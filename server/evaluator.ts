import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { recordAnalysisRun } from './analysis-log.js';
import { EVALUATOR_WORKFLOW } from './evaluation-workflow.js';
import type {
  Evaluation,
  EvaluationOrigin,
  ParsedMessage,
  Recommendation,
  RemoteMachine,
  ReviewPriority,
  UpdateCadence,
} from './types.js';

export { EVALUATOR_WORKFLOW, isEvaluationWorkflowCompatible, isEvaluationWorkflowComplete } from './evaluation-workflow.js';

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
  directoryIndex?: string[];
  techStack?: string[];
  keywords?: string[];
  searchText?: string;
  updateCadence?: UpdateCadence;
  reviewPriority?: ReviewPriority;
  reviewSignals?: string[];
  cwdMatchesWorkdir?: boolean | null;
  recommendedWorkdir?: string | null;
  remoteMachines?: RemoteMachine[];
  model?: string;
  status?: 'ok' | 'fallback' | 'failed';
  error?: string | null;
  sessionId?: string | null;
  machineId?: string | null;
  evaluatedByMachineId?: string | null;
  runId?: string | null;
  evaluationOrigin?: EvaluationOrigin;
  transcriptHash?: string | null;
}

interface LlmEvaluation {
  title: string;
  summary: string;
  detailedSummary: string;
  reasons: string[];
  actualWorkdirs: string[];
  directoryIndex?: string[];
  techStack?: string[];
  keywords?: string[];
  recommendedWorkdir: string | null;
  remoteMachines: RemoteMachine[];
  model?: string;
}

interface LlmEndpoint {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeys: string[];
  rpmLimit: number;
  stream: boolean;
  maxTokens: number;
  temperature: number;
  topP: number;
  thinking: boolean;
  responseFormat: boolean;
}

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
  directoryIndex: Annotation<string[] | undefined>(),
  techStack: Annotation<string[] | undefined>(),
  keywords: Annotation<string[] | undefined>(),
  searchText: Annotation<string | undefined>(),
  updateCadence: Annotation<UpdateCadence | undefined>(),
  reviewPriority: Annotation<ReviewPriority | undefined>(),
  reviewSignals: Annotation<string[] | undefined>(),
  cwdMatchesWorkdir: Annotation<boolean | null | undefined>(),
  recommendedWorkdir: Annotation<string | null | undefined>(),
  remoteMachines: Annotation<RemoteMachine[] | undefined>(),
  model: Annotation<string | undefined>(),
  status: Annotation<'ok' | 'fallback' | 'failed' | undefined>(),
  error: Annotation<string | null | undefined>(),
  sessionId: Annotation<string | null | undefined>(),
  machineId: Annotation<string | null | undefined>(),
  evaluatedByMachineId: Annotation<string | null | undefined>(),
  runId: Annotation<string | null | undefined>(),
  evaluationOrigin: Annotation<EvaluationOrigin | undefined>(),
  transcriptHash: Annotation<string | null | undefined>(),
});

function analysisTrace(state: WorkflowState) {
  return {
    sessionId: state.sessionId ?? null,
    machineId: state.machineId ?? null,
    runId: state.runId ?? null,
    source: state.evaluationOrigin === 'hub-remote' ? ('hub-remote' as const) : ('local' as const),
    transcriptHash: state.transcriptHash ?? null,
  };
}

export function getEvaluatorModel(): string {
  return getEvaluatorEndpoints()[0]?.model || 'minimaxai/minimax-m2.7';
}

export function getEvaluatorBaseUrl(): string {
  return getEvaluatorEndpoints()[0]?.baseUrl || 'https://integrate.api.nvidia.com/v1';
}

function providerForBaseUrl(baseUrl: string): string {
  if (baseUrl.includes('nvidia.com')) return 'nvidia';
  if (baseUrl.includes('opencodex')) return 'opencodex';
  return 'openai-compatible';
}

export function getEvaluatorProvider(): string {
  return getEvaluatorEndpoints()[0]?.provider || providerForBaseUrl(getEvaluatorBaseUrl());
}

export function getEvaluatorRpmLimit(): number {
  const raw = getEvaluatorEndpoints()[0]?.rpmLimit ?? Number(process.env.CURATOR_LLM_RPM || 40);
  if (!Number.isFinite(raw)) return 40;
  return Math.max(1, Math.min(120, Math.floor(raw)));
}

