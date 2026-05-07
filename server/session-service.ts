import { stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import {
  archiveSessionFilesBulk,
  archiveSessionFiles,
  copySessionToProject,
  countShellSnapshots,
  findJsonlFiles,
  getCodexHome,
  getRecycleRoot,
  getSessionsRoot,
  listRecycleArchives,
  purgeExpiredArchives,
  permanentlyDeleteArchive,
  restoreArchive,
  sameResolvedPath,
} from './file-ops.js';
import { EVALUATOR_WORKFLOW, evaluateSession, getRecommendedEvaluationConcurrency } from './evaluator.js';
import { extractSessionId, parseSessionFile, parseSessionHistory } from './session-parser.js';
import { CuratorStore } from './store.js';
import type {
  ActivityStatus,
  CodexSession,
  Evaluation,
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
  evaluation: Partial<Evaluation>;
}): string {
  const evaluation = input.evaluation;
  return [
    input.id ?? '',
    input.title ?? '',
    input.resumeCommand ?? '',
    input.cwd ?? '',
    input.machineId ?? '',
    evaluation.title ?? '',
    evaluation.summary ?? '',
    evaluation.detailedSummary ?? '',
    ...(evaluation.actualWorkdirs ?? []),
    ...(evaluation.directoryIndex ?? []),
    ...(evaluation.techStack ?? []),
    ...(evaluation.keywords ?? []),
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

  if (!changed && input.cached.workflow !== EVALUATOR_WORKFLOW) {
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
    recommendation,
    score: evaluation.score,
    reasons,
    actualWorkdirs: evaluation.actualWorkdirs ?? [],
    directoryIndex: evaluation.directoryIndex ?? evaluation.actualWorkdirs ?? [],
    techStack: evaluation.techStack ?? [],
    keywords: evaluation.keywords ?? [],
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
    searchText: '',
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

function enrichSession(base: Omit<CodexSession, 'resumeCommand' | 'machineId' | 'activityStatus' | 'lastActiveAt' | 'inactiveDays'>): CodexSession {
  const activity = getActivity(base.updatedAt);
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
    evaluation,
    resumeCommand: `codex resume ${base.id}`,
    machineId: getMachineId(),
    ...activity,
  };
}

export class SessionService {
  private codexHome = getCodexHome();
  private sessionsRoot = getSessionsRoot(this.codexHome);
  private store: CuratorStore;

  constructor(store: CuratorStore) {
    this.store = store;
  }

  getMeta() {
    return {
      machineId: getMachineId(),
      codexHome: this.codexHome,
      sessionsRoot: this.sessionsRoot,
      recycleRoot: getRecycleRoot(),
      recycleRetentionDays: Number(process.env.CURATOR_RECYCLE_RETENTION_DAYS || 30),
      deleteMode: 'archive-then-local-clean',
    };
  }

  private async findSessionFilesByIds(ids: string[]): Promise<{
    found: Array<{ sessionId: string; filePath: string }>;
    missingIds: string[];
  }> {
    const targetIds = new Set(ids.filter(Boolean));
    const foundById = new Map<string, string>();
    if (!targetIds.size) return { found: [], missingIds: [] };

    const files = await findJsonlFiles(this.sessionsRoot);
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
    const files = await findJsonlFiles(this.sessionsRoot);
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
          !options.refreshWorkflow &&
          cached.workflow === EVALUATOR_WORKFLOW &&
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
        cached.workflow === EVALUATOR_WORKFLOW &&
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
              searchText: cached.searchText ?? buildEvaluationSearchText({ id: parsed.id, cwd: parsed.cwd, evaluation: cached }),
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
        !hasCachedMetadata(cached)
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
          shellSnapshotCount,
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
    const session = await this.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return parseSessionHistory({
      filePath: session.filePath,
      limit: options.limit ?? 80,
      beforeIndex: options.beforeIndex ?? null,
    });
  }

  async setKept(id: string, kept: boolean): Promise<CodexSession | null> {
    await this.store.setKept(id, kept);
    return this.getSession(id);
  }

  async setTitle(id: string, title: string): Promise<CodexSession | null> {
    await this.store.setTitle(id, title);
    return this.getSession(id);
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
    const files = await findJsonlFiles(this.sessionsRoot);
    const shellSnapshotCounts = await countShellSnapshots(this.codexHome);
    const candidates: Array<{ filePath: string; id: string; bytes: number; mtimeMs: number; updatedAt: string | null }> = [];

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
          cached.workflow !== EVALUATOR_WORKFLOW ||
          (options.includeFailed === true && cached.status === 'failed') ||
          !hasCachedMetadata(cached);
        if (!needsBackfill) continue;
        candidates.push({ filePath, id, bytes: fileStat.size, mtimeMs: fileStat.mtimeMs, updatedAt: cached?.updatedAt ?? null });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        console.warn('[SessionService] Skipping unreadable session file:', filePath, error);
      }
    }

    candidates.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
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
        shellSnapshotCount,
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
