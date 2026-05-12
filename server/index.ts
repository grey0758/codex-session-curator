import cors from '@fastify/cors';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getCodexHome, getStatePath, isClaudeSessionPath } from './file-ops.js';
import { readAnalysisRuns } from './analysis-log.js';
import { parseSessionHistory } from './session-parser.js';
import {
  checkRemoteAgent,
  deleteAgentSession,
  deleteAgentSessionsBulk,
  fetchAgentJson,
  fetchAgentSessions,
  getRemoteAgents,
  postAgentJson,
} from './remote-agents.js';
import { SessionService } from './session-service.js';
import { CuratorStore } from './store.js';
import { startCodexTerminal, type TerminalInput } from './terminal.js';
import type { CodexSession } from './types.js';
import {
  exportServerIdentityInventory,
  getServerIdentityMachine,
  listServerIdentityMachines,
  patchServerIdentityMachine,
  renderServerIdentitySshConfig,
  upsertServerIdentityMachine,
} from './server-identity.js';
import {
  getCodexResumeJob,
  listCodexJobEvents,
  listCodexResumeJobs,
  recordCodexJobAudit,
  sendCodexJobGuidance,
  sendCodexJobProtocolMessage,
  startCodexResumeJob,
  startCodexSupervisorLoop,
  stopCodexResumeJob,
  superviseCodexResumeJob,
  type CodexJobProtocolKind,
  type CodexResumeJob,
  type CodexJobMode,
} from './codex-jobs.js';
import { evaluateJobSemantics } from './job-supervisor-ai.js';
import {
  getEvaluatorBaseUrl,
  getEvaluatorModel,
  getEvaluatorProvider,
  getEvaluatorRpmLimit,
  getRecommendedEvaluationConcurrency,
} from './evaluator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function redactRequestUrl(url: string | undefined): string | undefined {
  return url?.replace(/([?&](?:admin_token|token)=)[^&]+/gi, '$1[redacted]');
}

const app = Fastify({
  logger: {
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactRequestUrl(request.url),
          host: request.headers.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        };
      },
    },
  },
});
const codexHome = getCodexHome();
const store = new CuratorStore(getStatePath(codexHome));
const service = new SessionService(store);
const remoteAgents = getRemoteAgents();

const sessionCacheTtlMs = Number(process.env.CURATOR_SESSION_CACHE_TTL_MS || 8000);
const remoteSessionCacheTtlMs = Number(process.env.CURATOR_REMOTE_SESSION_CACHE_TTL_MS || 15000);
const defaultHermesStaleOutputMs = Number(process.env.CURATOR_HERMES_STALE_OUTPUT_MS || 2 * 60 * 1000);
const defaultHermesMaxRuntimeMs = Number(process.env.CURATOR_HERMES_MAX_RUNTIME_MS || 10 * 60 * 1000);
let localSessionsCache: { expiresAt: number; promise: Promise<Awaited<ReturnType<SessionService['listSessions']>>> } | null = null;
let localFastSessionsCache: { expiresAt: number; promise: Promise<Awaited<ReturnType<SessionService['listSessions']>>> } | null = null;
let remoteSessionsCache: { expiresAt: number; promise: Promise<Awaited<ReturnType<typeof fetchAgentSessions>>[]> } | null = null;
const remoteJobRegistryCache = new Map<
  string,
  {
    expiresAt: number;
    updatedAt: string;
    healthy: boolean;
    jobs: Array<{ machineId: string; baseUrl: string | null; job: CodexResumeJob }>;
    error: string | null;
  }
>();
let autoBackfillRunning = false;

type EvaluationRefreshJobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface EvaluationRefreshJob {
  id: string;
  sessionId: string;
  reason: string;
  status: EvaluationRefreshJobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: Awaited<ReturnType<SessionService['refreshSessionEvaluation']>> | null;
  error: string | null;
}

const evaluationRefreshJobs = new Map<string, EvaluationRefreshJob>();
const evaluationRefreshQueue: string[] = [];
let runningEvaluationRefreshJobs = 0;

