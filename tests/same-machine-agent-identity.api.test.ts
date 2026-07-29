import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServer(
  baseUrl: string,
  server: ChildProcessWithoutNullStreams,
  logs: string[],
): Promise<void> {
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

async function requestJson<T>(
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
  if (!response.ok) assert.fail(`HTTP ${response.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function evaluationFixture(title: string, cwd: string, filePath: string, now: string) {
  return {
    title,
    summary: `${title} summary`,
    detailedSummary: `${title} detail`,
    recommendation: 'keep',
    score: 90,
    reasons: ['same-machine Agent identity fixture'],
    actualWorkdirs: [cwd],
    directoryIndex: ['same-machine-agent'],
    techStack: ['TypeScript'],
    keywords: ['same-machine', 'identity'],
    failureCards: [],
    jobOutcomes: [],
    searchText: `${title} same machine identity`,
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
    messageCount: 1,
    userTurns: 1,
    assistantTurns: 0,
    shellSnapshotCount: 0,
  };
}

test('same-machine Codex and Claude duplicate IDs route and mutate by agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-same-machine-agent-'));
  const codexHome = join(root, '.codex');
  const claudeHome = join(root, '.claude');
  const codexProject = join(root, 'codex-project');
  const claudeProject = join(root, 'claude-project');
  const migrationTarget = join(root, 'migration-target');
  const sessionId = 'same-machine-shared-id';
  const codexSessionPath = join(codexHome, 'sessions', `${sessionId}.jsonl`);
  const claudeSessionPath = join(claudeHome, 'projects', '-fixture', `${sessionId}.jsonl`);
  const statePath = join(codexHome, 'session-curator-state.json');
  const port = 55_000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let server: ChildProcessWithoutNullStreams | null = null;
  const now = new Date().toISOString();

  await mkdir(dirname(codexSessionPath), { recursive: true });
  await mkdir(dirname(claudeSessionPath), { recursive: true });
  await mkdir(codexProject, { recursive: true });
  await mkdir(claudeProject, { recursive: true });
  await mkdir(migrationTarget, { recursive: true });
  await writeFile(join(codexProject, 'codex-only.txt'), 'codex\n', 'utf8');
  await writeFile(join(claudeProject, 'claude-only.txt'), 'claude\n', 'utf8');
  await writeFile(codexSessionPath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: now,
      payload: { id: sessionId, cwd: codexProject, timestamp: now },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: now,
      payload: { role: 'user', content: 'CODEX_SHARED_ID_USER' },
    }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(claudeSessionPath, [
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd: claudeProject,
      timestamp: now,
      message: { role: 'user', content: [{ type: 'text', text: 'CLAUDE_SHARED_ID_USER' }] },
    }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(
    statePath,
    JSON.stringify({
      keptIds: [],
      deletedIds: [],
      titles: {},
      evaluations: {
        [`codex|||${sessionId}`]: evaluationFixture('CODEX_KNOWLEDGE_IDENTITY', codexProject, codexSessionPath, now),
        [`claude|||${sessionId}`]: evaluationFixture('CLAUDE_KNOWLEDGE_IDENTITY', claudeProject, claudeSessionPath, now),
      },
      commanderActions: {},
    }),
    'utf8',
  );

  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_CODEX_JOBS_PATH: join(root, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(root, 'recycle'),
        CURATOR_MACHINE_ID: 'same-machine',
        CURATOR_REMOTE_AGENTS: '',
        CURATOR_KNOWLEDGE_GATEWAY_ENABLED: '0',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_SESSION_CACHE_TTL_MS: '0',
        CURATOR_REMOTE_SESSION_CACHE_TTL_MS: '0',
        CURATOR_AUTO_BACKFILL: '0',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '0',
        CURATOR_LLM_BASE_URL: 'http://127.0.0.1:9',
        CURATOR_LLM_API_KEY: 'test-only',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    server.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    server.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, server, logs);

    const sessions = await requestJson<{ sessions: Array<{ id: string; agent: string }> }>(
      baseUrl,
      '/api/sessions?detail=0&remote=0',
    );
    const duplicates = sessions.sessions.filter((session) => session.id === sessionId);
    assert.deepEqual(new Set(duplicates.map((session) => session.agent)), new Set(['codex', 'claude']));

    const ambiguous = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    assert.equal(ambiguous.status, 409);
    assert.equal(
      ((await ambiguous.json()) as { code?: string }).code,
      'AMBIGUOUS_SESSION_IDENTITY',
    );

    const codexQuery = 'machineId=same-machine&agent=codex';
    const claudeQuery = 'machineId=same-machine&agent=claude';
    const codexDetail = await requestJson<{ cwd: string; agent: string }>(
      baseUrl,
      `/api/sessions/${sessionId}?${codexQuery}`,
    );
    const claudeDetail = await requestJson<{ cwd: string; agent: string }>(
      baseUrl,
      `/api/sessions/${sessionId}?${claudeQuery}`,
    );
    assert.equal(codexDetail.cwd, codexProject);
    assert.equal(codexDetail.agent, 'codex');
    assert.equal(claudeDetail.cwd, claudeProject);
    assert.equal(claudeDetail.agent, 'claude');

    const codexFiles = await requestJson<{ entries: Array<{ name: string }> }>(
      baseUrl,
      `/api/sessions/${sessionId}/files?${codexQuery}`,
    );
    const claudeFiles = await requestJson<{ entries: Array<{ name: string }> }>(
      baseUrl,
      `/api/sessions/${sessionId}/files?${claudeQuery}`,
    );
    assert.ok(codexFiles.entries.some((entry) => entry.name === 'codex-only.txt'));
    assert.ok(!codexFiles.entries.some((entry) => entry.name === 'claude-only.txt'));
    assert.ok(claudeFiles.entries.some((entry) => entry.name === 'claude-only.txt'));

    const audit = await requestJson<{ sessionIds: string[] }>(baseUrl, '/api/audit/completeness');
    assert.deepEqual(
      new Set(audit.sessionIds.filter((id) => id.endsWith(`|||${sessionId}`))),
      new Set([`codex|||${sessionId}`, `claude|||${sessionId}`]),
    );

    await requestJson(baseUrl, '/api/knowledge/items', {
      method: 'POST',
      body: JSON.stringify({
        id: `${sessionId}:session-index`,
        type: 'session',
        scope: 'session_index',
        title: 'legacy raw identity',
        text: sessionId,
        source: 'curator:auto-sync',
      }),
    });
    await requestJson(baseUrl, '/api/hermes/session-index?remote=0');
    const knowledge = await requestJson<{
      items: Array<{ id: string; scope: string; tags: string[] }>;
    }>(baseUrl, `/api/knowledge/search?q=${encodeURIComponent(sessionId)}&limit=20`);
    const identityDocuments = knowledge.items.filter(
      (item) => item.scope === 'session_index' && item.tags.includes(sessionId),
    );
    assert.equal(identityDocuments.length, 2);
    assert.deepEqual(
      new Set(identityDocuments.flatMap((item) => item.tags.filter((tag) => tag === 'codex' || tag === 'claude'))),
      new Set(['codex', 'claude']),
    );
    assert.equal(new Set(identityDocuments.map((item) => item.id)).size, 2);
    assert.equal((await fetch(`${baseUrl}/api/knowledge/items/${encodeURIComponent(`${sessionId}:session-index`)}`)).status, 404);

    const claudeInPlace = await requestJson<{ resumeCommand: string; alreadyInTarget: boolean }>(
      baseUrl,
      `/api/sessions/${sessionId}/migrate`,
      {
        method: 'POST',
        body: JSON.stringify({
          targetProjectDir: claudeProject,
          machineId: 'same-machine',
          agent: 'claude',
        }),
      },
    );
    assert.equal(claudeInPlace.alreadyInTarget, true);
    assert.equal(claudeInPlace.resumeCommand, `claude --resume ${sessionId}`);

    const unsupportedClaudeMigration = await fetch(`${baseUrl}/api/sessions/${sessionId}/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetProjectDir: migrationTarget,
        machineId: 'same-machine',
        agent: 'claude',
      }),
    });
    assert.equal(unsupportedClaudeMigration.status, 422);
    assert.equal(
      ((await unsupportedClaudeMigration.json()) as { code?: string }).code,
      'CLAUDE_SESSION_MIGRATION_UNSUPPORTED',
    );
    await access(claudeSessionPath);

    const codexInPlace = await requestJson<{ resumeCommand: string; alreadyInTarget: boolean }>(
      baseUrl,
      `/api/sessions/${sessionId}/migrate`,
      {
        method: 'POST',
        body: JSON.stringify({
          targetProjectDir: codexProject,
          machineId: 'same-machine',
          agent: 'codex',
        }),
      },
    );
    assert.equal(codexInPlace.alreadyInTarget, true);
    assert.match(codexInPlace.resumeCommand, /^codex resume -C /);

    await requestJson(baseUrl, `/api/sessions/${sessionId}/keep`, {
      method: 'POST',
      body: JSON.stringify({
        kept: true,
        machineId: 'same-machine',
        agent: 'codex',
      }),
    });
    await requestJson(baseUrl, `/api/sessions/${sessionId}/title`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'CODEX_SCOPED_TITLE',
        machineId: 'same-machine',
        agent: 'codex',
      }),
    });
    const codexState = await requestJson<{ kept: boolean; customTitle: string | null }>(
      baseUrl,
      `/api/sessions/${sessionId}?${codexQuery}`,
    );
    const claudeState = await requestJson<{ kept: boolean; customTitle: string | null }>(
      baseUrl,
      `/api/sessions/${sessionId}?${claudeQuery}`,
    );
    assert.equal(codexState.kept, true);
    assert.equal(codexState.customTitle, 'CODEX_SCOPED_TITLE');
    assert.equal(claudeState.kept, false);
    assert.notEqual(claudeState.customTitle, 'CODEX_SCOPED_TITLE');

    const deleted = await requestJson<{ agent: string }>(
      baseUrl,
      `/api/sessions/${sessionId}?${claudeQuery}&remote=0`,
      {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(deleted.agent, 'claude');
    await assert.rejects(access(claudeSessionPath));
    await access(codexSessionPath);

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      keptIds: string[];
      titles: Record<string, string>;
    };
    assert.ok(state.keptIds.includes(`codex|||${sessionId}`));
    assert.equal(state.titles[`codex|||${sessionId}`], 'CODEX_SCOPED_TITLE');
  } finally {
    if (server) await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
