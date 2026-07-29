import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  findMentionedMachineIds,
  parseAiRankResponse,
  parseAiRouteResponse,
  scoreAiSearchCandidate,
} from '../server/ai-session-search.js';
import type { Evaluation } from '../server/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForServer(baseUrl: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.status < 500) return;
    } catch {
      // The child server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for Curator server; logs=${logs.join('').slice(-2000)}`);
}

async function stopProcess(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

function evaluationFixture(title: string, summary: string, cwd: string, now: string): Evaluation {
  return {
    title,
    summary,
    detailedSummary: `${summary} 详细记录了面板会话重复、复合身份和检索验证。`,
    hermesContext: '',
    hermesContextUpdatedAt: null,
    hermesLastUsedAt: null,
    hermesLastJobId: null,
    hermesNeedsRefresh: false,
    hermesRecalculatedAt: now,
    hermesRefreshStatus: 'ok',
    hermesRefreshError: null,
    recommendation: 'keep',
    score: 9,
    reasons: ['test fixture'],
    actualWorkdirs: [cwd],
    directoryIndex: ['codex-session-curator'],
    techStack: ['TypeScript', 'React'],
    keywords: ['面板', '会话重复', '复合身份'],
    failureCards: [],
    jobOutcomes: [],
    searchText: `${title} ${summary} 面板 会话重复 复合身份`,
    updateCadence: 'quiet',
    reviewPriority: 'normal',
    reviewSignals: [],
    cwdMatchesWorkdir: true,
    recommendedWorkdir: cwd,
    remoteMachines: [],
    evaluatedAt: now,
    workflow: 'test:complete',
    model: 'test',
    status: 'ok',
    error: null,
  };
}

function remoteSession(sessionId: string, cwd: string, now: string) {
  const evaluation = evaluationFixture('远端重复会话修复', '修复 us002 面板点击后多个会话粘连的问题。', cwd, now);
  return {
    id: sessionId,
    agent: 'claude',
    filePath: '/remote/claude/shared-session.jsonl',
    cwd,
    startedAt: now,
    updatedAt: now,
    bytes: 2000,
    messageCount: 8,
    userTurns: 4,
    assistantTurns: 4,
    lastUserMessage: { role: 'user', text: '帮我解决会话重复和点击粘连', timestamp: now },
    lastAssistantMessage: { role: 'assistant', text: '已经改用复合身份', timestamp: now },
    shellSnapshotCount: 0,
    title: evaluation.title,
    customTitle: null,
    resumeCommand: `claude --resume ${sessionId}`,
    machineId: 'us002',
    activityStatus: 'active',
    lastActiveAt: now,
    inactiveDays: 0,
    kept: false,
    deleted: false,
    evaluation,
  };
}

async function requestSearch(baseUrl: string, query: string) {
  const response = await fetch(`${baseUrl}/api/sessions/ai-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: 10,
      machineId: 'all',
      agent: 'all',
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as {
    mode: 'deepseek' | 'fallback-local';
    fallbackReason: string | null;
    intent: string;
    latencyMs: number;
    routing: {
      mode: 'deepseek' | 'user-filter' | 'local-hint' | 'broad';
      scope: 'focused' | 'broad';
      machineIds: string[];
      confidence: number;
      searchTerms: string[];
      fallbackReason: string | null;
    };
    candidateMachineCounts: Record<string, number>;
    matches: Array<{
      identity: { key: string; sessionId: string; machineId: string; agent: string };
      confidence: number;
      reason: string;
    }>;
  };
}

async function runApiScenario(mode: 'rank' | 'timeout' | 'retry' | 'invalid-retry' | 'empty-retry') {
  const testRoot = await mkdtemp(join(tmpdir(), `curator-ai-search-${mode}-`));
  const codexHome = join(testRoot, 'codex-home');
  const claudeHome = join(testRoot, 'claude-home');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(codexHome, 'session-curator-state.json');
  const localCwd = join(testRoot, 'local-project');
  const remoteCwd = '/srv/remote-panel';
  const sessionId = 'shared-session-id';
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const now = new Date().toISOString();
  const evaluation = evaluationFixture('本机会话身份修复', '修复 gpl001 面板重复 session id 的显示问题。', localCwd, now);
  const remote = remoteSession(sessionId, remoteCwd, now);
  const deepSeekCalls: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];

  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(claudeHome, 'projects'), { recursive: true });
  await mkdir(localCwd, { recursive: true });
  await writeFile(sessionFile, '', 'utf8');
  await writeFile(
    statePath,
    JSON.stringify({
      keptIds: [],
      deletedIds: [],
      titles: {},
      evaluations: {
        [sessionId]: {
          ...evaluation,
          filePath: sessionFile,
          mtimeMs: Date.now(),
          bytes: 2000,
          cwd: localCwd,
          startedAt: now,
          updatedAt: now,
          messageCount: 8,
          userTurns: 4,
          assistantTurns: 4,
          shellSnapshotCount: 0,
          lastUserMessage: { role: 'user', text: '面板里重复会话点一个会全部选中', timestamp: now },
          lastAssistantMessage: { role: 'assistant', text: '已使用机器和代理作为身份', timestamp: now },
        },
      },
    }),
    'utf8',
  );

  const remoteServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/sessions') {
      response.end(JSON.stringify({ sessions: [remote] }));
      return;
    }
    if (url.pathname === '/api/meta') {
      response.end(JSON.stringify({ machineId: 'us002' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  const remotePort = await listen(remoteServer);

  const deepSeekServer = createServer(async (request, response) => {
    const call = {
      authorization: request.headers.authorization,
      body: {} as Record<string, unknown>,
    };
    deepSeekCalls.push(call);
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk.toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
    call.body = body;
    const messages = body.messages as Array<{ content?: string }>;
    const systemPrompt = messages[0]?.content ?? '';
    if (systemPrompt.includes('意图规划器')) {
      const prompt = JSON.parse(messages[1]?.content ?? '{}') as {
        availableMachineIds?: string[];
        machines?: Array<{ machineId: string }>;
      };
      assert.deepEqual(prompt.availableMachineIds, ['gpl001', 'us002']);
      assert.deepEqual(prompt.machines?.map((machine) => machine.machineId), ['gpl001', 'us002']);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: '寻找修复面板重复 session id 与点击粘连的会话',
              machineIds: ['us002'],
              confidence: 0.91,
              searchTerms: ['面板重复', '点击粘连', '复合身份'],
              reason: 'us002 的代表会话直接包含点击粘连',
            }),
          },
        }],
      }));
      return;
    }
    if (mode === 'timeout' || (mode === 'retry' && deepSeekCalls.length === 1)) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.flushHeaders();
      request.on('aborted', () => response.destroy());
      return;
    }
    if (mode === 'invalid-retry' && deepSeekCalls.length === 1) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        choices: [{ message: { content: '{"intent":"truncated"' } }],
      }));
      return;
    }
    if (mode === 'empty-retry' && deepSeekCalls.length === 1) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        choices: [{ message: { content: '' } }],
      }));
      return;
    }
    const prompt = JSON.parse(messages[1]?.content ?? '{}') as {
      candidates?: Array<{ candidateId: string; machine: string }>;
    };
    const localCandidate = prompt.candidates?.find((candidate) => candidate.machine === 'gpl001');
    const remoteCandidate = prompt.candidates?.find((candidate) => candidate.machine === 'us002');
    assert.ok(localCandidate);
    assert.ok(remoteCandidate);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: '寻找修复面板重复 session id 与点击粘连的会话',
            machineIds: ['us002'],
            machineConfidence: 0.91,
            searchTerms: ['面板重复', '点击粘连', '复合身份'],
            machineReason: 'us002 候选摘要直接包含点击粘连',
            matches: [
              { candidateId: remoteCandidate.candidateId, confidence: 0.96, reason: '远端摘要直接提到点击粘连' },
              { candidateId: 'c999', confidence: 0.99, reason: '模型虚构编号，必须被过滤' },
              { candidateId: localCandidate.candidateId, confidence: 0.91, reason: '本地摘要提到重复 session id' },
            ],
          }),
        },
      }],
    }));
  });
  const deepSeekPort = await listen(deepSeekServer);
  const port = 56_000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let curatorServer: ChildProcessWithoutNullStreams | null = null;

  try {
    curatorServer = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_CODEX_JOBS_PATH: join(testRoot, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'gpl001',
        CURATOR_REMOTE_AGENTS: `us002=http://127.0.0.1:${remotePort}`,
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_KNOWLEDGE_GATEWAY_ENABLED: '0',
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_REMOTE_SESSION_CACHE_TTL_MS: '0',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        CURATOR_AUTO_BACKFILL: '0',
        CURATOR_AI_SEARCH_BASE_URL: `http://127.0.0.1:${deepSeekPort}`,
        CURATOR_AI_SEARCH_MODEL: 'deepseek-test',
        CURATOR_AI_SEARCH_API_KEY: 'test-key',
        CURATOR_AI_SEARCH_ALLOW_NON_DEEPSEEK_URL: '1',
        CURATOR_AI_SEARCH_TIMEOUT_MS:
          mode === 'rank' || mode === 'retry' || mode === 'invalid-retry' || mode === 'empty-retry'
            ? '5000'
            : '2800',
        CURATOR_AI_SEARCH_PRIMARY_TIMEOUT_MS: mode === 'retry' ? '500' : '6500',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    curatorServer.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    curatorServer.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, curatorServer, logs);
    const payload = await requestSearch(
      baseUrl,
      mode === 'timeout'
        ? 'us002上之前修复面板会话重复粘连的对话'
        : '之前修复面板会话重复粘连的对话',
    );
    return { payload, deepSeekCalls };
  } finally {
    if (curatorServer) await stopProcess(curatorServer);
    await closeServer(remoteServer);
    await closeServer(deepSeekServer);
    await rm(testRoot, { recursive: true, force: true });
  }
}