const keepSchema = z.object({ kept: z.boolean() });
const titleSchema = z.object({ title: z.string().max(120) });
const loginSchema = z.object({ username: z.string().min(1).max(120), password: z.string().min(1).max(300) });
const migrateSchema = z.object({ targetProjectDir: z.string().min(1).max(1000) });
const confirmSchema = z.object({ confirm: z.literal(true) });
const backfillSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  includeFailed: z.boolean().optional(),
});
const bulkDeleteSchema = z.object({ confirm: z.literal(true), ids: z.array(z.string().min(1).max(160)).min(1).max(200) });
const sessionIdSchema = z.object({ id: z.string().min(1).max(160) });
const hermesSearchSchema = z.object({
  q: z.string().min(1).transform((value) => value.slice(0, 1000)),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const jobPolicySchema = z.record(z.string(), z.unknown());
const taskTemplateSchema = z.enum(['fix', 'test', 'deploy', 'review', 'migrate', 'investigate']).optional();
const policyProfileSchema = z
  .enum(['read_only', 'code_edit', 'test_only', 'deploy_allowed', 'dangerous_ops_allowed'])
  .optional();
const supervisorStrategySchema = z
  .object({
    autoStop: z.boolean().optional(),
    autoRetry: z.boolean().optional(),
    checkIntervalMs: z.number().int().min(250).max(3_600_000).optional(),
    staleOutputMs: z.number().int().min(1_000).max(86_400_000).optional(),
    retryMode: z.enum(['exec', 'pty']).optional(),
  })
  .passthrough();
const resumeJobSchema = z.object({
  sessionId: z.string().min(1).max(160),
  prompt: z.string().min(1).max(20_000),
  model: z.string().min(1).max(120).optional(),
  extraArgs: z.array(z.string().min(1).max(300)).max(20).optional(),
  mode: z.enum(['exec', 'pty']).optional(),
  supervisor: z.union([z.boolean(), supervisorStrategySchema]).optional(),
  policy: jobPolicySchema.optional(),
  policyProfile: policyProfileSchema,
  template: taskTemplateSchema,
});
const hermesDispatchSchema = z.object({
  query: z.string().min(1).max(2000),
  prompt: z.string().min(1).max(20_000).optional(),
  sessionId: z.string().min(1).max(160).optional(),
  model: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(10).optional(),
  requireConfirmationBelowScore: z.number().int().min(0).max(100).optional(),
  extraArgs: z.array(z.string().min(1).max(300)).max(20).optional(),
  mode: z.enum(['exec', 'pty']).optional(),
  supervisor: z.union([z.boolean(), supervisorStrategySchema]).optional(),
  policy: jobPolicySchema.optional(),
  policyProfile: policyProfileSchema,
  template: taskTemplateSchema,
});
const jobGuidanceSchema = z.object({
  text: z.string().min(1).max(20_000),
  source: z.enum(['hermes', 'supervisor', 'api']).optional(),
});
const jobEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const jobProtocolSchema = z.object({
  kind: z.enum(['guide', 'pause', 'continue', 'summarize', 'handoff', 'verify']),
  text: z.string().max(20_000).optional().default(''),
});
const jobSupervisorSchema = z.object({
  instruction: z.string().min(1).max(20_000).optional(),
  autoStop: z.boolean().optional(),
  autoRetry: z.boolean().optional(),
  checkIntervalMs: z.number().int().min(250).max(3_600_000).optional(),
  staleOutputMs: z.number().int().min(1_000).max(86_400_000).optional(),
  retryMode: z.enum(['exec', 'pty']).optional(),
  semantic: z.boolean().optional(),
});
const sessionContextSchema = z.object({
  historyLimit: z.coerce.number().int().min(0).max(80).optional(),
});
const sessionFilesQuerySchema = z.object({
  path: z.string().max(2000).optional().default(''),
});
const sessionFileUploadQuerySchema = z.object({
  path: z.string().max(2000).optional().default(''),
  name: z.string().min(1).max(255),
  overwrite: z.enum(['0', '1', 'true', 'false']).optional(),
});
const remoteControlSchema = z.object({
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const includeDeprecatedSchema = z.object({
  includeDeprecated: z.enum(['0', '1', 'true', 'false']).optional(),
});
const hermesSessionIndexSchema = z.object({
  q: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const serverIdentityAliasSchema = z.object({ alias: z.string().min(1).max(120) });
const serverIdentityMachineSchema = z
  .object({
    alias: z.string().min(1).max(120),
    aliases: z.array(z.string().min(1).max(120)).optional(),
    status: z.enum(['active', 'deprecated']).optional(),
    region: z.string().max(120).nullable().optional(),
    public_dns: z.string().max(300).nullable().optional(),
    public_ip: z.string().max(120).nullable().optional(),
    ssh_user: z.string().max(120).optional(),
    ssh_users: z.array(z.string().min(1).max(120)).optional(),
    ssh_port: z.number().int().min(1).max(65535).optional(),
    frp_hostname: z.string().max(300).nullable().optional(),
    frp_port: z.number().int().min(1).max(65535).nullable().optional(),
    tailscale_hostname: z.string().max(300).nullable().optional(),
    tailscale_ip: z.string().max(120).nullable().optional(),
    priority: z.array(z.enum(['public', 'frp', 'tailscale'])).min(1).max(3).optional(),
    verified_hostname: z.string().max(300).nullable().optional(),
    verified_at: z.string().max(80).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    identity_file: z.string().max(500).nullable().optional(),
    identity_public_key_ref: z.string().max(500).nullable().optional(),
    host_key_alias: z.string().max(300).nullable().optional(),
  })
  .strict();
const serverIdentityPatchSchema = serverIdentityMachineSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'patch body must not be empty',
});

type SessionListItem = Awaited<ReturnType<SessionService['listSessions']>>[number];
let supervisorSessionCache: SessionListItem[] = [];

function toSessionSummary(session: SessionListItem) {
  return {
    ...session,
    evaluation: {
      ...session.evaluation,
      detailedSummary: '',
      reasons: session.evaluation.reasons.slice(0, 2),
      actualWorkdirs: session.evaluation.actualWorkdirs.slice(0, 4),
      directoryIndex: (session.evaluation.directoryIndex ?? []).slice(0, 16),
      techStack: (session.evaluation.techStack ?? []).slice(0, 12),
      keywords: (session.evaluation.keywords ?? []).slice(0, 18),
      reviewSignals: (session.evaluation.reviewSignals ?? []).slice(0, 3),
      remoteMachines: session.evaluation.remoteMachines.slice(0, 3),
    },
  };
}

function sessionSearchText(session: SessionListItem): string {
  return [
    session.id,
    session.title,
    session.resumeCommand,
    session.cwd ?? '',
    session.machineId,
    session.lastUserMessage?.text ?? '',
    session.lastAssistantMessage?.text ?? '',
    session.evaluation.summary,
    session.evaluation.detailedSummary,
    session.evaluation.searchText ?? '',
    ...session.evaluation.actualWorkdirs,
    ...(session.evaluation.directoryIndex ?? []),
    ...(session.evaluation.techStack ?? []),
    ...(session.evaluation.keywords ?? []),
    ...(session.evaluation.failureCards ?? []).flatMap((card) => [card.category, card.title, card.summary, card.evidence]),
    ...(session.evaluation.jobOutcomes ?? []).flatMap((outcome) => [
      outcome.status,
      outcome.goal,
      outcome.cwd ?? '',
      outcome.summary,
      outcome.failureReason ?? '',
      outcome.nextAction ?? '',
      ...outcome.changedFiles,
      ...outcome.tests,
    ]),
    session.evaluation.recommendedWorkdir ?? '',
    ...session.evaluation.remoteMachines.map((machine) =>
      [machine.label, machine.host, machine.ip, machine.user, machine.evidence].filter(Boolean).join(' ')
    ),
  ]
    .join(' ')
    .toLowerCase();
}

function cleanRelativeWorkdirPath(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw || raw === '.') return '';
  if (raw.includes('\0') || isAbsolute(raw)) throw new Error('Invalid path');
  const cleaned = normalize(raw);
  if (!cleaned || cleaned === '.') return '';
  if (cleaned.startsWith('..') || cleaned.includes(`${sep}..${sep}`)) throw new Error('Path escapes session cwd');
  return cleaned;
}

function safeFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid file name');
  }
  return trimmed;
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveSessionWorkdirPath(session: SessionListItem, requestedPath = '') {
  if (!session.cwd) throw new Error('Session has no cwd');
  const baseReal = await realpath(session.cwd);
  const relativePath = cleanRelativeWorkdirPath(requestedPath);
  const target = resolve(baseReal, relativePath || '.');
  const targetReal = await realpath(target);
  if (!isInsidePath(baseReal, targetReal)) throw new Error('Path escapes session cwd');
  return { baseReal, relativePath, targetReal };
}

async function resolveSessionUploadPath(session: SessionListItem, requestedPath: string, fileName: string) {
  if (!session.cwd) throw new Error('Session has no cwd');
  const baseReal = await realpath(session.cwd);
  const relativePath = cleanRelativeWorkdirPath(requestedPath);
  const directory = resolve(baseReal, relativePath || '.');
  const directoryReal = await realpath(directory);
  if (!isInsidePath(baseReal, directoryReal)) throw new Error('Upload path escapes session cwd');
  const target = resolve(directoryReal, safeFileName(fileName));
  if (!isInsidePath(baseReal, target)) throw new Error('Upload target escapes session cwd');
  return { baseReal, directoryReal, target, relativePath };
}

function fileEntryPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

async function listSessionWorkdir(session: SessionListItem, requestedPath = '') {
  const { baseReal, relativePath, targetReal } = await resolveSessionWorkdirPath(session, requestedPath);
  const targetStat = await stat(targetReal);
  if (!targetStat.isDirectory()) throw new Error('Path is not a directory');
  const entries = await Promise.all(
    (await readdir(targetReal, { withFileTypes: true })).map(async (entry) => {
      const fullPath = join(targetReal, entry.name);
      const info = await stat(fullPath).catch(() => null);
      const entryRelativePath = fileEntryPath(relativePath, entry.name);
      return {
        name: entry.name,
        path: entryRelativePath,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: info?.size ?? null,
        mtime: info?.mtime.toISOString() ?? null,
      };
    })
  );
  entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  const parent = relativePath ? dirname(relativePath).replace(/\\/g, '/') : null;
  return {
    sessionId: session.id,
    machineId: session.machineId,
    cwd: session.cwd,
    root: baseReal,
    path: relativePath,
    parent: parent === '.' ? '' : parent,
    entries,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envNameForMachine(machineId: string | null | undefined): string | null {
  const normalized = machineId?.trim().replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return normalized ? `CURATOR_TERMINAL_SSH_TARGET_${normalized}` : null;
}

function sshTargetForSession(session: Pick<SessionListItem, 'machineId'>): string | null {
  const machineEnvName = envNameForMachine(session.machineId);
  const configured = (machineEnvName ? process.env[machineEnvName] : null) || process.env.CURATOR_TERMINAL_SSH_TARGET;
  return configured?.trim() || null;
}

function remotePythonCommand(script: string, args: string[]): string {
  return `python3 -c ${shellQuote(script)} ${args.map(shellQuote).join(' ')}`;
}

function runRemoteJson<T>(target: string, script: string, args: string[], input?: Buffer): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remotePythonCommand(script, args)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(err || `remote ssh command failed with code ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(out) as T);
      } catch (error) {
        reject(error);
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

const remoteResolvePrelude = String.raw`
import json, os, shutil, sys
def fail(message, code=2):
    print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
    sys.exit(code)
def safe_rel(value):
    value = (value or "").strip()
    if "\x00" in value or os.path.isabs(value):
        fail("Invalid path")
    if value in ("", "."):
        return ""
    norm = os.path.normpath(value)
    if norm == ".":
        return ""
    if norm.startswith("..") or "/../" in norm:
        fail("Path escapes session cwd")
    return norm
def safe_name(value):
    value = (value or "").strip()
    if not value or "\x00" in value or "/" in value or "\\" in value or value in (".", ".."):
        fail("Invalid file name")
    return value
def inside(base, target):
    return target == base or target.startswith(base.rstrip(os.sep) + os.sep)
base_arg = sys.argv[1]
rel_arg = sys.argv[2] if len(sys.argv) > 2 else ""
if not base_arg:
    fail("Session has no cwd")
base = os.path.realpath(base_arg)
rel = safe_rel(rel_arg)
target = os.path.realpath(os.path.join(base, rel or "."))
if not inside(base, target):
    fail("Path escapes session cwd")
`;

const remoteListScript = `${remoteResolvePrelude}
if not os.path.isdir(target):
    fail("Path is not a directory")
entries = []
for name in os.listdir(target):
    full = os.path.join(target, name)
    try:
        st = os.lstat(full)
        if os.path.isdir(full) and not os.path.islink(full):
            typ = "directory"
        elif os.path.isfile(full) and not os.path.islink(full):
            typ = "file"
        elif os.path.islink(full):
            typ = "symlink"
        else:
            typ = "other"
        entries.append({
            "name": name,
            "path": (rel + "/" + name) if rel else name,
            "type": typ,
            "size": st.st_size,
            "mtime": __import__("datetime").datetime.fromtimestamp(st.st_mtime, __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        })
    except OSError:
        continue
entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
parent = None if not rel else os.path.dirname(rel)
print(json.dumps({"root": base, "path": rel, "parent": "" if parent == "." else parent, "entries": entries}))
`;

const remoteStatScript = `${remoteResolvePrelude}
if not os.path.isfile(target):
    fail("Path is not a file")
st = os.stat(target)
print(json.dumps({"name": os.path.basename(target), "size": st.st_size}))
`;

const remoteDownloadScript = `${remoteResolvePrelude}
if not os.path.isfile(target):
    fail("Path is not a file")
with open(target, "rb") as handle:
    shutil.copyfileobj(handle, sys.stdout.buffer)
`;

const remoteUploadScript = `${remoteResolvePrelude}
name = safe_name(sys.argv[3] if len(sys.argv) > 3 else "")
overwrite = (sys.argv[4] if len(sys.argv) > 4 else "0") in ("1", "true")
if not os.path.isdir(target):
    fail("Upload path is not a directory")
dest = os.path.realpath(os.path.join(target, name))
if not inside(base, dest):
    fail("Upload target escapes session cwd")
mode = "wb" if overwrite else "xb"
with open(dest, mode) as handle:
    shutil.copyfileobj(sys.stdin.buffer, handle)
st = os.stat(dest)
entry_path = (rel + "/" + name) if rel else name
print(json.dumps({"ok": True, "entry": {"name": name, "path": entry_path, "type": "file", "size": st.st_size, "mtime": __import__("datetime").datetime.fromtimestamp(st.st_mtime, __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")}}))
`;

async function listRemoteSessionWorkdir(session: SessionListItem, requestedPath = '') {
  const target = sshTargetForSession(session);
  if (!target) throw new Error(`No SSH target configured for machine ${session.machineId || 'unknown'}`);
  const result = await runRemoteJson<{ root: string; path: string; parent: string | null; entries: unknown[] }>(target, remoteListScript, [
    session.cwd || '',
    requestedPath,
  ]);
  return {
    sessionId: session.id,
    machineId: session.machineId,
    cwd: session.cwd,
    ...result,
  };
}

async function statRemoteSessionFile(session: SessionListItem, requestedPath = '') {
  const target = sshTargetForSession(session);
  if (!target) throw new Error(`No SSH target configured for machine ${session.machineId || 'unknown'}`);
  return {
    target,
    ...(await runRemoteJson<{ name: string; size: number }>(target, remoteStatScript, [session.cwd || '', requestedPath])),
  };
}

function spawnRemoteFileDownload(target: string, session: SessionListItem, requestedPath = '') {
  return spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remotePythonCommand(remoteDownloadScript, [session.cwd || '', requestedPath])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function uploadRemoteSessionFile(session: SessionListItem, requestedPath: string, fileName: string, overwrite: boolean, body: Buffer) {
  const target = sshTargetForSession(session);
  if (!target) throw new Error(`No SSH target configured for machine ${session.machineId || 'unknown'}`);
  const result = await runRemoteJson<{ ok: boolean; entry: unknown }>(
    target,
    remoteUploadScript,
    [session.cwd || '', requestedPath, fileName, overwrite ? '1' : '0'],
    body
  );
  return result;
}

function scoreHermesMatch(session: SessionListItem, query: string): number {
  const haystack = sessionSearchText(session);
  const terms = query
    .toLowerCase()
    .split(/[\s,，。/\\|:：;；()[\]{}"'`]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  let score = 0;
  if (haystack.includes(query.toLowerCase())) score += 12;
  if (session.id.includes(query)) score += 30;
  for (const term of terms) {
    if (session.id.toLowerCase().includes(term)) score += 12;
    if (session.title.toLowerCase().includes(term)) score += 8;
    if ((session.cwd ?? '').toLowerCase().includes(term)) score += 6;
    if (session.evaluation.summary.toLowerCase().includes(term)) score += 5;
    if (session.evaluation.detailedSummary.toLowerCase().includes(term)) score += 4;
    if ((session.evaluation.techStack ?? []).some((item) => item.toLowerCase().includes(term))) score += 3;
    if ((session.evaluation.keywords ?? []).some((item) => item.toLowerCase().includes(term))) score += 3;
  }
  if (session.activityStatus === 'active') score += 2;
  if (session.kept) score += 2;
  return score;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。/\\|:：;；()[\]{}"'`]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreDocumentMatch(document: {
  id: string;
  title: string;
  text: string;
  machineId?: string | null;
  sessionId?: string | null;
}, query: string): number {
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  const haystack = [document.id, document.title, document.text, document.machineId ?? '', document.sessionId ?? '']
    .join(' ')
    .toLowerCase();
  let score = haystack.includes(needle) ? 10 : 0;
  for (const term of queryTerms(query)) {
    if (haystack.includes(term)) score += 3;
    if (document.title.toLowerCase().includes(term)) score += 2;
    if (document.id.toLowerCase().includes(term)) score += 2;
  }
  return score;
}

function toHermesSession(session: SessionListItem, query = '') {
  const hermesRefreshStatus =
    session.evaluation.hermesRefreshStatus ?? (session.evaluation.hermesNeedsRefresh ? 'pending' : 'never');
  return {
    id: session.id,
    title: session.title,
    summary: session.evaluation.summary,
    detailedSummary: session.evaluation.detailedSummary,
    hermesContext: session.evaluation.hermesContext ?? '',
    hermesContextUpdatedAt: session.evaluation.hermesContextUpdatedAt ?? null,
    hermesLastUsedAt: session.evaluation.hermesLastUsedAt ?? null,
    hermesLastJobId: session.evaluation.hermesLastJobId ?? null,
    hermesNeedsRefresh: hermesRefreshStatus === 'failed' ? true : session.evaluation.hermesNeedsRefresh ?? false,
    hermesRecalculatedAt: session.evaluation.hermesRecalculatedAt ?? null,
    hermesRefreshStatus,
    hermesRefreshError: session.evaluation.hermesRefreshError ?? null,
    workflow: session.evaluation.workflow,
    model: session.evaluation.model,
    status: session.evaluation.status,
    error: session.evaluation.error,
    recommendation: session.evaluation.recommendation,
    score: query ? scoreHermesMatch(session, query) : session.evaluation.score,
    cwd: session.cwd,
    machineId: session.machineId,
    updatedAt: session.updatedAt,
    activityStatus: session.activityStatus,
    resumeCommand: session.cwd ? `codex resume -C ${session.cwd} ${session.id}` : session.resumeCommand,
    canResume: Boolean(session.cwd && !session.deleted),
    actualWorkdirs: session.evaluation.actualWorkdirs,
    recommendedWorkdir: session.evaluation.recommendedWorkdir,
    directoryIndex: session.evaluation.directoryIndex,
    techStack: session.evaluation.techStack,
    keywords: session.evaluation.keywords,
    failureCards: session.evaluation.failureCards ?? [],
    jobOutcomes: session.evaluation.jobOutcomes ?? [],
    remoteMachines: session.evaluation.remoteMachines,
    messageCount: session.messageCount,
    userTurns: session.userTurns,
    assistantTurns: session.assistantTurns,
    lastUserMessage: session.lastUserMessage,
    lastAssistantMessage: session.lastAssistantMessage,
  };
}

function toHermesSessionIndexEntry(session: SessionListItem, query = '') {
  const base = toHermesSession(session, query);
  return {
    id: base.id,
    title: base.title,
    machineId: base.machineId,
    cwd: base.cwd,
    recommendedWorkdir: base.recommendedWorkdir,
    resumeCommand: base.resumeCommand,
    canResume: base.canResume,
    updatedAt: base.updatedAt,
    activityStatus: base.activityStatus,
    score: base.score,
    recommendation: base.recommendation,
    summary: base.summary,
    directoryIndex: base.directoryIndex,
    actualWorkdirs: base.actualWorkdirs,
    keywords: base.keywords,
    techStack: base.techStack,
    remoteMachines: base.remoteMachines,
    messageCount: base.messageCount,
    userTurns: base.userTurns,
    assistantTurns: base.assistantTurns,
    workflow: base.workflow,
    status: base.status,
    hermesRefreshStatus: base.hermesRefreshStatus,
    preferredAction: base.canResume ? 'resume' : 'inspect',
  };
}

function isUsableAbsoluteWorkdir(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.trim().length > 1;
}

function effectiveJobCwd(session: Pick<SessionListItem, 'cwd' | 'evaluation'>): string | null {
  const recommended = session.evaluation.recommendedWorkdir;
  if (isUsableAbsoluteWorkdir(recommended)) return recommended;
  return session.cwd ?? null;
}

function withEffectiveJobCwd<T extends SessionListItem>(session: T): T {
  const cwd = effectiveJobCwd(session);
  if (!cwd || cwd === session.cwd) return session;
  return { ...session, cwd };
}

function withEffectiveHermesSessionCwd<T extends ReturnType<typeof toHermesSession>>(session: T): T {
  const cwd = isUsableAbsoluteWorkdir(session.recommendedWorkdir) ? session.recommendedWorkdir : session.cwd;
  if (!cwd || cwd === session.cwd) return session;
  return {
    ...session,
    cwd,
    resumeCommand: `codex resume -C ${cwd} ${session.id}`,
  };
}

function truncateWorkerContext(value: string | null | undefined, max = 900): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function stateSessionActivity(updatedAt: string | null | undefined): {
  activityStatus: 'active' | 'inactive';
  lastActiveAt: string | null;
  inactiveDays: number | null;
} {
  if (!updatedAt) return { activityStatus: 'inactive', lastActiveAt: null, inactiveDays: null };
  const elapsed = Date.now() - Date.parse(updatedAt);
  const inactiveDays = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 86_400_000)) : null;
  return {
    activityStatus: inactiveDays !== null && inactiveDays <= 3 ? 'active' : 'inactive',
    lastActiveAt: updatedAt,
    inactiveDays,
  };
}

async function getStateSessionsForHermes(): Promise<SessionListItem[]> {
  const state = await store.load();
  const machineId = service.getMeta().machineId;
  return Object.entries(state.evaluations)
    .filter(([id]) => !state.deletedIds.includes(id))
    .map(([id, evaluation]) => {
      const activity = stateSessionActivity(evaluation.updatedAt ?? evaluation.evaluatedAt);
      const agent = isClaudeSessionPath(evaluation.filePath) ? 'claude' : 'codex';
      return {
        id,
        agent,
        filePath: evaluation.filePath,
        cwd: evaluation.cwd ?? null,
        startedAt: evaluation.startedAt ?? null,
        updatedAt: evaluation.updatedAt ?? evaluation.evaluatedAt,
        bytes: evaluation.bytes,
        messageCount: evaluation.messageCount ?? 0,
        userTurns: evaluation.userTurns ?? 0,
        assistantTurns: evaluation.assistantTurns ?? 0,
        lastUserMessage: evaluation.lastUserMessage ?? null,
        lastAssistantMessage: evaluation.lastAssistantMessage ?? null,
        shellSnapshotCount: evaluation.shellSnapshotCount ?? 0,
        title: state.titles[id] || evaluation.title || evaluation.summary || id,
        customTitle: state.titles[id] ?? null,
        resumeCommand: agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`,
        machineId,
        kept: state.keptIds.includes(id),
        deleted: false,
        evaluation,
        ...activity,
      };
    });
}

function buildHermesMemoryContext(sessions: ReturnType<typeof toHermesSession>[]): string {
  if (!sessions.length) return '';
  const lines = ['Codex Session Curator matched sessions:'];
  sessions.slice(0, 5).forEach((session, index) => {
    lines.push(
      `${index + 1}. ${session.title}`,
      `   id: ${session.id}`,
      `   machine: ${session.machineId}`,
      `   cwd: ${session.cwd ?? 'unknown'}`,
      `   resume: ${session.resumeCommand}`,
      `   summary: ${session.summary}`,
      session.detailedSummary ? `   detail: ${session.detailedSummary}` : '',
      session.lastUserMessage ? `   last_user: ${session.lastUserMessage.text.slice(0, 700)}` : '',
      session.lastAssistantMessage ? `   last_agent: ${session.lastAssistantMessage.text.slice(0, 700)}` : '',
      session.techStack.length ? `   tech: ${session.techStack.join(', ')}` : '',
      session.jobOutcomes.length
        ? `   recent_jobs: ${session.jobOutcomes.slice(0, 3).map((job) => `${job.status}:${job.summary}`).join(' / ')}`
        : '',
      ''
    );
  });
  return lines.filter(Boolean).join('\n');
}

function buildHermesSearchDocuments(session: SessionListItem) {
  const base = toHermesSession(session);
  const docs = [
    {
      id: `${base.id}:session-index`,
      kind: 'session_index',
      sessionId: base.id,
      machineId: base.machineId,
      title: `Session index: ${base.title}`,
      text: [
        base.id,
        base.title,
        base.resumeCommand,
        base.cwd ?? '',
        base.recommendedWorkdir ?? '',
        base.summary,
        ...base.actualWorkdirs,
        ...base.directoryIndex,
        ...base.techStack,
        ...base.keywords,
      ].filter(Boolean).join('\n'),
      updatedAt: base.updatedAt,
    },
    {
      id: `${base.id}:session`,
      kind: 'session',
      sessionId: base.id,
      machineId: base.machineId,
      title: base.title,
      text: [
        base.summary,
        base.detailedSummary,
        base.lastUserMessage?.text,
        base.lastAssistantMessage?.text,
        base.cwd,
        ...base.techStack,
        ...base.keywords,
      ].filter(Boolean).join('\n'),
      updatedAt: base.updatedAt,
    },
    ...base.jobOutcomes.map((outcome) => ({
      id: `${base.id}:job:${outcome.jobId}`,
      kind: 'job_outcome',
      sessionId: base.id,
      jobId: outcome.jobId,
      machineId: outcome.machineId || base.machineId,
      title: `Codex worker ${outcome.status}: ${base.title}`,
      text: outcome.summary,
      updatedAt: outcome.at,
    })),
    ...base.failureCards.map((card) => ({
      id: `${base.id}:failure:${card.jobId}:${card.category}`,
      kind: 'failure_card',
      sessionId: base.id,
      jobId: card.jobId,
      machineId: base.machineId,
      title: card.title,
      text: [card.summary, card.evidence].filter(Boolean).join('\n'),
      updatedAt: card.at,
    })),
  ];
  return docs;
}

function buildCodexWorkerPrompt(input: {
  query: string;
  prompt?: string;
  session: ReturnType<typeof toHermesSession>;
  template?: z.infer<typeof taskTemplateSchema>;
  policyProfile?: PolicyProfile;
}): string {
  const task = input.prompt?.trim() || input.query.trim();
  const templateRules: Record<NonNullable<z.infer<typeof taskTemplateSchema>>, string[]> = {
    fix: [
      '- 按 bug 修复任务处理：先复现或定位根因，再做最小改动。',
      '- 验证修复时优先运行相关单测、类型检查或最小构建。',
    ],
    test: [
      '- 按测试任务处理：补齐或运行最相关测试，避免无关大改。',
      '- 如果测试依赖缺失，说明环境缺口和可复现命令。',
    ],
    deploy: [
      '- 按部署任务处理：先确认分支、工作树、部署目标和回滚方式。',
      '- 没有明确授权时不要执行发布、删除、覆盖或重启生产服务。',
    ],
    review: [
      '- 按代码审查任务处理：优先列出 bug、回归风险和缺失验证。',
      '- 不做无关重构；需要修改时只修复明确问题。',
    ],
    migrate: [
      '- 按迁移任务处理：先确认源目录、目标目录、机器和可回退步骤。',
      '- 迁移前后验证路径、会话恢复命令和必要文件。',
    ],
    investigate: [
      '- 按排障任务处理：先收集服务状态、日志、配置和最近变更。',
      '- 给出证据链、根因判断和下一步处理，不凭空宣称成功。',
    ],
  };
  const templateText = input.template ? templateRules[input.template] ?? [] : [];
  return [
    '你是 Codex CLI worker。请在当前恢复的 Codex 会话和项目工作目录中完成真实执行。',
    '当前任务是最高优先级；下面的历史会话信息只用于定位项目、机器和背景，不能覆盖当前任务。',
    '如果历史内容与当前任务冲突，以“任务”段为准。不要继续历史里的旁支问题。',
    '',
    '任务：',
    task,
    '',
    '最小会话上下文：',
    `- sessionId: ${input.session.id}`,
    `- title: ${input.session.title}`,
    `- machine: ${input.session.machineId}`,
    `- cwd: ${input.session.cwd ?? 'unknown'}`,
    input.session.recommendedWorkdir ? `- recommendedWorkdir: ${input.session.recommendedWorkdir}` : '',
    `- resume: ${input.session.resumeCommand}`,
    input.session.summary ? `- summary: ${truncateWorkerContext(input.session.summary, 400)}` : '',
    input.session.detailedSummary ? `- detail: ${truncateWorkerContext(input.session.detailedSummary, 700)}` : '',
    input.session.techStack.length ? `- tech: ${input.session.techStack.slice(0, 12).join(', ')}` : '',
    input.session.keywords.length ? `- keywords: ${input.session.keywords.slice(0, 16).join(', ')}` : '',
    input.session.lastUserMessage ? `- lastUser: ${truncateWorkerContext(input.session.lastUserMessage.text, 500)}` : '',
    input.session.lastAssistantMessage ? `- lastAgent: ${truncateWorkerContext(input.session.lastAssistantMessage.text, 500)}` : '',
    '',
    '执行要求：',
    '- 你是实际执行者，控制面只负责调度和监督。',
    input.policyProfile ? `- 当前权限策略：${input.policyProfile}。如果任务超出权限，停止并说明需要更高授权。` : '',
    '- 先确认当前目录、分支、相关文件和用户未提交改动，再按任务实施；如果 cwd 不是 recommendedWorkdir，先切换到 recommendedWorkdir。',
    '- 需要修改代码时直接修改，运行相关测试或构建验证。',
    '- 不要泄露密钥、token 或历史记录中的敏感内容。',
    ...templateText,
    '- 结束时必须输出以下结构化报告，字段名保持英文且各占一行：',
    'STATUS: completed | failed | blocked | needs_review',
    'CHANGED_FILES: 用逗号分隔改动文件；没有则写 none',
    'TESTS: 用逗号分隔已运行验证；没有则写 not run + 原因',
    'NEXT_ACTION: 下一步建议；没有则写 none',
    '- 结构化报告之前可以用中文总结改动文件、验证结果、失败原因或剩余风险。',
  ]
    .filter(Boolean)
    .join('\n');
}

async function deleteSessionById(id: string) {
  try {
    return await service.deleteSession(id);
  } catch (localError) {
    for (const agent of remoteAgents) {
      try {
        return await deleteAgentSession(agent, id);
      } catch {
        // Try the next remote agent.
      }
    }
    throw localError;
  }
}

async function deleteSessionsByIdsBulk(ids: string[], includeRemote: boolean) {
  const cleanIds = [...new Set(ids)];
  const resultsById = new Map<string, { id: string; ok: boolean; result?: unknown; error?: string }>();
  const local = await service.deleteSessionsBulk(cleanIds);

  for (const item of local.deleted) {
    resultsById.set(item.sessionId, { id: item.sessionId, ok: true, result: item });
  }

  let unresolvedIds = local.missingIds;
  if (includeRemote) {
    for (const agent of remoteAgents) {
      if (!unresolvedIds.length) break;
      try {
        const payload = await deleteAgentSessionsBulk<{
          results?: Array<{ id: string; ok: boolean; result?: unknown; error?: string }>;
        }>(agent, unresolvedIds);
        const deletedOnAgent = new Set<string>();
        for (const item of payload.results ?? []) {
          if (!item.ok) continue;
          deletedOnAgent.add(item.id);
          resultsById.set(item.id, { id: item.id, ok: true, result: item.result });
        }
        unresolvedIds = unresolvedIds.filter((id) => !deletedOnAgent.has(id));
      } catch {
        // Try the next remote agent.
      }
    }
  }

  for (const id of unresolvedIds) {
    resultsById.set(id, { id, ok: false, error: `Session not found: ${id}` });
  }

  return cleanIds.map((id) => resultsById.get(id) ?? { id, ok: false, error: `Session not found: ${id}` });
}

function clearSessionCaches(): void {
  localSessionsCache = null;
  localFastSessionsCache = null;
  remoteSessionsCache = null;
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function publicEvaluationRefreshJob(job: EvaluationRefreshJob): EvaluationRefreshJob {
  return { ...job };
}

function trimEvaluationRefreshJobs(): void {
  const finished = [...evaluationRefreshJobs.values()]
    .filter((job) => job.status === 'completed' || job.status === 'failed')
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt));
  for (const job of finished.slice(100)) {
    evaluationRefreshJobs.delete(job.id);
  }
}

function processEvaluationRefreshQueue(): void {
  const concurrency = readIntEnv('CURATOR_REFRESH_QUEUE_CONCURRENCY', 2, 1, 8);
  while (runningEvaluationRefreshJobs < concurrency && evaluationRefreshQueue.length > 0) {
    const jobId = evaluationRefreshQueue.shift();
    if (!jobId) return;
    const job = evaluationRefreshJobs.get(jobId);
    if (!job || job.status !== 'queued') continue;

    runningEvaluationRefreshJobs += 1;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    void (async () => {
      try {
        const result = await service.refreshSessionEvaluation(job.sessionId, job.reason);
        job.result = result;
        job.status = result.status === 'failed' ? 'failed' : 'completed';
        job.error = result.error ?? null;
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Refresh failed';
      } finally {
        job.completedAt = new Date().toISOString();
        runningEvaluationRefreshJobs = Math.max(0, runningEvaluationRefreshJobs - 1);
        clearSessionCaches();
        trimEvaluationRefreshJobs();
        processEvaluationRefreshQueue();
      }
    })();
  }
}

async function enqueueEvaluationRefresh(sessionId: string, reason: string): Promise<EvaluationRefreshJob> {
  const existing = [...evaluationRefreshJobs.values()].find(
    (job) => job.sessionId === sessionId && (job.status === 'queued' || job.status === 'running')
  );
  if (existing) return existing;

  const job: EvaluationRefreshJob = {
    id: randomUUID(),
    sessionId,
    reason,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
  };
  evaluationRefreshJobs.set(job.id, job);
  evaluationRefreshQueue.push(job.id);
  await service.markSessionEvaluationRefreshQueued(sessionId, reason);
  clearSessionCaches();
  processEvaluationRefreshQueue();
  return job;
}

async function runAutoBackfill(reason: string): Promise<void> {
  if (autoBackfillRunning) return;
  autoBackfillRunning = true;
  try {
    const limit = readIntEnv('CURATOR_AUTO_BACKFILL_LIMIT', 8, 1, 200);
    const includeFailed = process.env.CURATOR_AUTO_BACKFILL_INCLUDE_FAILED === '1';
    const result = await service.backfillEvaluations({ limit, includeFailed });
    if (result.processed > 0) clearSessionCaches();
    app.log.info({ reason, ...result }, 'Auto evaluation backfill completed');
  } catch (error) {
    app.log.warn({ reason, error }, 'Auto evaluation backfill failed');
  } finally {
    autoBackfillRunning = false;
  }
}

async function getLocalSessionsCached(refreshWorkflow: boolean, fast: boolean) {
  if (refreshWorkflow || sessionCacheTtlMs <= 0) {
    clearSessionCaches();
    return service.listSessions({ refreshWorkflow, fast: false });
  }
  const now = Date.now();
  if (fast) {
    if (!localFastSessionsCache || localFastSessionsCache.expiresAt <= now) {
      localFastSessionsCache = {
        expiresAt: now + sessionCacheTtlMs,
        promise: service.listSessions({ refreshWorkflow: false, fast: true }),
      };
    }
    return localFastSessionsCache.promise;
  }
  if (!localSessionsCache || localSessionsCache.expiresAt <= now) {
    localSessionsCache = {
      expiresAt: now + sessionCacheTtlMs,
      promise: service.listSessions({ refreshWorkflow: false }),
    };
  }
  return localSessionsCache.promise;
}

async function getRemoteSessionsCached() {
  if (!remoteAgents.length) return [];
  if (remoteSessionCacheTtlMs <= 0) return (await Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent)))).flat();
  const now = Date.now();
  if (!remoteSessionsCache || remoteSessionsCache.expiresAt <= now) {
    remoteSessionsCache = {
      expiresAt: now + remoteSessionCacheTtlMs,
      promise: Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent))),
    };
  }
  return (await remoteSessionsCache.promise).flat();
}

function orderedRemoteAgents(preferredMachineId?: string | null) {
  const preferred = preferredMachineId?.trim();
  if (!preferred) return remoteAgents;
  return [
    ...remoteAgents.filter((agent) => agent.id === preferred),
    ...remoteAgents.filter((agent) => agent.id !== preferred),
  ];
}

async function findRemoteSession(
  sessionId: string,
  preferredMachineId?: string | null
): Promise<{ agent: (typeof remoteAgents)[number]; session: CodexSession } | null> {
  for (const agent of orderedRemoteAgents(preferredMachineId)) {
    try {
      const payload = await fetchAgentJson<{ sessions?: CodexSession[] }>(
        agent,
        `/api/hermes/session-index?q=${encodeURIComponent(sessionId)}&limit=10&remote=0`
      );
      const session = (payload.sessions ?? []).find((candidate) => candidate.id === sessionId);
      if (!session) continue;
      return { agent, session: { ...session, machineId: session.machineId || agent.id } };
    } catch {
      // Try the next remote agent.
    }
  }
  return null;
}

function shouldPreferRemoteSession(localSession: CodexSession | null, remoteSession: CodexSession): boolean {
  if (!localSession) return true;
  const localMachineId = service.getMeta().machineId;
  return Boolean(remoteSession.machineId && remoteSession.machineId !== localMachineId);
}

async function fetchRemoteJobRegistryCached(agent: (typeof remoteAgents)[number]): Promise<{
  jobs: Array<{ machineId: string; baseUrl: string | null; job: CodexResumeJob }>;
  health: { machineId: string; baseUrl: string; healthy: boolean; updatedAt: string; cached: boolean; error: string | null };
}> {
  const ttlMs = readIntEnv('CURATOR_REMOTE_JOB_REGISTRY_TTL_MS', 10_000, 0, 300_000);
  const now = Date.now();
  const cached = remoteJobRegistryCache.get(agent.id);
  if (cached && ttlMs > 0 && cached.expiresAt > now) {
    return {
      jobs: cached.jobs,
      health: {
        machineId: agent.id,
        baseUrl: agent.baseUrl,
        healthy: cached.healthy,
        updatedAt: cached.updatedAt,
        cached: true,
        error: cached.error,
      },
    };
  }

  try {
    const payload = await fetchAgentJson<{
      jobs?: Array<{ machineId?: string; baseUrl?: string | null; job?: CodexResumeJob }>;
    }>(agent, '/api/hermes/job-registry?remote=0');
    const jobs = (payload.jobs ?? [])
      .filter((item) => item.job)
      .map((item) => ({
        machineId: item.machineId || item.job?.machineId || agent.id,
        baseUrl: item.baseUrl ?? agent.baseUrl,
        job: item.job as CodexResumeJob,
      }));
    const updatedAt = new Date().toISOString();
    remoteJobRegistryCache.set(agent.id, {
      expiresAt: now + ttlMs,
      updatedAt,
      healthy: true,
      jobs,
      error: null,
    });
    return {
      jobs,
      health: { machineId: agent.id, baseUrl: agent.baseUrl, healthy: true, updatedAt, cached: false, error: null },
    };
  } catch (error) {
    try {
      const fallback = await fetchAgentJson<{ jobs?: CodexResumeJob[] }>(agent, '/api/hermes/jobs');
      const jobs = (fallback.jobs ?? []).map((job) => ({ machineId: job.machineId || agent.id, baseUrl: agent.baseUrl, job }));
      const updatedAt = new Date().toISOString();
      remoteJobRegistryCache.set(agent.id, {
        expiresAt: now + ttlMs,
        updatedAt,
        healthy: true,
        jobs,
        error: null,
      });
      return {
        jobs,
        health: { machineId: agent.id, baseUrl: agent.baseUrl, healthy: true, updatedAt, cached: false, error: null },
      };
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : error instanceof Error ? error.message : 'remote failed';
      if (cached) {
        remoteJobRegistryCache.set(agent.id, {
          ...cached,
          expiresAt: now + Math.min(ttlMs || 10_000, 60_000),
          healthy: false,
          error: message,
        });
        return {
          jobs: cached.jobs,
          health: {
            machineId: agent.id,
            baseUrl: agent.baseUrl,
            healthy: false,
            updatedAt: cached.updatedAt,
            cached: true,
            error: message,
          },
        };
      }
      return {
        jobs: [],
        health: {
          machineId: agent.id,
          baseUrl: agent.baseUrl,
          healthy: false,
          updatedAt: new Date().toISOString(),
          cached: false,
          error: message,
        },
      };
    }
  }
}

function codexJobMode(input: CodexJobMode | undefined): CodexJobMode {
  return input ?? (process.env.CURATOR_CODEX_JOB_MODE === 'pty' ? 'pty' : 'exec');
}

type SupervisorStrategy = z.infer<typeof supervisorStrategySchema>;
type PolicyProfile = NonNullable<z.infer<typeof policyProfileSchema>>;

function hermesJobMode(input: CodexJobMode | undefined): CodexJobMode {
  if (input) return input;
  const configured = process.env.CURATOR_HERMES_DEFAULT_JOB_MODE || process.env.CURATOR_CODEX_JOB_MODE;
  if (configured === 'exec' || configured === 'pty') return configured;
  return 'pty';
}

function policyForProfile(profile: PolicyProfile | undefined, cwd?: string | null): Record<string, unknown> {
  const allowedCwds = cwd ? [cwd] : [];
  const base = {
    profile: profile ?? 'code_edit',
    allowDeploy: false,
    allowDeletes: false,
    autoStop: true,
    maxRuntimeMs: defaultHermesMaxRuntimeMs,
    allowedCwds,
  };
  if (profile === 'read_only') {
    return {
      ...base,
      blockedCommands: ['apply_patch', 'writeFileSync', 'npm install', 'pnpm install', 'git commit', 'git push'],
    };
  }
  if (profile === 'test_only') {
    return {
      ...base,
      blockedCommands: ['apply_patch', 'writeFileSync', 'git commit', 'git push', 'npm publish'],
    };
  }
  if (profile === 'deploy_allowed') {
    return { ...base, allowDeploy: true };
  }
  if (profile === 'dangerous_ops_allowed') {
    return { ...base, allowDeploy: true, allowDeletes: true };
  }
  return base;
}

function mergeJobPolicy(profile: PolicyProfile | undefined, explicitPolicy: Record<string, unknown> | undefined, cwd?: string | null) {
  return {
    ...policyForProfile(profile, cwd),
    ...(explicitPolicy ?? {}),
  };
}

function isSupervisorStrategy(value: boolean | SupervisorStrategy | undefined): value is SupervisorStrategy {
  return typeof value === 'object' && value !== null;
}

function supervisorEnabled(value: boolean | SupervisorStrategy | undefined): boolean {
  return isSupervisorStrategy(value) ? true : value ?? true;
}

function supervisorStrategy(value: boolean | SupervisorStrategy | undefined): SupervisorStrategy | undefined {
  const defaults: SupervisorStrategy = {
    autoStop: true,
    autoRetry: false,
    staleOutputMs: defaultHermesStaleOutputMs,
    idleTimeoutMs: defaultHermesStaleOutputMs,
  };
  if (value === false) return defaults;
  return isSupervisorStrategy(value)
    ? { ...defaults, ...value, idleTimeoutMs: value.staleOutputMs ?? value.idleTimeoutMs ?? defaults.idleTimeoutMs }
    : defaults;
}

function compactJobForEvents(job: CodexResumeJob): CodexResumeJob {
  const maxTailBytes = readIntEnv('CURATOR_JOB_EVENTS_RESPONSE_TAIL_BYTES', 32 * 1024, 1024, 256 * 1024);
  const outputTail =
    Buffer.byteLength(job.outputTail) <= maxTailBytes
      ? job.outputTail
      : Buffer.from(job.outputTail).subarray(-maxTailBytes).toString('utf8');
  return { ...job, outputTail };
}

function auditMeta(request: FastifyRequest): Record<string, unknown> {
  const auth = authState(request);
  return {
    actor: auth.user ?? 'admin-token',
    source: request.headers['x-curator-source'] ?? request.headers['user-agent'] ?? 'api',
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

async function recordJobFailureCard(job: CodexResumeJob, reason: string): Promise<void> {
  if (job.status === 'completed') return;
  await service.appendFailureKnowledgeCard({
    sessionId: job.sessionId,
    jobId: job.id,
    error: job.error ?? reason,
    outputTail: job.outputTail,
    policyViolations: job.policyState?.violations ?? [],
  });
  clearSessionCaches();
}

function jobOutcomeFromJob(job: CodexResumeJob, goal: string) {
  const report = job.structuredReport;
  const tests = report?.tests?.length ? report.tests : [];
  const changedFiles = report?.changedFiles?.length ? report.changedFiles : job.changedFiles;
  const failureReason = job.status === 'completed' ? null : job.error ?? job.supervisor?.lastReason ?? 'worker 未成功完成';
  const needsReview =
    job.status !== 'completed' ||
    !report ||
    /failed|blocked|needs_review/i.test(report.status ?? '') ||
    tests.length === 0 ||
    tests.some((test) => /not run|未运行|failed/i.test(test));
  return {
    id: `${job.id}:${job.completedAt ?? job.updatedAt}`,
    at: job.completedAt ?? job.updatedAt,
    jobId: job.id,
    sessionId: job.sessionId,
    machineId: job.machineId,
    status: job.status,
    mode: job.mode,
    goal: goal.slice(0, 1200),
    cwd: job.cwd ?? null,
    changedFiles,
    tests,
    nextAction: report?.nextAction ?? null,
    failureReason,
    needsReview,
    summary: [
      `目标：${goal.slice(0, 220)}`,
      `状态：${job.status}`,
      changedFiles.length ? `改动：${changedFiles.slice(0, 8).join(', ')}` : '改动：none',
      tests.length ? `验证：${tests.slice(0, 6).join(', ')}` : '验证：not run',
      failureReason ? `失败/风险：${failureReason.slice(0, 220)}` : '',
    ].filter(Boolean).join('；'),
  };
}

async function recordJobOutcome(job: CodexResumeJob, goal: string): Promise<void> {
  await service.appendJobOutcome(jobOutcomeFromJob(job, goal));
  clearSessionCaches();
}

async function finalizeJobFacts(job: CodexResumeJob, goal: string, reason: string): Promise<void> {
  await Promise.all([
    recordJobOutcome(job, goal),
    recordJobFailureCard(job, reason),
  ]);
}

await service.cleanupRecycleBin();
setInterval(
  () => {
    void service.cleanupRecycleBin().catch((error) => {
      app.log.warn({ error }, 'Recycle cleanup failed');
    });
  },
  6 * 60 * 60 * 1000
).unref();

const autoBackfillIntervalMs = readIntEnv('CURATOR_AUTO_BACKFILL_INTERVAL_MS', 0, 0, 24 * 60 * 60 * 1000);
if (autoBackfillIntervalMs > 0) {
  const initialDelayMs = readIntEnv('CURATOR_AUTO_BACKFILL_INITIAL_DELAY_MS', 30_000, 5_000, autoBackfillIntervalMs);
  setTimeout(() => void runAutoBackfill('startup'), initialDelayMs).unref();
  setInterval(() => void runAutoBackfill('interval'), autoBackfillIntervalMs).unref();
  app.log.info(
    {
      intervalMs: autoBackfillIntervalMs,
      initialDelayMs,
      limit: readIntEnv('CURATOR_AUTO_BACKFILL_LIMIT', 8, 1, 200),
      includeFailed: process.env.CURATOR_AUTO_BACKFILL_INCLUDE_FAILED === '1',
    },
    'Auto evaluation backfill enabled',
  );
}

async function refreshSupervisorSessionCache(): Promise<void> {
  try {
    supervisorSessionCache = await getStateSessionsForHermes();
  } catch (error) {
    app.log.warn({ error }, 'Supervisor session cache refresh failed');
  }
}

await refreshSupervisorSessionCache();
setInterval(() => void refreshSupervisorSessionCache(), 60_000).unref();
const semanticSupervisorCheckedAt = new Map<string, number>();
startCodexSupervisorLoop({
  intervalMs: readIntEnv('CURATOR_CODEX_SUPERVISOR_INTERVAL_MS', 30_000, 1_000, 3_600_000),
  idleTimeoutMs: readIntEnv('CURATOR_CODEX_SUPERVISOR_IDLE_MS', 10 * 60_000, 10_000, 86_400_000),
  autoStop: process.env.CURATOR_CODEX_SUPERVISOR_AUTO_STOP === '1',
  autoRetry: process.env.CURATOR_CODEX_SUPERVISOR_AUTO_RETRY === '1',
  maxRetries: readIntEnv('CURATOR_CODEX_SUPERVISOR_MAX_RETRIES', 1, 0, 10),
  restart: (previousJob, prompt) => {
    const session = supervisorSessionCache.find((item) => item.id === previousJob.sessionId);
    if (!session) throw new Error(`Supervisor retry session not found: ${previousJob.sessionId}`);
    return startCodexResumeJob({
      session,
      prompt,
      mode: previousJob.mode,
      supervisor: {
        enabled: previousJob.supervisor.enabled,
        autoStop: previousJob.supervisor.autoStop,
        autoRetry: previousJob.supervisor.autoRetry,
        idleTimeoutMs: previousJob.supervisor.idleTimeoutMs ?? undefined,
        maxRetries: previousJob.supervisor.maxRetries ?? undefined,
      },
      policy: previousJob.policy,
      onExit: (completedJob: CodexResumeJob) => {
        void finalizeJobFacts(completedJob, prompt, 'supervisor loop job finished').catch((error) => {
          app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
        });
        void enqueueEvaluationRefresh(completedJob.sessionId, `supervisor-loop:${completedJob.id}:${completedJob.status}`).catch((error) => {
          app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Supervisor loop evaluation refresh enqueue failed');
        });
      },
    });
  },
});
app.log.info({ intervalMs: readIntEnv('CURATOR_CODEX_SUPERVISOR_INTERVAL_MS', 30_000, 1_000, 3_600_000) }, 'Codex supervisor loop enabled');

const semanticSupervisorIntervalMs = readIntEnv('CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS', 0, 0, 3_600_000);
if (semanticSupervisorIntervalMs > 0 || process.env.CURATOR_CODEX_SEMANTIC_SUPERVISOR === '1') {
  const intervalMs = semanticSupervisorIntervalMs || 120_000;
  setInterval(() => {
    void (async () => {
      for (const job of listCodexResumeJobs()) {
        if (job.status !== 'running' || !job.supervisor?.enabled) continue;
        const last = semanticSupervisorCheckedAt.get(job.id) ?? 0;
        if (Date.now() - last < intervalMs) continue;
        semanticSupervisorCheckedAt.set(job.id, Date.now());
        const semantic = await evaluateJobSemantics({
          job,
          events: listCodexJobEvents(job.id, Math.max(0, (job.eventSeq ?? 0) - 80)),
          policy: job.policy,
        });
        if (!semantic) continue;
        recordCodexJobAudit(job.id, 'semantic-supervisor-loop', {
          decision: semantic.decision,
          reason: semantic.reason,
          confidence: semantic.confidence,
        });
        if (semantic.decision === 'needs_guidance' && semantic.guidance && job.mode === 'pty') {
          sendCodexJobGuidance(job.id, semantic.guidance, 'supervisor');
        }
        if ((semantic.decision === 'stop' || semantic.decision === 'failed') && job.supervisor.autoStop) {
          const stopped = stopCodexResumeJob(job.id);
          if (stopped) await finalizeJobFacts(stopped, stopped.prompt, semantic.reason);
        }
      }
    })().catch((error) => {
      app.log.warn({ error }, 'Semantic supervisor loop failed');
    });
  }, intervalMs).unref();
  app.log.info({ intervalMs }, 'Semantic Codex supervisor loop enabled');
}

await app.register(cors, { origin: true });
await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] });
await app.register(websocket);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
  done(null, body);
});

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isHttpsRequest(request: FastifyRequest): boolean {
  return request.headers['x-forwarded-proto'] === 'https' || request.headers['cf-visitor']?.includes('https') === true;
}

function authCookie(value: string, request: FastifyRequest, maxAge = 2_592_000): string {
  const secure = isHttpsRequest(request) ? ' Secure;' : '';
  return `curator_admin=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secure}`;
}

function authState(request: FastifyRequest): {
  enabled: boolean;
  authenticated: boolean;
  user: string | null;
  token: string | null;
} {
  const authUser = process.env.CURATOR_AUTH_USER;
  const authPassword = process.env.CURATOR_AUTH_PASSWORD;
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (!authUser || !authPassword || !adminToken) {
    return { enabled: false, authenticated: true, user: null, token: adminToken ?? null };
  }

  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.searchParams.get('admin_token') === adminToken) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }

  const cookies = parseCookies(request.headers.cookie);
  if (cookies.curator_admin === adminToken) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }

  const header = request.headers.authorization;
  const expected = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
  if (header === expected) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }

  return { enabled: true, authenticated: false, user: null, token: adminToken };
}

app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/assets/')) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
  if (request.url === '/' || request.url.startsWith('/?')) {
    reply.header('Cache-Control', 'no-cache');
  }
  return payload;
});

app.addHook('onRequest', async (request, reply) => {
  const auth = authState(request);
  if (!auth.enabled) return;

  const url = new URL(request.url, 'http://127.0.0.1');
  const isAuthRoute = url.pathname === '/api/auth/status' || url.pathname === '/api/auth/login' || url.pathname === '/api/auth/logout';
  const isAsset = url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico';
  const isPage = request.method === 'GET' && !url.pathname.startsWith('/api/') && !request.headers.upgrade;
  if (isAuthRoute || isAsset || isPage) {
    const adminToken = process.env.CURATOR_ADMIN_TOKEN;
    if (adminToken && url.searchParams.get('admin_token') === adminToken) {
      url.searchParams.delete('admin_token');
      reply.header('Set-Cookie', authCookie(adminToken, request));
      if (request.method === 'GET' && url.pathname === '/' && !request.headers.upgrade) {
        await reply.redirect(`${url.pathname}${url.search}${url.hash}` || '/');
        return;
      }
    }
    return;
  }

  const requestToken = url.searchParams.get('admin_token');
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (adminToken && requestToken === adminToken) {
    url.searchParams.delete('admin_token');
    const cleanPath = `${url.pathname}${url.search}${url.hash}`;
    reply.header('Set-Cookie', authCookie(adminToken, request));
    if (request.method === 'GET' && url.pathname === '/' && !request.headers.upgrade) {
      await reply.redirect(cleanPath || '/');
      return;
    }
    return;
  }

  if (auth.authenticated) return;

  await reply.code(401).send({ error: 'Authentication required' });
});

app.get('/api/auth/status', async (request) => {
  const auth = authState(request);
  return {
    enabled: auth.enabled,
    authenticated: auth.authenticated,
    user: auth.authenticated ? auth.user : null,
    tokenLogin: Boolean(process.env.CURATOR_ADMIN_TOKEN),
  };
});

app.post('/api/auth/login', async (request, reply) => {
  const authUser = process.env.CURATOR_AUTH_USER;
  const authPassword = process.env.CURATOR_AUTH_PASSWORD;
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (!authUser || !authPassword || !adminToken) {
    return { ok: true, authenticated: true, user: null };
  }

  const body = loginSchema.parse(request.body);
  if (body.username !== authUser || body.password !== authPassword) {
    return reply.code(401).send({ error: 'Invalid username or password' });
  }
  reply.header('Set-Cookie', authCookie(adminToken, request));
  return { ok: true, authenticated: true, user: authUser };
});

app.post('/api/auth/logout', async (request, reply) => {
  reply.header('Set-Cookie', authCookie('', request, 0));
  return { ok: true };
});

app.all('/api/codex/*', async (request, reply) => {
  const targetUrl = request.url.replace(/^\/api\/codex(?=\/|$)/, '/api/hermes');
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers = Object.fromEntries(
    Object.entries({
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      'content-type': payload ? 'application/json' : request.headers['content-type'],
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const injected = await app.inject({
    method: request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD',
    url: targetUrl,
    payload,
    headers,
  });
  const responseHeaders = injected.headers as Record<string, string | string[] | undefined>;
  const contentType = responseHeaders['content-type'];
  if (contentType) reply.header('content-type', contentType);
  return reply.code(injected.statusCode).send(injected.body);
});

app.get('/api/meta', async () => service.getMeta());

app.get('/api/analysis-runs', async () => {
  const records = await readAnalysisRuns(160);
  const now = Date.now();
  const lastHourRecords = records.filter((record) => now - Date.parse(record.timestamp) <= 60 * 60_000);
  return {
    provider: getEvaluatorProvider(),
    model: getEvaluatorModel(),
    baseUrl: getEvaluatorBaseUrl(),
    rpmLimit: getEvaluatorRpmLimit(),
    concurrency: getRecommendedEvaluationConcurrency(),
    records: records.slice(-40).reverse(),
    lastMinute: records.filter((record) => now - Date.parse(record.timestamp) <= 60_000).length,
    lastHour: lastHourRecords.length,
    successLastHour: lastHourRecords.filter((record) => record.status === 'ok').length,
    failedLastHour: lastHourRecords.filter((record) => record.status === 'failed').length,
  };
});

function includeDeprecated(query: z.infer<typeof includeDeprecatedSchema>): boolean {
  return query.includeDeprecated === '1' || query.includeDeprecated === 'true';
}

app.get('/api/server-identity/machines', async (request, reply) => {
  const query = includeDeprecatedSchema.parse(request.query);
  try {
    return { machines: await listServerIdentityMachines(includeDeprecated(query)) };
  } catch (error) {
    request.log.error({ error }, 'server identity list failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity list failed' });
  }
});

app.get('/api/server-identity/machines/:alias', async (request, reply) => {
  const params = serverIdentityAliasSchema.parse(request.params);
  try {
    const machine = await getServerIdentityMachine(params.alias);
    if (!machine) return reply.code(404).send({ error: 'Machine not found' });
    return { machine };
  } catch (error) {
    request.log.error({ error, alias: params.alias }, 'server identity get failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity get failed' });
  }
});

app.post('/api/server-identity/machines', async (request, reply) => {
  const body = serverIdentityMachineSchema.parse(request.body ?? {});
  try {
    return reply.code(201).send({ machine: await upsertServerIdentityMachine(body) });
  } catch (error) {
    request.log.error({ error, alias: body.alias }, 'server identity upsert failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity upsert failed' });
  }
});

app.patch('/api/server-identity/machines/:alias', async (request, reply) => {
  const params = serverIdentityAliasSchema.parse(request.params);
  const body = serverIdentityPatchSchema.parse(request.body ?? {});
  try {
    const machine = await patchServerIdentityMachine(params.alias, body);
    if (!machine) return reply.code(404).send({ error: 'Machine not found' });
    return { machine };
  } catch (error) {
    request.log.error({ error, alias: params.alias }, 'server identity patch failed');
    const message = error instanceof Error ? error.message : 'Server identity patch failed';
    return reply.code(message.includes('alias cannot be changed') ? 400 : 500).send({ error: message });
  }
});

app.post('/api/server-identity/export', async (request, reply) => {
  const body = includeDeprecatedSchema.parse(request.body ?? {});
  try {
    return await exportServerIdentityInventory(includeDeprecated(body));
  } catch (error) {
    request.log.error({ error }, 'server identity export failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity export failed' });
  }
});

app.get('/api/server-identity/ssh-config', async (request, reply) => {
  const query = includeDeprecatedSchema.parse(request.query);
  try {
    return reply.type('text/plain; charset=utf-8').send(await renderServerIdentitySshConfig(includeDeprecated(query)));
  } catch (error) {
    request.log.error({ error }, 'server identity ssh config render failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity SSH config render failed' });
  }
});

app.get('/api/hermes/search', async (request) => {
  const query = hermesSearchSchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const limit = query.limit ?? 5;
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote ? await getRemoteSessionsCached() : [];
  const sessions = [...localSessions, ...remoteSessions]
    .map((session) => ({ session, score: scoreHermesMatch(session, query.q) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''))
    .slice(0, limit)
    .map((item) => toHermesSession(item.session, query.q));

  return {
    query: query.q,
    sessions,
    count: sessions.length,
    memoryContext: buildHermesMemoryContext(sessions),
  };
});

app.get('/api/hermes/session-index', async (request) => {
  const query = hermesSessionIndexSchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote ? await getRemoteSessionsCached() : [];
  const needle = query.q?.trim() ?? '';
  const scored = [...localSessions, ...remoteSessions]
    .map((session) => ({ session, score: needle ? scoreHermesMatch(session, needle) : session.evaluation.score }))
    .filter((item) => !needle || item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''));
  const limit = query.limit ?? 200;
  const sessions = scored.slice(0, limit).map((item) => toHermesSessionIndexEntry(item.session, needle));
  return {
    query: needle,
    count: sessions.length,
    total: scored.length,
    resumePolicy: {
      defaultAction: 'resume-matched-session',
      createChildSessionOnlyWhen: [
        'no indexed session matches the requested project or task context',
        'the user explicitly asks for a new session',
      ],
    },
    sessions,
  };
});

app.get('/api/hermes/search-documents', async (request) => {
  const query = z
    .object({
      q: z.string().max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      remote: z.enum(['0', '1', 'true', 'false']).optional(),
    })
    .parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote ? await getRemoteSessionsCached() : [];
  const needle = query.q?.toLowerCase().trim() ?? '';
  const documents = [...localSessions, ...remoteSessions]
    .flatMap(buildHermesSearchDocuments)
    .map((document) => ({
      ...document,
      score: scoreDocumentMatch(
        {
          id: document.id,
          title: document.title,
          text: document.text,
          machineId: document.machineId,
          sessionId: 'sessionId' in document ? document.sessionId : null,
        },
        needle
      ),
    }))
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
    .slice(0, query.limit ?? 50);
  return {
    query: query.q ?? '',
    count: documents.length,
    documents,
  };
});

app.get('/api/codex/sessions/:id/context', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionContextSchema.parse(request.query);
  const historyLimit = query.historyLimit ?? 20;
  const localSession = (await getStateSessionsForHermes()).find((session) => session.id === params.id) ?? null;
  if (!localSession) {
    for (const agent of remoteAgents) {
      try {
        return await fetchAgentJson(
          agent,
          `/api/codex/sessions/${encodeURIComponent(params.id)}/context?historyLimit=${historyLimit}`
        );
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Session not found' });
  }

  const history = historyLimit > 0
    ? await parseSessionHistory({ filePath: localSession.filePath, limit: historyLimit })
    : { messages: [], nextBefore: null, hasMore: false };
  const session = toHermesSession(localSession);
  const contextText = [
    `# ${session.title}`,
    `- id: ${session.id}`,
    `- machine: ${session.machineId}`,
    `- cwd: ${session.cwd ?? 'unknown'}`,
    `- resume: ${session.resumeCommand}`,
    `- recommendation: ${session.recommendation}`,
    '',
    session.summary,
    session.detailedSummary ? `\n${session.detailedSummary}` : '',
    history.messages.length ? '\n## Recent history' : '',
    ...history.messages.map((message) => `- ${message.role}: ${message.text}`),
  ]
    .filter(Boolean)
    .join('\n');

  return { session, history, contextText };
});

app.get('/api/hermes/sessions/:id/context', async (_request, reply) => {
  return reply.code(410).send({
    error: 'Hermes session context endpoint has been retired. Use /api/codex/sessions/:id/context.',
  });
});

app.post('/api/hermes/jobs/resume', async (request, reply) => {
  const body = resumeJobSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const foundSession = (await getStateSessionsForHermes()).find((item) => item.id === body.sessionId) ?? null;
  const session = foundSession ? withEffectiveJobCwd(foundSession) : null;
  if (!session) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await postAgentJson(agent, '/api/hermes/jobs/resume?remote=0', body);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Session not found' });
  }

  const resumePrompt = buildCodexWorkerPrompt({
    query: body.prompt,
    prompt: body.prompt,
    session: toHermesSession(session),
    template: body.template,
    policyProfile: body.policyProfile,
  });
  const startInput = {
    session,
    prompt: resumePrompt,
    model: body.model,
    extraArgs: body.extraArgs,
    mode: hermesJobMode(body.mode),
    supervisor: supervisorEnabled(body.supervisor),
    supervisorStrategy: supervisorStrategy(body.supervisor),
    policy: mergeJobPolicy(body.policyProfile, body.policy, session.cwd),
    onExit: (completedJob: CodexResumeJob) => {
      void finalizeJobFacts(completedJob, body.prompt, 'resume job finished').catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
      });
      void enqueueEvaluationRefresh(completedJob.sessionId, `job:${completedJob.id}:${completedJob.status}`).catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Hermes job evaluation refresh enqueue failed');
      });
    },
  };
  const job = startCodexResumeJob(startInput);
  await service.markHermesSessionUsed(session.id, job.id);
  clearSessionCaches();
  return { job };
});

app.post('/api/hermes/dispatch', async (request, reply) => {
  const body = hermesDispatchSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const limit = body.limit ?? 5;
  const threshold = body.requireConfirmationBelowScore ?? 10;
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = allowRemote ? await getRemoteSessionsCached() : [];
  const localIds = new Set(localSessions.map((session) => session.id));
  const allSessions = [...localSessions, ...remoteSessions];

  const scored = allSessions
    .map((session) => ({ session, score: body.sessionId === session.id ? 10_000 : scoreHermesMatch(session, body.query) }))
    .filter((item) => (body.sessionId ? item.session.id === body.sessionId : item.score > 0))
    .sort((a, b) => b.score - a.score || Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''));
  const candidates = scored.slice(0, limit).map((item) => toHermesSession(item.session, body.query));
  const selected = candidates[0] ?? null;

  if (!selected) {
    return {
      status: 'needs_selection',
      reason: body.sessionId ? `Session not found: ${body.sessionId}` : 'No relevant Codex session matched the request.',
      query: body.query,
      candidates: [],
    };
  }

  if (!body.sessionId && selected.score < threshold) {
    return {
      status: 'needs_selection',
      reason: `Best match score ${selected.score} is below confirmation threshold ${threshold}.`,
      query: body.query,
      selectedSession: selected,
      candidates,
    };
  }

  const selectedForJob = withEffectiveHermesSessionCwd(selected);
  const workerPrompt = buildCodexWorkerPrompt({
    query: body.query,
    prompt: body.prompt,
    session: selectedForJob,
    template: body.template,
    policyProfile: body.policyProfile,
  });

  if (!localIds.has(selected.id)) {
    if (!allowRemote) {
      return reply.code(404).send({ error: 'Selected session is not local and remote dispatch is disabled' });
    }
    const matchingAgents = [
      ...remoteAgents.filter((agent) => agent.id === selected.machineId),
      ...remoteAgents.filter((agent) => agent.id !== selected.machineId),
    ];
    for (const agent of matchingAgents) {
      try {
        const remotePayload = await postAgentJson<{
          job?: unknown;
        }>(agent, '/api/hermes/jobs/resume?remote=0', {
          sessionId: selected.id,
          prompt: body.prompt ?? body.query,
          mode: hermesJobMode(body.mode),
          supervisor: body.supervisor === false ? false : supervisorStrategy(body.supervisor),
          policy: mergeJobPolicy(body.policyProfile, body.policy, selectedForJob.cwd),
        });
        return {
          status: 'started',
          ...remotePayload,
          routedTo: agent.id,
          query: body.query,
          selectedSession: selected,
          candidates,
          nextAction: remotePayload.job && typeof remotePayload.job === 'object' && 'id' in remotePayload.job
            ? `Poll /api/hermes/jobs/${String((remotePayload.job as { id?: unknown }).id)} until status is completed, failed, or stopped.`
            : 'Poll the remote job registry for completion.',
        };
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(502).send({ error: `Failed to dispatch session ${selected.id} to remote agent` });
  }

  const localSession = localSessions.find((session) => session.id === selected.id);
  if (!localSession) return reply.code(404).send({ error: 'Selected local session not found' });
  const jobSession = withEffectiveJobCwd(localSession);
  const startInput = {
    session: jobSession,
    prompt: workerPrompt,
    model: body.model,
    extraArgs: body.extraArgs,
    mode: hermesJobMode(body.mode),
    supervisor: supervisorEnabled(body.supervisor),
    supervisorStrategy: supervisorStrategy(body.supervisor),
    policy: mergeJobPolicy(body.policyProfile, body.policy, jobSession.cwd),
    onExit: (completedJob: CodexResumeJob) => {
      void finalizeJobFacts(completedJob, body.prompt ?? body.query, 'dispatch job finished').catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
      });
      void enqueueEvaluationRefresh(completedJob.sessionId, `dispatch:${completedJob.id}:${completedJob.status}`).catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Hermes dispatch evaluation refresh enqueue failed');
      });
    },
  };
  const job = startCodexResumeJob(startInput);
  await service.markHermesSessionUsed(localSession.id, job.id);
  clearSessionCaches();

  return {
    status: 'started',
    query: body.query,
    selectedSession: selected,
    candidates,
    job,
    nextAction: `Poll /api/hermes/jobs/${job.id} until status is completed, failed, or stopped.`,
  };
});

