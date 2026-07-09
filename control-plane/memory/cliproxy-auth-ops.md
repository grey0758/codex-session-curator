# CLIProxy Auth Operations

Last verified: 2026-05-13

- Production CLIProxy auth directory for `hongkong002` is `/home/grey/CLIProxyAPI/auths`.
- On 2026-05-13, 12 invalidated Codex auth JSON files were removed from that directory after creating backup `/home/grey/backups/cliproxy-auth-removals/remove-invalid-codex-accounts-20260512T164121Z.tar.gz`.
- Verification: target files were absent after removal, auth JSON count was 152, and `cli-proxy-api` logs showed incremental `REMOVE` events for all 12 files.
- Source: operator request in control plane and direct SSH verification on `hongkong002`.
