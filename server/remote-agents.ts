import type { CodexSession } from './types.js';

export interface RemoteAgent {
  id: string;
  baseUrl: string;
  token: string | null;
}

export interface RemoteAgentStatus {
  id: string;
  baseUrl: string;
  online: boolean;
  latencyMs: number | null;
  error: string | null;
  machineId: string | null;
}

export class RemoteAgentHttpError extends Error {
  readonly agentId: string;
  readonly status: number;
  readonly body: unknown;

  constructor(agentId: string, status: number, body: unknown) {
    super(`${agentId} HTTP ${status}`);
    this.name = 'RemoteAgentHttpError';
    this.agentId = agentId;
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_REMOTE_SESSIONS_TIMEOUT_MS = 3500;
const DEFAULT_REMOTE_JSON_TIMEOUT_MS = 8000;

type HubEvaluationState = Pick<
  CodexSession['evaluation'],
  'status' | 'hermesNeedsRefresh' | 'evaluationOrigin' | 'workflow'
>;

export function hasPendingHubEvaluation(session: { evaluation: HubEvaluationState }): boolean {
  return session.evaluation.status !== 'ok' ||
    session.evaluation.hermesNeedsRefresh === true ||
    session.evaluation.evaluationOrigin === 'worker-fast' ||
    session.evaluation.workflow.includes(':needs-refresh:') ||
    session.evaluation.workflow.endsWith(':fast-list');
}

export function shouldQueueHubRemoteEvaluation(
  session: { messageCount: number; updatedAt?: string | null; evaluation: HubEvaluationState },
  options: { nowMs?: number; quietMs?: number } = {},
): boolean {
  if (session.messageCount <= 0 || !hasPendingHubEvaluation(session)) return false;
  const quietMs = Math.max(0, options.quietMs ?? 0);
  if (!quietMs || !session.updatedAt) return true;
  const updatedAtMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return (options.nowMs ?? Date.now()) - updatedAtMs >= quietMs;
}

function timeoutMs(envName: string, fallback: number): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithTimeout(url: string | URL, timeout: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function getRemoteAgents(): RemoteAgent[] {
  const raw = process.env.CURATOR_REMOTE_AGENTS?.trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, ...urlParts] = entry.split('=');
      const cleanId = id.trim();
      return {
        id: cleanId,
        baseUrl: urlParts.join('=').trim().replace(/\/+$/, ''),
        token: remoteAgentToken(cleanId),
      };
    })
    .filter((agent) => agent.id && agent.baseUrl);
}

export function wsUrlForAgent(agent: RemoteAgent, path: string): string {
  const url = remoteUrl(agent, path);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseRemoteAgentTokens(): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of (process.env.CURATOR_REMOTE_AGENT_TOKENS || '').split(',')) {
    const [id, ...tokenParts] = entry.split('=');
    const token = tokenParts.join('=').trim();
    if (id?.trim() && token) result.set(id.trim(), token);
  }
  return result;
}

