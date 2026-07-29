#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-blue-green.sh"
SLOT_UNIT_NAME="codex-session-curator-slot@.service"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

prepare_fixture() {
  local fixture="$1"
  local old_release="$fixture/root/releases/old"

  mkdir -p \
    "$fixture/source/deploy" \
    "$fixture/runtime" \
    "$fixture/root/releases" \
    "$fixture/root/slots/blue" \
    "$fixture/root/slots/green" \
    "$fixture/root/state" \
    "$fixture/config/systemd/user" \
    "$old_release"
  printf '[Unit]\nDescription=old slot unit\n' > "$fixture/old-unit.service"
  printf '[Unit]\nDescription=new slot unit\n' \
    > "$fixture/source/deploy/$SLOT_UNIT_NAME"
  install -m 0644 "$fixture/old-unit.service" \
    "$fixture/config/systemd/user/$SLOT_UNIT_NAME"
  ln -s "$old_release" "$fixture/root/slots/blue/current"
  printf 'blue\n' > "$fixture/root/state/current-slot"
}

run_failed_deploy() (
  set -euo pipefail
  local fixture="$1"
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"
  export SYSTEMCTL_LOG="$fixture/systemctl.log"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null

  systemctl() {
    printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
    return 0
  }
  create_release() {
    local release="$RELEASES_DIR/new"
    cmp "$fixture/old-unit.service" "$SLOT_UNIT_TARGET"
    mkdir -p "$release"
    printf '%s\n' "$release"
  }
  healthcheck_port() {
    return 1
  }

  deploy
)

failure_fixture="$tmpdir/failure"
prepare_fixture "$failure_fixture"
set +e
run_failed_deploy "$failure_fixture"
failure_rc=$?
set -e
if [[ "$failure_rc" -eq 0 ]]; then
  printf 'Expected the simulated deployment to fail.\n' >&2
  exit 1
fi
cmp "$failure_fixture/old-unit.service" \
  "$failure_fixture/config/systemd/user/$SLOT_UNIT_NAME"
test "$(
  grep -c -- '--user daemon-reload' "$failure_fixture/systemctl.log"
)" -eq 2
test ! -e "$failure_fixture/root/state/rollback-state"
test ! -L "$failure_fixture/root/state/rollback-state"
grep -q -- \
  '--user stop codex-session-curator-slot@green.service' \
  "$failure_fixture/systemctl.log"
grep -q -- \
  '--user disable codex-session-curator-slot@green.service' \
  "$failure_fixture/systemctl.log"
test ! -L "$failure_fixture/root/slots/green/current"

run_post_switch_failure() (
  set -euo pipefail
  local fixture="$1"
  local public_checks=0
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"
  export SYSTEMCTL_LOG="$fixture/systemctl.log"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null

  systemctl() {
    printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
    return 0
  }
  create_release() {
    local release="$RELEASES_DIR/new"
    mkdir -p "$release"
    printf '%s\n' "$release"
  }
  healthcheck_port() {
    return 0
  }
  healthcheck_public() {
    public_checks=$((public_checks + 1))
    [[ "$public_checks" -gt 1 ]]
  }

  deploy
)

post_switch_fixture="$tmpdir/post-switch-failure"
prepare_fixture "$post_switch_fixture"
set +e
run_post_switch_failure "$post_switch_fixture"
post_switch_rc=$?
set -e
if [[ "$post_switch_rc" -eq 0 ]]; then
  printf 'Expected the post-switch health failure to fail deploy.\n' >&2
  exit 1
fi
cmp "$post_switch_fixture/old-unit.service" \
  "$post_switch_fixture/config/systemd/user/$SLOT_UNIT_NAME"
test "$(<"$post_switch_fixture/root/state/current-slot")" = blue
grep -q '127.0.0.1:54187' \
  "$post_switch_fixture/root/nginx/upstream.conf"
grep -q -- \
  '--user stop codex-session-curator-slot@green.service' \
  "$post_switch_fixture/systemctl.log"
grep -q -- \
  '--user disable codex-session-curator-slot@green.service' \
  "$post_switch_fixture/systemctl.log"
