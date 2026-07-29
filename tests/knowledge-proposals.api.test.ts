import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
type JsonRecord = Record<string, unknown>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate test port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.status < 500) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for Curator; logs=${logs.join('').slice(-3000)}`);
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

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: JsonRecord }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as JsonRecord : {} };
}

function proposalBody(localId: string, content = '# Proposal\n') {
  return {
    localId,
    baseSourceHash: 'a'.repeat(64),
    reason: 'exercise the single-writer proposal queue',
    sourceMachineId: 'cnal002',
    sourceSessionId: 'test-session',
    changes: [{
      path: 'knowledge/runbooks/proposal-test.md',
      operation: 'upsert',
      baseSha256: null,
      content,
      mode: '100644',
    }],
  };
}

test('Hub stores idempotent proposals and gates asynchronous apply/reject with a separate capability', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-proposals-'));
  const codexHome = join(testRoot, 'codex-home');
  const statePath = join(codexHome, 'session-curator-state.json');
  const helper = join(testRoot, 'apply-helper');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let curator: ChildProcessWithoutNullStreams | null = null;

  await mkdir(codexHome, { recursive: true });
  await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {}, commanderActions: {} }), 'utf8');
  await writeFile(helper, `#!/bin/sh
set -eu
read_payload="$(mktemp)"
trap 'rm -f "$read_payload"' EXIT
tee "$read_payload" >/dev/null
printf '%s\n' '{"ok":true,"preSourceHash":"${'a'.repeat(64)}","postSourceHash":"${'c'.repeat(64)}","changedFiles":["knowledge/runbooks/proposal-test.md"],"backupPath":"/tmp/test-proposal-backup","validations":["test validation"]}'
`, 'utf8');
  await chmod(helper, 0o755);

  try {
    curator = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_KNOWLEDGE_DB: join(testRoot, 'knowledge.sqlite'),
        CURATOR_KNOWLEDGE_PROPOSAL_APPLY_COMMAND: helper,
        CURATOR_PROPOSAL_APPLY_TOKEN: 'proposal-apply-test-token',
        CURATOR_CODEX_JOBS_PATH: join(testRoot, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'proposal-hub-test',
        CURATOR_ROLE: 'hub',
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        CURATOR_AUTO_BACKFILL_INTERVAL_MS: '0',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    curator.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    curator.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, curator, logs);

    const invalid = await request(baseUrl, '/api/knowledge/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...proposalBody('invalid-path'), changes: [{
        path: '../escape.md', operation: 'upsert', baseSha256: null, content: '# Escape\n', mode: '100644',
      }] }),
    });
    assert.equal(invalid.status, 400);

    const created = await request(baseUrl, '/api/knowledge/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proposalBody('cnal002-local-1')),
    });
    assert.equal(created.status, 201);
    const createdProposal = created.body.proposal as JsonRecord;
    assert.equal(createdProposal.status, 'pending');
    assert.equal(createdProposal.riskClass, 'ordinary');
    const proposalId = String(createdProposal.id);

    const duplicate = await request(baseUrl, '/api/knowledge/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proposalBody('cnal002-local-1')),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.idempotent, true);
    assert.equal((duplicate.body.proposal as JsonRecord).id, proposalId);

    const mismatch = await request(baseUrl, '/api/knowledge/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proposalBody('cnal002-local-1', '# Different\n')),
    });
    assert.equal(mismatch.status, 409);

    const withoutCapability = await request(baseUrl, `/api/knowledge/proposals/${proposalId}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publish: 'none' }),
    });
    assert.equal(withoutCapability.status, 403);

    const apply = await request(baseUrl, `/api/knowledge/proposals/${proposalId}/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-curator-proposal-apply-token': 'proposal-apply-test-token',
      },
      body: JSON.stringify({ publish: 'none' }),
    });
    assert.equal(apply.status, 202);
    assert.equal((apply.body.proposal as JsonRecord).status, 'applying');

    let completed: JsonRecord | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await request(baseUrl, `/api/knowledge/proposals/${proposalId}`);
      const proposal = current.body.proposal as JsonRecord;
      if (proposal.status === 'applied') {
        completed = proposal;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(completed);
    assert.equal(((completed.result as JsonRecord).publish as JsonRecord).status, 'skipped');

    const second = await request(baseUrl, '/api/knowledge/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proposalBody('cnal002-local-2', '# Reject me\n')),
    });
    const secondId = String((second.body.proposal as JsonRecord).id);
    const rejected = await request(baseUrl, `/api/knowledge/proposals/${secondId}/reject`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-curator-proposal-apply-token': 'proposal-apply-test-token',
      },
      body: JSON.stringify({ reason: 'test rejection' }),
    });
    assert.equal(rejected.status, 200);
    assert.equal((rejected.body.proposal as JsonRecord).status, 'rejected');

    const list = await request(baseUrl, '/api/knowledge/proposals?limit=10');
    assert.equal((list.body.proposals as JsonRecord[]).length, 2);
  } finally {
    if (curator) await stopServer(curator);
    await rm(testRoot, { recursive: true, force: true });
  }
});
