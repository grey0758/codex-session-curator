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
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SLOT_UNIT_NAME="$APP_NAME-slot@.service"
SLOT_UNIT_SOURCE="$SOURCE_DIR/deploy/$SLOT_UNIT_NAME"
SLOT_UNIT_TARGET="$USER_SYSTEMD_DIR/$SLOT_UNIT_NAME"
ROLLBACK_RECORDS_DIR="$STATE_DIR/rollback-records"
ROLLBACK_STATE_LINK="$STATE_DIR/rollback-state"
ROLLBACK_RELEASE_LINK="$STATE_DIR/rollback-release"

SLOT_TRANSACTION_ACTIVE=0
SLOT_TRANSACTION_UNIT_SNAPSHOT=""
SLOT_TRANSACTION_PREVIOUS_SLOT=""
SLOT_TRANSACTION_TARGET_SLOT=""
SLOT_TRANSACTION_TARGET_TOUCHED=0
SLOT_TRANSACTION_SWITCH_ATTEMPTED=0
SLOT_TRANSACTION_TARGET_PREVIOUS_RELEASE=""
SLOT_TRANSACTION_TARGET_HAD_RELEASE=0

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
  mkdir -p "$RELEASES_DIR" "$SLOTS_DIR/blue" "$SLOTS_DIR/green" \
    "$STATE_DIR" "$ROLLBACK_RECORDS_DIR" "$NGINX_DIR/logs" \
    "$NGINX_DIR/client-body"
}

acquire_operation_lock() {
  exec 9>"$STATE_DIR/deploy.lock"
  if ! flock -n 9; then
    printf 'Another deploy or rollback operation is already running.\n' >&2
    return 1
  fi
}

path_is_within() {
  local path="$1"
  local parent="$2"
  local resolved_path resolved_parent

  resolved_path="$(readlink -f "$path" 2>/dev/null || true)"
  resolved_parent="$(readlink -f "$parent" 2>/dev/null || true)"
  [[ -n "$resolved_path" && -n "$resolved_parent" &&
    "$resolved_path" == "$resolved_parent/"* ]]
}

write_slot_unit_file() {
  local source="$1"
  local temporary_target

  if [[ ! -f "$source" || -L "$source" ]]; then
    printf 'Refusing non-regular slot unit source: %s\n' "$source" >&2
    return 1
  fi
  mkdir -p "$USER_SYSTEMD_DIR"
  temporary_target="$USER_SYSTEMD_DIR/.${SLOT_UNIT_NAME}.$$.$RANDOM"
  if ! install -m 0644 "$source" "$temporary_target"; then
    rm -f "$temporary_target"
    return 1
  fi
  if ! mv -fT "$temporary_target" "$SLOT_UNIT_TARGET"; then
    rm -f "$temporary_target"
    return 1
  fi
}

install_slot_unit() {
  write_slot_unit_file "$SLOT_UNIT_SOURCE"
}

slot_unit_snapshot_is_valid() {
  local snapshot="$1"
  local has_unit=0
  local was_absent=0

  if [[ -f "$snapshot/$SLOT_UNIT_NAME" &&
        ! -L "$snapshot/$SLOT_UNIT_NAME" ]]; then
    has_unit=1
  fi
  if [[ -f "$snapshot/slot-unit.absent" &&
        ! -L "$snapshot/slot-unit.absent" ]]; then
    was_absent=1
  fi
  [[ "$has_unit" -ne "$was_absent" ]]
}

capture_slot_unit_snapshot() {
  local destination="$1"

  if [[ ! -d "$destination" || -L "$destination" ]]; then
    printf 'Refusing invalid slot unit snapshot directory: %s\n' \
      "$destination" >&2
    return 1
  fi
  if [[ -L "$SLOT_UNIT_TARGET" ]]; then
    printf 'Refusing symlinked installed slot unit: %s\n' \
      "$SLOT_UNIT_TARGET" >&2
    return 1
  fi
  if [[ -f "$SLOT_UNIT_TARGET" ]]; then
    install -m 0644 "$SLOT_UNIT_TARGET" \
      "$destination/$SLOT_UNIT_NAME"
  elif [[ -e "$SLOT_UNIT_TARGET" ]]; then
    printf 'Refusing non-regular installed slot unit: %s\n' \
      "$SLOT_UNIT_TARGET" >&2
    return 1
  else
    printf 'absent\n' > "$destination/slot-unit.absent"
  fi
}