test ! -L "$post_switch_fixture/root/slots/green/current"

run_success_and_rollback() (
  set -euo pipefail
  local fixture="$1"
  local expected_unit
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"
  export SYSTEMCTL_LOG="$fixture/systemctl.log"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null

  expected_unit="$fixture/source/deploy/$SLOT_UNIT_NAME"
  systemctl() {
    printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
    if [[ "$*" == *" restart codex-session-curator-slot@"* ]]; then
      cmp "$expected_unit" "$SLOT_UNIT_TARGET"
    fi
    return 0
  }
  create_release() {
    local release="$RELEASES_DIR/new"
    cmp "$fixture/old-unit.service" "$SLOT_UNIT_TARGET"
    mkdir -p "$release"
    printf '%s\n' "$release"
  }
  healthcheck_port() {
    return 0
  }
  healthcheck_public() {
    return 0
  }

  deploy >/dev/null
  cmp "$fixture/source/deploy/$SLOT_UNIT_NAME" "$SLOT_UNIT_TARGET"

  rollback_record="$(readlink -f "$STATE_DIR/rollback-state")"
  test "$(readlink -f "$rollback_record/release")" = \
    "$RELEASES_DIR/old"
  test "$(readlink -f "$STATE_DIR/rollback-release")" = \
    "$RELEASES_DIR/old"
  cmp "$fixture/old-unit.service" \
    "$rollback_record/$SLOT_UNIT_NAME"

  : > "$SYSTEMCTL_LOG"
  expected_unit="$fixture/old-unit.service"
  rollback >/dev/null
  cmp "$fixture/old-unit.service" "$SLOT_UNIT_TARGET"
  test "$(current_slot)" = blue

  daemon_line="$(
    grep -n -- '--user daemon-reload' "$SYSTEMCTL_LOG" |
      head -n 1 |
      cut -d: -f1
  )"
  restart_line="$(
    grep -n -- \
      'restart codex-session-curator-slot@blue.service' \
      "$SYSTEMCTL_LOG" |
      head -n 1 |
      cut -d: -f1
  )"
  test "$daemon_line" -lt "$restart_line"
)

run_failed_rollback() (
  set -euo pipefail
  local fixture="$1"
  local phase=deploy
  local expected_unit
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"
  export SYSTEMCTL_LOG="$fixture/systemctl.log"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null

  expected_unit="$fixture/source/deploy/$SLOT_UNIT_NAME"
  systemctl() {
    printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
    if [[ "$*" == *" restart codex-session-curator-slot@"* ]]; then
      cmp "$expected_unit" "$SLOT_UNIT_TARGET"
    fi
    return 0
  }
  create_release() {
    local release="$RELEASES_DIR/new"
    mkdir -p "$release"
    printf '%s\n' "$release"
  }
  healthcheck_port() {
    [[ "$phase" == deploy ]]
  }
  healthcheck_public() {
    return 0
  }

  deploy >/dev/null
  : > "$SYSTEMCTL_LOG"
  phase=rollback
  expected_unit="$fixture/old-unit.service"
  rollback
)

rollback_failure_fixture="$tmpdir/rollback-failure"
prepare_fixture "$rollback_failure_fixture"
set +e
run_failed_rollback "$rollback_failure_fixture"
rollback_failure_rc=$?
set -e
if [[ "$rollback_failure_rc" -eq 0 ]]; then
  printf 'Expected the simulated rollback health failure.\n' >&2
  exit 1
fi
cmp "$rollback_failure_fixture/source/deploy/$SLOT_UNIT_NAME" \
  "$rollback_failure_fixture/config/systemd/user/$SLOT_UNIT_NAME"
test "$(<"$rollback_failure_fixture/root/state/current-slot")" = green
grep -q '127.0.0.1:54188' \
  "$rollback_failure_fixture/root/nginx/upstream.conf"
grep -q -- \
  '--user stop codex-session-curator-slot@blue.service' \
  "$rollback_failure_fixture/systemctl.log"
