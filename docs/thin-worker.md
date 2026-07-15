# Curator Thin Worker

## Roles

The Hub runs the panel, knowledge federation, canonical Markdown access,
evaluation, server identity, direct actions, context packs, and remote-agent
aggregation. A thin worker runs only local Codex/Claude session discovery and
execution APIs.

`CURATOR_ROLE=worker` exposes:

- session list, details, history, and messages
- Codex and Claude resume jobs and job events
- files, recycle bin, restore, purge, and session deletion
- interactive terminal WebSocket support
- `/api/meta` with role and capability discovery

It returns 404 for Hub-only APIs and does not serve the frontend.

## Artifact

```bash
npm run build:worker -- --output /tmp/curator-worker
cd /tmp/curator-worker
npm ci --omit=dev
CURATOR_ROLE=worker HOST=127.0.0.1 PORT=55177 npm start
```

The artifact includes `server/`, a backend-only package lock, and
`bin/curator`. It excludes `src/`, `dist/`, the full control plane,
`@fastify/static`, React, Vite, LangGraph, evaluator source, analysis logs, and
the knowledge store.

## Hub Client

Install `bin/curator` on the worker and configure the reverse localhost tunnel:

```text
~/.config/codex-session-curator/client.env
CURATOR_HUB_BASE_URL=http://127.0.0.1:54176
```

The client reads authentication from `CURATOR_ADMIN_TOKEN` or
`~/.config/codex-session-curator/auth.env`. Do not print either value.

Knowledge workflows use:

```bash
curator knowledge-search "keywords" --limit 5
curator knowledge-document knowledge/runbooks/example.md
curator context-pack "task" --cwd "$PWD" --limit 5
```

## Tunnel

Keep both listeners on localhost. A Hub-initiated SSH connection can provide
both directions:

```text
Hub 127.0.0.1:54178 -> worker 127.0.0.1:55177
worker 127.0.0.1:54176 -> Hub 127.0.0.1:54177
```

Use unique Hub-side ports for multiple workers. Do not expose Curator directly
on a public or raw overlay address.

## Verification

Verify all of the following before replacing an existing full worker:

- `/api/meta` reports `role=worker`
- both Codex and Claude sessions are indexed
- Hub-only API routes return 404
- no frontend, evaluator, or knowledge-store files exist in the artifact
- real Codex and Claude resume jobs exit successfully
- terminal WebSockets create the expected remote tmux sessions
- temporary Codex and Claude fixtures pass archive, restore, and purge
- worker-side `curator` can search Hub knowledge, read canonical Markdown, and
  build context packs

Keep the old service, tunnel unit, repository, and one Hub release until the
new path has completed at least two stable release cycles.
