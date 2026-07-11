import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentResumeCommand } from '../server/terminal.js';
import type { CodexSession } from '../server/types.js';

function session(agent: 'codex' | 'claude'): CodexSession {
  return {
    id: `${agent}-session-id`,
    agent,
    filePath: `/tmp/${agent}.jsonl`,
    cwd: '/tmp/project',
    startedAt: null,
    updatedAt: null,
    bytes: 0,
    messageCount: 0,
    userTurns: 0,
    assistantTurns: 0,
    lastUserMessage: null,
    lastAssistantMessage: null,
    shellSnapshotCount: 0,
    title: agent,
    customTitle: null,
    resumeCommand: '',
    machineId: 'test',
    activityStatus: 'active',
    lastActiveAt: null,
    inactiveDays: 0,
    kept: false,
    deleted: false,
    evaluation: {} as CodexSession['evaluation'],
  };
}

test('terminal resume command follows the session agent', () => {
  assert.match(createAgentResumeCommand(session('codex'), { CODEX_BIN: 'codex' }), /^codex resume .*codex-session-id/);
  assert.equal(createAgentResumeCommand(session('claude'), { CLAUDE_BIN: 'claude' }), "claude --resume 'claude-session-id'");
});
