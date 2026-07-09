# Memory

This directory stores durable control-plane memory.

Use it for stable facts that future Codex scheduling or worker handoff decisions need. Examples:

- service topology and ownership notes
- deployment constraints
- recurring repo conventions
- links to authoritative runbooks
- durable references to secrets locations, never secret values
- known long-lived blockers or follow-up commitments

Do not use memory for:

- full chat transcripts
- temporary worker logs
- raw command output
- secrets or tokens
- speculative notes that have not been verified

## Writing Memory

Memory entries should be short, dated when useful, and tied to a source or observation.

Prefer this shape:

```text
## Topic

Last verified: YYYY-MM-DD

- Fact or constraint.
- Source: Curator job/session ID, repo path, runbook path, or operator note.
```

If information becomes stale, update or remove it instead of adding contradictory notes.

