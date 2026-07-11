import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommanderAction, PersistedState, StoredEvaluation } from './types.js';

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

  async save(state: PersistedState): Promise<void> {
    await this.mutate((current) => {
      const deletedIds = new Set(current.deletedIds);
      for (const [id, evaluation] of Object.entries(state.evaluations)) {
        if (!deletedIds.has(id)) current.evaluations[id] = evaluation;
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
      if (!state.deletedIds.includes(id)) state.evaluations[id] = evaluation;
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
