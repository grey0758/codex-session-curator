import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
type JsonRecord = Record<string, unknown>;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForServer(
  baseUrl: string,
  server: ChildProcessWithoutNullStreams,
  logs: string[],
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.status < 500) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for server startup; logs=${logs.join('').slice(-2_000)}`);
}

async function stopProcess(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; payload: JsonRecord }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? JSON.parse(text) as JsonRecord : {},
  };
}

function evaluationFixture(title: string, cwd: string, filePath: string, now: string) {
  return {
    title,
    summary: `${title} summary`,
    detailedSummary: `${title} detail`,
    recommendation: 'keep',
    score: 90,
    reasons: ['identity routing fixture'],
    actualWorkdirs: [cwd],
    directoryIndex: ['identity-routing'],
    techStack: ['TypeScript'],
    keywords: ['identity', 'routing'],
    failureCards: [],
    jobOutcomes: [],
    searchText: `${title} identity routing`,
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
    filePath,
    mtimeMs: 0,
    bytes: 0,
    cwd,
    startedAt: now,
    updatedAt: now,
    messageCount: 2,
    userTurns: 1,
    assistantTurns: 1,
    shellSnapshotCount: 0,
  };
}

function remoteSessionFixture(sessionId: string, now: string) {
  const cwd = '/remote/identity-routing';
  const filePath = `/remote/sessions/${sessionId}.jsonl`;
  return {
    id: sessionId,
    agent: 'claude',
    filePath,
    cwd,
    startedAt: now,
    updatedAt: now,
    bytes: 120,
    messageCount: 2,
    userTurns: 1,
    assistantTurns: 1,
    lastUserMessage: { role: 'user', text: 'remote marker', timestamp: now },
    lastAssistantMessage: { role: 'assistant', text: 'remote answer', timestamp: now },
    shellSnapshotCount: 0,
    title: 'Remote identity target',
    customTitle: null,
    resumeCommand: `claude --resume ${sessionId}`,
    machineId: 'sgp001',
    activityStatus: 'active',
    lastActiveAt: now,
    inactiveDays: 0,
    kept: false,
    deleted: false,
    evaluation: evaluationFixture('Remote identity target', cwd, filePath, now),
  };
}

test('Hermes composite identity fails closed for duplicate raw IDs and routes explicit targets', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-hermes-identity-'));
  const codexHome = join(testRoot, 'codex-home');
  const claudeHome = join(testRoot, 'claude-home');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(codexHome, 'session-curator-state.json');
  const jobsPath = join(testRoot, 'jobs.json');
  const projectDir = join(testRoot, 'local-project');
  const sessionId = 'shared-session-id';
  const uniqueSessionId = 'unique-local-session-id';
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  const uniqueSessionFile = join(sessionsDir, `${uniqueSessionId}.jsonl`);
  const now = new Date().toISOString();
  const remoteSession = remoteSessionFixture(sessionId, now);
  const remoteCalls: Array<{ method: string; path: string; query: string; body: JsonRecord | null }> = [];
  let remoteSessionInventoryAvailable = true;

  const remoteServer = createServer(async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of incoming) rawBody += chunk.toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) as JsonRecord : null;
    remoteCalls.push({
      method: incoming.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      body,
    });
    response.setHeader('content-type', 'application/json');

    if (incoming.method === 'GET' && url.pathname === '/api/meta') {
      response.end(JSON.stringify({ machineId: 'sgp001', role: 'worker' }));
      return;
    }
    if (incoming.method === 'GET' && url.pathname === '/api/sessions') {
      if (!remoteSessionInventoryAvailable) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'remote inventory unavailable' }));
        return;
      }
      response.end(JSON.stringify({ sessions: [remoteSession] }));
      return;
    }
    if (incoming.method === 'GET' && url.pathname === `/api/hermes/sessions/${sessionId}/context`) {
      response.end(JSON.stringify({
        session: remoteSession,
        history: { messages: [] },
        contextText: 'REMOTE_CONTEXT_MARKER',
      }));
      return;
    }
    if (incoming.method === 'POST' && url.pathname === '/api/hermes/jobs/resume') {
      response.end(JSON.stringify({
        job: {
          id: `remote-job-${remoteCalls.length}`,
          sessionId,
          machineId: 'sgp001',
          agent: 'claude',
          agentVerified: true,
          status: 'running',
        },
      }));
      return;
    }
    const remoteJobIds = [
      'remote-only-job-detail',
      'remote-only-job-events',
      'remote-only-job-outcome',
      'remote-only-job-stop',
      'remote-only-job-guidance',
      'remote-only-job-protocol',
      'remote-only-job-supervise',
    ];
    if (incoming.method === 'GET' && url.pathname === '/api/hermes/jobs') {
      response.end(JSON.stringify({
        jobs: remoteJobIds.map((id) => ({
          id,
          sessionId,
          machineId: 'sgp001',
          agent: 'claude',
          agentVerified: true,
          status: 'running',
        })),
      }));
      return;
    }
    const remoteJobId = remoteJobIds.find((id) =>
      url.pathname === `/api/hermes/jobs/${id}` ||
      url.pathname.startsWith(`/api/hermes/jobs/${id}/`)
    );
    if (remoteJobId) {
      const job = {
        id: remoteJobId,
        sessionId,
        machineId: 'sgp001',
        agent: 'claude',
        agentVerified: true,
        status: 'running',
      };
      if (url.pathname.endsWith('/outcome')) {
        response.end(JSON.stringify({
          jobId: remoteJobId,
          sessionId,
          agent: 'claude',
          outcome: {
            jobId: remoteJobId,
            sessionId,
            machineId: 'sgp001',
            agent: 'claude',
          },
        }));
      } else if (url.pathname.endsWith('/events')) {
        response.end(JSON.stringify({ jobId: remoteJobId, events: [], job }));
      } else {
        response.end(JSON.stringify({ job }));
      }
      return;
    }
    if (incoming.method === 'GET' && url.pathname === `/api/sessions/${sessionId}/outcome`) {
      response.end(JSON.stringify({
        sessionId,
        machineId: 'sgp001',
        agent: 'claude',
        summary: 'REMOTE_OUTCOME_MARKER',
      }));
      return;
    }
    if (incoming.method === 'POST' && url.pathname === `/api/sessions/${sessionId}/migrate`) {
      response.statusCode = 422;
      response.end(JSON.stringify({
        error: `Claude session migration is unsupported: ${sessionId}`,
        code: 'CLAUDE_SESSION_MIGRATION_UNSUPPORTED',
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const remotePort = await listen(remoteServer);
  const port = 57_000 + Math.floor(Math.random() * 2_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let curator: ChildProcessWithoutNullStreams | null = null;

  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(claudeHome, 'projects'), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id: sessionId, cwd: projectDir, timestamp: now } }),
      JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'local marker' } }),
    ].join('\n') + '\n',
    'utf8',
  );
  await writeFile(
    uniqueSessionFile,
    [
      JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id: uniqueSessionId, cwd: projectDir, timestamp: now } }),
      JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'unique local marker' } }),
    ].join('\n') + '\n',
    'utf8',
  );
  const sessionStat = await stat(sessionFile);
  const uniqueSessionStat = await stat(uniqueSessionFile);
  const localEvaluation = {
    ...evaluationFixture('Local identity decoy', projectDir, sessionFile, now),
    mtimeMs: sessionStat.mtimeMs,
    bytes: sessionStat.size,
  };
  const uniqueLocalEvaluation = {
    ...evaluationFixture('Unique local session', projectDir, uniqueSessionFile, now),
    mtimeMs: uniqueSessionStat.mtimeMs,
    bytes: uniqueSessionStat.size,
  };
  await writeFile(
    statePath,
    JSON.stringify({
      keptIds: [],
      deletedIds: [],
      titles: {},
      evaluations: {
        [sessionId]: localEvaluation,
        [uniqueSessionId]: uniqueLocalEvaluation,
      },
      commanderActions: {},
    }),
    'utf8',
  );

  try {
    curator = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_CODEX_JOBS_PATH: jobsPath,
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'gpl001',
        CURATOR_REMOTE_AGENTS: `sgp001=http://127.0.0.1:${remotePort}`,
        CURATOR_KNOWLEDGE_GATEWAY_ENABLED: '0',
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
    curator.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    curator.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, curator, logs);

    for (const [path, init] of [
      [`/api/hermes/sessions/${sessionId}/context`, undefined],
      ['/api/hermes/jobs/resume', {
        method: 'POST',
        body: JSON.stringify({ sessionId, prompt: 'resume duplicate' }),
      }],
      ['/api/hermes/dispatch', {
        method: 'POST',
        body: JSON.stringify({ query: 'identity routing', sessionId, prompt: 'dispatch duplicate' }),
      }],
      [`/api/sessions/${sessionId}/outcome`, undefined],
    ] as const) {
      const ambiguous = await request(baseUrl, path, init);
      assert.equal(ambiguous.status, 409, `${path} should reject an ambiguous raw sessionId`);
      assert.equal(ambiguous.payload.code, 'AMBIGUOUS_SESSION_IDENTITY');
      assert.equal((ambiguous.payload.candidates as JsonRecord[]).length, 2);
    }

    const ambiguousBulk = await request(baseUrl, '/api/sessions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        ids: [uniqueSessionId, sessionId],
      }),
    });
    assert.equal(ambiguousBulk.status, 409);
    assert.equal(ambiguousBulk.payload.code, 'AMBIGUOUS_SESSION_IDENTITY');
    await stat(uniqueSessionFile);
    await stat(sessionFile);
    assert.equal(remoteCalls.filter((call) => call.method === 'DELETE').length, 0);

    const identityQuery = 'machineId=sgp001&agent=claude';
    const context = await request(
      baseUrl,
      `/api/hermes/sessions/${sessionId}/context?historyLimit=5&${identityQuery}`,
    );
    assert.equal(context.status, 200);
    assert.equal(context.payload.contextText, 'REMOTE_CONTEXT_MARKER');

    const resume = await request(baseUrl, '/api/hermes/jobs/resume', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        machineId: 'sgp001',
        agent: 'claude',
        prompt: 'resume remote target',
      }),
    });
    assert.equal(resume.status, 200);
    assert.equal((resume.payload.job as JsonRecord).machineId, 'sgp001');

    const dispatch = await request(baseUrl, '/api/hermes/dispatch', {
      method: 'POST',
      body: JSON.stringify({
        query: 'identity routing',
        sessionId,
        machineId: 'sgp001',
        agent: 'claude',
        prompt: 'dispatch remote target',
      }),
    });
    assert.equal(dispatch.status, 200);
    assert.equal(dispatch.payload.status, 'started');
    assert.equal(dispatch.payload.routedTo, 'sgp001');

    const outcome = await request(baseUrl, `/api/sessions/${sessionId}/outcome?${identityQuery}`);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.payload.summary, 'REMOTE_OUTCOME_MARKER');

    const unsupportedRemoteClaudeMigration = await request(
      baseUrl,
      `/api/sessions/${sessionId}/migrate`,
      {
        method: 'POST',
        body: JSON.stringify({
          targetProjectDir: '/remote/new-project',
          machineId: 'sgp001',
          agent: 'claude',
        }),
      },
    );
    assert.equal(unsupportedRemoteClaudeMigration.status, 422);
    assert.equal(
      unsupportedRemoteClaudeMigration.payload.code,
      'CLAUDE_SESSION_MIGRATION_UNSUPPORTED',
    );

    const legacyJobReadRequests: Array<[string, RequestInit | undefined]> = [
      ['/api/hermes/jobs/remote-only-job-detail', undefined],
      ['/api/hermes/jobs/remote-only-job-events/events', undefined],
      ['/api/hermes/jobs/remote-only-job-outcome/outcome', undefined],
    ];
    for (const [path, init] of legacyJobReadRequests) {
      const proxied = await request(baseUrl, path, init);
      assert.equal(proxied.status, 200, `${path} should resolve one verified remote identity`);
    }

    const rawJobMutationRequests: Array<[string, RequestInit]> = [
      ['/api/hermes/jobs/remote-only-job-stop/stop', { method: 'POST', body: '{}' }],
      ['/api/hermes/jobs/remote-only-job-guidance/guidance', {
        method: 'POST',
        body: JSON.stringify({ text: 'single hop guidance' }),
      }],
      ['/api/hermes/jobs/remote-only-job-protocol/protocol', {
        method: 'POST',
        body: JSON.stringify({ kind: 'verify' }),
      }],
      ['/api/hermes/jobs/remote-only-job-supervise/supervise', {
        method: 'POST',
        body: '{}',
      }],
    ];
    const callsBeforeRawMutations = remoteCalls.length;
    for (const [path, init] of rawJobMutationRequests) {
      const rejected = await request(baseUrl, path, init);
      assert.equal(rejected.status, 400, `${path} must require a composite identity`);
      assert.equal(rejected.payload.code, 'JOB_IDENTITY_REQUIRED');
    }
    assert.equal(remoteCalls.length, callsBeforeRawMutations);

    const jobIdentityQuery = new URLSearchParams({
      machineId: 'sgp001',
      agent: 'claude',
      sessionId,
    }).toString();
    for (const [path, init] of rawJobMutationRequests) {
      const callsBeforeMutation = remoteCalls.length;
      const proxied = await request(baseUrl, `${path}?${jobIdentityQuery}`, init);
      assert.equal(proxied.status, 200, `${path} should proxy exactly one explicit target`);
      assert.equal(remoteCalls.length, callsBeforeMutation + 1);
      const call = remoteCalls.at(-1);
      const forwarded = new URLSearchParams(call?.query ?? '');
      assert.equal(forwarded.get('machineId'), 'sgp001');
      assert.equal(forwarded.get('agent'), 'claude');
      assert.equal(forwarded.get('sessionId'), sessionId);
      assert.equal(forwarded.get('remote'), '0');
    }

    const partialIdentity = await request(
      baseUrl,
      '/api/hermes/jobs/remote-only-job-detail?machineId=sgp001',
    );
    assert.equal(partialIdentity.status, 400);
    assert.equal(partialIdentity.payload.code, 'INCOMPLETE_JOB_IDENTITY');

    const callsBeforeFence = remoteCalls.length;
    const fenced = await request(
      baseUrl,
      `/api/hermes/jobs/remote-only-job-detail?${jobIdentityQuery}&remote=0`,
    );
    assert.equal(fenced.status, 404);
    assert.equal(fenced.payload.code, 'REMOTE_JOB_ROUTING_DISABLED');
    assert.equal(remoteCalls.length, callsBeforeFence);

    remoteSessionInventoryAvailable = false;
    const unavailable = await request(
      baseUrl,
      `/api/hermes/sessions/${sessionId}/context`,
    );
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.payload.code, 'REMOTE_SESSION_INVENTORY_UNAVAILABLE');
    assert.deepEqual(unavailable.payload.machineIds, ['sgp001']);

    const unavailableDispatch = await request(baseUrl, '/api/hermes/dispatch', {
      method: 'POST',
      body: JSON.stringify({
        query: 'identity routing',
        sessionId,
        prompt: 'must not dispatch while identity is uncertain',
      }),
    });
    assert.equal(unavailableDispatch.status, 503);
    assert.equal(unavailableDispatch.payload.code, 'REMOTE_SESSION_INVENTORY_UNAVAILABLE');

    const unavailableAutomaticDispatch = await request(baseUrl, '/api/hermes/dispatch', {
      method: 'POST',
      body: JSON.stringify({
        query: 'identity routing without an explicit session',
        prompt: 'must not auto-dispatch while remote inventory is unavailable',
      }),
    });
    assert.equal(unavailableAutomaticDispatch.status, 503);
    assert.equal(
      unavailableAutomaticDispatch.payload.code,
      'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
    );

    const unavailableBulk = await request(baseUrl, '/api/sessions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        ids: [uniqueSessionId],
      }),
    });
    assert.equal(unavailableBulk.status, 503);
    assert.equal(unavailableBulk.payload.code, 'REMOTE_SESSION_INVENTORY_UNAVAILABLE');
    await stat(uniqueSessionFile);

    const unavailableRoutedBulk = await request(baseUrl, '/api/sessions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        sessions: [
          { id: uniqueSessionId, machineId: 'gpl001', agent: 'codex' },
          { id: sessionId, machineId: 'sgp001', agent: 'claude' },
        ],
      }),
    });
    assert.equal(unavailableRoutedBulk.status, 503);
    assert.equal(
      unavailableRoutedBulk.payload.code,
      'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
    );
    await stat(uniqueSessionFile);

    const unavailablePrune = await request(baseUrl, '/api/sessions/prune-non-kept', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(unavailablePrune.status, 503);
    assert.equal(
      unavailablePrune.payload.code,
      'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
    );
    await stat(uniqueSessionFile);

    const explicitLocal = await request(
      baseUrl,
      `/api/hermes/sessions/${sessionId}/context?machineId=gpl001&agent=codex`,
    );
    assert.equal(explicitLocal.status, 200);
    assert.match(String(explicitLocal.payload.contextText), /Local identity decoy/);

    const contextCall = remoteCalls.find((call) => call.path.endsWith('/context'));
    assert.match(contextCall?.query ?? '', /machineId=sgp001/);
    assert.match(contextCall?.query ?? '', /agent=claude/);
    const routedResumeCalls = remoteCalls.filter(
      (call) => call.method === 'POST' && call.path === '/api/hermes/jobs/resume',
    );
    assert.equal(routedResumeCalls.length, 2);
    for (const call of routedResumeCalls) {
      assert.equal(call.body?.sessionId, sessionId);
      assert.equal(call.body?.machineId, 'sgp001');
      assert.equal(call.body?.agent, 'claude');
    }
    const outcomeCall = remoteCalls.find((call) => call.path.endsWith('/outcome'));
    assert.match(outcomeCall?.query ?? '', /machineId=sgp001/);
    assert.match(outcomeCall?.query ?? '', /agent=claude/);
  } finally {
    if (curator) await stopProcess(curator);
    await closeServer(remoteServer);
    await rm(testRoot, { recursive: true, force: true });
  }
});