app.get('/api/hermes/jobs', async () => ({ jobs: listCodexResumeJobs() }));

app.get('/api/hermes/job-registry', async (request) => {
  const query = remoteControlSchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const meta = service.getMeta();
  const jobs: Array<{ machineId: string; baseUrl: string | null; job: CodexResumeJob }> = listCodexResumeJobs().map((job) => ({
    machineId: job.machineId || meta.machineId,
    baseUrl: null,
    job,
  }));
  const errors: Array<{ machineId: string; baseUrl: string; error: string }> = [];
  const health: Array<{ machineId: string; baseUrl: string; healthy: boolean; updatedAt: string; cached: boolean; error: string | null }> = [];

  if (includeRemote) {
    for (const agent of remoteAgents) {
      const remote = await fetchRemoteJobRegistryCached(agent);
      jobs.push(...remote.jobs);
      health.push(remote.health);
      if (remote.health.error) errors.push({ machineId: agent.id, baseUrl: agent.baseUrl, error: remote.health.error });
    }
  }

  return {
    machineId: meta.machineId,
    baseUrl: null,
    jobs,
    count: jobs.length,
    health,
    errors,
  };
});

app.get('/api/hermes/jobs/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const job = getCodexResumeJob(params.id);
  if (!job) {
    for (const agent of remoteAgents) {
      try {
        return await fetchAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}`);
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  return { job };
});

app.get('/api/hermes/jobs/:id/outcome', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const liveJob = getCodexResumeJob(params.id);
  if (liveJob) {
    return {
      jobId: params.id,
      sessionId: liveJob.sessionId,
      outcome: jobOutcomeFromJob(liveJob, liveJob.prompt),
      job: liveJob,
    };
  }
  const stored = await service.findJobOutcome(params.id);
  if (!stored) {
    for (const agent of remoteAgents) {
      try {
        return await fetchAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/outcome`);
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Job outcome not found' });
  }
  return { jobId: params.id, ...stored };
});

