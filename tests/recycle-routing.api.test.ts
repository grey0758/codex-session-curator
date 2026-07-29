import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

async function requestJson<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

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

async function stopProcess(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

test('main panel aggregates and routes remote recycle actions and recommended prune', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-routing-'));
  const codexHome = join(testRoot, 'codex-home');
  const statePath = join(codexHome, 'session-curator-state.json');
  const jobsPath = join(testRoot, 'jobs.json');
  const remoteCalls: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }> = [];
  let remoteRecycleAvailable = true;
  const remoteArchive = {
    sessionId: 'remote-archive',
    agent: 'claude',
    archiveDir: '/remote/recycle/remote-archive',
    originalSessionFile: '/home/grey/.claude/projects/fixture/remote-archive.jsonl',
    deletedAt: '2026-07-12T00:00:00.000Z',
    expiresAt: '2026-08-11T00:00:00.000Z',
    retentionDays: 30,
    archivedFiles: ['/remote/recycle/remote-archive/claude-projects/fixture/remote-archive.jsonl'],
    removedOriginalFiles: ['/home/grey/.claude/projects/fixture/remote-archive.jsonl'],
    removedHistoryEntries: 0,
  };
  const olderRemoteArchive = {
    ...remoteArchive,
    agent: 'codex',
    archiveDir: '/remote/recycle/remote-archive-older',
    originalSessionFile: '/home/grey/.codex/sessions/remote-archive.jsonl',
    deletedAt: '2026-07-11T00:00:00.000Z',
    archivedFiles: ['/remote/recycle/remote-archive-older/sessions/remote-archive.jsonl'],
    removedOriginalFiles: ['/home/grey/.codex/sessions/remote-archive.jsonl'],
  };

  const remoteServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk.toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : null;
    remoteCalls.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    response.setHeader('content-type', 'application/json');

    if (request.method === 'GET' && url.pathname === '/api/recycle-bin') {
      if (!remoteRecycleAvailable) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'remote recycle inventory unavailable' }));
        return;
      }
      response.end(JSON.stringify({ archives: [remoteArchive, olderRemoteArchive] }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      response.end(JSON.stringify({
        sessions: [
          {
            id: 'remote-delete-target',
            title: 'Remote delete target',
            customTitle: null,
            kept: false,
            machineId: 'us002',
            agent: 'codex',
            evaluation: { recommendation: 'delete' },
          },
          {
            id: 'remote-routed-target',
            title: 'Remote routed target',
            customTitle: null,
            kept: true,
            machineId: 'us002',
            agent: 'codex',
            evaluation: { recommendation: 'keep' },
          },
        ],
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions/bulk-delete') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      response.end(JSON.stringify({ results: ids.map((id: string) => ({ id, ok: true, result: { sessionId: id } })) }));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/sessions/remote-routed-target') {
      response.end(JSON.stringify({ sessionId: 'remote-routed-target' }));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/sessions/remote-delete-target') {
      response.end(JSON.stringify({ sessionId: 'remote-delete-target' }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/recycle-bin/remote-archive/restore') {
      response.end(JSON.stringify({ sessionId: 'remote-archive', restoredFiles: ['fixture'], archiveDir: remoteArchive.archiveDir }));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/recycle-bin/remote-archive') {
      response.end(JSON.stringify({ sessionId: 'remote-archive', purgedArchive: remoteArchive.archiveDir }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const remotePort = await listen(remoteServer);
  const port = 58_000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let mainServer: ChildProcessWithoutNullStreams | null = null;

  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(testRoot, 'claude-home', 'projects'), { recursive: true });
  await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {} }), 'utf8');

  try {
    mainServer = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(testRoot, 'claude-home'),
        CODEX_CURATOR_STATE: statePath,
        CURATOR_CODEX_JOBS_PATH: jobsPath,
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'gpl001',
        CURATOR_REMOTE_AGENTS: `us002=http://127.0.0.1:${remotePort}`,
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
    mainServer.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    mainServer.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, mainServer, logs);

    const recycle = await requestJson<{ archives: Array<typeof remoteArchive & { machineId: string }> }>(baseUrl, '/api/recycle-bin');
    assert.equal(recycle.archives.length, 2);
    assert.ok(recycle.archives.every((archive) => archive.machineId === 'us002'));
    assert.equal(
      recycle.archives.find((archive) => archive.archiveDir === remoteArchive.archiveDir)?.agent,
      'claude',
    );

    const legacyRestore = await fetch(`${baseUrl}/api/recycle-bin/remote-archive/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(legacyRestore.status, 409);
    assert.match(
      ((await legacyRestore.json()) as { error?: string }).error ?? '',
      /Multiple recycle archives.*machineId and archiveDir are required/,
    );
    assert.equal(
      remoteCalls.filter((call) => call.method === 'POST' && call.path === '/api/recycle-bin/remote-archive/restore').length,
      0,
    );

    remoteRecycleAvailable = false;
    const unavailableLegacyRestore = await fetch(
      `${baseUrl}/api/recycle-bin/remote-archive/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(unavailableLegacyRestore.status, 503);
    assert.match(
      ((await unavailableLegacyRestore.json()) as { code?: string }).code ?? '',
      /REMOTE_RECYCLE_INVENTORY_UNAVAILABLE/,
    );
    remoteRecycleAvailable = true;

    const recycleRoute = new URLSearchParams({
      machineId: 'us002',
      archiveDir: remoteArchive.archiveDir,
      agent: remoteArchive.agent,
    });
    const remoteDisabledRoute = new URLSearchParams(recycleRoute);
    remoteDisabledRoute.set('remote', '0');
    const remoteDisabledRestore = await fetch(
      `${baseUrl}/api/recycle-bin/remote-archive/restore?${remoteDisabledRoute.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(remoteDisabledRestore.status, 404);
    assert.equal(
      remoteCalls.filter((call) => call.method === 'POST' && call.path === '/api/recycle-bin/remote-archive/restore').length,
      0,
    );

    await requestJson(baseUrl, `/api/recycle-bin/remote-archive/restore?${recycleRoute.toString()}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    await requestJson(baseUrl, `/api/recycle-bin/remote-archive?${recycleRoute.toString()}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    });
    const routedDelete = await requestJson<{
      deleted: number;
      failed: number;
      results: Array<{ id: string; machineId: string; ok: boolean }>;
    }>(baseUrl, '/api/sessions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        sessions: [{ id: 'remote-routed-target', machineId: 'us002' }],
      }),
    });
    assert.equal(routedDelete.deleted, 1);
    assert.equal(routedDelete.failed, 0);
    assert.deepEqual(routedDelete.results[0], {
      id: 'remote-routed-target',
      machineId: 'us002',
      ok: true,
      result: { sessionId: 'remote-routed-target' },
    });
    const prune = await requestJson<{ matched: number; deleted: number; failed: number }>(baseUrl, '/api/sessions/prune', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(prune.matched, 1);
    assert.equal(prune.deleted, 1);
    assert.equal(prune.failed, 0);

    const restoreCall = remoteCalls.find((call) => call.method === 'POST' && call.path === '/api/recycle-bin/remote-archive/restore');
    assert.deepEqual(restoreCall?.query, {
      remote: '0',
      archiveDir: remoteArchive.archiveDir,
      agent: remoteArchive.agent,
    });
    const purgeCall = remoteCalls.find((call) => call.method === 'DELETE' && call.path === '/api/recycle-bin/remote-archive');
    assert.deepEqual(purgeCall?.query, {
      remote: '0',
      archiveDir: remoteArchive.archiveDir,
      agent: remoteArchive.agent,
    });
    const routedDeleteCall = remoteCalls.find(
      (call) => call.method === 'DELETE' && call.path === '/api/sessions/remote-routed-target',
    );
    assert.deepEqual(routedDeleteCall?.query, {
      machineId: 'us002',
      remote: '0',
      agent: 'codex',
    });
    const pruneCall = remoteCalls.find((call) => call.method === 'DELETE' && call.path === '/api/sessions/remote-delete-target');
    assert.deepEqual(pruneCall?.query, {
      machineId: 'us002',
      remote: '0',
      agent: 'codex',
    });
    assert.deepEqual(pruneCall?.body, { confirm: true });
  } finally {
    if (mainServer) await stopProcess(mainServer);
    await closeServer(remoteServer);
    await rm(testRoot, { recursive: true, force: true });
  }
});
