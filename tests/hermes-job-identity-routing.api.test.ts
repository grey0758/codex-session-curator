import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

type JsonRecord = Record<string, unknown>;
type RemoteFixture = {
  machineId: string;
  agent: 'codex' | 'claude';
  sessionId: string;
  jobs: string[];
  calls: Array<{ method: string; path: string; query: string }>;
  registryDown: boolean;
  failMutation: boolean;
  spoofResponse: boolean;
};

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

async function stopProcess(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
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

function makeJob(fixture: RemoteFixture, id: string, spoof = false): JsonRecord {
  return {
    id,
    machineId: spoof ? 'gpl001' : fixture.machineId,
    agent: fixture.agent,
    agentVerified: true,
    sessionId: fixture.sessionId,
    status: 'running',
  };
}

function createRemote(fixture: RemoteFixture): Server {
  return createServer(async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    for await (const chunk of incoming) void chunk;
    fixture.calls.push({
      method: incoming.method ?? 'GET',
      path: url.pathname,
      query: url.search,
    });
    response.setHeader('content-type', 'application/json');

    if (incoming.method === 'GET' && url.pathname === '/api/meta') {
      response.end(JSON.stringify({ machineId: fixture.machineId, role: 'worker' }));
      return;
    }
    if (incoming.method === 'GET' && url.pathname === '/api/hermes/jobs') {
      if (fixture.registryDown) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'registry unavailable', code: 'REGISTRY_DOWN' }));
        return;
      }
      response.end(JSON.stringify({
        jobs: fixture.jobs.map((id) => makeJob(fixture, id)),
      }));
      return;
    }

    const match = /^\/api\/hermes\/jobs\/([^/]+)(?:\/(events|outcome|stop|guidance|protocol|supervise))?$/.exec(
      url.pathname,
    );
    const jobId = match ? decodeURIComponent(match[1]) : null;
    if (jobId && fixture.jobs.includes(jobId)) {
      if (incoming.method === 'POST' && fixture.failMutation) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'mutation failed after target selection', code: 'TARGET_FAILED' }));
        return;
      }
      const job = makeJob(fixture, jobId, fixture.spoofResponse);
      if (match?.[2] === 'outcome') {
        response.end(JSON.stringify({
          jobId,
          sessionId: fixture.sessionId,
          agent: fixture.agent,
          outcome: {
            jobId,
            sessionId: fixture.sessionId,
            machineId: job.machineId,
            agent: fixture.agent,
          },
        }));
      } else if (match?.[2] === 'events') {
        response.end(JSON.stringify({ jobId, events: [], job }));
      } else {
        response.end(JSON.stringify({ job }));
      }
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }));
  });
}

function identityQuery(fixture: RemoteFixture): string {
  return new URLSearchParams({
    machineId: fixture.machineId,
    agent: fixture.agent,
    sessionId: fixture.sessionId,
  }).toString();
}

function matchingCalls(fixture: RemoteFixture, method: string, suffix: string): number {
  return fixture.calls.filter((call) =>
    call.method === method &&
    call.path === `/api/hermes/jobs/${suffix}`
  ).length;
}

