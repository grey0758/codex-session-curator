import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentResumeCommand,
  createTmuxAgentResumeCommand,
  getCodexWorkerBin,
  mergeCodexWorkerEnv,
  normalizeCodexWorkerEnv,
  remoteAgentCommand,
  sanitizeCodexTerminalEnv,
  terminalTransportForSession,
} from '../server/terminal.js';
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
  assert.match(createAgentResumeCommand(session('codex')), /codex(?:\.js)? resume .*codex-session-id/);
  assert.equal(createAgentResumeCommand(session('claude'), { CLAUDE_BIN: 'claude' }), "claude --resume 'claude-session-id'");
});

test('terminal resume ignores service-level provider, model, and binary overrides', () => {
  const command = createAgentResumeCommand(session('codex'), {
    CODEX_BIN: process.execPath,
    CURATOR_TERMINAL_CODEX_BASE_URL_TEST: 'https://api.example.test/v1',
    CURATOR_TERMINAL_CODEX_API_KEY_TEST: 'secret-must-not-appear',
    CURATOR_TERMINAL_CODEX_MODEL_TEST: 'gpt-5.6-sol',
    CURATOR_TERMINAL_CODEX_ENV_FILE_TEST: '/run/user/1000/curator-terminal-codex.env',
  });

  assert.match(command, /codex(?:\.js)? resume/);
  assert.doesNotMatch(command, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(command, /curator-terminal|model_provider|model_providers|--model/);
  assert.doesNotMatch(command, /secret-must-not-appear/);
});

test('worker binary honors a valid explicit service override', () => {
  assert.equal(getCodexWorkerBin({ CODEX_BIN: process.execPath }), process.execPath);
});

test('terminal environment removes inherited evaluator auth without changing unrelated state', () => {
  const env = sanitizeCodexTerminalEnv({
    OPENAI_API_KEY: 'remove-openai-key',
    CODEX_API_KEY: 'remove-codex-key',
    API_KEY: 'remove-generic-key',
    OPENAI_BASE_URL: 'https://remove-openai.example/v1',
    CODEX_BASE_URL: 'https://remove-codex.example/v1',
    BASE_URL: 'https://remove-generic.example/v1',
    CODEX_HOME: '/home/grey/.codex',
    CURATOR_TERMINAL_TRANSPORT_TEST: 'ssh',
  });

  for (const name of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_BASE_URL',
    'BASE_URL',
  ]) {
    assert.equal(env[name], undefined);
  }
  assert.equal(env.CODEX_HOME, '/home/grey/.codex');
  assert.equal(env.CURATOR_TERMINAL_TRANSPORT_TEST, 'ssh');
});

test('worker environment preserves service auth and maps legacy generic aliases', () => {
  const env = normalizeCodexWorkerEnv({
    OPENAI_API_KEY: 'worker-openai-key',
    API_KEY: 'worker-generic-key',
    BASE_URL: 'https://worker.example.test/v1',
  });

  assert.equal(env.OPENAI_API_KEY, 'worker-openai-key');
  assert.equal(env.API_KEY, 'worker-generic-key');
  assert.equal(env.CODEX_API_KEY, 'worker-generic-key');
  assert.equal(env.CODEX_BASE_URL, 'https://worker.example.test/v1');
});

test('explicit worker service settings override conflicting login-shell values', () => {
  const env = mergeCodexWorkerEnv(
    {
      CODEX_BIN: '/shell/codex',
      CODEX_API_KEY: 'shell-key',
      CODEX_BASE_URL: 'https://shell.example.test/v1',
    },
    {
      CODEX_BIN: process.execPath,
      CODEX_API_KEY: 'service-key',
      CODEX_BASE_URL: 'https://service.example.test/v1',
    },
  );

  assert.equal(env.CODEX_BIN, process.execPath);
  assert.equal(env.CODEX_API_KEY, 'service-key');
  assert.equal(env.CODEX_BASE_URL, 'https://service.example.test/v1');
});

test('terminal transport supports a machine-scoped local override', () => {
  assert.equal(
    terminalTransportForSession(session('codex'), {
      CURATOR_TERMINAL_TRANSPORT: 'auto',
      CURATOR_TERMINAL_TRANSPORT_TEST: 'local',
    }),
    'local'
  );
});

test('tmux resume re-enters the grey login shell without sourcing a panel provider', () => {
  const command = createTmuxAgentResumeCommand(session('codex'), {
    CURATOR_TERMINAL_CODEX_BASE_URL_TEST: 'https://api.example.test/v1',
    CURATOR_TERMINAL_CODEX_API_KEY_TEST: 'secret-must-not-appear',
    CURATOR_TERMINAL_CODEX_ENV_FILE_TEST: '/run/user/1000/curator-terminal-codex.env',
  });

  assert.match(command, /^exec "\$\{SHELL:-\/bin\/bash\}" -l -c /);
  assert.match(command, /codex(?:\.js)? resume/);
  assert.doesNotMatch(command, /curator-terminal|CURATOR_TERMINAL_CODEX|secret-must-not-appear/);
});

test('remote resume uses the target login shell without forwarding panel configuration', () => {
  const target = session('codex');
  target.machineId = 'cnal002';
  const command = remoteAgentCommand(target, 160, 42);

  assert.match(command, /exec "\$\{SHELL:-\/bin\/bash\}" -l -c/);
  assert.match(command, /codex resume/);
  assert.doesNotMatch(command, /terminal-codex\.env|curator-terminal|model_provider|--model|secret-must-not-appear/);
});

test('remote resume without a recorded cwd uses the target grey home', () => {
  const target = session('codex');
  target.cwd = null;
  target.machineId = 'cnal002';
  const command = remoteAgentCommand(target, 160, 42);

  assert.match(command, /-C "\$HOME"/);
  assert.doesNotMatch(command, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
