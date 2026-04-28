import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  archiveSessionFiles,
  copySessionToProject,
  countShellSnapshots,
  findJsonlFiles,
  getCodexHome,
  getRecycleRoot,
  getSessionsRoot,
  listRecycleArchives,
  purgeExpiredArchives,
  sameResolvedPath,
} from './file-ops.js';
import { EVALUATOR_WORKFLOW, evaluateSession } from './evaluator.js';
import { extractSessionId, parseSessionFile, parseSessionHistory } from './session-parser.js';
import { CuratorStore } from './store.js';
import type { ActivityStatus, CodexSession, Evaluation, Recommendation, RemoteMachine, StoredEvaluation } from './types.js';

function getEvaluationConcurrency(): number {
  const raw = Number(process.env.CURATOR_EVALUATION_CONCURRENCY || 8);
  if (!Number.isFinite(raw)) return 8;
  return Math.max(1, Math.min(16, Math.floor(raw)));
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
    cwdMatchesWorkdir: evaluation.cwdMatchesWorkdir ?? null,
    recommendedWorkdir: evaluation.recommendedWorkdir ?? null,
    remoteMachines: cleanRemoteMachines(evaluation.remoteMachines),
    evaluatedAt: evaluation.evaluatedAt,
    workflow: evaluation.workflow,
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

  async listSessions(options: { refreshWorkflow?: boolean } = {}): Promise<CodexSession[]> {
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
          (!options.refreshWorkflow ||
            (cached.workflow === EVALUATOR_WORKFLOW &&
              cached.bytes === fileStat.size &&
              cached.mtimeMs === fileStat.mtimeMs));

        if (canUseCache) {
          if (!options.refreshWorkflow && (cached.bytes !== fileStat.size || cached.mtimeMs !== fileStat.mtimeMs)) {
            cached.bytes = fileStat.size;
            cached.mtimeMs = fileStat.mtimeMs;
            cached.updatedAt = new Date(fileStat.mtimeMs).toISOString();
            state.evaluations[id] = cached;
            stateChanged = true;
          }
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
      const evaluation =
        cached &&
        cached.filePath === parsed.filePath &&
        cached.mtimeMs === parsed.mtimeMs &&
        cached.bytes === parsed.bytes &&
        (!options.refreshWorkflow || cached.workflow === EVALUATOR_WORKFLOW)
          ? {
              title: cached.title ?? cached.summary.slice(0, 42) ?? '未命名会话',
              summary: cached.summary,
              detailedSummary: cached.detailedSummary ?? cached.summary,
              recommendation: cached.recommendation,
              score: cached.score,
              reasons: cached.reasons,
              actualWorkdirs: cached.actualWorkdirs ?? [],
              cwdMatchesWorkdir: cached.cwdMatchesWorkdir ?? null,
              recommendedWorkdir: cached.recommendedWorkdir ?? null,
              remoteMachines: cached.remoteMachines ?? [],
              evaluatedAt: cached.evaluatedAt,
              workflow: cached.workflow,
            }
          : await evaluateSession({
              messages: parsed.messages,
              userTurns: parsed.userTurns,
              assistantTurns: parsed.assistantTurns,
              cwd: parsed.cwd,
            });

      if (
        !cached ||
        cached.filePath !== parsed.filePath ||
        cached.mtimeMs !== parsed.mtimeMs ||
        cached.bytes !== parsed.bytes ||
        cached.workflow !== EVALUATOR_WORKFLOW ||
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
    const session = await this.getSession(id);
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
      };
    }
    const result = await copySessionToProject({
      codexHome: this.codexHome,
      sessionId: id,
      filePath: session.filePath,
      targetProjectDir,
    });
    return result;
  }

  async cleanupRecycleBin() {
    return purgeExpiredArchives({ recycleRoot: getRecycleRoot() });
  }

  async listRecycleBin() {
    return listRecycleArchives({ recycleRoot: getRecycleRoot() });
  }

  async pruneRecommended(recommendation: Recommendation = 'delete') {
    const sessions = await this.listSessions();
    const targets = sessions.filter((session) => !session.kept && session.evaluation.recommendation === recommendation);
    const results = [];
    for (const session of targets) {
      results.push(await this.deleteSession(session.id));
    }
    return results;
  }

  async pruneNonKept() {
    const sessions = await this.listSessions();
    const targets = sessions.filter((session) => !session.kept);
    const results = [];
    for (const session of targets) {
      results.push(await this.deleteSession(session.id));
    }
    return results;
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
