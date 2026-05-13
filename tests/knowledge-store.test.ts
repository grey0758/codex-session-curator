import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeStore } from '../server/knowledge-store.ts';

test('KnowledgeStore creates, updates, searches, filters, and redacts items through FTS5', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-knowledge-store-'));
  const store = new KnowledgeStore(join(testRoot, 'knowledge.sqlite'));

  try {
    assert.equal(store.hasFts(), true);

    const created = await store.createItem({
      id: 'runbook-api',
      type: 'runbook',
      scope: 'project',
      title: 'Deploy API runbook sk-1234567890abcdef',
      text: 'Restart the billing API with token nvapi-1234567890abcdef before checking queues.',
      project: 'billing',
      repo: '/srv/billing-api',
      cwd: '/srv/billing-api/server',
      machineId: 'machine-a',
      tags: ['deploy', 'api', 'sk-abcdef1234567890'],
      source: 'worker note sk-source1234567890',
      confidence: 0.8,
      lastVerifiedAt: '2026-05-13T00:00:00.000Z',
    });

    assert.equal(created.title, 'Deploy API runbook [redacted]');
    assert.match(created.text, /\[redacted\]/);
    assert.deepEqual(created.tags, ['deploy', 'api', '[redacted]']);
    assert.equal(created.source, 'worker note [redacted]');

    await store.createItem({
      id: 'preference-ui',
      type: 'preference',
      title: 'UI preference',
      text: 'Keep dashboard filters compact.',
      project: 'curator',
      repo: '/srv/curator',
      tags: ['ui'],
    });

    const search = await store.search({ q: 'billing API', limit: 10 });
    assert.equal(search.length, 1);
    assert.equal(search[0].item.id, 'runbook-api');
    assert.equal(search[0].item.type, 'runbook');
    assert.ok(search[0].score > 0);

    const filteredOut = await store.search({ q: 'API', type: 'preference', limit: 10 });
    assert.equal(filteredOut.length, 0);

    const filteredIn = await store.search({ q: 'API', project: 'billing', repo: '/srv/billing-api', limit: 10 });
    assert.equal(filteredIn.length, 1);
    assert.equal(filteredIn[0].item.id, 'runbook-api');

    const updated = await store.updateItem('runbook-api', {
      text: 'Restart the ledger API and verify invoice workers.',
      tags: ['ledger', 'invoice'],
      confidence: 0.95,
    });
    assert.ok(updated);
    assert.equal(updated.confidence, 0.95);
    assert.deepEqual(updated.tags, ['ledger', 'invoice']);
    assert.match(updated.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const oldTerm = await store.search({ q: 'billing', limit: 10 });
    assert.equal(oldTerm.length, 0);

    const newTerm = await store.search({ q: 'ledger invoice', limit: 10 });
    assert.equal(newTerm.length, 1);
    assert.equal(newTerm[0].item.id, 'runbook-api');

    const fetched = await store.getItem('runbook-api');
    assert.equal(fetched?.text, 'Restart the ledger API and verify invoice workers.');
  } finally {
    store.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
