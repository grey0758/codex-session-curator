# Codex Session Curator

Local-first panel for curating Codex session records.

It scans the running machine's `~/.codex/sessions`, extracts only the session key and file metadata, evaluates the conversation with a small LangGraph workflow, and lets you manually keep or delete records. Raw transcripts are read for local evaluation only and are not stored by the app.

## Commands

```bash
npm install
npm run build
npm run server
```

Development:

```bash
npm run dev
npm run dev:server
```

The server listens on `PORT` or `54177`.

## Environment

```bash
CODEX_HOME=/home/grey/.codex
CODEX_CURATOR_STATE=/home/grey/.codex/session-curator-state.json
HOST=127.0.0.1
PORT=54177
```

Optional GPT summary support is loaded from:

```text
/home/grey/.config/codex-session-curator/llm.env
```

Expected fields:

```bash
API_KEY=...
MODEL=gpt-5.4
BASE_URL=https://api.opencodex.uk/v1
CODEX_BIN=/usr/bin/codex
```

Delete actions remove files from the machine running the server:

- `~/.codex/sessions/**/rollout-...<session-id>.jsonl`
- matching `~/.codex/shell_snapshots/<session-id>.*.sh`
- matching lines in `~/.codex/history.jsonl`

`history.jsonl.bak` is created before the first history rewrite.

## Deploy Note

For `hongkong003`, run this service on that host if you want deletion to affect that host's local Codex records. A remote web server cannot delete another client machine's Codex files unless a local agent is also running there.

Example systemd unit:

```bash
sudo cp deploy/codex-session-curator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codex-session-curator
```

Suggested local origin for Cloudflare Tunnel:

```text
http://127.0.0.1:54177
```

Public entry:

```text
https://sweep-codex.xiannai.me
```

The Cloudflare Tunnel service template expects this local token file, which must not be committed:

```bash
printf 'REDACTED\n' > /home/grey/data/apps/codex-session-curator/.cloudflared.token
chmod 600 /home/grey/data/apps/codex-session-curator/.cloudflared.token
```
