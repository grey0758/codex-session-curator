import { z } from 'zod';
import type { AgentKind } from './types.js';

export interface AiSearchCandidate {
  candidateId: string;
  sessionId: string;
  machineId: string;
  agent: AgentKind;
  title: string;
  summary: string;
  detailedSummary: string;
  cwd: string | null;
  keywords: string[];
  techStack: string[];
  updatedAt: string | null;
  lastUserMessage: string;
  kept: boolean;
  localScore: number;
}

export interface AiRankedMatch {
  candidateId: string;
  confidence: number;
  reason: string;
}

export interface AiRankResult {
  intent: string;
  matches: AiRankedMatch[];
  machineIds: string[];
  machineConfidence: number;
  searchTerms: string[];
  machineReason: string;
  model: string;
  durationMs: number;
}

export interface AiSearchMachineExample {
  agent: AgentKind;
  title: string;
  summary: string;
  cwd: string | null;
  keywords: string[];
  updatedAt: string | null;
  localScore: number;
}

export interface AiSearchMachineProfile {
  machineId: string;
  sessionCount: number;
  agentCounts: Partial<Record<AgentKind, number>>;
  examples: AiSearchMachineExample[];
}

export interface AiSearchRouteResult {
  intent: string;
  machineIds: string[];
  confidence: number;
  searchTerms: string[];
  reason: string;
  model: string;
  durationMs: number;
}

export interface AiRankOptions {
  timeoutMs?: number;
  route?: Pick<AiSearchRouteResult, 'intent' | 'machineIds' | 'confidence' | 'searchTerms' | 'reason'>;
  machineProfiles?: AiSearchMachineProfile[];
}

export type AiSearchFailureCode =
  | 'not-configured'
  | 'not-deepseek'
  | 'timeout'
  | 'request-failed'
  | 'invalid-response';

export class AiSearchUnavailableError extends Error {
  readonly code: AiSearchFailureCode;

  constructor(code: AiSearchFailureCode, message: string) {
    super(message);
    this.name = 'AiSearchUnavailableError';
    this.code = code;
  }
}

interface DeepSeekEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
}

const rankedResponseSchema = z.object({
  intent: z.string().max(1000).optional().default(''),
  machineIds: z.array(z.string().min(1).max(120)).max(30).optional().default([]),
  machineConfidence: z.coerce.number().min(0).max(1).optional().default(0.5),
  searchTerms: z.array(z.string().min(1).max(120)).max(20).optional().default([]),
  machineReason: z.string().max(500).optional().default(''),
  matches: z.array(
    z.object({
      candidateId: z.string().min(1).max(80),
      confidence: z.coerce.number().min(0).max(1),
      reason: z.string().max(120).optional().default(''),
    }),
  ).max(50),
});

const routeResponseSchema = z.object({
  intent: z.string().min(1).max(1000),
  machineIds: z.array(z.string().min(1).max(120)).max(30).default([]),
  confidence: z.coerce.number().min(0).max(1),
  searchTerms: z.array(z.string().min(1).max(120)).max(20).default([]),
  reason: z.string().min(1).max(500),
});

