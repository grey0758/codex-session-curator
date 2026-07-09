# CLI-Anything Harness: Codex Session Curator

This harness gives agents a compact command-line interface for reading Codex Session Curator data without opening the web UI.

It wraps the real Curator backend first. If the HTTP service is unavailable, read-only commands fall back to the local curator state file.

## Install

```bash
cd agent-harness
pip install -e .
```

## Examples

```bash
cli-anything-codex-session-curator status --json
cli-anything-codex-session-curator sessions --limit 10 --json
cli-anything-codex-session-curator search newapi --limit 5 --json
cli-anything-codex-session-curator show <session-id> --json
cli-anything-codex-session-curator history <session-id> --limit 20 --json
cli-anything-codex-session-curator messages <session-id> --full --preserve
cli-anything-codex-session-curator context <session-id> --history-limit 12
cli-anything-codex-session-curator dispatch-to-codex "run focused tests" --policy-profile test_only
cli-anything-codex-session-curator resume-job <session-id> "continue implementation" --policy-profile code_edit
cli-anything-codex-session-curator outcome <job-or-session-id> --kind auto
```

`dispatch-to-codex` and `resume-job` default to `--mode pty`, so interactive workers can be guided while running and, when the backend creates one, attached through tmux. Use `--mode exec` for non-interactive execution.

Policy profiles are translated to backend job policy metadata:

- `read_only`
- `code_edit`
- `test_only`
- `deploy_allowed`
- `dangerous_ops_allowed`

`--policy '{"maxRuntimeMs":600000}'` can be combined with a profile; explicit JSON fields override the profile defaults.

Run without a subcommand to enter the REPL:

```bash
cli-anything-codex-session-curator
```

## Configuration

- `CURATOR_BASE_URL`, default `http://127.0.0.1:54177`
- `CURATOR_ADMIN_TOKEN`, used as `admin_token` for local API requests
- `CODEX_HOME`, default `~/.codex`
- `CODEX_CURATOR_STATE`, default `$CODEX_HOME/session-curator-state.json`

## Backend Boundary

The harness does not reimplement summarization, deletion, migration, or terminal behavior. It calls Curator HTTP endpoints and only reads the cached state file when the backend is offline.