app.get('/api/sessions/:id/outcome', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const outcome = await service.getSessionOutcome(params.id);
  if (!outcome) {
    for (const agent of remoteAgents) {
      try {
        return await fetchAgentJson(agent, `/api/sessions/${encodeURIComponent(params.id)}/outcome`);
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Session outcome not found' });
  }
  return outcome;
});

app.get('/api/hermes/jobs/:id/events', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = jobEventsQuerySchema.parse(request.query);
  const afterSeq = query.afterSeq ?? 0;
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const job = getCodexResumeJob(params.id);
  if (!job) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await fetchAgentJson(
            agent,
            `/api/hermes/jobs/${encodeURIComponent(params.id)}/events?afterSeq=${afterSeq}&remote=0`
          );
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  const events = listCodexJobEvents(params.id, afterSeq);
  return {
    jobId: params.id,
    afterSeq,
    nextSeq: events.reduce((max, event) => Math.max(max, event.seq + 1), afterSeq + 1),
    events,
    job: compactJobForEvents(job),
  };
});

app.get('/api/hermes/jobs/:id/events/stream', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = jobEventsQuerySchema.parse(request.query);
  const job = getCodexResumeJob(params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });

  let afterSeq = query.afterSeq ?? 0;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ jobId: params.id, afterSeq })}\n\n`);

  const send = (): void => {
    const current = getCodexResumeJob(params.id);
    if (!current) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
      clearInterval(timer);
      reply.raw.end();
      return;
    }
    const events = listCodexJobEvents(params.id, afterSeq);
    for (const event of events) {
      afterSeq = Math.max(afterSeq, event.seq);
      reply.raw.write(`event: job-event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString(), status: current.status, afterSeq })}\n\n`);
    if (current.status !== 'running') {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ job: compactJobForEvents(current), afterSeq })}\n\n`);
      clearInterval(timer);
      reply.raw.end();
    }
  };
  const timer = setInterval(send, readIntEnv('CURATOR_JOB_EVENTS_STREAM_INTERVAL_MS', 1000, 250, 10_000));
  request.raw.on('close', () => clearInterval(timer));
  send();
  return reply;
});

