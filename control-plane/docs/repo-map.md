# Claude Control Plane — Repo Map

How this panel relates to the rest of the local knowledge stack.

## This panel

```text
repos/codex-session-curator/control-plane/
  CLAUDE.md          agent guide (AGENTS.md -> CLAUDE.md symlink for Codex parity)
  README.md
  bin/claude-plane   thin wrapper over the claude CLI + native primitives
  docs/repo-map.md   this file
  memory/            shared committed durable facts
```

## Sibling and upstream workspaces

| Path | Role |
|---|---|
| `../codex-control-plane` | Codex/Curator control plane. Symmetric counterpart to this panel. |
| `../codex-session-curator` | Curator panel frontend/backend; indexes both Codex and Claude sessions and dispatches both agents' workers. |
| `../agent-knowledge-stack` | Central knowledge stack; canonical shared skills, knowledge, server-identity facts. |
| `../../` (`ops-agent-knowledge-stack`) | Upper ops workspace mounting these repos. |

## Ownership boundaries

- Canonical knowledge facts: `../agent-knowledge-stack/knowledge/`.
- Canonical shared skills: `../agent-knowledge-stack/skills/shared/` (installed to
  both `~/.claude/skills/` and `~/.agents/skills/`).
- Server identity facts: owned by `agent-knowledge-stack`; this panel only reads them.
- This panel owns only its own guide, wrapper, and memory export — it is not a source
  of truth for knowledge or skills.

## Codex ⇄ Claude parity

The two control planes are intentionally symmetric. When one panel's operating model
changes, update the other so the cross-agent experience stays aligned. The mechanism
differs (Curator service vs. native primitives); the behavior should not.