test('AI rank parser accepts fenced JSON and fuzzy local scoring favors matching content', () => {
  const parsed = parseAiRankResponse('reasoning\n```json\n{"intent":"面板修复","matches":[{"candidate_id":"c2","confidence":0.8,"reason":"摘要匹配"}]}\n```');
  assert.deepEqual(parsed, {
    intent: '面板修复',
    machineIds: [],
    machineConfidence: 0.5,
    searchTerms: [],
    machineReason: '',
    matches: [{ candidateId: 'c2', confidence: 0.8, reason: '摘要匹配' }],
  });
  const base = {
    sessionId: 'fixture',
    machineId: 'gpl001',
    agent: 'codex' as const,
    title: '普通会话',
    summary: '处理文档',
    detailedSummary: '',
    cwd: '/tmp/project',
    keywords: [] as string[],
    techStack: [] as string[],
    updatedAt: null,
    lastUserMessage: '',
    kept: false,
  };
  assert.ok(
    scoreAiSearchCandidate(
      { ...base, summary: '修复面板会话重复和点击粘连', keywords: ['复合身份'] },
      '之前面板重复粘连的对话',
    ) > scoreAiSearchCandidate(base, '之前面板重复粘连的对话'),
  );
  assert.ok(
    scoreAiSearchCandidate(
      { ...base, machineId: 'cnal002' },
      'cnal002的工作站',
    ) > scoreAiSearchCandidate(base, 'cnal002的工作站'),
  );
  assert.deepEqual(
    findMentionedMachineIds('帮我找 cnal002的工作站 上的对话', ['gpl001', 'cnal002', 'us002']),
    ['cnal002'],
  );
});

