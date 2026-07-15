import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function requestJson<T extends JsonRecord>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Hub federates Gateway knowledge, enriches context packs, and safely reads canonical Markdown', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-knowledge-federation-'));
  const codexHome = join(testRoot, 'codex-home');
  const statePath = join(codexHome, 'session-curator-state.json');
  const knowledgeRepo = join(testRoot, 'agent-knowledge-stack');
  const runbookPath = join(knowledgeRepo, 'knowledge', 'runbooks', 'thin-worker.md');
  const outsidePath = join(testRoot, 'outside.md');
  const gatewayPort = await freePort();
  const curatorPort = await freePort();
  const baseUrl = `http://127.0.0.1:${curatorPort}`;
  const logs: string[] = [];
  let curator: ChildProcessWithoutNullStreams | null = null;

  await mkdir(dirname(runbookPath), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(runbookPath, '# Thin Worker\n\n## Hub Knowledge\n\nWorkers query the Hub.\n', 'utf8');
  await writeFile(outsidePath, '# Outside\n', 'utf8');
  await symlink(outsidePath, join(knowledgeRepo, 'knowledge', 'runbooks', 'escape.md'));
  await writeFile(join(knowledgeRepo, 'knowledge', 'runbooks', 'not-markdown.txt'), 'not markdown\n', 'utf8');
  await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {}, commanderActions: {} }), 'utf8');

  spawnSync('git', ['init', '-q'], { cwd: knowledgeRepo });
  spawnSync('git', ['config', 'user.email', 'curator-test@example.invalid'], { cwd: knowledgeRepo });
  spawnSync('git', ['config', 'user.name', 'Curator Test'], { cwd: knowledgeRepo });
  spawnSync('git', ['add', 'knowledge/runbooks/thin-worker.md'], { cwd: knowledgeRepo });
  const committed = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: knowledgeRepo });
  assert.equal(committed.status, 0);

  const gateway = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/search') {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      query: 'thin worker',
      query_id: 'gateway-query-test',
      retrieval: 'qdrant',
      collection: 'test-knowledge',
      matches: [
        {
          id: 'gateway-runbook-chunk',
          doc_id: 'gateway-runbook',
          title: 'Thin Worker',
          path: 'knowledge/runbooks/thin-worker.md',
          kind: 'document',
          heading: 'Hub Knowledge',
          start_line: 3,
          tags: ['worker'],
          source_hash: 'source-hash',
          chunk_hash: 'chunk-hash',
          text: 'Workers query the Hub knowledge service without a local clone.',
          snippet: 'Workers query the Hub knowledge service.',
          score: 0.91,
          semantic_score: 0.91,
          lexical_score: 0.4,
          source: 'qdrant',
        },
        {
          id: 'gateway-runbook-second-chunk',
          doc_id: 'gateway-runbook',
          title: 'Thin Worker',
          path: 'knowledge/runbooks/thin-worker.md',
          kind: 'document',
          heading: 'Transport',
          start_line: 8,
          tags: ['worker'],
          source_hash: 'source-hash',
          chunk_hash: 'second-chunk-hash',
          text: 'The Hub and worker communicate through localhost SSH forwards.',
          snippet: 'The Hub and worker communicate through localhost SSH forwards.',
          score: 0.81,
          semantic_score: 0.81,
          lexical_score: 0.3,
          source: 'qdrant',
        },
      ],
    }));
  });
  await new Promise<void>((resolve) => gateway.listen(gatewayPort, '127.0.0.1', resolve));

  try {
    curator = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_KNOWLEDGE_DB: join(testRoot, 'knowledge.sqlite'),
        CURATOR_KNOWLEDGE_REPO: knowledgeRepo,
        CURATOR_KNOWLEDGE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        CURATOR_CODEX_JOBS_PATH: join(testRoot, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'knowledge-hub-test',
        CURATOR_ROLE: 'hub',
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        CURATOR_AUTO_BACKFILL_INTERVAL_MS: '0',
        HOST: '127.0.0.1',
        PORT: String(curatorPort),
      },
    });
    curator.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    curator.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, curator, logs);

    await requestJson<JsonRecord>(baseUrl, '/api/knowledge/items', {
      method: 'POST',
      body: JSON.stringify({ type: 'note', title: 'Local thin worker note', text: 'thin worker local sqlite entry' }),
    });

    const search = await requestJson<{ items: JsonRecord[]; sources: JsonRecord }>(baseUrl, '/api/knowledge/search?q=thin%20worker&limit=2');
    assert.ok(search.items.some((item) => item.retrievalSource === 'sqlite'));
    assert.ok(search.items.some((item) => item.retrievalSource === 'gateway'));
    assert.equal((search.sources.gateway as JsonRecord).available, true);
    assert.equal((search.sources.gateway as JsonRecord).queryId, 'gateway-query-test');

    const contextPack = await requestJson<{ runbooks: JsonRecord[]; workerPromptContext: string }>(
      baseUrl,
      '/api/context-pack?q=thin%20worker&limit=5&remote=0',
    );
    assert.ok(contextPack.runbooks.some((item) => String(item.title).includes('Thin Worker')));
    assert.equal(contextPack.runbooks.filter((item) => String(item.title).includes('Thin Worker')).length, 1);
    assert.match(contextPack.workerPromptContext, /Thin Worker/);

    const document = await requestJson<{ document: JsonRecord }>(
      baseUrl,
      '/api/knowledge/document?path=knowledge%2Frunbooks%2Fthin-worker.md',
    );
    assert.equal(document.document.path, 'knowledge/runbooks/thin-worker.md');
    assert.match(String(document.document.text), /Workers query the Hub/);
    assert.match(String(document.document.sourceHash), /^[0-9a-f]{64}$/);
    assert.match(String(document.document.gitCommit), /^[0-9a-f]{40}$/);
    assert.deepEqual((document.document.headings as JsonRecord[]).map((heading) => heading.line), [1, 3]);

    for (const path of ['..%2Foutside.md', 'knowledge%2Frunbooks%2Fnot-markdown.txt', 'knowledge%2Frunbooks%2Fescape.md']) {
      const response = await fetch(`${baseUrl}/api/knowledge/document?path=${path}`);
      assert.equal(response.status, 400);
    }

    await closeServer(gateway);
    const degraded = await requestJson<{ items: JsonRecord[]; sources: JsonRecord }>(baseUrl, '/api/knowledge/search?q=thin%20worker&limit=2');
    assert.ok(degraded.items.some((item) => item.retrievalSource === 'sqlite'));
    assert.equal((degraded.sources.gateway as JsonRecord).available, false);
  } finally {
    if (gateway.listening) await closeServer(gateway);
    if (curator) await stopServer(curator);
    await rm(testRoot, { recursive: true, force: true });
  }
});
