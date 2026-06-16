import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const serverIdentityCli = '/home/grey/work/codex-control-plane/bin/server-identity';

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

async function requestText(baseUrl: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  return text;
}

async function waitForServer(baseUrl: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.ok) return;
    } catch {
      // Retry until Fastify starts listening.
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

test('server identity API can upsert, patch, export, and render SSH config', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-server-identity-api-'));
  const codexHome = join(testRoot, 'codex-home');
  const dbPath = join(testRoot, 'server-identity.sqlite3');
  const port = 56_000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let server: ChildProcessWithoutNullStreams | null = null;

  await mkdir(codexHome, { recursive: true });

  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CURATOR_STATE: join(codexHome, 'session-curator-state.json'),
        CURATOR_SERVER_IDENTITY_CLI: serverIdentityCli,
        SERVER_IDENTITY_DB: dbPath,
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_AUTO_BACKFILL: '0',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    server.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    server.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, server, logs);

    const created = await requestJson<{ machine: JsonRecord }>(baseUrl, '/api/server-identity/machines', {
      method: 'POST',
      body: JSON.stringify({
        alias: 'test001',
        aliases: ['test001', 'test-primary'],
        status: 'active',
        region: 'test',
        public_dns: 'test001.ip.xiannai.me',
        public_ip: '203.0.113.10',
        ssh_user: 'grey',
        ssh_users: ['grey'],
        ssh_port: 22,
        priority: ['public', 'tailscale'],
        verified_hostname: 'test001',
        verified_at: '2026-06-16',
      }),
    });
    assert.equal(created.machine.alias, 'test001');

    const fetched = await requestJson<{ machine: JsonRecord }>(baseUrl, '/api/server-identity/machines/test-primary');
    assert.equal(fetched.machine.alias, 'test001');
    assert.equal(fetched.machine.public_dns, 'test001.ip.xiannai.me');

    const patched = await requestJson<{ machine: JsonRecord }>(baseUrl, '/api/server-identity/machines/test001', {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'patched through API' }),
    });
    assert.equal(patched.machine.notes, 'patched through API');

    const exported = await requestJson<{ machines: JsonRecord[] }>(baseUrl, '/api/server-identity/export', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(exported.machines.length, 1);

    const sshConfig = await requestText(baseUrl, '/api/server-identity/ssh-config');
    assert.match(sshConfig, /Host .*test-primary/);
    assert.match(sshConfig, /HostName test001\.ip\.xiannai\.me/);
  } finally {
    if (server) await stopServer(server);
    await rm(testRoot, { recursive: true, force: true });
  }
});
