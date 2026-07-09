# Curator CLI

`bin/curator` is a small Python stdlib wrapper around the local `codex-session-curator` API.
`bin/server-identity` and `bin/server-identity-mcp` are compatibility wrappers
for the global server identity tooling in `/home/grey/work/agent-knowledge-stack`.

Defaults:

- `CURATOR_BASE_URL`: `http://127.0.0.1:54177`
- token source: `CURATOR_ADMIN_TOKEN`, then `~/.config/codex-session-curator/auth.env`

Common commands:

```bash
bin/curator search "hongkong003 cliproxy" --limit 3
bin/curator session-index "codex-session-curator" --limit 20
bin/curator knowledge-search "resume policy" --type preference --type runbook --project codex-control-plane --limit 10
bin/curator context-pack "control-plane CLI work" --cwd /home/grey/work/codex-control-plane --limit 20
bin/curator context <session-id> --history-limit 0
bin/curator dispatch "fix the service" --repo /path/to/repo --mode exec --policy-profile code_edit
bin/curator job <job-id>
bin/curator events <job-id> --after-seq 0
bin/curator guide <job-id> "只处理当前任务，不要展开旁支"
bin/curator stop <job-id>
bin/curator refresh <session-id>
```

Server identity compatibility bridge:

```bash
bin/server-identity rebuild
bin/server-identity list
bin/server-identity get jp001 --json
bin/server-identity render-ssh-config > /tmp/xiannai-server-identity.conf
```

These commands operate on the canonical inventory at
`/home/grey/work/agent-knowledge-stack/knowledge/inventories/xiannai-server-identity.yaml`
and generated SQLite at
`/home/grey/work/agent-knowledge-stack/data/server-identity.sqlite3`. They do
not read or write SSH private keys.

Server identity MCP bridge:

```toml
[mcp_servers.server_identity]
command = "/home/grey/work/agent-knowledge-stack/scripts/server_identity_mcp.py"
```

Tools exposed:

- `server_identity.list_machines`
- `server_identity.get_machine`
- `server_identity.upsert_machine`
- `server_identity.render_ssh_config`

The MCP bridge uses the generated SQLite built from canonical knowledge
inventory and does not handle SSH private keys.

Default resume discovery:

```bash
bin/curator session-index "<project or task keywords>" --limit 20
bin/curator context-pack "<project or task keywords>" --cwd "$PWD" --limit 20
bin/curator knowledge-search "<stable fact or convention>" --repo /path/to/repo --limit 10
```

Use the matched session when the index and context pack point to the same relevant project, cwd, or repository. `dispatch` sends `cwd`/`repo` to Curator so the backend can prefer `context-pack.recommendedResume` before starting a worker. Create a new child session only when no suitable resumable context exists or the user explicitly asks for a new session.

Commander direct-action records:

```bash
bin/curator direct-action start \
  --kind direct-action \
  --goal "update control-plane CLI docs" \
  --reason "small control-plane maintenance task" \
  --scope "AGENTS.md, bin/curator, bin/README.md, tests/test_curator_cli.py" \
  --cwd /home/grey/work/codex-control-plane \
  --target-repo /home/grey/work/codex-control-plane

bin/curator direct-action finish <action-id> \
  --status completed \
  --changed-files AGENTS.md,bin/curator,bin/README.md,tests/test_curator_cli.py \
  --tests "python -m unittest tests/test_curator_cli.py" \
  --verification "CLI payload tests passed" \
  --follow-up "none"

bin/curator direct-action list
```

The CLI never prints the admin token.

## Server Identity Compatibility

`bin/server-identity` forwards to the global agent knowledge stack builder.

Defaults:

- database: `/home/grey/work/agent-knowledge-stack/data/server-identity.sqlite3`
- source: `/home/grey/work/agent-knowledge-stack/knowledge/inventories/xiannai-server-identity.yaml`
- local SSH config output: `~/.ssh/config.d/05-xiannai-server-identity.conf`

Common commands:

```bash
bin/server-identity rebuild
bin/server-identity list
bin/server-identity get jp001 --json
bin/server-identity upsert --json --file machine.json
bin/server-identity export-json --out .state/server-identity.json
bin/server-identity render-ssh-config --out /tmp/xiannai-server-identity.conf
bin/server-identity render-ssh-config --write-local
```

The SQLite facts and rendered SSH config never contain SSH private keys.

Ownership boundary:

- source inventory, builder, MCP, and tests are tracked in `agent-knowledge-stack`
- this repository tracks compatibility wrappers only
- `memory/server-identity-topology.md` is legacy export history, not the
  canonical machine fact source
