import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CuratorStore } from '../server/store.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

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

test('CuratorStore preserves commander actions in old state files', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-commander-store-'));
  const statePath = join(testRoot, 'state.json');
  try {
    await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {} }), 'utf8');
    const store = new CuratorStore(statePath);
    assert.deepEqual((await store.load()).commanderActions, {});
    await store.addCommanderAction({
      id: 'action-1',
      kind: 'direct-action',
      status: 'started',
      goal: 'test action persistence',
      reason: 'regression coverage',
      scope: null,
      targetRepo: null,
      cwd: null,
      changedFiles: [],
      tests: [],
      verification: [],
      followUp: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    assert.equal((await store.listCommanderActions())[0]?.id, 'action-1');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('Commander Actions API creates, lists, and completes an action', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-commander-api-'));
  const codexHome = join(testRoot, 'codex-home');
  const statePath = join(codexHome, 'session-curator-state.json');
  const port = 55_000 + Math.floor(Math.random() * 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let server: ChildProcessWithoutNullStreams | null = null;
  await mkdir(codexHome, { recursive: true });
  await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {} }), 'utf8');

  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_AUTO_BACKFILL: '0',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    server.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    server.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, server, logs);

    const createdResponse = await fetch(`${baseUrl}/api/commander-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'direct-action',
        goal: 'test direct action route',
        reason: 'regression coverage',
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { action: { id: string; status: string } };
    assert.equal(created.action.status, 'started');

    const listed = (await (await fetch(`${baseUrl}/api/commander-actions`)).json()) as {
      actions: Array<{ id: string }>;
    };
    assert.equal(listed.actions[0]?.id, created.action.id);

    const completedResponse = await fetch(`${baseUrl}/api/commander-actions/${created.action.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', verification: ['route works'] }),
    });
    assert.equal(completedResponse.status, 200);
    const completed = (await completedResponse.json()) as { action: { status: string; completedAt: string | null } };
    assert.equal(completed.action.status, 'completed');
    assert.equal(typeof completed.action.completedAt, 'string');
  } finally {
    if (server) await stopServer(server);
    await rm(testRoot, { recursive: true, force: true });
  }
});
