#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ${EUID} -ne 0 ]]; then
  exec sudo -n -- "$0" "$@"
fi

case "${1:-}" in
  '' )
    if [[ $(hostname -s) == sgp001 || -f /home/grey/data/dr/canonical/codex-version ]]; then
      printf 'CODEX_AUTO_UPDATE_SKIP_USERS=grey\n' > /etc/default/codex-cli-auto-update
      chmod 0644 /etc/default/codex-cli-auto-update
    fi
    ;;
  --skip-user )
    [[ $# -eq 2 && "$2" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Usage: install-codex-cli-auto-update.sh [--skip-user USER]' >&2; exit 2; }
    printf 'CODEX_AUTO_UPDATE_SKIP_USERS=%s\n' "$2" > /etc/default/codex-cli-auto-update
    chmod 0644 /etc/default/codex-cli-auto-update
    ;;
  * ) echo 'Usage: install-codex-cli-auto-update.sh [--skip-user USER]' >&2; exit 2 ;;
esac

install -Dm755 "$source_dir/scripts/codex-cli-auto-update.py" /usr/local/libexec/codex-cli-auto-update
install -Dm644 "$source_dir/deploy/codex-cli-auto-update.service" /etc/systemd/system/codex-cli-auto-update.service
install -Dm644 "$source_dir/deploy/codex-cli-auto-update.timer" /etc/systemd/system/codex-cli-auto-update.timer
systemctl daemon-reload
systemctl enable --now codex-cli-auto-update.timer
/usr/local/libexec/codex-cli-auto-update --dry-run