export function getRecommendedEvaluationConcurrency(): number {
  const raw = Number(process.env.CURATOR_EVALUATION_CONCURRENCY || 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(32, Math.floor(raw)));
}

let nextLlmRequestAt = 0;
const nextLlmRequestAtByKey = new Map<string, number>();
const nextApiKeyIndexByEndpoint = new Map<string, number>();

function parseApiKeys(raw: string): string[] {
  const keys = raw
    .split(',')
    .map((key) => key.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return [...new Set(keys)];
}

function readRpm(value: string | undefined, fallback: number): number {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(120, Math.floor(raw)));
}

function endpointFromEnv(prefix: string, defaults: Partial<LlmEndpoint> = {}): LlmEndpoint | null {
  const baseUrl = (process.env[`${prefix}_BASE_URL`] || (prefix === 'CURATOR_LLM' ? process.env.BASE_URL : '') || defaults.baseUrl || '')
    .replace(/\/$/, '');
  const model = process.env[`${prefix}_MODEL`] || (prefix === 'CURATOR_LLM' ? process.env.MODEL : '') || defaults.model || '';
  const rawKeys =
    process.env[`${prefix}_API_KEYS`] ||
    process.env[`${prefix}_API_KEY`] ||
    (prefix === 'CURATOR_LLM'
      ? process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY || process.env.API_KEY || ''
      : '');
  const apiKeys = parseApiKeys(rawKeys);
  if (!baseUrl || !model || apiKeys.length === 0) return null;
  const provider = providerForBaseUrl(baseUrl);
  return {
    provider,
    model,
    baseUrl,
    apiKeys,
    rpmLimit: readRpm(process.env[`${prefix}_RPM`], defaults.rpmLimit ?? 40),
    stream: provider === 'nvidia' && process.env[`${prefix}_STREAM`] !== '0',
    maxTokens: Number(process.env[`${prefix}_MAX_TOKENS`] || defaults.maxTokens || (provider === 'nvidia' ? 1536 : 500)),
    temperature: Number(process.env[`${prefix}_TEMPERATURE`] || defaults.temperature || (provider === 'nvidia' ? 1 : 0.2)),
    topP: Number(process.env[`${prefix}_TOP_P`] || defaults.topP || 1),
    thinking: process.env[`${prefix}_THINKING`] === '1',
    responseFormat: process.env[`${prefix}_RESPONSE_FORMAT`] !== '0',
  };
}

function endpointKey(endpoint: LlmEndpoint): string {
  return `${endpoint.provider}:${endpoint.baseUrl}:${endpoint.model}`;
}

