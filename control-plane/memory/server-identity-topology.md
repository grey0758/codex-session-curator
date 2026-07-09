# Server Identity Topology

Updated: 2026-06-15

Use stable `xiannai.me` identity domains before any NewAPI, CLIProxy, OpenCodex, DNS, or data migration work. Do not treat stale descriptive names such as `hongkong002` as source of truth when they conflict with this table.

## Public IP Identity

| Alias | DNS name | Public IP | Verified hostname | SSH user | Notes |
| --- | --- | --- | --- | --- | --- |
| hk002 | hk002.ip.xiannai.me | 156.225.19.45 | HK-M3PD | grey | DEPRECATED 2026-06-15. Keep identity/DNS/SSH history only; do not use for new work unless explicitly requested. |
| hk003 | hk003.ip.xiannai.me | 156.239.224.30 | C202604152364394 | grey | Existing hk003 public host. Tailscale onboarded 2026-06-11 as `hk003`, IP `100.73.138.83`, MagicDNS `hk003.tail239026.ts.net.`, DNS-only `hk003.ts.xiannai.me`. |
| hk004 | hk004.ip.xiannai.me | 156.225.19.113 | HK-KPDE | grey | DEPRECATED 2026-06-15. Former hk002 mapping; keep identity/DNS/SSH history only. |
| hk005 | hk005.ip.xiannai.me | 103.73.161.157 | HK-YBQP | grey | DEPRECATED 2026-06-15. Former CLIProxy host; legacy NetBird IP 100.88.146.19 observed. Keep history only. |
| hk006 | hk006.ip.xiannai.me | 38.76.194.249 | HK-IIUO | grey | DEPRECATED 2026-06-15. Keep identity/DNS/SSH history only; do not use for new work unless explicitly requested. |
| jd001 | jd001.ip.xiannai.me | 117.72.151.207 | jd001 | root, grey, robin | Reassigned on 2026-07-08 from historical `pub117` / old `jd001` to canonical alias `jd001`. `grey` was bootstrapped with the 1Password-backed `xiannai-server-admin-ed25519` public key and passwordless sudo. `robin` was created with password login and passwordless sudo, with no SSH public key installed. DNS-only A records `jd001.ip.xiannai.me -> 117.72.151.207` and `jd001.ts.xiannai.me -> 100.93.204.100` were verified through Cloudflare API and public DoH. Tailscale joined `grey0758.github` as `jd001`, MagicDNS `jd001.tail239026.ts.net.`, and ordinary OpenSSH over public and Tailscale paths verified as `grey`. NetBird is absent. |
| jp001 | jp001.ip.xiannai.me | 154.36.155.250 | jp001 | root, grey | Japan 001 host. `jp001` keeps the root break-glass SSH path with `~/.ssh/grey-normal` and the grey-user path with the 1Password-managed Ed25519 key. The former `jd001` compatibility alias was reassigned on 2026-07-08 to physical server `117.72.151.207`; use `jp001` for this Japan host. DNS-only A record verified on 2026-06-07. Tailscale joined on 2026-06-15 as `jp001`, IPv4 `100.64.12.127`, DNS-only `jp001.ts.xiannai.me`, and ordinary OpenSSH over Tailscale verified with `hostname` returning `jp001`. Remnawave Node deployed with Docker under `/opt/remnanode`; node `jp001-remnanode` is connected, node API listens on 2222, `rw-core` listens on 1443. Remnawave host `jp001-jp-direct` publishes direct user access to `154.36.155.250:1443` and is included in the Mihomo `日本故障转移` filter. |
| ny001 | ny001.ip.xiannai.me | 38.246.235.98 | newyork001 | grey | New York 001 host; public SSH verified from local workstation; hk003 cannot reach public 22/443/2222 as of 2026-06-02. NetBird control-plane host also resolves here. On 2026-06-15, user-provided `192.3.226.177` also reached hostname `newyork001` through SSH alias `pub192` / `old-newyork001`; this is not the canonical `ny001.ip.xiannai.me` mapping, and no DNS identity change was made. A clean copy of sgp001 CLIProxy was deployed to `192.3.226.177:8317` with management auth enabled and UFW inactive / INPUT ACCEPT. |
| sgp001 | sgp001.ip.xiannai.me | 15.235.145.62 | ns5011860 | grey | Singapore 001 host; public SSH verified; NetBird intentionally not added. `spg001` is a user-spoken alias for the same host, not a separate machine. |
| us001 | us001.ip.xiannai.me | 216.36.107.157 | us001 | grey | United States 001 host. DNS-only A record created on 2026-06-14 with TTL 120. Public SSH is on port 53111, not 22. `grey` user created with `~/.ssh/grey-normal` authorized key and passwordless sudo; SSH alias `us001` verified. Remnawave Node deployed with Docker under `/opt/remnanode`; node `us001-remnanode` is connected, node API listens on 2222, `rw-core` listens on 1443. Remnawave host `us001-us-direct` publishes direct user access to `216.36.107.157:1443` and is included in the haoyun17888 Mihomo `美国故障转移` filter with `main-reality-38`. |

