import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import type { CodexSession } from './types.js';
import { createTerminalEnv, terminalProbeTarget } from './terminal.js';
import { classifyUnknownTerminalError } from './terminal-watch-ai.js';

const execFileAsync = promisify(execFile);
const probeCode = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'terminal-watch-probe.py')).toString('base64');
const WATCH_INTERVAL_MS = 60_000;
const QUIET_MS = 180_000;
const CONFIRM_MS = 60_000;
const RETRY_MS = 180_000;
const MAX_ATTEMPTS = 3;

type MonitoredSession = Pick<CodexSession, 'id' | 'agent' | 'machineId' | 'filePath'>;
type WatchStatus = 'checking' | 'running' | 'idle' | 'manual-paused' | 'client-connection-failed' | 'closed' | 'upstream-unhealthy' |
  'suspected-upstream-error' | 'recovering' | 'recovered' | 'waiting-for-user' | 'unknown';

interface Probe {
  sessions?: string[];
  pane?: boolean;
  status?: string;
  observedAt?: string;
  clockOffsetMs?: number;
  goalStatus?: string | null;
  taskStartedAt?: string;
  taskCompleteAt?: string;
  failedComplete?: boolean;
  abortedAt?: string;
  lastActivityAt?: string;
  lastUserAt?: string;
  upstreamError?: boolean;
  promptVisible?: boolean;
  diagnostic?: string;
  healthy?: boolean;
  sent?: boolean;
  reason?: string;
}

interface WatchRecord {
  session: MonitoredSession;
  status: WatchStatus;
  goalStatus: string | null;
  taskStartedAt: string | null;
  lastActivityAt: string | null;
  lastCheckedAt: string | null;
  providerHealthy: boolean | null;
  providerReason: string | null;
  attempts: number;
  suspectedAt: string | null;
  pendingAt: string | null;
  blockedAt: string | null;
  awaitingErrorClear: boolean;
  lastAction: string | null;
  lastReason: string | null;
}