discard_slot_unit_snapshot() {
  local snapshot="$1"

  [[ -n "$snapshot" ]] || return 0
  rm -f "$snapshot/$SLOT_UNIT_NAME" "$snapshot/slot-unit.absent"
  rmdir "$snapshot" 2>/dev/null || true
}

restore_slot_unit_snapshot() {
  local snapshot="$1"

  if ! slot_unit_snapshot_is_valid "$snapshot"; then
    printf 'Invalid slot unit snapshot: %s\n' "$snapshot" >&2
    return 1
  fi

  if [[ -f "$snapshot/$SLOT_UNIT_NAME" ]]; then
    if ! write_slot_unit_file "$snapshot/$SLOT_UNIT_NAME"; then
      return 1
    fi
  else
    if [[ -e "$SLOT_UNIT_TARGET" || -L "$SLOT_UNIT_TARGET" ]]; then
      if [[ -d "$SLOT_UNIT_TARGET" && ! -L "$SLOT_UNIT_TARGET" ]]; then
        printf 'Refusing to remove directory at slot unit target: %s\n' \
          "$SLOT_UNIT_TARGET" >&2
        return 1
      fi
      if ! rm -f "$SLOT_UNIT_TARGET"; then
        return 1
      fi
    fi
  fi
  systemctl --user daemon-reload
}

publish_rollback_state() {
  local release="$1"
  local snapshot="$2"
  local record state_link_tmp release_link_tmp

  if [[ ! -d "$release" ]] ||
    ! path_is_within "$release" "$RELEASES_DIR"; then
    printf 'Refusing rollback state for invalid release: %s\n' \
      "$release" >&2
    return 1
  fi
  if ! slot_unit_snapshot_is_valid "$snapshot" ||
    [[ ! -f "$snapshot/$SLOT_UNIT_NAME" ]]; then
    printf 'Refusing rollback state without a restorable slot unit.\n' >&2
    return 1
  fi

  record="$(mktemp -d "$ROLLBACK_RECORDS_DIR/.record.XXXXXX")"
  chmod 0700 "$record"
  ln -s "$release" "$record/release"
  if [[ -f "$snapshot/$SLOT_UNIT_NAME" ]]; then
    install -m 0644 "$snapshot/$SLOT_UNIT_NAME" \
      "$record/$SLOT_UNIT_NAME"
  else
    printf 'absent\n' > "$record/slot-unit.absent"
  fi

  state_link_tmp="$STATE_DIR/.rollback-state.$$.$RANDOM"
  release_link_tmp="$STATE_DIR/.rollback-release.$$.$RANDOM"
  ln -s "$record" "$state_link_tmp"
  ln -s "rollback-state/release" "$release_link_tmp"
  if ! mv -fT "$release_link_tmp" "$ROLLBACK_RELEASE_LINK"; then
    rm -f "$state_link_tmp" "$release_link_tmp"
    return 1
  fi
  if ! mv -fT "$state_link_tmp" "$ROLLBACK_STATE_LINK"; then
    rm -f "$state_link_tmp"
    return 1
  fi
}

resolve_rollback_record() {
  local record release

  [[ -L "$ROLLBACK_STATE_LINK" ]] || return 1
  record="$(readlink -f "$ROLLBACK_STATE_LINK" 2>/dev/null || true)"
  if [[ -z "$record" || ! -d "$record" ||
        ! -L "$record/release" ]] ||
    ! path_is_within "$record" "$ROLLBACK_RECORDS_DIR"; then
    return 1
  fi
  release="$(readlink -f "$record/release" 2>/dev/null || true)"
  [[ -d "$release" ]] || return 1
  path_is_within "$release" "$RELEASES_DIR" || return 1
  slot_unit_snapshot_is_valid "$record" || return 1
  [[ -f "$record/$SLOT_UNIT_NAME" ]] || return 1
  printf '%s\n' "$record"
}

current_rollback_release() {
  local record release

  record="$(resolve_rollback_record 2>/dev/null || true)"
  if [[ -n "$record" ]]; then
    release="$(readlink -f "$record/release" 2>/dev/null || true)"
  else
    release="$(readlink -f "$ROLLBACK_RELEASE_LINK" 2>/dev/null || true)"
    if [[ -n "$release" ]] &&
      ! path_is_within "$release" "$RELEASES_DIR"; then
      release=""
    fi
  fi
  printf '%s\n' "$release"
}

