import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { CodexSession } from './types.js';
import { createTerminalEnv, getCodexBin } from './terminal.js';

export type CodexJobStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type CodexJobMode = 'exec' | 'pty';
export type CodexSupervisorDecision = 'continue' | 'needs_guidance' | 'stop' | 'retry' | 'completed' | 'failed';
export type CodexJobEventType =
  | 'started'
  | 'output'
  | 'status'
  | 'guidance'
  | 'supervisor'
  | 'completion'
  | 'policy'
  | 'structured_report'
  | 'audit';
export type CodexJobProtocolKind = 'guide' | 'pause' | 'continue' | 'summarize' | 'handoff' | 'verify';

export interface CodexJobEvent {
  seq: number;
  jobId: string;
  at: string;
  type: CodexJobEventType;
  message: string;
  data?: Record<string, unknown>;
}

export interface CodexJobGuidance {
  at: string;
  text: string;
  source: 'hermes' | 'supervisor' | 'api';
}

export interface CodexSupervisorOptions {
  enabled?: boolean;
  autoStop?: boolean;
  autoRetry?: boolean;
  idleTimeoutMs?: number;
  staleOutputMs?: number;
  maxRetries?: number;
}

export interface CodexSupervisorState {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastDecision: CodexSupervisorDecision | null;
  lastReason: string | null;
  checks: number;
  retries: number;
  autoStop: boolean;
  autoRetry: boolean;
  idleTimeoutMs: number | null;
  maxRetries: number | null;
  lastOutputAt: string | null;
  lastOutputBytes: number;
}

export interface CodexStructuredReport {
  status: string | null;
  changedFiles: string[];
  tests: string[];
  nextAction: string | null;
  rawFooter: string | null;
  parsedAt: string | null;
}

export interface CodexJobPolicy {
  maxRuntimeMs?: number | null;
  maxOutputBytes?: number | null;
  allowDeploy?: boolean;
  allowDeletes?: boolean;
  allowedCwds?: string[];
  blockedCommands?: string[];
  autoStop?: boolean;
}

export interface CodexPolicyViolation {
  at: string;
  reason: string;
  severity: 'warn' | 'stop';
  pattern?: string;
}

export interface CodexJobPolicyState {
  lastCheckedAt: string | null;
  violations: CodexPolicyViolation[];
  stoppedAt: string | null;
}

export interface CodexSupervisorLoopOptions {
  intervalMs?: number;
  checkIntervalMs?: number;
  idleTimeoutMs?: number;
  staleOutputMs?: number;
  autoStop?: boolean;
  autoRetry?: boolean;
  maxRetries?: number;
  runImmediately?: boolean;
  restart?: (job: CodexResumeJob, prompt: string) => CodexResumeJob;
}

export interface CodexResumeJob {
  id: string;
  sessionId: string;
  machineId: string;
  mode: CodexJobMode;
  cwd: string;
  command: string;
  prompt: string;
  status: CodexJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  outputBytes: number;
  changedFiles: string[];
  error: string | null;
  tmuxName: string | null;
  guidance: CodexJobGuidance[];
  supervisor: CodexSupervisorState;
  events: CodexJobEvent[];
  eventSeq: number;
  policy: CodexJobPolicy;
  policyState: CodexJobPolicyState;
  structuredReport: CodexStructuredReport | null;
}

const MAX_TAIL_BYTES = Number(process.env.CURATOR_CODEX_JOB_TAIL_BYTES || 64 * 1024);
const MAX_EVENTS_PER_JOB = Number(process.env.CURATOR_CODEX_JOB_MAX_EVENTS || 2000);
const EVENT_TAIL_BYTES = Number(process.env.CURATOR_CODEX_JOB_EVENT_TAIL_BYTES || 8192);
const DEFAULT_SUPERVISOR_IDLE_TIMEOUT_MS = Number(process.env.CURATOR_CODEX_SUPERVISOR_IDLE_MS || 2 * 60 * 1000);
type CodexJobProcess = ChildProcessByStdio<null, Readable, Readable>;
type CodexJobRuntime = CodexResumeJob & { process?: CodexJobProcess; pty?: IPty };

const jobs = new Map<string, CodexJobRuntime>();
let supervisorLoop: NodeJS.Timeout | null = null;

function defaultPolicy(input?: CodexJobPolicy): CodexJobPolicy {
  return {
    allowDeploy: false,
    allowDeletes: false,
    autoStop: true,
    ...input,
    allowedCwds: input?.allowedCwds?.filter(Boolean) ?? [],
    blockedCommands: input?.blockedCommands?.filter(Boolean) ?? [],
  };
}

function defaultSupervisor(input?: boolean | CodexSupervisorOptions): CodexSupervisorState {
  const options: CodexSupervisorOptions = typeof input === 'object' && input ? input : {};
  const idleTimeoutMs = options.idleTimeoutMs ?? options.staleOutputMs ?? DEFAULT_SUPERVISOR_IDLE_TIMEOUT_MS;
  return {
    enabled: typeof input === 'boolean' ? input : options.enabled ?? false,
    lastCheckedAt: null,
    lastDecision: null,
    lastReason: null,
    checks: 0,
    retries: 0,
    autoStop: options.autoStop ?? false,
    autoRetry: options.autoRetry ?? false,
    idleTimeoutMs,
    maxRetries: options.maxRetries ?? null,
    lastOutputAt: null,
    lastOutputBytes: 0,
  };
}

