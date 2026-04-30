import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PersistedState, StoredEvaluation } from './types.js';

const EMPTY_STATE: PersistedState = {
  keptIds: [],
  deletedIds: [],
  titles: {},
  evaluations: {},
};

export class CuratorStore {
  private statePath: string;

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        keptIds: Array.isArray(parsed.keptIds) ? parsed.keptIds : [],
        deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
        titles: parsed.titles && typeof parsed.titles === 'object' ? (parsed.titles as Record<string, string>) : {},
        evaluations: parsed.evaluations && typeof parsed.evaluations === 'object' ? parsed.evaluations : {},
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async setKept(id: string, kept: boolean): Promise<PersistedState> {
    const state = await this.load();
    const keptIds = new Set(state.keptIds);
    if (kept) keptIds.add(id);
    else keptIds.delete(id);
    state.keptIds = [...keptIds].sort();
    await this.save(state);
    return state;
  }

  async markDeleted(id: string): Promise<PersistedState> {
    const state = await this.load();
    state.deletedIds = [...new Set([...state.deletedIds, id])].sort();
    delete state.evaluations[id];
    delete state.titles[id];
    state.keptIds = state.keptIds.filter((keptId) => keptId !== id);
    await this.save(state);
    return state;
  }

  async unmarkDeleted(id: string): Promise<PersistedState> {
    const state = await this.load();
    state.deletedIds = state.deletedIds.filter((deletedId) => deletedId !== id);
    await this.save(state);
    return state;
  }

  async setTitle(id: string, title: string): Promise<PersistedState> {
    const state = await this.load();
    const cleanTitle = title.trim();
    if (cleanTitle) state.titles[id] = cleanTitle.slice(0, 120);
    else delete state.titles[id];
    await this.save(state);
    return state;
  }

  async setEvaluation(id: string, evaluation: StoredEvaluation): Promise<void> {
    const state = await this.load();
    state.evaluations[id] = evaluation;
    await this.save(state);
  }
}