export function getEvaluatorEndpoints(): LlmEndpoint[] {
  const primary =
    endpointFromEnv('CURATOR_LLM') ??
    endpointFromEnv('CURATOR_LLM', {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'minimaxai/minimax-m2.7',
      rpmLimit: 40,
    });
  const fallback = endpointFromEnv('CURATOR_LLM_FALLBACK', {
    rpmLimit: 20,
    maxTokens: 1536,
    temperature: 0.2,
  });
  const endpoints = [primary, fallback].filter((endpoint): endpoint is LlmEndpoint => Boolean(endpoint));
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = endpointKey(endpoint);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getLlmTimeoutMs(): number {
  const raw = Number(process.env.CURATOR_LLM_TIMEOUT_MS || 60_000);
  if (!Number.isFinite(raw)) return 60_000;
  return Math.max(10_000, Math.min(300_000, Math.floor(raw)));
}

function nextEvaluatorApiKey(endpoint: LlmEndpoint): string | null {
  if (!endpoint.apiKeys.length) return null;
  const key = endpointKey(endpoint);
  const index = nextApiKeyIndexByEndpoint.get(key) ?? 0;
  nextApiKeyIndexByEndpoint.set(key, index + 1);
  return endpoint.apiKeys[index % endpoint.apiKeys.length];
}

async function waitForLlmRateSlot(rpmLimit: number, apiKey?: string): Promise<void> {
  const intervalMs = Math.ceil(60_000 / Math.max(1, rpmLimit));
  const now = Date.now();
  const currentNext = apiKey ? (nextLlmRequestAtByKey.get(apiKey) ?? 0) : nextLlmRequestAt;
  const scheduledAt = Math.max(now, currentNext);
  if (apiKey) nextLlmRequestAtByKey.set(apiKey, scheduledAt + intervalMs);
  else nextLlmRequestAt = scheduledAt + intervalMs;
  const waitMs = scheduledAt - now;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

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

const TECH_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: 'Codex', patterns: [/\bcodex\b/i, /\bcodex\s+resume\b/i] },
  { label: 'Claude', patterns: [/\bclaude\b/i] },
  { label: 'NewAPI', patterns: [/\bnewapi\b/i, /\bnew-api\b/i] },
  { label: 'OpenAI API', patterns: [/\bopenai\b/i, /\bapi[_-]?key\b/i] },
  { label: 'LangGraph', patterns: [/\blanggraph\b/i] },
  { label: 'React', patterns: [/\breact\b/i, /\.tsx\b/i] },
  { label: 'TypeScript', patterns: [/\btypescript\b/i, /\btsx?\b/i] },
  { label: 'Node.js', patterns: [/\bnode\b/i, /\bnode-pty\b/i, /\bnpm\b/i] },
  { label: 'xterm.js', patterns: [/\bxterm\b/i, /\bweb\s*terminal\b/i] },
  { label: 'WebSocket', patterns: [/\bwebsocket\b/i, /\bws\b/i] },
  { label: 'tmux', patterns: [/\btmux\b/i] },
  { label: 'FRP', patterns: [/\bfrp\b/i, /\bfrpc\b/i] },
  { label: 'Cloudflare Tunnel', patterns: [/\bcloudflare\b/i, /\bcloudflared\b/i] },
  { label: 'SSH', patterns: [/\bssh\b/i] },
  { label: 'Docker', patterns: [/\bdocker\b/i, /\bcompose\b/i] },
  { label: 'Ollama', patterns: [/\bollama\b/i] },
  { label: 'OpenMemory', patterns: [/\bopenmemory\b/i] },
  { label: '1Password', patterns: [/\b1password\b/i, /\bop\b/i] },
];

const CHINESE_KEYWORDS = [
  '会话',
  '摘要',
  '总结',
  '迁移',
  '回收站',
  '部署',
  '终端',
  '隧道',
  '代理',
  '机器',
  '索引',
  '搜索',
  '保留',
  '删除',
  '复核',
  '技术栈',
  '工作目录',
  '项目目录',
  '前端',
  '后端',
  '服务端',
  '客户端',
];

const KEYWORD_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'http',
  'https',
  'true',
  'false',
  'null',
  'undefined',
  'localhost',
  '127.0.0.1',
]);

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

function sessionText(messages: ParsedMessage[]): string {
  return messages.map((message) => message.text).join('\n');
}

function extractDirectoryIndex(workdirs: string[], cwd: string | null): string[] {
  const paths = uniqueValues([...(cwd ? [cwd] : []), ...workdirs]);
  const parts: string[] = [];
  for (const path of paths) {
    parts.push(path);
    for (const segment of path.split('/').filter(Boolean)) {
      if (segment.length >= 3 && !/^\d+$/.test(segment)) parts.push(segment);
    }
  }
  return uniqueValues(parts).slice(0, 24);
}

function extractTechStack(messages: ParsedMessage[]): string[] {
  const text = sessionText(messages);
  return TECH_PATTERNS.filter((item) => item.patterns.some((pattern) => pattern.test(text)))
    .map((item) => item.label)
    .slice(0, 18);
}

function extractKeywords(messages: ParsedMessage[], workdirs: string[], cwd: string | null, techStack: string[]): string[] {
  const text = sessionText(messages);
  const lower = text.toLowerCase();
  const counted = new Map<string, number>();
  const add = (keyword: string, weight = 1) => {
    const clean = keyword.trim().replace(/^[._-]+|[._-]+$/g, '');
    if (clean.length < 2 || clean.length > 48) return;
    if (/^(sk|ops|eyj)[a-z0-9_-]{8,}$/i.test(clean)) return;
    if (KEYWORD_STOPWORDS.has(clean.toLowerCase())) return;
    counted.set(clean, (counted.get(clean) ?? 0) + weight);
  };

  for (const keyword of CHINESE_KEYWORDS) {
    if (text.includes(keyword)) add(keyword, 3);
  }
  for (const tech of techStack) add(tech, 4);
  for (const value of extractDirectoryIndex(workdirs, cwd)) add(value, value.startsWith('/') ? 2 : 3);
  for (const match of lower.matchAll(/\b[a-z][a-z0-9_.-]{2,}\b/g)) {
    add(match[0], 1);
  }

  return [...counted.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([keyword]) => keyword)
    .slice(0, 30);
}