restore_target_slot_release() {
  local target_link="$SLOTS_DIR/$SLOT_TRANSACTION_TARGET_SLOT/current"

  if [[ "$SLOT_TRANSACTION_TARGET_HAD_RELEASE" -eq 1 ]]; then
    ln -sfn "$SLOT_TRANSACTION_TARGET_PREVIOUS_RELEASE" "$target_link"
  elif [[ -L "$target_link" ]]; then
    rm -f "$target_link"
  elif [[ -e "$target_link" ]]; then
    printf 'Refusing non-symlinked target slot release: %s\n' \
      "$target_link" >&2
    return 1
  fi
}

begin_slot_transaction() {
  local previous_slot="$1"
  local target_slot="$2"
  local target_link="$SLOTS_DIR/$target_slot/current"
  local previous_release=""
  local had_release=0
  local snapshot

  slot_port "$previous_slot" >/dev/null
  slot_port "$target_slot" >/dev/null
  if [[ -L "$target_link" ]]; then
    previous_release="$(readlink -f "$target_link" 2>/dev/null || true)"
    if [[ -n "$previous_release" ]]; then
      if [[ ! -d "$previous_release" ]] ||
        ! path_is_within "$previous_release" "$RELEASES_DIR"; then
        printf 'Refusing invalid target slot release: %s\n' \
          "$target_link" >&2
        return 1
      fi
      had_release=1
    fi
  elif [[ -e "$target_link" ]]; then
    printf 'Refusing non-symlinked target slot release: %s\n' \
      "$target_link" >&2
    return 1
  fi

  snapshot="$(mktemp -d "$STATE_DIR/.slot-unit-snapshot.XXXXXX")"
  if ! capture_slot_unit_snapshot "$snapshot"; then
    discard_slot_unit_snapshot "$snapshot"
    return 1
  fi

  SLOT_TRANSACTION_UNIT_SNAPSHOT="$snapshot"
  SLOT_TRANSACTION_PREVIOUS_SLOT="$previous_slot"
  SLOT_TRANSACTION_TARGET_SLOT="$target_slot"
  SLOT_TRANSACTION_TARGET_TOUCHED=0
  SLOT_TRANSACTION_SWITCH_ATTEMPTED=0
  SLOT_TRANSACTION_TARGET_PREVIOUS_RELEASE="$previous_release"
  SLOT_TRANSACTION_TARGET_HAD_RELEASE="$had_release"
  SLOT_TRANSACTION_ACTIVE=1
  trap cleanup_failed_slot_transaction EXIT
}

commit_slot_transaction() {
  SLOT_TRANSACTION_ACTIVE=0
  trap - EXIT
  discard_slot_unit_snapshot "$SLOT_TRANSACTION_UNIT_SNAPSHOT"
  SLOT_TRANSACTION_UNIT_SNAPSHOT=""
}

