import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Evaluation, ParsedMessage, Recommendation, RemoteMachine } from './types.js';

interface Metrics {
  totalChars: number;
  codeSignals: number;
  projectSignals: number;
  oneShotSignals: number;
  hasImplementationAsk: boolean;
}

interface WorkflowState {
  messages: ParsedMessage[];
  userTurns: number;
  assistantTurns: number;
  cwd: string | null;
  metrics?: Metrics;
  title?: string;
  summary?: string;
  detailedSummary?: string;
  recommendation?: Recommendation;
  score?: number;
  reasons?: string[];
  actualWorkdirs?: string[];
  cwdMatchesWorkdir?: boolean | null;
  recommendedWorkdir?: string | null;
  remoteMachines?: RemoteMachine[];
}

interface LlmEvaluation {
  title: string;
  summary: string;
  detailedSummary: string;
  reasons: string[];
  actualWorkdirs: string[];
  recommendedWorkdir: string | null;
  remoteMachines: RemoteMachine[];
}

export const EVALUATOR_WORKFLOW = 'langgraph:measure->decide->gpt-5.4-cn-summary:v5';

const WorkflowAnnotation = Annotation.Root({
  messages: Annotation<ParsedMessage[]>(),
  userTurns: Annotation<number>(),
  assistantTurns: Annotation<number>(),
  cwd: Annotation<string | null>(),
  metrics: Annotation<Metrics | undefined>(),
  title: Annotation<string | undefined>(),
  summary: Annotation<string | undefined>(),
  detailedSummary: Annotation<string | undefined>(),
  recommendation: Annotation<Recommendation | undefined>(),
  score: Annotation<number | undefined>(),
  reasons: Annotation<string[] | undefined>(),
  actualWorkdirs: Annotation<string[] | undefined>(),
  cwdMatchesWorkdir: Annotation<boolean | null | undefined>(),
  recommendedWorkdir: Annotation<string | null | undefined>(),
  remoteMachines: Annotation<RemoteMachine[] | undefined>(),
});

const CODE_TERMS = [
  'implement',
  'fix',
  'debug',
  'build',
  'deploy',
  'test',
  'api',
  'server',
  'frontend',
  'backend',
  'database',
  'docker',
  'git',
  'npm',
  'typescript',
  'python',
  '项目',
  '开发',
  '实现',
  '修复',
  '部署',
  '接口',
  '代码',
  '前端',
  '后端',
  '数据库',
  '测试',
  '报错',
];

const ONE_SHOT_TERMS = [
  'hello',
  'hi',
  'thanks',
  'thank you',
  '谢谢',
  '你好',
  '在吗',
  '是什么',
  '怎么用',
];