Cloudflare records are DNS-only A records with TTL 120. Public DoH verification via Cloudflare returned the expected IPs for hk002-hk006 on 2026-05-19 and sgp001 on 2026-06-01. Local resolver on gpl001 required a temporary `/etc/hosts` compatibility block during propagation.

Machine status convention:

- `active`: normal target for new work and generated client SSH config.
- `deprecated`: retained for history or explicit break-glass only; generated inventory should include it with `status=deprecated`, and client generators should skip it by default unless `include_deprecated=true`.

As of 2026-06-15, among Hong Kong machines only `hk003` remains active. `hk002`, `hk004`, `hk005`, and `hk006` are deprecated.

## NetBird Preconditions

All checked hosts resolved `netbird.xiannai.me` to `38.246.235.98`, which is the required self-hosted NetBird control-plane hostname path.

Observed NetBird state:

| Alias | NetBird status |
| --- | --- |
| hk002 | netbird binary present; no tunnel IP observed in this pass |
| hk003 | NetBird binary absent, no systemd unit, no process observed on 2026-06-11; no active NetBird service to stop. Tailscale migration verified through `hk003.ts.xiannai.me`. |
| hk004 | no netbird status observed in this pass |
| hk005 | connected; tunnel IP 100.88.146.19/16; FQDN hongkong005.netbird.selfhosted |
| hk006 | no netbird status observed in this pass |
| jp001 | not checked; Remnawave public node is active, NetBird not required; Tailscale installed and joined on 2026-06-15 |
| ny001 | connected; tunnel IP 100.88.237.218/16 observed on wt0; hk003 has no active NetBird tunnel and cannot reach ny001 over public or NetBird path. |
| sgp001 | NetBird intentionally not added per request |

## SSH Config

Canonical local config file:

```text
~/.ssh/config.d/05-xiannai-server-identity.conf
```

This file should load before older host files and should define region-specific machine aliases such as `hk002` through `hk006` and `sgp001` using `<region>NNN.ip.xiannai.me` HostName plus raw IP aliases. Older config files may still contain `hongkong002` or historical aliases; prefer canonical short aliases and the `.ip.xiannai.me` identity records for new work.

`spg001` is kept as a local compatibility alias for `sgp001.ip.xiannai.me` because the user often says `spg001`. It must resolve to the same physical host as `sgp001`: `15.235.145.62`, hostname `ns5011860`.

`jd001` is no longer a compatibility alias for `jp001`. As of 2026-07-08 it is the canonical identity for physical host `117.72.151.207`, hostname `jd001`. `pub117` and the raw IP are compatibility aliases for this `jd001` host.

`cnal002` is currently reached from `gpl001` through two verified paths:

- FRP break-glass SSH alias `cnal002-frp`, endpoint `grey@frp.xiannai.me:33325`.
- Tailscale SSH alias `cnal002-ts`, endpoint `grey@100.101.174.3:22`, configured in `/home/grey/.ssh/config.d/22-cnal002-ts.conf` with `HostKeyAlias cnal002-ts`.

