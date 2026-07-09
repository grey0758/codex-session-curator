# Agent Control Plane Guide (Codex + Claude)

This directory is the control plane for coordinated agent work. It lives inside the
Curator panel repository (`codex-session-curator`) — the panel backend is the shared
session store, and this workspace is the operator layer with two symmetric entrypoints:

- `bin/curator` — Codex entrypoint. A Python client for the Curator service
  (session-index, context-pack, dispatch, resume, direct-action).
- `bin/claude-plane` — Claude entrypoint. A thin wrapper mapping the same verbs onto
  Claude Code's native primitives (`claude --resume`, sub-agents, `/schedule`).

Core model: an agent schedules, the shared session store controls, workers execute
and record. The Curator backend now indexes both Codex (`~/.codex/sessions`) and
Claude Code (`~/.claude/projects`) sessions and dispatches both agents' workers, so
either entrypoint sees one unified session store.

| Purpose | Codex (`bin/curator`) | Claude (`bin/claude-plane`) |
|---|---|---|
| Resume prior work | `curator session-index` / `resume` | `claude --resume` / `--continue` |
| Build handoff context | `curator context-pack` | native context + memory |
| Dispatch a worker | `curator dispatch` (spawns `codex`) | sub-agent or headless `claude -p` |
| Recurring work | Curator schedules | `/schedule`, `/loop` |
| Record state | `curator direct-action` | `memory/*.md`, commits |

- The dispatcher reads the request, chooses the next concrete task, assigns it to a worker or performs it directly, and checks the result.
- The shared session store (Curator backend) keeps job state, session links, logs, and handoff context so work can continue across workers and turns.
- Workers are execution agents. They operate in target repositories, make scoped changes, run checks, and report what changed.
- Records are part of the work. Every meaningful dispatch, result, blocker, and follow-up should be captured through Curator or in the appropriate local memory file.

## Operating Principles

- Keep this workspace small and operational. Do not turn `AGENTS.md` into a transcript, scratchpad, or long-term memory dump.
- This `control-plane/` directory is tracked as part of the `codex-session-curator` panel repository. Control-plane code, tests, reusable skills, and memory exports live here alongside the panel.
- Keep runtime state out of Git. `.state/`, logs, local Curator caches, tokens, and private keys are local-only.
- Treat target repositories as shared workspaces. Other workers may be active; never revert changes you did not make.
- Keep worker tasks narrow, verifiable, and tied to a target path or repo.
- Prefer explicit handoffs: task, target repo, constraints, expected output, verification command, and where to report results.
- Use Curator for state and session continuity instead of relying on hidden conversation context.
- Record durable facts in `memory/`; put reusable procedures in `skills/`; keep transient observations in Curator job/session notes.

## Commander Policy

Default to dispatching work to a worker through Curator. The control-plane commander should directly change files or run target-repo work only when dispatch is inappropriate, such as:

- Curator or the dispatch path is broken and needs self-repair.
- The action is a small control-plane maintenance task that would be slower or less clear to delegate.
- The user explicitly asks the commander to act directly.
- A manual note is needed to preserve state without starting a worker.

Every direct action must be recorded with:

- reason
- scope
- changed files
- tests
- verification
- follow-up

Use `bin/curator direct-action start` before direct execution and `bin/curator direct-action finish` after the result is known. If Curator itself is unavailable, self-repair is allowed; record the action retroactively as soon as the CLI/API is usable again.

## Session Resume Policy

Prefer resuming an indexed session over creating a new child session. When a task arrives, first identify existing context with both the resumable session index and a context pack:

```bash
bin/curator session-index "<project or task keywords>" --limit 20
bin/curator context-pack "<project or task keywords>" --cwd "$PWD" --limit 20
```

Resume the matched session when confidence is high: the session has the relevant project, cwd or repository, durable context, and a resumable command. Use `context-pack` to gather concise handoff material before dispatching or resuming, and use `knowledge-search` when stable facts, project conventions, or previous decisions are needed.

Create a new child session only when:

- the current conversation, session index, and context pack cannot identify a relevant project/context
- the user explicitly asks for a new session
- the matched session is not resumable and no suitable replacement exists

When creating a new child session, record why resume was not used in the worker handoff or direct-action record.

## Curator CLI

Use `bin/curator` from the control-plane root when a request requires dispatching, listing, inspecting, resuming, or recording worker work.

```bash
cd /home/grey/work/codex-control-plane
bin/curator --help
```

Typical flow:

1. Inspect available commands with `bin/curator --help`.
2. Run `bin/curator session-index "<project or task keywords>" --limit 20` and `bin/curator context-pack "<project or task keywords>" --cwd "$PWD" --limit 20`.
3. Dispatch with the matched project path, for example `bin/curator dispatch "<task>" --repo /path/to/repo --policy-profile code_edit`; Curator will build a context pack and prefer `recommendedResume`.
4. List or inspect current jobs before creating overlapping work.
5. Dispatch a worker with a narrow task and explicit constraints.
6. Watch or inspect the worker session until it reaches a clear result.
7. Record the outcome, verification, blockers, and follow-ups.

When invoking workers, include:

- target repository or directory
- exact files or areas in scope
- files or areas out of scope
- requested checks
- expected final report format
- any relevant memory or skill path to read first

Do not assume command names beyond what `bin/curator --help` exposes in the current checkout. If the CLI changes, follow the help output and update these docs when the workflow itself changes.

## Reading Skills

Skills are reusable operating procedures for recurring work. The index is at:

```text
skills/INDEX.md
```

Before dispatching or doing specialized work:

1. Read `skills/INDEX.md`.
2. Open only the specific skill file that matches the task.
3. Follow the skill's workflow and referenced scripts/assets.
4. If a skill is stale or incomplete, record the gap and keep the task moving with the best safe fallback.

Skills should contain procedures, checklists, command patterns, and references. They should not contain private transcripts or large session histories.

## Memory

Durable memory belongs under:

```text
memory/
```

Use memory for stable facts that future scheduling decisions need, such as service topology, durable credentials references, known deployment constraints, and recurring project conventions.

Do not store bulk logs, temporary worker chatter, or complete conversation transcripts in memory. Link to Curator records or external logs instead.

## Server Identity Facts

Xiannai machine identity facts are managed by:

```text
/home/grey/work/agent-knowledge-stack/knowledge/inventories/xiannai-server-identity.yaml
/home/grey/work/agent-knowledge-stack/scripts/build_server_identity_sqlite.py
```

Curator API access is wrapped for agents by:

```text
bin/curator server-identity ...
bin/server-identity-mcp
```

The current generated runtime database is:

```text
/home/grey/work/agent-knowledge-stack/data/server-identity.sqlite3
```

The control plane keeps Curator history, session, job, and direct-action
records. Global SSH machine facts now belong to `agent-knowledge-stack`, and
`bin/server-identity` / `bin/server-identity-mcp` are compatibility wrappers.
SSH private keys must stay in 1Password or a short-lived local SSH agent, never
in SQLite, memory exports, Worker inventory, generated SSH config, MCP output,
or Git.
