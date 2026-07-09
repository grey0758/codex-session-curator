# Codex Control Plane

This directory is the operating workspace for coordinated Codex work.

The operating idea is:

```text
Codex schedules. Curator controls. Workers execute and record.
```

Use this workspace when you want Codex to coordinate multiple tasks, hand work to worker sessions, keep records, and resume from saved state instead of relying on one long chat.

## Run Codex Here

Start Codex from the control-plane root:

```bash
cd /home/grey/work/codex-control-plane
codex
```

Once inside Codex, ask it to inspect `AGENTS.md` and use `bin/curator` for scheduling or worker control.

For direct Curator usage:

```bash
cd /home/grey/work/codex-control-plane
bin/curator --help
```

Use the help output as the source of truth for available Curator commands in this checkout.

## Telegram Thin Gateway

The Telegram gateway should stay thin. It is an input and notification channel, not the place where scheduling logic or durable memory lives.

Expected flow:

1. Send a request to the Telegram bot or gateway.
2. The gateway forwards the request into this control-plane workspace.
3. Codex interprets the request and uses Curator to dispatch, inspect, resume, or record worker sessions.
4. Workers operate in the target repositories and report results back through Curator.
5. The gateway returns concise status, blockers, and completion summaries to Telegram.

Gateway messages should include enough context for routing:

- target repo or service
- desired outcome
- urgency or deadline
- constraints and files out of scope
- whether changes should be committed, deployed, or only prepared

Keep secrets, large logs, and long transcripts out of Telegram. Store durable state in Curator records or `memory/`, and keep reusable procedures in `skills/`.

## Workspace Layout

- `AGENTS.md`: agent operating rules for this control plane
- `bin/curator`: Curator CLI entry point
- `bin/server-identity`: compatibility wrapper for the global agent-knowledge-stack server identity builder
- `bin/server-identity-mcp`: compatibility wrapper for the global agent-knowledge-stack server identity MCP
- `skills/INDEX.md`: list of reusable procedures workers should read when relevant
- `memory/README.md`: rules for durable memory
- `memory/`: stable operational facts and references

## Ownership And Git Boundary

This directory is an independent Git repository, even when mounted at:

```text
/home/grey/work/agent-knowledge-stack-ops/repos/codex-control-plane
```

The compatibility path remains:

```text
/home/grey/work/codex-control-plane
```

Track control-plane code, CLI tests, reusable skills, and human-readable memory
exports here. Do not track runtime state, generated SQLite databases, local
Curator caches, logs, tokens, or private keys. `.state/` is intentionally
ignored.

## Server Identity Bridge

The global server identity source of truth now lives in:

```text
/home/grey/work/agent-knowledge-stack/knowledge/inventories/xiannai-server-identity.yaml
```

The SQLite runtime and MCP server are generated from that inventory by:

```text
/home/grey/work/agent-knowledge-stack/scripts/build_server_identity_sqlite.py
/home/grey/work/agent-knowledge-stack/scripts/server_identity_mcp.py
```

This repository keeps `bin/server-identity` and `bin/server-identity-mcp` as
compatibility wrappers only. Curator history, sessions, jobs, and direct-action
records remain in the control plane; global SSH machine facts do not.

Legacy Curator server identity commands may still be used while callers are
migrated:

```bash
bin/curator server-identity list
bin/curator server-identity get jp001
bin/curator server-identity upsert --file machine.json
bin/curator server-identity patch jp001 --file patch.json
bin/curator server-identity export
bin/curator server-identity ssh-config
```

Legacy Curator API endpoints:

- `GET /api/server-identity/machines`
- `GET /api/server-identity/machines/:alias`
- `POST /api/server-identity/machines`
- `PATCH /api/server-identity/machines/:alias`
- `POST /api/server-identity/export`
- `GET /api/server-identity/ssh-config`

MCP-facing tool names should map to these same operations:
`server_identity.list_machines`, `server_identity.get_machine`,
`server_identity.upsert_machine`, and `server_identity.render_ssh_config`.

Prefer the global MCP command:

```toml
[mcp_servers.server_identity]
command = "/home/grey/work/agent-knowledge-stack/scripts/server_identity_mcp.py"
```

Rendered SSH config and machine facts do not include SSH private keys; use
1Password SSH agent or a short-lived local `ssh-agent` for keys.

## Collaboration Rules

This workspace may be used by multiple workers at once.

- Do not revert changes you did not make.
- Keep edits scoped to the requested files.
- Check current state before dispatching overlapping worker tasks.
- Record outcomes so the next Codex session can continue without guessing.
