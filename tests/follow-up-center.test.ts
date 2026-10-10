import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FollowUpCenter, analyzeFollowUp, isFollowUpCandidate } from '../server/follow-up-center.js';
import type { CodexSession, HistoryMessage } from '../server/types.js';

function session(endedAt: number, version = 1): CodexSession {
  const timestamp = new Date(endedAt).toISOString();
  return {
    id: 'session-1', machineId: 'gpl001', agent: 'codex', ownerUser: 'grey',
    filePath: '/tmp/session-1.jsonl', cwd: '/tmp/project', title: 'Feature work',
    updatedAt: timestamp, startedAt: timestamp, bytes: version, messageCount: version + 1,
    userTurns: 1, assistantTurns: 1, deleted: false,
    lastUserMessage: { role: 'user', text: 'Please fix it', timestamp: new Date(endedAt - 1000).toISOString() },
    lastAssistantMessage: { role: 'assistant', text: 'I changed it', timestamp },
    evaluation: { summary: 'Feature work summary' },
  } as CodexSession;
}

test('only settled conversations from the last 48 hours qualify', () => {
  const now = Date.now();
  assert.equal(isFollowUpCandidate(session(now - 11 * 60_000), now), true);
  assert.equal(isFollowUpCandidate(session(now - 9 * 60_000), now), false);
  assert.equal(isFollowUpCandidate(session(now - 49 * 60 * 60_000), now), false);
  const pendingUser = session(now - 11 * 60_000);
  pendingUser.lastUserMessage = { role: 'user', text: 'One more thing', timestamp: new Date(now - 10 * 60_000).toISOString() };
  assert.equal(isFollowUpCandidate(pendingUser, now), false);
});

test('verdict persists, dismissal survives reload, and a new turn reopens the reminder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-follow-ups-'));
  const file = join(root, 'follow-ups.json');
  let current = session(Date.now() - 20 * 60_000);
  let analyzed = 0;
  const history: HistoryMessage[] = [{ index: 0, role: 'assistant', text: 'I changed it', timestamp: current.updatedAt }];
  const analyze = async () => {
    analyzed += 1;
    return {
      needsFollowUp: true, priority: 'normal' as const,
      previousTaskSummary: 'Updated the feature', reason: 'Verify the deployment',
      suggestedPrompt: 'Please verify the deployment.', model: 'fixture-model',
    };
  };
  try {
    const center = new FollowUpCenter(file, async () => [current], async () => history, analyze);
    await center.load();
    await center.scan(true);
    assert.equal(analyzed, 1);
    const first = center.snapshot().items[0];
    assert.equal(first.needsFollowUp, true);
    await center.dismiss(first.key, first.version, true);
    assert.ok(center.snapshot().items[0].dismissedAt);
    const restored = new FollowUpCenter(file, async () => [current], async () => history, analyze);
    await restored.load();
    await restored.scan(true);
    assert.equal(analyzed, 1);
    assert.ok(restored.snapshot().items[0].dismissedAt);
    current = session(Date.now() - 11 * 60_000, 2);
    await restored.scan(true);
    assert.equal(analyzed, 2);
    assert.equal(restored.snapshot().items[0].dismissedAt, null);
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as { items: unknown[] }).items.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('flash assessment disables thinking so the answer has room for JSON', async () => {
  const names = ['CURATOR_LLM_BASE_URL', 'CURATOR_LLM_MODEL', 'CURATOR_LLM_API_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  try {
    process.env.CURATOR_LLM_BASE_URL = 'https://example.invalid/v1';
    process.env.CURATOR_LLM_MODEL = 'deepseek-v4.1-flash';
    process.env.CURATOR_LLM_API_KEY = 'fixture-only';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        needsFollowUp: true, priority: 'normal', previousTaskSummary: 'Fixed the UI',
        reason: 'Deployment pending', suggestedPrompt: 'Please deploy and verify.',
      }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const current = session(Date.now() - 20 * 60_000);
    const verdict = await analyzeFollowUp(current, [{ index: 0, role: 'assistant', text: 'Fix complete, deploy pending', timestamp: current.updatedAt }]);
    assert.equal(verdict.needsFollowUp, true);
    assert.deepEqual(requestBody?.thinking, { type: 'disabled' });
    assert.equal(requestBody?.max_tokens, 1600);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
