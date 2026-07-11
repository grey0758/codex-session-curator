import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CuratorStore } from '../server/store.js';
import type { StoredEvaluation } from '../server/types.js';

function evaluation(id: string, summary: string): StoredEvaluation {
  return {
    title: id,
    summary,
    detailedSummary: summary,
    recommendation: 'review',
    score: 0,
    reasons: [],
    actualWorkdirs: [],
    directoryIndex: [],
    techStack: [],
    keywords: [],
    searchText: summary,
    updateCadence: 'quiet',
    reviewPriority: 'normal',
    reviewSignals: [],
    cwdMatchesWorkdir: null,
    recommendedWorkdir: null,
    remoteMachines: [],
    evaluatedAt: '2026-07-11T00:00:00.000Z',
    workflow: 'test',
    model: 'test',
    status: 'ok',
    error: null,
    filePath: `/tmp/${id}.jsonl`,
    mtimeMs: 1,
    bytes: 1,
  };
}

test('stale evaluation saves preserve the latest manual session state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-store-concurrency-'));
  const statePath = join(root, 'session-curator-state.json');
  const firstStore = new CuratorStore(statePath);
  const secondStore = new CuratorStore(statePath);
  const sessionId = 'session-1';

  try {
    await firstStore.setEvaluation(sessionId, evaluation(sessionId, 'initial'));
    const staleState = await firstStore.load();

    await Promise.all([
      firstStore.setKept(sessionId, true),
      secondStore.setTitle(sessionId, '保留标题'),
    ]);

    staleState.evaluations[sessionId] = evaluation(sessionId, 'background refresh');
    await secondStore.save(staleState);

    const persisted = await firstStore.load();
    assert.deepEqual(persisted.keptIds, [sessionId]);
    assert.equal(persisted.titles[sessionId], '保留标题');
    assert.equal(persisted.evaluations[sessionId]?.summary, 'background refresh');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
