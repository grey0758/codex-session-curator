import type { CodexSession } from './types.js';

export interface RemoteAgent {
  id: string;
  baseUrl: string;
}

export interface RemoteAgentStatus {
  id: string;
  baseUrl: string;
  online: boolean;
  latencyMs: number | null;
  error: string | null;
  machineId: string | null;
}

const DEFAULT_REMOTE_SESSIONS_TIMEOUT_MS = 3500;
const DEFAULT_REMOTE_JSON_TIMEOUT_MS = 8000;

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
      return { id: id.trim(), baseUrl: urlParts.join('=').trim().replace(/\/+$/, '') };
    })
    .filter((agent) => agent.id && agent.baseUrl);
}

export function wsUrlForAgent(agent: RemoteAgent, path: string): string {
  const url = remoteUrl(agent, path);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function getRemoteAdminToken(): string | null {
  return process.env.CURATOR_REMOTE_ADMIN_TOKEN || process.env.CURATOR_ADMIN_TOKEN || null;
}

function remoteUrl(agent: RemoteAgent, path: string): URL {
  const url = new URL(path, `${agent.baseUrl}/`);
  const token = getRemoteAdminToken();
  if (token && !url.searchParams.has('admin_token')) url.searchParams.set('admin_token', token);
  return url;
}

export async function fetchAgentSessions(agent: RemoteAgent): Promise<CodexSession[]> {
  try {
    const response = await fetchWithTimeout(
      remoteUrl(agent, '/api/sessions?detail=0&remote=0'),
      timeoutMs('CURATOR_REMOTE_SESSIONS_TIMEOUT_MS', DEFAULT_REMOTE_SESSIONS_TIMEOUT_MS)
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { sessions?: CodexSession[] };
    return (payload.sessions ?? []).map((session) => ({ ...session, machineId: session.machineId || agent.id }));
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
      timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS)
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
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS)
  );
  if (!response.ok) throw new Error(`${agent.id} HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function deleteAgentSession<T>(agent: RemoteAgent, sessionId: string): Promise<T> {
  const response = await fetchWithTimeout(
    remoteUrl(agent, `/api/sessions/${encodeURIComponent(sessionId)}`),
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }
  );
  if (!response.ok) throw new Error(`${agent.id} HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function deleteAgentSessionsBulk<T>(agent: RemoteAgent, sessionIds: string[]): Promise<T> {
  const response = await fetchWithTimeout(
    remoteUrl(agent, '/api/sessions/bulk-delete?remote=0'),
    timeoutMs('CURATOR_REMOTE_JSON_TIMEOUT_MS', DEFAULT_REMOTE_JSON_TIMEOUT_MS),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, ids: sessionIds }),
    }
  );
  if (!response.ok) throw new Error(`${agent.id} HTTP ${response.status}`);
  return (await response.json()) as T;
}
