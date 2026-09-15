# Curator Primary and Standby Architecture

Last verified: 2026-09-15

This document describes the runtime topology represented by the deployment units
in this repository. It deliberately does not contain credentials, tokens, or
machine-specific private key material.

## Roles

### `gpl001`: normal Curator Hub

`gpl001` owns the normal Curator Hub write path:

- authenticated panel and API;
- Codex and Claude session aggregation;
- knowledge federation, canonical document reads, evaluation, context packs,
  server identity, and direct-action records;
- remote-agent aggregation for `cnal002` and `us002`;
- the local blue-green service slots.

The slot unit binds each release to localhost. The active proxy remains at
`127.0.0.1:54177`; the two application slots use `127.0.0.1:54187` and
`127.0.0.1:54188`. See `deploy/codex-session-curator-slot@.service` and
`docs/blue-green-deploy.md`.

### `sgp001`: fenced active-passive DR

`sgp001` carries a synchronized copy of the Hub and its required runtime state,
but remains stopped and unpromoted during normal operation. Promotion is an
explicit operator action. It must first prove that the primary writer is
unavailable (or that a controlled exercise was authorized), establish the
promoted fence, start and verify replacement worker tunnels, and then start the
DR Hub.

When promoted, `sgp001` is the only Curator writer. Failback first stops and
fences the DR Hub and its worker tunnels, then restores and verifies `gpl001`.
The browser CNAME may be switched only after the local target verification gate
passes. DNS or tunnel health never elects a writer.

The promotion scripts and the Cloudflare route operator live in the upper
`ops-agent-knowledge-stack` workspace. This repository supplies the Hub and
worker runtimes; it does not implement automatic promotion or active-active
writes.

### `cnal002` and `us002`: thin workers

Each worker runs the backend with `CURATOR_ROLE=worker`, listening on
`127.0.0.1:55177`. Workers retain native Codex/Claude session files, resume and
terminal APIs, jobs, and recycle-bin operations. They do not run the panel,
knowledge store, Qdrant, OpenMemory, Ollama, evaluator, or remote aggregation.

The worker-side Hub client uses `http://127.0.0.1:54176`. A bidirectional SSH
tunnel makes that address reach whichever Hub is active:

```text
normal:   gpl001 54179 -> cnal002 55177; cnal002 54176 -> gpl001 54177
          gpl001 54178 -> us002   55177; us002   54176 -> gpl001 54177
promoted: sgp001 54179 -> cnal002 55177; cnal002 54176 -> sgp001 54177
          sgp001 54178 -> us002   55177; us002   54176 -> sgp001 54177
```

The localhost address is intentionally unchanged during promotion and
failback. Worker ports are not published on public or raw overlay interfaces.
The production `us002` tunnel uses the managed `ssh-1p` helper; private keys are
loaded only for the process lifetime.

## State and Routing Rules

1. Normal state: `gpl001` is the Curator writer, its worker tunnels are active,
   and `sgp001` is stopped and unpromoted.
2. Promotion: fence the primary, mark `sgp001` promoted, take over both worker
   tunnels, verify workers and the local Hub, then switch the protected browser
   CNAME if public failover is required.
3. Failback: demote and independently fence `sgp001`, restore `gpl001`, verify
   the Hub and both workers, then switch the CNAME back.

Never run both Curator sites as writable instances. Do not round-robin writes,
auto-promote from a monitor timeout, or use the shared OpenCodex/NewAPI load
balancer for the Curator administration surface. OpenBao writer ownership is
separately fenced and is not elected by this repository.

## Source Alignment

The following files are the code-level contracts checked against this topology:

- `deploy/codex-session-curator-slot@.service`: Hub remote-agent ports and
  per-machine terminal SSH targets;
- `deploy/cnal002-codex-session-curator-worker.service` and
  `deploy/us002-codex-session-curator-worker.service`: thin-worker role,
  localhost listener, and unchanged Hub client address;
- `deploy/cnal002-curator-worker-tunnel.service` and
  `deploy/us002-curator-worker-tunnel.service`: bidirectional SSH forwarding;
- `docs/blue-green-deploy.md`: primary local release and rollback contract;
- `docs/thin-worker.md`: worker artifact boundary and verification checks.

The durable DR decision, promotion/failback scripts, and public route details
are maintained in the upper ops workspace and must be consulted before any
production failover.
