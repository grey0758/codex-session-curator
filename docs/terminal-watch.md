# Terminal session watch

The Hub monitors Codex sessions opened through the panel terminal and enrolls
already running panel tmux sessions on startup. Monitoring continues after the
browser disconnects and survives blue-green deployments in
`~/.codex/session-curator-terminal-watch.json`. The UI shows the current state,
active Goal status, attempt count, and provider health.

Each minute the Hub inspects the session's isolated `codex-curator` tmux pane and
Codex JSONL on the owning machine, using the same SSH target/login environment
as the terminal. The probe returns structured state and, for unknown failures,
one shortened, redacted diagnostic line. It never returns the pane or session
transcript to the Hub.

Recovery requires all of the following:

1. A Codex task is unfinished and has produced no activity for at least three
   minutes. A task that Codex marked complete after an upstream failure also
   qualifies when it has no final answer and the terminal still shows the
   upstream error and prompt.
2. The terminal shows an upstream/transport failure and an input prompt. A
   second scan confirms the failure at least one minute later. Unknown error
   text may be classified by the configured DeepSeek endpoint; uncertainty
   stops recovery. A Codex `unexpected status 403 Forbidden` response is
   eligible only after a fresh authenticated request to that user's configured
   model succeeds; an unhealthy channel remains on hold.
3. The session is neither explicitly paused nor manually interrupted (including
   `Conversation interrupted - use /feedback if something went wrong`), and
   Codex is not already retrying. Codex's own `Automatic reconnect could not
   restore this session` / `Server connection could not be restored` state
   requires the user to preserve any editable draft and reconnect the CLI;
   the monitor does not send a message into that state.
4. A small authenticated request to that user's configured model and Responses
   endpoint succeeds. A failed/limited/unavailable channel postpones recovery.

The Hub then sends `/goal resume` for an active Goal, or `继续` for a regular
Codex task, into the existing tmux pane. It waits three minutes before another
attempt. A completed task or sustained new task progress counts as recovery;
the monitor waits for the old terminal error to clear before treating another
error as a new failure. After three ineffective attempts it stops writing and
shows **等待人工处理**. A new user turn or the panel's **人工处理后恢复巡检** button
re-enables monitoring. Closed terminals are never relaunched automatically.

The provider probe generates a tiny response and may consume a small amount of
tokens. It runs only for confirmed recovery candidates, not on every scan.
The monitor does not manage Claude sessions because their transcript/task state
has different semantics.
During a blue-green deploy, only the active slot runs inspections or sends
recovery messages. The new slot takes over after the previous slot stops.

For a registered session, inspect state via:

```text
GET /api/terminal-watch
GET /api/sessions/<id>/terminal-watch?machineId=<machine>&agent=codex
```

The authenticated `POST` counterpart registers an already running panel tmux
session for monitoring. `POST .../terminal-watch/reset` clears the three-attempt
lock after manual handling. All routes use the panel's existing authentication.
