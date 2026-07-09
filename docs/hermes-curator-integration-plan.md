# Hermes + Codex Session Curator Integration Plan

## Goal

Let Hermes recall prior Codex CLI work, find the right session, resume that session through Codex Session Curator, supervise the Codex job, and report what Codex did.

The stable design is:

- Hermes memory stores only the pointer and operating rule.
- Codex Session Curator remains the source of truth for sessions, summaries, cwd, machines, resume IDs, history, and jobs.
- Hermes uses a skill and a memory provider to read Curator on demand.

## 1. Hermes MEMORY.md Entry

Purpose:

- Give Hermes a stable reminder that Curator is the Codex session memory source.
- Avoid copying session summaries into Hermes memory.

Implemented file:

- `/home/grey/.hermes/memories/MEMORY.md`

Rule:

- When the user asks to recall, find, continue, or supervise Codex work, Hermes should use Curator instead of asking the user to repeat context.

## 2. Hermes Skill

Purpose:

- Give Hermes explicit operating instructions and command examples.
- Keep the skill self-contained and human-readable.

Implemented file:

- `/home/grey/.hermes/skills/codex-session-curator/SKILL.md`

Main commands:

```bash
cli-anything-codex-session-curator dispatch-to-codex "fix/deploy/debug task" --json
cli-anything-codex-session-curator hermes-search "query" --limit 5 --json
cli-anything-codex-session-curator hermes-context <session-id> --history-limit 20 --json
cli-anything-codex-session-curator resume-job <session-id> "prompt" --json
cli-anything-codex-session-curator job <job-id> --json
```

Dispatch rule:

- For fix, implement, debug, deploy, test, refactor, and continue requests, Hermes should call `dispatch-to-codex` first.
- `hermes-search`, `hermes-context`, and `resume-job` are lower-level diagnostic or fallback commands.
- Hermes should not use terminal/ssh to modify target projects when a relevant Curator session exists.

## 3. Curator Hermes Search And Context

Purpose:

- Provide fast recall for Hermes without scanning or loading full transcripts on every turn.
- Search existing Curator state first, then load history only for a selected session.

Implemented APIs:

- `GET /api/hermes/search?q=<query>&limit=5`
- `GET /api/hermes/sessions/:id/context?historyLimit=20`

Implementation notes:

- Search reads `session-curator-state.json` directly through `CuratorStore`.
- Context reads state metadata and uses `parseSessionHistory()` for bounded recent history.
- Response includes title, summary, detailed summary, cwd, machine, resume command, tech stack, keywords, and a compact `memoryContext`.

## 4. Start Codex Resume Job

Purpose:

- Let Hermes continue a Codex session without relying on the browser terminal.
- Preserve machine locality: the Curator agent on the session's machine runs Codex.

Implemented API:

- `POST /api/hermes/jobs/resume`
- `POST /api/hermes/dispatch`

Request:

```json
{
  "sessionId": "019d...",
  "prompt": "Continue the task and run tests",
  "model": "optional-model"
}
```

Behavior:

- `/api/hermes/dispatch` searches local and remote Curator sessions, picks the best confident match, builds a Codex-worker prompt, starts the resume job, and returns the job id.
- If confidence is low, dispatch returns `needs_selection` with candidates instead of starting the wrong session.
- Uses `codex exec resume <session-id> <prompt>`.
- Runs in the recorded session cwd.
- Uses the server user's shell environment and `CODEX_BIN` resolution from the terminal module.
- If the session belongs to a remote agent, the control node forwards the request to that agent.

## 5. Job Supervisor

Purpose:

- Give Hermes a stable job handle.
- Track output, status, exit code, changed files, and errors.

Implemented file:

- `server/codex-jobs.ts`

Implemented APIs:

- `GET /api/hermes/jobs`
- `GET /api/hermes/jobs/:id`
- `POST /api/hermes/jobs/:id/stop`

Current state model:

- `running`
- `completed`
- `failed`
- `stopped`

Current limitations:

- Jobs are in-memory for this first version.
- Output is stored as a bounded tail.
- Completion is based on process exit.

Next enhancements:

- Persist job records in Curator state.
- Add SSE/WebSocket event stream.
- Add timeout and concurrent job limits.
- Add tmux-backed attach mode for long interactive jobs.

## 6. Hermes MemoryProvider

Purpose:

- Automatically prefetch relevant Curator sessions before Hermes answers.
- Expose tools for explicit search, context, resume, and job status checks.

Implemented files:

- `/home/grey/.hermes/plugins/codex_session_curator/plugin.yaml`
- `/home/grey/.hermes/plugins/codex_session_curator/__init__.py`

Enabled config:

```yaml
memory:
  provider: codex_session_curator
```

Tools:

- `codex_curator_dispatch_to_codex`
- `codex_curator_search`
- `codex_curator_context`
- `codex_curator_start_resume_job`
- `codex_curator_job`

Tool selection rule:

- `codex_curator_dispatch_to_codex` is the preferred first tool for project-changing requests.
- The other tools remain available for selection, context inspection, manual fallback, and job polling.

Prefetch behavior:

- Calls `hermes-search`.
- Injects a compact list of relevant Codex sessions.
- Does not write Hermes turns into Curator.

## 7. Promote Stable Workflows To Knowledge And Runbooks

Purpose:

- Keep raw sessions in Curator.
- Promote only reusable workflows into `knowledge/` and skill kits.

Recommended promotion rule:

- One-off or short tasks: Curator only.
- Useful project recovery context: Curator keep.
- Reusable procedure: promote to knowledge runbook.
- Frequently reused agent workflow: generate a self-contained skill kit.

Future command shape:

```bash
cli-anything-codex-session-curator export-knowledge <session-id>
cli-anything-codex-session-curator promote-runbook <session-id> --topic hermes-curator
```
