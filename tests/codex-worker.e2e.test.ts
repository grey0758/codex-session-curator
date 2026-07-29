import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexSession } from '../server/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeCodexBin = join(__dirname, 'fixtures', 'fake-codex-worker.mjs');
const testRoot = await mkdtemp(join(tmpdir(), 'curator-codex-worker-e2e-'));
const jobsPath = join(testRoot, 'jobs.json');

process.env.CODEX_BIN = fakeCodexBin;
process.env.CURATOR_CODEX_JOBS_PATH = jobsPath;
process.env.CURATOR_CODEX_JOB_TAIL_BYTES = String(128 * 1024);
process.env.CURATOR_CODEX_JOB_MAX_EVENTS = '500';
process.env.CURATOR_CODEX_SUPERVISOR_IDLE_MS = '10000';

await chmod(fakeCodexBin, 0o755);

const {
  getCodexResumeJob,
  listCodexJobEvents,
  startCodexResumeJob,
  stopCodexResumeJob,
  superviseCodexResumeJob,
} = await import('../server/codex-jobs.ts');

const startedJobIds: string[] = [];

test.after(async () => {
  for (const jobId of startedJobIds) {
    const job = getCodexResumeJob(jobId);
    if (job?.status === 'running') stopCodexResumeJob(job.id);
  }
  await rm(testRoot, { recursive: true, force: true });
});