cleanup_failed_slot_transaction() {
  local rc=$?
  local recovery_failed=0
  local traffic_safe=1

  trap - EXIT
  if [[ "$SLOT_TRANSACTION_ACTIVE" -eq 1 ]]; then
    if [[ "$SLOT_TRANSACTION_SWITCH_ATTEMPTED" -eq 1 ]]; then
      if ! switch_to_slot "$SLOT_TRANSACTION_PREVIOUS_SLOT" ||
        ! healthcheck_public; then
        printf 'Failed to restore traffic to slot %s.\n' \
          "$SLOT_TRANSACTION_PREVIOUS_SLOT" >&2
        recovery_failed=1
        traffic_safe=0
      fi
    fi

    if [[ "$traffic_safe" -eq 1 ]]; then
      if ! restore_slot_unit_snapshot \
        "$SLOT_TRANSACTION_UNIT_SNAPSHOT"; then
        printf 'Failed to restore the previous slot unit.\n' >&2
        recovery_failed=1
      fi
      if [[ "$SLOT_TRANSACTION_TARGET_TOUCHED" -eq 1 ]]; then
        if ! systemctl --user stop \
          "$APP_NAME-slot@$SLOT_TRANSACTION_TARGET_SLOT.service"; then
          printf 'Failed to stop transaction target slot %s.\n' \
            "$SLOT_TRANSACTION_TARGET_SLOT" >&2
          recovery_failed=1
        fi
        if ! systemctl --user disable \
          "$APP_NAME-slot@$SLOT_TRANSACTION_TARGET_SLOT.service" \
          >/dev/null; then
          printf 'Failed to disable transaction target slot %s.\n' \
            "$SLOT_TRANSACTION_TARGET_SLOT" >&2
          recovery_failed=1
        fi
      fi
      if ! restore_target_slot_release; then
        recovery_failed=1
      fi
    fi
  fi

  if [[ "$recovery_failed" -eq 0 ]]; then
    discard_slot_unit_snapshot "$SLOT_TRANSACTION_UNIT_SNAPSHOT"
  elif [[ -n "$SLOT_TRANSACTION_UNIT_SNAPSHOT" ]]; then
    printf 'Preserved recovery snapshot at %s\n' \
      "$SLOT_TRANSACTION_UNIT_SNAPSHOT" >&2
    rc=1
  fi
  exit "$rc"
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
  local stamp release release_id
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"

  if [[ ! -d "$RELEASES_DIR" || -L "$RELEASES_DIR" ]]; then
    printf 'Refusing invalid or symlinked releases directory: %s\n' \
      "$RELEASES_DIR" >&2
    return 1
  fi

  (cd "$SOURCE_DIR" && npm run build >&2)

  release="$(mktemp -d "$RELEASES_DIR/${stamp}.XXXXXX")"
  if [[ -z "$release" || ! -d "$release" || -L "$release" ]] ||
    ! path_is_within "$release" "$RELEASES_DIR"; then
    printf 'Refusing invalid release directory returned by mktemp: %s\n' \
      "${release:-empty}" >&2
    return 1
  fi
  release_id="$(basename "$release")"

  if ! rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'session-recycle-bin' \
    "$RUNTIME_DIR/" "$release/" ||
    ! rsync -a --delete "$SOURCE_DIR/dist/" "$release/dist/" ||
    ! rsync -a --delete "$SOURCE_DIR/server/" "$release/server/" ||
    ! ln -s "$RUNTIME_DIR/node_modules" "$release/node_modules" ||
    ! printf '%s\n' "$release_id" > "$release/RELEASE_ID" ||
    ! chmod 0755 "$release"; then
    if [[ -d "$release" && ! -L "$release" ]] &&
      path_is_within "$release" "$RELEASES_DIR"; then
      rm -rf -- "$release"
    else
      printf 'Preserving invalid failed release path for manual inspection: %s\n' \
        "$release" >&2
    fi
    return 1
  fi
  printf '%s\n' "$release"
}

switch_to_slot() {
  local slot="$1"

  if ! write_upstream "$slot"; then
    return 1
  fi
  if systemctl --user is-active --quiet "$APP_NAME.service"; then
    if ! systemctl --user reload "$APP_NAME.service" >/dev/null 2>&1 &&
      ! systemctl --user restart "$APP_NAME.service"; then
      return 1
    fi
  else
    if ! systemctl --user start "$APP_NAME.service"; then
      return 1
    fi
  fi
  printf '%s\n' "$slot" > "$STATE_DIR/current-slot"
}

deploy() {
  ensure_layout
  acquire_operation_lock
  local active active_link next old_release release port old_slot
  active="$(current_slot)"
  slot_port "$active" >/dev/null
  next="$(other_slot "$active")"
  old_slot="$active"
  active_link="$SLOTS_DIR/$active/current"
  old_release=""
  if [[ -L "$active_link" ]]; then
    old_release="$(readlink -f "$active_link" 2>/dev/null || true)"
    if [[ -z "$old_release" || ! -d "$old_release" ]] ||
      ! path_is_within "$old_release" "$RELEASES_DIR"; then
      printf 'Refusing invalid active release link: %s\n' \
        "$active_link" >&2
      return 1
    fi
  elif [[ -e "$active_link" ]]; then
    printf 'Refusing non-symlinked active release: %s\n' \
      "$active_link" >&2
    return 1
  fi
  release="$(create_release)"
  if [[ ! -d "$release" ]] ||
    ! path_is_within "$release" "$RELEASES_DIR"; then
    printf 'Refusing invalid newly created release: %s\n' "$release" >&2
    return 1
  fi

  begin_slot_transaction "$old_slot" "$next"
  if [[ -n "$old_release" &&
        -f "$SLOT_TRANSACTION_UNIT_SNAPSHOT/slot-unit.absent" ]]; then
    printf 'Refusing deploy because the active release has no installed slot unit.\n' \
      >&2
    return 1
  fi
  ln -sfn "$release" "$SLOTS_DIR/$next/current"

  install_slot_unit
  systemctl --user daemon-reload
  SLOT_TRANSACTION_TARGET_TOUCHED=1
  systemctl --user enable "$APP_NAME-slot@$next.service" >/dev/null
  systemctl --user restart "$APP_NAME-slot@$next.service"
  port="$(slot_port "$next")"
  healthcheck_port "$port"

  SLOT_TRANSACTION_SWITCH_ATTEMPTED=1
  switch_to_slot "$next"
  healthcheck_public

  if [[ -n "$old_release" && -d "$old_release" ]]; then
    publish_rollback_state "$old_release" \
      "$SLOT_TRANSACTION_UNIT_SNAPSHOT"
  fi
  commit_slot_transaction

  systemctl --user stop "$APP_NAME-slot@$old_slot.service" 2>/dev/null || true
  systemctl --user disable "$APP_NAME-slot@$old_slot.service" >/dev/null 2>&1 || true

  prune_releases
  status
}

