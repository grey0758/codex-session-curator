---
name: server-identity-mihomo-route-operator
description: Connect to registered xiannai servers by stable identity, and coordinate xiannai.me server identity DNS, SSH, NetBird/Tailscale overlay access, FRP naming, machine registration, and Mihomo DIRECT routing publication so server operations do not depend on stale hostnames or raw IP lists.
license: CC-BY-4.0
compatibility: Codex, Claude Code, and Markdown skill runners with bash, OpenSSH, Cloudflare API through 1Password, optional NetBird, and Mihomo publishing tools.
---

# Server Identity Mihomo Route Operator

Use this project skill when a task needs to connect to a registered xiannai server, identify a server from an alias/IP/hostname, register a new physical machine identity, onboard or repair overlay access, or change DNS, SSH, NetBird/Tailscale, FRP naming, service roles, or Mihomo route exclusions for owned infrastructure.

This skill supersedes the older `server-identity-ssh-netbird-operator` and absorbs the xiannai server use case of `netbird-selfhosted-peer-onboarder` by folding SSH connection, overlay onboarding, FRP, server identity, and Mihomo route publication into one workflow. Use `ssh-connection-operator` only as the lower-level SSH repair/reference workflow when this skill needs detailed SSH troubleshooting. Use `netbird-selfhosted-peer-onboarder` only for standalone NetBird work that is not tied to xiannai server identity.

## Required Source Skills

Read these local skills only as needed:

- `/home/grey/.agents/skills/ssh-connection-operator/SKILL.md`
- `/home/grey/.agents/skills/mihomo-subscription-route-publisher/SKILL.md`
- `/home/grey/.agents/skills/netbird-selfhosted-peer-onboarder/SKILL.md` for legacy self-hosted NetBird enrollment details
- `/home/grey/.agents/skills/cloudflare-openwebui-tunnel-operator/SKILL.md` for DNS Records API and zone publication behavior
- `/home/grey/.agents/skills/onepassword-cli-secret-operator/SKILL.md` for Cloudflare and distribution token reads

## Durable Memory

Read the global structured inventory or the server identity MCP before
migrations or multi-server edits:

- canonical facts: `/home/grey/work/agent-knowledge-stack/knowledge/inventories/xiannai-server-identity.yaml`
- generated SQLite: `/home/grey/work/agent-knowledge-stack/data/server-identity.sqlite3`
- builder: `/home/grey/work/agent-knowledge-stack/scripts/build_server_identity_sqlite.py`
- MCP server: `/home/grey/work/agent-knowledge-stack/scripts/server_identity_mcp.py`

The old export mirror at `/home/grey/work/codex-control-plane/memory/server-identity-topology.md`
is legacy compatibility only.

## Core Rule

Use stable `xiannai.me` names as the operational contract, then ensure Mihomo can reach those names directly.

- Physical public identity: `hkNNN.ip.xiannai.me`
- Physical NetBird identity: `hkNNN.nb.xiannai.me`
- Physical Tailscale identity, if the environment migrates: `hkNNN.ts.xiannai.me`
- FRP break-glass identity: `hkNNN.frp.xiannai.me`
- Movable service role: `<service>-primary.svc.xiannai.me`
- Mihomo direct cover: `DOMAIN-SUFFIX,xiannai.me` in `/home/grey/mihomo-fullstack-deploy/worker/src/inline-rules.js`

For already registered machines, this skill may directly connect by canonical alias such as `hk002`, `sgp001`, `jp001`, or `ny001`. Always resolve the target through memory and SSH config before guessing.

## Server Identity Rules

- Public IP identity records are DNS-only A records: `hkNNN.ip.xiannai.me`.
- NetBird identity names are `hkNNN.nb.xiannai.me`.
- Tailscale identity names are `hkNNN.ts.xiannai.me` only after a verified migration or parallel pilot.
- FRP break-glass names are `hkNNN.frp.xiannai.me` or device-specific names under `frp.xiannai.me`.
- Service roles use movable `*.svc.xiannai.me` records.
- Do not use old descriptive names like `hongkong002` as source of truth when they conflict with `hkNNN.ip.xiannai.me`.
- If `netbird.xiannai.me` resolves to `117.72.151.207` or `198.18.x.x`, fix DNS pollution before NetBird debugging.
- If NetBird ping works but SSH fails, debug SSH authorization with `ssh-connection-operator`, not NetBird.
- If overlay ping works but SSH fails, treat transport and SSH authorization as separate validations.
- Do not switch a registered server from NetBird to Tailscale in place without proving public SSH or FRP break-glass access first.
- Cloudflare records for SSH and machine identity must be DNS only.
- Registered short aliases such as `hk002`, `hk005`, `jp001`, `ny001`, and `sgp001` should be usable as direct SSH targets.
- If the user gives a raw IP that is already registered in memory, prefer the canonical alias and `.ip.xiannai.me` name in the final SSH command.
- If the user gives a raw IP that is not registered, verify SSH reachability first, then register the physical identity before treating it as a stable machine.