function parseApiKeys(raw: string): string[] {
  return [...new Set(
    raw
      .split(',')
      .map((key) => key.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  )];
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function resolveDeepSeekEndpoint(): DeepSeekEndpoint {
  const baseUrl = (
    process.env.CURATOR_AI_SEARCH_BASE_URL ||
    process.env.CURATOR_LLM_FALLBACK_BASE_URL ||
    ''
  ).replace(/\/$/, '');
  const model =
    process.env.CURATOR_AI_SEARCH_MODEL ||
    process.env.CURATOR_LLM_FALLBACK_MODEL ||
    '';
  const apiKeys = parseApiKeys(
    process.env.CURATOR_AI_SEARCH_API_KEYS ||
    process.env.CURATOR_AI_SEARCH_API_KEY ||
    process.env.CURATOR_LLM_FALLBACK_API_KEYS ||
    process.env.CURATOR_LLM_FALLBACK_API_KEY ||
    '',
  );
  if (!baseUrl || !model || apiKeys.length === 0) {
    throw new AiSearchUnavailableError('not-configured', 'DeepSeek fast search is not configured');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new AiSearchUnavailableError('not-deepseek', 'DeepSeek fast search URL is invalid');
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  const allowTestEndpoint = process.env.CURATOR_AI_SEARCH_ALLOW_NON_DEEPSEEK_URL === '1';
  const isDeepSeek =
    model.toLowerCase().includes('deepseek') &&
    (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com'));
  if (!isDeepSeek && !allowTestEndpoint) {
    throw new AiSearchUnavailableError('not-deepseek', 'Fast search endpoint is not a verified DeepSeek endpoint');
  }

  return {
    baseUrl,
    model,
    apiKey: apiKeys[0],
    timeoutMs: boundedInt(process.env.CURATOR_AI_SEARCH_TIMEOUT_MS, 8_000, 1_500, 15_000),
    maxTokens: boundedInt(process.env.CURATOR_AI_SEARCH_MAX_TOKENS, 1_600, 400, 4_000),
  };
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function queryTokens(query: string): string[] {
  const normalized = normalizedText(query);
  const tokens = normalized
    .split(/[^\p{L}\p{N}._+-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._+-]*/giu)) {
    if (match[0].length >= 2) tokens.push(match[0]);
  }
  for (const match of normalized.matchAll(/\p{Script=Han}{3,}/gu)) {
    const phrase = match[0];
    for (let index = 0; index < phrase.length - 1; index += 1) {
      tokens.push(phrase.slice(index, index + 2));
    }
  }
  return [...new Set(tokens)].slice(0, 80);
}

export function findMentionedMachineIds(query: string, machineIds: string[]): string[] {
  const normalized = normalizedText(query);
  return machineIds.filter((machineId) => {
    const needle = normalizedText(machineId.trim());
    return needle.length >= 2 && normalized.includes(needle);
  });
}

export function scoreAiSearchCandidate(candidate: Omit<AiSearchCandidate, 'candidateId' | 'localScore'>, query: string): number {
  const needle = normalizedText(query.trim());
  if (!needle) return 0;
  const fields = {
    id: normalizedText(candidate.sessionId),
    title: normalizedText(candidate.title),
    summary: normalizedText(candidate.summary),
    detailed: normalizedText(candidate.detailedSummary),
    cwd: normalizedText(candidate.cwd ?? ''),
    keywords: normalizedText(candidate.keywords.join(' ')),
    tech: normalizedText(candidate.techStack.join(' ')),
    lastUser: normalizedText(candidate.lastUserMessage),
    machine: normalizedText(`${candidate.machineId} ${candidate.agent}`),
  };

  let score = 0;
  if (fields.id.includes(needle)) score += 80;
  if (fields.title.includes(needle)) score += 36;
  if (fields.summary.includes(needle)) score += 26;
  if (fields.detailed.includes(needle)) score += 20;
  if (fields.lastUser.includes(needle)) score += 22;
  if (fields.keywords.includes(needle)) score += 18;
  if (fields.cwd.includes(needle)) score += 15;
  if (fields.tech.includes(needle)) score += 12;
  if (fields.machine.includes(needle)) score += 10;

  for (const token of queryTokens(query)) {
    if (fields.id.includes(token)) score += 14;
    if (fields.title.includes(token)) score += 10;
    if (fields.summary.includes(token)) score += 7;
    if (fields.detailed.includes(token)) score += 5;
    if (fields.lastUser.includes(token)) score += 7;
    if (fields.keywords.includes(token)) score += 6;
    if (fields.cwd.includes(token)) score += 4;
    if (fields.tech.includes(token)) score += 3;
    if (fields.machine.includes(token)) score += 3;
  }
  return score;
}

function clip(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function jsonObjectCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
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
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(trimmed.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.unshift(trimmed);
  return [...new Set(candidates)];
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，、\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeConfidence(value: unknown, fallback: number): number {
  const raw = typeof value === 'string'
    ? Number(value.trim().replace(/%$/, ''))
    : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const normalized = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, normalized));
}

export function parseAiRankResponse(
  text: string,
): Pick<AiRankResult, 'intent' | 'machineIds' | 'machineConfidence' | 'searchTerms' | 'machineReason' | 'matches'> | null {
  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsedJson = JSON.parse(candidate) as Record<string, unknown>;
      const raw = (
        parsedJson.result && typeof parsedJson.result === 'object' && !Array.isArray(parsedJson.result)
          ? parsedJson.result
          : parsedJson
      ) as {
        intent?: unknown;
        machineIds?: unknown;
        machine_ids?: unknown;
        machineId?: unknown;
        machine?: unknown;
        sourceMachines?: unknown;
        source_machines?: unknown;
        machineConfidence?: unknown;
        machine_confidence?: unknown;
        searchTerms?: unknown;
        search_terms?: unknown;
        machineReason?: unknown;
        machine_reason?: unknown;
        matches?: unknown;
        candidateIds?: unknown;
        candidate_ids?: unknown;
        rankedCandidateIds?: unknown;
        ranked_candidate_ids?: unknown;
      };
      const rawMatches = Array.isArray(raw.matches)
        ? raw.matches
        : normalizeStringArray(
            raw.candidateIds ??
            raw.candidate_ids ??
            raw.rankedCandidateIds ??
            raw.ranked_candidate_ids,
          );
      const normalized = {
        intent: raw.intent,
        machineIds: normalizeStringArray(
          raw.machineIds ??
          raw.machine_ids ??
          raw.machineId ??
          raw.machine ??
          raw.sourceMachines ??
          raw.source_machines,
        ),
        machineConfidence: normalizeConfidence(
          raw.machineConfidence ?? raw.machine_confidence,
          0.5,
        ),
        searchTerms: normalizeStringArray(raw.searchTerms ?? raw.search_terms),
        machineReason: raw.machineReason ?? raw.machine_reason,
        matches: rawMatches.map((match, index) => {
          if (typeof match === 'string') {
            return {
              candidateId: match,
              confidence: Math.max(0.55, 0.9 - index * 0.03),
              reason: '',
            };
          }
          const item = match && typeof match === 'object'
            ? match as Record<string, unknown>
            : {};
          return {
            candidateId: item.candidateId ?? item.candidate_id ?? item.id,
            confidence: normalizeConfidence(item.confidence ?? item.score, Math.max(0.55, 0.9 - index * 0.03)),
            reason: item.reason,
          };
        }),
      };
      const parsed = rankedResponseSchema.safeParse(normalized);
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next balanced or fenced JSON object.
    }
  }
  const recoveredIds = [...new Set(
    [...text.matchAll(/\bc(?:andidate)?[_\s-]?(\d{1,4})\b/gi)]
      .map((match) => `c${Number(match[1])}`)
      .filter((candidateId) => candidateId !== 'c0'),
  )].slice(0, 50);
  if (recoveredIds.length) {
    return {
      intent: '',
      machineIds: [],
      machineConfidence: 0.5,
      searchTerms: [],
      machineReason: '',
      matches: recoveredIds.map((candidateId, index) => ({
        candidateId,
        confidence: Number(Math.max(0.55, 0.82 - index * 0.03).toFixed(2)),
        reason: '',
      })),
    };
  }
  return null;
}

export function parseAiRouteResponse(
  text: string,
  availableMachineIds: string[],
): Pick<AiSearchRouteResult, 'intent' | 'machineIds' | 'confidence' | 'searchTerms' | 'reason'> | null {
  const availableByNormalized = new Map(
    availableMachineIds.map((machineId) => [normalizedText(machineId), machineId]),
  );
  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const raw = JSON.parse(candidate) as {
        intent?: unknown;
        machineIds?: unknown;
        machine_ids?: unknown;
        confidence?: unknown;
        searchTerms?: unknown;
        search_terms?: unknown;
        reason?: unknown;
      };
      const parsed = routeResponseSchema.safeParse({
        intent: raw.intent,
        machineIds: raw.machineIds ?? raw.machine_ids,
        confidence: raw.confidence,
        searchTerms: raw.searchTerms ?? raw.search_terms,
        reason: raw.reason,
      });
      if (!parsed.success) continue;
      const machineIds = [...new Set(
        parsed.data.machineIds.flatMap((machineId) => {
          const resolved = availableByNormalized.get(normalizedText(machineId));
          return resolved ? [resolved] : [];
        }),
      )];
      return {
        ...parsed.data,
        machineIds: machineIds.length ? machineIds : availableMachineIds,
        searchTerms: [...new Set(parsed.data.searchTerms.map((term) => term.trim()).filter(Boolean))],
      };
    } catch {
      // Try the next balanced or fenced JSON object.
    }
  }
  return null;
}

