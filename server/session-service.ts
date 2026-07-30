import { stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { relative, sep } from 'node:path';
import {
  archiveSessionFilesBulk,
  archiveSessionFiles,
  copySessionToProject,
  countShellSnapshots,
  findJsonlFiles,
  getClaudeProjectsRoot,
  getCodexHome,
  getRecycleRoot,
  getSessionsRoot,
  isClaudeSessionPath,
  listRecycleArchives,
  purgeExpiredArchives,
  permanentlyDeleteArchive,
  restoreArchive,
  sameResolvedPath,
} from './file-ops.js';
import {
  EVALUATOR_WORKFLOW,
  isEvaluationWorkflowCompatible,
  isEvaluationWorkflowComplete,
} from './evaluation-workflow.js';
import { getCuratorRole } from './runtime-role.js';
import { hashTranscript, recordSessionAuditEvent } from './session-audit.js';
import {
  extractSessionId,
  parseRecentUserMessages,
  parseSessionFile,
  parseSessionHistory,
  parseSessionMessages,
  readCodexSessionLineage,
} from './session-parser.js';
import { CuratorStore } from './store.js';
import type {
  ActivityStatus,
  AgentKind,
  CodexSession,
  Evaluation,
  EvaluationOrigin,
  FailureKnowledgeCard,
  JobOutcome,
  ParsedMessage,
  PersistedState,
  Recommendation,
  RemoteMachine,
  ReviewPriority,
  RemoteEvaluationInput,
  RecentUserMessagesPage,
  SessionCompletenessIssue,
  SessionCompletenessReport,
  StoredEvaluation,
  UpdateCadence,
} from './types.js';

async function getEvaluationConcurrency(): Promise<number> {
  if (getCuratorRole() === 'worker') return 1;
  const { getRecommendedEvaluationConcurrency } = await import('./evaluator.js');
  return getRecommendedEvaluationConcurrency();
}

async function evaluateSessionWithModel(input: {
  sessionId: string;
  machineId: string;
  runId: string;
  evaluationOrigin: 'local-llm' | 'hub-remote';
  transcriptHash: string;
  messages: ParsedMessage[];
  userTurns: number;
  assistantTurns: number;
  cwd: string | null;
}): Promise<Evaluation> {
  const { evaluateSession } = await import('./evaluator.js');
  return evaluateSession(input);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

function readDurationEnv(name: string, fallback: number, max = 24 * 60 * 60 * 1000): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function evaluationQuietMs(): number {
  return readDurationEnv('CURATOR_EVALUATION_QUIET_MS', 60_000);
}

function auditPendingGraceMs(): number {
  return readDurationEnv('CURATOR_SESSION_AUDIT_PENDING_GRACE_MS', 15 * 60_000);
}

function evaluationNeedsRefresh(evaluation: StoredEvaluation): boolean {
  return evaluation.hermesNeedsRefresh === true ||
    evaluation.hermesRefreshStatus === 'pending' ||
    evaluation.hermesRefreshStatus === 'running' ||
    !isEvaluationWorkflowComplete(evaluation.workflow);
}

function hasCachedMetadata(cached: unknown): cached is {
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  shellSnapshotCount: number;
} {
  const item = cached as Record<string, unknown>;
  return (
    typeof item.messageCount === 'number' &&
    typeof item.userTurns === 'number' &&
    typeof item.assistantTurns === 'number' &&
    typeof item.shellSnapshotCount === 'number'
  );
}

function isCachedMessage(value: unknown): value is ParsedMessage | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.role === 'user' || item.role === 'assistant') &&
    typeof item.text === 'string' &&
    (typeof item.timestamp === 'string' || item.timestamp === null)
  );
}

function hasCachedConversationPreview(cached: unknown): cached is {
  lastUserMessage: ParsedMessage | null;
  lastAssistantMessage: ParsedMessage | null;
} {
  const item = cached as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(item, 'lastUserMessage') &&
    Object.prototype.hasOwnProperty.call(item, 'lastAssistantMessage') &&
    isCachedMessage(item.lastUserMessage) &&
    isCachedMessage(item.lastAssistantMessage)
  );
}

function sameCachedMessage(a: ParsedMessage | null | undefined, b: ParsedMessage | null): boolean {
  return (
    (a?.role ?? null) === (b?.role ?? null) &&
    (a?.text ?? null) === (b?.text ?? null) &&
    (a?.timestamp ?? null) === (b?.timestamp ?? null)
  );
}

function getMachineId(): string {
  return process.env.CURATOR_MACHINE_ID || process.env.HOSTNAME || hostname();
}

function getActivity(updatedAt: string | null): { activityStatus: ActivityStatus; lastActiveAt: string | null; inactiveDays: number | null } {
  if (!updatedAt) return { activityStatus: 'inactive', lastActiveAt: null, inactiveDays: null };
  const time = Date.parse(updatedAt);
  if (Number.isNaN(time)) return { activityStatus: 'inactive', lastActiveAt: updatedAt, inactiveDays: null };
  const inactiveDays = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  return {
    activityStatus: Date.now() - time <= 3 * 86_400_000 ? 'active' : 'inactive',
    lastActiveAt: updatedAt,
    inactiveDays,
  };
}

export function sessionBackfillSortTimeMs(input: { cachedUpdatedAt?: string | null; fileMtimeMs: number }): number {
  const cachedTime = input.cachedUpdatedAt ? Date.parse(input.cachedUpdatedAt) : Number.NaN;
  const validCachedTime = Number.isFinite(cachedTime) ? cachedTime : 0;
  const validFileTime = Number.isFinite(input.fileMtimeMs) ? input.fileMtimeMs : 0;
  return Math.max(validCachedTime, validFileTime);
}

function getCodexBin(): string {
  return process.env.CODEX_BIN || 'codex';
}