rollback() {
  ensure_layout
  acquire_operation_lock
  local active next record release legacy_release port
  active="$(current_slot)"
  slot_port "$active" >/dev/null
  next="$(other_slot "$active")"
  record="$(resolve_rollback_record 2>/dev/null || true)"
  if [[ -z "$record" ]]; then
    if [[ -L "$ROLLBACK_RELEASE_LINK" ]]; then
      printf 'Refusing unpaired legacy rollback release; complete one successful deploy to create a release and slot-unit pair.\n' \
        >&2
      return 1
    fi
    printf 'No rollback release with a matching slot unit is available.\n' >&2
    return 1
  fi
  release="$(readlink -f "$record/release" 2>/dev/null || true)"
  legacy_release="$(
    readlink -f "$ROLLBACK_RELEASE_LINK" 2>/dev/null || true
  )"
  if [[ -z "$release" || ! -d "$release" ||
        -n "$legacy_release" && "$legacy_release" != "$release" ]]; then
    printf 'Rollback release and slot unit state are inconsistent.\n' >&2
    return 1
  fi

  begin_slot_transaction "$active" "$next"
  ln -sfn "$release" "$SLOTS_DIR/$next/current"
  restore_slot_unit_snapshot "$record"
  SLOT_TRANSACTION_TARGET_TOUCHED=1
  systemctl --user enable "$APP_NAME-slot@$next.service" >/dev/null
  systemctl --user restart "$APP_NAME-slot@$next.service"
  port="$(slot_port "$next")"
  healthcheck_port "$port"
  SLOT_TRANSACTION_SWITCH_ATTEMPTED=1
  switch_to_slot "$next"
  healthcheck_public
  commit_slot_transaction

  systemctl --user stop "$APP_NAME-slot@$active.service" 2>/dev/null || true
  systemctl --user disable "$APP_NAME-slot@$active.service" >/dev/null 2>&1 || true
  status
}

prune_releases() {
  local keep_current keep_rollback
  keep_current="$(readlink -f "$SLOTS_DIR/$(current_slot)/current" 2>/dev/null || true)"
  keep_rollback="$(current_rollback_release)"
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print | while IFS= read -r dir; do
    [[ "$dir" == "$keep_current" || "$dir" == "$keep_rollback" ]] && continue
    rm -rf "$dir"
  done
}

status() {
  ensure_layout
  local active rollback_record
  active="$(current_slot)"
  rollback_record="$(resolve_rollback_record 2>/dev/null || true)"
  printf 'active_slot=%s active_port=%s\n' "$active" "$(slot_port "$active")"
  printf 'blue_release=%s\n' "$(readlink -f "$SLOTS_DIR/blue/current" 2>/dev/null || true)"
  printf 'green_release=%s\n' "$(readlink -f "$SLOTS_DIR/green/current" 2>/dev/null || true)"
  printf 'rollback_release=%s\n' "$(current_rollback_release)"
  printf 'rollback_unit_state=%s\n' "$rollback_record"
  systemctl --user --no-pager --plain --full status "$APP_NAME.service" "$APP_NAME-slot@blue.service" "$APP_NAME-slot@green.service" 2>/dev/null | sed -n '1,80p' || true
}

case "${1:-}" in
  deploy) deploy ;;
  rollback) rollback ;;
  status) status ;;
  -h|--help|help|'') usage ;;
  *) usage >&2; exit 2 ;;
esac
