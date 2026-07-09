# Codex Installed Skills

Last verified: 2026-06-03

## mihomo-subscription-route-publisher

- Installed personal skill path: `/home/grey/.agents/skills/mihomo-subscription-route-publisher/SKILL.md`
- Distribution source path: `/home/grey/work/agent-knowledge-stack/skills/shared/mihomo-subscription-route-publisher/SKILL.md`
- Current role: Mihomo route-rule maintenance and legacy `rules.xiannai.me` client compatibility.
- Boundary: Remnawave is primary for users, nodes, hosts, and subscription URLs; use `remnawave-mihomo-control-plane-operator` for primary subscription work.
- Updated on 2026-06-04 after Remnawave migration.

## remnawave-mihomo-control-plane-operator

- Installed personal skill path: `/home/grey/.agents/skills/remnawave-mihomo-control-plane-operator/SKILL.md`
- Distribution source path: `/home/grey/work/agent-knowledge-stack/skills/shared/remnawave-mihomo-control-plane-operator/SKILL.md`
- Current role: primary xiannai Remnawave plus Mihomo control plane: panel placement, node onboarding, Remnawave subscription publication, legacy Cloudflare compatibility, and verification.
- Boundary: use `mihomo-subscription-route-publisher` only for Mihomo route rules or old `rules.xiannai.me` compatibility.
- Added to distribution source on 2026-06-04.

## codex-control-plane-curator-operator

- Installed personal skill path: `/home/grey/.agents/skills/codex-control-plane-curator-operator/SKILL.md`
- Control-plane source path: `/home/grey/work/codex-control-plane/skills/codex-control-plane-curator-operator/SKILL.md`
- Use for accessing Codex history and control-plane state through `bin/curator`: session index, context pack, knowledge search, jobs, events, outcomes, dispatch/resume, and direct-action records.
- Source: Curator direct-action `00fabf64-37fd-4d19-a88e-3f67fd8be4a6`.

## server-identity-mihomo-route-operator

- Installed personal skill path: `/home/grey/.agents/skills/server-identity-mihomo-route-operator/SKILL.md`
- Control-plane source path: `/home/grey/work/codex-control-plane/skills/server-identity-mihomo-route-operator/SKILL.md`
- Distribution source path: `/home/grey/work/agent-knowledge-stack/skills/shared/server-identity-mihomo-route-operator/SKILL.md`
- Use for owned infrastructure operations that combine direct SSH connection to registered machines, stable `xiannai.me` server identity, SSH aliases, NetBird/FRP naming, new machine registration, and Mihomo DIRECT route publication checks.
- Supersedes the older active `server-identity-ssh-netbird-operator` installed skill by folding DNS/SSH/NetBird/FRP identity checks into this route operator.
- Updated on 2026-06-07 to make direct SSH connection to registered machines a first-class workflow.
- Source: Curator direct-action `a49dee07-db44-4553-8a5c-0db9a5f6f848`.

## retired active skill entries

- `ssh-headless-bootstrap`: merged into `ssh-connection-operator` headless mode.
- `server-identity-ssh-netbird-operator`: merged into `server-identity-mihomo-route-operator`.
