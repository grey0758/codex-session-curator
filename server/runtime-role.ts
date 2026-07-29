export type CuratorRole = 'hub' | 'worker';

export interface CuratorCapabilities {
  panel: boolean;
  knowledge: boolean;
  contextPack: boolean;
  evaluation: boolean;
  serverIdentity: boolean;
  remoteAggregation: boolean;
  sessions: boolean;
  jobs: boolean;
  recycleBin: boolean;
  files: boolean;
  terminal: boolean;
  agents: Array<'codex' | 'claude'>;
}

const HUB_ONLY_API_PREFIXES = [
  '/api/commander-actions',
  '/api/knowledge',
  '/api/hermes/knowledge-search',
  '/api/hermes/knowledge-document',
  '/api/context-pack',
  '/api/hermes/context-pack',
  '/api/hermes/dispatch',
  '/api/analysis-runs',
  '/api/server-identity',
  '/api/evaluations',
  '/api/remote-agents',
  '/api/audit/fleet',
  '/api/sessions/ai-search',
];

export function getCuratorRole(): CuratorRole {
  return process.env.CURATOR_ROLE?.trim().toLowerCase() === 'worker' ? 'worker' : 'hub';
}

export function getCuratorCapabilities(role: CuratorRole): CuratorCapabilities {
  const isHub = role === 'hub';
  return {
    panel: isHub,
    knowledge: isHub,
    contextPack: isHub,
    evaluation: isHub,
    serverIdentity: isHub,
    remoteAggregation: isHub,
    sessions: true,
    jobs: true,
    recycleBin: true,
    files: true,
    terminal: true,
    agents: ['codex', 'claude'],
  };
}

function normalizedApiPath(rawUrl: string): string {
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
  return pathname.replace(/^\/api\/codex(?=\/|$)/, '/api/hermes');
}

export function isHubOnlyApiPath(rawUrl: string): boolean {
  const pathname = normalizedApiPath(rawUrl);
  return HUB_ONLY_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
