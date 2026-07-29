import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentKind, CommanderAction, PersistedState, StoredEvaluation } from './types.js';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 120_000;

function emptyState(): PersistedState {
  return {
    keptIds: [],
    deletedIds: [],
    titles: {},
    evaluations: {},
    commanderActions: {},
  };
}

function normalizeState(parsed: Partial<PersistedState>): PersistedState {
  return {
    keptIds: Array.isArray(parsed.keptIds) ? parsed.keptIds : [],
    deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
    titles: parsed.titles && typeof parsed.titles === 'object' ? (parsed.titles as Record<string, string>) : {},
    evaluations: parsed.evaluations && typeof parsed.evaluations === 'object' ? parsed.evaluations : {},
    commanderActions:
      parsed.commanderActions && typeof parsed.commanderActions === 'object'
        ? (parsed.commanderActions as Record<string, CommanderAction>)
        : {},
  };
}

function mergeByKey<T>(
  incoming: T[] | undefined,
  current: T[] | undefined,
  key: (item: T) => string,
  limit: number,
): T[] {
  const merged = new Map<string, T>();
  for (const item of [...(incoming ?? []), ...(current ?? [])]) {
    const itemKey = key(item);
    if (!itemKey || merged.has(itemKey)) continue;
    merged.set(itemKey, item);
  }
  return [...merged.values()].slice(0, limit);
}

function scopedAgent(stateKey: string): AgentKind | null {
  if (stateKey.startsWith('codex|||')) return 'codex';
  if (stateKey.startsWith('claude|||')) return 'claude';
  return null;
}

function mergeStoredEvaluation(
  stateKey: string,
  incoming: StoredEvaluation,
  current?: StoredEvaluation,
): StoredEvaluation {
  const agent = scopedAgent(stateKey);
  const jobOutcomes = mergeByKey(
    (incoming.jobOutcomes ?? [])
      .filter((outcome) => !agent || !outcome.agent || outcome.agent === agent)
      .map((outcome) => agent && !outcome.agent ? { ...outcome, agent } : outcome),
    (current?.jobOutcomes ?? [])
      .filter((outcome) => !agent || !outcome.agent || outcome.agent === agent)
      .map((outcome) => agent && !outcome.agent ? { ...outcome, agent } : outcome),
    (outcome) => outcome.jobId,
    30,
  );
  const failureCards = mergeByKey(
    incoming.failureCards,
    current?.failureCards,
    (card) => card.id || `${card.jobId}:${card.category}`,
    20,
  );
  const keywords = [...new Set([
    ...(incoming.keywords ?? []),
    ...(current?.keywords ?? []),
  ])].slice(0, 50);
  const reviewSignals = [...new Set([
    ...(incoming.reviewSignals ?? []),
    ...(current?.reviewSignals ?? []),
  ])].slice(0, 8);
  const durableSearchText = [
    incoming.searchText,
    ...failureCards.flatMap((card) => [card.title, card.summary, card.evidence]),
    ...jobOutcomes.flatMap((outcome) => [
      outcome.goal,
      outcome.summary,
      ...outcome.changedFiles,
      ...outcome.tests,
    ]),
  ].filter(Boolean).join('\n');
  return {
    ...incoming,
    failureCards,
    jobOutcomes,
    keywords,
    reviewSignals,
    searchText: durableSearchText,
  };
}

export class CuratorStore {
  private statePath: string;
  private lockPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(statePath: string) {
    this.statePath = statePath;
    this.lockPath = `${statePath}.lock`;
  }

