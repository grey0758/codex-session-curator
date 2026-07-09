# Telegram Thin Gateway

This is a thin Telegram entry point for the Codex Control Plane. It does not do
reasoning, scheduling, or durable memory itself. It receives Telegram messages,
forwards them to `codex exec`, and sends Codex output back to Telegram.

## Requirements

- Node.js 18+
- A Telegram bot token from BotFather
- A working `codex` CLI on the host

No npm dependencies are required; the gateway uses Node built-ins including
`fetch`, `child_process`, and `fs`.

## Configuration

Environment variables:

- `TELEGRAM_BOT_TOKEN`: required. Telegram bot token. Do not commit it.
- `CODEX_CONTROL_PLANE_DIR`: optional. Defaults to
  `/home/grey/work/codex-control-plane`.
- `CODEX_BIN`: optional. Defaults to `codex`.
- `CODEX_MODEL`: optional. Passed to Codex as `-m` when set.
- `TELEGRAM_ALLOWED_USER_IDS`: optional comma/space-separated allowlist. When
  empty, all Telegram users are accepted.

Per chat/thread session mapping files are stored under:

```text
telegram-gateway/.state/sessions/
```

The files contain chat/thread identifiers, Codex session id when available, and
last run metadata. They never contain the Telegram bot token.

## Run

```bash
cd /home/grey/work/codex-control-plane/telegram-gateway
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_ALLOWED_USER_IDS="123456789" \
npm start
```

Equivalent direct command:

```bash
node /home/grey/work/codex-control-plane/telegram-gateway/src/gateway.mjs
```

For each incoming text or caption message, the gateway calls Codex in the
control-plane workspace. New chat/thread mappings start with:

```bash
codex exec -C /home/grey/work/codex-control-plane <prompt>
```

When a Codex session id has been captured for that chat/thread, later messages
are sent with `codex exec resume <session_id> <prompt>`.

Send `/reset` in a chat/thread to delete that chat/thread's local session
mapping.

## Systemd

Copy and adjust the example service:

```bash
sudo cp /home/grey/work/codex-control-plane/deploy/codex-telegram-thin-gateway.service.example \
  /etc/systemd/system/codex-telegram-thin-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-telegram-thin-gateway.service
```

Put secrets in a local environment file referenced by the service, for example:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Do not commit that environment file.
