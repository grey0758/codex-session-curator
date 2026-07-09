# sgp001 Migration Prep

Updated: 2026-06-01

## OpenNana Gallery Placement: 2026-06-08

`opennana-gallery.opencodex.uk` has been migrated from hk002 to sgp001 while
keeping the public ingress on hk003.

Current chain:

```text
opennana-gallery.opencodex.uk
  -> DNS A 156.239.224.30
  -> hk003 Nginx TLS vhost
  -> hk003 HAProxy local frontend 127.0.0.1:18443
  -> sgp001 HTTPS vhost 15.235.145.62:443
  -> sgp001 Nginx
  -> sgp001 user systemd opennana-gallery.service
  -> 127.0.0.1:18080
```

Source/runtime paths:

- local source repo: `/home/grey/work/opennana-awesome-prompt-gallery-replica`
- sgp001 runtime app: `/home/grey/apps/opennana-gallery`
- sgp001 service: `/home/grey/.config/systemd/user/opennana-gallery.service`
- sgp001 static root: `/var/www/opennana-gallery`

Generation routing:

- OpenNana uses NewAPI 3006 for both image and video generation.
- sgp001 app env uses `NEWAPI_BASE=http://15.235.145.62:3006`,
  `OPENAI_BASE_URL=http://15.235.145.62:3006/v1`, and
  `PUBLIC_BASE_URL=https://video.opencodex.uk/v1`.
- default image model: `gpt-image-2`
- default video model: `sora-2-8s`
- generation endpoints require a logged-in NewAPI user session and use that
  user's token; there is no global server API key fallback.

Verification on 2026-06-08:

- `ssh sgp001 hostname` returned `ns5011860`.
- `systemctl --user status opennana-gallery.service` was active.
- service logs showed `/api/generate-image`, `/api/edit-image`,
  `/api/generate-video`, `/api/videos/:id`, and `/api/videos/:id/content`
  registered.
- `https://opennana-gallery.opencodex.uk/healthz` returned `{"ok":true}`.
- `https://opennana-gallery.opencodex.uk/ai-image-generator` returned HTTP 200.
- unauthenticated local POSTs to generation endpoints returned HTTP 401,
  confirming login/session gating rather than a missing route.
- `https://video.opencodex.uk/api/status` returned `New API Video 3006` with
  drawing and task features enabled.

Rollback note: hk002 source service was intentionally left running after the
2026-06-07 migration unless explicitly retired.

Target machine:

| Alias | DNS name | Public IP | Hostname | SSH user |
| --- | --- | --- | --- | --- |
| sgp001 | sgp001.ip.xiannai.me | 15.235.145.62 | ns5011860 | grey |

Prepared artifact root on sgp001:

```text
/home/grey/migration-prep/20260601-newapi-to-sgp001
```

Prepared services:

| Source | Service | Artifact directory | Status |
| --- | --- | --- | --- |
| hk002 | NewAPI primary | hk002-newapi | files, online SQL dump, Docker images, inventory copied |
| hk002 | OpenCodex NewAPI 3001 stack | hk002-newapi-3001 | files, online SQL dump, Docker images, inventory copied |
| hk006 | NewAPI | hk006-newapi | files, online SQL dump, Docker images, inventory copied |
| hk005 | CLIProxy | hk005-cliproxy | files, Docker image, inventory copied |

No source services were stopped or restarted during this prep pass. No NewAPI or CLIProxy containers were started on sgp001.

sgp001 runtime state after prep:

- Docker installed.
- Docker Compose v2 installed.
- Images loaded: `newapi-local:channel-cycle-failover-20260530032621`, `mysql:8.0`, `cliproxy-local:access-token-only-auth-20260529111911`.
- Target containers running: none.

sgp001 test port draft:

| Service | Loopback test port |
| --- | --- |
| hk002-newapi | 127.0.0.1:3001 |
| hk002-newapi-3001 | 127.0.0.1:3002 |
| hk006-newapi | 127.0.0.1:3003 |
| hk005-cliproxy | 127.0.0.1:8317 |

Next steps before any cutover:

1. Import the prepared SQL dumps into sgp001 MySQL containers.
2. Start the stacks on loopback-only test ports.
3. Run local smoke tests on sgp001.
4. Only after verification, plan DNS/upstream/router changes separately.

## Refresh: 2026-06-01

- NewAPI SQL dumps were refreshed from live hk002/hk006 without stopping source containers.
- hk005 CLIProxy files were refreshed from live hk005 without stopping its source container.
- sgp001 NewAPI loopback test ports were changed to `3001`, `3002`, and `3003`.
- Current hk machines must not be stopped or restarted during prep work.

## CLIProxy Port Finding: 2026-06-01

hk005 `docker-compose.yml` publishes six ports, but the running container only listens internally on `8317`. Local curl checks returned HTTP 200 on `8317`; the other published ports reset connections because no application listener is present inside the container. The sgp001 CLIProxy test override was therefore narrowed to only `127.0.0.1:8317:8317`.

## OVH Edge Firewall: 2026-06-02

OVHcloud API credential item:

```text
OpenClaw / OVHcloud API - openclaw
```

The validated endpoint is `ovh-ca` / `https://ca.api.ovh.com/1.0`.

Created and enabled OVH Network Firewall for:

```text
serviceName: 15.235.145.62/32
ipOnFirewall: 15.235.145.62
```

Rules:

