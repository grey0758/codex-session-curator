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
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
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

test('Knowledge API creates, updates, gets, searches, filters, and redacts items', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-knowledge-api-'));
  const codexHome = join(testRoot, 'codex-home');
  const statePath = join(codexHome, 'session-curator-state.json');
  const knowledgeDb = join(testRoot, 'knowledge.sqlite');
  const port = 58_000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let server: ChildProcessWithoutNullStreams | null = null;

  await mkdir(codexHome, { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {}, commanderActions: {} }, null, 2),
    'utf8',
  );

  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_KNOWLEDGE_DB: knowledgeDb,
        CURATOR_CODEX_JOBS_PATH: join(testRoot, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'knowledge-api-machine',
        CURATOR_REMOTE_AGENTS: '',
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
    server.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    server.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, server, logs);

    const created = await requestJson<{ item: JsonRecord }>(baseUrl, '/api/knowledge/items', {
      method: 'POST',
      body: JSON.stringify({
        id: 'service-secret',
        type: 'service',
        title: 'Search service sk-1234567890abcdef',
        text: 'OpenSearch endpoint uses nvapi-1234567890abcdef in old notes.',
        project: 'curator',
        repo: '/srv/curator',
        tags: ['search', 'service'],
        confidence: 0.7,
      }),
    });
    assert.equal(created.item.id, 'service-secret');
    assert.equal(created.item.title, 'Search service [redacted]');
    assert.match(String(created.item.text), /\[redacted\]/);

    const updated = await requestJson<{ item: JsonRecord }>(baseUrl, '/api/knowledge/items/service-secret', {
      method: 'PATCH',
      body: JSON.stringify({
        text: 'Search service is backed by SQLite FTS5.',
        type: 'runbook',
        tags: ['fts5'],
      }),
    });
    assert.equal(updated.item.type, 'runbook');
    assert.deepEqual(updated.item.tags, ['fts5']);

    const fetched = await requestJson<{ item: JsonRecord }>(baseUrl, '/api/knowledge/items/service-secret');
    assert.equal(fetched.item.text, 'Search service is backed by SQLite FTS5.');

    await requestJson<{ item: JsonRecord }>(baseUrl, '/api/knowledge/items', {
      method: 'POST',
      body: JSON.stringify({
        id: 'other-project',
        type: 'note',
        title: 'Unrelated search note',
        text: 'Search in another project.',
        project: 'other',
        repo: '/srv/other',
      }),
    });

    const search = await requestJson<{ items: JsonRecord[] }>(
      baseUrl,
      '/api/knowledge/search?q=SQLite%20FTS5&type=runbook&project=curator&repo=%2Fsrv%2Fcurator&limit=5',
    );
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].id, 'service-secret');
    assert.equal(typeof search.items[0].score, 'number');

    const filtered = await requestJson<{ items: JsonRecord[] }>(
      baseUrl,
      '/api/knowledge/search?q=search&type=note&project=curator&limit=5',
    );
    assert.equal(filtered.items.length, 0);

    const aliasSearch = await requestJson<{ items: JsonRecord[] }>(
      baseUrl,
      '/api/hermes/knowledge-search?q=search&type=runbook&type=note&limit=5',
    );
    assert.equal(aliasSearch.items.length, 2);
    assert.deepEqual(new Set(aliasSearch.items.map((item) => item.type)), new Set(['runbook', 'note']));
  } finally {
    if (server) await stopServer(server);
    await rm(testRoot, { recursive: true, force: true });
  }
});
