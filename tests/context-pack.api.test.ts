import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

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

async function waitForServer(baseUrl: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.status < 500) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for server startup; logs=${logs.join('').slice(-2000)}`);
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
    title: 'Context Pack Fixture',
    summary: 'Fixture session for context pack resume recommendation.',
    detailedSummary: 'Contains context-pack API data and should be selected for resume.',
    hermesContext: 'Use this session when the query mentions context pack resume.',
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
    directoryIndex: ['apps', 'context-pack-project'],
    techStack: ['TypeScript', 'Fastify'],
    keywords: ['context-pack', 'resume', 'dispatch'],
    failureCards: [],
    jobOutcomes: [],
    searchText: 'context pack resume dispatch worker prompt',
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

test('context pack recommends resumable matched session and explains new-session fallback', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-context-pack-api-'));
  const codexHome = join(testRoot, 'codex-home');
  const projectDir = join(testRoot, 'context-pack-project');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(codexHome, 'session-curator-state.json');
  const jobsPath = join(testRoot, 'jobs.json');
  const sessionId = 'context-pack-session';
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const now = new Date().toISOString();
  const port = 55_000 + Math.floor(Math.random() * 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let server: ChildProcessWithoutNullStreams | null = null;

  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionFile, '', 'utf8');
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
        CODEX_CURATOR_STATE: statePath,
        CURATOR_CODEX_JOBS_PATH: jobsPath,
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'context-pack-machine',
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_REMOTE_SESSION_CACHE_TTL_MS: '0',
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

    await requestJson<{ item: JsonRecord }>(baseUrl, '/api/knowledge/items', {
      method: 'POST',
      body: JSON.stringify({
        type: 'preference',
        title: 'Worker preference',
        text: 'Prefer scoped changes and direct verification.',
        project: 'context-pack-project',
        cwd: projectDir,
        tags: ['worker', 'preference'],
      }),
    });
    await requestJson<{ item: JsonRecord }>(baseUrl, '/api/knowledge/items', {
      method: 'POST',
      body: JSON.stringify({
        type: 'runbook',
        title: 'Context pack runbook',
        text: 'Run context-pack API tests after changing dispatch context.',
        project: 'context-pack-project',
        cwd: projectDir,
        tags: ['runbook'],
      }),
    });

    const matched = await requestJson<{
      query: string;
      matchedProject: JsonRecord;
      preferences: JsonRecord[];
      runbooks: JsonRecord[];
      sessions: JsonRecord[];
      commanderActions: JsonRecord[];
      recommendedResume: JsonRecord;
      workerPromptContext: string;
    }>(
      baseUrl,
      `/api/context-pack?q=context%20pack%20resume&cwd=${encodeURIComponent(projectDir)}&limit=5&remote=0`,
    );

    assert.equal(matched.query, 'context pack resume');
    assert.equal(matched.matchedProject.name, 'context-pack-project');
    assert.equal(matched.recommendedResume.sessionId, sessionId);
    assert.match(String(matched.recommendedResume.resumeCommand), new RegExp(sessionId));
    assert.equal(matched.sessions[0].id, sessionId);
    assert.ok(matched.preferences.some((item) => String(item.text).includes('scoped changes')));
    assert.ok(matched.runbooks.some((item) => item.title === 'Context pack runbook'));
    assert.match(matched.workerPromptContext, /Current task is highest priority/);
    assert.match(matched.workerPromptContext, /Historical sessions/);
    assert.match(matched.workerPromptContext, /Prefer resuming/);

    const aliasMatched = await requestJson<{
      recommendedResume: JsonRecord;
      workerPromptContext: string;
    }>(
      baseUrl,
      `/api/hermes/context-pack?q=context%20pack%20resume&cwd=${encodeURIComponent(projectDir)}&limit=5&remote=0`,
    );
    assert.equal(aliasMatched.recommendedResume.sessionId, sessionId);
    assert.match(aliasMatched.workerPromptContext, /Recommended resume/);

    const synced = await requestJson<{ items: JsonRecord[] }>(
      baseUrl,
      '/api/knowledge/search?q=context-pack%20session%20index&type=session&limit=10',
    );
    assert.ok(synced.items.some((item) => item.id === `${sessionId}:session-index`));

    const unmatched = await requestJson<{
      recommendedResume: null;
      newSessionReason: string;
      sessions: JsonRecord[];
      workerPromptContext: string;
    }>(
      baseUrl,
      `/api/context-pack?q=unrelated%20zebra&cwd=${encodeURIComponent(join(testRoot, 'other-project'))}&limit=5&remote=0`,
    );
    assert.equal(unmatched.recommendedResume, null);
    assert.equal(unmatched.sessions.length, 0);
    assert.match(unmatched.newSessionReason, /No canResume session matched/);
    assert.match(unmatched.workerPromptContext, /new child session may be created/);
  } finally {
    if (server) await stopServer(server);
    await rm(testRoot, { recursive: true, force: true });
  }
});
