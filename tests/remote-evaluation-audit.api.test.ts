import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  const projectDir = join(root, 'worker-project');
  const hubProjectDir = join(root, 'hub-project');
  const migrationTargetDir = join(root, 'migration-target');
  const externalUploadTarget = join(root, 'outside-upload-target.txt');
  const fakeBinDir = join(root, 'bin');
  const fakeSshBin = join(fakeBinDir, 'ssh');
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
  await mkdir(hubProjectDir, { recursive: true });
  await mkdir(migrationTargetDir, { recursive: true });
  await mkdir(fakeBinDir, { recursive: true });
  const workerSessionContent = sessionFixture(workerSessionId, projectDir, 'REMOTE_EVAL');
  const hubDuplicateSessionContent = `${JSON.stringify({
    type: 'session_meta',
    timestamp: new Date().toISOString(),
    payload: { id: workerSessionId, cwd: hubProjectDir, timestamp: new Date().toISOString() },
  })}\n`;
  await writeFile(workerSessionPath, workerSessionContent, 'utf8');
  await writeFile(hubDuplicateSessionPath, hubDuplicateSessionContent, 'utf8');
  await writeFile(join(projectDir, 'route.txt'), 'worker1-file\n', 'utf8');
  await writeFile(join(hubProjectDir, 'route.txt'), 'hub1-file\n', 'utf8');
  await writeFile(externalUploadTarget, 'outside-original\n', 'utf8');
  await symlink(externalUploadTarget, join(projectDir, 'escape-link.txt'));
  await symlink(externalUploadTarget, join(hubProjectDir, 'escape-link.txt'));
  await writeFile(
    fakeSshBin,
    `#!/usr/bin/env bash
set -euo pipefail
target=""
while (($#)); do
  case "$1" in
    -o|-i|-F|-p|-l)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      target="$1"
      shift
      break
      ;;
  esac
done
[[ "$target" == worker1-ssh ]]
[[ "$#" -eq 1 ]]
exec /bin/bash -c "$1"
`,
    'utf8',
  );
  await chmod(fakeSshBin, 0o755);
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
        CODEX_BIN: '/bin/true',
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
        CURATOR_TERMINAL_SSH_TARGET_WORKER1: 'worker1-ssh',
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
        CODEX_BIN: '/bin/true',
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
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

    const ambiguousRawDetail = await fetch(
      `${hubBaseUrl}/api/sessions/${workerSessionId}`,
    );
    assert.equal(ambiguousRawDetail.status, 409);
    assert.equal(
      ((await ambiguousRawDetail.json()) as { code?: string }).code,
      'AMBIGUOUS_SESSION_IDENTITY',
    );
    const ambiguousRawFiles = await fetch(
      `${hubBaseUrl}/api/sessions/${workerSessionId}/files`,
    );
    assert.equal(ambiguousRawFiles.status, 409);

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

    const localFiles = await requestJson<{ machineId: string; cwd: string; entries: JsonRecord[] }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/files?machineId=hub1`,
    );
    const remoteFiles = await requestJson<{ machineId: string; cwd: string; entries: JsonRecord[] }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/files?machineId=worker1`,
    );
    assert.equal(localFiles.machineId, 'hub1');
    assert.equal(localFiles.cwd, hubProjectDir);
    assert.ok(localFiles.entries.some((entry) => entry.name === 'route.txt'));
    assert.equal(remoteFiles.machineId, 'worker1');
    assert.equal(remoteFiles.cwd, projectDir);
    assert.ok(remoteFiles.entries.some((entry) => entry.name === 'route.txt'));

    const localDownload = await fetch(
      `${hubBaseUrl}/api/sessions/${workerSessionId}/files/download?machineId=hub1&path=route.txt`,
    );
    assert.equal(localDownload.status, 200);
    assert.equal(await localDownload.text(), 'hub1-file\n');
    const remoteDownload = await fetch(
      `${hubBaseUrl}/api/sessions/${workerSessionId}/files/download?machineId=worker1&path=route.txt`,
    );
    assert.equal(remoteDownload.status, 200);
    assert.equal(await remoteDownload.text(), 'worker1-file\n');

    const remoteUpload = await fetch(
      `${hubBaseUrl}/api/sessions/${workerSessionId}/files/upload?machineId=worker1&name=routed-upload.txt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('worker1-upload\n'),
      },
    );
    assert.equal(remoteUpload.status, 200, await remoteUpload.text());
    assert.equal(await readFile(join(projectDir, 'routed-upload.txt'), 'utf8'), 'worker1-upload\n');
    await assert.rejects(readFile(join(hubProjectDir, 'routed-upload.txt'), 'utf8'));

    for (const machineId of ['hub1', 'worker1']) {
      const symlinkUpload = await fetch(
        `${hubBaseUrl}/api/sessions/${workerSessionId}/files/upload?machineId=${machineId}&name=escape-link.txt&overwrite=1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from(`must-not-escape-${machineId}\n`),
        },
      );
      assert.equal(symlinkUpload.status, 400, `${machineId} symlink upload should fail closed`);
    }
    assert.equal(await readFile(externalUploadTarget, 'utf8'), 'outside-original\n');

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

    const localKeep = await requestJson<{ id: string; machineId: string; agent: string; kept: boolean }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/keep`,
      { method: 'POST', body: JSON.stringify({ kept: true, machineId: 'hub1' }) },
    );
    assert.deepEqual(localKeep, { id: workerSessionId, machineId: 'hub1', agent: 'codex', kept: true });
    const localTitle = await requestJson<{ id: string; machineId: string; agent: string; title: string }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/title`,
      { method: 'POST', body: JSON.stringify({ title: 'HUB_DUPLICATE_TITLE', machineId: 'hub1' }) },
    );
    assert.deepEqual(localTitle, {
      id: workerSessionId,
      machineId: 'hub1',
      agent: 'codex',
      title: 'HUB_DUPLICATE_TITLE',
    });

    const localAfterLocalState = await requestJson<{
      machineId: string;
      kept: boolean;
      customTitle: string | null;
    }>(hubBaseUrl, `/api/sessions/${workerSessionId}?machineId=hub1`);
    const remoteAfterLocalState = await requestJson<{
      machineId: string;
      kept: boolean;
      customTitle: string | null;
    }>(hubBaseUrl, `/api/sessions/${workerSessionId}?machineId=worker1`);
    assert.equal(localAfterLocalState.machineId, 'hub1');
    assert.equal(localAfterLocalState.kept, true);
    assert.equal(localAfterLocalState.customTitle, 'HUB_DUPLICATE_TITLE');
    assert.equal(remoteAfterLocalState.machineId, 'worker1');
    assert.equal(remoteAfterLocalState.kept, false);
    assert.notEqual(remoteAfterLocalState.customTitle, 'HUB_DUPLICATE_TITLE');

    const remoteKeep = await requestJson<{ id: string; machineId: string; agent: string; kept: boolean }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/keep`,
      { method: 'POST', body: JSON.stringify({ kept: true, machineId: 'worker1' }) },
    );
    assert.deepEqual(remoteKeep, { id: workerSessionId, machineId: 'worker1', agent: 'codex', kept: true });
    const remoteTitle = await requestJson<{ id: string; machineId: string; agent: string; title: string }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/title`,
      { method: 'POST', body: JSON.stringify({ title: 'WORKER_DUPLICATE_TITLE', machineId: 'worker1' }) },
    );
    assert.deepEqual(remoteTitle, {
      id: workerSessionId,
      machineId: 'worker1',
      agent: 'codex',
      title: 'WORKER_DUPLICATE_TITLE',
    });

    const hubViewAfterRemoteState = await requestJson<{
      machineId: string;
      kept: boolean;
      customTitle: string | null;
    }>(hubBaseUrl, `/api/sessions/${workerSessionId}?machineId=worker1`);
    assert.equal(hubViewAfterRemoteState.machineId, 'worker1');
    assert.equal(hubViewAfterRemoteState.kept, true);
    assert.equal(hubViewAfterRemoteState.customTitle, 'WORKER_DUPLICATE_TITLE');

    const workerAfterRemoteState = await requestJson<{
      machineId: string;
      kept: boolean;
      customTitle: string | null;
    }>(workerBaseUrl, `/api/sessions/${workerSessionId}`, {}, workerToken);
    assert.equal(workerAfterRemoteState.machineId, 'worker1');
    assert.equal(workerAfterRemoteState.kept, true);
    assert.equal(workerAfterRemoteState.customTitle, 'WORKER_DUPLICATE_TITLE');
    const hubPersistedState = JSON.parse(await readFile(hubState, 'utf8')) as {
      keptIds: string[];
      titles: Record<string, string>;
    };
    const workerPersistedState = JSON.parse(await readFile(workerState, 'utf8')) as {
      keptIds: string[];
      titles: Record<string, string>;
    };
    const scopedSessionStateKey = `codex|||${workerSessionId}`;
    assert.ok(hubPersistedState.keptIds.includes(scopedSessionStateKey));
    assert.equal(hubPersistedState.titles[scopedSessionStateKey], 'HUB_DUPLICATE_TITLE');
    assert.ok(workerPersistedState.keptIds.includes(scopedSessionStateKey));
    assert.equal(workerPersistedState.titles[scopedSessionStateKey], 'WORKER_DUPLICATE_TITLE');

    await requestJson(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/keep`,
      { method: 'POST', body: JSON.stringify({ kept: false, machineId: 'worker1' }) },
    );
    const migration = await requestJson<{
      sourceSessionId: string;
      sourceSessionFile: string;
      targetProjectDir: string;
      newSessionId: string;
      newSessionFile: string;
      verified: boolean;
      alreadyInTarget: boolean;
      machineId: string;
    }>(
      hubBaseUrl,
      `/api/sessions/${workerSessionId}/migrate`,
      {
        method: 'POST',
        body: JSON.stringify({ targetProjectDir: migrationTargetDir, machineId: 'worker1' }),
      },
    );
    assert.equal(migration.machineId, 'worker1');
    assert.equal(migration.sourceSessionId, workerSessionId);
    assert.equal(migration.sourceSessionFile, workerSessionPath);
    assert.equal(migration.targetProjectDir, migrationTargetDir);
    assert.notEqual(migration.newSessionId, workerSessionId);
    assert.equal(dirname(migration.newSessionFile), dirname(workerSessionPath));
    assert.equal(migration.verified, true);
    assert.equal(migration.alreadyInTarget, false);
    const migratedFirstRecord = JSON.parse(
      (await readFile(migration.newSessionFile, 'utf8')).split('\n', 1)[0],
    ) as { payload?: { id?: string; cwd?: string } };
    assert.equal(migratedFirstRecord.payload?.id, migration.newSessionId);
    assert.equal(migratedFirstRecord.payload?.cwd, migrationTargetDir);
    assert.equal(await readFile(workerSessionPath, 'utf8'), workerSessionContent);
    assert.equal(await readFile(hubDuplicateSessionPath, 'utf8'), hubDuplicateSessionContent);

    const prune = await requestJson<{
      matched: number;
      deleted: number;
      failed: number;
      results: Array<{ id: string; machineId: string; ok: boolean }>;
    }>(hubBaseUrl, '/api/sessions/prune-non-kept', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    const duplicatePruneResults = prune.results
      .filter((result) => result.id === workerSessionId)
      .map(({ id, machineId, ok }) => ({ id, machineId, ok }));
    assert.deepEqual(duplicatePruneResults, [{
      id: workerSessionId,
      machineId: 'worker1',
      ok: true,
    }]);
    assert.equal(await readFile(hubDuplicateSessionPath, 'utf8'), hubDuplicateSessionContent);
    await assert.rejects(readFile(workerSessionPath, 'utf8'));

    const localAfterPrune = await fetch(
      `${hubBaseUrl}/api/sessions/${workerSessionId}?machineId=hub1`,
    );
    assert.equal(localAfterPrune.status, 200);
    const remoteAfterPrune = await fetch(`${workerBaseUrl}/api/sessions/${workerSessionId}`, {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    assert.equal(remoteAfterPrune.status, 404);
  } finally {
    if (hub) await stopServer(hub);
    if (worker) await stopServer(worker);
    if (llm.listening) await closeServer(llm);
    await rm(root, { recursive: true, force: true });
  }
});
