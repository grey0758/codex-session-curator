# Skills Index

Skills are reusable procedures for this control plane. They tell Codex and workers how to perform recurring work consistently.

Read this index before specialized work, then open only the relevant skill documents. Keep skill files procedural: commands, checklists, expected inputs, expected outputs, and verification steps.

## Current Skills

- codex-control-plane-curator-operator: query and operate the local Curator API through `bin/curator` for Codex history, context packs, knowledge search, jobs, events, outcomes, dispatch/resume, and direct-action records.
  Path: skills/codex-control-plane-curator-operator/SKILL.md
  Use when: a task needs prior Codex history, resumable sessions, context packs, worker/job state, durable knowledge, or control-plane action recording.

- server-identity-mihomo-route-operator: connect to registered xiannai servers by stable identity, and coordinate xiannai.me server identity DNS/SSH/NetBird/FRP naming with Mihomo DIRECT route publication and live subscription verification.
  Path: skills/server-identity-mihomo-route-operator/SKILL.md
  Use when: a task needs to SSH into a registered owned server, identify a machine from alias/IP/hostname, register a new physical machine identity, or change owned server hostnames, public IPs, NetBird/FRP routes, service migration aliases, or Mihomo direct/proxy exclusions for those domains.

- remnawave-mihomo-control-plane-operator: operate the primary xiannai Remnawave plus Mihomo control plane, including panel placement, node onboarding, subscription publication, legacy Cloudflare compatibility, and verification.
  Path: /home/grey/.agents/skills/remnawave-mihomo-control-plane-operator/SKILL.md
  Use when: a task changes Remnawave users, nodes, hosts, panel placement, primary subscription output, or needs to check whether legacy Mihomo compatibility still matches Remnawave topology.

When adding a skill, use this format:

```text
- skill-name: one-line purpose
  Path: skills/skill-name/SKILL.md
  Use when: concrete trigger condition
```

## Skill Rules

- Skills describe repeatable workflows, not one-off session notes.
- Skills should name required tools, target directories, checks, and reporting format.
- Skills may reference scripts or templates, but should avoid copying large generated output.
- If a worker uses a skill, the final report should mention which skill was used and whether any step was skipped.
- If no skill matches, proceed normally and record a proposed skill only when the workflow is likely to recur.


## mihomo-subscription-route-publisher

Use when owned domains or other routes must be changed in Mihomo route rules or old `rules.xiannai.me` Mihomo client compatibility. Remnawave is now primary for users, nodes, hosts, and subscription URLs; use `remnawave-mihomo-control-plane-operator` for those. Canonical local skill path: `/home/grey/.agents/skills/mihomo-subscription-route-publisher/SKILL.md`.
