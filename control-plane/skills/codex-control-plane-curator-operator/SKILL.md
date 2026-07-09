---
name: codex-control-plane-curator-operator
description: Query and operate the local Codex control-plane Curator API through bin/curator to recover Codex history, build context packs, search durable knowledge, inspect jobs, and record commander actions. 通过 bin/curator 调用本地 Codex 控制面 Curator API，获取 Codex 历史、生成上下文包、检索知识、检查任务并记录指挥官动作。
license: CC-BY-4.0
compatibility: Codex, Claude Code, and ClawHub-style markdown skill runners with bash, Python stdlib, local file access, and access to /home/grey/work/codex-control-plane.
---

# Codex Control Plane Curator Operator

Use this skill when Codex needs access to prior Codex work history, resumable sessions, context packs, durable knowledge, worker jobs, job events, outcomes, or commander direct-action records.
当 Codex 需要访问历史 Codex 工作、可恢复会话、上下文包、长期知识、worker 任务、任务事件、结果或指挥官直接操作记录时，使用这个 skill。

## Primary Rule | 核心原则

Use `bin/curator` from `/home/grey/work/codex-control-plane` as the supported interface. Do not read or print Curator admin tokens directly.
使用 `/home/grey/work/codex-control-plane/bin/curator` 作为受支持接口。不要直接读取或打印 Curator admin token。

## API Boundary | API 边界

`bin/curator` is a local Python wrapper around the `codex-session-curator` API.
`bin/curator` 是本地 `codex-session-curator` API 的 Python 包装器。

- default base URL: `http://127.0.0.1:54177`
- token source: `CURATOR_ADMIN_TOKEN`, then `~/.config/codex-session-curator/auth.env`
- the CLI must not print the admin token

## Workflow | 执行流程

1. change to the control-plane root
   切换到控制面根目录
2. inspect available commands with `bin/curator --help`
   用 `bin/curator --help` 确认当前可用命令
3. search resumable history with both `session-index` and `context-pack`
   同时用 `session-index` 和 `context-pack` 搜索可恢复历史
4. use `knowledge-search` for stable facts, conventions, and runbooks
   用 `knowledge-search` 查长期事实、约定和 runbook
5. inspect session or worker details only as deep as the task needs
   只按任务需要深入读取 session 或 worker 细节
6. prefer resuming a high-confidence matched session over creating a new one
   优先恢复高置信匹配会话，而不是创建新会话
7. record meaningful direct work with `direct-action start` and `direct-action finish`
   用 `direct-action start` 和 `direct-action finish` 记录有意义的直接操作

## Common Commands | 常用命令

```bash
cd /home/grey/work/codex-control-plane
bin/curator --help
bin/curator session-index "<project or task keywords>" --limit 20
bin/curator context-pack "<project or task keywords>" --cwd "$PWD" --limit 20
bin/curator knowledge-search "<stable fact or convention>" --repo /path/to/repo --limit 10
bin/curator context <session-id> --history-limit 0
bin/curator search "<keywords>" --limit 10
bin/curator documents "<keywords>" --limit 10
bin/curator jobs
bin/curator registry
bin/curator job <job-id>
bin/curator events <job-id> --after-seq 0
bin/curator outcome <job-id>
```

## Dispatch And Resume | 派发与恢复

Use dispatch only when worker delegation is actually appropriate. Keep worker tasks narrow.
仅在确实适合 worker 代理时使用 dispatch。worker 任务要窄。

```bash
bin/curator dispatch "fix the specific issue" --repo /path/to/repo --mode exec --policy-profile code_edit
bin/curator resume <session-id> "continue the specific task" --repo /path/to/repo --mode exec
bin/curator guide <job-id> "只处理当前任务，不要展开旁支"
bin/curator stop <job-id>
```

## Session Migration | 会话迁移

