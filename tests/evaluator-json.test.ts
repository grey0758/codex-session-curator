import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonObject } from '../server/evaluator.js';

const valid = {
  title: '会话分析',
  summary: '完成了会话分析和验证。',
  detailedSummary: 'Hub 读取 transcript 后完成结构化分析。',
  reasons: ['结构完整'],
  actualWorkdirs: ['/work/project'],
  directoryIndex: ['project'],
  techStack: ['Curator'],
  keywords: ['audit'],
  recommendedWorkdir: '/work/project',
  remoteMachines: [],
};

test('evaluator JSON parser accepts fenced and reasoning-wrapped balanced objects', () => {
  const fenced = parseJsonObject(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
  assert.equal(fenced?.title, valid.title);

  const wrapped = parseJsonObject(`思考里有一个无效对象 {not-json}。最终结果：${JSON.stringify(valid)} 完成。`);
  assert.equal(wrapped?.summary, valid.summary);
});

test('evaluator JSON parser rejects truncated or schema-incomplete output', () => {
  assert.equal(parseJsonObject('{"summary":"truncated"'), null);
  assert.equal(parseJsonObject(JSON.stringify({ summary: 'missing reasons' })), null);
});