| Sequence | Action | Source | Destination port |
| --- | --- | --- | --- |
| 0 | permit | 156.239.224.30/32 | 3001 |
| 1 | permit | 156.239.224.30/32 | 3002 |
| 2 | permit | 156.239.224.30/32 | 3003 |
| 3 | deny | any | 3001 |
| 4 | deny | any | 3002 |
| 5 | deny | any | 3003 |

Verification:

- hk003 to sgp001 `3001`, `3002`, `3003`: HTTP 200.
- non-hk003 source to sgp001 `3001`, `3002`, `3003`: timed out.
- sgp001 NewAPI containers remain running on `15.235.145.62:3001-3003`.
- hk002, hk005, and hk006 source containers were not stopped or restarted.

## NewAPI IP Smoke Test: 2026-06-02

Ran OpenAI-compatible API smoke tests against the three sgp001 NewAPI instances using the planned direct IP ports from hk003. No hk source services were stopped or restarted.

| Instance | URL | Result |
| --- | --- | --- |
| hk002-newapi | `http://15.235.145.62:3001/v1/chat/completions` | HTTP 200, `gpt-5.5` returned `ok` |
| hk002-newapi-3001 | `http://15.235.145.62:3002/v1/chat/completions` | HTTP 200, `gpt-5.5` returned `ok` |
| hk006-newapi | `http://15.235.145.62:3003/v1/chat/completions` | HTTP 200, `gpt-5.5` returned `ok` |

`/v1/models` also returned HTTP 200 on all three instances. Model counts observed:

- `hk002-newapi`: 28 models, includes `gpt-5.5`.
- `hk002-newapi-3001`: 28 models, includes `gpt-5.5`.
- `hk006-newapi`: 7 models, includes `gpt-5.5`.

Container logs show the successful API requests entered sgp001 from hk003 egress IP `156.239.224.30`. A direct request from the current control host egress IP `38.246.235.98` did not reach NewAPI application logs, which is consistent with keeping sgp001's public NewAPI ports usable through the hk003 ingress path rather than broadly exposed.

## hk003 to sgp001 Routing Check: 2026-06-02

Checked the planned backend leg for `hk003 -> sgp001`.

- `hk003 -> sgp001` ping: about 36 ms, 0% packet loss.
- `sgp001 -> hk003` ping: about 36 ms, 0% packet loss.
- MTR/traceroute showed the backend leg going through NTT/AS2914 from Hong Kong to Singapore, then OVH/AS16276 in Singapore.
- No CN2/AS4809 or `59.43.x.x` hops were observed on the `hk003 -> sgp001` backend leg.

Interpretation: CN2, if used, is expected on the client/domestic-probe to hk003 ingress leg. The hk003-to-sgp001 backend leg is NTT to OVH, which is currently stable and low-latency for the reverse-proxy plan.

## hk005 Cloudflare Tunnel Test Ingress: 2026-06-02

Created a test public hostname without touching hk003:

```text
vip.opencodex.uk
```

Current chain:

```text
vip.opencodex.uk
  -> Cloudflare Tunnel 20c92b6c-77eb-44c2-acd9-2f661c4f59d2
  -> hk005 cloudflared systemd service
  -> hk005 HAProxy local origin 127.0.0.1:18080
  -> sgp001 NewAPI 15.235.145.62:3003
```

hk005 details:

- Hostname: `HK-YBQP`.
- Public egress IP: `178.92.33.5`.
- HAProxy installed and configured at `/etc/haproxy/haproxy.cfg`.
- HAProxy only listens on `127.0.0.1:18080`; it does not occupy hk005 `80` or `443`.
- systemd service: `cloudflared-vip-opencodex.service`.
- cloudflared runs with `--protocol http2`; QUIC timed out from hk005.
- Tunnel token is stored on hk005 at `/etc/cloudflared/vip-opencodex.tunnel-token` with root-only permissions.

OVH firewall was updated so sgp001 permits both hk003 and hk005 to reach NewAPI ports:

| Sequence | Action | Source | Destination port |
| --- | --- | --- | --- |
| 0 | permit | 156.239.224.30/32 | 3001 |
| 1 | permit | 156.239.224.30/32 | 3002 |
| 2 | permit | 156.239.224.30/32 | 3003 |
| 3 | permit | 178.92.33.5/32 | 3001 |
| 4 | permit | 178.92.33.5/32 | 3002 |
| 5 | permit | 178.92.33.5/32 | 3003 |
| 6 | deny | any | 3001 |
| 7 | deny | any | 3002 |
| 8 | deny | any | 3003 |

Verification:

- hk005 -> sgp001 `3001/3002/3003`: HTTP 200 on `/`.
- hk005 local HAProxy origin `http://127.0.0.1:18080/`: HTTP 200.
- Cloudflare API and hk005 DNS resolve `vip.opencodex.uk` to Cloudflare proxy IPs.
- Public `GET https://vip.opencodex.uk/`: HTTP 200.
- Public OpenAI-compatible call to `https://vip.opencodex.uk/v1/chat/completions` with model `gpt-5.5`: HTTP 200, returned `ok`.

Note: the control host local resolver did not resolve `vip.opencodex.uk` because its DNS path uses `198.18.x.x` fake DNS behavior. Cloudflare DoH, hk005, and forced Cloudflare IP resolution all verified the hostname. Python's default `urllib` user agent hit Cloudflare `1010`; using normal API client user agents such as `OpenAI/Python` or `curl` succeeded.