function countSignals(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((count, term) => count + (lower.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function cleanSnippet(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().replace(/[),.;，。；、]+$/g, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function extractWorkdirs(messages: ParsedMessage[], cwd: string | null): string[] {
  const text = messages.map((message) => message.text).join('\n');
  const pathMatches = [
    ...text.matchAll(/(?:^|[\s"'`：:])((?:\/home|\/work|\/mnt|\/data|\/opt|\/var|\/srv|\/tmp)\/[^\s"'`，。；;<>)]{2,})/g),
  ].map((match) => match[1]);
  const projectMatches = [
    ...text.matchAll(
      /(?:项目|工作目录|目录|仓库|repo|workspace|cwd|source|deployed app|部署目录)[^\n]{0,28}((?:\/home|\/work|\/mnt|\/data|\/opt|\/var|\/srv|\/tmp)\/[^\s"'`，。；;<>)]{2,})/gi
    ),
  ].map((match) => match[1]);

  const candidates = uniqueValues([...projectMatches, ...pathMatches]);
  if (cwd && candidates.length === 0) return [cwd];
  return candidates.slice(0, 8);
}

function extractRemoteMachines(messages: ParsedMessage[]): RemoteMachine[] {
  const text = messages.map((message) => message.text).join('\n');
  const machines: RemoteMachine[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/\bssh\s+([a-z_][\w.-]*@)?([a-zA-Z0-9][\w.-]*)(?:\s|-p|\n|$)/g)) {
    const user = match[1]?.replace('@', '') ?? null;
    const host = match[2] ?? null;
    if (!host) continue;
    const ip = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : null;
    const key = `${user ?? ''}@${host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    machines.push({
      label: host,
      host,
      ip,
      user,
      evidence: cleanSnippet(match[0]),
    });
  }

  for (const match of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9-]{2,}\d{2,})\b/g)) {
    const label = match[1];
    if (!/(hongkong|hk|server|node|cloud|prod|dev|test|staging)/i.test(label)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    machines.push({ label, host: label, ip: null, user: null, evidence: label });
  }

  for (const match of text.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) {
    const ip = match[1];
    if (seen.has(ip)) continue;
    seen.add(ip);
    machines.push({ label: ip, host: ip, ip, user: null, evidence: ip });
  }

  return machines.slice(0, 8);
}

function compareWorkdir(cwd: string | null, workdirs: string[]): boolean | null {
  if (!cwd || workdirs.length === 0) return null;
  const normalizedCwd = cwd.replace(/\/+$/, '');
  return workdirs.some((dir) => {
    const normalizedDir = dir.replace(/\/+$/, '');
    return normalizedDir === normalizedCwd || normalizedDir.startsWith(`${normalizedCwd}/`) || normalizedCwd.startsWith(`${normalizedDir}/`);
  });
}

function summarize(messages: ParsedMessage[], cwd: string | null): string {
  const users = messages.filter((message) => message.role === 'user');
  const first = users[0]?.text ?? messages[0]?.text ?? '';
  const last = users.at(-1)?.text ?? first;
  const base = first === last ? cleanSnippet(first) : `${cleanSnippet(first)} / ${cleanSnippet(last)}`;
  if (!base) return cwd ? `Codex session in ${cwd}` : 'Short Codex session with no durable task.';
  return base.length > 180 ? `${base.slice(0, 177)}...` : base;
}

function fallbackTitle(summary: string, cwd: string | null): string {
  const clean = cleanSnippet(summary);
  if (clean) return clean.slice(0, 42);
  if (cwd) return cwd.split('/').filter(Boolean).at(-1) ?? cwd;
  return '未命名会话';
}

function fallbackDetailedSummary(messages: ParsedMessage[], cwd: string | null): string {
  const users = messages.filter((message) => message.role === 'user').map((message) => cleanSnippet(message.text));
  const parts = users.filter(Boolean).slice(0, 4);
  if (parts.length) return `这段会话主要围绕：${parts.join('；')}。`;
  return cwd ? `这段会话发生在 ${cwd}，没有足够的对话内容生成更细摘要。` : '这段会话内容较少，没有足够信息生成更细摘要。';
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-REDACTED')
    .replace(/ops_[A-Za-z0-9_-]{24,}/g, 'ops_REDACTED')
    .replace(/eyJ[A-Za-z0-9_-]{40,}/g, 'JWT_REDACTED')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=REDACTED');
}

function transcriptForLlm(messages: ParsedMessage[]): string {
  const usefulMessages = messages.filter((message) => message.text.trim());
  const selected = new Map<number, ParsedMessage>();
  const addRange = (start: number, end: number) => {
    for (let index = Math.max(0, start); index < Math.min(usefulMessages.length, end); index += 1) {
      selected.set(index, usefulMessages[index]);
    }
  };

  addRange(0, 8);
  addRange(usefulMessages.length - 18, usefulMessages.length);
  const middleBudget = 22;
  if (usefulMessages.length > 26) {
    const start = 8;
    const end = usefulMessages.length - 18;
    const span = Math.max(1, end - start);
    for (let offset = 0; offset < Math.min(middleBudget, span); offset += 1) {
      const index = start + Math.floor((offset * span) / Math.min(middleBudget, span));
      selected.set(index, usefulMessages[index]);
    }
  }

  const useful = [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, message]) => {
      const timestamp = message.timestamp ? ` ${message.timestamp}` : '';
      return `#${index + 1}${timestamp} ${message.role === 'user' ? '用户' : '助手'}: ${redactSecrets(message.text).slice(0, 760)}`;
    });

  const text = useful.join('\n\n');
  return text.length > 12000 ? `${text.slice(0, 12000)}\n\n[已按整段会话抽样截断]` : text;
}

function parseJsonObject(text: string): LlmEvaluation | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fenced?.[1] ?? trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<LlmEvaluation>;
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.reasons)) return null;
    const reasons = parsed.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 5);
    const actualWorkdirs = Array.isArray(parsed.actualWorkdirs)
      ? parsed.actualWorkdirs.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];
    const remoteMachines = Array.isArray(parsed.remoteMachines)
      ? parsed.remoteMachines
          .filter((item): item is RemoteMachine => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            label: typeof item.label === 'string' ? item.label.slice(0, 80) : null,
            host: typeof item.host === 'string' ? item.host.slice(0, 120) : null,
            ip: typeof item.ip === 'string' ? item.ip.slice(0, 80) : null,
            user: typeof item.user === 'string' ? item.user.slice(0, 80) : null,
            evidence: typeof item.evidence === 'string' ? item.evidence.slice(0, 160) : '',
          }))
          .slice(0, 8)
      : [];
    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 80) : fallbackTitle(parsed.summary, null),
      summary: parsed.summary.trim().slice(0, 220),
      detailedSummary:
        typeof parsed.detailedSummary === 'string'
          ? parsed.detailedSummary.trim().slice(0, 900)
          : parsed.summary.trim().slice(0, 220),
      reasons: reasons.length ? reasons : ['GPT-5.4 已根据对话内容生成中文摘要'],
      actualWorkdirs,
      recommendedWorkdir: typeof parsed.recommendedWorkdir === 'string' ? parsed.recommendedWorkdir.slice(0, 240) : null,
      remoteMachines,
    };
  } catch {
    return null;
  }
}