The Curator panel backend can migrate a session to another project directory,
but the current `bin/curator` CLI does not expose this as a first-class
subcommand.
Curator 面板后端可以把会话迁移到另一个项目目录，但当前 `bin/curator`
CLI 没有把它暴露成一等子命令。

Use the local API only when the user explicitly asks to migrate a session cwd.
Do not print the admin token.
仅当用户明确要求迁移会话 cwd 时，才使用本地 API。不要打印 admin token。

```text
POST /api/sessions/:id/migrate
body: {"targetProjectDir": "/absolute/project/path"}
```

Important behavior:
重要行为：

- migration is copy-based, not an in-place rewrite
- the original session remains unchanged
- the new JSONL receives a new session id
- the new JSONL first `session_meta.payload.cwd` is set to the target directory
- verify the first JSONL line after migration before returning the new resume command

Source locations:
源码位置：

```text
/home/grey/work/codex-session-curator/server/index.ts
/home/grey/work/codex-session-curator/server/session-service.ts
/home/grey/work/codex-session-curator/server/file-ops.ts
```

If the API request times out, check whether a new session JSONL was still
created before retrying.
如果 API 请求超时，先检查是否已经生成新的 session JSONL，再决定是否重试。

## Direct Action Records | 直接操作记录

Use direct-action records when the commander directly changes files, fixes control-plane plumbing, performs production repair, or records a manual note.
当指挥官直接改文件、修控制面链路、做生产修复或记录手工说明时，使用 direct-action 记录。

```bash
bin/curator direct-action start \
  --kind direct-action \
  --goal "short concrete goal" \
  --reason "why direct action is appropriate" \
  --scope "paths and constraints" \
  --cwd /home/grey/work/codex-control-plane \
  --target-repo /path/to/repo

bin/curator direct-action finish <action-id> \
  --status completed \
  --changed-files "file1,file2" \
  --tests "commands run" \
  --verification "proof of result" \
  --follow-up "none"
```

## Strong Heuristics | 强判断规则

- if the task references previous work, run `session-index` and `context-pack` before guessing
- if `context-pack` returns `recommendedResume` with high confidence, use that session as the continuity anchor
- if a fact should survive future sessions, store it through Curator knowledge or the appropriate `memory/` file, not only in chat
- if Curator is unavailable, repair the control-plane path first, then backfill the direct-action record
- if using `dispatch`, include target repo, in-scope files, out-of-scope files, checks, and expected report format
- if reading events or context, summarize only what is relevant; do not dump long transcripts
- if migrating a session cwd, use `/api/sessions/:id/migrate`, then return the new session id and `codex resume -C <target> <new-session-id>`

中文解释：

- 任务提到历史工作时，先跑 `session-index` 和 `context-pack`，不要猜。
- `context-pack` 给出高置信 `recommendedResume` 时，把它作为连续性锚点。
- 需要长期保留的事实写进 Curator knowledge 或 `memory/`，不要只留在聊天里。
- Curator 不可用时，先修控制面链路，再补 direct-action 记录。
- 使用 `dispatch` 时，要写清目标 repo、范围、排除范围、检查命令和报告格式。
- 读取 events 或 context 时，只总结相关部分，不要倾倒长 transcript。
- 迁移会话 cwd 时，使用 `/api/sessions/:id/migrate`，然后返回新的 session id 和 `codex resume -C <目标目录> <新 session id>`。

## Response Format | 输出格式

Always return:
始终返回：

1. query or task keywords used
2. Curator commands run
3. matched sessions, knowledge, jobs, or direct actions
4. chosen continuity action: resume, dispatch, direct action, or no action
5. verification or remaining blocker

## Constraints | 约束

- do not reveal `CURATOR_ADMIN_TOKEN` or auth.env contents
- do not treat raw chat context as more authoritative than Curator records
- do not create overlapping worker jobs without checking existing jobs first
- do not stop or guide jobs unless the task requires it
- do not claim latest history without running the Curator query