app.post('/api/hermes/jobs/:id/stop', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const job = stopCodexResumeJob(params.id);
  if (!job) {
    for (const agent of remoteAgents) {
      try {
        return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/stop`, {});
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  recordCodexJobAudit(params.id, 'stop', auditMeta(request));
  await finalizeJobFacts(job, job.prompt, 'job stopped by API');
  return { job };
});

app.post('/api/hermes/jobs/:id/protocol', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = jobProtocolSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const localJob = getCodexResumeJob(params.id);
  if (!localJob) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/protocol?remote=0`, body);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }

  const protocolText = body.text.trim() || {
    continue: '继续当前任务，按既定目标完成并报告验证结果。',
    summarize: '请总结当前进展、已修改文件、验证结果和剩余风险。',
    handoff: '请输出结构化交接报告，包括上下文、已完成事项、未完成事项、命令结果和下一步。',
    verify: '请运行或说明最相关的验证，并报告结果。',
    pause: '请暂停当前操作，保留上下文，等待下一条继续或指导指令。',
    guide: '',
  }[body.kind];
  if (!protocolText) return reply.code(400).send({ error: 'Protocol text is required for guide' });

  const result = sendCodexJobProtocolMessage(params.id, body.kind as CodexJobProtocolKind, protocolText);
  if (!result) return reply.code(404).send({ error: 'Job not found' });
  recordCodexJobAudit(params.id, `protocol:${body.kind}`, {
    ...auditMeta(request),
    kind: body.kind,
    text: protocolText.slice(0, 1000),
  });
  return {
    kind: body.kind,
    action: result.injected ? 'guided' : 'recorded',
    injected: result.injected,
    error: result.error,
    event: result.event,
    job: result.job,
  };
});

