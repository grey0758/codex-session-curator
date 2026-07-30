import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  classifyInjectedUserContext,
  parseRecentUserMessages,
  parseSessionHistory,
  parseSessionFile,
  readCodexSessionLineage,
} from '../server/session-parser.js';

test('Codex lineage remains undetermined until the first metadata record is complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-codex-lineage-'));
  const sessionPath = join(root, 'sessions', 'late-primary.jsonl');
  try {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, '', 'utf8');
    assert.equal(await readCodexSessionLineage(sessionPath), null);

    await writeFile(sessionPath, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'late-primary',
        cwd: '/tmp/project',
        thread_source: 'user',
      },
    })}\n`, 'utf8');
    assert.deepEqual(await readCodexSessionLineage(sessionPath), {
      isSubagent: false,
      parentThreadId: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex subagent rollouts keep their own identity when parent metadata is embedded later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-codex-parser-'));
  const childId = '019f88b0-7eaa-7ab3-8eda-1e012d0325c8';
  const parentId = '019f8878-e6c1-7ae3-b2ab-803e575daad3';
  const sessionPath = join(
    root,
    'sessions',
    `rollout-2026-07-22T00-18-15-${childId}.jsonl`,
  );

  try {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-22T07:18:15.978Z',
        payload: {
          id: childId,
          cwd: '/tmp/child-project',
          timestamp: '2026-07-22T07:18:15.978Z',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentId,
                depth: 1,
                agent_path: '/root/example',
              },
            },
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-22T07:18:16.000Z',
        payload: { role: 'user', content: 'CHILD_USER' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-22T07:18:17.000Z',
        payload: { role: 'assistant', content: 'CHILD_ASSISTANT' },
      }),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-22T06:17:32.609Z',
        payload: {
          id: parentId,
          cwd: '/tmp/parent-project',
          timestamp: '2026-07-22T06:17:32.609Z',
          source: 'cli',
        },
      }),
    ].join('\n') + '\n', 'utf8');

    const parsed = await parseSessionFile(sessionPath);
    assert.equal(parsed.source, 'codex');
    assert.equal(parsed.id, childId);
    assert.equal(parsed.cwd, '/tmp/child-project');
    assert.equal(parsed.startedAt, '2026-07-22T07:18:15.978Z');
    assert.equal(parsed.updatedAt, '2026-07-22T07:18:17.000Z');
    assert.equal(parsed.userTurns, 1);
    assert.equal(parsed.assistantTurns, 1);
    assert.equal(parsed.isSubagent, true);
    assert.equal(parsed.parentThreadId, parentId);
    assert.deepEqual(await readCodexSessionLineage(sessionPath), {
      isSubagent: true,
      parentThreadId: parentId,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recent conversation keeps user text verbatim and folds complete injected blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-codex-recent-'));
  const sessionId = '019fb123-7524-71f1-97de-cd7b384adfe9';
  const sessionPath = join(root, 'sessions', `rollout-2026-07-30T00-00-00-${sessionId}.jsonl`);
  const agentsContext = [
    '# AGENTS.md instructions for /tmp/project',
    '<INSTRUCTIONS>',
    'Use the project rules.',
    '</INSTRUCTIONS>',
  ].join('\n');
  const skillContext = '<skill>\n<name>example-skill</name>\nSkill body\n</skill>';
  const environmentContext = '<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>';
  const agentsAndEnvironmentContext = `${agentsContext}\n\n${environmentContext}`;
  const quotedUserText = [
    'Keep this exact spacing.',
    '',
    'The literal <environment_context> marker and "This sub-agent is controlled by its parent" are user text.',
  ].join('\n');
  const inlineEnvironmentUserText =
    `Before the injected block.${environmentContext}After the injected block.`;
  const inlineEnvironmentVisibleText = [
    'Before the injected block.',
    'After the injected block.',
  ].join('\n');
  const quotedAgentsText = `${agentsContext}\n\nPlease treat the block above as quoted user text.`;

  try {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-30T07:00:00.000Z',
        payload: {
          id: sessionId,
          cwd: '/tmp/project',
          timestamp: '2026-07-30T07:00:00.000Z',
          source: 'cli',
          thread_source: 'user',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:01.000Z',
        payload: { role: 'user', content: agentsContext },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:02.000Z',
        payload: { role: 'user', content: skillContext },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:03.000Z',
        payload: { role: 'user', content: environmentContext },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:04.000Z',
        payload: { role: 'user', content: quotedUserText },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:05.000Z',
        payload: { role: 'assistant', content: 'Assistant reply' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:06.000Z',
        payload: { role: 'user', content: environmentContext },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:07.000Z',
        payload: { role: 'user', content: 'continue\non the next line' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-30T07:00:08.000Z',
        payload: { role: 'user', content: inlineEnvironmentUserText },
      }),
    ].join('\n') + '\n', 'utf8');

    assert.equal(classifyInjectedUserContext(quotedUserText), null);
    assert.equal(classifyInjectedUserContext(quotedAgentsText), null);
    assert.equal(
      classifyInjectedUserContext(agentsAndEnvironmentContext)?.kind,
      'agents_instructions',
    );
    const recent = await parseRecentUserMessages({ filePath: sessionPath, limit: 4 });
    assert.equal(recent.totalUserMessages, 3);
    assert.equal(recent.hiddenContextMessages, 4);
    assert.equal(recent.messages.length, 3);
    assert.equal(recent.messages[0].text, quotedUserText);
    assert.deepEqual(
      recent.messages[0].precedingContext?.map((item) => item.kind),
      ['agents_instructions', 'skill', 'environment_context'],
    );
    assert.equal(recent.messages[1].text, 'continue\non the next line');
    assert.deepEqual(
      recent.messages[1].precedingContext?.map((item) => item.kind),
      ['environment_context'],
    );
    assert.equal(recent.messages[2].text, inlineEnvironmentVisibleText);
    assert.deepEqual(
      recent.messages[2].precedingContext?.map((item) => item.kind),
      ['environment_context'],
    );
    assert.equal(recent.messages[2].precedingContext?.[0].text, environmentContext);
    const history = await parseSessionHistory({ filePath: sessionPath, limit: 20 });
    assert.equal(history.messages.at(-1)?.text, 'Before the injected block. After the injected block.');
    assert.deepEqual(
      history.messages.at(-1)?.precedingContext?.map((item) => item.kind),
      ['environment_context'],
    );
    assert.deepEqual(await readCodexSessionLineage(sessionPath), {
      isSubagent: false,
      parentThreadId: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
