# Codex Session Curator

Codex Session Curator is a local-first web panel for reviewing, searching, summarizing, resuming, and safely archiving Codex CLI sessions across one or more machines.

It is designed for people who use Codex heavily and end up with many saved sessions under `~/.codex`. The app helps you find useful project work, identify disposable one-off conversations, keep important sessions, and move stale records into a recoverable recycle bin.

## What It Does

- Scans local Codex session files under `~/.codex/sessions`.
- Extracts session ids, timestamps, working directories, message counts, and shell snapshot counts.
- Generates Chinese AI summaries, titles, directory hints, tech stack tags, and searchable keywords.
- Groups sessions by machine, project directory, or activity date.
- Copies resume commands such as `codex resume <session-id>`.
- Shows session history on demand instead of loading every transcript into the panel.
- Opens an xterm.js web terminal backed by `node-pty` for continuing a real Codex session.
- Supports remote agents so each machine manages its own local Codex files.
- Archives deleted sessions into a recycle bin before removing them from active Codex directories.
- Supports manual keep labels, bulk delete, restore, and permanent purge.

## Safety Model

This project is local-first. Deleting a session affects the machine running the agent.

Archive delete moves data into a recycle bin first:

- `~/.codex/sessions/**/rollout-*.jsonl`
- matching `~/.codex/shell_snapshots/<session-id>.*`
- matching entries in `~/.codex/history.jsonl`

The recycle bin is stored under the app runtime directory by default and can be restored from the UI. Expired archives are cleaned after the configured retention period.

Do not expose this app publicly without authentication. It can read and remove local Codex session files.

## Quick Start

```bash
npm install
npm run build
npm run server
```

The server listens on:

```text
http://127.0.0.1:54177
```

Development:

```bash
npm run dev
npm run dev:server
```

## Authentication

The app supports a built-in login page and token login links.

Set these variables:

```bash
CURATOR_AUTH_USER=admin
CURATOR_AUTH_PASSWORD=change-me
CURATOR_ADMIN_TOKEN=generate-a-long-random-token
```

Login methods:

- Open the app and sign in with username/password.
- Or use a token link once:

```text
http://127.0.0.1:54177/?admin_token=generate-a-long-random-token
```

The token link sets an HttpOnly cookie and redirects back to the clean URL. Basic Authorization headers are still accepted for automation, but browser users get the UI login form.

## Configuration

Common environment variables:

```bash
HOST=127.0.0.1
PORT=54177
CODEX_HOME=/home/you/.codex
CODEX_CURATOR_STATE=/home/you/.codex/session-curator-state.json
CURATOR_RECYCLE_ROOT=/home/you/data/codex-session-curator/session-recycle-bin
CURATOR_RECYCLE_RETENTION_DAYS=30
CURATOR_MACHINE_ID=workstation
CODEX_BIN=/usr/bin/codex
```

AI summary configuration uses an OpenAI-compatible chat completion endpoint:

```bash
CURATOR_LLM_BASE_URL=https://integrate.api.nvidia.com/v1
CURATOR_LLM_MODEL=minimaxai/minimax-m2.7
CURATOR_LLM_API_KEYS=key-one,key-two
CURATOR_LLM_RPM=10
CURATOR_EVALUATION_CONCURRENCY=4
CURATOR_LLM_MAX_TOKENS=1536
CURATOR_LLM_STREAM=1
```

You can also use:

```bash
NVIDIA_API_KEYS=key-one,key-two
```

Multiple keys are rotated per request. Keep all keys in an untracked environment file.

## Remote Agents

To manage sessions on several machines, run one curator agent on each machine. The control panel talks to those agents over private networking, SSH tunnels, FRP, or another trusted transport.

On the control node:

```bash
CURATOR_REMOTE_AGENTS=server-a=http://127.0.0.1:54178,server-b=http://127.0.0.1:54179
CURATOR_REMOTE_ADMIN_TOKEN=the-agent-admin-token
```

Each remote agent should run with its own:

```bash
CURATOR_MACHINE_ID=server-a
CODEX_HOME=/home/you/.codex
```

Remote deletion is performed by the remote agent on its own machine, not by the control server directly.

## Systemd Deployment

Example user service:

```ini
[Unit]
Description=Codex Session Curator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/you/data/apps/codex-session-curator
Environment=HOST=127.0.0.1
Environment=PORT=54177
Environment=CODEX_HOME=/home/you/.codex
EnvironmentFile=-/home/you/.config/codex-session-curator/auth.env
EnvironmentFile=-/home/you/.config/codex-session-curator/llm.env
ExecStart=/usr/bin/npm run server
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-session-curator.service
```

For long-lived user services on a headless server:

```bash
loginctl enable-linger "$USER"
```

## Tunnels And Proxies

The app works behind reverse proxies and tunnels as long as WebSocket forwarding is enabled for terminal sessions.

Recommended local origin:

```text
http://127.0.0.1:54177
```

If you expose it through Cloudflare Tunnel, FRP, Nginx, Caddy, or SSH port forwarding, keep authentication enabled and prefer HTTPS for browser access.

## Notes For Open Source Use

Do not commit:

- API keys
- admin tokens
- tunnel tokens
- machine-specific SSH secrets
- real `~/.codex` data
- private service-account files

Use `.env`, `EnvironmentFile=`, or your secret manager for runtime credentials.

## License

Add the license that matches your intended release before publishing.