function buildSearchText(input: {
  title?: string;
  summary?: string;
  detailedSummary?: string;
  cwd: string | null;
  actualWorkdirs: string[];
  directoryIndex: string[];
  techStack: string[];
  keywords: string[];
  remoteMachines: RemoteMachine[];
}): string {
  return uniqueValues([
    input.title ?? '',
    input.summary ?? '',
    input.detailedSummary ?? '',
    input.cwd ?? '',
    ...input.actualWorkdirs,
    ...input.directoryIndex,
    ...input.techStack,
    ...input.keywords,
    ...input.remoteMachines.flatMap((machine) => [machine.label ?? '', machine.host ?? '', machine.ip ?? '', machine.user ?? '']),
  ])
    .join(' ')
    .toLowerCase();
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
  const messageCharLimit = Math.max(160, Math.min(1200, Number(process.env.CURATOR_LLM_MESSAGE_CHARS || 420)));
  const transcriptCharLimit = Math.max(1600, Math.min(16000, Number(process.env.CURATOR_LLM_TRANSCRIPT_CHARS || 5000)));
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
      return `#${index + 1}${timestamp} ${message.role === 'user' ? '用户' : '助手'}: ${redactSecrets(message.text).slice(0, messageCharLimit)}`;
    });

  const text = useful.join('\n\n');
  return text.length > transcriptCharLimit ? `${text.slice(0, transcriptCharLimit)}\n\n[已按整段会话抽样截断]` : text;
}

function parseLlmEvaluationCandidate(raw: string): LlmEvaluation | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LlmEvaluation>;
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.reasons)) return null;
    const reasons = parsed.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 5);
    const actualWorkdirs = Array.isArray(parsed.actualWorkdirs)
      ? parsed.actualWorkdirs.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];
    const directoryIndex = Array.isArray(parsed.directoryIndex)
      ? parsed.directoryIndex.filter((item): item is string => typeof item === 'string').slice(0, 24)
      : [];
    const techStack = Array.isArray(parsed.techStack)
      ? parsed.techStack.filter((item): item is string => typeof item === 'string').slice(0, 18)
      : [];
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((item): item is string => typeof item === 'string').slice(0, 30)
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
      reasons: reasons.length ? reasons : ['AI 已根据对话内容生成中文摘要'],
      actualWorkdirs,
      directoryIndex,
      techStack,
      keywords,
      recommendedWorkdir: typeof parsed.recommendedWorkdir === 'string' ? parsed.recommendedWorkdir.slice(0, 240) : null,
      remoteMachines,
    };
  } catch {
    return null;
  }
}

function jsonObjectCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fenced) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push(trimmed.slice(start, index + 1));
      start = -1;
    }
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.unshift(trimmed);
  return [...new Set(candidates)];
}

export function parseJsonObject(text: string): LlmEvaluation | null {
  for (const candidate of jsonObjectCandidates(text)) {
    const parsed = parseLlmEvaluationCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function extractChatContent(payload: unknown): string | null {
  const data = payload as { choices?: Array<{ message?: Record<string, unknown> }> };
  const message = data.choices?.[0]?.message;
  if (!message) return null;

  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        return typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }

  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
  return typeof reasoning === 'string' && reasoning.trim() ? reasoning : null;
}

async function readStreamingContent(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let fallbackReasoning = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data) as {
          choices?: Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown> }>;
        };
        const delta = payload.choices?.[0]?.delta ?? payload.choices?.[0]?.message;
        if (!delta) continue;
        if (typeof delta.content === 'string') content += delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof reasoning === 'string') fallbackReasoning += reasoning;
      } catch {
        // Ignore malformed SSE keepalive chunks.
      }
    }
  }

  return content.trim() || fallbackReasoning.trim() || null;
}