function extractChatContent(payload: unknown): string | null {
  const data = payload as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return typeof (item as { text?: unknown }).text === 'string'
        ? String((item as { text: string }).text)
        : '';
    })
    .filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

function selectRescueCandidates(
  candidates: AiSearchCandidate[],
  route: AiRankOptions['route'],
  limit: number,
): AiSearchCandidate[] {
  const preferred = new Set(
    route && route.confidence >= 0.62 ? route.machineIds : [],
  );
  const selected: AiSearchCandidate[] = [];
  const seen = new Set<string>();
  const append = (items: AiSearchCandidate[], count: number) => {
    let appended = 0;
    for (const candidate of items) {
      if (seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      selected.push(candidate);
      appended += 1;
      if (selected.length >= limit || appended >= count) return;
    }
  };
  if (preferred.size) {
    append(
      candidates.filter((candidate) => preferred.has(candidate.machineId)),
      Math.max(1, Math.round(limit * 0.65)),
    );
  }
  const remainingByMachine = new Map<string, AiSearchCandidate[]>();
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateId)) continue;
    const machineCandidates = remainingByMachine.get(candidate.machineId) ?? [];
    machineCandidates.push(candidate);
    remainingByMachine.set(candidate.machineId, machineCandidates);
  }
  while (selected.length < limit && remainingByMachine.size) {
    let appended = false;
    for (const [machineId, machineCandidates] of remainingByMachine) {
      const candidate = machineCandidates.shift();
      if (!candidate) {
        remainingByMachine.delete(machineId);
        continue;
      }
      append([candidate], 1);
      appended = true;
      if (selected.length >= limit) break;
    }
    if (!appended) break;
  }
  return selected;
}