function verifyResumeCommand(cwd: string | null, id: string): { ok: boolean; output: string } {
  if (!cwd) return { ok: false, output: '缺少 cwd，无法验证 resume 命令' };
  const result = spawnSync('timeout', ['5', getCodexBin(), 'resume', '-C', cwd, id], {
    cwd,
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
    encoding: 'utf8',
    input: '\u0003',
    maxBuffer: 200_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const missing = /No saved session found|no saved session/i.test(output);
  return {
    ok: !missing && (result.status === 0 || result.status === 124 || output.length > 0),
    output: output.slice(0, 1200),
  };
}

export class UnsupportedSessionMigrationError extends Error {
  readonly code = 'CLAUDE_SESSION_MIGRATION_UNSUPPORTED';

  constructor(sessionId: string) {
    super(`Claude session migration is unsupported; resume the existing session in place: ${sessionId}`);
    this.name = 'UnsupportedSessionMigrationError';
  }
}

function cleanRemoteMachines(machines: RemoteMachine[] | undefined): RemoteMachine[] {
  const result: RemoteMachine[] = [];
  const seen = new Set<string>();
  for (const machine of machines ?? []) {
    const label = machine.label?.trim() || null;
    const host = machine.host?.trim() || null;
    const ip = machine.ip?.trim() || null;
    const user = machine.user?.trim() || null;
    const key = (host ?? ip ?? label ?? '').toLowerCase();
    if (!key) continue;
    if (['127.0.0.1', 'localhost', '::1'].includes(key)) continue;
    if (label && /^(本机|local|localhost)/i.test(label)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      label,
      host,
      ip,
      user,
      evidence: machine.evidence?.trim().slice(0, 160) ?? '',
    });
  }
  return result.slice(0, 8);
}

function buildEvaluationSearchText(input: {
  id?: string;
  title?: string;
  resumeCommand?: string;
  cwd?: string | null;
  machineId?: string;
  lastUserMessage?: ParsedMessage | null;
  lastAssistantMessage?: ParsedMessage | null;
  evaluation: Partial<Evaluation>;
}): string {
  const evaluation = input.evaluation;
  return [
    input.id ?? '',
    input.title ?? '',
    input.resumeCommand ?? '',
    input.cwd ?? '',
    input.machineId ?? '',
    input.lastUserMessage?.text ?? '',
    input.lastAssistantMessage?.text ?? '',
    evaluation.title ?? '',
    evaluation.summary ?? '',
    evaluation.detailedSummary ?? '',
    ...(evaluation.actualWorkdirs ?? []),
    ...(evaluation.directoryIndex ?? []),
    ...(evaluation.techStack ?? []),
    ...(evaluation.keywords ?? []),
    ...(evaluation.failureCards ?? []).flatMap((card) => [card.category, card.title, card.summary, card.evidence]),
    ...(evaluation.jobOutcomes ?? []).flatMap((outcome) => [
      outcome.status,
      outcome.goal,
      outcome.cwd ?? '',
      outcome.summary,
      outcome.failureReason ?? '',
      outcome.nextAction ?? '',
      ...outcome.changedFiles,
      ...outcome.tests,
    ]),
    evaluation.recommendedWorkdir ?? '',
    ...(evaluation.remoteMachines ?? []).map((machine) =>
      [machine.label, machine.host, machine.ip, machine.user].filter(Boolean).join(' ')
    ),
  ]
    .join(' ')
    .toLowerCase();
}

function classifyUpdate(input: {
  cached?: StoredEvaluation;
  bytes: number;
  mtimeMs: number;
  userTurns: number;
  messageCount: number;
}): { updateCadence: UpdateCadence; reviewPriority: ReviewPriority; reviewSignals: string[] } {
  if (!input.cached) {
    const activeStart = input.userTurns >= 12 || input.bytes >= 60_000;
    return {
      updateCadence: 'new',
      reviewPriority: activeStart ? 'review' : 'normal',
      reviewSignals: activeStart ? ['新会话信息量较大，建议完成一次完整理解和标题生成'] : ['新会话，等待首次完整评估'],
    };
  }

  const deltaTurns = Math.max(0, input.userTurns - (input.cached.userTurns ?? 0));
  const deltaMessages = Math.max(0, input.messageCount - (input.cached.messageCount ?? 0));
  const deltaBytes = Math.max(0, input.bytes - input.cached.bytes);
  const changed = input.bytes !== input.cached.bytes || input.mtimeMs !== input.cached.mtimeMs;
  const minutesSinceEvaluation = Math.max(0, (Date.now() - Date.parse(input.cached.evaluatedAt ?? '')) / 60_000);
  const recentlyEvaluated = Number.isFinite(minutesSinceEvaluation) && minutesSinceEvaluation <= 120;

  if (!changed && !isEvaluationWorkflowCompatible(input.cached.workflow)) {
    return {
      updateCadence: input.cached.updateCadence ?? 'new',
      reviewPriority: input.cached.reviewPriority ?? 'normal',
      reviewSignals: input.cached.reviewSignals?.length
        ? input.cached.reviewSignals
        : ['上次只是轻量扫描或待刷新标记，详情页需要完成完整评估'],
    };
  }

  if (!changed || (deltaTurns === 0 && deltaMessages === 0 && deltaBytes < 1200)) {
    return {
      updateCadence: 'quiet',
      reviewPriority: 'low',
      reviewSignals: ['会话未出现有效新增内容，降低复核频率'],
    };
  }

  if (deltaTurns >= 6 || deltaMessages >= 12 || deltaBytes >= 18_000 || (recentlyEvaluated && deltaTurns >= 2)) {
    return {
      updateCadence: 'high',
      reviewPriority: 'reunderstand',
      reviewSignals: [
        `新增 ${deltaTurns} 个用户回合、${deltaMessages} 条消息、${Math.round(deltaBytes / 1024)} KB 内容`,
        '会话更新频繁，需要重新理解整段目标并刷新标题、摘要和索引',
      ],
    };
  }

  if (deltaTurns >= 2 || deltaMessages >= 5 || deltaBytes >= 5_000) {
    return {
      updateCadence: 'medium',
      reviewPriority: 'review',
      reviewSignals: [
        `新增 ${deltaTurns} 个用户回合、${deltaMessages} 条消息`,
        '会话有实质变化，建议复核新增内容后再决定保留或删除',
      ],
    };
  }

  return {
    updateCadence: 'low',
    reviewPriority: 'normal',
    reviewSignals: ['会话仅低频小幅更新，保留旧摘要并等待详情页或手动重算'],
  };
}

function applyUpdateMeta(evaluation: Evaluation, updateMeta: ReturnType<typeof classifyUpdate>): Evaluation {
  const reviewSignals = updateMeta.reviewSignals.length ? updateMeta.reviewSignals : evaluation.reviewSignals;
  return {
    ...evaluation,
    updateCadence: updateMeta.updateCadence,
    reviewPriority: updateMeta.reviewPriority,
    reviewSignals,
    searchText: buildEvaluationSearchText({ evaluation }),
  };
}

function publicEvaluation(evaluation: Evaluation | StoredEvaluation): Evaluation {
  const summary = evaluation.summary || 'No summary available.';
  const hermesRefreshStatus = evaluation.hermesRefreshStatus ?? (evaluation.hermesNeedsRefresh ? 'pending' : 'never');
  const recommendation =
    evaluation.score <= 2 && evaluation.recommendation !== 'keep' ? 'delete' : evaluation.recommendation;
  const reasons =
    recommendation === 'delete' && evaluation.recommendation !== 'delete'
      ? [...evaluation.reasons, '已启用回收站，低分会话更积极归为建议删除']
      : evaluation.reasons;
  return {
    title: evaluation.title ?? summary.slice(0, 42) ?? '未命名会话',
    summary,
    detailedSummary: evaluation.detailedSummary ?? summary,
    hermesContext: evaluation.hermesContext ?? '',
    hermesContextUpdatedAt: evaluation.hermesContextUpdatedAt ?? null,
    hermesLastUsedAt: evaluation.hermesLastUsedAt ?? null,
    hermesLastJobId: evaluation.hermesLastJobId ?? null,
    hermesNeedsRefresh: hermesRefreshStatus === 'failed' ? true : evaluation.hermesNeedsRefresh ?? false,
    hermesRecalculatedAt: evaluation.hermesRecalculatedAt ?? null,
    hermesRefreshStatus,
    hermesRefreshError: evaluation.hermesRefreshError ?? null,
    recommendation,
    score: evaluation.score,
    reasons,
    actualWorkdirs: evaluation.actualWorkdirs ?? [],
    directoryIndex: evaluation.directoryIndex ?? evaluation.actualWorkdirs ?? [],
    techStack: evaluation.techStack ?? [],
    keywords: evaluation.keywords ?? [],
    failureCards: evaluation.failureCards ?? [],
    jobOutcomes: evaluation.jobOutcomes ?? [],
    searchText: evaluation.searchText ?? buildEvaluationSearchText({ evaluation }),
    updateCadence: evaluation.updateCadence ?? 'quiet',
    reviewPriority: evaluation.reviewPriority ?? 'normal',
    reviewSignals: evaluation.reviewSignals ?? [],
    cwdMatchesWorkdir: evaluation.cwdMatchesWorkdir ?? null,
    recommendedWorkdir: evaluation.recommendedWorkdir ?? null,
    remoteMachines: cleanRemoteMachines(evaluation.remoteMachines),
    evaluatedAt: evaluation.evaluatedAt,
    workflow: evaluation.workflow,
    model: evaluation.model ?? process.env.CURATOR_LLM_MODEL ?? process.env.MODEL ?? 'gpt-5.4',
    status: evaluation.status ?? 'fallback',
    error: evaluation.error ?? null,
    evaluationOrigin: evaluation.evaluationOrigin,
    evaluatedByMachineId: evaluation.evaluatedByMachineId ?? null,
    evaluationRunId: evaluation.evaluationRunId ?? null,
    transcriptHash: evaluation.transcriptHash ?? null,
  };
}

function fastEvaluation(input: {
  id: string;
  cwd: string | null;
  cached?: StoredEvaluation;
  userTurns: number;
  assistantTurns: number;
  messageCount: number;
  updateMeta?: ReturnType<typeof classifyUpdate>;
  transcriptHash?: string | null;
  runId?: string | null;
  evaluationOrigin: Extract<EvaluationOrigin, 'worker-fast' | 'rule-fallback'>;
}): Evaluation {
  if (input.cached?.summary) {
    const cached = publicEvaluation(input.cached);
    const updateMeta = input.updateMeta ?? {
      updateCadence: cached.updateCadence,
      reviewPriority: cached.reviewPriority,
      reviewSignals: cached.reviewSignals,
    };
    const needsRefresh = updateMeta.updateCadence !== 'quiet' || evaluationNeedsRefresh(input.cached);
    return {
      ...cached,
      ...updateMeta,
      workflow:
        updateMeta.updateCadence === 'quiet'
          ? cached.workflow
          : `${EVALUATOR_WORKFLOW}:needs-refresh:${updateMeta.updateCadence}`,
      reasons:
        updateMeta.updateCadence === 'quiet'
          ? cached.reasons
          : [...cached.reasons, ...updateMeta.reviewSignals].slice(-8),
      hermesNeedsRefresh: needsRefresh,
      hermesRefreshStatus: needsRefresh ? 'pending' : cached.hermesRefreshStatus,
      hermesRefreshError: needsRefresh ? null : cached.hermesRefreshError,
    };
  }
  const title = input.cwd?.split('/').filter(Boolean).at(-1) ?? input.id.slice(0, 12);
  const lowSubstance = input.userTurns <= 2 && input.messageCount <= 5;
  const actualWorkdirs = input.cwd ? [input.cwd] : [];
  const directoryIndex = input.cwd ? input.cwd.split('/').filter(Boolean).slice(-4) : [];
  const updateMeta = input.updateMeta ?? {
    updateCadence: 'new' as const,
    reviewPriority: 'normal' as const,
    reviewSignals: ['轻量列表快速扫描，等待完整 AI 摘要'],
  };
  const evaluation: Evaluation = {
    title,
    summary: input.cwd ? `会话位于 ${input.cwd}，尚未生成完整 AI 摘要。` : '尚未生成完整 AI 摘要。',
    detailedSummary: '',
    recommendation: lowSubstance ? 'delete' : 'review',
    score: lowSubstance ? 1 : 3,
    reasons: ['轻量列表快速扫描，点击详情或执行 AI 重算后生成完整依据', ...updateMeta.reviewSignals],
    actualWorkdirs,
    directoryIndex,
    techStack: [],
    keywords: directoryIndex,
    failureCards: [],
    jobOutcomes: [],
    searchText: '',
    hermesNeedsRefresh: true,
    hermesRecalculatedAt: null,
    hermesRefreshStatus: 'pending',
    hermesRefreshError: null,
    updateCadence: updateMeta.updateCadence,
    reviewPriority: updateMeta.reviewPriority,
    reviewSignals: updateMeta.reviewSignals,
    cwdMatchesWorkdir: input.cwd ? true : null,
    recommendedWorkdir: null,
    remoteMachines: [],
    evaluatedAt: new Date().toISOString(),
    workflow: `${EVALUATOR_WORKFLOW}:fast-list`,
    model: process.env.CURATOR_LLM_MODEL ?? process.env.MODEL ?? 'gpt-5.4',
    status: 'fallback',
    error: null,
    evaluationOrigin: input.evaluationOrigin,
    evaluatedByMachineId: getMachineId(),
    evaluationRunId: input.runId ?? null,
    transcriptHash: input.transcriptHash ?? null,
  };
  return {
    ...evaluation,
    searchText: buildEvaluationSearchText({ id: input.id, cwd: input.cwd, evaluation }),
  };
}

function enrichSession(base: Omit<CodexSession, 'agent' | 'resumeCommand' | 'machineId' | 'activityStatus' | 'lastActiveAt' | 'inactiveDays'>): CodexSession {
  const activity = getActivity(base.updatedAt);
  const agent: AgentKind = isClaudeSessionPath(base.filePath) ? 'claude' : 'codex';
  let evaluation = base.evaluation;
  const shouldPromoteToDelete =
    !base.kept &&
    evaluation.recommendation !== 'delete' &&
    (evaluation.score <= 2 ||
      (activity.activityStatus === 'inactive' && base.userTurns <= 5) ||
      (evaluation.actualWorkdirs.length === 0 && base.userTurns <= 6));
  if (shouldPromoteToDelete) {
    evaluation = {
      ...evaluation,
      recommendation: 'delete',
      reasons: [...evaluation.reasons, '已启用回收站，短会话或缺少项目目录的记录更积极归为建议删除'],
    };
  }
  return {
    ...base,
    agent,
    evaluation,
    resumeCommand: agent === 'claude' ? `claude --resume ${base.id}` : `codex resume ${base.id}`,
    machineId: getMachineId(),
    ...activity,
  };
}

export function sessionStateKey(sessionId: string, agent: AgentKind): string {
  return `${agent}|||${sessionId}`;
}

export function parseSessionStateKey(
  stateKey: string,
): { sessionId: string; agent: AgentKind } | null {
  const separatorIndex = stateKey.indexOf('|||');
  if (separatorIndex <= 0) return null;
  const agent = stateKey.slice(0, separatorIndex);
  const sessionId = stateKey.slice(separatorIndex + 3);
  if ((agent !== 'codex' && agent !== 'claude') || !sessionId) return null;
  return { sessionId, agent };
}

function sessionAgentForFile(filePath: string): AgentKind {
  return isClaudeSessionPath(filePath) ? 'claude' : 'codex';
}

export class SessionService {
  private codexHome = getCodexHome();
  private sessionsRoot = getSessionsRoot(this.codexHome);
  private claudeProjectsRoot = getClaudeProjectsRoot();
  private store: CuratorStore;
  private lastAuditFindingFingerprints = new Map<string, string>();
  private legacyStateMigrationPromise: Promise<PersistedState> | null = null;
  private codexSessionLineageCache = new Map<string, Promise<Awaited<ReturnType<typeof readCodexSessionLineage>>>>();
  private recentUserMessagesCache = new Map<
    string,
    {
      fileSize: number;
      fileMtimeMs: number;
      promise: Promise<Omit<RecentUserMessagesPage, 'fileSize' | 'fileMtimeMs' | 'cached'>>;
    }
  >();

  constructor(store: CuratorStore) {
    this.store = store;
  }

  getMeta() {
    return {
      machineId: getMachineId(),
      codexHome: this.codexHome,
      sessionsRoot: this.sessionsRoot,
      claudeProjectsRoot: this.claudeProjectsRoot,
      recycleRoot: getRecycleRoot(),
      recycleRetentionDays: Number(process.env.CURATOR_RECYCLE_RETENTION_DAYS || 30),
      deleteMode: 'archive-then-local-clean',
    };
  }

  // Session files come from two roots: the Codex sessions root and the Claude
  // Code projects root. Both hold *.jsonl transcripts; parseSessionFile detects
  // the schema per file, so search / index / context-pack cover both agents.
  private async codexSessionIsPrimary(filePath: string): Promise<boolean> {
    let lineage = this.codexSessionLineageCache.get(filePath);
    if (!lineage) {
      lineage = readCodexSessionLineage(filePath);
      this.codexSessionLineageCache.set(filePath, lineage);
      while (this.codexSessionLineageCache.size > 4096) {
        const oldestKey = this.codexSessionLineageCache.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        this.codexSessionLineageCache.delete(oldestKey);
      }
    } else {
      this.codexSessionLineageCache.delete(filePath);
      this.codexSessionLineageCache.set(filePath, lineage);
    }
    try {
      const result = await lineage;
      if (!result) {
        this.codexSessionLineageCache.delete(filePath);
        return true;
      }
      return !result.isSubagent;
    } catch {
      this.codexSessionLineageCache.delete(filePath);
      return true;
    }
  }

  private async discoverSessionFiles(options: { includeSubagents?: boolean } = {}): Promise<string[]> {
    const [codexFiles, claudeFiles] = await Promise.all([
      findJsonlFiles(this.sessionsRoot),
      findJsonlFiles(this.claudeProjectsRoot),
    ]);
    const primaryClaudeFiles = claudeFiles.filter((filePath) => {
      const segments = relative(this.claudeProjectsRoot, filePath).split(sep);
      return !segments.includes('subagents');
    });
    if (options.includeSubagents) return [...codexFiles, ...primaryClaudeFiles];
    const primaryCodexFlags = await mapLimit(codexFiles, 32, (filePath) => this.codexSessionIsPrimary(filePath));
    const primaryCodexFiles = codexFiles.filter((_, index) => primaryCodexFlags[index]);
    return [...primaryCodexFiles, ...primaryClaudeFiles];
  }

  private sessionStateIdentities(files: string[]): Array<{
    id: string;
    stateKey: string;
    agent: AgentKind;
    filePath: string;
  }> {
    return files.map((filePath) => {
      const id = extractSessionId(filePath);
      const agent = sessionAgentForFile(filePath);
      return {
        id,
        stateKey: sessionStateKey(id, agent),
        agent,
        filePath,
      };
    });
  }

  private async migrateLegacyStateForFiles(
    files: string[],
    force = false,
  ): Promise<PersistedState> {
    const migrate = () => this.store.migrateLegacySessionKeys(this.sessionStateIdentities(files));
    if (force) return migrate();
    if (!this.legacyStateMigrationPromise) {
      this.legacyStateMigrationPromise = migrate();
      return this.legacyStateMigrationPromise;
    }
    await this.legacyStateMigrationPromise;
    return this.store.load();
  }

  async ensureLegacyStateMigrated(): Promise<PersistedState> {
    if (this.legacyStateMigrationPromise) {
      await this.legacyStateMigrationPromise;
      return this.store.load();
    }
    return this.migrateLegacyStateForFiles(await this.discoverSessionFiles());
  }

  async getVisibleSessionStateKeys(): Promise<Set<string>> {
    return new Set(
      this.sessionStateIdentities(await this.discoverSessionFiles())
        .map((identity) => identity.stateKey),
    );
  }

  private async findSessionFileByIdentity(
    sessionId: string,
    agent?: AgentKind | null,
  ): Promise<{ sessionId: string; filePath: string; agent: AgentKind } | null> {
    const matches = (await this.discoverSessionFiles({ includeSubagents: true }))
      .filter((filePath) => extractSessionId(filePath) === sessionId)
      .map((filePath) => ({
        sessionId,
        filePath,
        agent: sessionAgentForFile(filePath),
      }))
      .filter((match) => !agent || match.agent === agent);
    if (matches.length > 1) {
      throw new Error(`Ambiguous session identity: ${sessionId}; agent is required`);
    }
    return matches[0] ?? null;
  }

  async listSessions(options: { refreshWorkflow?: boolean; fast?: boolean } = {}): Promise<CodexSession[]> {
    const curatorRole = getCuratorRole();
    const files = await this.discoverSessionFiles();
    const state = await this.migrateLegacyStateForFiles(files);
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const sessions: CodexSession[] = [];
    const parseQueue: Array<{ filePath: string; id: string; bytes: number; mtimeMs: number }> = [];
    let stateChanged = false;

    for (const filePath of files) {
      try {
        const fileStat = await stat(filePath);
        const id = extractSessionId(filePath);
        const agent = sessionAgentForFile(filePath);
        const stateKey = sessionStateKey(id, agent);
        const cached = state.evaluations[stateKey];
        const shellSnapshotCount = agent === 'codex' ? (shellSnapshotCounts.get(id) ?? 0) : 0;
        const customTitle = state.titles[stateKey];
        const kept = state.keptIds.includes(stateKey);

        const canUseCache =
          cached &&
          cached.filePath === filePath &&
          hasCachedMetadata(cached) &&
          hasCachedConversationPreview(cached) &&
          !options.refreshWorkflow &&
          isEvaluationWorkflowComplete(cached.workflow) &&
          cached.bytes === fileStat.size &&
          cached.mtimeMs === fileStat.mtimeMs;

        if (canUseCache) {
          sessions.push(enrichSession({
            id,
            filePath,
            cwd: cached.cwd,
            startedAt: cached.startedAt,
            updatedAt: cached.updatedAt,
            bytes: fileStat.size,
            messageCount: cached.messageCount,
            userTurns: cached.userTurns,
            assistantTurns: cached.assistantTurns,
            lastUserMessage: cached.lastUserMessage,
            lastAssistantMessage: cached.lastAssistantMessage,
            shellSnapshotCount,
            title: customTitle || cached.title || cached.summary.slice(0, 42) || id,
            customTitle: customTitle ?? null,
            kept,
            deleted: false,
            evaluation: publicEvaluation(cached),
          }));
          if (cached.shellSnapshotCount !== shellSnapshotCount) {
            cached.shellSnapshotCount = shellSnapshotCount;
            state.evaluations[stateKey] = cached;
            stateChanged = true;
          }
        } else {
          parseQueue.push({ filePath, id, bytes: fileStat.size, mtimeMs: fileStat.mtimeMs });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        console.warn('[SessionService] Skipping unreadable session file:', filePath, error);
      }
    }

    const evaluated = await mapLimit(parseQueue, await getEvaluationConcurrency(), async (item) => {
      const parsed = await parseSessionFile(item.filePath);
      const stateKey = sessionStateKey(parsed.id, parsed.source);
      const transcriptHash = hashTranscript(parsed.messages);
      const runId = randomUUID();
      await recordSessionAuditEvent({
        event: 'session-discovered',
        sessionId: parsed.id,
        machineId: getMachineId(),
        agent: parsed.source,
        runId,
        evaluationOrigin: curatorRole === 'worker' ? 'worker-fast' : 'local-llm',
        transcriptHash,
        messageCount: parsed.messageCount,
        userTurns: parsed.userTurns,
        assistantTurns: parsed.assistantTurns,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        model: null,
        status: 'discovered',
        error: null,
        details: {},
      }).catch(() => undefined);
      const cached = state.evaluations[stateKey];
      const updateMeta = classifyUpdate({
        cached,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        userTurns: parsed.userTurns,
        messageCount: parsed.messageCount,
      });
      const canReuseParsedCache =
        cached &&
        cached.filePath === parsed.filePath &&
        cached.mtimeMs === parsed.mtimeMs &&
        cached.bytes === parsed.bytes &&
        isEvaluationWorkflowComplete(cached.workflow) &&
        hasCachedMetadata(cached);
      const evaluationMode = canReuseParsedCache && !options.refreshWorkflow
        ? 'cache'
        : options.fast && !options.refreshWorkflow && curatorRole === 'hub'
          ? 'deferred'
          : curatorRole === 'worker'
            ? 'worker-fast'
            : 'model';
      if (evaluationMode === 'deferred') {
        await recordSessionAuditEvent({
          event: 'evaluation-deferred',
          sessionId: parsed.id,
          machineId: getMachineId(),
          agent: parsed.source,
          runId,
          evaluationOrigin: 'local-llm',
          transcriptHash,
          messageCount: parsed.messageCount,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          bytes: parsed.bytes,
          mtimeMs: parsed.mtimeMs,
          model: null,
          status: 'pending',
          error: null,
          details: { reason: 'fast-list-transcript-changed' },
        }).catch(() => undefined);
      } else if (evaluationMode === 'model' || evaluationMode === 'worker-fast') {
        await recordSessionAuditEvent({
          event: 'evaluation-started',
          sessionId: parsed.id,
          machineId: getMachineId(),
          agent: parsed.source,
          runId,
          evaluationOrigin: evaluationMode === 'worker-fast' ? 'worker-fast' : 'local-llm',
          transcriptHash,
          messageCount: parsed.messageCount,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          bytes: parsed.bytes,
          mtimeMs: parsed.mtimeMs,
          model: null,
          status: 'running',
          error: null,
          details: { reason: options.refreshWorkflow ? 'workflow-refresh' : 'new-or-changed-session' },
        }).catch(() => undefined);
      }
      const evaluation =
        canReuseParsedCache && !options.refreshWorkflow
          ? {
              title: cached.title ?? cached.summary.slice(0, 42) ?? '未命名会话',
              summary: cached.summary,
              detailedSummary: cached.detailedSummary ?? cached.summary,
              recommendation: cached.recommendation,
              score: cached.score,
              reasons: cached.reasons,
              actualWorkdirs: cached.actualWorkdirs ?? [],
              directoryIndex: cached.directoryIndex ?? cached.actualWorkdirs ?? [],
              techStack: cached.techStack ?? [],
              keywords: cached.keywords ?? [],
              failureCards: cached.failureCards ?? [],
              jobOutcomes: cached.jobOutcomes ?? [],
              searchText: cached.searchText ?? buildEvaluationSearchText({
                id: parsed.id,
                cwd: parsed.cwd,
                lastUserMessage: cached.lastUserMessage,
                lastAssistantMessage: cached.lastAssistantMessage,
                evaluation: cached,
              }),
              updateCadence: cached.updateCadence ?? 'quiet',
              reviewPriority: cached.reviewPriority ?? 'normal',
              reviewSignals: cached.reviewSignals ?? [],
              cwdMatchesWorkdir: cached.cwdMatchesWorkdir ?? null,
              recommendedWorkdir: cached.recommendedWorkdir ?? null,
              remoteMachines: cached.remoteMachines ?? [],
              evaluatedAt: cached.evaluatedAt,
              workflow: cached.workflow,
              model: cached.model ?? process.env.CURATOR_LLM_MODEL ?? process.env.MODEL ?? 'gpt-5.4',
              status: cached.status ?? 'fallback',
              error: cached.error ?? null,
              evaluationOrigin: cached.evaluationOrigin,
              evaluatedByMachineId: cached.evaluatedByMachineId ?? null,
              evaluationRunId: cached.evaluationRunId ?? null,
              transcriptHash: cached.transcriptHash ?? null,
            }
          : (options.fast && !options.refreshWorkflow) || curatorRole === 'worker'
            ? fastEvaluation({
                id: parsed.id,
                cwd: parsed.cwd,
                cached,
                userTurns: parsed.userTurns,
                assistantTurns: parsed.assistantTurns,
                messageCount: parsed.messageCount,
                updateMeta,
                transcriptHash,
                runId,
                evaluationOrigin: curatorRole === 'worker' ? 'worker-fast' : 'rule-fallback',
              })
            : applyUpdateMeta(
                await evaluateSessionWithModel({
                  sessionId: parsed.id,
                  machineId: getMachineId(),
                  runId,
                  evaluationOrigin: 'local-llm',
                  transcriptHash,
                  messages: parsed.messages,
                  userTurns: parsed.userTurns,
                  assistantTurns: parsed.assistantTurns,
                  cwd: parsed.cwd,
                }),
                updateMeta
              );

      if (evaluationMode === 'model' || evaluationMode === 'worker-fast') {
        await recordSessionAuditEvent({
          event: evaluation.status === 'failed' ? 'evaluation-failed' : 'evaluation-completed',
          sessionId: parsed.id,
          machineId: getMachineId(),
          agent: parsed.source,
          runId,
          evaluationOrigin: evaluation.evaluationOrigin ?? (evaluationMode === 'worker-fast' ? 'worker-fast' : 'local-llm'),
          transcriptHash,
          messageCount: parsed.messageCount,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          bytes: parsed.bytes,
          mtimeMs: parsed.mtimeMs,
          model: evaluation.model,
          status: evaluation.status,
          error: evaluation.error,
          details: {},
        }).catch(() => undefined);
      }

      if (
        !cached ||
        cached.filePath !== parsed.filePath ||
        cached.mtimeMs !== parsed.mtimeMs ||
        cached.bytes !== parsed.bytes ||
        cached.workflow !== evaluation.workflow ||
        !hasCachedMetadata(cached) ||
        !hasCachedConversationPreview(cached) ||
        !sameCachedMessage(cached.lastUserMessage, parsed.lastUserMessage) ||
        !sameCachedMessage(cached.lastAssistantMessage, parsed.lastAssistantMessage)
      ) {
        const shellSnapshotCount = shellSnapshotCounts.get(parsed.id) ?? 0;
        state.evaluations[stateKey] = {
          ...evaluation,
          filePath: parsed.filePath,
          mtimeMs: parsed.mtimeMs,
          bytes: parsed.bytes,
          cwd: parsed.cwd,
          startedAt: parsed.startedAt,
          updatedAt: parsed.updatedAt,
          messageCount: parsed.messageCount,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          lastUserMessage: parsed.lastUserMessage,
          lastAssistantMessage: parsed.lastAssistantMessage,
          shellSnapshotCount,
          searchText: buildEvaluationSearchText({
            id: parsed.id,
            cwd: parsed.cwd,
            lastUserMessage: parsed.lastUserMessage,
            lastAssistantMessage: parsed.lastAssistantMessage,
            evaluation,
          }),
        };
        stateChanged = true;
        await recordSessionAuditEvent({
          event: 'session-indexed',
          sessionId: parsed.id,
          machineId: getMachineId(),
          agent: parsed.source,
          runId,
          evaluationOrigin: evaluation.evaluationOrigin ?? (getCuratorRole() === 'worker' ? 'worker-fast' : 'local-llm'),
          transcriptHash,
          messageCount: parsed.messageCount,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          bytes: parsed.bytes,
          mtimeMs: parsed.mtimeMs,
          model: evaluation.model,
          status: evaluation.status,
          error: evaluation.error,
          details: {
            searchable: Boolean(evaluation.searchText?.trim()),
            aiAnalysisCurrent: evaluation.status === 'ok' &&
              evaluation.transcriptHash === transcriptHash &&
              isEvaluationWorkflowComplete(evaluation.workflow),
          },
        }).catch(() => undefined);
      }

      return { parsed, evaluation };
    });

    if (stateChanged) await this.store.save(state);

    for (const { parsed, evaluation } of evaluated) {
      const shellSnapshotCount = parsed.source === 'codex'
        ? (shellSnapshotCounts.get(parsed.id) ?? 0)
        : 0;
      const stateKey = sessionStateKey(parsed.id, parsed.source);
      const customTitle = state.titles[stateKey];
      const kept = state.keptIds.includes(stateKey);
      sessions.push(enrichSession({
        id: parsed.id,
        filePath: parsed.filePath,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        bytes: parsed.bytes,
        messageCount: parsed.messageCount,
        userTurns: parsed.userTurns,
        assistantTurns: parsed.assistantTurns,
        lastUserMessage: parsed.lastUserMessage,
        lastAssistantMessage: parsed.lastAssistantMessage,
        shellSnapshotCount,
        title: customTitle || evaluation.title || evaluation.summary.slice(0, 42) || parsed.id,
        customTitle: customTitle ?? null,
        kept,
        deleted: false,
        evaluation: publicEvaluation(evaluation),
      }));
    }

    return sessions.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
  }

  async getSession(id: string, agent?: AgentKind | null): Promise<CodexSession | null> {
    const sessions = await this.listSessions();
    const matches = sessions.filter((session) => session.id === id && (!agent || session.agent === agent));
    if (matches.length > 1) throw new Error(`Ambiguous session identity: ${id}; agent is required`);
    return matches[0] ?? null;
  }

  async getSessionFast(id: string, agent?: AgentKind | null): Promise<CodexSession | null> {
    const sessions = await this.listSessions({ fast: true });
    const matches = sessions.filter((session) => session.id === id && (!agent || session.agent === agent));
    if (matches.length > 1) throw new Error(`Ambiguous session identity: ${id}; agent is required`);
    return matches[0] ?? null;
  }

  async getSessionHistory(
    id: string,
    options: { limit?: number; beforeIndex?: number | null; agent?: AgentKind | null } = {},
  ) {
    const session = await this.getSessionFast(id, options.agent);
    if (!session) throw new Error(`Session not found: ${id}`);
    return parseSessionHistory({
      filePath: session.filePath,
      limit: options.limit ?? 80,
      beforeIndex: options.beforeIndex ?? null,
    });
  }

  async getRecentUserMessages(
    filePath: string,
    limit = 4,
  ): Promise<RecentUserMessagesPage> {
    const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
    const fileStat = await stat(filePath);
    const cacheKey = `${filePath}|||${boundedLimit}`;
    const cached = this.recentUserMessagesCache.get(cacheKey);
    if (
      cached &&
      cached.fileSize === fileStat.size &&
      cached.fileMtimeMs === fileStat.mtimeMs
    ) {
      this.recentUserMessagesCache.delete(cacheKey);
      this.recentUserMessagesCache.set(cacheKey, cached);
      return {
        ...(await cached.promise),
        fileSize: cached.fileSize,
        fileMtimeMs: cached.fileMtimeMs,
        cached: true,
      };
    }

    const entry = {
      fileSize: fileStat.size,
      fileMtimeMs: fileStat.mtimeMs,
      promise: parseRecentUserMessages({ filePath, limit: boundedLimit }),
    };
    this.recentUserMessagesCache.set(cacheKey, entry);
    while (this.recentUserMessagesCache.size > 128) {
      const oldestKey = this.recentUserMessagesCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.recentUserMessagesCache.delete(oldestKey);
    }
    try {
      return {
        ...(await entry.promise),
        fileSize: entry.fileSize,
        fileMtimeMs: entry.fileMtimeMs,
        cached: false,
      };
    } catch (error) {
      if (this.recentUserMessagesCache.get(cacheKey) === entry) {
        this.recentUserMessagesCache.delete(cacheKey);
      }
      throw error;
    }
  }

  async getSessionMessages(
    id: string,
    options: {
      limit?: number | null;
      beforeIndex?: number | null;
      afterIndex?: number | null;
      full?: boolean;
      preserveWhitespace?: boolean;
      agent?: AgentKind | null;
    } = {}
  ) {
    const found = await this.findSessionFileByIdentity(id, options.agent);
    if (!found) throw new Error(`Session not found: ${id}`);
    return parseSessionMessages({
      filePath: found.filePath,
      limit: options.limit ?? null,
      beforeIndex: options.beforeIndex ?? null,
      afterIndex: options.afterIndex ?? null,
      full: options.full,
      preserveWhitespace: options.preserveWhitespace,
    });
  }

  async getRemoteEvaluationInput(id: string, agent?: AgentKind | null): Promise<RemoteEvaluationInput> {
    const found = await this.findSessionFileByIdentity(id, agent);
    if (!found) throw new Error(`Session not found: ${id}`);
    const parsed = await parseSessionFile(found.filePath);
    const transcriptHash = hashTranscript(parsed.messages);
    await recordSessionAuditEvent({
      event: 'history-read',
      sessionId: parsed.id,
      machineId: getMachineId(),
      agent: parsed.source,
      runId: null,
      evaluationOrigin: null,
      transcriptHash,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      model: null,
      status: 'ok',
      error: null,
      details: { purpose: 'hub-remote-evaluation-input' },
    }).catch(() => undefined);
    return {
      sessionId: parsed.id,
      machineId: getMachineId(),
      agent: parsed.source,
      cwd: parsed.cwd,
      updatedAt: parsed.updatedAt,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      transcriptHash,
      messages: parsed.messages,
    };
  }

  async applyHubEvaluation(input: {
    sessionId: string;
    agent: AgentKind;
    hubMachineId: string;
    runId: string;
    transcriptHash: string;
    reason: string;
    evaluation: Evaluation;
  }) {
    const found = await this.findSessionFileByIdentity(input.sessionId, input.agent);
    if (!found) throw new Error(`Session not found: ${input.sessionId}`);
    const parsed = await parseSessionFile(found.filePath);
    const currentTranscriptHash = hashTranscript(parsed.messages);
    if (currentTranscriptHash !== input.transcriptHash) {
      await recordSessionAuditEvent({
        event: 'evaluation-failed',
        sessionId: parsed.id,
        machineId: getMachineId(),
        agent: parsed.source,
        runId: input.runId,
        evaluationOrigin: 'hub-remote',
        transcriptHash: currentTranscriptHash,
        messageCount: parsed.messageCount,
        userTurns: parsed.userTurns,
        assistantTurns: parsed.assistantTurns,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        model: input.evaluation.model,
        status: 'stale-transcript',
        error: 'Transcript changed while Hub evaluation was running',
        details: { expectedTranscriptHash: input.transcriptHash },
      }).catch(() => undefined);
      throw new Error('Transcript changed while Hub evaluation was running');
    }

    const state = await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(parsed.id, parsed.source);
    const cached = state.evaluations[stateKey];
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const evaluation: Evaluation = {
      ...input.evaluation,
      evaluationOrigin: 'hub-remote',
      evaluatedByMachineId: input.hubMachineId,
      evaluationRunId: input.runId,
      transcriptHash: currentTranscriptHash,
      hermesLastUsedAt: cached?.hermesLastUsedAt ?? input.evaluation.hermesLastUsedAt ?? null,
      hermesLastJobId: cached?.hermesLastJobId ?? input.evaluation.hermesLastJobId ?? null,
      hermesNeedsRefresh: input.evaluation.status === 'failed',
      hermesRefreshStatus: input.evaluation.status === 'failed' ? 'failed' : 'ok',
      hermesRefreshError: input.evaluation.error ?? null,
      reviewSignals: [`Hub 中央评估：${input.reason}`, ...(input.evaluation.reviewSignals ?? [])].slice(0, 6),
    };
    await this.store.setEvaluation(stateKey, {
      ...evaluation,
      filePath: parsed.filePath,
      mtimeMs: parsed.mtimeMs,
      bytes: parsed.bytes,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      lastUserMessage: parsed.lastUserMessage,
      lastAssistantMessage: parsed.lastAssistantMessage,
      shellSnapshotCount: parsed.source === 'codex'
        ? (shellSnapshotCounts.get(parsed.id) ?? 0)
        : 0,
      searchText: buildEvaluationSearchText({
        id: parsed.id,
        cwd: parsed.cwd,
        lastUserMessage: parsed.lastUserMessage,
        lastAssistantMessage: parsed.lastAssistantMessage,
        evaluation,
      }),
    });
    await recordSessionAuditEvent({
      event: 'evaluation-published',
      sessionId: parsed.id,
      machineId: getMachineId(),
      agent: parsed.source,
      runId: input.runId,
      evaluationOrigin: 'hub-remote',
      transcriptHash: currentTranscriptHash,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      model: evaluation.model,
      status: evaluation.status,
      error: evaluation.error,
      details: { hubMachineId: input.hubMachineId, reason: input.reason },
    }).catch(() => undefined);
    return {
      id: parsed.id,
      machineId: getMachineId(),
      status: evaluation.status,
      model: evaluation.model,
      runId: input.runId,
      transcriptHash: currentTranscriptHash,
    };
  }

  async auditCompleteness(): Promise<SessionCompletenessReport> {
    const generatedAt = new Date().toISOString();
    const nowMs = Date.now();
    const machineId = getMachineId();
    const quietMs = evaluationQuietMs();
    const pendingGraceMs = Math.max(quietMs, auditPendingGraceMs());
    const [files, allFiles] = await Promise.all([
      this.discoverSessionFiles(),
      this.discoverSessionFiles({ includeSubagents: true }),
    ]);
    const state = await this.migrateLegacyStateForFiles(files);
    const parsedResults = await mapLimit(files, 4, async (filePath) => {
      try {
        return { parsed: await parseSessionFile(filePath), filePath, error: null };
      } catch (error) {
        return {
          parsed: null,
          filePath,
          error: error instanceof Error ? error.message.slice(0, 240) : 'Unreadable session file',
        };
      }
    });
    const parsedSessions = parsedResults.flatMap((item) => (item.parsed ? [item.parsed] : []));
    const unreadableFiles = parsedResults
      .filter((item) => !item.parsed)
      .map((item) => ({ filePath: item.filePath, error: item.error ?? 'Unreadable session file' }));
    const parsedStateKeys = new Set(
      parsedSessions.map((parsed) => sessionStateKey(parsed.id, parsed.source)),
    );
    const issues: SessionCompletenessIssue[] = [];
    const pending: SessionCompletenessIssue[] = [];
    const skipped: SessionCompletenessIssue[] = [];
    let stateChanged = false;
    let indexedSessions = 0;
    let searchableSessions = 0;
    let historyReadableSessions = 0;
    let evaluationOk = 0;
    let evaluationFallback = 0;
    let evaluationFailed = 0;
    let evaluationMissing = 0;
    let eligibleSessions = 0;
    let fullyEvaluatedSessions = 0;
    let pendingEvaluationSessions = 0;
    let metadataOnlySessions = 0;
    let activeWriteSessions = 0;
    let transcriptVerified = 0;
    let staleIndex = 0;

    for (const parsed of parsedSessions) {
      const stateKey = sessionStateKey(parsed.id, parsed.source);
      const cached = state.evaluations[stateKey];
      const transcriptHash = hashTranscript(parsed.messages);
      const ageMs = Math.max(0, nowMs - parsed.mtimeMs);
      const metadataOnly = parsed.messageCount <= 0;
      const recentlyModified = ageMs < quietMs;
      const reasons: string[] = [];
      const metadataMatches = Boolean(
        cached &&
        cached.filePath === parsed.filePath &&
        cached.bytes === parsed.bytes &&
        cached.mtimeMs === parsed.mtimeMs,
      );
      if (metadataMatches) indexedSessions += 1;
      else {
        if (cached) {
          staleIndex += 1;
          reasons.push('stale-index');
        } else {
          evaluationMissing += 1;
          reasons.push('missing-index');
        }
      }
      if (metadataOnly) metadataOnlySessions += 1;
      else {
        eligibleSessions += 1;
        historyReadableSessions += 1;
      }
      if (cached?.searchText?.trim()) searchableSessions += 1;
      else if (!metadataOnly) reasons.push('not-searchable');

      if (cached) {
        if (cached.status === 'ok') evaluationOk += 1;
        else if (cached.status === 'fallback') {
          evaluationFallback += 1;
          reasons.push('evaluation-fallback');
        } else {
          evaluationFailed += 1;
          reasons.push('evaluation-failed');
        }
        if (metadataMatches && !cached.transcriptHash) {
          cached.transcriptHash = transcriptHash;
          cached.evaluationOrigin = cached.workflow.endsWith(':fast-list') ? 'worker-fast' : 'local-llm';
          cached.evaluatedByMachineId = cached.evaluatedByMachineId ?? machineId;
          state.evaluations[stateKey] = cached;
          stateChanged = true;
        }
        if (cached.transcriptHash === transcriptHash) transcriptVerified += 1;
        else if (!metadataOnly) reasons.push('transcript-unverified');
      } else {
        if (!metadataOnly) reasons.push('evaluation-missing');
      }

      if (metadataOnly) {
        skipped.push({
          sessionId: parsed.id,
          agent: parsed.source,
          filePath: parsed.filePath,
          classification: 'skipped',
          reasons: ['metadata-only'],
          transcriptHash,
          evaluationStatus: cached?.status ?? 'missing',
          evaluationOrigin: cached?.evaluationOrigin ?? null,
          messageCount: parsed.messageCount,
          mtimeMs: parsed.mtimeMs,
          ageMs,
        });
        continue;
      }

      const refreshPending = Boolean(cached && evaluationNeedsRefresh(cached));
      const analysisCurrent = Boolean(
        cached &&
        cached.status === 'ok' &&
        metadataMatches &&
        cached.transcriptHash === transcriptHash &&
        cached.searchText?.trim() &&
        !refreshPending,
      );
      if (analysisCurrent) {
        fullyEvaluatedSessions += 1;
        continue;
      }

      if (refreshPending) reasons.push('evaluation-pending');
      if (recentlyModified) {
        reasons.push('active-write');
        activeWriteSessions += 1;
      }
      const uniqueReasons = [...new Set(reasons)];
      const isPending = recentlyModified || (refreshPending && ageMs < pendingGraceMs);
      const finding: SessionCompletenessIssue = {
        sessionId: parsed.id,
        agent: parsed.source,
        filePath: parsed.filePath,
        classification: isPending ? 'pending' : 'actionable',
        reasons: uniqueReasons,
        transcriptHash,
        evaluationStatus: cached?.status ?? 'missing',
        evaluationOrigin: cached?.evaluationOrigin ?? null,
        messageCount: parsed.messageCount,
        mtimeMs: parsed.mtimeMs,
        ageMs,
      };
      if (isPending) {
        pendingEvaluationSessions += 1;
        pending.push(finding);
      } else {
        issues.push(finding);
      }
    }

    if (stateChanged) await this.store.save(state);
    const existingStateKeys = new Set(this.sessionStateIdentities(allFiles).map((item) => item.stateKey));
    const orphanedEvaluationIds = Object.keys(state.evaluations)
      .filter((stateKey) => parseSessionStateKey(stateKey) && !existingStateKeys.has(stateKey));
    const report: SessionCompletenessReport = {
      generatedAt,
      machineId,
      role: getCuratorRole(),
      sessionIds: [...parsedStateKeys].sort(),
      counts: {
        discoveredFiles: files.length,
        parsedSessions: parsedSessions.length,
        indexedSessions,
        searchableSessions,
        historyReadableSessions,
        evaluationOk,
        evaluationFallback,
        evaluationFailed,
        evaluationMissing,
        eligibleSessions,
        fullyEvaluatedSessions,
        pendingEvaluationSessions,
        metadataOnlySessions,
        activeWriteSessions,
        actionableIssues: issues.length + unreadableFiles.length,
        transcriptVerified,
        staleIndex,
        unreadableFiles: unreadableFiles.length,
        orphanedEvaluations: orphanedEvaluationIds.length,
      },
      issues,
      pending,
      skipped,
      unreadableFiles,
      orphanedEvaluationIds,
    };

    await recordSessionAuditEvent({
      event: 'completeness-scan',
      sessionId: null,
      machineId,
      agent: null,
      runId: null,
      evaluationOrigin: null,
      transcriptHash: null,
      messageCount: null,
      userTurns: null,
      assistantTurns: null,
      bytes: null,
      mtimeMs: null,
      model: null,
      status: issues.length || unreadableFiles.length ? 'issues' : pending.length ? 'pending' : 'ok',
      error: null,
      details: {
        discoveredFiles: files.length,
        parsedSessions: parsedSessions.length,
        issues: issues.length,
        pending: pending.length,
        skipped: skipped.length,
        fullyEvaluatedSessions,
        eligibleSessions,
        unreadableFiles: unreadableFiles.length,
        orphanedEvaluations: orphanedEvaluationIds.length,
      },
    }).catch(() => undefined);

    const currentFingerprints = new Map<string, string>();
    for (const finding of [...issues, ...pending, ...skipped]) {
      const fingerprint = `${finding.classification}:${finding.reasons.slice().sort().join(',')}`;
      const findingKey = finding.agent
        ? sessionStateKey(finding.sessionId, finding.agent)
        : `unknown|||${finding.sessionId}`;
      currentFingerprints.set(findingKey, fingerprint);
      if (this.lastAuditFindingFingerprints.get(findingKey) === fingerprint) continue;
      await recordSessionAuditEvent({
        event: finding.classification === 'actionable'
          ? 'completeness-issue'
          : finding.classification === 'pending'
            ? 'completeness-pending'
            : 'completeness-skipped',
        sessionId: finding.sessionId,
        machineId,
        agent: finding.agent,
        runId: null,
        evaluationOrigin: finding.evaluationOrigin,
        transcriptHash: finding.transcriptHash,
        messageCount: finding.messageCount,
        userTurns: null,
        assistantTurns: null,
        bytes: null,
        mtimeMs: finding.mtimeMs,
        model: null,
        status: finding.classification === 'actionable' ? finding.evaluationStatus : finding.classification,
        error: null,
        details: {
          classification: finding.classification,
          reasons: finding.reasons.slice().sort().join(','),
          ageMs: finding.ageMs,
        },
      }).catch(() => undefined);
    }
    for (const stateKey of this.lastAuditFindingFingerprints.keys()) {
      if (currentFingerprints.has(stateKey)) continue;
      const identity = parseSessionStateKey(stateKey);
      if (!identity) continue;
      await recordSessionAuditEvent({
        event: 'completeness-recovered',
        sessionId: identity.sessionId,
        machineId,
        agent: identity.agent,
        runId: null,
        evaluationOrigin: null,
        transcriptHash: null,
        messageCount: null,
        userTurns: null,
        assistantTurns: null,
        bytes: null,
        mtimeMs: null,
        model: null,
        status: 'ok',
        error: null,
        details: {},
      }).catch(() => undefined);
    }
    this.lastAuditFindingFingerprints = currentFingerprints;
    return report;
  }

  async markHermesSessionUsed(
    id: string,
    agent: AgentKind,
    jobId: string | null,
  ): Promise<void> {
    await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(id, agent);
    await this.store.updateEvaluation(stateKey, (cached) => cached ? {
      ...cached,
      hermesLastUsedAt: new Date().toISOString(),
      hermesLastJobId: jobId,
      hermesNeedsRefresh: true,
      hermesRefreshStatus: 'pending',
      hermesRefreshError: null,
    } : null);
  }

  async markSessionEvaluationRefreshQueued(
    id: string,
    agent: AgentKind,
    reason = 'manual',
  ): Promise<void> {
    await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(id, agent);
    await this.store.updateEvaluation(stateKey, (cached) => cached ? {
      ...cached,
      hermesNeedsRefresh: true,
      hermesRefreshStatus: 'pending',
      hermesRefreshError: null,
      reviewSignals: [`已加入 AI 重算队列：${reason}`, ...(cached.reviewSignals ?? [])].slice(0, 6),
    } : null);
  }

  async refreshSessionEvaluation(
    id: string,
    reason = 'manual',
    agent?: AgentKind | null,
  ) {
    const found = await this.findSessionFileByIdentity(id, agent);
    if (!found) throw new Error(`Session not found: ${id}`);
    const parsed = await parseSessionFile(found.filePath);
    const transcriptHash = hashTranscript(parsed.messages);
    const runId = randomUUID();
    const state = await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(id, parsed.source);
    const cached = state.evaluations[stateKey];
    const updateMeta = classifyUpdate({
      cached,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      userTurns: parsed.userTurns,
      messageCount: parsed.messageCount,
    });
    if (cached) {
      await this.store.updateEvaluation(stateKey, (latest) => latest ? {
        ...latest,
        hermesNeedsRefresh: true,
        hermesRefreshStatus: 'running',
        hermesRefreshError: null,
      } : null);
    }
    await recordSessionAuditEvent({
      event: 'evaluation-started',
      sessionId: parsed.id,
      machineId: getMachineId(),
      agent: parsed.source,
      runId,
      evaluationOrigin: getCuratorRole() === 'worker' ? 'worker-fast' : 'local-llm',
      transcriptHash,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      model: null,
      status: 'running',
      error: null,
      details: { reason },
    }).catch(() => undefined);
    try {
    const evaluation = getCuratorRole() === 'worker'
      ? fastEvaluation({
          id: parsed.id,
          cwd: parsed.cwd,
          cached,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          messageCount: parsed.messageCount,
          updateMeta,
          transcriptHash,
          runId,
          evaluationOrigin: 'worker-fast',
        })
      : applyUpdateMeta(
          await evaluateSessionWithModel({
            sessionId: parsed.id,
            machineId: getMachineId(),
            runId,
            evaluationOrigin: 'local-llm',
            transcriptHash,
            messages: parsed.messages,
            userTurns: parsed.userTurns,
            assistantTurns: parsed.assistantTurns,
            cwd: parsed.cwd,
          }),
          {
            ...updateMeta,
            reviewSignals: [`AI 重算：${reason}`, ...updateMeta.reviewSignals].slice(0, 6),
          }
        );
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const refreshedAt = new Date().toISOString();
    const refreshedEvaluation: StoredEvaluation = {
      ...evaluation,
      hermesLastUsedAt: cached?.hermesLastUsedAt ?? null,
      hermesLastJobId: cached?.hermesLastJobId ?? null,
      hermesNeedsRefresh: evaluation.status === 'failed',
      hermesRecalculatedAt: evaluation.status === 'failed' ? cached?.hermesRecalculatedAt ?? null : refreshedAt,
      hermesRefreshStatus: evaluation.status === 'failed' ? 'failed' : 'ok',
      hermesRefreshError: evaluation.error ?? null,
      filePath: parsed.filePath,
      mtimeMs: parsed.mtimeMs,
      bytes: parsed.bytes,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      lastUserMessage: parsed.lastUserMessage,
      lastAssistantMessage: parsed.lastAssistantMessage,
      shellSnapshotCount: parsed.source === 'codex'
        ? (shellSnapshotCounts.get(parsed.id) ?? 0)
        : 0,
      searchText: buildEvaluationSearchText({
        id: parsed.id,
        cwd: parsed.cwd,
        lastUserMessage: parsed.lastUserMessage,
        lastAssistantMessage: parsed.lastAssistantMessage,
        evaluation,
      }),
    };
    await this.store.updateEvaluation(stateKey, (latest) => ({
      ...refreshedEvaluation,
      hermesLastUsedAt: latest?.hermesLastUsedAt ?? refreshedEvaluation.hermesLastUsedAt,
      hermesLastJobId: latest?.hermesLastJobId ?? refreshedEvaluation.hermesLastJobId,
      failureCards: latest?.failureCards ?? refreshedEvaluation.failureCards,
      jobOutcomes: latest?.jobOutcomes ?? refreshedEvaluation.jobOutcomes,
    }));
    await recordSessionAuditEvent({
      event: evaluation.status === 'failed' ? 'evaluation-failed' : 'evaluation-completed',
      sessionId: parsed.id,
      machineId: getMachineId(),
      agent: parsed.source,
      runId,
      evaluationOrigin: evaluation.evaluationOrigin ?? (getCuratorRole() === 'worker' ? 'worker-fast' : 'local-llm'),
      transcriptHash,
      messageCount: parsed.messageCount,
      userTurns: parsed.userTurns,
      assistantTurns: parsed.assistantTurns,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      model: evaluation.model,
      status: evaluation.status,
      error: evaluation.error,
      details: { reason },
    }).catch(() => undefined);
    return {
      id,
      machineId: getMachineId(),
      status: evaluation.status,
      title: evaluation.title,
      model: evaluation.model,
      error: evaluation.error,
      runId,
      transcriptHash,
      evaluationOrigin: evaluation.evaluationOrigin,
    };
    } catch (error) {
      await this.store.updateEvaluation(stateKey, (latest) => {
        const current = latest ?? cached;
        return current ? {
          ...current,
          hermesNeedsRefresh: true,
          hermesRefreshStatus: 'failed',
          hermesRefreshError: error instanceof Error ? error.message.slice(0, 240) : 'AI 重算失败',
        } : null;
      });
      await recordSessionAuditEvent({
        event: 'evaluation-failed',
        sessionId: parsed.id,
        machineId: getMachineId(),
        agent: parsed.source,
        runId,
        evaluationOrigin: getCuratorRole() === 'worker' ? 'worker-fast' : 'local-llm',
        transcriptHash,
        messageCount: parsed.messageCount,
        userTurns: parsed.userTurns,
        assistantTurns: parsed.assistantTurns,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        model: null,
        status: 'failed',
        error: error instanceof Error ? error.message : 'AI refresh failed',
        details: { reason },
      }).catch(() => undefined);
      throw error;
    }
  }

  async appendFailureKnowledgeCard(input: {
    sessionId: string;
    agent: AgentKind;
    jobId: string;
    outputTail?: string | null;
    error?: string | null;
    policyViolations?: Array<{ reason?: string; pattern?: string; severity?: string }>;
  }): Promise<void> {
    await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(input.sessionId, input.agent);
    const evidence = [input.error, ...(input.policyViolations ?? []).map((item) => item.reason), input.outputTail]
      .filter(Boolean)
      .join('\n')
      .slice(-1800);
    const lower = evidence.toLowerCase();
    const category: FailureKnowledgeCard['category'] =
      /auth|401|token|signing in/i.test(lower)
        ? 'auth'
        : /missing environment variable|missing env|env\b|api_key/i.test(lower)
          ? 'env'
          : /npm err|module not found|dependency|pnpm|yarn|package/i.test(lower)
            ? 'dependency'
            : /test failed|failed tests|expect\(|assert/i.test(lower)
              ? 'test'
              : /ssh|connect timeout|connection refused|remote|unreachable/i.test(lower)
                ? 'remote'
                : (input.policyViolations?.length ?? 0) > 0
                  ? 'policy'
                  : /timeout|stale|无输出|卡住/i.test(lower)
                    ? 'timeout'
                    : /codex|worker|exit/i.test(lower)
                      ? 'worker'
                      : 'unknown';
    const titleByCategory: Record<string, string> = {
      auth: '认证或 token 失效',
      env: '环境变量缺失',
      dependency: '依赖或安装环境异常',
      test: '测试失败',
      remote: '远端机器或 SSH 不可达',
      policy: '触发安全策略',
      timeout: '任务卡住或超时',
      worker: 'Codex worker 执行失败',
      unknown: '任务失败原因待复核',
    };
    const card: FailureKnowledgeCard = {
      id: `${input.jobId}:${Date.now()}`,
      at: new Date().toISOString(),
      jobId: input.jobId,
      category,
      title: titleByCategory[category] ?? titleByCategory.unknown,
      summary: `job ${input.jobId} 失败或被停止，分类为：${titleByCategory[category] ?? titleByCategory.unknown}`,
      evidence: evidence.replace(/\b(sk|nvapi)-[A-Za-z0-9_-]{12,}\b/g, '$1-[redacted]').slice(0, 1200),
    };
    await this.store.updateEvaluation(stateKey, (cached) => {
      if (!cached) return null;
      const failureCards = [
        card,
        ...(cached.failureCards ?? []).filter((item) => item.jobId !== input.jobId),
      ].slice(0, 20);
      return {
        ...cached,
        failureCards,
        keywords: [...new Set([...(cached.keywords ?? []), card.category, card.title])].slice(0, 40),
        reviewSignals: [`失败知识卡片：${card.title}`, ...(cached.reviewSignals ?? [])].slice(0, 8),
        searchText: buildEvaluationSearchText({
          id: input.sessionId,
          cwd: cached.cwd,
          evaluation: { ...cached, failureCards },
        }),
      };
    });
  }

  async appendJobOutcome(input: JobOutcome): Promise<void> {
    await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(input.sessionId, input.agent);
    await this.store.updateEvaluation(stateKey, (cached) => {
      if (!cached) return null;
      const jobOutcomes = [
        input,
        ...(cached.jobOutcomes ?? []).filter((item) => item.jobId !== input.jobId),
      ].slice(0, 30);
      const outcomeKeywords = [
        input.status,
        input.mode,
        input.cwd ?? '',
        ...input.changedFiles,
        ...input.tests,
        input.needsReview ? 'needs-review' : '',
      ].filter(Boolean);
      return {
        ...cached,
        jobOutcomes,
        keywords: [...new Set([...(cached.keywords ?? []), ...outcomeKeywords])].slice(0, 50),
        reviewSignals: [
          `最近 Codex worker：${input.status}${input.needsReview ? '，需要复核' : ''}`,
          ...(cached.reviewSignals ?? []),
        ].slice(0, 8),
        searchText: buildEvaluationSearchText({
          id: input.sessionId,
          cwd: cached.cwd,
          evaluation: { ...cached, jobOutcomes },
        }),
      };
    });
  }

  async getSessionOutcome(id: string, agent: AgentKind) {
    const state = await this.ensureLegacyStateMigrated();
    const stateKey = sessionStateKey(id, agent);
    const cached = state.evaluations[stateKey];
    if (!cached) return null;
    return {
      sessionId: id,
      agent,
      title: state.titles[stateKey] || cached.title || cached.summary || id,
      hermesLastJobId: cached.hermesLastJobId ?? null,
      jobOutcomes: cached.jobOutcomes ?? [],
      failureCards: cached.failureCards ?? [],
      summary: cached.summary,
      detailedSummary: cached.detailedSummary,
      searchText: cached.searchText,
    };
  }

  async findJobOutcome(
    jobId: string,
    targetIdentity?: { sessionId: string; agent: AgentKind; machineId?: string },
  ) {
    const state = await this.ensureLegacyStateMigrated();
    for (const [stateKey, evaluation] of Object.entries(state.evaluations)) {
      const parsedIdentity = parseSessionStateKey(stateKey);
      if (!parsedIdentity) continue;
      if (
        targetIdentity &&
        (
          parsedIdentity.sessionId !== targetIdentity.sessionId ||
          parsedIdentity.agent !== targetIdentity.agent
        )
      ) {
        continue;
      }
      const outcome = (evaluation.jobOutcomes ?? []).find((item) => item.jobId === jobId);
      if (outcome) {
        if (
          outcome.sessionId !== parsedIdentity.sessionId ||
          outcome.agent !== parsedIdentity.agent ||
          (targetIdentity?.machineId && outcome.machineId !== targetIdentity.machineId)
        ) {
          continue;
        }
        return {
          sessionId: parsedIdentity.sessionId,
          agent: parsedIdentity.agent,
          title: state.titles[stateKey] ||
            evaluation.title ||
            evaluation.summary ||
            parsedIdentity.sessionId,
          outcome,
          failureCards: (evaluation.failureCards ?? []).filter((card) => card.jobId === jobId),
        };
      }
    }
    return null;
  }

  async setKept(id: string, kept: boolean, agent: AgentKind): Promise<void> {
    await this.store.setKept(sessionStateKey(id, agent), kept);
  }

  async setTitle(id: string, title: string, agent: AgentKind): Promise<void> {
    await this.store.setTitle(sessionStateKey(id, agent), title);
  }

  async deleteSession(id: string, agent?: AgentKind | null): Promise<{
    sessionId: string;
    agent: AgentKind;
    archiveDir: string;
    archivedFiles: string[];
    removedOriginalFiles: string[];
    removedHistoryEntries: number;
    expiresAt: string;
  }> {
    const session = await this.findSessionFileByIdentity(id, agent);
    if (!session) throw new Error(`Session not found: ${id}`);
    const result = await archiveSessionFiles({
      codexHome: this.codexHome,
      sessionId: id,
      filePath: session.filePath,
      retentionDays: Number(process.env.CURATOR_RECYCLE_RETENTION_DAYS || 30),
      claudeProjectsRoot: this.claudeProjectsRoot,
    });
    await this.store.markDeleted(sessionStateKey(id, session.agent));
    return { sessionId: id, ...result };
  }

  async deleteSessionsBulk(
    identities: Array<string | { id: string; agent?: AgentKind | null }>,
  ): Promise<{
    deleted: Array<{
      sessionId: string;
      agent: AgentKind;
      archiveDir: string;
      archivedFiles: string[];
      removedOriginalFiles: string[];
      removedHistoryEntries: number;
      expiresAt: string;
    }>;
    missingIds: string[];
  }> {
    const cleanIdentities = [
      ...new Map(
        identities
          .map((identity) => typeof identity === 'string'
            ? { id: identity, agent: null }
            : { id: identity.id, agent: identity.agent ?? null })
          .filter((identity) => Boolean(identity.id))
          .map((identity) => [`${identity.agent ?? ''}|||${identity.id}`, identity]),
      ).values(),
    ];
    const found: Array<{ sessionId: string; filePath: string; agent: AgentKind }> = [];
    const missingIds: string[] = [];

    // Resolve every identity before archiving any file. Raw ids are accepted
    // only when they identify exactly one local Agent.
    for (const identity of cleanIdentities) {
      const match = await this.findSessionFileByIdentity(identity.id, identity.agent);
      if (match) found.push(match);
      else missingIds.push(identity.id);
    }
    if (!found.length) return { deleted: [], missingIds };

    const deleted = await archiveSessionFilesBulk({
      codexHome: this.codexHome,
      sessions: found,
      retentionDays: Number(process.env.CURATOR_RECYCLE_RETENTION_DAYS || 30),
      claudeProjectsRoot: this.claudeProjectsRoot,
    });
    await this.store.markDeletedMany(
      deleted.map((item) => sessionStateKey(item.sessionId, item.agent)),
    );
    return { deleted, missingIds };
  }

  async migrateSessionToProject(id: string, targetProjectDir: string, agent?: AgentKind | null) {
    const session = await this.getSession(id, agent);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (sameResolvedPath(session.cwd, targetProjectDir)) {
      if (session.agent === 'claude') {
        return {
          sourceSessionId: id,
          sourceSessionFile: session.filePath,
          targetProjectDir: session.cwd,
          newSessionId: id,
          newSessionFile: session.filePath,
          verified: true,
          verifiedCwd: session.cwd,
          resumeCommand: `claude --resume ${id}`,
          alreadyInTarget: true,
          verifyResume: {
            ok: true,
            output: 'Claude session remains in its original project store; Codex-only resume verification was not run.',
          },
        };
      }
      return {
        sourceSessionId: id,
        sourceSessionFile: session.filePath,
        targetProjectDir: session.cwd,
        newSessionId: id,
        newSessionFile: session.filePath,
        verified: true,
        verifiedCwd: session.cwd,
        resumeCommand: `codex resume -C ${session.cwd} ${id}`,
        alreadyInTarget: true,
        verifyResume: verifyResumeCommand(session.cwd, id),
      };
    }
    if (session.agent === 'claude') {
      throw new UnsupportedSessionMigrationError(id);
    }
    const result = await copySessionToProject({
      codexHome: this.codexHome,
      sessionId: id,
      filePath: session.filePath,
      targetProjectDir,
    });
    return {
      ...result,
      verifyResume: verifyResumeCommand(result.targetProjectDir, result.newSessionId),
    };
  }

  async cleanupRecycleBin() {
    return purgeExpiredArchives({ recycleRoot: getRecycleRoot() });
  }

  async queueFailedSummaryRetry() {
    const queuedIds = await this.store.clearFailedEvaluations();
    return { queuedIds, queued: queuedIds.length };
  }

  async backfillEvaluations(options: { limit?: number; includeFailed?: boolean } = {}) {
    const nowMs = Date.now();
    const quietMs = evaluationQuietMs();
    const files = await this.discoverSessionFiles();
    const state = await this.migrateLegacyStateForFiles(files);
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const candidates: Array<{ filePath: string; id: string; bytes: number; mtimeMs: number; sortTimeMs: number }> = [];
    let deferredActive = 0;

    for (const filePath of files) {
      try {
        const fileStat = await stat(filePath);
        const id = extractSessionId(filePath);
        const agent = sessionAgentForFile(filePath);
        const cached = state.evaluations[sessionStateKey(id, agent)];
        const needsBackfill =
          !cached ||
          cached.filePath !== filePath ||
          cached.bytes !== fileStat.size ||
          cached.mtimeMs !== fileStat.mtimeMs ||
          !isEvaluationWorkflowComplete(cached.workflow) ||
          cached.hermesNeedsRefresh === true ||
          !hasCachedConversationPreview(cached) ||
          (options.includeFailed === true && cached.status === 'failed') ||
          !hasCachedMetadata(cached);
        if (!needsBackfill) continue;
        if (nowMs - fileStat.mtimeMs < quietMs) {
          deferredActive += 1;
          continue;
        }
        candidates.push({
          filePath,
          id,
          bytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          sortTimeMs: sessionBackfillSortTimeMs({
            cachedUpdatedAt: cached?.updatedAt ?? null,
            fileMtimeMs: fileStat.mtimeMs,
          }),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        console.warn('[SessionService] Skipping unreadable session file:', filePath, error);
      }
    }

    candidates.sort((a, b) => b.sortTimeMs - a.sortTimeMs || b.filePath.localeCompare(a.filePath));
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 8)));
    const batch = candidates.slice(0, limit);
    let stateChanged = false;

    const results = await mapLimit(batch, await getEvaluationConcurrency(), async (item) => {
      const parsed = await parseSessionFile(item.filePath);
      const stateKey = sessionStateKey(parsed.id, parsed.source);
      const transcriptHash = hashTranscript(parsed.messages);
      const runId = randomUUID();
      const cached = state.evaluations[stateKey];
      const updateMeta = classifyUpdate({
        cached,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        userTurns: parsed.userTurns,
        messageCount: parsed.messageCount,
      });
      const evaluation = getCuratorRole() === 'worker'
        ? fastEvaluation({
            id: parsed.id,
            cwd: parsed.cwd,
            cached,
            userTurns: parsed.userTurns,
            assistantTurns: parsed.assistantTurns,
            messageCount: parsed.messageCount,
            updateMeta,
            transcriptHash,
            runId,
            evaluationOrigin: 'worker-fast',
          })
        : applyUpdateMeta(
            await evaluateSessionWithModel({
              sessionId: parsed.id,
              machineId: getMachineId(),
              runId,
              evaluationOrigin: 'local-llm',
              transcriptHash,
              messages: parsed.messages,
              userTurns: parsed.userTurns,
              assistantTurns: parsed.assistantTurns,
              cwd: parsed.cwd,
            }),
            updateMeta
          );
      const shellSnapshotCount = parsed.source === 'codex'
        ? (shellSnapshotCounts.get(parsed.id) ?? 0)
        : 0;
      state.evaluations[stateKey] = {
        ...evaluation,
        filePath: parsed.filePath,
        mtimeMs: parsed.mtimeMs,
        bytes: parsed.bytes,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        messageCount: parsed.messageCount,
        userTurns: parsed.userTurns,
        assistantTurns: parsed.assistantTurns,
        lastUserMessage: parsed.lastUserMessage,
        lastAssistantMessage: parsed.lastAssistantMessage,
        shellSnapshotCount,
        searchText: buildEvaluationSearchText({
          id: parsed.id,
          cwd: parsed.cwd,
          lastUserMessage: parsed.lastUserMessage,
          lastAssistantMessage: parsed.lastAssistantMessage,
          evaluation,
        }),
      };
      stateChanged = true;
      await recordSessionAuditEvent({
        event: evaluation.status === 'failed' ? 'evaluation-failed' : 'evaluation-completed',
        sessionId: parsed.id,
        machineId: getMachineId(),
        agent: parsed.source,
        runId,
        evaluationOrigin: evaluation.evaluationOrigin ?? (getCuratorRole() === 'worker' ? 'worker-fast' : 'local-llm'),
        transcriptHash,
        messageCount: parsed.messageCount,
        userTurns: parsed.userTurns,
        assistantTurns: parsed.assistantTurns,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        model: evaluation.model,
        status: evaluation.status,
        error: evaluation.error,
        details: { reason: 'backfill' },
      }).catch(() => undefined);
      return {
        id: parsed.id,
        status: evaluation.status,
        title: evaluation.title,
        model: evaluation.model,
        error: evaluation.error,
        runId,
        transcriptHash,
        evaluationOrigin: evaluation.evaluationOrigin,
      };
    });

    if (stateChanged) await this.store.save(state);
    return {
      requested: limit,
      processed: results.length,
      remainingEstimate: Math.max(0, candidates.length - results.length),
      ok: results.filter((item) => item.status === 'ok').length,
      failed: results.filter((item) => item.status === 'failed').length,
      fallback: results.filter((item) => item.status === 'fallback').length,
      deferredActive,
      results,
    };
  }

  async listRecycleBin() {
    return listRecycleArchives({ recycleRoot: getRecycleRoot() });
  }

  async restoreRecycleArchive(
    sessionId: string,
    selector: { archiveDir?: string; agent?: AgentKind } = {},
  ) {
    const result = await restoreArchive({
      codexHome: this.codexHome,
      recycleRoot: getRecycleRoot(),
      sessionId,
      archiveDir: selector.archiveDir,
      agent: selector.agent,
      claudeProjectsRoot: this.claudeProjectsRoot,
    });
    const files = await this.discoverSessionFiles();
    await this.migrateLegacyStateForFiles(files, true);
    if (result.agent) {
      await this.store.unmarkDeleted(sessionStateKey(sessionId, result.agent));
    }
    // Old releases persisted deletion under a raw session id. It is never safe
    // to keep that unscoped tombstone after an explicitly selected restore.
    await this.store.unmarkDeleted(sessionId);
    return result;
  }

  async purgeRecycleArchive(
    sessionId: string,
    selector: { archiveDir?: string; agent?: AgentKind } = {},
  ) {
    return permanentlyDeleteArchive({
      recycleRoot: getRecycleRoot(),
      sessionId,
      archiveDir: selector.archiveDir,
      agent: selector.agent,
    });
  }

  async pruneRecommended(recommendation: Recommendation = 'delete') {
    const sessions = await this.listSessions();
    const targets = sessions.filter((session) => !session.kept && session.evaluation.recommendation === recommendation);
    return (await this.deleteSessionsBulk(
      targets.map((session) => ({ id: session.id, agent: session.agent })),
    )).deleted;
  }

  async pruneNonKept() {
    const sessions = await this.listSessions();
    const targets = sessions.filter((session) => !session.kept);
    return (await this.deleteSessionsBulk(
      targets.map((session) => ({ id: session.id, agent: session.agent })),
    )).deleted;
  }

  async countExistingSessionFiles(): Promise<number> {
    try {
      await stat(this.sessionsRoot);
    } catch {
      return 0;
    }
    return (await findJsonlFiles(this.sessionsRoot)).length;
  }
}
