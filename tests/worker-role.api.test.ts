import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
type JsonRecord = Record<string, unknown>;

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
  assert.fail(`Timed out waiting for worker startup; logs=${logs.join('').slice(-2000)}`);
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

test('worker role indexes Codex and Claude locally while Hub-only APIs and frontend remain absent', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-worker-role-'));
  const codexHome = join(testRoot, '.codex');
  const claudeHome = join(testRoot, '.claude');
  const projectDir = join(testRoot, 'project');
  const codexSessionId = 'worker-codex-session';
  const codexSubagentSessionId = 'worker-codex-subagent-session';
  const claudeSessionId = 'worker-claude-session';
  const codexSessionPath = join(codexHome, 'sessions', `${codexSessionId}.jsonl`);
  const codexSubagentSessionPath = join(codexHome, 'sessions', `${codexSubagentSessionId}.jsonl`);
  const claudeSessionPath = join(claudeHome, 'projects', '-worker-project', `${claudeSessionId}.jsonl`);
  const statePath = join(codexHome, 'session-curator-state.json');
  const knowledgeDb = join(testRoot, 'must-not-exist.sqlite');
  const port = 52_000 + Math.floor(Math.random() * 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let worker: ChildProcessWithoutNullStreams | null = null;

  await mkdir(dirname(codexSessionPath), { recursive: true });
  await mkdir(dirname(claudeSessionPath), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(codexSessionPath, [
    JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id: codexSessionId, cwd: projectDir, timestamp: now } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'CODEX_WORKER_USER' } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'assistant', content: 'CODEX_WORKER_ASSISTANT' } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: '<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>' } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'CODEX_WORKER_RECENT\nSECOND_LINE' } }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(codexSubagentSessionPath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: now,
      payload: {
        id: codexSubagentSessionId,
        cwd: projectDir,
        timestamp: now,
        thread_source: 'subagent',
        parent_thread_id: codexSessionId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: codexSessionId,
              depth: 1,
              agent_path: '/root/reviewer',
            },
          },
        },
      },
    }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'user', content: 'COPIED_PARENT_USER' } }),
    JSON.stringify({ type: 'response_item', timestamp: now, payload: { role: 'assistant', content: 'SUBAGENT_REPLY' } }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(claudeSessionPath, [
    JSON.stringify({ type: 'user', sessionId: claudeSessionId, cwd: projectDir, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'CLAUDE_WORKER_USER' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: claudeSessionId, cwd: projectDir, timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE_WORKER_ASSISTANT' }] } }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(statePath, JSON.stringify({ keptIds: [], deletedIds: [], titles: {}, evaluations: {}, commanderActions: {} }), 'utf8');

  try {
    worker = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_CURATOR_STATE: statePath,
        CURATOR_KNOWLEDGE_DB: knowledgeDb,
        CURATOR_CODEX_JOBS_PATH: join(testRoot, 'jobs.json'),
        CURATOR_RECYCLE_ROOT: join(testRoot, 'recycle'),
        CURATOR_MACHINE_ID: 'thin-worker-test',
        CURATOR_ROLE: 'worker',
        CURATOR_REMOTE_AGENTS: 'unexpected=http://127.0.0.1:9',
        CURATOR_AUTH_USER: '',
        CURATOR_AUTH_PASSWORD: '',
        CURATOR_ADMIN_TOKEN: '',
        CURATOR_SESSION_CACHE_TTL_MS: '8000',
        CURATOR_CODEX_SUPERVISOR_INTERVAL_MS: '3600000',
        CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS: '60000',
        CURATOR_AUTO_BACKFILL_INTERVAL_MS: '60000',
        CURATOR_LLM_BASE_URL: 'http://127.0.0.1:9',
        CURATOR_LLM_API_KEY: 'test-only',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
    });
    worker.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    worker.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    await waitForServer(baseUrl, worker, logs);

    const meta = await requestJson<{ role: string; capabilities: JsonRecord }>(baseUrl, '/api/meta');
    assert.equal(meta.role, 'worker');
    assert.equal(meta.capabilities.panel, false);
    assert.equal(meta.capabilities.knowledge, false);
    assert.equal(meta.capabilities.sessions, true);
    assert.deepEqual(meta.capabilities.agents, ['codex', 'claude']);

    const sessions = await requestJson<{ sessions: JsonRecord[]; meta: JsonRecord }>(baseUrl, '/api/sessions?detail=0&remote=0');
    assert.deepEqual(new Set(sessions.sessions.map((session) => session.agent)), new Set(['codex', 'claude']));
    assert.equal(sessions.sessions.some((session) => session.id === codexSubagentSessionId), false);
    assert.deepEqual(sessions.meta.remoteAgents, []);

    const index = await requestJson<{ sessions: JsonRecord[] }>(baseUrl, '/api/hermes/session-index?limit=10&remote=0');
    assert.deepEqual(new Set(index.sessions.map((session) => session.agent)), new Set(['codex', 'claude']));
    assert.equal(index.sessions.some((session) => session.id === codexSubagentSessionId), false);

    const files = await requestJson<{ cwd: string; entries: JsonRecord[] }>(baseUrl, `/api/sessions/${codexSessionId}/files`);
    assert.equal(files.cwd, projectDir);
    const history = await requestJson<{ messages: JsonRecord[] }>(baseUrl, `/api/sessions/${claudeSessionId}/history?limit=5`);
    assert.equal(history.messages.length, 2);
    const recent = await requestJson<{
      messages: Array<{ text: string; precedingContext?: Array<{ kind: string }> }>;
      totalUserMessages: number;
      hiddenContextMessages: number;
      cached: boolean;
    }>(baseUrl, `/api/sessions/${codexSessionId}/recent-user-messages?limit=4`);
    assert.equal(recent.cached, false);
    assert.equal(recent.totalUserMessages, 2);
    assert.equal(recent.hiddenContextMessages, 1);
    assert.equal(recent.messages.at(-1)?.text, 'CODEX_WORKER_RECENT\nSECOND_LINE');
    assert.deepEqual(recent.messages.at(-1)?.precedingContext?.map((item) => item.kind), ['environment_context']);
    const recentCached = await requestJson<{ cached: boolean }>(
      baseUrl,
      `/api/sessions/${codexSessionId}/recent-user-messages?limit=4`,
    );
    assert.equal(recentCached.cached, true);
    await requestJson<JsonRecord>(baseUrl, '/api/hermes/jobs');
    await requestJson<JsonRecord>(baseUrl, '/api/recycle-bin?remote=0');
    const audit = await requestJson<{ counts: JsonRecord; issues: JsonRecord[]; pending: JsonRecord[]; skipped: JsonRecord[] }>(baseUrl, '/api/audit/completeness');
    assert.equal(audit.counts.parsedSessions, 2);
    assert.equal(audit.counts.eligibleSessions, 2);
    assert.equal(audit.counts.fullyEvaluatedSessions, 0);
    assert.equal(audit.counts.pendingEvaluationSessions, 2);
    assert.equal(audit.counts.actionableIssues, 0);
    assert.equal(audit.issues.length, 0);
    assert.equal(audit.pending.length, 2);
    assert.equal(audit.skipped.length, 0);
    const evaluationInput = await requestJson<{ transcriptHash: string; messageCount: number }>(
      baseUrl,
      `/api/worker/evaluation-input/${codexSessionId}`,
    );
    assert.match(evaluationInput.transcriptHash, /^[0-9a-f]{64}$/);
    assert.equal(evaluationInput.messageCount, 4);

    const hubOnlyRequests: Array<[string, RequestInit | undefined]> = [
      ['/', undefined],
      ['/api/knowledge/search?q=test', undefined],
      ['/api/knowledge/proposals', undefined],
      ['/api/hermes/knowledge-document?path=knowledge%2FINDEX.md', undefined],
      ['/api/context-pack?q=test', undefined],
      ['/api/analysis-runs', undefined],
      ['/api/server-identity/machines', undefined],
      ['/api/evaluations/retry-failed', { method: 'POST' }],
      ['/api/commander-actions', undefined],
      ['/api/hermes/dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/api/remote-agents', undefined],
      ['/api/audit/fleet', undefined],
      ['/api/sessions/ai-search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"test"}' }],
    ];
    for (const [path, init] of hubOnlyRequests) {
      const response = await fetch(`${baseUrl}${path}`, init);
      assert.equal(response.status, 404, path);
    }

    await assert.rejects(access(knowledgeDb));
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { evaluations: Record<string, JsonRecord> };
    assert.match(String(state.evaluations[`codex|||${codexSessionId}`].workflow), /:fast-list$/);
    assert.match(String(state.evaluations[`claude|||${claudeSessionId}`].workflow), /:fast-list$/);
    assert.equal(state.evaluations[`codex|||${codexSubagentSessionId}`], undefined);
  } finally {
    if (worker) await stopServer(worker);
    await rm(testRoot, { recursive: true, force: true });
  }
});