test('AI machine route parser keeps registered machines and expands fuzzy search terms', () => {
  const parsed = parseAiRouteResponse(
    '```json\n{"intent":"找远端面板修复","machine_ids":["us002","invented"],"confidence":0.87,"search_terms":["面板粘连","复合身份"],"reason":"远端摘要匹配"}\n```',
    ['gpl001', 'us002'],
  );
  assert.deepEqual(parsed, {
    intent: '找远端面板修复',
    machineIds: ['us002'],
    confidence: 0.87,
    searchTerms: ['面板粘连', '复合身份'],
    reason: '远端摘要匹配',
  });
});

test('AI rank parser tolerates single-machine, percentage confidence, and candidate-id arrays', () => {
  const parsed = parseAiRankResponse(JSON.stringify({
    result: {
      intent: '找工作站会话',
      machine: 'cnal002',
      machine_confidence: '98%',
      search_terms: '工作站，远端会话',
      machine_reason: '明确机器',
      candidate_ids: ['c2', 'c1'],
    },
  }));
  assert.deepEqual(parsed, {
    intent: '找工作站会话',
    machineIds: ['cnal002'],
    machineConfidence: 0.98,
    searchTerms: ['工作站', '远端会话'],
    machineReason: '明确机器',
    matches: [
      { candidateId: 'c2', confidence: 0.9, reason: '' },
      { candidateId: 'c1', confidence: 0.87, reason: '' },
    ],
  });
});

test('AI rank parser recovers ordered candidate IDs from non-JSON model output', () => {
  const parsed = parseAiRankResponse('优先选择 candidate-4，然后是 c2；其余候选不够相关。');
  assert.deepEqual(parsed, {
    intent: '',
    machineIds: [],
    machineConfidence: 0.5,
    searchTerms: [],
    machineReason: '',
    matches: [
      { candidateId: 'c4', confidence: 0.82, reason: '' },
      { candidateId: 'c2', confidence: 0.79, reason: '' },
    ],
  });
});

