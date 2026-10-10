export interface SessionIdentity {
  id: string;
  machineId: string;
  agent: 'codex' | 'claude';
}

interface InjectedContextBlock {
  kind: 'agents_instructions' | 'environment_context' | 'skill';
  label: string;
  text: string;
  characterCount: number;
}

export interface HistoryMessage {
  index: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  injectedContext?: InjectedContextBlock | null;
  precedingContext?: InjectedContextBlock[];
}

interface RecentUserMessagesPayload {
  messages: HistoryMessage[];
  totalUserMessages: number;
  hiddenContextMessages: number;
  fileSize: number;
  fileMtimeMs: number;
  cached: boolean;
}

const recentUserMessageCache = new Map<string, RecentUserMessagesPayload>();
const recentUserMessageRequests = new Map<string, Promise<RecentUserMessagesPayload>>();
const recentUserMessageEtags = new Map<string, string>();

export function sessionKey(session: SessionIdentity): string {
  return `${session.machineId || 'unknown'}|||${session.agent}|||${session.id}`;
}

export function getCachedRecentUserMessages(session: SessionIdentity): RecentUserMessagesPayload | undefined {
  return recentUserMessageCache.get(sessionKey(session));
}

export function fetchRecentUserMessages(session: SessionIdentity): Promise<RecentUserMessagesPayload> {
  const key = sessionKey(session);
  const inFlight = recentUserMessageRequests.get(key);
  if (inFlight) return inFlight;
  const params = new URLSearchParams({ limit: '4', machineId: session.machineId, agent: session.agent });
  const url = `/api/sessions/${encodeURIComponent(session.id)}/recent-user-messages?${params}`;
  const etag = recentUserMessageEtags.get(key);
  const request = fetch(url, { cache: 'no-cache', headers: etag ? { 'If-None-Match': etag } : {} })
    .then(async (response) => {
      if (response.status === 304) {
        const cached = recentUserMessageCache.get(key);
        if (cached) return cached;
        recentUserMessageEtags.delete(key);
        const retry = await fetch(url, { cache: 'no-cache' });
        if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
        const payload = await retry.json() as RecentUserMessagesPayload;
        const freshEtag = retry.headers.get('ETag');
        if (freshEtag) recentUserMessageEtags.set(key, freshEtag);
        recentUserMessageCache.set(key, payload);
        return payload;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as RecentUserMessagesPayload;
      const freshEtag = response.headers.get('ETag');
      if (freshEtag) recentUserMessageEtags.set(key, freshEtag);
      recentUserMessageCache.delete(key);
      recentUserMessageCache.set(key, payload);
      while (recentUserMessageCache.size > 64) {
        const oldestKey = recentUserMessageCache.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        recentUserMessageCache.delete(oldestKey);
        recentUserMessageEtags.delete(oldestKey);
      }
      return payload;
    })
    .finally(() => { recentUserMessageRequests.delete(key); });
  recentUserMessageRequests.set(key, request);
  return request;
}