Update: `vip.opencodex.uk` was switched from sgp001 `3001` to sgp001 `3003` on 2026-06-02 by updating hk005 HAProxy only. Cloudflare Tunnel and DNS were unchanged. Verification after the switch: public `gpt-5.5` chat completion returned HTTP 200 and `ok`, and `sgp001-hk006-newapi` logged the request.

## Live Data Refresh: 2026-06-02

Refreshed live NewAPI SQL data from hk002/hk006 to sgp001 without stopping or restarting source hk services.

Source hot dumps:

- `hk002:newapi-mysql` -> `hk002-newapi.sql.gz`
- `hk002:open-codex-newapi-3001-mysql` -> `hk002-newapi-3001.sql.gz`
- `hk006:newapi-mysql` -> `hk006-newapi.sql.gz`

sgp001 refresh directory:

```text
/home/grey/migration-prep/20260601-newapi-to-sgp001/sql-refresh/20260602-refresh-110535
```

Import mapping:

| Source dump | Target container |
| --- | --- |
| `hk002-newapi.sql.gz` | `sgp001-hk002-newapi-mysql` |
| `hk002-newapi-3001.sql.gz` | `sgp001-hk002-newapi-3001-mysql` |
| `hk006-newapi.sql.gz` | `sgp001-hk006-newapi-mysql` |

Post-import verification:

- sgp001 target table counts: `37`, `29`, `26`.
- sgp001 target MySQL containers: healthy.
- hk002 and hk006 source NewAPI/MySQL containers remained running.
- `vip.opencodex.uk` to sgp001 `3003` model smoke test: HTTP 200, `gpt-5.5` returned `ok`, observed latency about `2.9s`.

## hk002 Selected Frontend Prep: 2026-06-02

Prepared the selected hk002 services without stopping or restarting hk002 services:

- `gpt-image-playground`
- `opencodex.service` frontend from `/home/grey/opencodex`
- `opencodex-uk-web.service` frontend from `/home/grey/opencodex-uk`
- related `vip1-opencodex-router.service` unit for route context
- hk002 nginx configuration
- hk002 Let's Encrypt certificates and renewal metadata
- relevant `/etc/default/opencodex*` environment files

sgp001 artifact root:

```text
/home/grey/migration-prep/20260602-full-prep-hk002-hk006/hk002-selected
```

Artifacts:

- Files: `hk002-selected/files/`
- Image archive: `hk002-selected/images/gpt-image-playground_20260520.tar.gz`
- Loaded image on sgp001: `gpt-image-playground:20260520`

hk002 source service verification after prep:

- `gpt-image-playground`: still running, up 12 days.
- `opencodex.service`: active.
- `opencodex-uk-web.service`: active.
- `vip1-opencodex-router.service`: active.
- `nginx`: active.

`streamfix-proxy` finding: `/home/grey/streamfix-proxy/streamfix_proxy.py` is a small Python HTTP proxy listening on `PORT=39134`. It proxies to `https://cc.585dg.com/codex` by default and normalizes OpenAI/Responses API SSE/JSON payloads, especially `created_at` values and a generic upstream pool-exhausted error. It was not migrated in this selected prep pass.

## NewAPI gpt-5.5 xhigh Price Sync: 2026-06-02

Target model pricing requested:

- `gpt-5.5 xhigh`
- Input: `$75.0000 / 1M tokens`
- Completion: `$450.0000 / 1M tokens`

Observed NewAPI billing representation:

- `model_ratio=2.5`
- `completion_ratio=6`
- `model_price=-1`

This is the same ratio already used by `gpt-5.5` and maps to the requested 6x completion pricing.

Changes:

- hk002 `newapi`: already had `gpt-5.5 xhigh` on channels `25,32,33,34`; no write needed.
- hk002 `newapi-3001`: already had `gpt-5.5 xhigh` on channels `25,32,33,34`; no write needed.
- hk006 `newapi`: added `gpt-5.5 xhigh` abilities by copying `gpt-5.5` ability rows and added channel `model_mapping` to upstream `gpt-5.5`.
- sgp001 hk006 copy: applied the same update.

Backups created before hk006/sgp-hk006 writes:

- `abilities_backup_gpt55_xhigh_20260602`
- `channels_backup_gpt55_xhigh_20260602`

Post-sync verification:

- hk002 `newapi`: `gpt-5.5 xhigh` has 8 ability rows, all enabled.
- hk002 `newapi-3001`: `gpt-5.5 xhigh` has 8 ability rows, all enabled.
- hk006 `newapi`: `gpt-5.5 xhigh` has 28 ability rows, 16 enabled, matching `gpt-5.5`.
- sgp001 hk006 copy: `gpt-5.5 xhigh` has 28 ability rows, 16 enabled, matching `gpt-5.5`.
- hk006 direct local smoke test for `gpt-5.5 xhigh`: HTTP 200, returned `ok`, ratio logged as `2.5/6`.
- `vip.opencodex.uk` through sgp001 `3003` smoke test for `gpt-5.5 xhigh`: HTTP 200, returned `ok`, ratio logged as `2.5/6`.

### 2026-06-08 follow-up

The three sgp001 NewAPI instances were checked after a report that `gpt-5.5 xhigh` kept showing `$75 / 1M` input and `$450 / 1M` completion:

- `3001` / `sgp001-hk002-newapi-mysql`
- `3002` / `sgp001-hk002-newapi-3001-mysql`
- `3003` / `sgp001-hk006-newapi-mysql`