function keyOf(session: MonitoredSession): string {
  return `${session.machineId}|||${session.agent}|||${session.id}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function laterThan(value: string | undefined | null, reference: string | undefined | null): boolean {
  return Boolean(value && (!reference || Date.parse(value) > Date.parse(reference)));
}

export function recoveryDecision(record: WatchRecord, probe: Probe, now: number): 'skip' | 'confirm' | 'health' | 'blocked' {
  if (!probe.pane || probe.status === 'closed' || probe.status === 'manual-paused' ||
      probe.status === 'client-connection-failed' || probe.status === 'retrying') return 'skip';
  if (!probe.upstreamError || !probe.promptVisible ||
      (probe.status !== 'running' && !(probe.status === 'idle' && probe.failedComplete))) return 'skip';
  if (!probe.taskStartedAt || (!probe.failedComplete && !laterThan(probe.taskStartedAt, probe.taskCompleteAt))) return 'skip';
  const lastActivity = Date.parse(probe.lastActivityAt || probe.taskStartedAt);
  if (!Number.isFinite(lastActivity) || now - (lastActivity + (probe.clockOffsetMs ?? 0)) < QUIET_MS) return 'skip';
  if (record.pendingAt && now - Date.parse(record.pendingAt) < RETRY_MS) return 'skip';
  if (record.attempts >= MAX_ATTEMPTS) return 'blocked';
  if (!record.suspectedAt || now - Date.parse(record.suspectedAt) < CONFIRM_MS) return 'confirm';
  return 'health';
}

export class TerminalWatch {
  private records = new Map<string, WatchRecord>();
  private scanning = false;
  private inFlight = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly stateFile: string;
  private readonly runner: (session: MonitoredSession, mode: 'inspect' | 'health' | 'send' | 'list', args?: string[]) => Promise<Probe>;
  private readonly isLeader: () => boolean;
  private leaderReady = false;

  constructor(stateFile: string, runner: (session: MonitoredSession, mode: 'inspect' | 'health' | 'send' | 'list', args?: string[]) => Promise<Probe> = runProbe, isLeader: () => boolean = () => true) {
    this.stateFile = stateFile;
    this.runner = runner;
    this.isLeader = isLeader;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as { records?: WatchRecord[] };
      this.records.clear();
      for (const record of saved.records ?? []) {
        if (record.session?.id && record.session.agent === 'codex') this.records.set(keyOf(record.session), record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan().catch(() => {}), WATCH_INTERVAL_MS);
    this.timer.unref();
    setTimeout(() => void this.scan().catch(() => {}), 3_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): Array<Omit<WatchRecord, 'session'> & { session: Omit<MonitoredSession, 'filePath'> }> {
    return [...this.records.values()].map(({ session, ...rest }) => ({
      ...rest,
      session: { id: session.id, machineId: session.machineId, agent: session.agent },
    }));
  }

  get(identity: MonitoredSession) {
    return this.list().find((record) => keyOf(record.session as MonitoredSession) === keyOf(identity)) ?? null;
  }

  private async ensureLeader(): Promise<boolean> {
    if (!this.isLeader()) {
      this.leaderReady = false;
      return false;
    }
    if (!this.leaderReady) {
      await this.load();
      this.leaderReady = true;
    }
    return true;
  }

  async watch(session: CodexSession, inspectNow = true): Promise<void> {
    if (!await this.ensureLeader()) return;
    if (session.agent !== 'codex') return;
    const identity: MonitoredSession = { id: session.id, agent: session.agent, machineId: session.machineId, filePath: session.filePath };
    const key = keyOf(identity);
    const existing = this.records.get(key);
    if (existing) {
      existing.session = identity;
    } else {
      this.records.set(key, {
        session: identity, status: 'checking', goalStatus: null, taskStartedAt: null,
        lastActivityAt: null, lastCheckedAt: null, providerHealthy: null, providerReason: null,
        attempts: 0, suspectedAt: null, pendingAt: null, blockedAt: null, awaitingErrorClear: false,
        lastAction: null, lastReason: null,
      });
    }
    await this.save();
    if (inspectNow) await this.check(key);
  }

  async enrollExisting(sessions: CodexSession[]): Promise<number> {
    if (!await this.ensureLeader()) return 0;
    const byMachine = new Map<string, CodexSession[]>();
    for (const session of sessions) {
      if (session.agent !== 'codex') continue;
      const entries = byMachine.get(session.machineId) ?? [];
      entries.push(session);
      byMachine.set(session.machineId, entries);
    }
    let registered = 0;
    for (const entries of byMachine.values()) {
      try {
        const live = new Set((await this.runner(entries[0], 'list')).sessions ?? []);
        for (const session of entries) {
          if (!live.has(session.id) || this.records.has(keyOf(session))) continue;
          await this.watch(session, false);
          registered += 1;
        }
      } catch { /* disconnected machines are retried when a terminal opens */ }
    }
    return registered;
  }

  async reset(identity: MonitoredSession): Promise<boolean> {
    if (!await this.ensureLeader()) return false;
    const key = keyOf(identity);
    const record = this.records.get(key);
    if (!record) return false;
    record.attempts = 0;
    record.pendingAt = null;
    record.blockedAt = null;
    record.suspectedAt = null;
    record.awaitingErrorClear = false;
    record.status = 'checking';
    record.lastReason = 'manual-reset';
    await this.save();
    await this.check(key);
    return true;
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    if (!await this.ensureLeader()) return;
    this.scanning = true;
    try {
      const keys = [...this.records.keys()];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async () => {
        while (next < keys.length) await this.check(keys[next++]);
      }));
    } finally {
      this.scanning = false;
    }
  }

  private async check(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record || this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const probe = await this.runner(record.session, 'inspect');
      const now = Date.now();
      record.lastCheckedAt = new Date(now).toISOString();
      record.goalStatus = probe.goalStatus ?? null;
      record.taskStartedAt = probe.taskStartedAt || null;
      record.lastActivityAt = probe.lastActivityAt || null;
      const remoteTime = (timestamp: string | undefined) => Date.parse(timestamp ?? '') + (probe.clockOffsetMs ?? 0);
      if (record.blockedAt && remoteTime(probe.lastUserAt) > Date.parse(record.blockedAt)) {
        record.attempts = 0;
        record.blockedAt = null;
        record.pendingAt = null;
        record.suspectedAt = null;
        record.awaitingErrorClear = false;
        record.lastReason = 'new-user-task';
      }
      // Remote clocks can drift; compare rollout timestamps in the Hub clock domain.
      // Codex can append task_started while send-keys is returning, so allow a small overlap.
      const sustainedProgress = record.pendingAt &&
        remoteTime(probe.taskStartedAt) >= Date.parse(record.pendingAt) - 5_000 &&
        remoteTime(probe.lastActivityAt) - Date.parse(record.pendingAt) > 60_000;
      if (record.pendingAt && ((remoteTime(probe.taskCompleteAt) > Date.parse(record.pendingAt) && !probe.failedComplete) || sustainedProgress)) {
        record.attempts = 0;
        record.pendingAt = null;
        record.suspectedAt = null;
        record.awaitingErrorClear = Boolean(probe.upstreamError);
        record.status = 'recovered';
        record.lastReason = 'task-continued-after-recovery';
        await this.save();
        return;
      }
      if (record.blockedAt) {
        record.status = 'waiting-for-user';
        await this.save();
        return;
      }
      if (probe.status === 'manual-paused' || probe.status === 'closed') record.awaitingErrorClear = false;
      if (record.awaitingErrorClear && probe.upstreamError) {
        record.status = 'running';
        await this.save();
        return;
      }
      if (!probe.upstreamError) record.awaitingErrorClear = false;
      let aiConfirmed = false;
      if (!probe.upstreamError && probe.diagnostic && probe.status === 'running' && probe.promptVisible &&
          now - Date.parse(probe.lastActivityAt || probe.taskStartedAt || '') >= QUIET_MS) {
        aiConfirmed = await classifyUnknownTerminalError(probe.diagnostic);
        probe.upstreamError = aiConfirmed;
      }
      const decision = recoveryDecision(record, probe, now);
      if (decision === 'skip') {
        record.status = probe.status === 'manual-paused' ? 'manual-paused' :
          probe.status === 'client-connection-failed' ? 'client-connection-failed' :
          probe.status === 'closed' ? 'closed' : probe.status === 'idle' ? 'idle' :
          probe.status === 'running' || probe.status === 'retrying' ? 'running' : 'unknown';
        if (probe.status === 'client-connection-failed') record.lastReason = 'codex-client-reconnect-failed';
        if (!probe.upstreamError) {
          record.suspectedAt = null;
          record.providerHealthy = null;
          record.providerReason = null;
        }
        await this.save();
        return;
      }
      if (decision === 'confirm') {
        record.suspectedAt ??= new Date(now).toISOString();
        record.status = 'suspected-upstream-error';
        await this.save();
        return;
      }
      if (decision === 'blocked') {
        record.blockedAt = new Date(now).toISOString();
        record.status = 'waiting-for-user';
        record.lastReason = 'three-recoveries-did-not-complete';
        await this.save();
        return;
      }
      const health = await this.runner(record.session, 'health');
      record.providerHealthy = health.healthy === true;
      record.providerReason = health.reason ?? null;
      if (!health.healthy) {
        record.status = 'upstream-unhealthy';
        await this.save();
        return;
      }
      if (!this.isLeader()) return;
      const message = probe.goalStatus === 'active' ? '/goal resume' : '继续';
      const dispatchAt = new Date().toISOString();
      const sent = await this.runner(record.session, 'send', [probe.taskStartedAt ?? '', message, aiConfirmed ? probe.diagnostic ?? '' : '']);
      if (!sent.sent) {
        record.status = 'unknown';
        record.lastReason = sent.reason ?? 'send-refused';
        await this.save();
        return;
      }
      record.attempts += 1;
      record.pendingAt = dispatchAt;
      record.lastAction = message;
      record.lastReason = 'upstream-healthy-recovery-sent';
      record.status = 'recovering';
      await this.save();
    } catch {
      record.status = 'unknown';
      record.lastReason = 'inspection-failed';
      await this.save();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private save(): Promise<void> {
    this.writing = this.writing.catch(() => undefined).then(async () => {
      const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ records: [...this.records.values()] }), { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    return this.writing;
  }
}

export async function runProbe(session: MonitoredSession, mode: 'inspect' | 'health' | 'send' | 'list', args: string[] = []): Promise<Probe> {
  const target = terminalProbeTarget(session);
  if (target.remote && !target.sshTarget) return { status: 'unknown', reason: 'ssh-target-unavailable' };
  const localMachineId = process.env.CURATOR_MACHINE_ID || hostname().split('.')[0];
  if (!target.remote && session.machineId !== localMachineId) return { status: 'unknown', reason: 'remote-target-unavailable' };
  const command = `exec "\${SHELL:-/bin/bash}" -lc ${shellQuote(`python3 -c "import base64;exec(base64.b64decode('${probeCode}'))" ${[mode, session.id, session.filePath, ...args].map(shellQuote).join(' ')}`)}`;
  const probeStartedAt = Date.now();
  let executable: string;
  let argv: string[];
  if (target.remote && target.sshTarget) {
    executable = target.sshCommand;
    argv = target.hostFirst ? [target.sshTarget, command] : [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target.sshTarget, command,
    ];
  } else {
    executable = process.env.SHELL || '/bin/bash';
    argv = ['-lc', command];
  }
  const { stdout } = await execFileAsync(executable, argv, {
    env: createTerminalEnv(), timeout: 35_000, maxBuffer: 64_000,
  });
  const line = stdout.trim().split('\n').at(-1);
  if (!line) throw new Error('Probe returned no result');
  const probe = JSON.parse(line) as Probe;
  if (mode === 'inspect' && probe.observedAt) {
    const remoteObservedAt = Date.parse(probe.observedAt);
    if (Number.isFinite(remoteObservedAt)) probe.clockOffsetMs = Math.round((probeStartedAt + Date.now()) / 2 - remoteObservedAt);
  }
  return probe;
}
