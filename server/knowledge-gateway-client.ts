export interface KnowledgeGatewayMatch {
  id: string;
  docId: string | null;
  title: string;
  path: string;
  kind: string | null;
  heading: string | null;
  startLine: number | null;
  tags: string[];
  sourceHash: string | null;
  chunkHash: string | null;
  text: string;
  snippet: string;
  score: number;
  semanticScore: number | null;
  lexicalScore: number | null;
  source: string | null;
}

export interface KnowledgeGatewaySearchResult {
  available: boolean;
  queryId: string | null;
  retrieval: string | null;
  collection: string | null;
  matches: KnowledgeGatewayMatch[];
  error: string | null;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanMatch(value: unknown): KnowledgeGatewayMatch | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = cleanString(item.id);
  const path = cleanString(item.path);
  const title = cleanString(item.title);
  const text = cleanString(item.text) ?? cleanString(item.snippet);
  if (!id || !path || !title || !text) return null;
  return {
    id,
    docId: cleanString(item.doc_id),
    title,
    path,
    kind: cleanString(item.kind),
    heading: cleanString(item.heading),
    startLine: cleanNumber(item.start_line),
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sourceHash: cleanString(item.source_hash),
    chunkHash: cleanString(item.chunk_hash),
    text,
    snippet: cleanString(item.snippet) ?? text.slice(0, 420),
    score: cleanNumber(item.score) ?? 0,
    semanticScore: cleanNumber(item.semantic_score),
    lexicalScore: cleanNumber(item.lexical_score),
    source: cleanString(item.source),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'knowledge gateway request timed out';
    return error.message.slice(0, 300);
  }
  return 'knowledge gateway request failed';
}

export async function searchKnowledgeGateway(input: {
  query: string;
  limit: number;
  projectCwd?: string | null;
}): Promise<KnowledgeGatewaySearchResult> {
  const baseUrl = (process.env.CURATOR_KNOWLEDGE_GATEWAY_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
  if (process.env.CURATOR_KNOWLEDGE_GATEWAY_ENABLED === '0') {
    return { available: false, queryId: null, retrieval: null, collection: null, matches: [], error: 'disabled' };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(250, Math.min(120_000, Number(process.env.CURATOR_KNOWLEDGE_GATEWAY_TIMEOUT_MS || 30_000)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent': 'curator-hub',
        'x-knowledge-purpose': 'production',
        'x-project-cwd': input.projectCwd || process.cwd(),
      },
      body: JSON.stringify({ query: input.query, limit: Math.max(1, Math.min(50, input.limit)) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`knowledge gateway HTTP ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    const rawMatches = Array.isArray(payload.matches) ? payload.matches : [];
    return {
      available: true,
      queryId: cleanString(payload.query_id),
      retrieval: cleanString(payload.retrieval),
      collection: cleanString(payload.collection),
      matches: rawMatches.map(cleanMatch).filter((match): match is KnowledgeGatewayMatch => Boolean(match)),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      queryId: null,
      retrieval: null,
      collection: null,
      matches: [],
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