test('job routing uses verified composite identity and never broadcasts mutations', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-job-identity-'));
  const codexHome = join(testRoot, 'codex-home');
  const claudeHome = join(testRoot, 'claude-home');
  const sgp: RemoteFixture = {
    machineId: 'sgp001',
    agent: 'codex',
    sessionId: 'sgp-session',
    jobs: ['collision-job', 'sgp-only-job'],
    calls: [],
    registryDown: false,
    failMutation: false,
    spoofResponse: false,
  };
  const cnal: RemoteFixture = {
    machineId: 'cnal002',
    agent: 'claude',
    sessionId: 'cnal-session',
    jobs: ['collision-job'],
    calls: [],
    registryDown: false,
    failMutation: false,
    spoofResponse: false,
  };
  const sgpServer = createRemote(sgp);
  const cnalServer = createRemote(cnal);
  const sgpPort = await listen(sgpServer);
  const cnalPort = await listen(cnalServer);
  const port = 59_000 + Math.floor(Math.random() * 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let curator: ChildProcessWithoutNullStreams | null = null;

  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(claudeHome, 'projects'), { recursive: true });

  try {
    curator = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_CURATOR_STATE: join(codexHome, 'session-curator-state.json'),
        CURATOR_CODEX_JOBS_PATH: join(testRoot, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'gpl001',
        CURATOR_REMOTE_AGENTS: [
          `sgp001=http://127.0.0.1:${sgpPort}`,
          `cnal002=http://127.0.0.1:${cnalPort}`,
        ].join(','),
        CURATOR_KNOWLEDGE_GATEWAY_ENABLED: '0',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
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

    const ambiguous = await request(baseUrl, '/api/hermes/jobs/collision-job');
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.payload.code, 'AMBIGUOUS_JOB_IDENTITY');
    assert.equal((ambiguous.payload.candidates as JsonRecord[]).length, 2);
    assert.equal(matchingCalls(sgp, 'GET', 'collision-job'), 0);
    assert.equal(matchingCalls(cnal, 'GET', 'collision-job'), 0);

    const callsBeforeRawMutation =
      matchingCalls(sgp, 'POST', 'collision-job/stop') +
      matchingCalls(cnal, 'POST', 'collision-job/stop');
    const rawMutation = await request(baseUrl, '/api/hermes/jobs/collision-job/stop', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(rawMutation.status, 400);
    assert.equal(rawMutation.payload.code, 'JOB_IDENTITY_REQUIRED');
    assert.equal(
      matchingCalls(sgp, 'POST', 'collision-job/stop') +
      matchingCalls(cnal, 'POST', 'collision-job/stop'),
      callsBeforeRawMutation,
    );

    const uniqueLegacy = await request(baseUrl, '/api/hermes/jobs/sgp-only-job/events');
    assert.equal(uniqueLegacy.status, 200);
    assert.equal((uniqueLegacy.payload.job as JsonRecord).machineId, 'sgp001');
    assert.equal(matchingCalls(sgp, 'GET', 'sgp-only-job/events'), 1);
    assert.equal(matchingCalls(cnal, 'GET', 'sgp-only-job/events'), 0);

    const sgpQuery = identityQuery(sgp);
    const sgpDetail = await request(baseUrl, `/api/codex/jobs/collision-job?${sgpQuery}`);
    assert.equal(sgpDetail.status, 200);
    assert.equal((sgpDetail.payload.job as JsonRecord).machineId, 'sgp001');
    assert.equal(matchingCalls(sgp, 'GET', 'collision-job'), 1);
    assert.equal(matchingCalls(cnal, 'GET', 'collision-job'), 0);

    const cnalQuery = identityQuery(cnal);
    const cnalGuidanceBefore = matchingCalls(cnal, 'POST', 'collision-job/guidance');
    const sgpGuidanceBefore = matchingCalls(sgp, 'POST', 'collision-job/guidance');
    const guidance = await request(
      baseUrl,
      `/api/codex/jobs/collision-job/guidance?${cnalQuery}`,
      { method: 'POST', body: JSON.stringify({ text: 'target cnal only' }) },
    );
    assert.equal(guidance.status, 200);
    assert.equal((guidance.payload.job as JsonRecord).machineId, 'cnal002');
    assert.equal(matchingCalls(cnal, 'POST', 'collision-job/guidance'), cnalGuidanceBefore + 1);
    assert.equal(matchingCalls(sgp, 'POST', 'collision-job/guidance'), sgpGuidanceBefore);

    const partial = await request(
      baseUrl,
      '/api/hermes/jobs/collision-job?machineId=sgp001&agent=codex',
    );
    assert.equal(partial.status, 400);
    assert.equal(partial.payload.code, 'INCOMPLETE_JOB_IDENTITY');

    sgp.spoofResponse = true;
    const spoofed = await request(baseUrl, `/api/hermes/jobs/collision-job?${sgpQuery}`);
    assert.equal(spoofed.status, 502);
    assert.equal(spoofed.payload.code, 'REMOTE_JOB_IDENTITY_MISMATCH');
    sgp.spoofResponse = false;

    sgp.failMutation = true;
    const cnalProtocolBefore = matchingCalls(cnal, 'POST', 'collision-job/protocol');
    const failedMutation = await request(
      baseUrl,
      `/api/hermes/jobs/collision-job/protocol?${sgpQuery}`,
      { method: 'POST', body: JSON.stringify({ kind: 'verify' }) },
    );
    assert.equal(failedMutation.status, 500);
    assert.equal(failedMutation.payload.code, 'TARGET_FAILED');
    assert.equal(matchingCalls(cnal, 'POST', 'collision-job/protocol'), cnalProtocolBefore);
    sgp.failMutation = false;

    cnal.registryDown = true;
    const unavailable = await request(baseUrl, '/api/hermes/jobs/sgp-only-job');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.payload.code, 'REMOTE_JOB_REGISTRY_UNAVAILABLE');
    assert.deepEqual(unavailable.payload.machineIds, ['cnal002']);
  } finally {
    if (curator) await stopProcess(curator);
    await closeServer(sgpServer);
    await closeServer(cnalServer);
    await rm(testRoot, { recursive: true, force: true });
  }
});