All three instances have channel `model_mapping` entries mapping `gpt-5.5 xhigh` to upstream `gpt-5.5`. To avoid relying on alias/default ratio matching, `options` was updated in all three databases so `gpt-5.5 xhigh` explicitly mirrors `gpt-5.5`:

- `ModelRatio`: `2.5`
- `CompletionRatio`: `6`
- `CacheRatio`: `0.1`
- `ModelPrice`: unset/null for both models

The three NewAPI app containers were restarted to reload option caches. `/api/pricing` on ports `3001` and `3002` returned identical pricing objects for `gpt-5.5` and `gpt-5.5 xhigh`; port `3003` public pricing returned no rows because `UserUsableGroups={}`, but its database values and abilities matched. Health checks returned HTTP 200 on all three ports.

## Live Data Refresh: 2026-06-03

Refreshed live NewAPI SQL data again from hk002/hk006 to sgp001 without stopping or restarting source hk services.

Source hot dumps:

- `hk002:newapi-mysql` -> `hk002-newapi.sql.gz`
- `hk002:open-codex-newapi-3001-mysql` -> `hk002-newapi-3001.sql.gz`
- `hk006:newapi-mysql` -> `hk006-newapi.sql.gz`

sgp001 refresh directory:

```text
/home/grey/migration-prep/20260601-newapi-to-sgp001/sql-refresh/20260603-refresh-002426
```

Post-import verification:

- sgp001 target table counts: `37`, `29`, `28`.
- hk006 table count is now `28` because the `gpt-5.5 xhigh` sync created two backup tables that are present in the source and were synced.
- sgp001 target MySQL containers: healthy.
- hk002 and hk006 source NewAPI/MySQL containers remained running.
- `vip.opencodex.uk` to sgp001 `3003` smoke tests:
  - `gpt-5.5`: HTTP 200, returned `ok`, about `2.6s`.
  - `gpt-5.5 xhigh`: HTTP 200, returned `ok`, about `11.2s`.

Domain service readiness check on 2026-06-03:

- sgp001 currently listens only on NewAPI ports `3001`, `3002`, and `3003` for this migration.
- `gpt-image-playground:20260520` image is loaded on sgp001, but no container is started.
- OpenCodex frontend files, nginx configs, and Let's Encrypt certs are copied to artifacts, but nginx/OpenCodex services are not installed or running on sgp001.
- Therefore NewAPI is close to cutover-ready, but the broader domain services are not yet "DNS-only" ready.

## Selected Frontend Enablement on sgp001: 2026-06-03

Enabled the selected hk002 frontend/domain services on sgp001 without stopping or restarting hk002, hk005, or hk006 source services.

Changes on sgp001:

- Installed and enabled `nginx`.
- Restored copied Let's Encrypt certificate material from the migration artifact into `/etc/letsencrypt`.
- Enabled nginx sites:
  - `open-codex.com`
  - `api.open-codex.com`
  - `opencodex.uk`
  - `00-migrated-domain-aliases.conf`
- Did not enable standalone `cliproxy.opencodex.uk` or `cliproxy1.opencodex.uk` sites, because CLIProxy migration was explicitly excluded.
- `opencodex.service` is active on `0.0.0.0:28080`.
- `opencodex-uk-web.service` is active on `127.0.0.1:38018`.
- `vip1-opencodex-router.service` is active on `127.0.0.1:3000`.
- Added sgp001-specific systemd drop-in `/etc/systemd/system/vip1-opencodex-router.service.d/sgp001-newapi.conf`, setting `NEWAPI_HOST=15.235.145.62` and `NEWAPI_PORT=3001`, because sgp001 NewAPI containers publish on the server public IP rather than loopback.
- Started `gpt-image-playground` container from `gpt-image-playground:20260520`, attached to `sgp_hk002_newapi_default`, with `127.0.0.1:38080->80` and restart policy `unless-stopped`.
- `gpt-image-playground` proxy target is `http://sgp001-hk002-newapi:3000/v1` through the Docker network.

Verification:

- `nginx -t`: passed.
- sgp001 local checks:
  - `http://127.0.0.1:28080/`: HTTP 200.
  - `http://127.0.0.1:38018/`: HTTP 307.
  - `http://127.0.0.1:3000/`: HTTP 200.
  - `http://127.0.0.1:3000/v1/models`: HTTP 401, expected without API key.
  - `http://127.0.0.1:38080/`: HTTP 200.
- sgp001 TLS/SNI checks with `--resolve <domain>:443:127.0.0.1`:
  - `open-codex.com`: HTTP 200.
  - `www.open-codex.com`: HTTP 200.
  - `api.open-codex.com`: HTTP 200.
  - `opencodex.uk`: HTTP 200.
  - `api.opencodex.uk`: HTTP 200.
  - `ops.opencodex.uk`: HTTP 307.
  - `install.open-codex.com`, `newapict.open-codex.com`, `openapi.open-codex.com`, `proxydemo.open-codex.com`, `openwebui.opencodex.uk`: reachable through enabled alias config.
- External forced-resolution checks to `15.235.145.62:443` from the control host, hk003, and hk005 returned HTTP 200/307 for the selected domains.
- OpenAI-compatible smoke tests through sgp001 nginx:
  - `https://api.open-codex.com/v1/chat/completions`, model `gpt-5.5`: HTTP 200, returned `ok`, about `2.4s`.
  - `https://api.opencodex.uk/v1/chat/completions`, model `gpt-5.5`: HTTP 200, returned `ok`, about `3.1s`.