function mergeSupervisorInput(
  supervisor?: boolean | CodexSupervisorOptions,
  strategy?: CodexSupervisorOptions,
): boolean | CodexSupervisorOptions | undefined {
  if (!strategy) return supervisor;
  const enabled = typeof supervisor === 'boolean' ? supervisor : supervisor?.enabled;
  return {
    ...(typeof supervisor === 'object' && supervisor ? supervisor : {}),
    ...strategy,
    enabled: strategy.enabled ?? enabled ?? false,
  };
}

function emptyPolicyState(): CodexJobPolicyState {
  return {
    lastCheckedAt: null,
    violations: [],
    stoppedAt: null,
  };
}

function recordJobEvent(
  job: CodexJobRuntime | CodexResumeJob,
  type: CodexJobEventType,
  message: string,
  data?: Record<string, unknown>,
  shouldPersist = false,
): CodexJobEvent {
  job.eventSeq = (job.eventSeq ?? 0) + 1;
  const event: CodexJobEvent = {
    seq: job.eventSeq,
    jobId: job.id,
    at: new Date().toISOString(),
    type,
    message,
    ...(data ? { data } : {}),
  };
  job.events = [...(job.events ?? []), event].slice(-MAX_EVENTS_PER_JOB);
  if (shouldPersist) persistJobs();
  return event;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function truncateEventText(value: string, maxBytes = EVENT_TAIL_BYTES): string {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(-maxBytes).toString('utf8');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCommandWord(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : shellQuote(value);
}

function jobsPath(): string {
  return process.env.CURATOR_CODEX_JOBS_PATH || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'session-curator-jobs.json');
}

function persistJobs(): void {
  const path = jobsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ jobs: [...jobs.values()].map(snapshotJob) }, null, 2), 'utf8');
}