  private async readState(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      return normalizeState(JSON.parse(raw) as Partial<PersistedState>);
    } catch {
      return emptyState();
    }
  }

  private async writeState(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(tempPath, this.statePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.close();
        return async () => {
          await rm(this.lockPath, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for Curator state lock: ${this.lockPath}`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  private async mutate<T>(operation: (state: PersistedState) => T | Promise<T>): Promise<T> {
    return this.enqueueMutation(async () => {
      const release = await this.acquireLock();
      try {
        const state = await this.readState();
        const result = await operation(state);
        await this.writeState(state);
        return result;
      } finally {
        await release();
      }
    });
  }

  async load(): Promise<PersistedState> {
    return this.readState();
  }

  async migrateLegacySessionKeys(
    identities: Array<{
      id: string;
      stateKey: string;
      agent: AgentKind;
      filePath: string;
    }>,
  ): Promise<PersistedState> {
    const identitiesById = new Map<string, Map<string, {
      stateKey: string;
      agent: AgentKind;
      filePath: string;
    }>>();
    for (const identity of identities) {
      if (!identity.id || !identity.stateKey || !identity.filePath) continue;
      const matches = identitiesById.get(identity.id) ?? new Map();
      matches.set(identity.stateKey, identity);
      identitiesById.set(identity.id, matches);
    }
    return this.mutate((state) => {
      const keptIds = new Set(state.keptIds);
      const deletedIds = new Set(state.deletedIds);
      for (const [id, matches] of identitiesById) {
        if (matches.size !== 1) continue;
        const [identity] = [...matches.values()];
        const { stateKey, agent, filePath } = identity;
        const legacyEvaluation = state.evaluations[id];
        const scopedEvaluation = state.evaluations[stateKey];
        const sourceEvaluation = legacyEvaluation ?? scopedEvaluation;
        const sourceMatchesIdentity = Boolean(
          sourceEvaluation &&
          resolve(sourceEvaluation.filePath) === resolve(filePath) &&
          (sourceEvaluation.jobOutcomes ?? []).every(
            (outcome) => !outcome.agent || outcome.agent === agent,
          ),
        );

        // Raw state has no Agent field. Only an evaluation whose original file
        // path matches the active identity is sufficient proof for migration.
        // Otherwise retain the legacy keys as inert quarantine data.
        if (!sourceMatchesIdentity) continue;

        if (keptIds.has(id)) {
          keptIds.add(stateKey);
          keptIds.delete(id);
        }
        if (deletedIds.has(id)) {
          deletedIds.add(stateKey);
          deletedIds.delete(id);
        }
        if (state.titles[id] !== undefined) {
          if (state.titles[stateKey] === undefined) state.titles[stateKey] = state.titles[id];
          delete state.titles[id];
        }
        if (legacyEvaluation !== undefined) {
          if (state.evaluations[stateKey] === undefined) {
            state.evaluations[stateKey] = legacyEvaluation;
          }
          delete state.evaluations[id];
        }
        const migratedEvaluation = state.evaluations[stateKey];
        if (migratedEvaluation?.jobOutcomes?.length) {
          migratedEvaluation.jobOutcomes = migratedEvaluation.jobOutcomes.map((outcome) => ({
            ...outcome,
            agent: outcome.agent ?? agent,
          }));
        }
      }
      state.keptIds = [...keptIds].sort();
      state.deletedIds = [...deletedIds].sort();
      return state;
    });
  }

  async save(state: PersistedState): Promise<void> {
    await this.mutate((current) => {
      const deletedIds = new Set(current.deletedIds);
      for (const [id, evaluation] of Object.entries(state.evaluations)) {
        if (!deletedIds.has(id)) {
          current.evaluations[id] = mergeStoredEvaluation(
            id,
            evaluation,
            current.evaluations[id],
          );
        }
      }
    });
  }

  async setKept(id: string, kept: boolean): Promise<PersistedState> {
    return this.mutate((state) => {
      const keptIds = new Set(state.keptIds);
      if (kept) keptIds.add(id);
      else keptIds.delete(id);
      state.keptIds = [...keptIds].sort();
      return state;
    });
  }

  async markDeleted(id: string): Promise<PersistedState> {
    return this.mutate((state) => {
      state.deletedIds = [...new Set([...state.deletedIds, id])].sort();
      delete state.evaluations[id];
      delete state.titles[id];
      state.keptIds = state.keptIds.filter((keptId) => keptId !== id);
      return state;
    });
  }

  async markDeletedMany(ids: string[]): Promise<PersistedState> {
    const cleanIds = ids.filter(Boolean);
    if (!cleanIds.length) return this.load();
    return this.mutate((state) => {
      const deletedIds = new Set(state.deletedIds);
      const removedIds = new Set(cleanIds);
      for (const id of cleanIds) {
        deletedIds.add(id);
        delete state.evaluations[id];
        delete state.titles[id];
      }
      state.deletedIds = [...deletedIds].sort();
      state.keptIds = state.keptIds.filter((keptId) => !removedIds.has(keptId));
      return state;
    });
  }

  async unmarkDeleted(id: string): Promise<PersistedState> {
    return this.mutate((state) => {
      state.deletedIds = state.deletedIds.filter((deletedId) => deletedId !== id);
      return state;
    });
  }

  async setTitle(id: string, title: string): Promise<PersistedState> {
    return this.mutate((state) => {
      const cleanTitle = title.trim();
      if (cleanTitle) state.titles[id] = cleanTitle.slice(0, 120);
      else delete state.titles[id];
      return state;
    });
  }

  async setEvaluation(id: string, evaluation: StoredEvaluation): Promise<void> {
    await this.mutate((state) => {
      if (!state.deletedIds.includes(id)) {
        state.evaluations[id] = mergeStoredEvaluation(
          id,
          evaluation,
          state.evaluations[id],
        );
      }
    });
  }

  async updateEvaluation(
    id: string,
    updater: (current: StoredEvaluation | undefined) => StoredEvaluation | null | undefined,
  ): Promise<StoredEvaluation | null> {
    return this.mutate((state) => {
      if (state.deletedIds.includes(id)) return null;
      const current = state.evaluations[id];
      const next = updater(current);
      if (!next) return current ?? null;
      const merged = mergeStoredEvaluation(id, next, current);
      state.evaluations[id] = merged;
      return merged;
    });
  }

  async clearFailedEvaluations(): Promise<string[]> {
    return this.mutate((state) => {
      const failedIds = Object.entries(state.evaluations)
        .filter(([, evaluation]) => evaluation.status === 'failed')
        .map(([id]) => id);
      for (const id of failedIds) delete state.evaluations[id];
      return failedIds;
    });
  }

  async addCommanderAction(action: CommanderAction): Promise<CommanderAction> {
    return this.mutate((state) => {
      state.commanderActions[action.id] = action;
      return action;
    });
  }

  async updateCommanderAction(id: string, patch: Partial<Omit<CommanderAction, 'id'>>): Promise<CommanderAction | null> {
    return this.mutate((state) => {
      const existing = state.commanderActions[id];
      if (!existing) return null;
      const updated = { ...existing, ...patch, id };
      state.commanderActions[id] = updated;
      return updated;
    });
  }

  async listCommanderActions(): Promise<CommanderAction[]> {
    const state = await this.load();
    return Object.values(state.commanderActions).sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id)
    );
  }
}
