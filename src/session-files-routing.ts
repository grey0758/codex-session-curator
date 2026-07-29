export interface FilesPageRoute {
  sessionId: string | null;
  machineId: string | null;
  agent: SessionAgent | null;
}

export interface TerminalPageRoute {
  sessionId: string | null;
  machineId: string | null;
  agent: SessionAgent | null;
}

export type SessionAgent = 'codex' | 'claude';

function readAgent(params: URLSearchParams): SessionAgent | null {
  const agent = params.get('agent');
  return agent === 'codex' || agent === 'claude' ? agent : null;
}

export function readFilesPageRoute(href = window.location.href): FilesPageRoute {
  try {
    const params = new URL(href).searchParams;
    return {
      sessionId: params.get('files'),
      machineId: params.get('machine') ?? params.get('machineId'),
      agent: readAgent(params),
    };
  } catch {
    return { sessionId: null, machineId: null, agent: null };
  }
}

export function readTerminalPageRoute(
  href = window.location.href
): TerminalPageRoute {
  try {
    const params = new URL(href).searchParams;
    return {
      sessionId: params.get('terminal'),
      machineId: params.get('machine') ?? params.get('machineId'),
      agent: readAgent(params),
    };
  } catch {
    return { sessionId: null, machineId: null, agent: null };
  }
}

export function filesPageUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent,
  href = window.location.href
): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('files', sessionId);
  url.searchParams.set('machine', machineId);
  url.searchParams.set('agent', agent);
  return url.toString();
}

export function terminalPageUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent,
  href = window.location.href
): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('terminal', sessionId);
  url.searchParams.set('machine', machineId);
  url.searchParams.set('agent', agent);
  return url.toString();
}

function sessionApiPath(sessionId: string, suffix = ''): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function apiUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent,
  suffix: string,
  configure?: (params: URLSearchParams) => void
): string {
  const params = new URLSearchParams({ machineId, agent });
  configure?.(params);
  return `${sessionApiPath(sessionId, suffix)}?${params.toString()}`;
}

export function sessionFilesDetailUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent
): string {
  return apiUrl(sessionId, machineId, agent, '');
}

export function sessionFilesListUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent,
  path = ''
): string {
  return apiUrl(sessionId, machineId, agent, '/files', (params) => {
    if (path) params.set('path', path);
  });
}

export function sessionFileDownloadUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent,
  path: string
): string {
  return apiUrl(sessionId, machineId, agent, '/files/download', (params) => {
    params.set('path', path);
  });
}

export function sessionFileUploadUrl(
  sessionId: string,
  machineId: string,
  agent: SessionAgent,
  path: string,
  name: string
): string {
  return apiUrl(sessionId, machineId, agent, '/files/upload', (params) => {
    params.set('path', path);
    params.set('name', name);
    params.set('overwrite', '1');
  });
}
