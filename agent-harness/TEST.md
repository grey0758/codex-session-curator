# Test Plan

## Unit Tests

- Verify fallback state loading and session filtering.
- Verify JSON command output for list, show, and history behavior.
- Verify API URL construction does not expose tokens in rendered summaries.

## End-To-End Checks

```bash
pip install -e .
python -m unittest discover -s cli_anything/codex_session_curator/tests
cli-anything-codex-session-curator status --json
printf 'help\nexit\n' | cli-anything-codex-session-curator
```

Optional checks when the Curator service is running:

```bash
cli-anything-codex-session-curator sessions --limit 5 --json
cli-anything-codex-session-curator analysis --json
```