## Overlay Access Mode

NetBird is the current deployed overlay for this environment unless the user explicitly asks for a Tailscale migration or pilot. Treat public SSH, FRP break-glass, and overlay access as separate paths, and keep at least one verified non-overlay recovery path before changing overlay membership.

For NetBird onboarding or repair:

1. Confirm SSH access to the target machine through public SSH, an existing canonical alias, or fixed FRP break-glass.
2. Verify the target resolves `netbird.xiannai.me` to `38.246.235.98`.
3. If it resolves to `117.72.151.207`, stop and repair the stale path first.
4. If it resolves to `198.18.x.x`, treat it as fake-IP pollution before changing NetBird server state.
5. Ensure the `netbird` client is installed.
6. Prefer setup-key enrollment for long-lived server-like machines.
7. If the current peer is an expired interactive SSO profile, run `netbird profile list` and `netbird deregister --profile <ACTIVE_PROFILE>` before re-enrollment.
8. Run `netbird down`, then `netbird up --management-url https://netbird.xiannai.me --admin-url https://netbird.xiannai.me --setup-key "<SETUP_KEY>" --allow-server-ssh --disable-dns`.
9. Verify `netbird status --detail`, peer tunnel ping, and optional SSH over the tunnel IP.
10. Record the verified tunnel IP and `.nb.xiannai.me` identity only after tunnel connectivity is proven.

For a Tailscale pilot or migration:

1. Do not remove NetBird until Tailscale has been installed, authenticated, and verified from at least one existing admin machine.
2. Prefer tagged server enrollment with short-lived or one-off auth keys kept in 1Password; do not print auth keys.
3. Verify `tailscale status`, `tailscale ip -4`, peer ping, and SSH over the Tailscale IP or MagicDNS name.
4. Add or update `hkNNN.ts.xiannai.me` only after the Tailscale IP/name is verified.
5. Keep `.nb.xiannai.me` during the parallel run; remove it only after SSH, service access, and Mihomo direct coverage are verified through Tailscale.

## SSH Connection Mode

For an already registered server:

1. Look up the target through `server_identity.get_machine` MCP or `/home/grey/work/agent-knowledge-stack/scripts/build_server_identity_sqlite.py get <alias> --json`.
2. Normalize user input to the canonical alias, DNS identity, public IP, SSH user, and expected hostname.
3. If the local generated SSH config is stale, rebuild with `/home/grey/work/agent-knowledge-stack/scripts/build_server_identity_sqlite.py render-ssh-config --write-local`.
4. Check resolved SSH configuration with `ssh -G <alias>`.
5. Verify connection with `ssh -o BatchMode=yes -o ConnectTimeout=8 <alias> hostname` or a task-specific read-only command.
6. Return the final SSH command, normally `ssh <alias>`.

For an unregistered server:

1. Confirm the proposed canonical alias, region prefix, public IP, expected SSH user, and intended role.
2. Test raw TCP reachability to public SSH before editing identity records.
3. Use direct SSH or `ssh-1p` per `ssh-connection-operator` to prove access.
4. Record the verified hostname with `hostname`.
5. Upsert DNS-only `<region>NNN.ip.xiannai.me`.
6. Add layered SSH config with both the canonical alias and raw IP in the same `Host` stanza.
7. Verify DNS, `ssh -G`, and SSH login by canonical alias.
8. Update `/home/grey/work/agent-knowledge-stack/knowledge/inventories/xiannai-server-identity.yaml` after verification, then rebuild SQLite.

## Combined Workflow

1. Normalize the target into a machine identity, connection target, and optional service role.
2. Check the global server identity inventory or MCP for the current verified alias, DNS name, public IP, hostname, SSH user, SSH config, and overlay state.
3. If the target is already registered and the user only wants to connect or run a command, run SSH Connection Mode and stop after verification unless DNS/Mihomo state is stale.
4. For new or changed physical servers, run the merged server identity workflow:
   - confirm the user-provided physical server map: alias, public IP, expected SSH user, and role
   - verify raw TCP reachability to public SSH before editing config
   - use SSH Connection Mode and `ssh-connection-operator` details to verify direct SSH or headless `ssh-1p`
   - upsert DNS-only `hkNNN.ip.xiannai.me`
   - verify DNS through Cloudflare API and public DoH
   - update layered SSH config in an early file such as `~/.ssh/config.d/05-xiannai-server-identity.conf`
   - keep raw IP aliases in the same `Host` stanza for break-glass and host-key continuity
   - verify overlay prerequisites and record NetBird or Tailscale tunnel IPs only after client status and peer connectivity confirm them
   - use FRP only as fixed break-glass access when public SSH or NetBird is unavailable