test('DeepSeek reranking filters invented IDs and keeps duplicate session IDs isolated by machine and agent', async () => {
  const { payload, deepSeekCalls } = await runApiScenario('rank');
  assert.equal(payload.mode, 'deepseek', JSON.stringify({
    fallbackReason: payload.fallbackReason,
    routing: payload.routing,
    deepSeekCallCount: deepSeekCalls.length,
  }));
  assert.match(payload.intent, /重复 session id/);
  assert.equal(payload.routing.mode, 'deepseek');
  assert.equal(payload.routing.scope, 'focused');
  assert.deepEqual(payload.routing.machineIds, ['us002']);
  assert.deepEqual(payload.routing.searchTerms, ['面板重复', '点击粘连', '复合身份']);
  assert.equal(payload.matches.length, 2);
  assert.deepEqual(payload.matches.map((match) => match.identity.machineId), ['us002', 'gpl001']);
  assert.deepEqual(payload.matches.map((match) => match.identity.sessionId), ['shared-session-id', 'shared-session-id']);
  assert.equal(new Set(payload.matches.map((match) => match.identity.key)).size, 2);
  assert.equal(deepSeekCalls.length, 1);
  assert.ok(deepSeekCalls.every((call) => call.authorization === 'Bearer test-key'));
});

test('DeepSeek timeout keeps an explicit registered-machine hint and returns enhanced local matches', async () => {
  const { payload, deepSeekCalls } = await runApiScenario('timeout');
  assert.equal(payload.mode, 'fallback-local');
  assert.equal(payload.fallbackReason, 'timeout');
  assert.equal(payload.routing.mode, 'local-hint');
  assert.deepEqual(payload.routing.machineIds, ['us002']);
  assert.ok(payload.matches.length >= 2);
  assert.equal(payload.matches[0].identity.machineId, 'us002');
  assert.match(payload.matches[0].reason, /机器提示/);
  assert.ok(
    payload.latencyMs >= 2_000 && payload.latencyMs < 4_500,
    `timeout fallback escaped its bounded deadline: ${payload.latencyMs}ms`,
  );
  assert.equal(new Set(payload.matches.map((match) => match.identity.key)).size, payload.matches.length);
  assert.equal(deepSeekCalls.length, 1);
});

test('DeepSeek tail latency retries once with a compact rescue candidate set', async () => {
  const { payload, deepSeekCalls } = await runApiScenario('retry');
  assert.equal(payload.mode, 'deepseek', JSON.stringify({
    fallbackReason: payload.fallbackReason,
    routing: payload.routing,
    deepSeekCallCount: deepSeekCalls.length,
  }));
  assert.equal(payload.fallbackReason, null);
  assert.equal(payload.routing.mode, 'deepseek');
  assert.deepEqual(payload.routing.machineIds, ['us002']);
  assert.equal(deepSeekCalls.length, 2);
  const rescueMessages = deepSeekCalls[1].body.messages as Array<{ content?: string }>;
  const rescuePrompt = JSON.parse(rescueMessages[1]?.content ?? '{}') as {
    rescue?: boolean;
    candidates?: unknown[];
  };
  assert.equal(rescuePrompt.rescue, true);
  assert.ok((rescuePrompt.candidates?.length ?? 0) <= 10);
});

test('DeepSeek invalid JSON retries once with the compact rescue candidate set', async () => {
  const { payload, deepSeekCalls } = await runApiScenario('invalid-retry');
  assert.equal(payload.mode, 'deepseek');
  assert.equal(payload.fallbackReason, null);
  assert.deepEqual(payload.routing.machineIds, ['us002']);
  assert.equal(deepSeekCalls.length, 2);
  const rescueMessages = deepSeekCalls[1].body.messages as Array<{ content?: string }>;
  const rescuePrompt = JSON.parse(rescueMessages[1]?.content ?? '{}') as { rescue?: boolean };
  assert.equal(rescuePrompt.rescue, true);
});

test('DeepSeek empty content retries once with the compact rescue candidate set', async () => {
  const { payload, deepSeekCalls } = await runApiScenario('empty-retry');
  assert.equal(payload.mode, 'deepseek');
  assert.equal(payload.fallbackReason, null);
  assert.deepEqual(payload.routing.machineIds, ['us002']);
  assert.equal(deepSeekCalls.length, 2);
});