async function callLlm(state: WorkflowState): Promise<LlmEvaluation | null> {
  const apiKey = process.env.CURATOR_LLM_API_KEY || process.env.API_KEY;
  const model = process.env.CURATOR_LLM_MODEL || process.env.MODEL || 'gpt-5.4';
  const baseUrl = (process.env.CURATOR_LLM_BASE_URL || process.env.BASE_URL || 'https://api.opencodex.uk/v1').replace(
    /\/$/,
    ''
  );
  if (!apiKey) return null;

  const transcript = transcriptForLlm(state.messages);
  if (!transcript.trim()) return null;

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是一个代码会话整理器。请用简体中文总结 Codex 对话，重点说明这次大概做了什么、涉及哪个项目或机器、是否值得保留。不要输出原始密钥、token 或长段原文。',
      },
      {
        role: 'user',
        content: [
          `工作目录：${state.cwd ?? '未知'}`,
          `用户回合：${state.userTurns}`,
          `助手回合：${state.assistantTurns}`,
          `推荐结果：${state.recommendation ?? 'review'}`,
          `规则依据：${(state.reasons ?? []).join('；')}`,
          `规则提取工作目录：${(state.actualWorkdirs ?? []).join('；') || '无'}`,
          `规则提取远程机器：${(state.remoteMachines ?? [])
            .map((machine) => machine.label ?? machine.host ?? machine.ip)
            .filter(Boolean)
            .join('；') || '无'}`,
          '',
          '请只返回 JSON：',
          '{"title":"短标题，12到28字，适合作为保留面板标题","summary":"一小段中文，概括整段会话主要做了什么，不要只总结最后一次消息，120字以内","detailedSummary":"更细致说明整段会话做了什么、修改/部署/验证了什么、遗留了什么，180到350字，不泄露密钥","reasons":["中文依据1","中文依据2"],"actualWorkdirs":["/实际工作目录"],"recommendedWorkdir":"/建议迁移或继续工作的目录，没有则为null","remoteMachines":[{"label":"机器名","host":"主机名或域名","ip":"IP或null","user":"SSH用户或null","evidence":"简短依据"}]}',
          '',
          '下面是从整段会话开头、中间和结尾抽取的摘录，请综合判断：',
          transcript,
        ].join('\n'),
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 500,
  };

  let response: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.ok) break;
    if (attempt < 3 && response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 900));
      continue;
    }
    throw new Error(`LLM request failed: ${response.status}`);
  }

  if (!response?.ok) throw new Error('LLM request failed without response');
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  return content ? parseJsonObject(content) : null;
}

function measureNode(state: WorkflowState): Partial<WorkflowState> {
  const text = state.messages.map((message) => message.text).join('\n');
  const userText = state.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
    .join('\n');

  const codeSignals = countSignals(text, CODE_TERMS);
  const projectSignals = countSignals(userText, ['项目', 'repo', 'repository', 'workspace', 'codebase', '服务端', '客户端']);
  const oneShotSignals = countSignals(userText, ONE_SHOT_TERMS);
  const hasImplementationAsk = /(?:帮我|please|can you|实现|修复|部署|创建|build|fix|implement|deploy)/i.test(userText);

  const actualWorkdirs = extractWorkdirs(state.messages, state.cwd);
  const remoteMachines = extractRemoteMachines(state.messages);
  const cwdMatchesWorkdir = compareWorkdir(state.cwd, actualWorkdirs);
  return {
    metrics: {
      totalChars: text.length,
      codeSignals,
      projectSignals,
      oneShotSignals,
      hasImplementationAsk,
    },
    actualWorkdirs,
    cwdMatchesWorkdir,
    recommendedWorkdir: cwdMatchesWorkdir === false ? actualWorkdirs[0] ?? null : null,
    remoteMachines,
  };
}