- `gpt-image-playground` same-origin proxy smoke test:
  - `POST http://127.0.0.1:38080/api-proxy/responses`, model `gpt-5.5`: HTTP 200, returned `ok`, about `4.1s`.

DNS state:

- No DNS was modified.
- Public A records still resolve to hk002 `156.225.19.45` for `open-codex.com`, `api.open-codex.com`, `opencodex.uk`, `api.opencodex.uk`, and `ops.opencodex.uk`.
- The selected OpenCodex/nginx domain services are now ready for DNS cutover to sgp001 `15.235.145.62`.
- `gpt-image-playground` is enabled and verified locally on sgp001, but no dedicated HTTPS domain is currently assigned to it. Existing copied certificates do not cover a new `gpt-image.*` hostname; assigning a dedicated domain still requires DNS plus certificate issuance or choosing an already covered hostname.

## api.open-codex.com Cutover to sgp001: 2026-06-03

Refreshed live NewAPI SQL data one more time from hk002/hk006 to sgp001 without stopping or restarting source hk services, then cut only `api.open-codex.com` DNS to sgp001.

Source hot dumps:

- `hk002:newapi-mysql` -> `hk002-newapi.sql.gz`
- `hk002:open-codex-newapi-3001-mysql` -> `hk002-newapi-3001.sql.gz`
- `hk006:newapi-mysql` -> `hk006-newapi.sql.gz`

sgp001 refresh directory:

```text
/home/grey/migration-prep/20260601-newapi-to-sgp001/sql-refresh/20260602-refresh-171925
```

Dump sizes:

- `hk002-newapi.sql.gz`: about `96M`.
- `hk002-newapi-3001.sql.gz`: about `13M`.
- `hk006-newapi.sql.gz`: about `35M`.

Post-import verification before DNS cut:

- sgp001 target table counts: `37`, `29`, `28`.
- sgp001 target MySQL containers: healthy.
- sgp001 NewAPI containers remained running.
- hk002 and hk006 source NewAPI/MySQL containers remained running.
- Forced sgp001 `api.open-codex.com` origin smoke test for `gpt-5.5`: HTTP 200, returned `ok`, about `2.6s`.

DNS change:

- Cloudflare zone: `open-codex.com`.
- Record changed: `api.open-codex.com`.
- Previous A record: `156.225.19.45`.
- New A record: `15.235.145.62`.
- Record type stayed `A`.
- Proxy mode stayed `false` / DNS-only.
- TTL stayed automatic (`1` in Cloudflare API).
- No other DNS records were changed.

Post-cut verification:

- Cloudflare API readback: `api.open-codex.com A 15.235.145.62`.
- Cloudflare DoH returned `15.235.145.62`.
- hk003 resolver returned `15.235.145.62`; `https://api.open-codex.com/` from hk003 reached `15.235.145.62` with HTTP 200.
- hk005 resolver returned `15.235.145.62`; `https://api.open-codex.com/` from hk005 reached `15.235.145.62` with HTTP 200.
- Local resolver, Google DNS, and Cloudflare DNS all returned `15.235.145.62` after propagation.
- Live public model call to `https://api.open-codex.com/v1/chat/completions`, model `gpt-5.5`: HTTP 200, returned `ok`, about `3.2s`, remote IP `15.235.145.62`.

Notes:

- A transient earlier dump attempt produced empty gz files because `$MYSQL_ROOT_PASSWORD` was expanded by the wrong shell. DNS had not been cut at that point. The sgp001 target databases were then overwritten with valid fresh dumps before cutover.
- A later table-count check failed due to SQL string escaping, not data import failure; corrected verification showed the expected table counts.

## api.open-codex.com hk003 HAProxy Ingress: 2026-06-03

Changed the `api.open-codex.com` production path from direct sgp001 DNS to the requested small-node L7 reverse-proxy pattern.

New chain:

```text
api.open-codex.com
  -> DNS A 156.239.224.30
  -> hk003 nginx TLS vhost :443
  -> hk003 HAProxy local frontend 127.0.0.1:18081
  -> sgp001 NewAPI 15.235.145.62:3001
```

hk003 setup:

- Machine identity: `hk003.ip.xiannai.me`, public IP `156.239.224.30`, hostname `C202604152364394`.
- Existing `nginx` on hk003 remained the public `80/443` listener.
- Installed and enabled `haproxy`.
- HAProxy listens only on `127.0.0.1:18081`, so it does not occupy public `80/443`.
- HAProxy backend `sgp001_3001` points to `15.235.145.62:3001` and health-checks `GET /`.
- Restored the existing `open-codex.com` certificate material on hk003 from the sgp001 migration artifact so hk003 can terminate TLS for `api.open-codex.com`.
- Added nginx site `/etc/nginx/sites-available/api.open-codex.com` and enabled it.

Verification before DNS update:

- hk003 -> sgp001 `3001/3002/3003`: HTTP 200.
- hk003 nginx local forced SNI for `api.open-codex.com`: HTTP 200.
- hk003 HAProxy local origin `http://127.0.0.1:18081/`: HTTP 200.
- HAProxy backend status: `UP`, L7 check passed with HTTP 200.
- Forced public request to hk003 with `--resolve api.open-codex.com:443:156.239.224.30`: `gpt-5.5` chat completion returned HTTP 200 and `ok`, about `1.7s`; repeated forced test returned HTTP 200 and `ok`, about `6.1s`.

DNS change:

