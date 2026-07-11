import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSessionFile, parseSessionHistory } from '../server/session-parser.js';

test('Claude JSONL sessions expose the same conversation metadata as Codex sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-claude-parser-'));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claudeHome = join(root, '.claude');
  const sessionPath = join(claudeHome, 'projects', '-tmp-project', 'claude-session-1.jsonl');
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  try {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'user',
        sessionId: 'claude-session-1',
        cwd: '/tmp/project',
        timestamp: '2026-07-12T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'CLAUDE_USER_MARKER' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-session-1',
        cwd: '/tmp/project',
        timestamp: '2026-07-12T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE_ASSISTANT_MARKER' }] },
      }),
    ].join('\n') + '\n', 'utf8');

    const parsed = await parseSessionFile(sessionPath);
    assert.equal(parsed.source, 'claude');
    assert.equal(parsed.id, 'claude-session-1');
    assert.equal(parsed.cwd, '/tmp/project');
    assert.equal(parsed.userTurns, 1);
    assert.equal(parsed.assistantTurns, 1);
    assert.equal(parsed.lastUserMessage?.text, 'CLAUDE_USER_MARKER');
    assert.equal(parsed.lastAssistantMessage?.text, 'CLAUDE_ASSISTANT_MARKER');

    const history = await parseSessionHistory({ filePath: sessionPath, limit: 10 });
    assert.deepEqual(history.messages.map((message) => message.role), ['user', 'assistant']);
  } finally {
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    await rm(root, { recursive: true, force: true });
  }
});