async function requestDeepSeekJson(
  endpoint: DeepSeekEndpoint,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  timeoutMs: number,
  maxTokens: number,
): Promise<{ content: string; durationMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
        top_p: 0.9,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AiSearchUnavailableError('request-failed', `DeepSeek fast search returned HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new AiSearchUnavailableError('invalid-response', 'DeepSeek fast search returned invalid JSON');
    }
    const content = extractChatContent(payload);
    if (!content) {
      throw new AiSearchUnavailableError('invalid-response', 'DeepSeek fast search returned empty content');
    }
    return { content, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof AiSearchUnavailableError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiSearchUnavailableError('timeout', 'DeepSeek fast search timed out');
    }
    throw new AiSearchUnavailableError('request-failed', 'DeepSeek fast search request failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function inferAiSearchRoute(
  query: string,
  profiles: AiSearchMachineProfile[],
  timeoutMs?: number,
): Promise<AiSearchRouteResult> {
  const endpoint = resolveDeepSeekEndpoint();
  const availableMachineIds = profiles.map((profile) => profile.machineId);
  const mentionedMachineIds = findMentionedMachineIds(query, availableMachineIds);
  const promptProfiles = profiles.map((profile) => ({
    machineId: profile.machineId,
    sessionCount: profile.sessionCount,
    agentCounts: profile.agentCounts,
    examples: profile.examples.slice(0, 4).map((example) => ({
      agent: example.agent,
      title: clip(example.title, 72),
      summary: clip(example.summary, 96),
      cwd: clip(example.cwd ?? '', 72),
      keywords: example.keywords.slice(0, 3).map((item) => clip(item, 24)),
      updatedAt: example.updatedAt,
      lexicalScore: example.localScore,
    })),
  }));
  const messages = [
    {
      role: 'system' as const,
      content: [
        '你是 Curator 会话搜索的意图规划器。用户可以只描述模糊内容，也可以提到机器、项目、时间或代理；不得要求用户改写输入。',
        '根据所有机器的会话概况判断最可能保存目标会话的源机器，并生成有助于召回的简短搜索词。',
        '源机器是会话 identity.machineId，不要因为某台机器只在会话正文中被讨论就误判为会话来源。',
        '如果用户明确写出 registered machine id，应优先选择该机器；如果证据不足，返回多个或全部机器，不要武断排除。',
        'machineIds 只能使用 availableMachineIds。searchTerms 应包含项目名、功能、错误、同义词等，不要重复整句。',
        '只输出严格 JSON：{"intent":"理解后的目标","machineIds":["machine"],"confidence":0.86,"searchTerms":["词1","词2"],"reason":"机器判断依据"}。',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        query,
        availableMachineIds,
        explicitlyMentionedMachineIds: mentionedMachineIds,
        machines: promptProfiles,
      }),
    },
  ];
  const requestedTimeout = Math.min(endpoint.timeoutMs, timeoutMs ?? endpoint.timeoutMs);
  const response = await requestDeepSeekJson(
    endpoint,
    messages,
    requestedTimeout,
    boundedInt(process.env.CURATOR_AI_SEARCH_ROUTE_MAX_TOKENS, 400, 300, 1_200),
  );
  const parsed = parseAiRouteResponse(response.content, availableMachineIds);
  if (!parsed) {
    throw new AiSearchUnavailableError('invalid-response', 'DeepSeek machine routing result could not be parsed');
  }
  return {
    ...parsed,
    model: endpoint.model,
    durationMs: response.durationMs,
  };
}

export async function rankAiSearchCandidates(
  query: string,
  candidates: AiSearchCandidate[],
  limit: number,
  options: AiRankOptions = {},
): Promise<AiRankResult> {
  const endpoint = resolveDeepSeekEndpoint();
  const promptCandidate = (candidate: AiSearchCandidate) => ({
    candidateId: candidate.candidateId,
    machine: candidate.machineId,
    agent: candidate.agent,
    title: clip(candidate.title, 90),
    summary: clip(candidate.summary, 170),
    details: clip(candidate.detailedSummary, 100),
    cwd: clip(candidate.cwd ?? '', 90),
    keywords: candidate.keywords.slice(0, 6).map((item) => clip(item, 32)),
    techStack: candidate.techStack.slice(0, 4).map((item) => clip(item, 24)),
    updatedAt: candidate.updatedAt,
    lastUser: clip(candidate.lastUserMessage, 120),
    kept: candidate.kept,
    lexicalScore: candidate.localScore,
  });
  const promptCandidates = candidates.map(promptCandidate);
  const machineProfiles = (options.machineProfiles ?? []).map((profile) => ({
    machineId: profile.machineId,
    sessionCount: profile.sessionCount,
    agentCounts: profile.agentCounts,
    examples: profile.examples.slice(0, 3).map((example) => ({
      agent: example.agent,
      title: clip(example.title, 64),
      summary: clip(example.summary, 84),
      cwd: clip(example.cwd ?? '', 64),
      keywords: example.keywords.slice(0, 2).map((item) => clip(item, 24)),
    })),
  }));
  const systemMessage = {
    role: 'system' as const,
    content: [
      '你是 Curator 的跨机器会话检索器。用户只会给出模糊回忆，你要在一次判断中理解意图、判断源机器并排序候选会话；不得要求用户改写输入。',
      '源机器是会话 identity.machineId，不要因为某台机器只在会话正文中被讨论就误判为会话来源。',
      '综合标题、摘要、工作目录、关键词、最近用户问题、机器、代理与时间判断，不要只做字面匹配。',
      'machineHint 是本地安全提示，不是强制限制；候选中保留了其他机器，证据更强时必须纠正它。证据不足时 machineIds 返回多个或全部机器。',
      'machineIds 只能使用 availableMachineIds；searchTerms 返回有助于后续召回的简短项目名、功能、错误或同义词。',
      '只能返回提供的 candidateId，绝不虚构 ID。为降低延迟，matches 不要输出解释文字，只返回 candidateId 与 confidence。',
      'intent、machineReason 和每个 searchTerm 都要非常短。只输出严格 JSON：{"intent":"目标","machineIds":["machine"],"machineConfidence":0.86,"searchTerms":["词1","词2"],"machineReason":"机器依据","matches":[{"candidateId":"c1","confidence":0.92}]}。',
    ].join('\n'),
  };
  const promptPayload = {
    query,
    limit,
    availableMachineIds: [...new Set(candidates.map((candidate) => candidate.machineId))],
    machineHint: options.route ?? null,
    machineProfiles,
    candidates: promptCandidates,
  };
  const messages = [
    systemMessage,
    {
      role: 'user' as const,
      content: JSON.stringify(promptPayload),
    },
  ];
  const requestedTimeout = Math.min(endpoint.timeoutMs, options.timeoutMs ?? endpoint.timeoutMs);
  const primaryTimeoutMs = requestedTimeout >= 3_000
    ? Math.min(
        requestedTimeout - 1_500,
        boundedInt(process.env.CURATOR_AI_SEARCH_PRIMARY_TIMEOUT_MS, 6_500, 500, 10_000),
      )
    : requestedTimeout;
  const requestStartedAt = Date.now();
  let response: { content: string; durationMs: number };
  let usedRescue = false;
  const rescueRequest = async (remainingMs: number) => {
    const rescueCandidates = selectRescueCandidates(candidates, options.route, Math.min(10, candidates.length));
    const rescued = await requestDeepSeekJson(
      endpoint,
      [
        systemMessage,
        {
          role: 'user' as const,
          content: JSON.stringify({
            ...promptPayload,
            rescue: true,
            candidates: rescueCandidates.map(promptCandidate),
          }),
        },
      ],
      remainingMs,
      endpoint.maxTokens,
    );
    rescued.durationMs = Date.now() - requestStartedAt;
    usedRescue = true;
    return rescued;
  };
  try {
    response = await requestDeepSeekJson(endpoint, messages, primaryTimeoutMs, endpoint.maxTokens);
  } catch (error) {
    const remainingMs = requestedTimeout - (Date.now() - requestStartedAt);
    if (
      !(error instanceof AiSearchUnavailableError) ||
      !['timeout', 'invalid-response'].includes(error.code) ||
      remainingMs < 1_000
    ) {
      throw error;
    }
    response = await rescueRequest(remainingMs);
  }
  let parsed = parseAiRankResponse(response.content);
  if (!parsed && !usedRescue) {
    const remainingMs = requestedTimeout - (Date.now() - requestStartedAt);
    if (remainingMs >= 1_000) {
      response = await rescueRequest(remainingMs);
      parsed = parseAiRankResponse(response.content);
    }
  }
  if (!parsed) {
    throw new AiSearchUnavailableError('invalid-response', 'DeepSeek fast search result could not be parsed');
  }
  const availableMachineIds = [...new Set(candidates.map((candidate) => candidate.machineId))];
  const availableByNormalized = new Map(
    availableMachineIds.map((machineId) => [normalizedText(machineId), machineId]),
  );
  const machineIds = [...new Set(
    parsed.machineIds.flatMap((machineId) => {
      const resolved = availableByNormalized.get(normalizedText(machineId));
      return resolved ? [resolved] : [];
    }),
  )];
  return {
    ...parsed,
    machineIds: machineIds.length ? machineIds : availableMachineIds,
    searchTerms: [...new Set(parsed.searchTerms.map((term) => term.trim()).filter(Boolean))],
    matches: parsed.matches.map((match) => ({
      ...match,
      reason: match.reason.trim() || 'DeepSeek 综合机器、标题、摘要、工作目录和最近问题判断匹配',
    })),
    model: endpoint.model,
    durationMs: response.durationMs,
  };
}
