import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const fakeCodexBin = join(__dirname, 'fixtures', 'fake-codex-worker.mjs');

type JsonRecord = Record<string, unknown>;

async function requestJson<T extends JsonRecord>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  }
  return payload as T;
}

async function waitFor<T>(
  producer: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const startedAt = Date.now();
  let last: T | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await producer();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function waitForServer(baseUrl: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  await waitFor(
    async () => {
      if (server.exitCode !== null) return { ok: false, exited: true };
      try {
        const response = await fetch(`${baseUrl}/api/hermes/jobs?remote=0`);
        return { ok: response.ok, exited: false };
      } catch {
        return { ok: false, exited: false };
      }
    },
    (value) => value.ok,
    `server startup; logs=${logs.join('').slice(-2000)}`,
    8000,
  );
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

function evaluationFixture(input: {
  sessionId: string;
  filePath: string;
  cwd: string;
  now: string;
}) {
  return {
    title: 'Hermes Dispatch E2E Fixture',
    summary: 'Fixture session for Hermes dispatch E2E fake worker validation.',
    detailedSummary: 'Contains Hermes dispatch E2E context and should be selected for dispatch API testing.',
    hermesContext: 'Use this session when the query mentions Hermes dispatch E2E.',
    hermesContextUpdatedAt: input.now,
    hermesLastUsedAt: null,
    hermesLastJobId: null,
    hermesNeedsRefresh: false,
    hermesRecalculatedAt: input.now,
    hermesRefreshStatus: 'ok',
    hermesRefreshError: null,
    recommendation: 'keep',
    score: 9,
    reasons: ['test fixture'],
    actualWorkdirs: [input.cwd],
    directoryIndex: ['codex-session-curator', 'hermes-dispatch-e2e'],
    techStack: ['TypeScript', 'Fastify'],
    keywords: ['Hermes', 'dispatch', 'E2E', 'fake worker'],
    failureCards: [],
    searchText: 'Hermes dispatch E2E fake worker structured report',
    updateCadence: 'quiet',
    reviewPriority: 'normal',
    reviewSignals: [],
    cwdMatchesWorkdir: true,
    recommendedWorkdir: input.cwd,
    remoteMachines: [],
    evaluatedAt: input.now,
    workflow: 'test:complete',
    model: 'test',
    status: 'ok',
    error: null,
    filePath: input.filePath,
    mtimeMs: Date.now(),
    bytes: 1,
    cwd: input.cwd,
    startedAt: input.now,
    updatedAt: input.now,
    messageCount: 2,
    userTurns: 1,
    assistantTurns: 1,
    shellSnapshotCount: 0,
  };
}

test('Hermes dispatch API runs fake worker through events, supervisor, structured report, and completion', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-hermes-dispatch-e2e-'));
  const codexHome = join(testRoot, 'codex-home');
  const projectDir = join(testRoot, 'project');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(codexHome, 'session-curator-state.json');
  const jobsPath = join(testRoot, 'jobs.json');
  const sessionId = 'hermes-dispatch-e2e-session';
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const now = new Date().toISOString();
  const port = 55_000 + Math.floor(Math.random() * 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let server: ChildProcessWithoutNullStreams | null = null;

  await chmod(fakeCodexBin, 0o755);
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id: sessionId, cwd: projectDir, timestamp: now } }),
      JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'Hermes dispatch E2E' } }),
    ].join('\n') + '\n',
    'utf8',
  );
  await writeFile(
    statePath,
    JSON.stringify(
      {
        keptIds: [sessionId],
        deletedIds: [],
        titles: {},
        evaluations: {
          [sessionId]: evaluationFixture({ sessionId, filePath: sessionFile, cwd: projectDir, now }),
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_BIN: fakeCodexBin,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_CODEX_JOBS_PATH: jobsPath,
        CURATOR_MACHINE_ID: 'hermes-e2e-machine',
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_KNOWLEDGE_GATEWAY_ENABLED: '0',
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_REMOTE_SESSION_CACHE_TTL_MS: '0',
        CURATOR_CODEX_JOB_TAIL_BYTES: String(128 * 1024),
        CURATOR_CODEX_JOB_MAX_EVENTS: '500',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        CURATOR_AUTO_BACKFILL: '0',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    server.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    server.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, server, logs);

    const dispatch = await requestJson<{
      status: string;
      selectedSession: JsonRecord;
      contextPack: { recommendedResume: JsonRecord; workerPromptContext: string };
      candidates: JsonRecord[];
      job: JsonRecord;
    }>(
      baseUrl,
      '/api/hermes/dispatch?remote=0',
      {
        method: 'POST',
        body: JSON.stringify({
          query: 'Hermes dispatch E2E',
          prompt: 'Run the Hermes dispatch E2E fake worker and report the result.',
          sessionId,
          repo: projectDir,
          mode: 'exec',
          supervisor: { autoStop: true, staleOutputMs: 1000 },
          extraArgs: ['--fake-scenario', 'hermes-dispatch-e2e'],
          requireConfirmationBelowScore: 0,
        }),
      },
    );

    assert.equal(dispatch.status, 'started');
    assert.equal(dispatch.selectedSession.id, sessionId);
    assert.equal(dispatch.contextPack.recommendedResume.sessionId, sessionId);
    assert.match(dispatch.contextPack.workerPromptContext, /Recommended resume/);
    assert.equal(dispatch.job.sessionId, sessionId);
    assert.equal(dispatch.job.status, 'running');
    assert.ok(dispatch.candidates.length >= 1);
    const jobId = String(dispatch.job.id);

    const sessionIndex = await requestJson<{ sessions: JsonRecord[]; resumePolicy: JsonRecord }>(
      baseUrl,
      '/api/hermes/session-index?q=Hermes%20dispatch%20E2E&remote=0',
    );
    assert.equal(sessionIndex.resumePolicy.defaultAction, 'resume-matched-session');
    assert.equal(sessionIndex.sessions[0].id, sessionId);
    assert.equal(sessionIndex.sessions[0].preferredAction, 'resume');
    assert.match(String(sessionIndex.sessions[0].resumeCommand), new RegExp(sessionId));

    const indexDocuments = await requestJson<{ documents: JsonRecord[] }>(
      baseUrl,
      '/api/hermes/search-documents?q=Hermes%20session%20index&remote=0',
    );
    assert.ok(indexDocuments.documents.some((document) => document.kind === 'session_index' && document.sessionId === sessionId));

    const supervise = await requestJson<{ decision: string; job: JsonRecord }>(
      baseUrl,
      `/api/hermes/jobs/${jobId}/supervise`,
      {
        method: 'POST',
        body: JSON.stringify({ autoStop: true, staleOutputMs: 1000 }),
      },
    );
    assert.ok(
      supervise.decision === 'continue' || supervise.decision === 'completed',
      `unexpected supervisor decision: ${supervise.decision}`,
    );
    assert.equal(supervise.job.id, jobId);
    assert.ok(
      supervise.job.status === 'running' || supervise.job.status === 'completed',
      `unexpected supervised job status: ${String(supervise.job.status)}`,
    );

    const runningEvents = await waitFor(
      () => requestJson<{ events: JsonRecord[] }>(baseUrl, `/api/hermes/jobs/${jobId}/events?remote=0`),
      (payload) => payload.events.some((event) => event.type === 'output' && JSON.stringify(event.data ?? {}).includes('PROMPT_OK')),
      'fake worker prompt acknowledgement',
    );
    assert.ok(runningEvents.events.some((event) => event.type === 'started'));
    assert.ok(runningEvents.events.some((event) => event.type === 'output' && JSON.stringify(event.data ?? {}).includes('CONTEXT_PACK_OK')));
    assert.ok(runningEvents.events.some((event) => event.type === 'output' && JSON.stringify(event.data ?? {}).includes('RECOMMENDED_RESUME_OK')));

    const completed = await waitFor(
      () => requestJson<{ job: JsonRecord }>(baseUrl, `/api/hermes/jobs/${jobId}`),
      (payload) => payload.job.status === 'completed' && payload.job.structuredReport !== null,
      'job completion with structured report',
    );

    const report = completed.job.structuredReport as JsonRecord;
    assert.equal(completed.job.exitCode, 0);
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.changedFiles, ['tests/hermes-dispatch.e2e.test.ts', 'tests/fixtures/fake-codex-worker.mjs']);
    assert.deepEqual(report.tests, ['npm run test:hermes-dispatch']);
    assert.equal(report.nextAction, 'none');

    const finalEvents = await requestJson<{ events: JsonRecord[]; job: JsonRecord }>(
      baseUrl,
      `/api/hermes/jobs/${jobId}/events?remote=0`,
    );
    assert.equal(finalEvents.job.status, 'completed');
    assert.ok(finalEvents.events.some((event) => event.type === 'supervisor'));
    assert.ok(finalEvents.events.some((event) => event.type === 'structured_report'));
    assert.ok(finalEvents.events.some((event) => event.type === 'completion'));
  } finally {
    if (server) await stopServer(server);
    await rm(testRoot, { recursive: true, force: true });
  }
});
