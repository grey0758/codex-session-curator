import type { CodexSession } from './types.js';

export interface RemoteAgent {
  id: string;
  baseUrl: string;
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
  const url = new URL(path, `${agent.baseUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function fetchAgentSessions(agent: RemoteAgent): Promise<CodexSession[]> {
  try {
    const response = await fetch(`${agent.baseUrl}/api/sessions`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { sessions?: CodexSession[] };
    return (payload.sessions ?? []).map((session) => ({ ...session, machineId: session.machineId || agent.id }));
  } catch (error) {
    console.warn('[RemoteAgents] Failed to fetch sessions:', agent.id, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function fetchAgentJson<T>(agent: RemoteAgent, path: string): Promise<T> {
  const response = await fetch(new URL(path, `${agent.baseUrl}/`));
  if (!response.ok) throw new Error(`${agent.id} HTTP ${response.status}`);
  return (await response.json()) as T;
}