app.post('/api/hermes/jobs/:id/guidance', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = jobGuidanceSchema.parse(request.body ?? {});
  const job = sendCodexJobGuidance(params.id, body.text, body.source ?? 'hermes');
  if (!job) {
    for (const agent of remoteAgents) {
      try {
        return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/guidance`, body);
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  recordCodexJobAudit(params.id, 'guidance', {
    ...auditMeta(request),
    source: body.source ?? 'hermes',
    text: body.text.slice(0, 1000),
  });
  return { job };
});

app.post('/api/hermes/jobs/:id/supervise', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = jobSupervisorSchema.parse(request.body ?? {});
  const localSessions = body.autoRetry ? await getStateSessionsForHermes() : [];
  const superviseInput = {
    id: params.id,
    instruction: body.instruction,
    autoStop: body.autoStop,
    autoRetry: body.autoRetry,
    checkIntervalMs: body.checkIntervalMs,
    staleOutputMs: body.staleOutputMs,
    restart: (previousJob: CodexResumeJob, prompt: string) => {
      const session = localSessions.find((item) => item.id === previousJob.sessionId);
      if (!session) throw new Error(`Session not found for retry: ${previousJob.sessionId}`);
      return startCodexResumeJob({
        session,
        prompt,
        mode: codexJobMode(body.retryMode ?? previousJob.mode),
        supervisor: true,
        policy: previousJob.policy,
        onExit: (completedJob: CodexResumeJob) => {
          void finalizeJobFacts(completedJob, prompt, 'supervisor retry job finished').catch((error) => {
            app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
          });
          void enqueueEvaluationRefresh(completedJob.sessionId, `supervisor:${completedJob.id}:${completedJob.status}`).catch((error) => {
            app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Supervisor retry evaluation refresh enqueue failed');
          });
        },
      });
    },
  };
  const result = superviseCodexResumeJob(superviseInput);
  if (!result) {
    for (const agent of remoteAgents) {
      try {
        return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/supervise`, body);
      } catch {
        // Try the next remote agent.
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  recordCodexJobAudit(params.id, 'supervise', {
    ...auditMeta(request),
    autoStop: body.autoStop,
    autoRetry: body.autoRetry,
    semantic: body.semantic,
  });

  let semantic = null;
  if (body.semantic || process.env.CURATOR_CODEX_SEMANTIC_SUPERVISOR === '1') {
    semantic = await evaluateJobSemantics({
      job: result.job,
      events: listCodexJobEvents(params.id, Math.max(0, (result.job.eventSeq ?? 0) - 80)),
      policy: result.job.policy,
    });
    if (semantic) {
      recordCodexJobAudit(params.id, 'semantic-supervisor', {
        decision: semantic.decision,
        reason: semantic.reason,
        confidence: semantic.confidence,
      });
      if (semantic.decision === 'needs_guidance' && semantic.guidance && result.job.mode === 'pty') {
        sendCodexJobGuidance(params.id, semantic.guidance, 'supervisor');
      }
      if ((semantic.decision === 'stop' || semantic.decision === 'failed') && body.autoStop) {
        const stopped = stopCodexResumeJob(params.id);
        if (stopped) await finalizeJobFacts(stopped, stopped.prompt, semantic.reason);
      }
    }
  }
  return { ...result, semantic };
});

app.get('/api/sessions', async (request) => {
  const query = z
    .object({
      q: z.string().optional(),
      recommendation: z.enum(['all', 'keep', 'review', 'delete']).optional(),
      refresh: z.enum(['0', '1', 'true', 'false']).optional(),
      remote: z.enum(['0', '1', 'true', 'false']).optional(),
      detail: z.enum(['0', '1', 'true', 'false']).optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(500).optional(),
    })
    .parse(request.query);
  const refreshWorkflow = query.refresh === '1' || query.refresh === 'true';
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const includeDetails = query.detail !== '0' && query.detail !== 'false';
  const localSessions = await getLocalSessionsCached(refreshWorkflow, !includeDetails);
  const remoteSessions = refreshWorkflow || !includeRemote
    ? []
    : await getRemoteSessionsCached();
  const sessions = [...localSessions, ...remoteSessions];
  const filtered = sessions.filter((session) => {
    const matchesRecommendation =
      !query.recommendation ||
      query.recommendation === 'all' ||
      session.evaluation.recommendation === query.recommendation;
    const text = sessionSearchText(session);
    const matchesQuery = !query.q || text.includes(query.q.toLowerCase());
    return matchesRecommendation && matchesQuery;
  });

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? (filtered.length || 1);
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  return {
    meta: { ...service.getMeta(), remoteAgents: remoteAgents.map((agent) => ({ id: agent.id, baseUrl: agent.baseUrl })) },
    sessions: includeDetails ? paged : paged.map(toSessionSummary),
    total: sessions.length,
    filteredTotal: filtered.length,
    page,
    pageSize,
  };
});

app.get('/api/remote-agents', async () => ({
  agents: await Promise.all(remoteAgents.map((agent) => checkRemoteAgent(agent))),
}));

app.get('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const remote = await findRemoteSession(params.id);
  if (remote && shouldPreferRemoteSession(null, remote.session)) return remote.session;
  const fastSession = await service.getSessionFast(params.id);
  const session = fastSession ? (await service.getSession(params.id)) ?? fastSession : null;
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  return session;
});

