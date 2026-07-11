#!/usr/bin/env bash
set -euo pipefail

APP_NAME="codex-session-curator"
SOURCE_DIR="${SOURCE_DIR:-/home/grey/work/codex-session-curator}"
RUNTIME_DIR="${RUNTIME_DIR:-/home/grey/data/apps/codex-session-curator}"
ROOT_DIR="${ROOT_DIR:-/home/grey/data/apps/codex-session-curator-blue-green}"
RELEASES_DIR="$ROOT_DIR/releases"
SLOTS_DIR="$ROOT_DIR/slots"
STATE_DIR="$ROOT_DIR/state"
NGINX_DIR="$ROOT_DIR/nginx"
BLUE_PORT="${BLUE_PORT:-54187}"
GREEN_PORT="${GREEN_PORT:-54188}"
PUBLIC_PORT="${PUBLIC_PORT:-54177}"

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-blue-green.sh deploy
  scripts/deploy-blue-green.sh status
  scripts/deploy-blue-green.sh rollback

Builds the source frontend, creates a release from the current runtime tree,
starts the inactive slot, verifies it, switches the local proxy, then stops
the old slot while retaining only one rollback release.
EOF
}

slot_port() {
  case "$1" in
    blue) printf '%s\n' "$BLUE_PORT" ;;
    green) printf '%s\n' "$GREEN_PORT" ;;
    *) printf 'unknown slot: %s\n' "$1" >&2; return 2 ;;
  esac
}

other_slot() {
  case "${1:-}" in
    blue) printf 'green\n' ;;
    green) printf 'blue\n' ;;
    *) printf 'blue\n' ;;
  esac
}

current_slot() {
  if [[ -f "$STATE_DIR/current-slot" ]]; then
    tr -d '[:space:]' < "$STATE_DIR/current-slot"
  else
    printf 'green\n'
  fi
}

ensure_layout() {
  mkdir -p "$RELEASES_DIR" "$SLOTS_DIR/blue" "$SLOTS_DIR/green" "$STATE_DIR" "$NGINX_DIR/logs" "$NGINX_DIR/client-body"
}

write_upstream() {
  local slot="$1"
  local port
  port="$(slot_port "$slot")"
  cat > "$NGINX_DIR/upstream.conf" <<EOF
upstream curator_live {
    server 127.0.0.1:$port;
}
EOF
}

healthcheck_port() {
  local port="$1"
  local code attempt
  for attempt in {1..30}; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/" || true)"
    if [[ "$code" == "200" ]]; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/api/health" || true)"
      [[ "$code" == "200" || "$code" == "401" ]] && return 0
    fi
    sleep 1
  done
  printf 'healthcheck failed for port %s, last status %s\n' "$port" "$code" >&2
  return 1
}

healthcheck_public() {
  local code attempt
  for attempt in {1..20}; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PUBLIC_PORT/" || true)"
    [[ "$code" == "200" ]] && return 0
    sleep 1
  done
  printf 'public healthcheck failed for port %s, last status %s\n' "$PUBLIC_PORT" "$code" >&2
  return 1
}

create_release() {
  local stamp release
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  release="$RELEASES_DIR/$stamp"

  (cd "$SOURCE_DIR" && npm run build >&2)

  mkdir -p "$release"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'session-recycle-bin' \
    "$RUNTIME_DIR/" "$release/"
  rsync -a --delete "$SOURCE_DIR/dist/" "$release/dist/"
  rsync -a --delete "$SOURCE_DIR/server/" "$release/server/"
  ln -s "$RUNTIME_DIR/node_modules" "$release/node_modules"
  printf '%s\n' "$stamp" > "$release/RELEASE_ID"
  printf '%s\n' "$release"
}

switch_to_slot() {
  local slot="$1"
  write_upstream "$slot"
  if systemctl --user is-active --quiet "$APP_NAME.service"; then
    systemctl --user reload "$APP_NAME.service" >/dev/null 2>&1 || systemctl --user restart "$APP_NAME.service"
  else
    systemctl --user start "$APP_NAME.service"
  fi
  printf '%s\n' "$slot" > "$STATE_DIR/current-slot"
}

deploy() {
  ensure_layout
  local active next old_release release port old_slot
  active="$(current_slot)"
  next="$(other_slot "$active")"
  old_slot="$active"
  old_release="$(readlink -f "$SLOTS_DIR/$active/current" 2>/dev/null || true)"
  release="$(create_release)"
  ln -sfn "$release" "$SLOTS_DIR/$next/current"

  systemctl --user daemon-reload
  systemctl --user enable "$APP_NAME-slot@$next.service" >/dev/null
  systemctl --user restart "$APP_NAME-slot@$next.service"
  port="$(slot_port "$next")"
  healthcheck_port "$port"

  switch_to_slot "$next"
  healthcheck_public

  systemctl --user stop "$APP_NAME-slot@$old_slot.service" 2>/dev/null || true
  systemctl --user disable "$APP_NAME-slot@$old_slot.service" >/dev/null 2>&1 || true
  if [[ -n "$old_release" && -d "$old_release" ]]; then
    ln -sfn "$old_release" "$STATE_DIR/rollback-release"
  fi

  prune_releases
  status
}

rollback() {
  ensure_layout
  local active next release port
  active="$(current_slot)"
  next="$(other_slot "$active")"
  release="$(readlink -f "$STATE_DIR/rollback-release" 2>/dev/null || true)"
  if [[ -z "$release" || ! -d "$release" ]]; then
    printf 'No rollback release is available.\n' >&2
    return 1
  fi
  ln -sfn "$release" "$SLOTS_DIR/$next/current"
  systemctl --user daemon-reload
  systemctl --user enable "$APP_NAME-slot@$next.service" >/dev/null
  systemctl --user restart "$APP_NAME-slot@$next.service"
  port="$(slot_port "$next")"
  healthcheck_port "$port"
  switch_to_slot "$next"
  healthcheck_public
  systemctl --user stop "$APP_NAME-slot@$active.service" 2>/dev/null || true
  systemctl --user disable "$APP_NAME-slot@$active.service" >/dev/null 2>&1 || true
  status
}

prune_releases() {
  local keep_current keep_rollback
  keep_current="$(readlink -f "$SLOTS_DIR/$(current_slot)/current" 2>/dev/null || true)"
  keep_rollback="$(readlink -f "$STATE_DIR/rollback-release" 2>/dev/null || true)"
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print | while IFS= read -r dir; do
    [[ "$dir" == "$keep_current" || "$dir" == "$keep_rollback" ]] && continue
    rm -rf "$dir"
  done
}

status() {
  ensure_layout
  local active
  active="$(current_slot)"
  printf 'active_slot=%s active_port=%s\n' "$active" "$(slot_port "$active")"
  printf 'blue_release=%s\n' "$(readlink -f "$SLOTS_DIR/blue/current" 2>/dev/null || true)"
  printf 'green_release=%s\n' "$(readlink -f "$SLOTS_DIR/green/current" 2>/dev/null || true)"
  printf 'rollback_release=%s\n' "$(readlink -f "$STATE_DIR/rollback-release" 2>/dev/null || true)"
  systemctl --user --no-pager --plain --full status "$APP_NAME.service" "$APP_NAME-slot@blue.service" "$APP_NAME-slot@green.service" 2>/dev/null | sed -n '1,80p' || true
}

case "${1:-}" in
  deploy) deploy ;;
  rollback) rollback ;;
  status) status ;;
  -h|--help|help|'') usage ;;
  *) usage >&2; exit 2 ;;
esac
