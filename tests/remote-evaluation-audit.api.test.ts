import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareSessionVisibility } from '../server/session-audit.js';
import { hasPendingHubEvaluation, shouldQueueHubRemoteEvaluation } from '../server/remote-agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
type JsonRecord = Record<string, unknown>;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.status < 500) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for server startup; logs=${logs.join('').slice(-3000)}`);
}

async function stopServer(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function requestJson<T extends JsonRecord>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function sessionFixture(id: string, cwd: string, marker: string): string {
  const now = new Date().toISOString();
  return [
    JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id, cwd, timestamp: now } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: `${marker}_USER` } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'assistant', content: `${marker}_ASSISTANT` } }),
  ].join('\n') + '\n';
}

test('automatic Hub backfill skips metadata-only remote sessions while keeping them auditable', () => {
  const evaluation = {
    status: 'fallback' as const,
    hermesNeedsRefresh: false,
    evaluationOrigin: 'hub-remote' as const,
    workflow: 'langgraph-session-evaluator-v1:fast-list',
  };
  assert.equal(hasPendingHubEvaluation({ evaluation }), true);
  assert.equal(shouldQueueHubRemoteEvaluation({ messageCount: 0, evaluation }), false);
  assert.equal(shouldQueueHubRemoteEvaluation({ messageCount: 1, evaluation }), true);
  assert.equal(shouldQueueHubRemoteEvaluation({
    messageCount: 1,
    updatedAt: new Date(90_000).toISOString(),
    evaluation,
  }, { nowMs: 120_000, quietMs: 60_000 }), false);
  assert.equal(shouldQueueHubRemoteEvaluation({
    messageCount: 1,
    updatedAt: new Date(30_000).toISOString(),
    evaluation,
  }, { nowMs: 120_000, quietMs: 60_000 }), true);
  assert.equal(hasPendingHubEvaluation({
    evaluation: {
      ...evaluation,
      status: 'ok',
      evaluationOrigin: 'hub-remote',
      workflow: 'langgraph-session-evaluator-v1:needs-refresh:low',
    },
  }), true);
});

test('Hub evaluates a worker transcript, publishes the traced result, uses a worker token, and audits panel completeness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-remote-evaluation-'));
  const workerHome = join(root, 'worker-home');
  const hubHome = join(root, 'hub-home');
  const projectDir = join(root, 'project');
  const workerSessionId = 'remote-evaluation-session';
  const metadataSessionId = 'metadata-only-session';
  const lateSessionId = 'late-panel-session';
  const workerSessionPath = join(workerHome, 'sessions', `${workerSessionId}.jsonl`);
  const hubDuplicateSessionPath = join(hubHome, 'sessions', `${workerSessionId}.jsonl`);
  const metadataSessionPath = join(workerHome, 'sessions', `${metadataSessionId}.jsonl`);
  const lateSessionPath = join(workerHome, 'sessions', `${lateSessionId}.jsonl`);
  const workerState = join(workerHome, 'session-curator-state.json');
  const hubState = join(hubHome, 'session-curator-state.json');
  const workerAuditLog = join(workerHome, 'audit.jsonl');
  const hubAuditLog = join(hubHome, 'audit.jsonl');
  const hubAnalysisLog = join(hubHome, 'analysis.jsonl');
  const workerToken = 'worker-test-token';
  const workerPort = await freePort();
  const hubPort = await freePort();
  const llmPort = await freePort();
  const workerBaseUrl = `http://127.0.0.1:${workerPort}`;
  const hubBaseUrl = `http://127.0.0.1:${hubPort}`;
  const workerLogs: string[] = [];
  const hubLogs: string[] = [];
  let worker: ChildProcessWithoutNullStreams | null = null;
  let hub: ChildProcessWithoutNullStreams | null = null;
  let llmRequestCount = 0;

  await mkdir(dirname(workerSessionPath), { recursive: true });
  await mkdir(dirname(hubDuplicateSessionPath), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(workerSessionPath, sessionFixture(workerSessionId, projectDir, 'REMOTE_EVAL'), 'utf8');
  await writeFile(hubDuplicateSessionPath, `${JSON.stringify({
    type: 'session_meta',
    timestamp: new Date().toISOString(),
    payload: { id: workerSessionId, cwd: projectDir, timestamp: new Date().toISOString() },
  })}\n`, 'utf8');
  await writeFile(metadataSessionPath, `${JSON.stringify({
    type: 'session_meta',
    timestamp: new Date().toISOString(),
    payload: { id: metadataSessionId, cwd: projectDir, timestamp: new Date().toISOString() },
  })}\n`, 'utf8');
  assert.deepEqual(compareSessionVisibility(['indexed', 'missing'], ['indexed', 'unexpected']), {
    missing: ['missing'],
    unexpected: ['unexpected'],
  });
  for (const statePath of [workerState, hubState]) {
    await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {}, commanderActions: {} }), 'utf8');
  }

  const llm = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    llmRequestCount += 1;
    response.setHeader('content-type', 'application/json');
    if (llmRequestCount === 1) {
      response.end(JSON.stringify({ choices: [{ message: { content: 'not valid curator json' } }] }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '远端会话中央评估完成',
            summary: 'Hub 已读取 worker transcript 并完成中央 AI 分析。',
            detailedSummary: '测试确认会话历史由 worker 提供，Hub 完成模型分析并将带哈希的结果安全回写。',
            reasons: ['远端 transcript 可读', 'Hub 模型调用成功'],
            actualWorkdirs: [projectDir],
            directoryIndex: ['project'],
            techStack: ['Curator'],
            keywords: ['remote-evaluation', 'audit'],
            recommendedWorkdir: projectDir,
            remoteMachines: [],
          }),
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => llm.listen(llmPort, '127.0.0.1', resolve));

  try {
    worker = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: workerHome,
        CLAUDE_CONFIG_DIR: join(root, 'worker-claude'),
        CODEX_CURATOR_STATE: workerState,
        CURATOR_SESSION_AUDIT_LOG: workerAuditLog,
        CURATOR_CODEX_JOBS_PATH: join(root, 'worker-jobs.json'),
        CURATOR_RECYCLE_ROOT: join(root, 'worker-recycle'),
        CURATOR_MACHINE_ID: 'worker1',
        CURATOR_ROLE: 'worker',
        CURATOR_AUTH_USER: 'worker',
        CURATOR_AUTH_PASSWORD: 'test-password',
        CURATOR_ADMIN_TOKEN: workerToken,
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_AUTO_BACKFILL_INTERVAL_MS: '0',
        CURATOR_REMOTE_EVALUATION_INTERVAL_MS: '0',
        CURATOR_SESSION_AUDIT_INTERVAL_MS: '0',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        HOST: '127.0.0.1',
        PORT: String(workerPort),
      },
    });
    worker.stdout.on('data', (chunk) => workerLogs.push(chunk.toString('utf8')));
    worker.stderr.on('data', (chunk) => workerLogs.push(chunk.toString('utf8')));
    await waitForServer(workerBaseUrl, worker, workerLogs);

    const unauthenticatedAudit = await fetch(`${workerBaseUrl}/api/audit/completeness`);
    assert.equal(unauthenticatedAudit.status, 401);

    hub = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: hubHome,
        CLAUDE_CONFIG_DIR: join(root, 'hub-claude'),
        CODEX_CURATOR_STATE: hubState,
        CURATOR_SESSION_AUDIT_LOG: hubAuditLog,
        CURATOR_ANALYSIS_LOG: hubAnalysisLog,
        CURATOR_CODEX_JOBS_PATH: join(root, 'hub-jobs.json'),
        CURATOR_RECYCLE_ROOT: join(root, 'hub-recycle'),
        CURATOR_MACHINE_ID: 'hub1',
        CURATOR_ROLE: 'hub',
        CURATOR_REMOTE_AGENTS: `worker1=${workerBaseUrl}`,
        CURATOR_REMOTE_AGENT_TOKEN_WORKER1: workerToken,
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_LLM_BASE_URL: `http://127.0.0.1:${llmPort}`,
        CURATOR_LLM_MODEL: 'test-model',
        CURATOR_LLM_API_KEY: 'test-key',
        CURATOR_LLM_STREAM: '0',
        CURATOR_LLM_RPM: '120',
        CURATOR_LLM_TIMEOUT_MS: '5000',
        CURATOR_EVALUATION_CONCURRENCY: '1',
        CURATOR_REFRESH_QUEUE_CONCURRENCY: '1',
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_REMOTE_SESSION_CACHE_TTL_MS: '10000',
        CURATOR_AUTO_BACKFILL_INTERVAL_MS: '0',
        CURATOR_REMOTE_EVALUATION_INTERVAL_MS: '0',
        CURATOR_SESSION_AUDIT_INTERVAL_MS: '0',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        HOST: '127.0.0.1',
        PORT: String(hubPort),
      },
    });
    hub.stdout.on('data', (chunk) => hubLogs.push(chunk.toString('utf8')));
    hub.stderr.on('data', (chunk) => hubLogs.push(chunk.toString('utf8')));
    await waitForServer(hubBaseUrl, hub, hubLogs);

    const initial = await requestJson<{ sessions: JsonRecord[] }>(hubBaseUrl, '/api/sessions?detail=0');
    const duplicateSessions = initial.sessions.filter((session) => session.id === workerSessionId);
    assert.deepEqual(new Set(duplicateSessions.map((session) => session.machineId)), new Set(['hub1', 'worker1']));
    const initialSession = duplicateSessions.find((session) => session.machineId === 'worker1');
    assert.equal((initialSession?.evaluation as JsonRecord).status, 'fallback');

    const localDetail = await requestJson<{ machineId: string; messageCount: number }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}?machineId=hub1`,
    );
    const remoteDetail = await requestJson<{ machineId: string; messageCount: number }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}?machineId=worker1`,
    );
    assert.equal(localDetail.machineId, 'hub1');
    assert.equal(localDetail.messageCount, 0);
    assert.equal(remoteDetail.machineId, 'worker1');
    assert.equal(remoteDetail.messageCount, 2);

    const localHistory = await requestJson<{ messages: JsonRecord[] }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/history?machineId=hub1&limit=10`,
    );
    const remoteHistory = await requestJson<{ messages: JsonRecord[] }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/history?machineId=worker1&limit=10`,
    );
    assert.equal(localHistory.messages.length, 0);
    assert.deepEqual(remoteHistory.messages.map((message) => message.text), [
      'REMOTE_EVAL_USER',
      'REMOTE_EVAL_ASSISTANT',
    ]);

    const remoteMessages = await requestJson<{ messages: JsonRecord[] }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/messages?machineId=worker1&full=1&preserve=1`,
    );
    assert.deepEqual(remoteMessages.messages.map((message) => message.text), [
      'REMOTE_EVAL_USER',
      'REMOTE_EVAL_ASSISTANT',
    ]);

    const refresh = await requestJson<{ job: JsonRecord }>(
      hubBaseUrl,
      `/api/evaluations/${workerSessionId}/refresh`,
      { method: 'POST', body: JSON.stringify({ machineId: 'worker1' }) },
    );
    const jobId = String(refresh.job.id);
    let job: JsonRecord | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const payload = await requestJson<{ job: JsonRecord }>(hubBaseUrl, `/api/evaluations/refresh-jobs/${jobId}`);
      job = payload.job;
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job?.status, 'completed', JSON.stringify(job));
    assert.equal((job?.result as JsonRecord).machineId, 'worker1');

    const workerSession = await requestJson<{ evaluation: JsonRecord }>(
      workerBaseUrl,
      `/api/sessions/${workerSessionId}`,
      {},
      workerToken,
    );
    assert.equal(workerSession.evaluation.status, 'ok');
    assert.equal(workerSession.evaluation.model, 'test-model');
    assert.equal(workerSession.evaluation.evaluationOrigin, 'hub-remote');
    assert.equal(workerSession.evaluation.evaluatedByMachineId, 'hub1');
    assert.equal(workerSession.evaluation.evaluationRunId, jobId);
    assert.match(String(workerSession.evaluation.transcriptHash), /^[0-9a-f]{64}$/);

    const search = await requestJson<{ sessions: JsonRecord[] }>(
      hubBaseUrl,
      '/api/hermes/session-index?q=remote-evaluation&limit=20',
    );
    assert.ok(search.sessions.some((session) => session.id === workerSessionId));

    const hubEvents = await requestJson<{ events: JsonRecord[] }>(
      hubBaseUrl,
      `/api/audit/events?sessionId=${workerSessionId}&limit=50`,
    );
    assert.ok(hubEvents.events.some((event) => event.event === 'evaluation-started'));
    assert.ok(hubEvents.events.some((event) => event.event === 'evaluation-completed'));
    assert.ok(hubEvents.events.every((event) => !('messages' in event) && !('text' in event)));

    const workerEvents = await requestJson<{ events: JsonRecord[] }>(
      workerBaseUrl,
      `/api/audit/events?sessionId=${workerSessionId}&limit=50`,
      {},
      workerToken,
    );
    assert.ok(workerEvents.events.some((event) => event.event === 'history-read'));
    assert.ok(workerEvents.events.some((event) => event.event === 'evaluation-published'));

    const analysisRecords = (await readFile(hubAnalysisLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as JsonRecord);
    assert.ok(analysisRecords.some((record) =>
      record.sessionId === workerSessionId &&
      record.machineId === 'worker1' &&
      record.runId === jobId &&
      record.source === 'hub-remote' &&
      record.status === 'ok'
    ));
    assert.ok(analysisRecords.some((record) =>
      record.sessionId === workerSessionId &&
      record.runId === jobId &&
      record.phase === 'parse' &&
      record.final === false &&
      record.status === 'failed'
    ));
    assert.ok(analysisRecords.some((record) =>
      record.sessionId === workerSessionId &&
      record.runId === jobId &&
      record.phase === 'parsed' &&
      record.final === true &&
      record.status === 'ok'
    ));

    const completeFleet = await requestJson<{ summary: JsonRecord; remotes: JsonRecord[] }>(hubBaseUrl, '/api/audit/fleet?refresh=1');
    assert.equal(completeFleet.summary.eligibleSessions, 1);
    assert.equal(completeFleet.summary.fullyEvaluatedSessions, 1);
    assert.equal(completeFleet.summary.pendingEvaluationSessions, 0);
    assert.equal(completeFleet.summary.metadataOnlySessions, 2);
    assert.equal(completeFleet.summary.analysisCoveragePercent, 100);
    assert.equal(completeFleet.summary.settledEligibleSessions, 1);
    assert.equal(completeFleet.summary.settledCoveragePercent, 100);
    const completeWorker = completeFleet.remotes.find((remote) => remote.machineId === 'worker1');
    assert.ok(((completeWorker?.report as JsonRecord).skipped as JsonRecord[]).some((finding) =>
      finding.sessionId === metadataSessionId &&
      finding.classification === 'skipped' &&
      (finding.reasons as string[]).includes('metadata-only')
    ));

    await writeFile(lateSessionPath, sessionFixture(lateSessionId, projectDir, 'LATE_PANEL'), 'utf8');
    const staleFleet = await requestJson<{ remotes: JsonRecord[] }>(hubBaseUrl, '/api/audit/fleet');
    const staleWorker = staleFleet.remotes.find((remote) => remote.machineId === 'worker1');
    assert.ok(((staleWorker?.report as JsonRecord).pending as JsonRecord[]).some((issue) =>
      issue.sessionId === lateSessionId &&
      issue.classification === 'pending' &&
      (issue.reasons as string[]).includes('evaluation-fallback')
    ));

    const freshFleet = await requestJson<{ summary: JsonRecord; remotes: JsonRecord[] }>(hubBaseUrl, '/api/audit/fleet?refresh=1');
    const freshWorker = freshFleet.remotes.find((remote) => remote.machineId === 'worker1');
    assert.deepEqual(freshWorker?.missingFromPanel, []);
    assert.equal(freshFleet.summary.missingFromPanel, 0);
  } finally {
    if (hub) await stopServer(hub);
    if (worker) await stopServer(worker);
    if (llm.listening) await closeServer(llm);
    await rm(root, { recursive: true, force: true });
  }
});