app.get('/api/sessions/:id/files', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionFilesQuerySchema.parse(request.query);
  const remote = await findRemoteSession(params.id);
  if (remote && shouldPreferRemoteSession(null, remote.session)) {
    try {
      return await listRemoteSessionWorkdir(remote.session, query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to list remote session cwd' });
    }
  }
  const session = await service.getSessionFast(params.id);
  if (remote && shouldPreferRemoteSession(session, remote.session)) {
    try {
      return await listRemoteSessionWorkdir(remote.session, query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to list remote session cwd' });
    }
  }
  if (!session) return reply.code(404).send({ error: 'Session not found' });

  try {
    return await listSessionWorkdir(session, query.path);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to list session cwd' });
  }
});

app.get('/api/sessions/:id/files/download', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionFilesQuerySchema.parse(request.query);
  const remote = await findRemoteSession(params.id);
  if (remote && shouldPreferRemoteSession(null, remote.session)) {
    try {
      const file = await statRemoteSessionFile(remote.session, query.path);
      const child = spawnRemoteFileDownload(file.target, remote.session, query.path);
      child.stderr.on('data', (chunk: Buffer) => app.log.warn({ sessionId: params.id, error: chunk.toString('utf8') }, 'Remote file download stderr'));
      request.raw.on('close', () => child.kill());
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(file.size));
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      return reply.send(child.stdout);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to download remote file' });
    }
  }
  const session = await service.getSessionFast(params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found on this agent' });

  try {
    const { targetReal } = await resolveSessionWorkdirPath(session, query.path);
    const targetStat = await stat(targetReal);
    if (!targetStat.isFile()) return reply.code(400).send({ error: 'Path is not a file' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(targetStat.size));
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(basename(targetReal))}"`);
    return reply.send(createReadStream(targetReal));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to download file' });
  }
});

