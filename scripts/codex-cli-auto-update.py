#!/usr/bin/env python3
"""Update official Codex CLI installations for every local login user."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pwd
import re
import subprocess
import sys
from pathlib import Path

VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$")
INSTALLER_URL = "https://chatgpt.com/codex/install.sh"


def run_as(user: str, argv: list[str], timeout: int = 360) -> subprocess.CompletedProcess[str]:
    command = ["sudo", "-n", "-u", user, "-H", *argv]
    return subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)


def installed_version(user: str, binary: Path) -> str | None:
    result = run_as(user, [str(binary), "--version"], timeout=15)
    if result.returncode:
        return None
    match = re.search(r"\bcodex-cli\s+(\S+)", result.stdout)
    return match.group(1) if match else None


def installation(binary: Path, home: Path) -> tuple[str, Path] | None:
    try:
        valid_binary = binary.exists() and not binary.is_dir()
    except PermissionError:
        return None
    if not valid_binary:
        return None
    resolved = binary.resolve()
    standalone_root = home / ".codex" / "packages" / "standalone"
    if resolved.is_relative_to(standalone_root) and resolved.name == "codex":
        return "standalone", standalone_root
    if binary.name != "codex" or binary.parent.name != "bin":
        return None
    prefix = binary.parent.parent
    package = prefix / "lib" / "node_modules" / "@openai" / "codex"
    if (package / "package.json").is_file() and resolved == (package / "bin" / "codex.js").resolve():
        return "npm", prefix
    return None


def candidates(user: str, home: Path) -> list[Path]:
    paths = [home / ".local" / "bin" / "codex", home / ".npm-global" / "bin" / "codex"]
    nvm_versions = home / ".nvm" / "versions" / "node"
    if os.access(nvm_versions, os.R_OK | os.X_OK):
        paths.extend(nvm_versions.glob("*/bin/codex"))
    try:
        result = run_as(user, ["bash", "-lc", "command -v codex"], timeout=15)
        if result.returncode == 0 and result.stdout.strip():
            executable = result.stdout.strip().splitlines()[-1]
            if executable.startswith("/"):
                paths.append(Path(executable))
    except subprocess.TimeoutExpired:
        print(f"{user}: login shell timed out; checking standard install paths", file=sys.stderr, flush=True)
    return list(dict.fromkeys(paths))


def latest_npm_version() -> str:
    result = subprocess.run(
        ["npm", "view", "@openai/codex", "dist-tags.latest", "--json"],
        text=True, capture_output=True, timeout=45, check=False,
    )
    if result.returncode:
        raise RuntimeError("could not read the official @openai/codex npm latest tag")
    version = json.loads(result.stdout)
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise RuntimeError("npm returned an invalid Codex version")
    return version


def update(user: str, channel: str, prefix: Path, binary: Path, version: str, current: str | None) -> bool:
    if channel == "npm":
        if current == version:
            print(f"{user}: npm {prefix} already {version}", flush=True)
            return True
        command = ["npm", "install", "--global", "--prefix", str(prefix), f"@openai/codex@{version}"]
    else:
        # The standalone installer is the official update command and selects its own latest release.
        command = ["bash", "-o", "pipefail", "-c", f"curl -fsSL {INSTALLER_URL} | sh"]
    result = run_as(user, command)
    if result.returncode:
        print(f"{user}: {channel} update failed (exit {result.returncode})", file=sys.stderr, flush=True)
        return False
    after = installed_version(user, binary)
    if not after or (channel == "npm" and after != version):
        print(f"{user}: {channel} update did not install the expected version", file=sys.stderr, flush=True)
        return False
    print(f"{user}: {channel} {current or 'unknown'} -> {after}", flush=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="list discovered installations without updating")
    parser.add_argument("--user", action="append", help="update only this user (repeatable)")
    args = parser.parse_args()
    if not args.dry_run and os.geteuid() != 0:
        parser.error("updates require root; install the system timer or run with sudo")

    if not args.dry_run:
        lock = open("/run/lock/codex-cli-auto-update.lock", "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Codex update already running", file=sys.stderr)
            return 1

    excluded = set(os.environ.get("CODEX_AUTO_UPDATE_SKIP_USERS", "").replace(",", " ").split())
    selected = set(args.user or [])
    found: list[tuple[str, str, Path, Path]] = []
    seen: set[tuple[str, str, Path]] = set()
    for account in pwd.getpwall():
        user, home = account.pw_name, Path(account.pw_dir)
        if selected and user not in selected:
            continue
        is_login_home = str(home).startswith("/home/") or (user == "root" and home == Path("/root"))
        if user in excluded or not is_login_home or not home.is_dir():
            continue
        if account.pw_shell.endswith(("nologin", "false")):
            continue
        for binary in candidates(user, home):
            result = installation(binary, home)
            if result is None:
                continue
            channel, prefix = result
            if user != "root" and not prefix.is_relative_to(home):
                continue
            key = user, channel, prefix
            if key not in seen:
                seen.add(key)
                found.append((user, channel, prefix, binary))

    if not found:
        print("No installed Codex CLI found for local login users", flush=True)
        return 0
    if args.dry_run:
        for user, channel, prefix, binary in found:
            print(f"{user}: {channel} {binary} (prefix {prefix})", flush=True)
        return 0

    try:
        latest = latest_npm_version()
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Codex update skipped: {error}", file=sys.stderr, flush=True)
        return 1
    failures = 0
    for user, channel, prefix, binary in found:
        try:
            if not update(user, channel, prefix, binary, latest, installed_version(user, binary)):
                failures += 1
        except subprocess.TimeoutExpired:
            print(f"{user}: {channel} update timed out", file=sys.stderr, flush=True)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