grep -q -- \
  '--user disable codex-session-curator-slot@blue.service' \
  "$rollback_failure_fixture/systemctl.log"

run_restore_failure() (
  set -euo pipefail
  local fixture="$1"
  local daemon_reloads=0
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"
  export SYSTEMCTL_LOG="$fixture/systemctl.log"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null

  systemctl() {
    printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
    if [[ "$*" == '--user daemon-reload' ]]; then
      daemon_reloads=$((daemon_reloads + 1))
      [[ "$daemon_reloads" -lt 2 ]]
      return
    fi
    return 0
  }
  create_release() {
    local release="$RELEASES_DIR/new"
    mkdir -p "$release"
    printf '%s\n' "$release"
  }
  healthcheck_port() {
    return 1
  }

  deploy
)

restore_failure_fixture="$tmpdir/restore-failure"
prepare_fixture "$restore_failure_fixture"
set +e
run_restore_failure "$restore_failure_fixture"
restore_failure_rc=$?
set -e
if [[ "$restore_failure_rc" -eq 0 ]]; then
  printf 'Expected the simulated restore daemon-reload failure.\n' >&2
  exit 1
fi
mapfile -t preserved_snapshots < <(
  find "$restore_failure_fixture/root/state" \
    -mindepth 1 -maxdepth 1 -type d \
    -name '.slot-unit-snapshot.*' -print
)
test "${#preserved_snapshots[@]}" -eq 1
cmp "$restore_failure_fixture/old-unit.service" \
  "${preserved_snapshots[0]}/$SLOT_UNIT_NAME"

run_path_validation() (
  set -euo pipefail
  local fixture="$1"
  local outside_record="$fixture/outside-record"
  local inside_record="$fixture/root/state/rollback-records/record"
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null
  ensure_layout

  mkdir -p "$outside_record"
  ln -s "$RELEASES_DIR/old" "$outside_record/release"
  install -m 0644 "$fixture/old-unit.service" \
    "$outside_record/$SLOT_UNIT_NAME"
  ln -s "$outside_record" "$ROLLBACK_STATE_LINK"
  if resolve_rollback_record >/dev/null 2>&1; then
    printf 'Accepted rollback record outside rollback-records.\n' >&2
    return 1
  fi

  rm -f "$ROLLBACK_STATE_LINK"
  mkdir -p "$inside_record"
  ln -s "$RELEASES_DIR/old" "$inside_record/release"
  ln -s "$fixture/old-unit.service" \
    "$inside_record/$SLOT_UNIT_NAME"
  ln -s "$inside_record" "$ROLLBACK_STATE_LINK"
  if resolve_rollback_record >/dev/null 2>&1; then
    printf 'Accepted symlinked rollback slot unit.\n' >&2
    return 1
  fi
)

path_fixture="$tmpdir/path-validation"
prepare_fixture "$path_fixture"
run_path_validation "$path_fixture"

run_lock_validation() (
  set -euo pipefail
  local fixture="$1"
  local ready="$fixture/lock-ready"
  local holder
  export SOURCE_DIR="$fixture/source"
  export RUNTIME_DIR="$fixture/runtime"
  export ROOT_DIR="$fixture/root"
  export XDG_CONFIG_HOME="$fixture/config"

  set -- help
  # shellcheck disable=SC1090
  source "$DEPLOY_SCRIPT" >/dev/null
  ensure_layout

  flock -x "$STATE_DIR/deploy.lock" \
    bash -c 'touch "$1"; sleep 1' _ "$ready" &
  holder=$!
  for _ in {1..100}; do
    [[ -e "$ready" ]] && break
    sleep 0.01
  done
  test -e "$ready"
  if acquire_operation_lock; then
    printf 'Acquired deploy lock while another process held it.\n' >&2
    return 1
  fi
  wait "$holder"
)

lock_fixture="$tmpdir/lock-validation"
prepare_fixture "$lock_fixture"
run_lock_validation "$lock_fixture"

success_fixture="$tmpdir/success"
prepare_fixture "$success_fixture"
run_success_and_rollback "$success_fixture"

printf 'deploy blue-green unit transaction tests passed\n'