app.post('/api/sessions/:id/files/upload', { bodyLimit: 100 * 1024 * 1024 }, async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionFileUploadQuerySchema.parse(request.query);
  const body = request.body;
  if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'Expected application/octet-stream upload body' });
  const remote = await findRemoteSession(params.id);
  if (remote && shouldPreferRemoteSession(null, remote.session)) {
    try {
      const overwrite = query.overwrite === '1' || query.overwrite === 'true';
      return await uploadRemoteSessionFile(remote.session, query.path, query.name, overwrite, body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to upload remote file' });
    }
  }

  const session = await service.getSessionFast(params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found on this agent' });

  try {
    const overwrite = query.overwrite === '1' || query.overwrite === 'true';
    const { target, directoryReal, relativePath } = await resolveSessionUploadPath(session, query.path, query.name);
    await mkdir(directoryReal, { recursive: true });
    await writeFile(target, body, { flag: overwrite ? 'w' : 'wx' });
    const uploaded = await stat(target);
    return {
      ok: true,
      entry: {
        name: basename(target),
        path: fileEntryPath(relativePath, basename(target)),
        type: 'file',
        size: uploaded.size,
        mtime: uploaded.mtime.toISOString(),
      },
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to upload file' });
  }
});

app.get('/api/sessions/:id/history', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.coerce.number().int().min(0).optional(),
    })
    .parse(request.query);
  try {
    return await service.getSessionHistory(params.id, { limit: query.limit, beforeIndex: query.before ?? null });
  } catch (error) {
    for (const agent of remoteAgents) {
      try {
        const path = `/api/sessions/${encodeURIComponent(params.id)}/history?limit=${query.limit ?? 80}${
          query.before === undefined ? '' : `&before=${query.before}`
        }`;
        return await fetchAgentJson(agent, path);
      } catch {
        // Try the next agent.
      }
    }
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'History failed' });
  }
});

app.get('/api/sessions/:id/messages', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(5000).optional(),
      before: z.coerce.number().int().min(0).optional(),
      after: z.coerce.number().int().min(0).optional(),
      full: z.enum(['0', '1', 'true', 'false']).optional(),
      preserve: z.enum(['0', '1', 'true', 'false']).optional(),
    })
    .parse(request.query);
  const full = query.full === '1' || query.full === 'true';
  const preserveWhitespace = query.preserve === '1' || query.preserve === 'true';
  try {
    return await service.getSessionMessages(params.id, {
      limit: query.limit,
      beforeIndex: query.before ?? null,
      afterIndex: query.after ?? null,
      full,
      preserveWhitespace,
    });
  } catch (error) {
    for (const agent of remoteAgents) {
      try {
        const searchParams = new URLSearchParams();
        if (query.limit !== undefined) searchParams.set('limit', String(query.limit));
        if (query.before !== undefined) searchParams.set('before', String(query.before));
        if (query.after !== undefined) searchParams.set('after', String(query.after));
        if (query.full !== undefined) searchParams.set('full', query.full);
        if (query.preserve !== undefined) searchParams.set('preserve', query.preserve);
        const suffix = searchParams.size ? `?${searchParams.toString()}` : '';
        return await fetchAgentJson(agent, `/api/sessions/${encodeURIComponent(params.id)}/messages${suffix}`);
      } catch {
        // Try the next agent.
      }
    }
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Messages failed' });
  }
});

app.get('/api/sessions/:id/terminal', { websocket: true }, async (socket, request) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      cols: z.coerce.number().int().min(40).max(500).optional(),
      rows: z.coerce.number().int().min(12).max(160).optional(),
    })
    .parse(request.query);
  const remote = await findRemoteSession(params.id);
  if (remote && shouldPreferRemoteSession(null, remote.session)) {
    const terminal = startCodexTerminal(remote.session, (message) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    }, query);
    socket.on('message', (raw: { toString(): string }) => {
      try {
        terminal.write(JSON.parse(raw.toString()) as TerminalInput);
      } catch {
        socket.send(JSON.stringify({ type: 'error', data: 'Invalid terminal input' }));
      }
    });
    socket.on('close', () => terminal.close());
    socket.on('error', () => terminal.close());
    return;
  }
  const session = await service.getSessionFast(params.id);
  const terminalSession = remote && shouldPreferRemoteSession(session, remote.session) ? remote.session : session;
  if (!terminalSession) {
    socket.send(JSON.stringify({ type: 'error', data: 'Session not found' }));
    socket.close();
    return;
  }

  const terminal = startCodexTerminal(terminalSession, (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }, query);

  socket.on('message', (raw: { toString(): string }) => {
    try {
      terminal.write(JSON.parse(raw.toString()) as TerminalInput);
    } catch {
      socket.send(JSON.stringify({ type: 'error', data: 'Invalid terminal input' }));
    }
  });
  socket.on('close', () => terminal.close());
  socket.on('error', () => terminal.close());
});

app.get('/api/recycle-bin', async () => ({
  meta: service.getMeta(),
  archives: await service.listRecycleBin(),
}));

app.post('/api/recycle-bin/:id/restore', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  confirmSchema.parse(request.body);
  try {
    const result = await service.restoreRecycleArchive(params.id);
    clearSessionCaches();
    return result;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Restore failed' });
  }
});

app.delete('/api/recycle-bin/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  confirmSchema.parse(request.body);
  try {
    const result = await service.purgeRecycleArchive(params.id);
    return result;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Purge failed' });
  }
});

app.post('/api/sessions/:id/keep', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = keepSchema.parse(request.body);
  const session = await service.setKept(params.id, body.kept);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  clearSessionCaches();
  return session;
});

app.post('/api/sessions/:id/title', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = titleSchema.parse(request.body);
  const session = await service.setTitle(params.id, body.title);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  clearSessionCaches();
  return session;
});

app.post('/api/sessions/:id/migrate', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = migrateSchema.parse(request.body);
  try {
    const result = await service.migrateSessionToProject(params.id, body.targetProjectDir);
    clearSessionCaches();
    return result;
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Migrate failed' });
  }
});

app.delete('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  confirmSchema.parse(request.body);
  try {
    const result = await deleteSessionById(params.id);
    clearSessionCaches();
    return result;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Delete failed' });
  }
});

app.post('/api/sessions/prune', async (request) => {
  confirmSchema.parse(request.body);
  const result = await service.pruneRecommended('delete');
  clearSessionCaches();
  return result;
});

app.post('/api/sessions/prune-non-kept', async (request) => {
  confirmSchema.parse(request.body);
  const result = await service.pruneNonKept();
  clearSessionCaches();
  return result;
});

app.post('/api/sessions/bulk-delete', async (request) => {
  const body = bulkDeleteSchema.parse(request.body);
  const query = request.query as { remote?: string };
  const results = await deleteSessionsByIdsBulk(body.ids, query.remote !== '0');
  clearSessionCaches();
  return {
    deleted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
});

app.post('/api/evaluations/retry-failed', async () => {
  const result = await service.queueFailedSummaryRetry();
  clearSessionCaches();
  return result;
});

app.post('/api/evaluations/backfill', async (request) => {
  const body = backfillSchema.parse(request.body ?? {});
  const result = await service.backfillEvaluations({ limit: body.limit, includeFailed: body.includeFailed });
  clearSessionCaches();
  return result;
});

app.post('/api/evaluations/:id/refresh', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  try {
    const job = await enqueueEvaluationRefresh(params.id, 'manual-api');
    return reply.code(202).send({ job: publicEvaluationRefreshJob(job) });
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Refresh failed' });
  }
});

app.get('/api/evaluations/refresh-jobs/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const job = evaluationRefreshJobs.get(params.id);
  if (!job) return reply.code(404).send({ error: 'Refresh job not found' });
  return { job: publicEvaluationRefreshJob(job) };
});

const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    setHeaders(response, pathName) {
      if (pathName.includes('/assets/')) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        response.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.sendFile('index.html');
  });
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 54177);

await app.listen({ host, port });
app.log.info(`Codex Session Curator listening on http://${host}:${port}`);