function remoteAgentToken(id: string): string | null {
  const envName = `CURATOR_REMOTE_AGENT_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return process.env[envName] || parseRemoteAgentTokens().get(id) || process.env.CURATOR_REMOTE_ADMIN_TOKEN || process.env.CURATOR_ADMIN_TOKEN || null;
}

function getRemoteAdminToken(agent: RemoteAgent): string | null {
  return agent.token || remoteAgentToken(agent.id);
}

function remoteHeaders(agent: RemoteAgent, init: Record<string, string> = {}): Record<string, string> {
  const token = getRemoteAdminToken(agent);
  return token ? { ...init, Authorization: `Bearer ${token}` } : init;
}

function remoteUrl(agent: RemoteAgent, path: string): URL {
  const url = new URL(path, `${agent.baseUrl}/`);
  const token = getRemoteAdminToken(agent);
  if (token && !url.searchParams.has('admin_token')) url.searchParams.set('admin_token', token);
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRemoteSession(
  agent: RemoteAgent,
  value: unknown,
  location: string,
): CodexSession {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error(`Invalid remote session from ${agent.id} at ${location}`);
  }
  if (value.agent !== 'codex' && value.agent !== 'claude') {
    throw new Error(`Invalid remote session Agent from ${agent.id} at ${location}`);
  }
  return {
    ...value,
    agent: value.agent,
    machineId: agent.id,
  } as unknown as CodexSession;
}

function normalizeRemoteAgentPayload<T>(
  agent: RemoteAgent,
  payload: unknown,
  options: { requireSessions?: boolean } = {},
): T {
  if (!isRecord(payload)) {
    if (options.requireSessions) throw new Error(`Invalid remote sessions payload from ${agent.id}`);
    return payload as T;
  }

  const hasSessions = Object.prototype.hasOwnProperty.call(payload, 'sessions');
  if (options.requireSessions && !Array.isArray(payload.sessions)) {
    throw new Error(`Invalid remote sessions payload from ${agent.id}`);
  }

  let normalized: Record<string, unknown> = payload;
  if (hasSessions) {
    if (!Array.isArray(payload.sessions)) {
      throw new Error(`Invalid remote sessions payload from ${agent.id}`);
    }
    normalized = {
      ...normalized,
      sessions: payload.sessions.map((session, index) =>
        normalizeRemoteSession(agent, session, `sessions[${index}]`)
      ),
    };
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'session')) {
    normalized = {
      ...normalized,
      session: normalizeRemoteSession(agent, payload.session, 'session'),
    };
  }

  return normalized as T;
}

function isSessionCollectionPath(path: string): boolean {
  return new URL(path, 'http://curator-remote.invalid').pathname === '/api/sessions';
}

export async function fetchAgentSessions(agent: RemoteAgent): Promise<CodexSession[]> {
  try {
    const response = await fetchWithTimeout(
      remoteUrl(agent, '/api/sessions?detail=0&remote=0'),
      timeoutMs('CURATOR_REMOTE_SESSIONS_TIMEOUT_MS', DEFAULT_REMOTE_SESSIONS_TIMEOUT_MS),
      { headers: remoteHeaders(agent) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = normalizeRemoteAgentPayload<{ sessions: CodexSession[] }>(
      agent,
      await response.json(),
      { requireSessions: true },
    );
    return payload.sessions;
  } catch (error) {
    console.warn('[RemoteAgents] Failed to fetch sessions:', agent.id, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function checkRemoteAgent(agent: RemoteAgent): Promise<RemoteAgentStatus> {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(
      remoteUrl(agent, '/api/meta'),
      timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
      { headers: remoteHeaders(agent) },
    );
    const latencyMs = Date.now() - started;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const meta = (await response.json()) as { machineId?: string };
    return {
      id: agent.id,
      baseUrl: agent.baseUrl,
      online: true,
      latencyMs,
      error: null,
      machineId: meta.machineId ?? agent.id,
    };
  } catch (error) {
    return {
      id: agent.id,
      baseUrl: agent.baseUrl,
      online: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : 'remote unavailable',
      machineId: null,
    };
  }
}

export async function fetchAgentJson<T>(agent: RemoteAgent, path: string): Promise<T> {
  const response = await fetchWithTimeout(
    remoteUrl(agent, path),
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
    { headers: remoteHeaders(agent) },
  );
  if (!response.ok) {
    const responseBody = await response.json().catch(() => null) as unknown;
    throw new RemoteAgentHttpError(agent.id, response.status, responseBody);
  }
  return normalizeRemoteAgentPayload<T>(
    agent,
    await response.json(),
    { requireSessions: isSessionCollectionPath(path) },
  );
}

export async function postAgentJson<T>(agent: RemoteAgent, path: string, body: unknown): Promise<T> {
  const response = await fetchWithTimeout(
    remoteUrl(agent, path),
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
    {
      method: 'POST',
      headers: remoteHeaders(agent, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const responseBody = await response.json().catch(() => null) as unknown;
    throw new RemoteAgentHttpError(agent.id, response.status, responseBody);
  }
  return (await response.json()) as T;
}

export async function deleteAgentJson<T>(agent: RemoteAgent, path: string, body: unknown): Promise<T> {
  const response = await fetchWithTimeout(
    remoteUrl(agent, path),
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
    {
      method: 'DELETE',
      headers: remoteHeaders(agent, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) throw new Error(`${agent.id} HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function deleteAgentSession<T>(
  agent: RemoteAgent,
  sessionId: string,
  sessionAgent?: CodexSession['agent'],
): Promise<T> {
  const query = new URLSearchParams({ machineId: agent.id, remote: '0' });
  if (sessionAgent) query.set('agent', sessionAgent);
  return deleteAgentJson<T>(
    agent,
    `/api/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`,
    { confirm: true },
  );
}

export async function deleteAgentSessionsBulk<T>(agent: RemoteAgent, sessionIds: string[]): Promise<T> {
  const response = await fetchWithTimeout(
    remoteUrl(agent, '/api/sessions/bulk-delete?remote=0'),
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
    {
      method: 'POST',
      headers: remoteHeaders(agent, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        confirm: true,
        sessions: sessionIds.map((id) => ({ id, machineId: agent.id })),
      }),
    }
  );
  if (!response.ok) throw new Error(`${agent.id} HTTP ${response.status}`);
  return (await response.json()) as T;
}