5. For service migrations, change `*.svc.xiannai.me`; do not repoint `*.ip.xiannai.me` unless the physical server identity itself changed.
6. Confirm Mihomo route coverage:
   - `DOMAIN-SUFFIX,xiannai.me` should cover `*.ip.xiannai.me`, `*.nb.xiannai.me`, `*.frp.xiannai.me`, and `*.svc.xiannai.me`
   - after a Tailscale migration, `DOMAIN-SUFFIX,xiannai.me` should also cover `*.ts.xiannai.me`
   - if the suffix rule is missing, add it to `worker/src/inline-rules.js`
   - if the user explicitly wants a non-`xiannai.me` infrastructure domain direct, add that domain to the same direct rules source
7. If Mihomo source changed, regenerate assets, validate, deploy Worker code, call `/sync`, and verify live output with token and cache busting.
8. If no Mihomo source changed, still verify the live direct rule and one concrete client config when the task is about route behavior.
9. Update the global server identity inventory after verified topology changes, then rebuild generated SQLite/MCP runtime data.

## Validation Commands

```bash
nc -vz -w 5 <public-ip> 22
ssh -G <alias>
ssh -o BatchMode=yes -o ConnectTimeout=8 <alias> hostname
ssh -o BatchMode=yes -o ConnectTimeout=8 <alias> exit
ssh <alias>
getent hosts netbird.xiannai.me
dig +short A <alias>.ip.xiannai.me
curl -sS 'https://cloudflare-dns.com/dns-query?name=<alias>.ip.xiannai.me&type=A' -H 'accept: application/dns-json'
netbird status --detail
netbird profile list
ping -c 3 <netbird-tunnel-ip>
tailscale status
tailscale ip -4
tailscale ping <peer-or-ip>
rg -n "DOMAIN-SUFFIX,xiannai\\.me|hk[0-9]+\\.ip\\.xiannai\\.me|RULE-SET,my_direct_rules" /home/grey/mihomo-fullstack-deploy/worker/src/inline-rules.js /home/grey/mihomo-fullstack-deploy/etc/mihomo
node --check /home/grey/mihomo-fullstack-deploy/worker/src/index.js
node --check /home/grey/mihomo-fullstack-deploy/worker/src/inline-rules.js
HOME=/etc/mihomo XDG_CONFIG_HOME=/etc/mihomo/.config /usr/local/bin/mihomo -t -f /home/grey/mihomo-fullstack-deploy/etc/mihomo/config.yaml
HOME=/etc/mihomo XDG_CONFIG_HOME=/etc/mihomo/.config /usr/local/bin/mihomo -t -f /home/grey/mihomo-fullstack-deploy/etc/mihomo/config.windows.yaml
```

For live verification, read the distribution token from 1Password and do not print it.

```bash
DOWNLOAD_TOKEN="$(op read 'op://OpenClaw/Worker Token - Distribution Access/download_token')"
curl -fsSL "https://rules.xiannai.me/rule_set/custom_ruleset/my_direct_rules.txt?token=${DOWNLOAD_TOKEN}&ts=$(date +%s)" | rg -n "xiannai\\.me"
curl -fsSL "https://rules.xiannai.me/configs/linux.yaml?token=${DOWNLOAD_TOKEN}&ts=$(date +%s)" | rg -n '"\\+\\.xiannai\\.me"|RULE-SET,my_direct_rules'
```

## Response Format

Always return:

1. normalized machine identity and service role
2. SSH connection mode, final SSH command, and verification result
3. DNS/SSH/overlay changes or confirmation
4. Mihomo route source status
5. publish and live verification status
6. remaining risk or follow-up

## Constraints

- never reveal Cloudflare, 1Password, SSH, NetBird, or distribution tokens
- do not delete unrelated SSH or Mihomo config
- do not treat old descriptive names such as `hongkong002` as source of truth
- do not use `*.svc.xiannai.me` as physical machine identity
- do not proxy SSH or machine identity Cloudflare records
- do not register a new machine identity before proving SSH reachability or receiving an explicit user-provided map
- do not run mutating remote commands when the user only asked to connect; verify with `hostname` or `exit`
- do not claim route publication from local source alone; verify the live subscription layer