function sessionFixture(name: string): CodexSession {
  const now = new Date().toISOString();
  return {
    id: `session-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    filePath: join(testRoot, `${name}.jsonl`),
    cwd: testRoot,
    startedAt: now,
    updatedAt: now,
    bytes: 0,
    messageCount: 1,
    userTurns: 1,
    assistantTurns: 0,
    shellSnapshotCount: 0,
    title: `Fake ${name}`,
    customTitle: null,
    resumeCommand: `codex resume ${name}`,
    machineId: 'test-machine',
    activityStatus: 'active',
    lastActiveAt: now,
    inactiveDays: 0,
    kept: false,
    deleted: false,
    evaluation: {
      title: `Fake ${name}`,
      summary: 'fake session',
      detailedSummary: 'fake session for worker e2e tests',
      recommendation: 'review',
      score: 10,
      reasons: [],
      actualWorkdirs: [testRoot],
      directoryIndex: [],
      techStack: [],
      keywords: ['fake-codex'],
      searchText: 'fake codex',
      updateCadence: 'new',
      reviewPriority: 'normal',
      reviewSignals: [],
      cwdMatchesWorkdir: true,
      recommendedWorkdir: testRoot,
      remoteMachines: [],
      evaluatedAt: now,
      workflow: 'test',
      model: 'test',
      status: 'ok',
      error: null,
    },
  };
}

async function waitForJob(jobId: string, predicate: (job: NonNullable<ReturnType<typeof getCodexResumeJob>>) => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = getCodexResumeJob(jobId);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const job = getCodexResumeJob(jobId);
  assert.fail(`Timed out waiting for job ${jobId}; last status=${job?.status}, tail=${JSON.stringify(job?.outputTail.slice(-300))}`);
}

function startFakeJob(
  scenario: string,
  options: Partial<Parameters<typeof startCodexResumeJob>[0]> = {},
) {
  const job = startCodexResumeJob({
    session: sessionFixture(scenario),
    prompt: `run ${scenario}`,
    mode: 'exec',
    extraArgs: ['--fake-scenario', scenario],
    ...options,
  });
  startedJobIds.push(job.id);
  return job;
}

test('fake Codex worker completes normally', async () => {
  const job = startFakeJob('complete');
  const completed = await waitForJob(job.id, (item) => item.status === 'completed');

  assert.equal(completed.exitCode, 0);
  assert.match(completed.outputTail, /Implemented requested change/);
  assert.ok(listCodexJobEvents(job.id).some((event) => event.type === 'completion'));
});

test('PTY worker command uses the configured worker binary', async () => {
  process.env.FAKE_CODEX_SCENARIO = 'waiting-confirmation';
  const job = startCodexResumeJob({
    session: sessionFixture('pty-binary'),
    prompt: 'run PTY binary selection check',
    mode: 'pty',
  });
  startedJobIds.push(job.id);

  try {
    assert.equal(job.mode, 'pty');
    const startedEvent = listCodexJobEvents(job.id).find((event) => event.type === 'started');
    assert.match(
      JSON.stringify(startedEvent?.data ?? {}),
      new RegExp(fakeCodexBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    await waitForJob(job.id, (item) => item.status === 'running' || item.status === 'completed');
  } finally {
    const current = getCodexResumeJob(job.id);
    if (current?.status === 'running') stopCodexResumeJob(job.id);
    delete process.env.FAKE_CODEX_SCENARIO;
  }
});

test('fake Codex worker with no output is stopped by supervisor', async () => {
  const job = startFakeJob('stuck', {
    supervisor: { enabled: true, autoStop: true, idleTimeoutMs: 10 },
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const result = superviseCodexResumeJob({ id: job.id, staleOutputMs: 10, autoStop: true });
  assert.equal(result?.decision, 'stop');

  const stopped = await waitForJob(job.id, (item) => item.status === 'stopped');
  assert.match(stopped.error ?? '', /Supervisor stopped job/);
});

test('fake Codex worker auth failure is classified as failed', async () => {
  const job = startFakeJob('auth-failed', { supervisor: true });
  const failed = await waitForJob(job.id, (item) => item.status === 'failed');
  const result = superviseCodexResumeJob({ id: job.id });

  assert.equal(failed.exitCode, 1);
  assert.match(failed.outputTail, /Authentication failed/);
  assert.equal(result?.decision, 'failed');
});

test('fake Codex worker waiting for confirmation needs guidance', async () => {
  const job = startFakeJob('waiting-confirmation', { supervisor: true });
  const running = await waitForJob(job.id, (item) => item.status === 'running' && /Press enter/.test(item.outputTail));
  const result = superviseCodexResumeJob({ id: running.id });

  assert.equal(result?.decision, 'needs_guidance');
  assert.match(result?.reason ?? '', /等待确认|确认|指令/);
  stopCodexResumeJob(job.id);
});

test('fake Codex worker structured report is parsed on completion', async () => {
  const job = startFakeJob('structured-report');
  const completed = await waitForJob(job.id, (item) => item.status === 'completed' && item.structuredReport !== null);

  assert.equal(completed.structuredReport?.status, 'completed');
  assert.deepEqual(completed.structuredReport?.changedFiles, ['server/codex-jobs.ts', 'tests/codex-worker.e2e.test.ts']);
  assert.deepEqual(completed.structuredReport?.tests, ['npm run test:codex-worker']);
  assert.equal(completed.structuredReport?.nextAction, 'none');
  assert.ok(listCodexJobEvents(job.id).some((event) => event.type === 'structured_report'));
});

test('fake Codex worker ignores prompt report template and preserves stopped status', async () => {
  const job = startFakeJob('stuck', {
    prompt: [
      'Do real work.',
      'STATUS: completed | failed | blocked | needs_review',
      'CHANGED_FILES: 用逗号分隔改动文件；没有则写 none',
      'TESTS: 用逗号分隔已运行验证；没有则写 not run + 原因',
      'NEXT_ACTION: 下一步建议；没有则写 none',
    ].join('\n'),
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stopCodexResumeJob(job.id);
  const stopped = await waitForJob(job.id, (item) => item.status === 'stopped');

  assert.equal(stopped.structuredReport, null);
  assert.equal(stopped.error, 'Job stopped by request');
});

test('fake Codex worker is policy-stopped on deploy-like output', async () => {
  const job = startFakeJob('policy-stop', {
    policy: { allowDeploy: false, autoStop: true },
  });
  const stopped = await waitForJob(job.id, (item) => item.status === 'stopped');

  assert.match(stopped.error ?? '', /Policy guard stopped/);
  assert.ok(stopped.policyState.violations.some((violation) => violation.pattern === 'git push'));
  assert.ok(listCodexJobEvents(job.id).some((event) => event.type === 'policy'));
});
