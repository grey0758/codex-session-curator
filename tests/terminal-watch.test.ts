import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { recoveryDecision, TerminalWatch } from '../server/terminal-watch.js';
import type { CodexSession } from '../server/types.js';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const execFileAsync = promisify(execFile);
const session = {
  id: '01a12f2f-c546-7302-9f5c-3458c3ac7cdd', agent: 'codex', machineId: 'cnal002',
  filePath: '/home/grey/.codex/sessions/example.jsonl',
} as CodexSession;

function observation(overrides: Record<string, unknown> = {}) {
  return {
    pane: true, status: 'running', goalStatus: 'active', taskStartedAt: ago(15 * 60_000),
    taskCompleteAt: ago(20 * 60_000), lastActivityAt: ago(10 * 60_000),
    upstreamError: true, promptVisible: true, ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return { attempts: 0, pendingAt: null, suspectedAt: ago(2 * 60_000), ...overrides } as Parameters<typeof recoveryDecision>[0];
}

test('recovery gates require an idle prompt, an unfinished task, and a confirmed upstream error', () => {
  const now = Date.now();
  assert.equal(recoveryDecision(state(), observation(), now), 'health');
  assert.equal(recoveryDecision(state(), observation({ status: 'manual-paused' }), now), 'skip');
  assert.equal(recoveryDecision(state(), observation({ upstreamError: false }), now), 'skip');
  assert.equal(recoveryDecision(state(), observation({ promptVisible: false }), now), 'skip');
  assert.equal(recoveryDecision(state(), observation({ lastActivityAt: ago(30_000) }), now), 'skip');
  assert.equal(recoveryDecision(state(), observation({ taskCompleteAt: ago(2_000) }), now), 'skip');
  assert.equal(recoveryDecision(state(), observation({ status: 'idle', taskCompleteAt: ago(2_000), failedComplete: true }), now), 'health');
  assert.equal(recoveryDecision(state(), observation({ status: 'idle', taskCompleteAt: ago(2_000), failedComplete: true, upstreamError: false }), now), 'skip');
  assert.equal(recoveryDecision(state(), observation({ status: 'manual-paused', taskCompleteAt: ago(2_000), failedComplete: true }), now), 'skip');
  assert.equal(recoveryDecision(state({ suspectedAt: null }), observation(), now), 'confirm');
  assert.equal(recoveryDecision(state({ attempts: 3 }), observation(), now), 'blocked');
  assert.equal(recoveryDecision(state({ pendingAt: ago(30_000) }), observation(), now), 'skip');
});

test('watch sends Goal resume only after confirmation and a healthy request channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-watch-'));
  const calls: Array<{ mode: string; args?: string[] }> = [];
  const watcher = new TerminalWatch(join(dir, 'state.json'), async (_session, mode, args) => {
    calls.push({ mode, args });
    if (mode === 'inspect') return observation();
    if (mode === 'health') return { healthy: true, reason: 'ok' };
    return { sent: true, reason: 'ok' };
  });
  try {
    await watcher.watch(session);
    for (let i = 0; i < 50 && watcher.get(session)?.status !== 'suspected-upstream-error'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(watcher.get(session)?.status, 'suspected-upstream-error');
    assert.deepEqual(calls.map((call) => call.mode), ['inspect']);
    const record = (watcher as unknown as { records: Map<string, { suspectedAt: string }> }).records.values().next().value!;
    record.suspectedAt = ago(2 * 60_000);
    await watcher.scan();
    assert.equal(watcher.get(session)?.status, 'recovering');
    assert.equal(watcher.get(session)?.attempts, 1);
    assert.deepEqual(calls.map((call) => call.mode), ['inspect', 'inspect', 'health', 'send']);
    assert.equal(calls.at(-1)?.args?.[1], '/goal resume');
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('unhealthy provider never receives a recovery instruction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-watch-'));
  const calls: string[] = [];
  const watcher = new TerminalWatch(join(dir, 'state.json'), async (_session, mode) => {
    calls.push(mode);
    return mode === 'inspect' ? observation({ goalStatus: null }) : { healthy: false, reason: 'upstream-http-429' };
  });
  try {
    await watcher.watch(session);
    for (let i = 0; i < 50 && watcher.get(session)?.status !== 'suspected-upstream-error'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const record = (watcher as unknown as { records: Map<string, { suspectedAt: string }> }).records.values().next().value!;
    record.suspectedAt = ago(2 * 60_000);
    await watcher.scan();
    assert.equal(watcher.get(session)?.status, 'upstream-unhealthy');
    assert.equal(watcher.get(session)?.attempts, 0);
    assert.deepEqual(calls, ['inspect', 'inspect', 'health']);
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a task completed by an upstream failure receives continue when the channel recovers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-watch-'));
  const calls: Array<{ mode: string; args?: string[] }> = [];
  const watcher = new TerminalWatch(join(dir, 'state.json'), async (_session, mode, args) => {
    calls.push({ mode, args });
    if (mode === 'inspect') return observation({
      status: 'idle', goalStatus: null, taskCompleteAt: ago(5 * 60_000), failedComplete: true,
    });
    if (mode === 'health') return { healthy: true, reason: 'ok' };
    return { sent: true, reason: 'ok' };
  });
  try {
    await watcher.watch(session);
    const record = (watcher as unknown as { records: Map<string, { suspectedAt: string }> }).records.values().next().value!;
    record.suspectedAt = ago(2 * 60_000);
    await watcher.scan();
    assert.equal(watcher.get(session)?.status, 'recovering');
    assert.equal(watcher.get(session)?.attempts, 1);
    assert.deepEqual(calls.map((call) => call.mode), ['inspect', 'inspect', 'health', 'send']);
    assert.equal(calls.at(-1)?.args?.[1], '继续');
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('regular tasks use continue and three failed recoveries wait for a new user turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-watch-'));
  const sent: string[] = [];
  let newUserAt = ago(20 * 60_000);
  const watcher = new TerminalWatch(join(dir, 'state.json'), async (_session, mode, args) => {
    if (mode === 'inspect') return observation({ goalStatus: null, lastUserAt: newUserAt });
    if (mode === 'health') return { healthy: true, reason: 'ok' };
    sent.push(args?.[1] ?? '');
    return { sent: true, reason: 'ok' };
  });
  try {
    await watcher.watch(session);
    const record = (watcher as unknown as { records: Map<string, { attempts: number; suspectedAt: string; pendingAt: string | null }> }).records.values().next().value!;
    record.suspectedAt = ago(2 * 60_000);
    await watcher.scan();
    assert.deepEqual(sent, ['继续']);
    record.attempts = 3;
    record.pendingAt = ago(4 * 60_000);
    await watcher.scan();
    assert.equal(watcher.get(session)?.status, 'waiting-for-user');
    assert.equal(watcher.get(session)?.attempts, 3);
    assert.deepEqual(sent, ['继续']);
    newUserAt = new Date(Date.now() + 1000).toISOString();
    await watcher.scan();
    assert.equal(watcher.get(session)?.attempts, 0);
    assert.equal(watcher.get(session)?.status, 'suspected-upstream-error');
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an accepted recovery is not sent again while the old error remains on screen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-watch-'));
  let sent = 0;
  let recovered = false;
  let recoveredTaskStartedAt = '';
  const watcher = new TerminalWatch(join(dir, 'state.json'), async (_session, mode) => {
    if (mode === 'inspect') return observation(recovered ? {
      taskStartedAt: recoveredTaskStartedAt, lastActivityAt: ago(60_000),
    } : {});
    if (mode === 'health') return { healthy: true, reason: 'ok' };
    sent += 1;
    return { sent: true, reason: 'ok' };
  });
  try {
    await watcher.watch(session);
    const record = (watcher as unknown as { records: Map<string, { suspectedAt: string; pendingAt: string | null }> }).records.values().next().value!;
    record.suspectedAt = ago(2 * 60_000);
    await watcher.scan();
    assert.equal(sent, 1);
    record.pendingAt = ago(4 * 60_000);
    recoveredTaskStartedAt = new Date(Date.parse(record.pendingAt) - 8).toISOString();
    recovered = true;
    await watcher.scan();
    assert.equal(watcher.get(session)?.status, 'recovered');
    await watcher.scan();
    assert.equal(sent, 1);
    assert.equal(watcher.get(session)?.status, 'running');
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('standby deployment slot does not register or recover sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-watch-'));
  let leader = false;
  let inspected = 0;
  const watcher = new TerminalWatch(join(dir, 'state.json'), async () => {
    inspected += 1;
    return observation();
  }, () => leader);
  try {
    await watcher.watch(session);
    await watcher.scan();
    assert.equal(watcher.get(session), null);
    assert.equal(inspected, 0);
    leader = true;
    await watcher.watch(session);
    assert.equal(watcher.get(session)?.status, 'suspected-upstream-error');
    assert.equal(inspected, 1);
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('real probe distinguishes a manual interruption from an upstream failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curator-terminal-probe-'));
  const binaryDir = join(dir, 'bin');
  const filePath = join(dir, `rollout-${session.id}.jsonl`);
  await mkdir(binaryDir);
  await writeFile(join(binaryDir, 'tmux'), '#!/bin/sh\nif [ "$3" = display-message ]; then printf "node|0\\n"; elif [ "$3" = capture-pane ]; then printf "%s\\n" "$CURATOR_WATCH_TEST_PANE"; else exit 1; fi\n');
  await chmod(join(binaryDir, 'tmux'), 0o700);
  const started = ago(10 * 60_000);
  const aborted = ago(9 * 60_000);
  const event = (type: string, timestamp: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'event_msg', timestamp, payload: { type, ...extra } });
  const inspect = async (pane: string) => {
    const { stdout } = await execFileAsync('python3', [join(process.cwd(), 'server/terminal-watch-probe.py'), 'inspect', session.id, filePath], {
      env: { ...process.env, PATH: `${binaryDir}:${process.env.PATH}`, CURATOR_WATCH_TEST_PANE: pane },
    });
    return JSON.parse(stdout) as { status: string; upstreamError: boolean; promptVisible: boolean; goalStatus: string; failedComplete: boolean };
  };
  try {
    await writeFile(filePath, [
      event('task_started', started),
      event('thread_goal_updated', started, { goal: { status: 'active' } }),
      event('turn_aborted', aborted),
    ].join('\n'));
    const manual = await inspect('■ Conversation interrupted - use /feedback if something went wrong\n› ');
    assert.equal(manual.status, 'manual-paused');
    assert.equal(recoveryDecision(state(), { ...manual, pane: true }, Date.now()), 'skip');

    await writeFile(filePath, [
      event('task_started', started),
      event('thread_goal_updated', started, { goal: { status: 'active' } }),
      event('item_completed', ago(8 * 60_000)),
    ].join('\n'));
    const upstream = await inspect('■ stream disconnected before completion\n› ');
    assert.equal(upstream.status, 'running');
    assert.equal(upstream.goalStatus, 'active');
    assert.equal(upstream.upstreamError, true);
    assert.equal(upstream.promptVisible, true);

    await writeFile(filePath, [
      event('task_started', started),
      event('item_completed', ago(8 * 60_000), { item: { type: 'CommandExecution', status: 'completed' } }),
      event('task_complete', ago(4 * 60_000)),
    ].join('\n'));
    const failedComplete = await inspect('■ HTTP 503 Service Unavailable\n› ');
    assert.equal(failedComplete.status, 'idle');
    assert.equal(failedComplete.failedComplete, true);
    assert.equal(recoveryDecision(state(), { ...failedComplete, pane: true, taskStartedAt: started, lastActivityAt: ago(8 * 60_000), taskCompleteAt: ago(4 * 60_000) }, Date.now()), 'health');

    await writeFile(filePath, [
      event('task_started', started),
      event('item_completed', ago(5 * 60_000), { item: { type: 'AgentMessage', phase: 'final_answer' } }),
      event('task_complete', ago(4 * 60_000)),
    ].join('\n'));
    const successful = await inspect('■ HTTP 503 Service Unavailable\n› ');
    assert.equal(successful.failedComplete, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