- Cloudflare zone: `open-codex.com`.
- Record changed: `api.open-codex.com`.
- Previous A record: `15.235.145.62`.
- New A record: `156.239.224.30`.
- Record type stayed `A`.
- Proxy mode stayed `false` / DNS-only.
- TTL stayed automatic (`1` in Cloudflare API).
- No other DNS records were changed.

Post-change DNS state:

- Cloudflare API readback: `api.open-codex.com A 156.239.224.30`.
- Cloudflare DoH and Google DNS returned `156.239.224.30`.
- Local resolver on the control host still temporarily returned cached `15.235.145.62` during the verification window, so an unforced local live request still reached sgp001 directly and returned HTTP 200/`ok`.
- The intended hk003 ingress path itself was verified by forced-resolution calls and HAProxy logs.

## Broad hk003 HAProxy Ingress Cutover: 2026-06-03

Expanded hk003 from a single-domain `api.open-codex.com` ingress to the broader small-node HAProxy ingress for the migrated hk002/hk006 domain services that are already prepared on sgp001.

Target chain:

```text
client
  -> DNS A 156.239.224.30
  -> hk003 nginx TLS vhost :443
  -> hk003 HAProxy local frontend
  -> sgp001 backend
```

hk003 HAProxy frontends/backends:

- `127.0.0.1:18081` -> `15.235.145.62:3001` for `api.open-codex.com`.
- `127.0.0.1:18082` -> `15.235.145.62:3001` for `api.opencodex.uk`.
- `127.0.0.1:18083` -> `15.235.145.62:3003` for `vip1.opencodex.uk`.
- `127.0.0.1:18443` -> `15.235.145.62:443` with SNI/Host preserved for the sgp001 nginx-hosted frontend/alias domains.

hk003 certificate material restored:

- `open-codex.com` cert from the sgp001 migration artifact for `open-codex.com`, `www.open-codex.com`, `api.open-codex.com`, `install.open-codex.com`, `newapict.open-codex.com`, `openapi.open-codex.com`, and `proxydemo.open-codex.com`.
- `opencodex.uk` cert from hk002 for `api.opencodex.uk`, `opencodex.uk`, `ops.opencodex.uk`, `openwebui.opencodex.uk`, and `opennana-gallery.opencodex.uk`.
- `vip1.opencodex.uk` cert from hk006 for `vip1.opencodex.uk`.

Nginx/HAProxy validation:

- `haproxy -c`: passed.
- `nginx -t`: passed.
- `haproxy` and `nginx`: active.
- HAProxy backends `sgp001_hk002_newapi_3001`, `sgp001_hk006_newapi_3003`, and `sgp001_https_vhosts`: `UP`.

Forced-resolution verification to hk003 before DNS cut:

- `open-codex.com`, `www.open-codex.com`, `install.open-codex.com`, `newapict.open-codex.com`, `openapi.open-codex.com`, `proxydemo.open-codex.com`: HTTP 200.
- `opencodex.uk`: HTTP 200.
- `ops.opencodex.uk`: HTTP 307.
- `openwebui.opencodex.uk`: HTTP 200.
- `opennana-gallery.opencodex.uk`: HTTP 200.
- `api.open-codex.com` model smoke test: HTTP 200, returned `ok`, about `2.0s`.
- `api.opencodex.uk` model smoke test: HTTP 200, returned `ok`, about `2.3s`.
- `vip1.opencodex.uk` model smoke test: HTTP 200, returned `ok`, about `1.9s`.
- HAProxy logs confirmed `api.opencodex.uk` hit the `3001` backend and `vip1.opencodex.uk` hit the `3003` backend.

Cloudflare DNS records changed to hk003 `156.239.224.30`:

`open-codex.com` zone:

- `api.open-codex.com` was already on hk003.
- `open-codex.com`
- `www.open-codex.com`
- `install.open-codex.com`
- `newapict.open-codex.com`
- `openapi.open-codex.com`
- `proxydemo.open-codex.com`

`opencodex.uk` zone:

- `api.opencodex.uk`
- `opencodex.uk`
- `ops.opencodex.uk`
- `openwebui.opencodex.uk`
- `opennana-gallery.opencodex.uk`
- `vip1.opencodex.uk`

Records intentionally not changed:

- `cliproxy.opencodex.uk` and `cliproxy1.opencodex.uk`: CLIProxy was explicitly excluded from this migration.
- `gzh.opencodex.uk`: hosted on hk006, Cloudflare proxied, and not part of the prepared sgp001 NewAPI/OpenCodex migration.
- `cursorapi.open-codex.com`, `newapi-origin.open-codex.com`, `newapicr.open-codex.com`: point to third-party/origin IP `117.72.151.207`, not hk002/hk006.
- `vip.opencodex.uk`: Cloudflare Tunnel through hk005 to sgp001 `3003`; unchanged.

Post-cut verification:

- Cloudflare API readback showed all changed A records on `156.239.224.30`.
- Cloudflare DoH returned `156.239.224.30` for all changed records.
- Google DNS and the control host local resolver had propagated for most records during the verification window.
- `api.opencodex.uk` still returned cached `156.225.19.45` from Google/local resolvers during the final check, but Cloudflare DoH and Cloudflare API had already switched it to hk003, and forced hk003 model calls returned HTTP 200/`ok`.
- Live non-forced checks reached hk003 for `open-codex.com`, `opencodex.uk`, `ops.opencodex.uk`, `openwebui.opencodex.uk`, `opennana-gallery.opencodex.uk`, `vip1.opencodex.uk`, and the open-codex.com aliases where local recursion had refreshed.