On 2026-06-15, `cnal002` joined the `grey0758.github` tailnet with hostname
`cnal002` and Tailscale IPv4 `100.101.174.3`. SSH over Tailscale was verified
from `gpl001` with hostname `cnal002` and user `grey`. NetBird remains parallel
and FRP remains the recovery path; do not remove either path as part of the
Tailscale pilot.

## Naming Rule

- Physical public identity: `<region>NNN.ip.xiannai.me`, for example `hk002.ip.xiannai.me` or `sgp001.ip.xiannai.me`
- Physical NetBird identity: `<region>NNN.nb.xiannai.me`
- Physical Tailscale identity: `<region>NNN.ts.xiannai.me`
- FRP break-glass identity: `<region>NNN.frp.xiannai.me` or device-specific name under `frp.xiannai.me`
- Movable service role: `<service>-primary.svc.xiannai.me`

Do not use service role domains as physical server identity.

## Service Placement Notes

| Service | Public entry | Current backend | Notes |
| --- | --- | --- | --- |
| Remnawave panel | rw.xiannai.me via hk003 Nginx | sgp001:15.235.145.62:3004 | Moved from hk003 to sgp001 on 2026-06-02. hk003 keeps TLS/public entry and proxies to sgp001; hk003 remnanode remains on hk003. |

## Mihomo Direct Routing Contract

All `xiannai.me` infrastructure identity domains are expected to route directly in Mihomo.

Canonical source:

```text
/home/grey/mihomo-fullstack-deploy/worker/src/inline-rules.js
```

Required direct rule:

```text
DOMAIN-SUFFIX,xiannai.me
```

This one suffix covers `*.ip.xiannai.me`, `*.nb.xiannai.me`, `*.ts.xiannai.me`, `*.frp.xiannai.me`, and `*.svc.xiannai.me`. When server identity DNS changes, verify this rule still exists and verify the live subscription layer after `/sync` if Mihomo artifacts were changed. On 2026-06-11, `rules.xiannai.me` live verification confirmed `my_direct_rules.txt` contains `DOMAIN-SUFFIX,xiannai.me`, and the Linux config references `RULE-SET,my_direct_rules,直连`.

## 2026-06-11 hk003 Tailscale Migration

`hk003` was onboarded to the official Tailscale tailnet `grey0758.github` using a 1Password-stored auth key. Tailscale was installed from the official apt repository on Ubuntu noble and joined with hostname `hk003`.

Verified state:

- Tailscale IPv4: `100.73.138.83`
- Tailscale IPv6: `fd7a:115c:a1e0::c538:8a54`
- MagicDNS: `hk003.tail239026.ts.net.`
- xiannai identity: DNS-only A `hk003.ts.xiannai.me -> 100.73.138.83`, TTL 120
- ordinary OpenSSH over Tailscale works with `grey` and `~/.ssh/grey-normal`
- public SSH through `hk003.ip.xiannai.me` remains the non-overlay recovery path
- Tailscale SSH, exit node, subnet routes, app connector, and Tailscale DNS acceptance are disabled
- `tailscale ping hk003` reached the peer through DERP Hong Kong during verification; direct P2P was not established in that snapshot
- NetBird was not active on this machine: no binary, no systemd unit, no process

## 2026-06-15 cnal002 Tailscale Curator Tunnel

`cnal002` was onboarded to the official Tailscale tailnet `grey0758.github`
through interactive GitHub login. Tailscale was installed from the official apt
repository on Ubuntu noble and joined with hostname `cnal002`.

Verified state:

- Tailscale IPv4: `100.101.174.3`
- `gpl001` Tailscale IPv4: `100.74.114.30`
- SSH alias from `gpl001`: `cnal002-ts`
- ordinary OpenSSH over Tailscale works with `grey` and `~/.ssh/grey-normal`
- `tailscale ping cnal002` from `gpl001` and `tailscale ping gpl001` from `cnal002` worked through DERP during verification
- FRP alias `cnal002-frp` remains the non-Tailscale recovery path
- NetBird remains present as a parallel overlay; this was a Tailscale pilot, not a NetBird removal

## 2026-06-15 jp001 Tailscale Enrollment

