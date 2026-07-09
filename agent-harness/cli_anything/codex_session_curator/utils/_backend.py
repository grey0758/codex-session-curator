from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class BackendError(RuntimeError):
    pass


def default_base_url() -> str:
    return os.environ.get("CURATOR_BASE_URL", "http://127.0.0.1:54177").rstrip("/")


def default_state_path() -> Path:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    return Path(os.environ.get("CODEX_CURATOR_STATE", codex_home / "session-curator-state.json")).expanduser()


def admin_token() -> str | None:
    token = os.environ.get("CURATOR_ADMIN_TOKEN", "").strip()
    if token:
        return token
    auth_path = Path(os.environ.get("CURATOR_AUTH_ENV", Path.home() / ".config/codex-session-curator/auth.env")).expanduser()
    try:
        for line in auth_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("CURATOR_ADMIN_TOKEN="):
                return line.split("=", 1)[1].strip().strip("\"'") or None
    except OSError:
        return None
    return None


def request_json(
    path: str,
    *,
    base_url: str | None = None,
    params: dict[str, Any] | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 8.0,
) -> Any:
    url = f"{(base_url or default_base_url()).rstrip('/')}{path}"
    query = dict(params or {})
    token = admin_token()
    if token:
        query.setdefault("admin_token", token)
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"

    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        raise BackendError(str(exc)) from exc


def load_state(path: Path | None = None) -> dict[str, Any]:
    state_path = path or default_state_path()
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"keptIds": [], "deletedIds": [], "titles": {}, "evaluations": {}}
    except json.JSONDecodeError as exc:
        raise BackendError(f"Invalid state JSON: {state_path}") from exc


def state_sessions(state: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    data = state or load_state()
    evaluations = data.get("evaluations") if isinstance(data, dict) else {}
    titles = data.get("titles") if isinstance(data, dict) else {}
    kept_ids = set(data.get("keptIds") or [])
    deleted_ids = set(data.get("deletedIds") or [])
    sessions: list[dict[str, Any]] = []
    if not isinstance(evaluations, dict):
        return sessions
    for session_id, evaluation in evaluations.items():
        if not isinstance(evaluation, dict):
            continue
        title = titles.get(session_id) if isinstance(titles, dict) else None
        sessions.append(
            {
                "id": session_id,
                "filePath": evaluation.get("filePath"),
                "title": title or evaluation.get("title") or session_id,
                "cwd": evaluation.get("cwd"),
                "updatedAt": evaluation.get("updatedAt") or evaluation.get("evaluatedAt"),
                "messageCount": evaluation.get("messageCount"),
                "userTurns": evaluation.get("userTurns"),
                "assistantTurns": evaluation.get("assistantTurns"),
                "resumeCommand": f"codex resume {session_id}",
                "machineId": os.environ.get("CURATOR_MACHINE_ID") or os.uname().nodename,
                "kept": session_id in kept_ids,
                "deleted": session_id in deleted_ids,
                "evaluation": evaluation,
            }
        )
    return sessions
