# Codex Session Curator Blue-Green Deploy

`codex-session-curator` runs on the local machine and is exposed by FRP at
`frp.xiannai.me:48088`. The deployment shape is local blue-green rather than
GitHub-CI-first:

```text
FRP remote 48088
  -> 127.0.0.1:54177 nginx proxy
  -> blue slot  127.0.0.1:54187
  -> green slot 127.0.0.1:54188
```

The deploy script builds the source frontend, creates a timestamped release
from the current runtime tree, starts the inactive slot, verifies it, switches
the proxy, then stops the previous slot. It retains only the current release
and one rollback release.

```bash
cd /home/grey/work/codex-session-curator
scripts/deploy-blue-green.sh deploy
scripts/deploy-blue-green.sh status
scripts/deploy-blue-green.sh rollback
```

GitHub CI is optional later. For this service, CI should only build/test and
trigger the same local script over a verified local runner or SSH path. It
should not bypass the local health checks, proxy switch, and rollback-retention
policy.

The service is not containerized today. "Image" retention maps to release
directory retention:

- active release: target of the active slot symlink
- rollback release: `state/rollback-release`
- old slot process: stopped after cutover

Runtime paths:

```text
runtime source of truth: /home/grey/data/apps/codex-session-curator
blue-green root:        /home/grey/data/apps/codex-session-curator-blue-green
source repo:            /home/grey/work/codex-session-curator
```