`jp001` was onboarded to the official Tailscale tailnet `grey0758.github`
through the 1Password-stored server onboarding auth key. Public/root
break-glass SSH over `jp001.ip.xiannai.me` was verified before changing overlay
state. Tailscale was installed from the official apt repository on Ubuntu
noble and joined with hostname `jp001`.

Verified state:

- Tailscale IPv4: `100.64.12.127`
- hostname in tailnet: `jp001`
- xiannai identity: DNS-only A `jp001.ts.xiannai.me -> 100.64.12.127`, TTL 120
- `tailscale ping jp001` from `gpl001` returned through public endpoint `154.36.155.250:41641`
- ordinary OpenSSH over Tailscale works with `root` and `~/.ssh/grey-normal`;
  verification returned hostname `jp001`
- public SSH through `jp001.ip.xiannai.me` remains the non-overlay recovery path
- Tailscale SSH, exit node, subnet routes, app connector, and Tailscale DNS
  acceptance were not enabled by the onboarding command
- `jd001` remains a local grey-user compatibility alias for the same physical
  host; fix local SSH identity handling before treating `ssh jd001` as the
  primary Tailscale verification path

Curator aggregation:

```text
gpl001:127.0.0.1:54179 -> cnal002:127.0.0.1:54177
```

The tunnel is managed on `gpl001` by user service
`cnal002-curator-ssh-tunnel.service`:

```text
/usr/bin/ssh -NT -L 127.0.0.1:54179:127.0.0.1:54177 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 cnal002-ts
```

`cnal002` Curator is intentionally hardened to listen on localhost only through
`~/.config/systemd/user/codex-session-curator.service.d/localhost-only.conf`.
`gpl001` aggregates it through `CURATOR_REMOTE_AGENTS` as
`cnal002=http://127.0.0.1:54179`. Direct access to
`http://100.101.174.3:54177/` should fail; `http://127.0.0.1:54179/` from
`gpl001` should return HTTP 200.


## 2026-06-04 gpl001 Mihomo Raw IP Route Fix

Local gpl001 SSH to raw `15.235.145.62` was observed going through the Mihomo TUN route (`Meta` / `198.18.0.0/16`) and landing on the wrong SSH host-key path. The fix is to keep `15.235.145.62/32` in Mihomo `tun.route-exclude-address` and direct rules. After adding it, `ip route get 15.235.145.62` returned the LAN gateway path and both `ssh spg001` and `ssh sgp001` reached hostname `ns5011860`.

## 2026-06-06 sgp001 Local Mihomo Proxy

sgp001 does not run the standard `mihomo.service` compatibility install. Its active local proxy is `mihomo-windows-proxy.service`, running `/usr/local/bin/mihomo -d /etc/mihomo-windows-proxy -f /etc/mihomo-windows-proxy/config.yaml` and listening on `172.18.0.1:7890` for Docker/Windows-side clients. On 2026-06-06 the upstream was changed from the old authenticated SOCKS5 proxy to the whitelisted HTTP proxy `178.92.33.5:47418`, with node name `upstream-http-178`. Verification through `http://172.18.0.1:7890` returned external IP `178.92.33.5`.

## 2026-06-08 OpenCodex VIP NewAPI 3003 Domains

`vip.opencodex.uk` is DNS-only A `156.239.224.30` and terminates TLS on hk003 Nginx with `/etc/nginx/sites-available/vip.opencodex.uk`, then proxies to local HAProxy frontend `127.0.0.1:18083`; hk003 HAProxy backend `sgp001_hk006_newapi_3003` forwards to `15.235.145.62:3003`.

`vipsgp.opencodex.uk` is DNS-only A `15.235.145.62` and terminates TLS directly on sgp001 Nginx with `/etc/nginx/sites-available/vipsgp.opencodex.uk`, then proxies to `http://15.235.145.62:3003`.

Both certificates were issued by Certbot on 2026-06-08 and expire on 2026-09-06. Verification with Cloudflare/Google DoH and HTTPS returned NewAPI HTTP 200 for both names. Local `dig @isabel.ns.cloudflare.com` and `dig @yevgen.ns.cloudflare.com` from gpl001 may route through Mihomo TUN (`198.18.0.0/16`) and can disagree with DoH during validation; prefer DoH plus HTTPS checks for these public OpenCodex records.
