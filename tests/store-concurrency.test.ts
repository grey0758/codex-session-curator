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

test('concurrent durable job facts survive later model refreshes with empty fact arrays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-store-durable-facts-'));
  const statePath = join(root, 'session-curator-state.json');
  const firstStore = new CuratorStore(statePath);
  const secondStore = new CuratorStore(statePath);
  const sessionId = 'durable-facts-session';
  const stateKey = `codex|||${sessionId}`;
  const now = '2026-07-29T00:00:00.000Z';

  try {
    const initial = evaluation(sessionId, 'initial');
    initial.filePath = `/tmp/${sessionId}.jsonl`;
    await firstStore.setEvaluation(stateKey, initial);

    await Promise.all([
      firstStore.updateEvaluation(stateKey, (current) => current ? {
        ...current,
        jobOutcomes: [{
          id: 'outcome-1',
          at: now,
          jobId: 'job-1',
          sessionId,
          machineId: 'gpl001',
          agent: 'codex',
          status: 'completed',
          mode: 'exec',
          goal: 'preserve the outcome',
          cwd: '/tmp',
          changedFiles: ['server/store.ts'],
          tests: ['store concurrency'],
          nextAction: null,
          failureReason: null,
          needsReview: false,
          summary: 'durable job outcome',
        }],
      } : null),
      secondStore.updateEvaluation(stateKey, (current) => current ? {
        ...current,
        failureCards: [{
          id: 'failure-1',
          at: now,
          jobId: 'job-2',
          category: 'test',
          title: 'durable failure title',
          summary: 'durable failure summary',
          evidence: 'durable failure evidence',
        }],
      } : null),
    ]);

    const refreshed = evaluation(sessionId, 'model refresh');
    refreshed.filePath = `/tmp/${sessionId}.jsonl`;
    refreshed.jobOutcomes = [];
    refreshed.failureCards = [];
    refreshed.keywords = [];
    refreshed.reviewSignals = [];
    await firstStore.setEvaluation(stateKey, refreshed);

    const persisted = await secondStore.load();
    const stored = persisted.evaluations[stateKey];
    assert.equal(stored.summary, 'model refresh');
    assert.deepEqual(stored.jobOutcomes?.map((item) => item.jobId), ['job-1']);
    assert.equal(stored.jobOutcomes?.[0]?.agent, 'codex');
    assert.deepEqual(stored.failureCards?.map((item) => item.id), ['failure-1']);
    assert.match(stored.searchText, /durable job outcome/);
    assert.match(stored.searchText, /durable failure summary/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy raw session state migrates only when the active agent identity is unique', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-store-legacy-identity-'));
  const statePath = join(root, 'session-curator-state.json');
  const store = new CuratorStore(statePath);

  try {
    await store.setKept('unique-id', true);
    await store.markDeleted('deleted-id');
    await store.setTitle('unique-id', 'legacy title');
    await store.setEvaluation('unique-id', evaluation('unique-id', 'legacy evaluation'));
    await store.setKept('duplicate-id', true);
    await store.setTitle('duplicate-id', 'ambiguous title');
    await store.setEvaluation('duplicate-id', evaluation('duplicate-id', 'ambiguous evaluation'));

    const migrated = await store.migrateLegacySessionKeys([
      {
        id: 'unique-id',
        stateKey: 'codex|||unique-id',
        agent: 'codex',
        filePath: '/tmp/unique-id.jsonl',
      },
      {
        id: 'deleted-id',
        stateKey: 'claude|||deleted-id',
        agent: 'claude',
        filePath: '/tmp/.claude/projects/deleted-id.jsonl',
      },
      {
        id: 'duplicate-id',
        stateKey: 'codex|||duplicate-id',
        agent: 'codex',
        filePath: '/tmp/duplicate-id.jsonl',
      },
      {
        id: 'duplicate-id',
        stateKey: 'claude|||duplicate-id',
        agent: 'claude',
        filePath: '/tmp/.claude/projects/duplicate-id.jsonl',
      },
    ]);

    assert.ok(migrated.keptIds.includes('codex|||unique-id'));
    assert.ok(!migrated.keptIds.includes('unique-id'));
    assert.ok(migrated.deletedIds.includes('deleted-id'));
    assert.ok(!migrated.deletedIds.includes('claude|||deleted-id'));
    assert.equal(migrated.titles['codex|||unique-id'], 'legacy title');
    assert.equal(migrated.titles['unique-id'], undefined);
    assert.equal(migrated.evaluations['codex|||unique-id']?.summary, 'legacy evaluation');
    assert.equal(migrated.evaluations['unique-id'], undefined);

    assert.ok(migrated.keptIds.includes('duplicate-id'));
    assert.equal(migrated.titles['duplicate-id'], 'ambiguous title');
    assert.equal(migrated.evaluations['duplicate-id']?.summary, 'ambiguous evaluation');
    assert.equal(migrated.titles['codex|||duplicate-id'], undefined);
    assert.equal(migrated.titles['claude|||duplicate-id'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy evaluation is quarantined when its file path belongs to a different Agent identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-store-legacy-agent-mismatch-'));
  const statePath = join(root, 'session-curator-state.json');
  const store = new CuratorStore(statePath);
  const sessionId = 'reused-session-id';

  try {
    const claudeEvaluation = evaluation(sessionId, 'old Claude summary');
    claudeEvaluation.filePath = join(root, '.claude', 'projects', '-old', `${sessionId}.jsonl`);
    await store.setKept(sessionId, true);
    await store.setTitle(sessionId, 'old Claude title');
    await store.setEvaluation(sessionId, claudeEvaluation);

    const migrated = await store.migrateLegacySessionKeys([{
      id: sessionId,
      stateKey: `codex|||${sessionId}`,
      agent: 'codex',
      filePath: join(root, '.codex', 'sessions', `${sessionId}.jsonl`),
    }]);

    assert.ok(migrated.keptIds.includes(sessionId));
    assert.ok(!migrated.keptIds.includes(`codex|||${sessionId}`));
    assert.equal(migrated.titles[sessionId], 'old Claude title');
    assert.equal(migrated.titles[`codex|||${sessionId}`], undefined);
    assert.equal(migrated.evaluations[sessionId]?.summary, 'old Claude summary');
    assert.equal(migrated.evaluations[`codex|||${sessionId}`], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
