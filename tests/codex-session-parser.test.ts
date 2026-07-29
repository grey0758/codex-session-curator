import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSessionFile } from '../server/session-parser.js';

test('Codex subagent rollouts keep their own identity when parent metadata is embedded later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-codex-parser-'));
  const childId = '019f88b0-7eaa-7ab3-8eda-1e012d0325c8';
  const parentId = '019f8878-e6c1-7ae3-b2ab-803e575daad3';
  const sessionPath = join(
    root,
    'sessions',
    `rollout-2026-07-22T00-18-15-${childId}.jsonl`,
  );

  try {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-22T07:18:15.978Z',
        payload: {
          id: childId,
          cwd: '/tmp/child-project',
          timestamp: '2026-07-22T07:18:15.978Z',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentId,
                depth: 1,
                agent_path: '/root/example',
              },
            },
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-22T07:18:16.000Z',
        payload: { role: 'user', content: 'CHILD_USER' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-22T07:18:17.000Z',
        payload: { role: 'assistant', content: 'CHILD_ASSISTANT' },
      }),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-22T06:17:32.609Z',
        payload: {
          id: parentId,
          cwd: '/tmp/parent-project',
          timestamp: '2026-07-22T06:17:32.609Z',
          source: 'cli',
        },
      }),
    ].join('\n') + '\n', 'utf8');

    const parsed = await parseSessionFile(sessionPath);
    assert.equal(parsed.source, 'codex');
    assert.equal(parsed.id, childId);
    assert.equal(parsed.cwd, '/tmp/child-project');
    assert.equal(parsed.startedAt, '2026-07-22T07:18:15.978Z');
    assert.equal(parsed.updatedAt, '2026-07-22T07:18:17.000Z');
    assert.equal(parsed.userTurns, 1);
    assert.equal(parsed.assistantTurns, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