async function callLlm(state: WorkflowState): Promise<LlmEvaluation | null> {
  const endpoints = getEvaluatorEndpoints();
  if (!endpoints.length) return null;

  const transcript = transcriptForLlm(state.messages);
  if (!transcript.trim()) return null;
  const callStartedAt = Date.now();

  const messages = [
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
        '{"title":"短标题，12到28字，适合作为保留面板标题","summary":"一小段中文，概括整段会话主要做了什么，不要只总结最后一次消息，120字以内","detailedSummary":"更细致说明整段会话做了什么、修改/部署/验证了什么、遗留了什么，180到350字，不泄露密钥","reasons":["中文依据1","中文依据2"],"actualWorkdirs":["/实际工作目录"],"directoryIndex":["目录路径或项目名"],"techStack":["Codex","React","WebSocket"],"keywords":["可搜索关键词"],"recommendedWorkdir":"/建议迁移或继续工作的目录，没有则为null","remoteMachines":[{"label":"机器名","host":"主机名或域名","ip":"IP或null","user":"SSH用户或null","evidence":"简短依据"}]}',
        '',
        '下面是从整段会话开头、中间和结尾抽取的摘录，请综合判断：',
        transcript,
      ].join('\n'),
    },
  ];

  let lastError: Error | null = null;
  let lastEndpoint: LlmEndpoint | null = null;
  let analysisAttempt = 0;
  for (const endpoint of endpoints) {
    lastEndpoint = endpoint;
    for (let formatAttempt = 1; formatAttempt <= 2; formatAttempt += 1) {
      analysisAttempt += 1;
      const strictRetry = formatAttempt > 1;
      const requestMessages = strictRetry
        ? [
            ...messages,
            {
              role: 'system',
              content: '严格重试：上一次响应无法解析。只输出一个合法 JSON 对象，不要 Markdown、代码围栏、思考过程或额外文字；字符串中的换行和引号必须正确转义。',
            },
          ]
        : messages;
      const useStream = strictRetry ? false : endpoint.stream;
      const body: Record<string, unknown> = {
        model: endpoint.model,
        messages: requestMessages,
        max_tokens: endpoint.maxTokens,
        temperature: strictRetry ? Math.min(endpoint.temperature, 0.2) : endpoint.temperature,
        top_p: endpoint.topP,
        stream: useStream,
      };
      if (endpoint.provider === 'nvidia') {
        if (endpoint.thinking || strictRetry) body.chat_template_kwargs = { thinking: strictRetry ? false : endpoint.thinking };
      } else if (endpoint.responseFormat) {
        body.response_format = { type: 'json_object' };
      }

      let response: Response | null = null;
      const startedAt = Date.now();
      let httpStatus: number | null = null;
      let requestError: Error | null = null;
      let apiKey = nextEvaluatorApiKey(endpoint);
      if (!apiKey) break;
      for (let requestAttempt = 1; requestAttempt <= 3; requestAttempt += 1) {
        requestError = null;
        await waitForLlmRateSlot(endpoint.rpmLimit, `${endpoint.baseUrl}:${apiKey}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), getLlmTimeoutMs());
        try {
          response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: useStream ? 'text/event-stream' : 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          requestError = error instanceof Error ? error : new Error('LLM request failed');
          if (requestAttempt < 3) {
            apiKey = nextEvaluatorApiKey(endpoint) ?? apiKey;
            await new Promise((resolve) => setTimeout(resolve, requestAttempt * 1500));
            continue;
          }
          break;
        } finally {
          clearTimeout(timer);
        }
        httpStatus = response.status;
        if (response.ok) break;
        if (requestAttempt < 3 && (response.status >= 500 || response.status === 429)) {
          apiKey = nextEvaluatorApiKey(endpoint) ?? apiKey;
          await new Promise((resolve) => setTimeout(resolve, requestAttempt * 1500));
          continue;
        }
        break;
      }

      if (!response?.ok) {
        lastError = requestError ?? new Error(`LLM request failed: ${httpStatus ?? 'no response'}`);
        await recordAnalysisRun({
          timestamp: new Date().toISOString(),
          provider: endpoint.provider,
          model: endpoint.model,
          baseUrl: endpoint.baseUrl,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          httpStatus,
          error: lastError.message,
          phase: 'request',
          attempt: analysisAttempt,
          final: false,
          ...analysisTrace(state),
        }).catch(() => undefined);
        break;
      }

      let content: string | null = null;
      try {
        content = useStream ? await readStreamingContent(response) : extractChatContent(await response.json());
      } catch {
        lastError = new Error('LLM response body was not valid JSON');
      }
      if (!content) {
        lastError = lastError ?? new Error('LLM response had no content');
        await recordAnalysisRun({
          timestamp: new Date().toISOString(),
          provider: endpoint.provider,
          model: endpoint.model,
          baseUrl: endpoint.baseUrl,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          httpStatus,
          error: lastError.message,
          phase: 'content',
          attempt: analysisAttempt,
          final: false,
          ...analysisTrace(state),
        }).catch(() => undefined);
        continue;
      }

      const parsed = parseJsonObject(content);
      if (parsed) {
        await recordAnalysisRun({
          timestamp: new Date().toISOString(),
          provider: endpoint.provider,
          model: endpoint.model,
          baseUrl: endpoint.baseUrl,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          httpStatus,
          error: null,
          phase: 'parsed',
          attempt: analysisAttempt,
          final: true,
          ...analysisTrace(state),
        }).catch(() => undefined);
        return { ...parsed, model: endpoint.model };
      }

      lastError = new Error('LLM response was not valid curator JSON');
      await recordAnalysisRun({
        timestamp: new Date().toISOString(),
        provider: endpoint.provider,
        model: endpoint.model,
        baseUrl: endpoint.baseUrl,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        httpStatus,
        error: lastError.message,
        phase: 'parse',
        attempt: analysisAttempt,
        final: false,
        ...analysisTrace(state),
      }).catch(() => undefined);
    }
  }

  if (lastError) {
    const endpoint = lastEndpoint ?? endpoints[0];
    await recordAnalysisRun({
      timestamp: new Date().toISOString(),
      provider: endpoint.provider,
      model: endpoint.model,
      baseUrl: endpoint.baseUrl,
      status: 'failed',
      durationMs: Date.now() - callStartedAt,
      httpStatus: null,
      error: lastError.message,
      phase: 'final',
      attempt: analysisAttempt,
      final: true,
      ...analysisTrace(state),
    }).catch(() => undefined);
    throw lastError;
  }
  return null;
}

function measureNode(state: WorkflowState): Partial<WorkflowState> {
  const text = sessionText(state.messages);
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
  const directoryIndex = extractDirectoryIndex(actualWorkdirs, state.cwd);
  const techStack = extractTechStack(state.messages);
  const keywords = extractKeywords(state.messages, actualWorkdirs, state.cwd, techStack);
  return {
    metrics: {
      totalChars: text.length,
      codeSignals,
      projectSignals,
      oneShotSignals,
      hasImplementationAsk,
    },
    actualWorkdirs,
    directoryIndex,
    techStack,
    keywords,
    searchText: buildSearchText({
      cwd: state.cwd,
      actualWorkdirs,
      directoryIndex,
      techStack,
      keywords,
      remoteMachines,
    }),
    updateCadence: 'new',
    reviewPriority: 'normal',
    reviewSignals: ['首次或完整评估，已生成基础索引'],
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
      const directoryIndex = uniqueValues([
        ...(llm.directoryIndex ?? []),
        ...(state.directoryIndex ?? []),
        ...extractDirectoryIndex(actualWorkdirs, state.cwd),
      ]).slice(0, 24);
      const techStack = uniqueValues([...(llm.techStack ?? []), ...(state.techStack ?? [])]).slice(0, 18);
      const keywords = uniqueValues([
        ...(llm.keywords ?? []),
        ...(state.keywords ?? []),
        ...extractKeywords(state.messages, actualWorkdirs, state.cwd, techStack),
      ]).slice(0, 30);
      const remoteMachines = [...llm.remoteMachines, ...(state.remoteMachines ?? [])].slice(0, 8);
      const cwdMatchesWorkdir = compareWorkdir(state.cwd, actualWorkdirs);
      return {
        title: llm.title,
        summary: llm.summary,
        detailedSummary: llm.detailedSummary,
        reasons: llm.reasons,
        actualWorkdirs,
        directoryIndex,
        techStack,
        keywords,
        searchText: buildSearchText({
          title: llm.title,
          summary: llm.summary,
          detailedSummary: llm.detailedSummary,
          cwd: state.cwd,
          actualWorkdirs,
          directoryIndex,
          techStack,
          keywords,
          remoteMachines,
        }),
        cwdMatchesWorkdir,
        recommendedWorkdir: llm.recommendedWorkdir ?? (cwdMatchesWorkdir === false ? actualWorkdirs[0] ?? null : null),
        remoteMachines,
        model: llm.model ?? getEvaluatorModel(),
        status: 'ok',
        error: null,
      };
    }
  } catch (error) {
    console.warn('[Evaluator] GPT summary failed:', error instanceof Error ? error.message : error);
    const summary = summarize(state.messages, state.cwd);
    const title = fallbackTitle(summary, state.cwd);
    const detailedSummary = fallbackDetailedSummary(state.messages, state.cwd);
    return {
      title,
      summary,
      detailedSummary,
      searchText: buildSearchText({
        title,
        summary,
        detailedSummary,
        cwd: state.cwd,
        actualWorkdirs: state.actualWorkdirs ?? [],
        directoryIndex: state.directoryIndex ?? [],
        techStack: state.techStack ?? [],
        keywords: state.keywords ?? [],
        remoteMachines: state.remoteMachines ?? [],
      }),
      model: getEvaluatorModel(),
      status: 'failed',
      error: error instanceof Error ? error.message.slice(0, 240) : 'GPT summary failed',
    };
  }

  const summary = summarize(state.messages, state.cwd);
  const title = fallbackTitle(summary, state.cwd);
  const detailedSummary = fallbackDetailedSummary(state.messages, state.cwd);
  return {
    title,
    summary,
    detailedSummary,
    searchText: buildSearchText({
      title,
      summary,
      detailedSummary,
      cwd: state.cwd,
      actualWorkdirs: state.actualWorkdirs ?? [],
      directoryIndex: state.directoryIndex ?? [],
      techStack: state.techStack ?? [],
      keywords: state.keywords ?? [],
      remoteMachines: state.remoteMachines ?? [],
    }),
    model: getEvaluatorModel(),
    status: 'fallback',
    error: null,
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
  sessionId?: string | null;
  machineId?: string | null;
  evaluatedByMachineId?: string | null;
  runId?: string | null;
  evaluationOrigin?: EvaluationOrigin;
  transcriptHash?: string | null;
}): Promise<Evaluation> {
  const result = await evaluator.invoke(input);
  const summary = result.summary ?? 'No summary available.';
  const actualWorkdirs = result.actualWorkdirs ?? extractWorkdirs(input.messages, input.cwd);
  const directoryIndex = result.directoryIndex ?? extractDirectoryIndex(actualWorkdirs, input.cwd);
  const techStack = result.techStack ?? extractTechStack(input.messages);
  const keywords = result.keywords ?? extractKeywords(input.messages, actualWorkdirs, input.cwd, techStack);
  const remoteMachines = result.remoteMachines ?? extractRemoteMachines(input.messages);
  const title = result.title ?? fallbackTitle(summary, input.cwd);
  const detailedSummary = result.detailedSummary ?? fallbackDetailedSummary(input.messages, input.cwd);
  const recommendedWorkdir = result.recommendedWorkdir ?? null;
  const now = new Date().toISOString();
  return {
    title,
    summary,
    detailedSummary,
    hermesNeedsRefresh: false,
    hermesRecalculatedAt: now,
    hermesRefreshStatus: 'ok',
    hermesRefreshError: null,
    recommendation: result.recommendation ?? 'review',
    score: result.score ?? 0,
    reasons: result.reasons ?? ['工作流未返回评估依据'],
    actualWorkdirs,
    directoryIndex,
    techStack,
    keywords,
    failureCards: [],
    jobOutcomes: [],
    searchText:
      result.searchText ??
      buildSearchText({
        title,
        summary,
        detailedSummary,
        cwd: input.cwd,
        actualWorkdirs,
        directoryIndex,
        techStack,
        keywords,
        remoteMachines,
      }),
    updateCadence: result.updateCadence ?? 'new',
    reviewPriority: result.reviewPriority ?? 'normal',
    reviewSignals: result.reviewSignals ?? ['首次或完整评估，已生成基础索引'],
    cwdMatchesWorkdir: result.cwdMatchesWorkdir ?? null,
    recommendedWorkdir,
    remoteMachines,
    evaluatedAt: now,
    workflow: EVALUATOR_WORKFLOW,
    model: result.model ?? getEvaluatorModel(),
    status: result.status ?? 'fallback',
    error: result.error ?? null,
    evaluationOrigin: input.evaluationOrigin ?? 'local-llm',
    evaluatedByMachineId: input.evaluatedByMachineId ?? input.machineId ?? null,
    evaluationRunId: input.runId ?? null,
    transcriptHash: input.transcriptHash ?? null,
  };
}