function decisionNode(state: WorkflowState): Partial<WorkflowState> {
  const metrics = state.metrics ?? {
    totalChars: 0,
    codeSignals: 0,
    projectSignals: 0,
    oneShotSignals: 0,
    hasImplementationAsk: false,
  };

  let score = 0;
  const reasons: string[] = [];

  if (state.userTurns >= 5) {
    score += 2;
    reasons.push('多轮对话，说明不是一次性问题');
  }
  if (metrics.totalChars >= 1200) {
    score += 2;
    reasons.push('对话内容较完整，后续可能需要回看');
  }
  if (metrics.codeSignals >= 3) {
    score += 3;
    reasons.push('包含项目开发、代码或部署相关信号');
  }
  if (metrics.projectSignals > 0) {
    score += 2;
    reasons.push('提到了项目路径、仓库或机器环境');
  }
  if (metrics.hasImplementationAsk) {
    score += 1;
    reasons.push('用户请求了实现、修复或运维操作');
  }
  if (state.userTurns <= 4 && metrics.totalChars < 900 && metrics.projectSignals === 0) {
    score -= 1;
    reasons.push('已启用回收站，低信息量会话可更积极建议删除');
  }
  if (metrics.codeSignals <= 1 && metrics.projectSignals === 0 && !metrics.hasImplementationAsk) {
    score -= 1;
    reasons.push('缺少可迁移的项目上下文');
  }
  if (state.userTurns <= 2 && metrics.totalChars < 420) {
    score -= 3;
    reasons.push('对话较短，更像一次性交流');
  }
  if (metrics.oneShotSignals > 0 && metrics.codeSignals === 0) {
    score -= 2;
    reasons.push('缺少项目开发信号，可能不值得长期保留');
  }

  let recommendation: Recommendation = 'review';
  if (score >= 4) recommendation = 'keep';
  if (score <= 2) recommendation = 'delete';

  if (reasons.length === 0) reasons.push('有效信息不足，需要人工复核');

  return { recommendation, score, reasons };
}

async function llmSummaryNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  try {
    const llm = await callLlm(state);
    if (llm) {
      const actualWorkdirs = uniqueValues([...llm.actualWorkdirs, ...(state.actualWorkdirs ?? [])]).slice(0, 8);
      const remoteMachines = [...llm.remoteMachines, ...(state.remoteMachines ?? [])].slice(0, 8);
      const cwdMatchesWorkdir = compareWorkdir(state.cwd, actualWorkdirs);
      return {
        title: llm.title,
        summary: llm.summary,
        detailedSummary: llm.detailedSummary,
        reasons: llm.reasons,
        actualWorkdirs,
        cwdMatchesWorkdir,
        recommendedWorkdir: llm.recommendedWorkdir ?? (cwdMatchesWorkdir === false ? actualWorkdirs[0] ?? null : null),
        remoteMachines,
      };
    }
  } catch (error) {
    console.warn('[Evaluator] GPT summary failed:', error instanceof Error ? error.message : error);
  }

  const summary = summarize(state.messages, state.cwd);
  return {
    title: fallbackTitle(summary, state.cwd),
    summary,
    detailedSummary: fallbackDetailedSummary(state.messages, state.cwd),
  };
}

const evaluator = new StateGraph(WorkflowAnnotation)
  .addNode('measure', measureNode)
  .addNode('decide', decisionNode)
  .addNode('summarize', llmSummaryNode)
  .addEdge(START, 'measure')
  .addEdge('measure', 'decide')
  .addEdge('decide', 'summarize')
  .addEdge('summarize', END)
  .compile();

export async function evaluateSession(input: {
  messages: ParsedMessage[];
  userTurns: number;
  assistantTurns: number;
  cwd: string | null;
}): Promise<Evaluation> {
  const result = await evaluator.invoke(input);
  const summary = result.summary ?? 'No summary available.';
  return {
    title: result.title ?? fallbackTitle(summary, input.cwd),
    summary,
    detailedSummary: result.detailedSummary ?? fallbackDetailedSummary(input.messages, input.cwd),
    recommendation: result.recommendation ?? 'review',
    score: result.score ?? 0,
    reasons: result.reasons ?? ['工作流未返回评估依据'],
    actualWorkdirs: result.actualWorkdirs ?? [],
    cwdMatchesWorkdir: result.cwdMatchesWorkdir ?? null,
    recommendedWorkdir: result.recommendedWorkdir ?? null,
    remoteMachines: result.remoteMachines ?? [],
    evaluatedAt: new Date().toISOString(),
    workflow: EVALUATOR_WORKFLOW,
  };
}