## hk005 CLIProxy Cutover Through hk003: 2026-06-03

Migrated hk005 CLIProxy to sgp001 and cut `cliproxy.opencodex.uk` to the same small-node ingress pattern. The hk005 source container was not stopped or restarted.

Target chain:

```text
client
  -> cliproxy.opencodex.uk A 156.239.224.30
  -> hk003 nginx TLS vhost :443
  -> hk003 HAProxy local frontend 127.0.0.1:18084
  -> sgp001 CLIProxy 15.235.145.62:8317
```

sgp001 deployment:

- Synced current hk005 `/home/grey/CLIProxyAPI` to sgp001 `/home/grey/CLIProxyAPI`.
- Started container `sgp001-hk005-cliproxy` from image `cliproxy-local:access-token-only-auth-20260529111911`.
- Published only `15.235.145.62:8317 -> 8317`; the other hk005 legacy published ports were not exposed on sgp001.
- CLIProxy loaded `80` auth entries and returned HTTP 200 on `/`.

hk003 ingress:

- Added HAProxy frontend `cliproxy_opencodex_uk_local` on `127.0.0.1:18084`.
- Added HAProxy backend `sgp001_hk005_cliproxy_8317` to `15.235.145.62:8317`.
- Added nginx site `cliproxy.opencodex.uk` using the existing `opencodex.uk` certificate, whose SAN includes `cliproxy.opencodex.uk`.
- `haproxy -c` and `nginx -t` passed; both services were reloaded.

OVH Network Firewall:

- Added sequence `9`: permit TCP from `156.239.224.30/32` to `15.235.145.62/32` port `8317`.
- Added sequence `10`: deny TCP from any source to `15.235.145.62/32` port `8317`.
- Both rules reached state `ok`.

Cloudflare DNS:

- Updated `cliproxy.opencodex.uk` A record from `156.225.19.45` to `156.239.224.30`, DNS-only, TTL `120`.
- Deleted `cliproxy1.opencodex.uk` A record, which previously pointed to `103.73.161.157`.

Verification:

- Forced and live HTTPS `GET https://cliproxy.opencodex.uk/`: HTTP 200 via hk003.
- Cloudflare DoH: `cliproxy.opencodex.uk -> 156.239.224.30`; `cliproxy1.opencodex.uk` returned NXDOMAIN.
- Public `GET /v1/models` without auth returned HTTP 401, confirming the API path is protected.
- hk003 HAProxy logs showed `cliproxy_opencodex_uk_local -> sgp001_hk005_cliproxy_8317/sgp001_8317`.
- sgp001 CLIProxy logs showed requests entering from hk003 and public client IP headers.
- hk005 source `cli-proxy-api` remained running and local `http://127.0.0.1:8317/` still returned HTTP 200.

## NewAPI 3002 Login Routing Fix: 2026-06-03

Customer reports after the hk003 ingress cutover indicated NewAPI login failures, especially on the OpenCodex/3002 side.

Root cause:

- Before migration, hk002 `api.open-codex.com` proxied to `127.0.0.1:3002`, the `open-codex-newapi-3001` stack.
- After the hk003 ingress cutover, both `api.open-codex.com` and `api.opencodex.uk` were routed to sgp001 `3001`.
- sgp001 `3001` and `3002` are different NewAPI databases/configurations.
- sgp001 `3002` is the stack with `passkey_login=true`, populated OpenCodex console/sidebar module settings, and `server_address=https://api.opencodex.uk`, matching the old hk002 `3002` config.
- Routing those domains to `3001` caused users to hit the wrong NewAPI instance, so existing accounts/tokens/login state did not match expectations.

Fix applied on hk003:

- Changed `api_open_codex_local` from backend `sgp001_hk002_newapi_3001` to `sgp001_hk002_newapi_3002`.
- Changed `api_opencodex_uk_local` from backend `sgp001_hk002_newapi_3001` to `sgp001_hk002_newapi_3002`.
- Added HAProxy backend `sgp001_hk002_newapi_3002 -> 15.235.145.62:3002`.
- `haproxy -c` passed and HAProxy was reloaded.

Verification:

- `https://api.open-codex.com/api/status` now returns sgp001 `3002` markers: `start_time=1780299335`, `passkey_login=true`, and populated OpenCodex module settings.
- `https://api.opencodex.uk/api/status` returns the same sgp001 `3002` markers.
- HAProxy logs show `api_open_codex_local` and `api_opencodex_uk_local` hitting `sgp001_hk002_newapi_3002/sgp001_3002`.
- Old hk002 `3002` and sgp001 `3002` share the same passkey domain settings: `passkey_origins=https://api.opencodex.uk`, `passkey_rp_id=api.opencodex.uk`.

Follow-up for cached/direct sgp001 access:

- hk003 no longer routes public API domains to sgp001 `3001`, but sgp001's local nginx still had a stale direct vhost for `api.open-codex.com -> 15.235.145.62:3001`.
- Updated sgp001 local nginx so direct `api.open-codex.com` and direct `api.opencodex.uk` both proxy to `15.235.145.62:3002`.
- `nginx -t` passed and nginx was reloaded on sgp001.
- Forced sgp001-origin checks from hk003 confirmed both API domains return the sgp001 `3002` markers.

Correction: restored `api.opencodex.uk` to original hk002 `3000` semantics.

