import { stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  evaluateSession,
  getRecommendedEvaluationConcurrency,
  isEvaluationWorkflowCompatible,
  isEvaluationWorkflowComplete,
} from './evaluator.js';
import { extractSessionId, parseSessionFile, parseSessionHistory, parseSessionMessages } from './session-parser.js';
import { CuratorStore } from './store.js';
import type {
  ActivityStatus,
  AgentKind,
  CodexSession,
  Evaluation,
  FailureKnowledgeCard,
  JobOutcome,
  ParsedMessage,
  Recommendation,
  RemoteMachine,
  ReviewPriority,
  StoredEvaluation,
  UpdateCadence,
} from './types.js';

function getEvaluationConcurrency(): number {
  return getRecommendedEvaluationConcurrency();
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
}): Evaluation {
  if (input.cached?.summary) {
    const cached = publicEvaluation(input.cached);
    const updateMeta = input.updateMeta ?? {
      updateCadence: cached.updateCadence,
      reviewPriority: cached.reviewPriority,
      reviewSignals: cached.reviewSignals,
    };
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

export class SessionService {
  private codexHome = getCodexHome();
  private sessionsRoot = getSessionsRoot(this.codexHome);
  private claudeProjectsRoot = getClaudeProjectsRoot();
  private store: CuratorStore;

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
  private async discoverSessionFiles(): Promise<string[]> {
    const [codexFiles, claudeFiles] = await Promise.all([
      findJsonlFiles(this.sessionsRoot),
      findJsonlFiles(this.claudeProjectsRoot),
    ]);
    const primaryClaudeFiles = claudeFiles.filter((filePath) => {
      const segments = relative(this.claudeProjectsRoot, filePath).split(sep);
      return !segments.includes('subagents');
    });
    return [...codexFiles, ...primaryClaudeFiles];
  }

  private async findSessionFilesByIds(ids: string[]): Promise<{
    found: Array<{ sessionId: string; filePath: string }>;
    missingIds: string[];
  }> {
    const targetIds = new Set(ids.filter(Boolean));
    const foundById = new Map<string, string>();
    if (!targetIds.size) return { found: [], missingIds: [] };

    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      const id = extractSessionId(filePath);
      if (targetIds.has(id) && !foundById.has(id)) foundById.set(id, filePath);
    }

    const found = [...foundById.entries()].map(([sessionId, filePath]) => ({ sessionId, filePath }));
    const missingIds = [...targetIds].filter((id) => !foundById.has(id));
    return { found, missingIds };
  }

  async listSessions(options: { refreshWorkflow?: boolean; fast?: boolean } = {}): Promise<CodexSession[]> {
    const state = await this.store.load();
    const files = await this.discoverSessionFiles();
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const sessions: CodexSession[] = [];
    const parseQueue: Array<{ filePath: string; id: string; bytes: number; mtimeMs: number }> = [];
    let stateChanged = false;

    for (const filePath of files) {
      try {
        const fileStat = await stat(filePath);
        const id = extractSessionId(filePath);
        const cached = state.evaluations[id];
        const shellSnapshotCount = shellSnapshotCounts.get(id) ?? 0;

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
            title: state.titles[id] || cached.title || cached.summary.slice(0, 42) || id,
            customTitle: state.titles[id] ?? null,
            kept: state.keptIds.includes(id),
            deleted: false,
            evaluation: publicEvaluation(cached),
          }));
          if (cached.shellSnapshotCount !== shellSnapshotCount) {
            cached.shellSnapshotCount = shellSnapshotCount;
            state.evaluations[id] = cached;
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

    const evaluated = await mapLimit(parseQueue, getEvaluationConcurrency(), async (item) => {
      const parsed = await parseSessionFile(item.filePath);
      const cached = state.evaluations[parsed.id];
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
            }
          : options.fast
            ? fastEvaluation({
                id: parsed.id,
                cwd: parsed.cwd,
                cached,
                userTurns: parsed.userTurns,
                assistantTurns: parsed.assistantTurns,
                messageCount: parsed.messageCount,
                updateMeta,
              })
            : applyUpdateMeta(
                await evaluateSession({
                  messages: parsed.messages,
                  userTurns: parsed.userTurns,
                  assistantTurns: parsed.assistantTurns,
                  cwd: parsed.cwd,
                }),
                updateMeta
              );

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
        state.evaluations[parsed.id] = {
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
      }

      return { parsed, evaluation };
    });

    if (stateChanged) await this.store.save(state);

    for (const { parsed, evaluation } of evaluated) {
      const shellSnapshotCount = shellSnapshotCounts.get(parsed.id) ?? 0;
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
        title: state.titles[parsed.id] || evaluation.title || evaluation.summary.slice(0, 42) || parsed.id,
        customTitle: state.titles[parsed.id] ?? null,
        kept: state.keptIds.includes(parsed.id),
        deleted: false,
        evaluation: publicEvaluation(evaluation),
      }));
    }

    return sessions.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
  }

  async getSession(id: string): Promise<CodexSession | null> {
    const sessions = await this.listSessions();
    return sessions.find((session) => session.id === id) ?? null;
  }

  async getSessionFast(id: string): Promise<CodexSession | null> {
    const sessions = await this.listSessions({ fast: true });
    return sessions.find((session) => session.id === id) ?? null;
  }

  async getSessionHistory(id: string, options: { limit?: number; beforeIndex?: number | null } = {}) {
    const session = await this.getSessionFast(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return parseSessionHistory({
      filePath: session.filePath,
      limit: options.limit ?? 80,
      beforeIndex: options.beforeIndex ?? null,
    });
  }

  async getSessionMessages(
    id: string,
    options: {
      limit?: number | null;
      beforeIndex?: number | null;
      afterIndex?: number | null;
      full?: boolean;
      preserveWhitespace?: boolean;
    } = {}
  ) {
    const { found, missingIds } = await this.findSessionFilesByIds([id]);
    if (missingIds.length || !found[0]) throw new Error(`Session not found: ${id}`);
    return parseSessionMessages({
      filePath: found[0].filePath,
      limit: options.limit ?? null,
      beforeIndex: options.beforeIndex ?? null,
      afterIndex: options.afterIndex ?? null,
      full: options.full,
      preserveWhitespace: options.preserveWhitespace,
    });
  }

  async markHermesSessionUsed(id: string, jobId: string | null): Promise<void> {
    const state = await this.store.load();
    const cached = state.evaluations[id];
    if (!cached) return;
    state.evaluations[id] = {
      ...cached,
      hermesLastUsedAt: new Date().toISOString(),
      hermesLastJobId: jobId,
      hermesNeedsRefresh: true,
      hermesRefreshStatus: 'pending',
      hermesRefreshError: null,
    };
    await this.store.save(state);
  }

  async markSessionEvaluationRefreshQueued(id: string, reason = 'manual'): Promise<void> {
    const state = await this.store.load();
    const cached = state.evaluations[id];
    if (!cached) return;
    state.evaluations[id] = {
      ...cached,
      hermesNeedsRefresh: true,
      hermesRefreshStatus: 'pending',
      hermesRefreshError: null,
      reviewSignals: [`已加入 AI 重算队列：${reason}`, ...(cached.reviewSignals ?? [])].slice(0, 6),
    };
    await this.store.save(state);
  }

  async refreshSessionEvaluation(id: string, reason = 'manual') {
    const { found, missingIds } = await this.findSessionFilesByIds([id]);
    if (missingIds.length || !found[0]) throw new Error(`Session not found: ${id}`);
    const parsed = await parseSessionFile(found[0].filePath);
    const state = await this.store.load();
    const cached = state.evaluations[id];
    const updateMeta = classifyUpdate({
      cached,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
      userTurns: parsed.userTurns,
      messageCount: parsed.messageCount,
    });
    if (cached) {
      state.evaluations[id] = {
        ...cached,
        hermesNeedsRefresh: true,
        hermesRefreshStatus: 'running',
        hermesRefreshError: null,
      };
      await this.store.save(state);
    }
    try {
    const evaluation = applyUpdateMeta(
      await evaluateSession({
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
    state.evaluations[id] = {
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
      shellSnapshotCount: shellSnapshotCounts.get(parsed.id) ?? 0,
      searchText: buildEvaluationSearchText({
        id: parsed.id,
        cwd: parsed.cwd,
        lastUserMessage: parsed.lastUserMessage,
        lastAssistantMessage: parsed.lastAssistantMessage,
        evaluation,
      }),
    };
    await this.store.save(state);
    return { id, status: evaluation.status, title: evaluation.title, model: evaluation.model, error: evaluation.error };
    } catch (error) {
      const failedState = await this.store.load();
      const latest = failedState.evaluations[id] ?? cached;
      if (latest) {
        failedState.evaluations[id] = {
          ...latest,
          hermesNeedsRefresh: true,
          hermesRefreshStatus: 'failed',
          hermesRefreshError: error instanceof Error ? error.message.slice(0, 240) : 'AI 重算失败',
        };
        await this.store.save(failedState);
      }
      throw error;
    }
  }

  async appendFailureKnowledgeCard(input: {
    sessionId: string;
    jobId: string;
    outputTail?: string | null;
    error?: string | null;
    policyViolations?: Array<{ reason?: string; pattern?: string; severity?: string }>;
  }): Promise<void> {
    const state = await this.store.load();
    const cached = state.evaluations[input.sessionId];
    if (!cached) return;
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
    const failureCards = [card, ...(cached.failureCards ?? []).filter((item) => item.jobId !== input.jobId)].slice(0, 20);
    state.evaluations[input.sessionId] = {
      ...cached,
      failureCards,
      keywords: [...new Set([...(cached.keywords ?? []), card.category, card.title])].slice(0, 40),
      reviewSignals: [`失败知识卡片：${card.title}`, ...(cached.reviewSignals ?? [])].slice(0, 8),
      searchText: buildEvaluationSearchText({ id: input.sessionId, cwd: cached.cwd, evaluation: { ...cached, failureCards } }),
    };
    await this.store.save(state);
  }

  async appendJobOutcome(input: JobOutcome): Promise<void> {
    const state = await this.store.load();
    const cached = state.evaluations[input.sessionId];
    if (!cached) return;
    const jobOutcomes = [input, ...(cached.jobOutcomes ?? []).filter((item) => item.jobId !== input.jobId)].slice(0, 30);
    const outcomeKeywords = [
      input.status,
      input.mode,
      input.cwd ?? '',
      ...input.changedFiles,
      ...input.tests,
      input.needsReview ? 'needs-review' : '',
    ].filter(Boolean);
    state.evaluations[input.sessionId] = {
      ...cached,
      jobOutcomes,
      keywords: [...new Set([...(cached.keywords ?? []), ...outcomeKeywords])].slice(0, 50),
      reviewSignals: [
        `最近 Codex worker：${input.status}${input.needsReview ? '，需要复核' : ''}`,
        ...(cached.reviewSignals ?? []),
      ].slice(0, 8),
      searchText: buildEvaluationSearchText({ id: input.sessionId, cwd: cached.cwd, evaluation: { ...cached, jobOutcomes } }),
    };
    await this.store.save(state);
  }

  async getSessionOutcome(id: string) {
    const state = await this.store.load();
    const cached = state.evaluations[id];
    if (!cached) return null;
    return {
      sessionId: id,
      title: state.titles[id] || cached.title || cached.summary || id,
      hermesLastJobId: cached.hermesLastJobId ?? null,
      jobOutcomes: cached.jobOutcomes ?? [],
      failureCards: cached.failureCards ?? [],
      summary: cached.summary,
      detailedSummary: cached.detailedSummary,
      searchText: cached.searchText,
    };
  }

  async findJobOutcome(jobId: string) {
    const state = await this.store.load();
    for (const [sessionId, evaluation] of Object.entries(state.evaluations)) {
      const outcome = (evaluation.jobOutcomes ?? []).find((item) => item.jobId === jobId);
      if (outcome) {
        return {
          sessionId,
          title: state.titles[sessionId] || evaluation.title || evaluation.summary || sessionId,
          outcome,
          failureCards: (evaluation.failureCards ?? []).filter((card) => card.jobId === jobId),
        };
      }
    }
    return null;
  }

  async setKept(id: string, kept: boolean): Promise<void> {
    await this.store.setKept(id, kept);
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.store.setTitle(id, title);
  }

  async deleteSession(id: string): Promise<{
    sessionId: string;
    archiveDir: string;
    archivedFiles: string[];
    removedOriginalFiles: string[];
    removedHistoryEntries: number;
    expiresAt: string;
  }> {
    const { found } = await this.findSessionFilesByIds([id]);
    const session = found[0];
    if (!session) throw new Error(`Session not found: ${id}`);
    const result = await archiveSessionFiles({
      codexHome: this.codexHome,
      sessionId: id,
      filePath: session.filePath,
      retentionDays: Number(process.env.CURATOR_RECYCLE_RETENTION_DAYS || 30),
    });
    await this.store.markDeleted(id);
    return { sessionId: id, ...result };
  }

  async deleteSessionsBulk(ids: string[]): Promise<{
    deleted: Array<{
      sessionId: string;
      archiveDir: string;
      archivedFiles: string[];
      removedOriginalFiles: string[];
      removedHistoryEntries: number;
      expiresAt: string;
    }>;
    missingIds: string[];
  }> {
    const cleanIds = [...new Set(ids.filter(Boolean))];
    const { found, missingIds } = await this.findSessionFilesByIds(cleanIds);
    if (!found.length) return { deleted: [], missingIds };

    const deleted = await archiveSessionFilesBulk({
      codexHome: this.codexHome,
      sessions: found,
      retentionDays: Number(process.env.CURATOR_RECYCLE_RETENTION_DAYS || 30),
    });
    await this.store.markDeletedMany(deleted.map((item) => item.sessionId));
    return { deleted, missingIds };
  }

  async migrateSessionToProject(id: string, targetProjectDir: string) {
    const session = await this.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (sameResolvedPath(session.cwd, targetProjectDir)) {
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
    const state = await this.store.load();
    const files = await this.discoverSessionFiles();
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const candidates: Array<{ filePath: string; id: string; bytes: number; mtimeMs: number; sortTimeMs: number }> = [];

    for (const filePath of files) {
      try {
        const fileStat = await stat(filePath);
        const id = extractSessionId(filePath);
        const cached = state.evaluations[id];
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

    const results = await mapLimit(batch, getEvaluationConcurrency(), async (item) => {
      const parsed = await parseSessionFile(item.filePath);
      const cached = state.evaluations[parsed.id];
      const updateMeta = classifyUpdate({
        cached,
        bytes: parsed.bytes,
        mtimeMs: parsed.mtimeMs,
        userTurns: parsed.userTurns,
        messageCount: parsed.messageCount,
      });
      const evaluation = applyUpdateMeta(
        await evaluateSession({
          messages: parsed.messages,
          userTurns: parsed.userTurns,
          assistantTurns: parsed.assistantTurns,
          cwd: parsed.cwd,
        }),
        updateMeta
      );
      const shellSnapshotCount = shellSnapshotCounts.get(parsed.id) ?? 0;
      state.evaluations[parsed.id] = {
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
      return {
        id: parsed.id,
        status: evaluation.status,
        title: evaluation.title,
        model: evaluation.model,
        error: evaluation.error,
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
      results,
    };
  }

  async listRecycleBin() {
    return listRecycleArchives({ recycleRoot: getRecycleRoot() });
  }

  async restoreRecycleArchive(sessionId: string) {
    const result = await restoreArchive({
      codexHome: this.codexHome,
      recycleRoot: getRecycleRoot(),
      sessionId,
    });
    await this.store.unmarkDeleted(sessionId);
    return result;
  }

  async purgeRecycleArchive(sessionId: string) {
    return permanentlyDeleteArchive({ recycleRoot: getRecycleRoot(), sessionId });
  }

  async pruneRecommended(recommendation: Recommendation = 'delete') {
    const sessions = await this.listSessions();
    const targets = sessions.filter((session) => !session.kept && session.evaluation.recommendation === recommendation);
    return (await this.deleteSessionsBulk(targets.map((session) => session.id))).deleted;
  }

  async pruneNonKept() {
    const sessions = await this.listSessions();
    const targets = sessions.filter((session) => !session.kept);
    return (await this.deleteSessionsBulk(targets.map((session) => session.id))).deleted;
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
