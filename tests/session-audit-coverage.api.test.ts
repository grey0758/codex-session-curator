import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
type JsonRecord = Record<string, unknown>;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
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
  assert.fail(`Timed out waiting for Hub startup; logs=${logs.join('').slice(-2000)}`);
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

async function requestJson<T extends JsonRecord>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

test('Hub fast discovery records deferred AI analysis instead of a false completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-audit-coverage-'));
  const codexHome = join(root, '.codex');
  const projectDir = join(root, 'project');
  const sessionId = 'hub-pending-session';
  const sessionPath = join(codexHome, 'sessions', `${sessionId}.jsonl`);
  const statePath = join(codexHome, 'session-curator-state.json');
  const auditPath = join(codexHome, 'session-curator-audit.jsonl');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let hub: ChildProcessWithoutNullStreams | null = null;

  await mkdir(dirname(sessionPath), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(sessionPath, [
    JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id: sessionId, cwd: projectDir, timestamp: now } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'PENDING_USER' } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'assistant', content: 'PENDING_ASSISTANT' } }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {}, commanderActions: {} }), 'utf8');

  try {
    hub = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(root, '.claude'),
        CODEX_CURATOR_STATE: statePath,
        CURATOR_SESSION_AUDIT_LOG: auditPath,
        CURATOR_CODEX_JOBS_PATH: join(root, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(root, 'recycle'),
        CURATOR_MACHINE_ID: 'hub-test',
        CURATOR_ROLE: 'hub',
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_AUTO_BACKFILL_INTERVAL_MS: '0',
        CURATOR_REMOTE_EVALUATION_INTERVAL_MS: '0',
        CURATOR_SESSION_AUDIT_INTERVAL_MS: '0',
        CURATOR_EVALUATION_QUIET_MS: '60000',
        CURATOR_SESSION_AUDIT_PENDING_GRACE_MS: '900000',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        CURATOR_LLM_BASE_URL: 'http://127.0.0.1:9',
        CURATOR_LLM_API_KEY: 'test-only',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    hub.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    hub.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, hub, logs);

    const sessions = await requestJson<{ sessions: JsonRecord[] }>(baseUrl, '/api/sessions?detail=0&remote=0');
    const session = sessions.sessions.find((item) => item.id === sessionId);
    const evaluation = session?.evaluation as JsonRecord;
    assert.equal(evaluation.status, 'fallback');
    assert.equal(evaluation.evaluationOrigin, 'rule-fallback');
    assert.equal(evaluation.hermesRefreshStatus, 'pending');

    const audit = await requestJson<{
      counts: JsonRecord;
      issues: JsonRecord[];
      pending: JsonRecord[];
    }>(baseUrl, '/api/audit/completeness');
    assert.equal(audit.counts.eligibleSessions, 1);
    assert.equal(audit.counts.fullyEvaluatedSessions, 0);
    assert.equal(audit.counts.pendingEvaluationSessions, 1);
    assert.equal(audit.counts.actionableIssues, 0);
    assert.equal(audit.issues.length, 0);
    assert.equal(audit.pending[0]?.classification, 'pending');

    const events = await requestJson<{ events: JsonRecord[] }>(baseUrl, `/api/audit/events?sessionId=${sessionId}&limit=50`);
    assert.ok(events.events.some((event) => event.event === 'evaluation-deferred'));
    assert.ok(!events.events.some((event) => event.event === 'evaluation-completed'));
  } finally {
    if (hub) await stopServer(hub);
    await rm(root, { recursive: true, force: true });
  }
});