- Rechecked old hk002 nginx: `api.opencodex.uk` proxied to `127.0.0.1:3000`, not `3001` or `3002`.
- hk002 `127.0.0.1:3000/api/status` markers: `server_address=https://api.opencodex.uk`, `passkey_login=false`, and empty `HeaderNavModules`.
- sgp001 has the corresponding local `127.0.0.1:3000` service with matching markers.
- Restored sgp001 nginx `api.opencodex.uk` vhost to `proxy_pass http://127.0.0.1:3000`.
- Restored hk003 HAProxy `api_opencodex_uk_local` to backend `sgp001_https_vhosts`, so the current request path is:

```text
api.opencodex.uk
  -> hk003 nginx
  -> hk003 HAProxy 127.0.0.1:18082
  -> sgp001 HTTPS vhost with SNI/Host api.opencodex.uk
  -> sgp001 127.0.0.1:3000
```

- `api.open-codex.com` remains on `sgp001:3002`.
- Public and forced-sgp001 checks confirmed:
  - `api.opencodex.uk/api/status`: `start_time=1780299334`, `passkey_login=false`, empty `HeaderNavModules`.
  - `api.open-codex.com/api/status`: `start_time=1780299335`, `passkey_login=true`, populated OpenCodex module settings.

## NewAPI 3002 Canary Image: 2026-06-04

- Built latest `/home/grey/work/new-api` `main` commit `b826f34e9` as local image `newapi-local:b826f34e9-api-open-codex-3002-20260604005846`.
- Loaded the image onto sgp001 and replaced only `sgp001-hk002-newapi-3001`, which serves `15.235.145.62:3002` and public `api.open-codex.com`.
- Kept `sgp001-hk002-newapi` on `3001` and `sgp001-hk006-newapi` on `3003` unchanged at `newapi-local:channel-cycle-failover-20260530032621`.
- Preserved the previous 3002 container as stopped rollback container `sgp001-hk002-newapi-3001-rollback-20260603170454`.
- Verification after cutover:
  - Direct `http://15.235.145.62:3002/api/status`: HTTP 200.
  - Public `https://api.open-codex.com/api/status`: HTTP 200.
  - 3002 logs showed New API startup and successful `/v1/responses` traffic on channel `35`.

## OpenNana Gallery Migrated To sgp001: 2026-06-07

`opennana-gallery.opencodex.uk` DNS remains on hk003 (`156.239.224.30`), and the OpenNana application now runs on sgp001.

Current working chain:

```text
opennana-gallery.opencodex.uk
  -> hk003 nginx dedicated vhost
  -> hk003 HAProxy local frontend 127.0.0.1:18443
  -> sgp001 HTTPS vhost with Host/SNI opennana-gallery.opencodex.uk
  -> sgp001 nginx /var/www/opennana-gallery and user service opennana-gallery.service
  -> sgp001 backend 127.0.0.1:18080 for /healthz and /api/
```

Migration details:

- Synced hk002 `/home/grey/apps/opennana-gallery/` to sgp001 `/home/grey/apps/opennana-gallery/`.
- Synced hk002 `/var/www/opennana-gallery/` to sgp001 `/var/www/opennana-gallery/`.
- Installed sgp001 user systemd unit `/home/grey/.config/systemd/user/opennana-gallery.service`.
- Enabled lingering for `grey` on sgp001 and enabled/started the user service.
- Installed sgp001 dedicated Nginx vhost `/etc/nginx/sites-available/opennana-gallery.opencodex.uk`, enabled under `sites-enabled`.
- sgp001 uses `/etc/letsencrypt/live/opencodex.uk/` cert; SAN includes `opennana-gallery.opencodex.uk`.
- hk002 source service was left running as rollback source.

hk003 ingress change:

- Updated dedicated `opennana-gallery.opencodex.uk` TLS vhost in `/etc/nginx/sites-available/opencodex.uk`.
- Replaced temporary direct hk002 proxy `https://156.225.19.45` with `proxy_pass http://127.0.0.1:18443`.
- HAProxy frontend `sgp001_https_vhosts_local` binds `127.0.0.1:18443`.
- HAProxy backend `sgp001_https_vhosts` sends to `15.235.145.62:443 ssl verify none check check-ssl sni req.hdr(Host)`.
- Backup before hk003 edit: `/etc/nginx/sites-available/opencodex.uk.bak-opennana-sgp001-20260607T035943Z`.

Verification after migration:

- sgp001 `opennana-gallery.service`: active, backend listening on `127.0.0.1:18080`.
- sgp001 direct `https://opennana-gallery.opencodex.uk/healthz` forced to `15.235.145.62`: HTTP 200, body `{"ok":true}`.
- sgp001 direct `https://opennana-gallery.opencodex.uk/ai-image-generator/` forced to `15.235.145.62`: HTTP 200, title `Nano Banana Pro提示词图库 | OpenNana Replica`.
- hk003 HAProxy local `http://127.0.0.1:18443/healthz` with Host `opennana-gallery.opencodex.uk`: HTTP 200, body `{"ok":true}`.
- Public DNS `opennana-gallery.opencodex.uk`: `156.239.224.30`.
- Public `https://opennana-gallery.opencodex.uk/healthz`: HTTP 200, body `{"ok":true}`.
- Public `https://opennana-gallery.opencodex.uk/ai-image-generator/`: HTTP 200, title `Nano Banana Pro提示词图库 | OpenNana Replica`.
- Mihomo live direct rules contain `DOMAIN-SUFFIX,opencodex.uk`; the outage was ingress/vhost routing, not client routing.