function tmuxSessionName(jobId: string): string {
  return `codex-curator-job-${jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
}

function hasTmux(env: NodeJS.ProcessEnv): boolean {
  return spawnSync('tmux', ['-V'], { env, stdio: 'ignore' }).status === 0;
}

function tmuxHasSession(name: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync('tmux', ['has-session', '-t', name], { env, stdio: 'ignore' }).status === 0;
}

function configureTmuxSession(name: string, env: NodeJS.ProcessEnv): void {
  spawnSync('tmux', ['set-option', '-t', name, 'status', 'off'], { env, stdio: 'ignore' });
  spawnSync('tmux', ['set-option', '-t', name, 'mouse', 'off'], { env, stdio: 'ignore' });
  spawnSync('tmux', ['set-option', '-t', name, 'history-limit', '50000'], { env, stdio: 'ignore' });
  spawnSync('tmux', ['set-window-option', '-t', name, 'alternate-screen', 'off'], { env, stdio: 'ignore' });
}

function parseListValue(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 200);
}

function parseStructuredReportFromTail(outputTail: string): CodexStructuredReport | null {
  const clean = stripAnsi(outputTail);
  const lines = clean.split(/\r?\n/).slice(-160);
  const keyPattern = /^(STATUS|CHANGED_FILES|TESTS|NEXT_ACTION)\s*[:：]\s*(.*)$/i;
  const footerIndexes = lines
    .map((line, index) => (keyPattern.test(line.trim()) ? index : -1))
    .filter((index) => index >= 0);
  if (!footerIndexes.length) return null;

  let firstFooterIndex = -1;
  for (const index of footerIndexes) {
    const window = lines.slice(index, Math.min(lines.length, index + 18)).map((line) => line.trim());
    const keys = new Set(
      window
        .map((line) => keyPattern.exec(line)?.[1]?.toUpperCase())
        .filter((key): key is string => Boolean(key)),
    );
    if (keys.has('STATUS') && keys.has('CHANGED_FILES') && keys.has('TESTS') && keys.has('NEXT_ACTION')) {
      firstFooterIndex = index;
    }
  }
  if (firstFooterIndex < 0) return null;

  const report: CodexStructuredReport = {
    status: null,
    changedFiles: [],
    tests: [],
    nextAction: null,
    rawFooter: lines.slice(firstFooterIndex).join('\n').trim().slice(-12000),
    parsedAt: new Date().toISOString(),
  };
  let currentKey: 'status' | 'changedFiles' | 'tests' | 'nextAction' | null = null;

  for (const rawLine of lines.slice(firstFooterIndex)) {
    const line = rawLine.trim();
    const match = keyPattern.exec(line);
    if (match) {
      const key = match[1].toUpperCase();
      const value = match[2].trim();
      currentKey =
        key === 'STATUS' ? 'status' : key === 'CHANGED_FILES' ? 'changedFiles' : key === 'TESTS' ? 'tests' : 'nextAction';
      if (currentKey === 'status') report.status = value || report.status;
      if (currentKey === 'changedFiles' && value) report.changedFiles.push(...parseListValue(value));
      if (currentKey === 'tests' && value) report.tests.push(...parseListValue(value));
      if (currentKey === 'nextAction') report.nextAction = value || report.nextAction;
      continue;
    }

    if (!line || !currentKey) continue;
    if (currentKey === 'changedFiles') report.changedFiles.push(...parseListValue(line));
    if (currentKey === 'tests') report.tests.push(line.replace(/^[-*]\s*/, '').trim());
    if (currentKey === 'nextAction') report.nextAction = [report.nextAction, line].filter(Boolean).join('\n');
  }

  report.changedFiles = [...new Set(report.changedFiles)].slice(0, 200);
  report.tests = [...new Set(report.tests.filter(Boolean))].slice(0, 200);
  const invalidTemplate =
    !report.status ||
    /\|/.test(report.status) ||
    /用逗号分隔|没有则写|下一步建议|not run \+ 原因/i.test(
      [report.status, report.nextAction, ...report.changedFiles, ...report.tests].filter(Boolean).join('\n'),
    );
  if (invalidTemplate) return null;
  return report.status || report.changedFiles.length || report.tests.length || report.nextAction ? report : null;
}

function structuredReportChanged(previous: CodexStructuredReport | null, next: CodexStructuredReport): boolean {
  if (!previous) return true;
  return JSON.stringify({
    status: previous.status,
    changedFiles: previous.changedFiles,
    tests: previous.tests,
    nextAction: previous.nextAction,
  }) !== JSON.stringify({
    status: next.status,
    changedFiles: next.changedFiles,
    tests: next.tests,
    nextAction: next.nextAction,
  });
}

function updateStructuredReport(job: CodexJobRuntime): void {
  const report = parseStructuredReportFromTail(job.outputTail);
  if (!report || !structuredReportChanged(job.structuredReport, report)) return;
  job.structuredReport = report;
  recordJobEvent(job, 'structured_report', 'Parsed structured Codex completion report', {
    status: report.status,
    changedFiles: report.changedFiles,
    tests: report.tests,
    nextAction: report.nextAction,
  });
}

function recordMissingStructuredReport(job: CodexJobRuntime): void {
  if (job.structuredReport) return;
  const alreadyRecorded = job.events.some(
    (event) => event.type === 'structured_report' && event.data?.missing === true,
  );
  if (alreadyRecorded) return;
  recordJobEvent(job, 'structured_report', 'Codex worker completed without the required structured report footer', {
    missing: true,
    requiredFields: ['STATUS', 'CHANGED_FILES', 'TESTS', 'NEXT_ACTION'],
  });
}

function cwdAllowed(cwd: string, allowedCwds: string[]): boolean {
  if (!allowedCwds.length) return true;
  const resolvedCwd = resolve(cwd);
  return allowedCwds.some((allowed) => {
    const resolvedAllowed = resolve(allowed);
    return resolvedCwd === resolvedAllowed || resolvedCwd.startsWith(`${resolvedAllowed}/`);
  });
}

function addPolicyViolation(job: CodexJobRuntime, violation: Omit<CodexPolicyViolation, 'at'>): boolean {
  const exists = job.policyState.violations.some(
    (item) => item.reason === violation.reason && item.pattern === violation.pattern && item.severity === violation.severity,
  );
  if (exists) return false;
  const item: CodexPolicyViolation = { ...violation, at: new Date().toISOString() };
  job.policyState.violations = [...job.policyState.violations, item].slice(-100);
  recordJobEvent(job, 'policy', item.reason, {
    severity: item.severity,
    pattern: item.pattern,
  });
  return true;
}

function stopRuntimeJob(job: CodexJobRuntime, reason: string): void {
  if (job.status !== 'running' && job.status !== 'stopped') return;
  const wasRunning = job.status === 'running';
  job.status = 'stopped';
  job.error = reason;
  job.updatedAt = new Date().toISOString();
  if (wasRunning) recordJobEvent(job, 'status', reason, { status: job.status });
  if (job.process) job.process.kill('SIGTERM');
  if (job.pty) job.pty.kill();
  if (job.tmuxName) spawnSync('tmux', ['kill-session', '-t', job.tmuxName], { env: createTerminalEnv(), stdio: 'ignore' });
}

function enforceJobPolicy(job: CodexJobRuntime): void {
  const now = Date.now();
  const policy = defaultPolicy(job.policy);
  const output = stripAnsi(job.outputTail).toLowerCase();
  const elapsed = now - Date.parse(job.startedAt);
  let shouldStop = false;

  job.policy = policy;
  job.policyState.lastCheckedAt = new Date().toISOString();

  if (!cwdAllowed(job.cwd, policy.allowedCwds ?? [])) {
    shouldStop =
      addPolicyViolation(job, {
        reason: `Job cwd is outside allowedCwds: ${job.cwd}`,
        severity: 'stop',
        pattern: 'allowedCwds',
      }) || shouldStop;
  }
  if (policy.maxRuntimeMs && elapsed > policy.maxRuntimeMs) {
    shouldStop =
      addPolicyViolation(job, {
        reason: `Job exceeded maxRuntimeMs (${policy.maxRuntimeMs})`,
        severity: 'stop',
        pattern: 'maxRuntimeMs',
      }) || shouldStop;
  }
  if (policy.maxOutputBytes && job.outputBytes > policy.maxOutputBytes) {
    shouldStop =
      addPolicyViolation(job, {
        reason: `Job exceeded maxOutputBytes (${policy.maxOutputBytes})`,
        severity: 'stop',
        pattern: 'maxOutputBytes',
      }) || shouldStop;
  }

  for (const blocked of policy.blockedCommands ?? []) {
    if (blocked.trim() && output.includes(blocked.trim().toLowerCase())) {
      shouldStop =
        addPolicyViolation(job, {
          reason: `Blocked command appeared in output: ${blocked}`,
          severity: 'stop',
          pattern: blocked,
        }) || shouldStop;
    }
  }

  const deletePatterns = [
    { label: 'rm -rf', regex: /(^|[\s;&|])(?:sudo\s+)?rm\s+-[^\n;&|]*r[^\n;&|]*f/i },
    { label: 'git reset --hard', regex: /(^|[\s;&|])git\s+reset\s+--hard/i },
    { label: 'git clean -fd', regex: /(^|[\s;&|])git\s+clean\s+-[^\n;&|]*[fd][^\n;&|]*[fd]/i },
    { label: 'find -delete', regex: /(^|[\s;&|])find\s+[^\n;&|]+\s-delete/i },
    { label: 'terraform destroy', regex: /(^|[\s;&|])terraform\s+destroy/i },
    { label: 'kubectl delete', regex: /(^|[\s;&|])kubectl\s+delete/i },
    { label: '--delete sync', regex: /(^|[\s;&|])(?:rsync|aws\s+s3\s+sync)\s+[^\n]*--delete/i },
  ];
  if (policy.allowDeletes !== true) {
    for (const pattern of deletePatterns) {
      if (pattern.regex.test(output)) {
        shouldStop =
          addPolicyViolation(job, {
            reason: `Delete-like command appeared in output while allowDeletes=false: ${pattern.label}`,
            severity: 'stop',
            pattern: pattern.label,
          }) || shouldStop;
      }
    }
  }

  const deployPatterns = [
    { label: 'npm publish', regex: /(^|[\s;&|])npm\s+publish/i },
    { label: 'deploy command', regex: /(^|[\s;&|])(?:vercel|netlify|fly|railway|wrangler)\s+(?:deploy|up|publish)/i },
    { label: 'git push', regex: /(^|[\s;&|])git\s+push/i },
    { label: 'gh release', regex: /(^|[\s;&|])gh\s+release\s+(?:create|upload)/i },
  ];
  if (policy.allowDeploy !== true) {
    for (const pattern of deployPatterns) {
      if (pattern.regex.test(output)) {
        shouldStop =
          addPolicyViolation(job, {
            reason: `Deploy-like command appeared in output while allowDeploy=false: ${pattern.label}`,
            severity: 'stop',
            pattern: pattern.label,
          }) || shouldStop;
      }
    }
  }

  if (shouldStop && policy.autoStop !== false && job.status === 'running') {
    job.policyState.stoppedAt = new Date().toISOString();
    stopRuntimeJob(job, 'Policy guard stopped the job');
  }
}

function appendOutput(job: CodexJobRuntime, chunk: string): void {
  job.outputBytes += Buffer.byteLength(chunk);
  job.outputTail += chunk;
  if (Buffer.byteLength(job.outputTail) > MAX_TAIL_BYTES) {
    job.outputTail = Buffer.from(job.outputTail).subarray(-MAX_TAIL_BYTES).toString('utf8');
  }
  job.updatedAt = new Date().toISOString();
  job.supervisor.lastOutputAt = job.updatedAt;
  job.supervisor.lastOutputBytes = job.outputBytes;
  recordJobEvent(job, 'output', 'Codex emitted output', {
    bytes: Buffer.byteLength(chunk),
    tail: truncateEventText(chunk),
  });
  updateStructuredReport(job);
  enforceJobPolicy(job);
  persistJobs();
}

function gitChangedFiles(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const result = spawnSync('git', ['status', '--short'], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^..?\s+/, '').trim())
    .slice(0, 200);
}

function captureTmuxTail(job: CodexJobRuntime, env: NodeJS.ProcessEnv): void {
  if (!job.tmuxName) return;
  if (!tmuxHasSession(job.tmuxName, env)) {
    if (job.mode === 'pty' && job.status === 'running') {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.changedFiles = gitChangedFiles(job.cwd, env);
      updateStructuredReport(job);
      recordMissingStructuredReport(job);
      recordJobEvent(job, 'completion', 'PTY tmux session ended', {
        status: job.status,
        changedFiles: job.changedFiles,
      });
      persistJobs();
    }
    return;
  }
  const result = spawnSync('tmux', ['capture-pane', '-t', job.tmuxName, '-p', '-S', '-3000'], {
    env,
    encoding: 'utf8',
    maxBuffer: MAX_TAIL_BYTES * 2,
  });
  if (result.status === 0 && result.stdout.trim()) {
    const nextTail = result.stdout.slice(-MAX_TAIL_BYTES);
    if (nextTail === job.outputTail) return;
    job.outputTail = nextTail;
    job.outputBytes = Math.max(job.outputBytes, Buffer.byteLength(job.outputTail));
    job.updatedAt = new Date().toISOString();
    job.supervisor.lastOutputAt = job.updatedAt;
    job.supervisor.lastOutputBytes = job.outputBytes;
    recordJobEvent(job, 'output', 'Captured PTY tmux output tail', {
      bytes: Buffer.byteLength(job.outputTail),
      tail: truncateEventText(job.outputTail),
    });
    updateStructuredReport(job);
    enforceJobPolicy(job);
    persistJobs();
  }
}

function refreshRuntimeJob(job: CodexJobRuntime): void {
  if (job.mode === 'pty') captureTmuxTail(job, createTerminalEnv());
}

function snapshotJob(job: CodexJobRuntime): CodexResumeJob {
  const { process: _process, pty: _pty, ...rest } = job;
  return rest;
}

export function publicJob(job: CodexJobRuntime): CodexResumeJob {
  refreshRuntimeJob(job);
  return snapshotJob(job);
}

export function listCodexResumeJobs(): CodexResumeJob[] {
  return [...jobs.values()].map(publicJob).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function getCodexResumeJob(id: string): CodexResumeJob | null {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function listCodexJobEvents(jobId: string, afterSeq = 0): CodexJobEvent[] {
  const job = jobs.get(jobId);
  if (!job) return [];
  return job.events.filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}

function buildExecArgs(input: { session: CodexSession; prompt: string; model?: string | null; extraArgs?: string[] }, cwd: string): string[] {
  const args = ['-C', cwd, 'exec', 'resume', '--skip-git-repo-check'];
  if (input.model) args.push('-m', input.model);
  for (const arg of input.extraArgs ?? []) {
    if (typeof arg === 'string' && arg.trim()) args.push(arg);
  }
  args.push(input.session.id, input.prompt);
  return args;
}

function buildInteractiveCommand(input: { session: CodexSession; model?: string | null }, cwd: string, env: NodeJS.ProcessEnv): string {
  const args = ['resume', '--include-non-interactive', '--no-alt-screen', '-C', cwd];
  if (input.model) args.push('-m', input.model);
  args.push(input.session.id);
  return [shellCommandWord(getCodexBin(env)), ...args.map(shellQuote)].join(' ');
}

function baseJob(input: {
  session: CodexSession;
  prompt: string;
  mode: CodexJobMode;
  command: string;
  cwd: string;
  tmuxName?: string | null;
  supervisor?: boolean | CodexSupervisorOptions;
  policy?: CodexJobPolicy;
  id?: string;
}): CodexJobRuntime {
  const now = new Date().toISOString();
  const job: CodexJobRuntime = {
    id: input.id ?? randomUUID(),
    sessionId: input.session.id,
    machineId: input.session.machineId,
    mode: input.mode,
    cwd: input.cwd,
    command: input.command,
    prompt: input.prompt,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    exitCode: null,
    signal: null,
    outputTail: '',
    outputBytes: 0,
    changedFiles: [],
    error: null,
    tmuxName: input.tmuxName ?? null,
    guidance: [],
    supervisor: defaultSupervisor(input.supervisor),
    events: [],
    eventSeq: 0,
    policy: defaultPolicy(input.policy),
    policyState: emptyPolicyState(),
    structuredReport: null,
  };
  recordJobEvent(job, 'started', 'Codex job started', {
    mode: job.mode,
    cwd: job.cwd,
    command: job.command,
    supervisorEnabled: job.supervisor.enabled,
  });
  return job;
}

export function startCodexResumeJob(input: {
  session: CodexSession;
  prompt: string;
  model?: string | null;
  extraArgs?: string[];
  mode?: CodexJobMode;
  supervisor?: boolean | CodexSupervisorOptions;
  supervisorStrategy?: CodexSupervisorOptions;
  policy?: CodexJobPolicy;
  onExit?: (job: CodexResumeJob) => void | Promise<void>;
}): CodexResumeJob {
  const env = createTerminalEnv();
  const cwd = input.session.cwd || process.cwd();
  const codexBin = getCodexBin(env);
  const mode = input.mode ?? 'exec';
  const supervisor = mergeSupervisorInput(input.supervisor, input.supervisorStrategy);

  if (mode === 'pty') return startCodexPtyJob({ ...input, cwd, env });

  const args = buildExecArgs(input, cwd);
  const job = baseJob({
    session: input.session,
    prompt: input.prompt,
    mode: 'exec',
    command: [codexBin, ...args.map(shellQuote)].join(' '),
    cwd,
    supervisor,
    policy: input.policy,
  });

  const child = spawn(codexBin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.process = child;
  jobs.set(job.id, job);
  enforceJobPolicy(job);
  persistJobs();
  let finalized = false;

  function notifyExit(): void {
    if (finalized) return;
    finalized = true;
    void input.onExit?.(publicJob(job));
  }

  child.stdout.on('data', (chunk: Buffer) => appendOutput(job, chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => appendOutput(job, chunk.toString('utf8')));
  child.on('error', (error) => {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.changedFiles = gitChangedFiles(cwd, env);
    updateStructuredReport(job);
    recordMissingStructuredReport(job);
    recordJobEvent(job, 'status', 'Codex process failed to start', {
      status: job.status,
      error: job.error,
    });
    recordJobEvent(job, 'completion', 'Codex job failed', {
      status: job.status,
      changedFiles: job.changedFiles,
    });
    persistJobs();
    notifyExit();
  });
  child.on('exit', (code, signal) => {
    job.exitCode = code;
    job.signal = signal;
    job.status = job.status === 'stopped' ? 'stopped' : code === 0 ? 'completed' : 'failed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.changedFiles = gitChangedFiles(cwd, env);
    delete job.process;
    updateStructuredReport(job);
    recordMissingStructuredReport(job);
    recordJobEvent(job, 'status', `Codex process exited with status ${job.status}`, {
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
    });
    recordJobEvent(job, 'completion', 'Codex job completed execution', {
      status: job.status,
      changedFiles: job.changedFiles,
      structuredReport: job.structuredReport,
    });
    persistJobs();
    notifyExit();
  });

  return publicJob(job);
}

function startCodexPtyJob(input: {
  session: CodexSession;
  prompt: string;
  model?: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  supervisor?: boolean | CodexSupervisorOptions;
  supervisorStrategy?: CodexSupervisorOptions;
  policy?: CodexJobPolicy;
  onExit?: (job: CodexResumeJob) => void | Promise<void>;
}): CodexResumeJob {
  const jobId = randomUUID();
  const tmuxName = tmuxSessionName(jobId);
  const command = buildInteractiveCommand(input, input.cwd, input.env);
  const job = baseJob({
    session: input.session,
    prompt: input.prompt,
    mode: 'pty',
    command,
    cwd: input.cwd,
    tmuxName,
    supervisor: mergeSupervisorInput(input.supervisor, input.supervisorStrategy),
    policy: input.policy,
    id: jobId,
  });

  let attachCommand = command;
  if (hasTmux(input.env)) {
    const created = spawnSync('tmux', ['new-session', '-d', '-s', tmuxName, '-c', input.cwd, '-x', '120', '-y', '40', command], {
      env: input.env,
      encoding: 'utf8',
    });
    if (created.status !== 0) {
      throw new Error(created.stderr?.trim() || created.error?.message || 'tmux session create failed');
    }
    configureTmuxSession(tmuxName, input.env);
    attachCommand = `tmux attach-session -t ${tmuxName}`;
  } else {
    job.tmuxName = null;
  }

  const pty = job.tmuxName
    ? spawnPty('tmux', ['attach-session', '-t', job.tmuxName], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: input.cwd,
        env: input.env,
      })
    : spawnPty(getCodexBin(input.env), ['resume', '--include-non-interactive', '--no-alt-screen', '-C', input.cwd, input.session.id], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: input.cwd,
        env: input.env,
      });

  job.command = attachCommand;
  job.pty = pty;
  jobs.set(job.id, job);
  enforceJobPolicy(job);
  persistJobs();
  pty.onData((data) => appendOutput(job, data));
  pty.onExit(({ exitCode, signal }) => {
    job.exitCode = exitCode;
    job.signal = signal === 0 ? null : String(signal);
    job.status = job.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'completed' : 'failed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.changedFiles = gitChangedFiles(input.cwd, input.env);
    delete job.pty;
    updateStructuredReport(job);
    recordMissingStructuredReport(job);
    recordJobEvent(job, 'status', `Codex PTY exited with status ${job.status}`, {
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
    });
    recordJobEvent(job, 'completion', 'Codex PTY job completed execution', {
      status: job.status,
      changedFiles: job.changedFiles,
      structuredReport: job.structuredReport,
    });
    persistJobs();
    void input.onExit?.(publicJob(job));
  });

  sendCodexJobGuidance(job.id, input.prompt, 'api');
  return publicJob(job);
}

export function stopCodexResumeJob(id: string): CodexResumeJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  stopRuntimeJob(job, 'Job stopped by request');
  persistJobs();
  return publicJob(job);
}

function injectPtyText(job: CodexJobRuntime, text: string): boolean {
  if (job.mode !== 'pty' || job.status !== 'running') return false;
  const payload = `${text.trim()}\n`;
  if (job.pty) {
    job.pty.write(payload);
    return true;
  }
  if (job.tmuxName) {
    const env = createTerminalEnv();
    spawnSync('tmux', ['send-keys', '-t', job.tmuxName, '-l', text.trim()], { env, stdio: 'ignore' });
    spawnSync('tmux', ['send-keys', '-t', job.tmuxName, 'Enter'], { env, stdio: 'ignore' });
    return true;
  }
  return false;
}

export function sendCodexJobGuidance(id: string, text: string, source: CodexJobGuidance['source'] = 'hermes'): CodexResumeJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  const guidance: CodexJobGuidance = { at: new Date().toISOString(), text, source };
  job.guidance.push(guidance);
  job.guidance = job.guidance.slice(-50);
  job.updatedAt = guidance.at;
  recordJobEvent(job, 'guidance', 'Guidance recorded for Codex job', {
    source,
    text,
  });

  if (!injectPtyText(job, text) && job.status === 'running') {
    job.error = '当前 job 是 exec 非交互模式，已记录指导，但无法注入正在运行的进程。Hermes 可停止后重新派发。';
  }

  persistJobs();
  return publicJob(job);
}

function protocolInstruction(kind: CodexJobProtocolKind, text: string): string {
  const labels: Record<CodexJobProtocolKind, string> = {
    guide: 'Apply the following guidance.',
    pause: 'Pause active work, preserve context, and wait for a continue message.',
    continue: 'Continue the paused work.',
    summarize: 'Summarize current state, decisions, changed files, tests, and blockers.',
    handoff: 'Prepare a concise handoff for another worker.',
    verify: 'Verify the work and report concrete evidence.',
  };
  return [`[CURATOR_PROTOCOL ${kind}]`, labels[kind], text.trim(), `[/CURATOR_PROTOCOL ${kind}]`].filter(Boolean).join('\n');
}

export function sendCodexJobProtocolMessage(
  jobId: string,
  kind: CodexJobProtocolKind,
  text: string,
): { job: CodexResumeJob; event: CodexJobEvent; injected: boolean; error?: string } | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const payload = protocolInstruction(kind, text);
  const event = recordJobEvent(job, kind === 'guide' ? 'guidance' : 'supervisor', `Protocol message recorded: ${kind}`, {
    kind,
    text,
  });
  if (kind === 'guide') {
    job.guidance.push({ at: event.at, text, source: 'api' });
    job.guidance = job.guidance.slice(-50);
  }
  job.updatedAt = event.at;
  const injected = injectPtyText(job, payload);
  let error: string | undefined;
  if (!injected && job.mode === 'exec') {
    error = '当前 job 是 exec 非交互模式，protocol message 已记录但无法注入。';
    if (job.status === 'running') job.error = error;
  } else if (!injected && job.status === 'running') {
    error = '当前 job 是 exec 非交互模式或没有可写 PTY，protocol message 已记录但无法注入。';
    job.error = error;
  }
  persistJobs();
  return { job: publicJob(job), event, injected, ...(error ? { error } : {}) };
}

function autoRetryBlockedReason(job: CodexJobRuntime, decision: CodexSupervisorDecision, reason: string): string | null {
  const lower = `${job.error ?? ''}\n${job.outputTail}\n${reason}`.toLowerCase();
  if (job.policyState.violations.length > 0 || /policy guard|policy stop|触发安全策略/.test(lower)) {
    return 'policy stop 不自动重派，需要人工确认权限策略';
  }
  if (/authentication token has been invalidated|auth(?:entication)? failed|401 unauthorized|signing in|token/.test(lower)) {
    return '认证或 token 失效不自动重派，需要先重新登录';
  }
  if (/missing environment variable|missing env|api_key|code[x]?_api_key|environment variable/.test(lower)) {
    return '环境变量缺失不自动重派，需要先修复运行环境';
  }
  if (/no saved session found|session not found/.test(lower)) {
    return '会话缺失不自动重派，需要先确认 session id 和迁移状态';
  }
  if (/permission denied|eacces/.test(lower)) {
    return '权限问题不自动重派，需要先确认文件或机器权限';
  }
  if (decision === 'stop' && /长时间无输出|stale|timeout|无输出/.test(reason)) {
    return '卡住任务先要求 summarize 或人工复核，不直接自动重派';
  }
  return null;
}

export function recordCodexJobAudit(
  jobId: string,
  action: string,
  data: Record<string, unknown> = {},
): { job: CodexResumeJob; event: CodexJobEvent } | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const event = recordJobEvent(job, 'audit', `Audit: ${action}`, {
    action,
    ...data,
  });
  job.updatedAt = event.at;
  persistJobs();
  return { job: publicJob(job), event };
}

export function superviseCodexResumeJob(input: {
  id: string;
  instruction?: string;
  autoStop?: boolean;
  autoRetry?: boolean;
  idleTimeoutMs?: number;
  staleOutputMs?: number;
  checkIntervalMs?: number;
  maxRetries?: number;
  restart?: (job: CodexResumeJob, prompt: string) => CodexResumeJob;
}): { job: CodexResumeJob; decision: CodexSupervisorDecision; reason: string; followupJob?: CodexResumeJob } | null {
  const job = jobs.get(input.id);
  if (!job) return null;
  refreshRuntimeJob(job);
  updateStructuredReport(job);
  enforceJobPolicy(job);
  const lower = job.outputTail.toLowerCase();
  const now = new Date();
  const idleTimeoutMs = input.idleTimeoutMs ?? input.staleOutputMs ?? job.supervisor.idleTimeoutMs ?? DEFAULT_SUPERVISOR_IDLE_TIMEOUT_MS;
  const lastOutputAt = job.supervisor.lastOutputAt ?? (job.outputBytes > 0 ? job.updatedAt : job.startedAt);
  const idleMs = now.getTime() - Date.parse(lastOutputAt);
  const autoStop = input.autoStop ?? job.supervisor.autoStop;
  const autoRetry = input.autoRetry ?? job.supervisor.autoRetry;
  const maxRetries = input.maxRetries ?? job.supervisor.maxRetries;
  let decision: CodexSupervisorDecision = 'continue';
  let reason = 'job 正在运行，未发现明确跑偏或失败信号';

  if (job.status === 'completed') {
    decision = 'completed';
    reason = 'job 已完成';
  } else if (
    job.status === 'failed' ||
    /authentication token has been invalidated|auth(?:entication)? failed|401 unauthorized|no saved session found|missing environment variable|missing env|permission denied/i.test(
      lower,
    )
  ) {
    decision = 'failed';
    reason = '检测到失败、认证、会话缺失或权限相关信号';
  } else if (job.status === 'running' && /waiting for user input|press enter|confirm|continue\?|是否继续|需要确认|等待确认/i.test(lower)) {
    decision = 'needs_guidance';
    reason = '检测到 Codex 可能在等待确认或进一步指令';
  } else if (job.status === 'running' && idleTimeoutMs > 0 && idleMs > idleTimeoutMs) {
    decision = autoStop ? 'stop' : 'needs_guidance';
    reason = `检测到 job 长时间无输出（${Math.round(idleMs / 1000)}s）`;
  } else if (job.status === 'running' && input.instruction?.trim()) {
    decision = job.mode === 'pty' ? 'needs_guidance' : 'retry';
    reason = job.mode === 'pty' ? '收到监督指令，已准备注入交互式 worker' : 'exec worker 无法运行中注入，需要停止并重派';
  }

  job.supervisor.enabled = true;
  job.supervisor.autoStop = autoStop;
  job.supervisor.autoRetry = autoRetry;
  job.supervisor.idleTimeoutMs = idleTimeoutMs;
  job.supervisor.maxRetries = maxRetries ?? null;
  job.supervisor.lastCheckedAt = now.toISOString();
  job.supervisor.lastDecision = decision;
  job.supervisor.lastReason = reason;
  job.supervisor.checks += 1;
  recordJobEvent(job, 'supervisor', reason, {
    decision,
    idleMs,
    autoStop,
    autoRetry,
  });

  let followupJob: CodexResumeJob | undefined;
  if (decision === 'needs_guidance' && input.instruction?.trim() && job.mode === 'pty') {
    sendCodexJobGuidance(job.id, input.instruction, 'supervisor');
  }
  if ((decision === 'failed' || decision === 'retry' || decision === 'stop') && autoStop && job.status === 'running') {
    stopRuntimeJob(job, `Supervisor stopped job: ${reason}`);
  }
  const retryBlockedReason = autoRetry ? autoRetryBlockedReason(job, decision, reason) : null;
  if (retryBlockedReason) {
    recordJobEvent(job, 'supervisor', retryBlockedReason, {
      decision,
      retries: job.supervisor.retries,
      autoRetry,
    });
  } else if ((decision === 'failed' || decision === 'retry') && autoRetry && input.restart && (maxRetries == null || job.supervisor.retries < maxRetries)) {
    const prompt = [
      input.instruction?.trim() || '继续这个任务，修复上一次失败并完成验证。',
      '',
      '上一次 Codex worker 输出尾部：',
      job.outputTail.slice(-4000),
    ].join('\n');
    job.supervisor.retries += 1;
    followupJob = input.restart(publicJob(job), prompt);
  } else if ((decision === 'failed' || decision === 'retry') && autoRetry && maxRetries != null && job.supervisor.retries >= maxRetries) {
    recordJobEvent(job, 'supervisor', `Auto retry skipped because maxRetries=${maxRetries} was reached`, {
      decision,
      retries: job.supervisor.retries,
    });
  }

  persistJobs();
  return { job: publicJob(job), decision, reason, followupJob };
}

export function runCodexSupervisorSweep(options: CodexSupervisorLoopOptions = {}): Array<{
  job: CodexResumeJob;
  decision: CodexSupervisorDecision;
  reason: string;
  followupJob?: CodexResumeJob;
}> {
  const results: Array<{
    job: CodexResumeJob;
    decision: CodexSupervisorDecision;
    reason: string;
    followupJob?: CodexResumeJob;
  }> = [];
  for (const job of jobs.values()) {
    if (job.status !== 'running' || !job.supervisor.enabled) continue;
    const result = superviseCodexResumeJob({
      id: job.id,
      autoStop: options.autoStop ?? job.supervisor.autoStop,
      autoRetry: options.autoRetry ?? job.supervisor.autoRetry,
      idleTimeoutMs: options.idleTimeoutMs ?? options.staleOutputMs ?? job.supervisor.idleTimeoutMs ?? undefined,
      maxRetries: options.maxRetries ?? job.supervisor.maxRetries ?? undefined,
      restart: options.restart,
    });
    if (result) results.push(result);
  }
  return results;
}

export function startCodexSupervisorLoop(options: CodexSupervisorLoopOptions = {}): () => void {
  if (supervisorLoop) clearInterval(supervisorLoop);
  const intervalMs = Math.max(
    1000,
    options.intervalMs ?? options.checkIntervalMs ?? Number(process.env.CURATOR_CODEX_SUPERVISOR_INTERVAL_MS || 30_000),
  );
  const sweep = (): void => {
    runCodexSupervisorSweep(options);
  };
  if (options.runImmediately !== false) sweep();
  supervisorLoop = setInterval(sweep, intervalMs);
  supervisorLoop.unref?.();
  return () => {
    if (!supervisorLoop) return;
    clearInterval(supervisorLoop);
    supervisorLoop = null;
  };
}

function normalizePersistedJob(item: Partial<CodexResumeJob>): CodexJobRuntime {
  const supervisor = {
    ...defaultSupervisor(item.supervisor?.enabled ?? false),
    ...(item.supervisor ?? {}),
  };
  const job: CodexJobRuntime = {
    id: item.id ?? randomUUID(),
    sessionId: item.sessionId ?? '',
    machineId: item.machineId ?? '',
    mode: item.mode ?? 'exec',
    cwd: item.cwd ?? process.cwd(),
    command: item.command ?? '',
    prompt: item.prompt ?? '',
    status: item.status ?? 'stopped',
    startedAt: item.startedAt ?? new Date().toISOString(),
    updatedAt: item.updatedAt ?? new Date().toISOString(),
    completedAt: item.completedAt ?? null,
    exitCode: item.exitCode ?? null,
    signal: item.signal ?? null,
    outputTail: item.outputTail ?? '',
    outputBytes: item.outputBytes ?? Buffer.byteLength(item.outputTail ?? ''),
    changedFiles: item.changedFiles ?? [],
    error: item.error ?? null,
    tmuxName: item.tmuxName ?? null,
    guidance: item.guidance ?? [],
    supervisor: {
      ...supervisor,
      lastOutputAt: supervisor.lastOutputAt ?? (item.outputBytes ? item.updatedAt ?? null : null),
      lastOutputBytes: supervisor.lastOutputBytes ?? item.outputBytes ?? 0,
    },
    events: item.events ?? [],
    eventSeq: item.eventSeq ?? item.events?.reduce((max, event) => Math.max(max, event.seq), 0) ?? 0,
    policy: defaultPolicy(item.policy),
    policyState: {
      ...emptyPolicyState(),
      ...(item.policyState ?? {}),
      violations: item.policyState?.violations ?? [],
    },
    structuredReport: item.structuredReport ?? null,
  };
  if (!job.events.length) {
    recordJobEvent(job, 'started', 'Restored job from cache without historical events');
  }
  return job;
}

function loadPersistedJobs(): void {
  const path = jobsPath();
  if (!existsSync(path)) return;
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8')) as { jobs?: Partial<CodexResumeJob>[] };
    const env = createTerminalEnv();
    for (const item of payload.jobs ?? []) {
      const job = normalizePersistedJob(item);
      if (job.status === 'running' && job.mode === 'exec') {
        job.status = 'stopped';
        job.completedAt = job.completedAt ?? new Date().toISOString();
        job.error = job.error ?? '服务重启后 exec worker 进程不可恢复';
        recordJobEvent(job, 'status', job.error, { status: job.status });
      }
      if (job.status === 'running' && job.mode === 'pty' && job.tmuxName && !tmuxHasSession(job.tmuxName, env)) {
        job.status = 'stopped';
        job.completedAt = job.completedAt ?? new Date().toISOString();
        job.error = job.error ?? '服务重启后未找到对应 tmux session';
        recordJobEvent(job, 'status', job.error, { status: job.status });
      }
      updateStructuredReport(job);
      enforceJobPolicy(job);
      jobs.set(job.id, job);
    }
    persistJobs();
  } catch {
    // Ignore corrupt job cache; Curator can still start new jobs.
  }
}

loadPersistedJobs();
