import cors from '@fastify/cors';
import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  getCodexHome,
  getStatePath,
  sameResolvedPath,
  type RecycleArchive,
} from './file-ops.js';
import type { KnowledgeStore } from './knowledge-store.js';
import { parseSessionHistory } from './session-parser.js';
import {
  RemoteAgentHttpError,
  checkRemoteAgent,
  deleteAgentJson,
  deleteAgentSession,
  fetchAgentJson,
  fetchAgentSessions,
  getRemoteAgents,
  hasPendingHubEvaluation,
  postAgentJson,
  shouldQueueHubRemoteEvaluation,
} from './remote-agents.js';
import {
  SessionService,
  UnsupportedSessionMigrationError,
  parseSessionStateKey,
  sessionStateKey,
} from './session-service.js';
import { compareSessionVisibility, readSessionAuditEvents, recordSessionAuditEvent } from './session-audit.js';
import { CuratorStore } from './store.js';
import { startCodexTerminal, type TerminalInput } from './terminal.js';
import type {
  AgentKind,
  CodexSession,
  CommanderAction,
  Evaluation,
  KnowledgeItem,
  KnowledgeItemType,
  KnowledgeProposalChange,
  KnowledgeProposalPublishMode,
  PersistedState,
  RemoteEvaluationInput,
  SessionCompletenessReport,
} from './types.js';
import {
  exportServerIdentityInventory,
  getServerIdentityMachine,
  listServerIdentityMachines,
  patchServerIdentityMachine,
  renderServerIdentitySshConfig,
  upsertServerIdentityMachine,
} from './server-identity.js';
import {
  getCodexResumeJob,
  listCodexJobEvents,
  listCodexResumeJobs,
  recordCodexJobAudit,
  sendCodexJobGuidance,
  sendCodexJobProtocolMessage,
  startCodexResumeJob,
  startCodexSupervisorLoop,
  stopCodexResumeJob,
  superviseCodexResumeJob,
  type CodexJobProtocolKind,
  type CodexResumeJob,
  type CodexJobMode,
} from './codex-jobs.js';
import { evaluateJobSemantics } from './job-supervisor-ai.js';
import { buildContextPack, type ContextKnowledgeItem } from './context-pack.js';
import {
  AiSearchUnavailableError,
  findMentionedMachineIds,
  rankAiSearchCandidates,
  scoreAiSearchCandidate,
  type AiSearchCandidate,
  type AiSearchMachineProfile,
} from './ai-session-search.js';
import { searchKnowledgeGateway, type KnowledgeGatewayMatch } from './knowledge-gateway-client.js';
import {
  getCanonicalKnowledgeRepoPath,
  readCanonicalKnowledgeDocument,
} from './knowledge-documents.js';
import {
  getCuratorCapabilities,
  getCuratorRole,
  isHubOnlyApiPath,
} from './runtime-role.js';
import {
  classifyProposalRisk,
  executeKnowledgeProposal,
  isProposalApplyConfigured,
  KnowledgeProposalApplyError,
  normalizeProposalChanges,
  proposalApplyTokenMatches,
  proposalPayloadMatches,
} from './knowledge-proposals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function redactRequestUrl(url: string | undefined): string | undefined {
  return url?.replace(/([?&](?:admin_token|token)=)[^&]+/gi, '$1[redacted]');
}

const app = Fastify({
  logger: {
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactRequestUrl(request.url),
          host: request.headers.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        };
      },
    },
  },
});
const curatorRole = getCuratorRole();
const curatorCapabilities = getCuratorCapabilities(curatorRole);
const codexHome = getCodexHome();
const store = new CuratorStore(getStatePath(codexHome));
const knowledgeStore = await (async (): Promise<KnowledgeStore | null> => {
  if (curatorRole !== 'hub') return null;
  const { getKnowledgeDbPath, KnowledgeStore: HubKnowledgeStore } = await import('./knowledge-store.js');
  return new HubKnowledgeStore(getKnowledgeDbPath(codexHome));
})();
const service = new SessionService(store);
const remoteAgents = curatorRole === 'hub' ? getRemoteAgents() : [];

function requireKnowledgeStore(): KnowledgeStore {
  if (!knowledgeStore) throw new Error('Knowledge store is unavailable in worker role');
  return knowledgeStore;
}

let knowledgeProposalApplyQueue: Promise<void> = Promise.resolve();

function enqueueKnowledgeProposalApply(id: string, publishMode: KnowledgeProposalPublishMode): void {
  const run = async () => {
    const proposal = await requireKnowledgeStore().getProposal(id);
    if (!proposal || proposal.status !== 'applying') return;
    try {
      const outcome = await executeKnowledgeProposal(proposal, publishMode);
      await requireKnowledgeStore().finishProposalApply(id, 'applied', outcome.result, outcome.warning);
      app.log.info({ proposalId: id, publishMode, publishStatus: outcome.result.publish.status }, 'Knowledge proposal applied');
    } catch (error) {
      const status = error instanceof KnowledgeProposalApplyError && error.kind === 'conflict' ? 'conflict' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      await requireKnowledgeStore().finishProposalApply(id, status, null, message.slice(0, 4000));
      app.log.error({ proposalId: id, publishMode, status, error }, 'Knowledge proposal apply failed');
    }
  };
  knowledgeProposalApplyQueue = knowledgeProposalApplyQueue.then(run, run).catch((error) => {
    app.log.error({ proposalId: id, error }, 'Knowledge proposal queue failed');
  });
}

const sessionCacheTtlMs = Number(process.env.CURATOR_SESSION_CACHE_TTL_MS || 60_000);
const remoteSessionCacheTtlMs = Number(process.env.CURATOR_REMOTE_SESSION_CACHE_TTL_MS || 60_000);
const defaultHermesStaleOutputMs = Number(process.env.CURATOR_HERMES_STALE_OUTPUT_MS || 2 * 60 * 1000);
const defaultHermesMaxRuntimeMs = Number(process.env.CURATOR_HERMES_MAX_RUNTIME_MS || 10 * 60 * 1000);
type RefreshableCache<T> = {
  expiresAt: number;
  promise: Promise<T>;
  refreshing: Promise<void> | null;
};
let localSessionsCache: RefreshableCache<Awaited<ReturnType<SessionService['listSessions']>>> | null = null;
let localFastSessionsCache: RefreshableCache<Awaited<ReturnType<SessionService['listSessions']>>> | null = null;
let remoteSessionsCache: RefreshableCache<Awaited<ReturnType<typeof fetchAgentSessions>>[]> | null = null;
const remoteJobRegistryCache = new Map<
  string,
  {
    expiresAt: number;
    updatedAt: string;
    healthy: boolean;
    jobs: Array<{ machineId: string; baseUrl: string | null; job: CodexResumeJob }>;
    error: string | null;
  }
>();
let autoBackfillRunning = false;

type EvaluationRefreshJobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface EvaluationRefreshJob {
  id: string;
  sessionId: string;
  machineId: string;
  agent: AgentKind | null;
  reason: string;
  status: EvaluationRefreshJobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: {
    id: string;
    machineId: string;
    status: Evaluation['status'];
    title: string;
    model: string;
    error: string | null;
    runId: string;
    transcriptHash: string;
    evaluationOrigin?: Evaluation['evaluationOrigin'];
  } | null;
  error: string | null;
}

const evaluationRefreshJobs = new Map<string, EvaluationRefreshJob>();
const evaluationRefreshQueue: string[] = [];
let runningEvaluationRefreshJobs = 0;

const keepSchema = z.object({
  kept: z.boolean(),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const titleSchema = z.object({
  title: z.string().max(120),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const loginSchema = z.object({ username: z.string().min(1).max(120), password: z.string().min(1).max(300) });
const migrateSchema = z.object({
  targetProjectDir: z.string().min(1).max(1000),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const confirmSchema = z.object({ confirm: z.literal(true) });
const backfillSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  includeFailed: z.boolean().optional(),
});
const evaluationRefreshSchema = z.object({
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const importedEvaluationSchema = z.custom<Evaluation>((value) => {
  if (!value || typeof value !== 'object') return false;
  const evaluation = value as Partial<Evaluation>;
  return Boolean(
    typeof evaluation.title === 'string' &&
    typeof evaluation.summary === 'string' &&
    typeof evaluation.detailedSummary === 'string' &&
    typeof evaluation.model === 'string' &&
    (evaluation.status === 'ok' || evaluation.status === 'fallback' || evaluation.status === 'failed') &&
    Array.isArray(evaluation.reasons) &&
    Array.isArray(evaluation.actualWorkdirs),
  );
}, 'Invalid evaluation payload');
const hubEvaluationImportSchema = z.object({
  hubMachineId: z.string().min(1).max(300),
  agent: z.enum(['codex', 'claude']),
  runId: z.string().min(1).max(160),
  transcriptHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().min(1).max(500),
  evaluation: importedEvaluationSchema,
});
const auditQuerySchema = z.object({
  sessionId: z.string().min(1).max(160).optional(),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const fleetAuditQuerySchema = z.object({
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
});
const bulkDeleteRouteSchema = z.object({
  id: z.string().min(1).max(160),
  machineId: z.string().min(1).max(300),
  agent: z.enum(['codex', 'claude']).optional(),
});
const bulkDeleteSchema = z
  .object({
    confirm: z.literal(true),
    ids: z.array(z.string().min(1).max(160)).min(1).max(200).optional(),
    sessions: z.array(bulkDeleteRouteSchema).min(1).max(200).optional(),
  })
  .refine((body) => Boolean(body.ids?.length || body.sessions?.length), {
    message: 'ids or sessions is required',
  });
const sessionIdSchema = z.object({ id: z.string().min(1).max(160) });
const machineRouteQuerySchema = z.object({
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const recycleArchiveRouteQuerySchema = machineRouteQuerySchema.extend({
  archiveDir: z.string().min(1).max(4096).optional(),
});
const hermesSearchSchema = z.object({
  q: z.string().min(1).transform((value) => value.slice(0, 1000)),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const aiSessionSearchSchema = z.object({
  query: z.string().trim().min(2).max(1000),
  limit: z.number().int().min(1).max(20).optional(),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['all', 'codex', 'claude']).optional(),
});
const jobPolicySchema = z.record(z.string(), z.unknown());
const taskTemplateSchema = z.enum(['fix', 'test', 'deploy', 'review', 'migrate', 'investigate']).optional();
const policyProfileSchema = z
  .enum(['read_only', 'code_edit', 'test_only', 'deploy_allowed', 'dangerous_ops_allowed'])
  .optional();
const supervisorStrategySchema = z
  .object({
    autoStop: z.boolean().optional(),
    autoRetry: z.boolean().optional(),
    checkIntervalMs: z.number().int().min(250).max(3_600_000).optional(),
    staleOutputMs: z.number().int().min(1_000).max(86_400_000).optional(),
    retryMode: z.enum(['exec', 'pty']).optional(),
  })
  .passthrough();
const resumeJobSchema = z.object({
  sessionId: z.string().min(1).max(160),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
  prompt: z.string().min(1).max(20_000),
  model: z.string().min(1).max(120).optional(),
  extraArgs: z.array(z.string().min(1).max(300)).max(20).optional(),
  mode: z.enum(['exec', 'pty']).optional(),
  supervisor: z.union([z.boolean(), supervisorStrategySchema]).optional(),
  policy: jobPolicySchema.optional(),
  policyProfile: policyProfileSchema,
  template: taskTemplateSchema,
});
const hermesDispatchSchema = z.object({
  query: z.string().min(1).max(2000),
  prompt: z.string().min(1).max(20_000).optional(),
  sessionId: z.string().min(1).max(160).optional(),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
  cwd: z.string().min(1).max(1000).optional(),
  repo: z.string().min(1).max(1000).optional(),
  model: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(10).optional(),
  requireConfirmationBelowScore: z.number().int().min(0).max(100).optional(),
  extraArgs: z.array(z.string().min(1).max(300)).max(20).optional(),
  mode: z.enum(['exec', 'pty']).optional(),
  supervisor: z.union([z.boolean(), supervisorStrategySchema]).optional(),
  policy: jobPolicySchema.optional(),
  policyProfile: policyProfileSchema,
  template: taskTemplateSchema,
});
const jobGuidanceSchema = z.object({
  text: z.string().min(1).max(20_000),
  source: z.enum(['hermes', 'supervisor', 'api']).optional(),
});
const jobEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const jobProtocolSchema = z.object({
  kind: z.enum(['guide', 'pause', 'continue', 'summarize', 'handoff', 'verify']),
  text: z.string().max(20_000).optional().default(''),
});
const jobSupervisorSchema = z.object({
  instruction: z.string().min(1).max(20_000).optional(),
  autoStop: z.boolean().optional(),
  autoRetry: z.boolean().optional(),
  checkIntervalMs: z.number().int().min(250).max(3_600_000).optional(),
  staleOutputMs: z.number().int().min(1_000).max(86_400_000).optional(),
  retryMode: z.enum(['exec', 'pty']).optional(),
  semantic: z.boolean().optional(),
});
const sessionContextSchema = z.object({
  historyLimit: z.coerce.number().int().min(0).max(80).optional(),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const sessionIdentityQuerySchema = z.object({
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const sessionFilesQuerySchema = z.object({
  path: z.string().max(2000).optional().default(''),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const sessionFileUploadQuerySchema = z.object({
  path: z.string().max(2000).optional().default(''),
  name: z.string().min(1).max(255),
  overwrite: z.enum(['0', '1', 'true', 'false']).optional(),
  machineId: z.string().min(1).max(300).optional(),
  agent: z.enum(['codex', 'claude']).optional(),
});
const remoteControlSchema = z.object({
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const includeDeprecatedSchema = z.object({
  includeDeprecated: z.enum(['0', '1', 'true', 'false']).optional(),
});
const hermesSessionIndexSchema = z.object({
  q: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const contextPackSchema = z.object({
  q: z.string().max(1000).optional(),
  cwd: z.string().min(1).max(1000).optional(),
  repo: z.string().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  remote: z.enum(['0', '1', 'true', 'false']).optional(),
});
const commanderActionKindSchema = z.enum(['direct-action', 'self-repair', 'manual-note']);
const commanderActionStatusSchema = z.enum(['started', 'completed', 'failed', 'blocked']);
const commanderActionArraySchema = z.array(z.string().min(1).max(1000)).max(200).optional();
const commanderActionCreateSchema = z.object({
  kind: commanderActionKindSchema,
  status: commanderActionStatusSchema.optional(),
  goal: z.string().min(1).max(5000),
  reason: z.string().min(1).max(5000),
  scope: z.string().min(1).max(5000).nullable().optional(),
  targetRepo: z.string().min(1).max(1000).nullable().optional(),
  cwd: z.string().min(1).max(1000).nullable().optional(),
  changedFiles: commanderActionArraySchema,
  tests: commanderActionArraySchema,
  verification: commanderActionArraySchema,
  followUp: z.string().min(1).max(5000).nullable().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});
const commanderActionUpdateSchema = z.object({
  kind: commanderActionKindSchema.optional(),
  status: commanderActionStatusSchema.optional(),
  goal: z.string().min(1).max(5000).optional(),
  reason: z.string().min(1).max(5000).optional(),
  scope: z.string().min(1).max(5000).nullable().optional(),
  targetRepo: z.string().min(1).max(1000).nullable().optional(),
  cwd: z.string().min(1).max(1000).nullable().optional(),
  changedFiles: commanderActionArraySchema,
  tests: commanderActionArraySchema,
  verification: commanderActionArraySchema,
  followUp: z.string().min(1).max(5000).nullable().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});
const serverIdentityAliasSchema = z.object({ alias: z.string().min(1).max(120) });
const serverIdentityMachineSchema = z
  .object({
    alias: z.string().min(1).max(120),
    aliases: z.array(z.string().min(1).max(120)).optional(),
    status: z.enum(['active', 'deprecated']).optional(),
    region: z.string().max(120).nullable().optional(),
    public_dns: z.string().max(300).nullable().optional(),
    public_ip: z.string().max(120).nullable().optional(),
    ssh_user: z.string().max(120).optional(),
    ssh_users: z.array(z.string().min(1).max(120)).optional(),
    ssh_port: z.number().int().min(1).max(65535).optional(),
    frp_hostname: z.string().max(300).nullable().optional(),
    frp_port: z.number().int().min(1).max(65535).nullable().optional(),
    tailscale_hostname: z.string().max(300).nullable().optional(),
    tailscale_ip: z.string().max(120).nullable().optional(),
    priority: z.array(z.enum(['public', 'frp', 'tailscale'])).min(1).max(3).optional(),
    verified_hostname: z.string().max(300).nullable().optional(),
    verified_at: z.string().max(80).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    identity_file: z.string().max(500).nullable().optional(),
    identity_public_key_ref: z.string().max(500).nullable().optional(),
    host_key_alias: z.string().max(300).nullable().optional(),
  })
  .strict();
const serverIdentityPatchSchema = serverIdentityMachineSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'patch body must not be empty',
});
const knowledgeItemTypeSchema = z.enum([
  'project',
  'preference',
  'service',
  'runbook',
  'decision',
  'session',
  'job',
  'commander_action',
  'note',
]);
const knowledgeItemBaseSchema = {
  type: knowledgeItemTypeSchema,
  scope: z.string().max(1000).nullable().optional(),
  title: z.string().min(1).max(1000),
  text: z.string().min(1).max(100_000),
  project: z.string().max(1000).nullable().optional(),
  repo: z.string().max(1000).nullable().optional(),
  cwd: z.string().max(2000).nullable().optional(),
  machineId: z.string().max(300).nullable().optional(),
  tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  source: z.string().max(5000).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  lastVerifiedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
};
const knowledgeItemCreateSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  ...knowledgeItemBaseSchema,
  createdAt: z.string().datetime().optional(),
});
const knowledgeItemUpdateSchema = z.object(knowledgeItemBaseSchema).partial();
const knowledgeSearchSchema = z.object({
  q: z.string().max(1000).optional(),
  type: z.union([knowledgeItemTypeSchema, z.array(knowledgeItemTypeSchema)]).optional(),
  project: z.string().max(1000).optional(),
  repo: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const knowledgeDocumentQuerySchema = z.object({
  path: z.string().min(1).max(2000),
});
const knowledgeProposalStatusSchema = z.enum(['pending', 'applying', 'applied', 'rejected', 'conflict', 'failed']);
const knowledgeProposalChangeSchema = z.object({
  path: z.string().min(1).max(2000),
  operation: z.enum(['upsert', 'delete']),
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  content: z.string().max(1_000_000).nullable(),
  mode: z.enum(['100644', '100755']),
});
const knowledgeProposalCreateSchema = z.object({
  localId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  baseSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().min(1).max(5000),
  sourceMachineId: z.string().min(1).max(300),
  sourceSessionId: z.string().min(1).max(300).nullable().optional(),
  changes: z.array(knowledgeProposalChangeSchema).min(1).max(50),
});
const knowledgeProposalListSchema = z.object({
  status: knowledgeProposalStatusSchema.optional(),
  sourceMachineId: z.string().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const knowledgeProposalApplySchema = z.object({
  publish: z.enum(['none', 'workers', 'fleet']).optional().default('none'),
});
const knowledgeProposalRejectSchema = z.object({
  reason: z.string().min(1).max(5000),
});

type SessionListItem = Awaited<ReturnType<SessionService['listSessions']>>[number];
let supervisorSessionCache: SessionListItem[] = [];

function toSessionSummary(session: SessionListItem) {
  const preview = (message: SessionListItem['lastUserMessage']) =>
    message ? { ...message, text: message.text.slice(0, 600) } : null;
  return {
    ...session,
    lastUserMessage: preview(session.lastUserMessage),
    lastAssistantMessage: preview(session.lastAssistantMessage),
    evaluation: {
      ...session.evaluation,
      detailedSummary: '',
      searchText: session.evaluation.searchText.slice(0, 1_500),
      reasons: session.evaluation.reasons.slice(0, 2),
      actualWorkdirs: session.evaluation.actualWorkdirs.slice(0, 4),
      directoryIndex: (session.evaluation.directoryIndex ?? []).slice(0, 16),
      techStack: (session.evaluation.techStack ?? []).slice(0, 12),
      keywords: (session.evaluation.keywords ?? []).slice(0, 18),
      reviewSignals: (session.evaluation.reviewSignals ?? []).slice(0, 3),
      remoteMachines: session.evaluation.remoteMachines.slice(0, 3),
    },
  };
}

function applyPanelSessionState<T extends CodexSession>(session: T, state: PersistedState): T {
  if (session.machineId !== service.getMeta().machineId) return session;
  const stateKey = sessionStateKey(session.id, session.agent);
  const customTitle = state.titles[stateKey] ?? session.customTitle ?? null;
  return {
    ...session,
    title: customTitle || session.title,
    customTitle,
    kept: state.keptIds.includes(stateKey) || session.kept,
  };
}

function sessionSearchText(session: SessionListItem): string {
  return [
    session.id,
    session.title,
    session.resumeCommand,
    session.cwd ?? '',
    session.machineId,
    session.lastUserMessage?.text ?? '',
    session.lastAssistantMessage?.text ?? '',
    session.evaluation.summary,
    session.evaluation.detailedSummary,
    session.evaluation.searchText ?? '',
    ...session.evaluation.actualWorkdirs,
    ...(session.evaluation.directoryIndex ?? []),
    ...(session.evaluation.techStack ?? []),
    ...(session.evaluation.keywords ?? []),
    ...(session.evaluation.failureCards ?? []).flatMap((card) => [card.category, card.title, card.summary, card.evidence]),
    ...(session.evaluation.jobOutcomes ?? []).flatMap((outcome) => [
      outcome.status,
      outcome.goal,
      outcome.cwd ?? '',
      outcome.summary,
      outcome.failureReason ?? '',
      outcome.nextAction ?? '',
      ...outcome.changedFiles,
      ...outcome.tests,
    ]),
    session.evaluation.recommendedWorkdir ?? '',
    ...session.evaluation.remoteMachines.map((machine) =>
      [machine.label, machine.host, machine.ip, machine.user, machine.evidence].filter(Boolean).join(' ')
    ),
  ]
    .join(' ')
    .toLowerCase();
}

function cleanRelativeWorkdirPath(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw || raw === '.') return '';
  if (raw.includes('\0') || isAbsolute(raw)) throw new Error('Invalid path');
  const cleaned = normalize(raw);
  if (!cleaned || cleaned === '.') return '';
  if (cleaned.startsWith('..') || cleaned.includes(`${sep}..${sep}`)) throw new Error('Path escapes session cwd');
  return cleaned;
}

function safeFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid file name');
  }
  return trimmed;
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveSessionWorkdirPath(session: SessionListItem, requestedPath = '') {
  if (!session.cwd) throw new Error('Session has no cwd');
  const baseReal = await realpath(session.cwd);
  const relativePath = cleanRelativeWorkdirPath(requestedPath);
  const target = resolve(baseReal, relativePath || '.');
  const targetReal = await realpath(target);
  if (!isInsidePath(baseReal, targetReal)) throw new Error('Path escapes session cwd');
  return { baseReal, relativePath, targetReal };
}

async function resolveSessionUploadPath(session: SessionListItem, requestedPath: string, fileName: string) {
  if (!session.cwd) throw new Error('Session has no cwd');
  const baseReal = await realpath(session.cwd);
  const relativePath = cleanRelativeWorkdirPath(requestedPath);
  const directory = resolve(baseReal, relativePath || '.');
  const directoryReal = await realpath(directory);
  if (!isInsidePath(baseReal, directoryReal)) throw new Error('Upload path escapes session cwd');
  const target = resolve(directoryReal, safeFileName(fileName));
  if (!isInsidePath(baseReal, target)) throw new Error('Upload target escapes session cwd');
  return { baseReal, directoryReal, target, relativePath };
}

function fileEntryPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

async function listSessionWorkdir(session: SessionListItem, requestedPath = '') {
  const { baseReal, relativePath, targetReal } = await resolveSessionWorkdirPath(session, requestedPath);
  const targetStat = await stat(targetReal);
  if (!targetStat.isDirectory()) throw new Error('Path is not a directory');
  const entries = await Promise.all(
    (await readdir(targetReal, { withFileTypes: true })).map(async (entry) => {
      const fullPath = join(targetReal, entry.name);
      const info = await stat(fullPath).catch(() => null);
      const entryRelativePath = fileEntryPath(relativePath, entry.name);
      return {
        name: entry.name,
        path: entryRelativePath,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: info?.size ?? null,
        mtime: info?.mtime.toISOString() ?? null,
      };
    })
  );
  entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  const parent = relativePath ? dirname(relativePath).replace(/\\/g, '/') : null;
  return {
    sessionId: session.id,
    machineId: session.machineId,
    cwd: session.cwd,
    root: baseReal,
    path: relativePath,
    parent: parent === '.' ? '' : parent,
    entries,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envNameForMachine(machineId: string | null | undefined): string | null {
  const normalized = machineId?.trim().replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return normalized ? `CURATOR_TERMINAL_SSH_TARGET_${normalized}` : null;
}

function sshTargetForSession(session: Pick<SessionListItem, 'machineId'>): string | null {
  const machineEnvName = envNameForMachine(session.machineId);
  const configured = (machineEnvName ? process.env[machineEnvName] : null) || process.env.CURATOR_TERMINAL_SSH_TARGET;
  return configured?.trim() || null;
}

function remotePythonCommand(script: string, args: string[]): string {
  return `python3 -c ${shellQuote(script)} ${args.map(shellQuote).join(' ')}`;
}

function runRemoteJson<T>(target: string, script: string, args: string[], input?: Buffer): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remotePythonCommand(script, args)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(err || `remote ssh command failed with code ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(out) as T);
      } catch (error) {
        reject(error);
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

const remoteResolvePrelude = String.raw`
import json, os, shutil, sys
def fail(message, code=2):
    print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
    sys.exit(code)
def safe_rel(value):
    value = (value or "").strip()
    if "\x00" in value or os.path.isabs(value):
        fail("Invalid path")
    if value in ("", "."):
        return ""
    norm = os.path.normpath(value)
    if norm == ".":
        return ""
    if norm.startswith("..") or "/../" in norm:
        fail("Path escapes session cwd")
    return norm
def safe_name(value):
    value = (value or "").strip()
    if not value or "\x00" in value or "/" in value or "\\" in value or value in (".", ".."):
        fail("Invalid file name")
    return value
def inside(base, target):
    return target == base or target.startswith(base.rstrip(os.sep) + os.sep)
base_arg = sys.argv[1]
rel_arg = sys.argv[2] if len(sys.argv) > 2 else ""
if not base_arg:
    fail("Session has no cwd")
base = os.path.realpath(base_arg)
rel = safe_rel(rel_arg)
target = os.path.realpath(os.path.join(base, rel or "."))
if not inside(base, target):
    fail("Path escapes session cwd")
`;

const remoteListScript = `${remoteResolvePrelude}
if not os.path.isdir(target):
    fail("Path is not a directory")
entries = []
for name in os.listdir(target):
    full = os.path.join(target, name)
    try:
        st = os.lstat(full)
        if os.path.isdir(full) and not os.path.islink(full):
            typ = "directory"
        elif os.path.isfile(full) and not os.path.islink(full):
            typ = "file"
        elif os.path.islink(full):
            typ = "symlink"
        else:
            typ = "other"
        entries.append({
            "name": name,
            "path": (rel + "/" + name) if rel else name,
            "type": typ,
            "size": st.st_size,
            "mtime": __import__("datetime").datetime.fromtimestamp(st.st_mtime, __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        })
    except OSError:
        continue
entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
parent = None if not rel else os.path.dirname(rel)
print(json.dumps({"root": base, "path": rel, "parent": "" if parent == "." else parent, "entries": entries}))
`;

const remoteStatScript = `${remoteResolvePrelude}
if not os.path.isfile(target):
    fail("Path is not a file")
st = os.stat(target)
print(json.dumps({"name": os.path.basename(target), "size": st.st_size}))
`;

const remoteDownloadScript = `${remoteResolvePrelude}
if not os.path.isfile(target):
    fail("Path is not a file")
with open(target, "rb") as handle:
    shutil.copyfileobj(handle, sys.stdout.buffer)
`;

const remoteUploadScript = `${remoteResolvePrelude}
name = safe_name(sys.argv[3] if len(sys.argv) > 3 else "")
overwrite = (sys.argv[4] if len(sys.argv) > 4 else "0") in ("1", "true")
if not os.path.isdir(target):
    fail("Upload path is not a directory")
dest_candidate = os.path.join(target, name)
if os.path.islink(dest_candidate):
    fail("Upload target must not be a symlink")
dest = os.path.realpath(dest_candidate)
if not inside(base, dest):
    fail("Upload target escapes session cwd")
flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
flags |= os.O_TRUNC if overwrite else os.O_EXCL
fd = os.open(dest, flags, 0o644)
with os.fdopen(fd, "wb") as handle:
    shutil.copyfileobj(sys.stdin.buffer, handle)
st = os.stat(dest)
entry_path = (rel + "/" + name) if rel else name
print(json.dumps({"ok": True, "entry": {"name": name, "path": entry_path, "type": "file", "size": st.st_size, "mtime": __import__("datetime").datetime.fromtimestamp(st.st_mtime, __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")}}))
`;

async function listRemoteSessionWorkdir(session: SessionListItem, requestedPath = '') {
  const target = sshTargetForSession(session);
  if (!target) throw new Error(`No SSH target configured for machine ${session.machineId || 'unknown'}`);
  const result = await runRemoteJson<{ root: string; path: string; parent: string | null; entries: unknown[] }>(target, remoteListScript, [
    session.cwd || '',
    requestedPath,
  ]);
  return {
    sessionId: session.id,
    machineId: session.machineId,
    cwd: session.cwd,
    ...result,
  };
}

async function statRemoteSessionFile(session: SessionListItem, requestedPath = '') {
  const target = sshTargetForSession(session);
  if (!target) throw new Error(`No SSH target configured for machine ${session.machineId || 'unknown'}`);
  return {
    target,
    ...(await runRemoteJson<{ name: string; size: number }>(target, remoteStatScript, [session.cwd || '', requestedPath])),
  };
}

function spawnRemoteFileDownload(target: string, session: SessionListItem, requestedPath = '') {
  return spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remotePythonCommand(remoteDownloadScript, [session.cwd || '', requestedPath])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function uploadRemoteSessionFile(session: SessionListItem, requestedPath: string, fileName: string, overwrite: boolean, body: Buffer) {
  const target = sshTargetForSession(session);
  if (!target) throw new Error(`No SSH target configured for machine ${session.machineId || 'unknown'}`);
  const result = await runRemoteJson<{ ok: boolean; entry: unknown }>(
    target,
    remoteUploadScript,
    [session.cwd || '', requestedPath, fileName, overwrite ? '1' : '0'],
    body
  );
  return result;
}

function aiSearchSessionKey(session: Pick<SessionListItem, 'id' | 'agent' | 'machineId'>): string {
  return `${session.machineId || 'unknown'}|||${session.agent}|||${session.id}`;
}

function aiSearchCandidateFields(
  session: SessionListItem,
): Omit<AiSearchCandidate, 'candidateId' | 'localScore'> {
  return {
    sessionId: session.id,
    machineId: session.machineId,
    agent: session.agent,
    title: session.title,
    summary: session.evaluation.summary,
    detailedSummary: session.evaluation.detailedSummary,
    cwd: session.cwd,
    keywords: session.evaluation.keywords ?? [],
    techStack: session.evaluation.techStack ?? [],
    updatedAt: session.updatedAt,
    lastUserMessage: session.lastUserMessage?.text ?? '',
    kept: session.kept,
  };
}

function buildAiSearchMachineProfiles(
  sessions: SessionListItem[],
  query: string,
): AiSearchMachineProfile[] {
  const sessionsByMachine = new Map<string, SessionListItem[]>();
  for (const session of sessions) {
    const machineSessions = sessionsByMachine.get(session.machineId) ?? [];
    machineSessions.push(session);
    sessionsByMachine.set(session.machineId, machineSessions);
  }
  return [...sessionsByMachine.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([machineId, machineSessions]) => {
      const scored = machineSessions.map((session) => ({
        session,
        fields: aiSearchCandidateFields(session),
        localScore: scoreAiSearchCandidate(aiSearchCandidateFields(session), query),
        updatedAtMs: Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0,
      }));
      const byLexicalScore = [...scored].sort(
        (a, b) => b.localScore - a.localScore || b.updatedAtMs - a.updatedAtMs,
      );
      const byRecency = [...scored].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      const representatives: typeof scored = [];
      const seen = new Set<string>();
      const append = (items: typeof scored, limit: number) => {
        for (const item of items) {
          const key = aiSearchSessionKey(item.session);
          if (seen.has(key)) continue;
          seen.add(key);
          representatives.push(item);
          if (representatives.length >= limit) return;
        }
      };
      append(byLexicalScore.filter((item) => item.localScore > 0), 6);
      append(byRecency, 10);
      const agentCounts: AiSearchMachineProfile['agentCounts'] = {};
      for (const session of machineSessions) {
        agentCounts[session.agent] = (agentCounts[session.agent] ?? 0) + 1;
      }
      return {
        machineId,
        sessionCount: machineSessions.length,
        agentCounts,
        examples: representatives.map(({ fields, localScore }) => ({
          agent: fields.agent,
          title: fields.title,
          summary: fields.summary,
          cwd: fields.cwd,
          keywords: fields.keywords,
          updatedAt: fields.updatedAt,
          localScore,
        })),
      };
    });
}

function selectAiSearchCandidates(
  sessions: SessionListItem[],
  query: string,
  candidateLimit: number,
): Array<{ session: SessionListItem; localScore: number }> {
  const scored = sessions.map((session) => ({
    session,
    localScore: scoreAiSearchCandidate(aiSearchCandidateFields(session), query),
    updatedAtMs: Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0,
  }));
  const byLexicalScore = [...scored].sort(
    (a, b) =>
      b.localScore - a.localScore ||
      b.updatedAtMs - a.updatedAtMs ||
      b.session.evaluation.score - a.session.evaluation.score,
  );
  const byRecency = [...scored].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || b.session.evaluation.score - a.session.evaluation.score,
  );
  const kept = byRecency.filter((item) => item.session.kept);
  const selected: typeof scored = [];
  const seen = new Set<string>();
  const append = (items: typeof scored, limit: number) => {
    let appended = 0;
    for (const item of items) {
      const key = aiSearchSessionKey(item.session);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(item);
      appended += 1;
      if (selected.length >= candidateLimit) return;
      if (appended >= limit) return;
    }
  };

  const machineIds = [...new Set(sessions.map((session) => session.machineId))].sort();
  if (machineIds.length > 1) {
    const perMachineLimit = Math.max(3, Math.min(8, Math.floor(candidateLimit / (machineIds.length * 2))));
    for (const machineId of machineIds) {
      const lexical = byLexicalScore.filter(
        (item) => item.session.machineId === machineId && item.localScore > 0,
      );
      const recent = byRecency.filter((item) => item.session.machineId === machineId);
      append(lexical, perMachineLimit);
      const selectedForMachine = selected.filter((item) => item.session.machineId === machineId).length;
      if (selectedForMachine < perMachineLimit) {
        append(recent, perMachineLimit - selectedForMachine);
      }
    }
  }
  append(byLexicalScore.filter((item) => item.localScore > 0), Math.max(24, candidateLimit - 18));
  if (selected.length < candidateLimit) append(kept, 8);
  if (selected.length < candidateLimit) append(byRecency, 12);
  if (selected.length < candidateLimit) append(byLexicalScore, candidateLimit);
  return selected.slice(0, candidateLimit).map(({ session, localScore }) => ({ session, localScore }));
}

function selectAiSearchCandidatesForRoute(
  sessions: SessionListItem[],
  query: string,
  candidateLimit: number,
  preferredMachineIds: string[],
  confidence: number,
): Array<{ session: SessionListItem; localScore: number }> {
  const preferred = new Set(preferredMachineIds);
  const allMachineIds = new Set(sessions.map((session) => session.machineId));
  if (
    confidence < 0.62 ||
    preferred.size === 0 ||
    preferred.size >= allMachineIds.size
  ) {
    return selectAiSearchCandidates(sessions, query, candidateLimit);
  }

  const preferredSessions = sessions.filter((session) => preferred.has(session.machineId));
  const safetySessions = sessions.filter((session) => !preferred.has(session.machineId));
  const safetyLimit = safetySessions.length
    ? Math.max(4, Math.round(candidateLimit * (confidence >= 0.9 ? 0.12 : 0.22)))
    : 0;
  const focused = selectAiSearchCandidates(preferredSessions, query, candidateLimit - safetyLimit);
  const safety = selectAiSearchCandidates(safetySessions, query, safetyLimit);
  return [...focused, ...safety].slice(0, candidateLimit);
}

function localAiSearchConfidence(score: number, hasLexicalMatches: boolean): number {
  if (!hasLexicalMatches) return 0.18;
  return Number(Math.min(0.86, 0.38 + (score / (score + 30)) * 0.48).toFixed(2));
}

function scoreHermesMatch(session: SessionListItem, query: string): number {
  const haystack = sessionSearchText(session);
  const terms = query
    .toLowerCase()
    .split(/[\s,，。/\\|:：;；()[\]{}"'`]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  let score = 0;
  if (haystack.includes(query.toLowerCase())) score += 12;
  if (session.id.includes(query)) score += 30;
  for (const term of terms) {
    if (session.id.toLowerCase().includes(term)) score += 12;
    if (session.title.toLowerCase().includes(term)) score += 8;
    if ((session.cwd ?? '').toLowerCase().includes(term)) score += 6;
    if (session.evaluation.summary.toLowerCase().includes(term)) score += 5;
    if (session.evaluation.detailedSummary.toLowerCase().includes(term)) score += 4;
    if ((session.evaluation.techStack ?? []).some((item) => item.toLowerCase().includes(term))) score += 3;
    if ((session.evaluation.keywords ?? []).some((item) => item.toLowerCase().includes(term))) score += 3;
  }
  if (session.activityStatus === 'active') score += 2;
  if (session.kept) score += 2;
  return score;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。/\\|:：;；()[\]{}"'`]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreDocumentMatch(document: {
  id: string;
  title: string;
  text: string;
  machineId?: string | null;
  sessionId?: string | null;
}, query: string): number {
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  const haystack = [document.id, document.title, document.text, document.machineId ?? '', document.sessionId ?? '']
    .join(' ')
    .toLowerCase();
  let score = haystack.includes(needle) ? 10 : 0;
  for (const term of queryTerms(query)) {
    if (haystack.includes(term)) score += 3;
    if (document.title.toLowerCase().includes(term)) score += 2;
    if (document.id.toLowerCase().includes(term)) score += 2;
  }
  return score;
}

function toHermesSession(session: SessionListItem, query = '') {
  const hermesRefreshStatus =
    session.evaluation.hermesRefreshStatus ?? (session.evaluation.hermesNeedsRefresh ? 'pending' : 'never');
  return {
    id: session.id,
    agent: session.agent,
    title: session.title,
    summary: session.evaluation.summary,
    detailedSummary: session.evaluation.detailedSummary,
    hermesContext: session.evaluation.hermesContext ?? '',
    hermesContextUpdatedAt: session.evaluation.hermesContextUpdatedAt ?? null,
    hermesLastUsedAt: session.evaluation.hermesLastUsedAt ?? null,
    hermesLastJobId: session.evaluation.hermesLastJobId ?? null,
    hermesNeedsRefresh: hermesRefreshStatus === 'failed' ? true : session.evaluation.hermesNeedsRefresh ?? false,
    hermesRecalculatedAt: session.evaluation.hermesRecalculatedAt ?? null,
    hermesRefreshStatus,
    hermesRefreshError: session.evaluation.hermesRefreshError ?? null,
    workflow: session.evaluation.workflow,
    model: session.evaluation.model,
    status: session.evaluation.status,
    error: session.evaluation.error,
    evaluationOrigin: session.evaluation.evaluationOrigin ?? null,
    evaluatedByMachineId: session.evaluation.evaluatedByMachineId ?? null,
    evaluationRunId: session.evaluation.evaluationRunId ?? null,
    transcriptHash: session.evaluation.transcriptHash ?? null,
    recommendation: session.evaluation.recommendation,
    score: query ? scoreHermesMatch(session, query) : session.evaluation.score,
    cwd: session.cwd,
    machineId: session.machineId,
    updatedAt: session.updatedAt,
    activityStatus: session.activityStatus,
    resumeCommand: session.agent === 'claude'
      ? `claude --resume ${session.id}`
      : session.cwd
        ? `codex resume -C ${session.cwd} ${session.id}`
        : session.resumeCommand,
    canResume: Boolean(session.cwd && !session.deleted),
    actualWorkdirs: session.evaluation.actualWorkdirs,
    recommendedWorkdir: session.evaluation.recommendedWorkdir,
    directoryIndex: session.evaluation.directoryIndex,
    techStack: session.evaluation.techStack,
    keywords: session.evaluation.keywords,
    failureCards: session.evaluation.failureCards ?? [],
    jobOutcomes: session.evaluation.jobOutcomes ?? [],
    remoteMachines: session.evaluation.remoteMachines,
    messageCount: session.messageCount,
    userTurns: session.userTurns,
    assistantTurns: session.assistantTurns,
    lastUserMessage: session.lastUserMessage,
    lastAssistantMessage: session.lastAssistantMessage,
  };
}

function toHermesSessionIndexEntry(session: SessionListItem, query = '') {
  const base = toHermesSession(session, query);
  return {
    id: base.id,
    agent: base.agent,
    title: base.title,
    machineId: base.machineId,
    cwd: base.cwd,
    recommendedWorkdir: base.recommendedWorkdir,
    resumeCommand: base.resumeCommand,
    canResume: base.canResume,
    updatedAt: base.updatedAt,
    activityStatus: base.activityStatus,
    score: base.score,
    recommendation: base.recommendation,
    summary: base.summary,
    directoryIndex: base.directoryIndex,
    actualWorkdirs: base.actualWorkdirs,
    keywords: base.keywords,
    techStack: base.techStack,
    remoteMachines: base.remoteMachines,
    messageCount: base.messageCount,
    userTurns: base.userTurns,
    assistantTurns: base.assistantTurns,
    workflow: base.workflow,
    status: base.status,
    hermesRefreshStatus: base.hermesRefreshStatus,
    evaluationOrigin: base.evaluationOrigin,
    evaluatedByMachineId: base.evaluatedByMachineId,
    evaluationRunId: base.evaluationRunId,
    transcriptHash: base.transcriptHash,
    preferredAction: base.canResume ? 'resume' : 'inspect',
  };
}

function isUsableAbsoluteWorkdir(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.trim().length > 1;
}

function effectiveJobCwd(session: Pick<SessionListItem, 'cwd' | 'evaluation'>): string | null {
  const recommended = session.evaluation.recommendedWorkdir;
  if (isUsableAbsoluteWorkdir(recommended)) return recommended;
  return session.cwd ?? null;
}

function withEffectiveJobCwd<T extends SessionListItem>(session: T): T {
  const cwd = effectiveJobCwd(session);
  if (!cwd || cwd === session.cwd) return session;
  return { ...session, cwd };
}

function withEffectiveHermesSessionCwd<T extends ReturnType<typeof toHermesSession>>(session: T): T {
  const cwd = isUsableAbsoluteWorkdir(session.recommendedWorkdir) ? session.recommendedWorkdir : session.cwd;
  if (!cwd || cwd === session.cwd) return session;
  return {
    ...session,
    cwd,
    resumeCommand: session.agent === 'claude' ? `claude --resume ${session.id}` : `codex resume -C ${cwd} ${session.id}`,
  };
}

function normalizedPathMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = (left ?? '').trim().toLowerCase().replace(/\/+$/, '');
  const b = (right ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function scoreRequestedSessionPath(session: SessionListItem, input: { cwd?: string | null; repo?: string | null }): number {
  const paths = [session.cwd, session.evaluation.recommendedWorkdir, ...session.evaluation.actualWorkdirs].filter(Boolean);
  let score = 0;
  if (input.cwd && paths.some((path) => normalizedPathMatch(path, input.cwd))) score += 60;
  if (input.repo && paths.some((path) => normalizedPathMatch(path, input.repo))) score += 50;
  return score;
}

function truncateWorkerContext(value: string | null | undefined, max = 900): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function stateSessionActivity(updatedAt: string | null | undefined): {
  activityStatus: 'active' | 'inactive';
  lastActiveAt: string | null;
  inactiveDays: number | null;
} {
  if (!updatedAt) return { activityStatus: 'inactive', lastActiveAt: null, inactiveDays: null };
  const elapsed = Date.now() - Date.parse(updatedAt);
  const inactiveDays = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 86_400_000)) : null;
  return {
    activityStatus: inactiveDays !== null && inactiveDays <= 3 ? 'active' : 'inactive',
    lastActiveAt: updatedAt,
    inactiveDays,
  };
}

async function getStateSessionsForHermes(): Promise<SessionListItem[]> {
  const state = await service.ensureLegacyStateMigrated();
  const machineId = service.getMeta().machineId;
  return Object.entries(state.evaluations)
    .flatMap(([stateKey, evaluation]) => {
      const identity = parseSessionStateKey(stateKey);
      if (!identity || state.deletedIds.includes(stateKey)) return [];
      const { sessionId: id, agent } = identity;
      const activity = stateSessionActivity(evaluation.updatedAt ?? evaluation.evaluatedAt);
      return [{
        id,
        agent,
        filePath: evaluation.filePath,
        cwd: evaluation.cwd ?? null,
        startedAt: evaluation.startedAt ?? null,
        updatedAt: evaluation.updatedAt ?? evaluation.evaluatedAt,
        bytes: evaluation.bytes,
        messageCount: evaluation.messageCount ?? 0,
        userTurns: evaluation.userTurns ?? 0,
        assistantTurns: evaluation.assistantTurns ?? 0,
        lastUserMessage: evaluation.lastUserMessage ?? null,
        lastAssistantMessage: evaluation.lastAssistantMessage ?? null,
        shellSnapshotCount: evaluation.shellSnapshotCount ?? 0,
        title: state.titles[stateKey] || evaluation.title || evaluation.summary || id,
        customTitle: state.titles[stateKey] ?? null,
        resumeCommand: agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`,
        machineId,
        kept: state.keptIds.includes(stateKey),
        deleted: false,
        evaluation,
        ...activity,
      }];
    });
}

function buildHermesMemoryContext(sessions: ReturnType<typeof toHermesSession>[]): string {
  if (!sessions.length) return '';
  const lines = ['Agent Session Curator matched sessions:'];
  sessions.slice(0, 5).forEach((session, index) => {
    lines.push(
      `${index + 1}. ${session.title}`,
      `   agent: ${session.agent}`,
      `   id: ${session.id}`,
      `   machine: ${session.machineId}`,
      `   cwd: ${session.cwd ?? 'unknown'}`,
      `   resume: ${session.resumeCommand}`,
      `   summary: ${session.summary}`,
      session.detailedSummary ? `   detail: ${session.detailedSummary}` : '',
      session.lastUserMessage ? `   last_user: ${session.lastUserMessage.text.slice(0, 700)}` : '',
      session.lastAssistantMessage ? `   last_agent: ${session.lastAssistantMessage.text.slice(0, 700)}` : '',
      session.techStack.length ? `   tech: ${session.techStack.join(', ')}` : '',
      session.jobOutcomes.length
        ? `   recent_jobs: ${session.jobOutcomes.slice(0, 3).map((job) => `${job.status}:${job.summary}`).join(' / ')}`
        : '',
      ''
    );
  });
  return lines.filter(Boolean).join('\n');
}

function hermesKnowledgeIdentity(machineId: string, agent: AgentKind, sessionId: string): string {
  return [machineId, agent, sessionId].map((part) => encodeURIComponent(part)).join(':');
}

function buildHermesSearchDocuments(session: SessionListItem) {
  const base = toHermesSession(session);
  const identity = hermesKnowledgeIdentity(base.machineId, base.agent, base.id);
  const docs = [
    {
      id: `${identity}:session-index`,
      legacyIds: [`${base.id}:session-index`],
      kind: 'session_index',
      sessionId: base.id,
      machineId: base.machineId,
      agent: base.agent,
      title: `Session index: ${base.title}`,
      text: [
        `machineId: ${base.machineId}`,
        `agent: ${base.agent}`,
        `sessionId: ${base.id}`,
        base.id,
        base.title,
        base.resumeCommand,
        base.cwd ?? '',
        base.recommendedWorkdir ?? '',
        base.summary,
        ...base.actualWorkdirs,
        ...base.directoryIndex,
        ...base.techStack,
        ...base.keywords,
      ].filter(Boolean).join('\n'),
      updatedAt: base.updatedAt,
    },
    {
      id: `${identity}:session`,
      legacyIds: [`${base.id}:session`],
      kind: 'session',
      sessionId: base.id,
      machineId: base.machineId,
      agent: base.agent,
      title: base.title,
      text: [
        `machineId: ${base.machineId}`,
        `agent: ${base.agent}`,
        `sessionId: ${base.id}`,
        base.summary,
        base.detailedSummary,
        base.lastUserMessage?.text,
        base.lastAssistantMessage?.text,
        base.cwd,
        ...base.techStack,
        ...base.keywords,
      ].filter(Boolean).join('\n'),
      updatedAt: base.updatedAt,
    },
    ...base.jobOutcomes.map((outcome) => ({
      id: `${identity}:job:${outcome.jobId}`,
      legacyIds: [`${base.id}:job:${outcome.jobId}`],
      kind: 'job_outcome',
      sessionId: base.id,
      jobId: outcome.jobId,
      machineId: outcome.machineId || base.machineId,
      agent: base.agent,
      title: `${base.agent} worker ${outcome.status}: ${base.title}`,
      text: [
        `machineId: ${base.machineId}`,
        `agent: ${base.agent}`,
        `sessionId: ${base.id}`,
        outcome.summary,
      ].join('\n'),
      updatedAt: outcome.at,
    })),
    ...base.failureCards.map((card) => ({
      id: `${identity}:failure:${card.jobId}:${card.category}`,
      legacyIds: [`${base.id}:failure:${card.jobId}:${card.category}`],
      kind: 'failure_card',
      sessionId: base.id,
      jobId: card.jobId,
      machineId: base.machineId,
      agent: base.agent,
      title: card.title,
      text: [
        `machineId: ${base.machineId}`,
        `agent: ${base.agent}`,
        `sessionId: ${base.id}`,
        card.summary,
        card.evidence,
      ].filter(Boolean).join('\n'),
      updatedAt: card.at,
    })),
  ];
  return docs;
}

function buildCommanderActionSearchDocument(action: CommanderAction) {
  return {
    id: `commander-action:${action.id}`,
    kind: 'commander_action',
    actionId: action.id,
    actionKind: action.kind,
    status: action.status,
    machineId: service.getMeta().machineId,
    title: `Commander ${action.kind}: ${action.goal.slice(0, 120)}`,
    text: [
      action.goal,
      action.reason,
      action.scope ?? '',
      action.targetRepo ?? '',
      action.cwd ?? '',
      ...action.changedFiles,
      ...action.tests,
      ...action.verification,
      action.followUp ?? '',
    ].filter(Boolean).join('\n'),
    updatedAt: action.completedAt ?? action.startedAt,
  };
}

function projectNameFromDocumentText(text: string): string | null {
  const path = text
    .split(/\s+/)
    .find((part) => part.startsWith('/') && part.split('/').filter(Boolean).length > 1);
  if (!path) return null;
  const clean = path.replace(/[,;:]+$/, '').replace(/\/+$/, '');
  return clean.split('/').filter(Boolean).at(-1) ?? null;
}

function knowledgeTypeForDocument(kind: string): KnowledgeItemType {
  if (kind === 'commander_action') return 'commander_action';
  if (kind === 'job_outcome') return 'job';
  if (kind === 'session' || kind === 'session_index') return 'session';
  return 'note';
}

type KnowledgeSyncItem = Omit<KnowledgeItem, 'createdAt' | 'updatedAt'> & {
  updatedAt: string | null;
  legacyIds?: string[];
};

function toKnowledgeItem(document: ReturnType<typeof buildHermesSearchDocuments>[number] | ReturnType<typeof buildCommanderActionSearchDocument>): KnowledgeSyncItem {
  const cwd = 'cwd' in document && typeof document.cwd === 'string' ? document.cwd : null;
  const sessionId = 'sessionId' in document && typeof document.sessionId === 'string' ? document.sessionId : null;
  const agent = 'agent' in document && typeof document.agent === 'string' ? document.agent : null;
  return {
    id: document.id,
    type: knowledgeTypeForDocument(document.kind),
    scope: document.kind,
    title: document.title,
    text: document.text,
    project: projectNameFromDocumentText(document.text),
    repo: null,
    cwd,
    machineId: 'machineId' in document ? document.machineId ?? null : service.getMeta().machineId,
    updatedAt: document.updatedAt ?? null,
    tags: [document.kind, sessionId ?? '', agent ?? '', 'machineId' in document ? document.machineId ?? '' : ''].filter(Boolean),
    source: 'curator:auto-sync',
    confidence: 0.75,
    lastVerifiedAt: document.updatedAt ?? null,
    ...('legacyIds' in document ? { legacyIds: document.legacyIds } : {}),
  };
}

async function syncKnowledgeItems(items: KnowledgeSyncItem[]): Promise<void> {
  if (!knowledgeStore || !items.length) return;
  for (const syncItem of items) {
    const { legacyIds = [], ...item } = syncItem;
    try {
      for (const legacyId of legacyIds) {
        if (legacyId === item.id) continue;
        const legacy = await knowledgeStore.getItem(legacyId);
        if (legacy?.source === 'curator:auto-sync') {
          await knowledgeStore.deleteItem(legacyId);
        }
      }
      const existing = await knowledgeStore.getItem(item.id);
      if (existing) {
        await knowledgeStore.updateItem(item.id, {
          type: item.type,
          scope: item.scope,
          title: item.title,
          text: item.text,
          project: item.project,
          repo: item.repo,
          cwd: item.cwd,
          machineId: item.machineId,
          tags: item.tags,
          source: item.source,
          confidence: item.confidence,
          lastVerifiedAt: item.lastVerifiedAt,
          updatedAt: item.updatedAt ?? new Date().toISOString(),
        });
      } else {
        await knowledgeStore.createItem({
          ...item,
          updatedAt: item.updatedAt ?? undefined,
        });
      }
    } catch (error) {
      app.log.warn({ itemId: item.id, error }, 'Knowledge item sync failed');
    }
  }
}

function toContextKnowledgeItem(item: ReturnType<typeof toKnowledgeItem> | KnowledgeItem): ContextKnowledgeItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    text: item.text,
    project: item.project,
    cwd: item.cwd,
    repo: item.repo,
    updatedAt: item.updatedAt,
    tags: item.tags,
  };
}
function buildCodexWorkerPrompt(input: {
  query: string;
  prompt?: string;
  session: ReturnType<typeof toHermesSession>;
  template?: z.infer<typeof taskTemplateSchema>;
  policyProfile?: PolicyProfile;
  contextPackText?: string | null;
}): string {
  const task = input.prompt?.trim() || input.query.trim();
  const workerName = input.session.agent === 'claude' ? 'Claude Code' : 'Codex CLI';
  const templateRules: Record<NonNullable<z.infer<typeof taskTemplateSchema>>, string[]> = {
    fix: [
      '- 按 bug 修复任务处理：先复现或定位根因，再做最小改动。',
      '- 验证修复时优先运行相关单测、类型检查或最小构建。',
    ],
    test: [
      '- 按测试任务处理：补齐或运行最相关测试，避免无关大改。',
      '- 如果测试依赖缺失，说明环境缺口和可复现命令。',
    ],
    deploy: [
      '- 按部署任务处理：先确认分支、工作树、部署目标和回滚方式。',
      '- 没有明确授权时不要执行发布、删除、覆盖或重启生产服务。',
    ],
    review: [
      '- 按代码审查任务处理：优先列出 bug、回归风险和缺失验证。',
      '- 不做无关重构；需要修改时只修复明确问题。',
    ],
    migrate: [
      '- 按迁移任务处理：先确认源目录、目标目录、机器和可回退步骤。',
      '- 迁移前后验证路径、会话恢复命令和必要文件。',
    ],
    investigate: [
      '- 按排障任务处理：先收集服务状态、日志、配置和最近变更。',
      '- 给出证据链、根因判断和下一步处理，不凭空宣称成功。',
    ],
  };
  const templateText = input.template ? templateRules[input.template] ?? [] : [];
  return [
    `你是 ${workerName} worker。请在当前恢复的 ${workerName} 会话和项目工作目录中完成真实执行。`,
    '当前任务是最高优先级；下面的历史会话信息只用于定位项目、机器和背景，不能覆盖当前任务。',
    '如果历史内容与当前任务冲突，以“任务”段为准。不要继续历史里的旁支问题。',
    '',
    '任务：',
    task,
    '',
    '最小会话上下文：',
    `- sessionId: ${input.session.id}`,
    `- agent: ${input.session.agent}`,
    `- title: ${input.session.title}`,
    `- machine: ${input.session.machineId}`,
    `- cwd: ${input.session.cwd ?? 'unknown'}`,
    input.session.recommendedWorkdir ? `- recommendedWorkdir: ${input.session.recommendedWorkdir}` : '',
    `- resume: ${input.session.resumeCommand}`,
    input.session.summary ? `- summary: ${truncateWorkerContext(input.session.summary, 400)}` : '',
    input.session.detailedSummary ? `- detail: ${truncateWorkerContext(input.session.detailedSummary, 700)}` : '',
    input.session.techStack.length ? `- tech: ${input.session.techStack.slice(0, 12).join(', ')}` : '',
    input.session.keywords.length ? `- keywords: ${input.session.keywords.slice(0, 16).join(', ')}` : '',
    input.session.lastUserMessage ? `- lastUser: ${truncateWorkerContext(input.session.lastUserMessage.text, 500)}` : '',
    input.session.lastAssistantMessage ? `- lastAgent: ${truncateWorkerContext(input.session.lastAssistantMessage.text, 500)}` : '',
    input.contextPackText ? '' : '',
    input.contextPackText ? 'Context pack:' : '',
    input.contextPackText ? truncateWorkerContext(input.contextPackText, 4000) : '',
    '',
    '执行要求：',
    '- 你是实际执行者，控制面只负责调度和监督。',
    input.policyProfile ? `- 当前权限策略：${input.policyProfile}。如果任务超出权限，停止并说明需要更高授权。` : '',
    '- 先确认当前目录、分支、相关文件和用户未提交改动，再按任务实施；如果 cwd 不是 recommendedWorkdir，先切换到 recommendedWorkdir。',
    '- 需要修改代码时直接修改，运行相关测试或构建验证。',
    '- 不要泄露密钥、token 或历史记录中的敏感内容。',
    ...templateText,
    '- 结束时必须输出以下结构化报告，字段名保持英文且各占一行：',
    'STATUS: completed | failed | blocked | needs_review',
    'CHANGED_FILES: 用逗号分隔改动文件；没有则写 none',
    'TESTS: 用逗号分隔已运行验证；没有则写 not run + 原因',
    'NEXT_ACTION: 下一步建议；没有则写 none',
    '- 结构化报告之前可以用中文总结改动文件、验证结果、失败原因或剩余风险。',
  ]
    .filter(Boolean)
    .join('\n');
}

async function deleteSessionById(
  id: string,
  machineId?: string,
  sessionAgent?: AgentKind,
  includeRemote = true,
) {
  const routed = await findRoutableSession(id, machineId, sessionAgent, includeRemote);
  if (!routed) throw new Error(`Session not found: ${id}`);
  return deleteResolvedSession(routed);
}

async function deleteResolvedSession(
  routed: NonNullable<Awaited<ReturnType<typeof findRoutableSession>>>,
) {
  if (routed.kind === 'local') {
    return service.deleteSession(routed.session.id, routed.session.agent);
  }
  const remoteAgent = remoteAgents.find((candidate) => candidate.id === routed.session.machineId);
  if (!remoteAgent) throw new Error(`Remote machine not configured: ${routed.session.machineId}`);
  return deleteAgentSession(remoteAgent, routed.session.id, routed.session.agent);
}

async function deleteSessionsByIdsBulk(ids: string[], includeRemote: boolean) {
  const cleanIds = [...new Set(ids.filter(Boolean))];
  const resolved: Array<{
    id: string;
    route: NonNullable<Awaited<ReturnType<typeof findRoutableSession>>> | null;
  }> = [];

  // Resolve the complete legacy raw-id batch first. A 409/503 must leave every
  // session untouched, even if an earlier id happened to be uniquely routable.
  for (const id of cleanIds) {
    resolved.push({
      id,
      route: await findRoutableSession(id, undefined, undefined, includeRemote),
    });
  }

  const results: Array<{ id: string; ok: boolean; result?: unknown; error?: string }> = [];
  for (const { id, route } of resolved) {
    if (!route) {
      results.push({ id, ok: false, error: `Session not found: ${id}` });
      continue;
    }
    try {
      results.push({
        id,
        ok: true,
        result: await deleteResolvedSession(route),
      });
    } catch (error) {
      results.push({
        id,
        ok: false,
        error: error instanceof Error ? error.message : `Session not found: ${id}`,
      });
    }
  }
  return results;
}

async function deleteRoutedSessionsBulk(
  routes: Array<{ id: string; machineId: string; agent?: AgentKind }>,
) {
  const resolved: Array<{
    id: string;
    machineId: string;
    agent?: AgentKind;
    route: NonNullable<Awaited<ReturnType<typeof findRoutableSession>>> | null;
  }> = [];

  // Explicit composite routes still require an all-or-nothing routing
  // preflight. In particular, a later unavailable remote must not leave an
  // earlier local session already archived.
  for (const { id, machineId, agent } of routes) {
    resolved.push({
      id,
      machineId,
      agent,
      route: await findRoutableSession(id, machineId, agent),
    });
  }

  const results: Array<{
    id: string;
    machineId: string;
    agent?: AgentKind;
    ok: boolean;
    result?: unknown;
    error?: string;
  }> = [];
  for (const { id, machineId, agent, route } of resolved) {
    if (!route) {
      results.push({
        id,
        machineId,
        agent,
        ok: false,
        error: `Session not found: ${id}`,
      });
      continue;
    }
    try {
      results.push({
        id,
        machineId,
        agent,
        ok: true,
        result: await deleteResolvedSession(route),
      });
    } catch (error) {
      results.push({
        id,
        machineId,
        agent,
        ok: false,
        error: error instanceof Error ? error.message : 'Delete failed',
      });
    }
  }
  return results;
}

interface RoutedRecycleArchive extends RecycleArchive {
  machineId: string;
}

async function listRecycleArchivesAggregated(includeRemote: boolean): Promise<{
  archives: RoutedRecycleArchive[];
  errors: Array<{ machineId: string; error: string }>;
}> {
  const localMachineId = service.getMeta().machineId;
  const archives: RoutedRecycleArchive[] = (await service.listRecycleBin()).map((archive) => ({
    ...archive,
    machineId: localMachineId,
  }));
  const errors: Array<{ machineId: string; error: string }> = [];

  if (includeRemote) {
    const remoteResults = await Promise.all(remoteAgents.map(async (agent) => {
      try {
        const payload = await fetchAgentJson<{ archives?: RecycleArchive[] }>(agent, '/api/recycle-bin?remote=0');
        return {
          archives: (payload.archives ?? []).map((archive) => ({ ...archive, machineId: agent.id })),
          error: null,
        };
      } catch (error) {
        return {
          archives: [] as RoutedRecycleArchive[],
          error: error instanceof Error ? error.message : 'remote recycle bin unavailable',
        };
      }
    }));
    for (let index = 0; index < remoteResults.length; index += 1) {
      const remoteResult = remoteResults[index];
      archives.push(...remoteResult.archives);
      if (remoteResult.error) {
        errors.push({ machineId: remoteAgents[index].id, error: remoteResult.error });
      }
    }
  }

  archives.sort((a, b) => Date.parse(b.deletedAt ?? '') - Date.parse(a.deletedAt ?? ''));
  return { archives, errors };
}

interface RecycleArchiveRoute {
  machineId?: string;
  archiveDir?: string;
  agent?: AgentKind;
}

function recycleArchiveRemotePath(
  sessionId: string,
  action: 'restore' | 'purge',
  route: RecycleArchiveRoute,
): string {
  const query = new URLSearchParams({ remote: '0' });
  if (route.archiveDir) query.set('archiveDir', route.archiveDir);
  if (route.agent) query.set('agent', route.agent);
  const base = `/api/recycle-bin/${encodeURIComponent(sessionId)}`;
  return `${base}${action === 'restore' ? '/restore' : ''}?${query.toString()}`;
}

async function resolveRecycleArchiveRoute(
  sessionId: string,
  route: RecycleArchiveRoute,
  includeRemote: boolean,
): Promise<RecycleArchiveRoute> {
  if (route.machineId) return route;
  const { archives, errors } = await listRecycleArchivesAggregated(includeRemote);
  if (errors.length) {
    throw new SessionRoutingError(
      503,
      'REMOTE_RECYCLE_INVENTORY_UNAVAILABLE',
      `Remote recycle inventory unavailable: ${errors.map((error) => error.machineId).join(', ')}`,
      { machineIds: errors.map((error) => error.machineId) },
    );
  }
  const matches = archives.filter((archive) =>
    archive.sessionId === sessionId &&
    (!route.archiveDir || sameResolvedPath(archive.archiveDir, route.archiveDir)) &&
    (!route.agent || archive.agent === route.agent)
  );
  if (matches.length > 1) {
    throw new SessionRoutingError(
      409,
      'AMBIGUOUS_RECYCLE_ARCHIVE_IDENTITY',
      `Multiple recycle archives found for session ${sessionId}; machineId and archiveDir are required`,
      {
        candidates: matches.map((archive) => ({
          machineId: archive.machineId,
          archiveDir: archive.archiveDir,
          agent: archive.agent,
        })),
      },
    );
  }
  if (!matches.length) throw new Error(`Recycle archive not found: ${sessionId}`);
  const match = matches[0];
  return {
    machineId: match.machineId,
    archiveDir: match.archiveDir,
    agent: match.agent ?? undefined,
  };
}

async function restoreRecycleArchiveByMachine(
  sessionId: string,
  route: RecycleArchiveRoute,
  allowRemote: boolean,
) {
  const resolvedRoute = await resolveRecycleArchiveRoute(sessionId, route, allowRemote);
  const localMachineId = service.getMeta().machineId;
  if (resolvedRoute.machineId === localMachineId) {
    return service.restoreRecycleArchive(sessionId, resolvedRoute);
  }
  if (!allowRemote) {
    throw new Error(`Recycle archive not found: ${sessionId}`);
  }

  const candidates = resolvedRoute.machineId
    ? remoteAgents.filter((agent) => agent.id === resolvedRoute.machineId)
    : remoteAgents;
  if (resolvedRoute.machineId && !candidates.length) {
    throw new Error(`Remote machine not configured: ${resolvedRoute.machineId}`);
  }
  let lastError: unknown = null;
  for (const agent of candidates) {
    try {
      return await postAgentJson(
        agent,
        recycleArchiveRemotePath(sessionId, 'restore', resolvedRoute),
        { confirm: true },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Recycle archive not found: ${sessionId}`);
}

async function purgeRecycleArchiveByMachine(
  sessionId: string,
  route: RecycleArchiveRoute,
  allowRemote: boolean,
) {
  const resolvedRoute = await resolveRecycleArchiveRoute(sessionId, route, allowRemote);
  const localMachineId = service.getMeta().machineId;
  if (resolvedRoute.machineId === localMachineId) {
    return service.purgeRecycleArchive(sessionId, resolvedRoute);
  }
  if (!allowRemote) {
    throw new Error(`Recycle archive not found: ${sessionId}`);
  }

  const candidates = resolvedRoute.machineId
    ? remoteAgents.filter((agent) => agent.id === resolvedRoute.machineId)
    : remoteAgents;
  if (resolvedRoute.machineId && !candidates.length) {
    throw new Error(`Remote machine not configured: ${resolvedRoute.machineId}`);
  }
  let lastError: unknown = null;
  for (const agent of candidates) {
    try {
      return await deleteAgentJson(
        agent,
        recycleArchiveRemotePath(sessionId, 'purge', resolvedRoute),
        { confirm: true },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Recycle archive not found: ${sessionId}`);
}

async function pruneAggregatedSessions(
  includeRemote: boolean,
  predicate: (session: CodexSession) => boolean
) {
  const [localSessions, remoteInventory, panelState] = await Promise.all([
    getLocalSessionsCached(false, true),
    includeRemote
      ? getRemoteSessionsStrict()
      : Promise.resolve({ status: 'ok' as const, sessions: [] }),
    service.ensureLegacyStateMigrated(),
  ]);
  if (remoteInventory.status === 'unavailable') {
    throw new SessionRoutingError(
      503,
      'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
      `Remote session inventory unavailable: ${remoteInventory.machineIds.join(', ')}`,
      { machineIds: remoteInventory.machineIds },
    );
  }
  const targets = [...localSessions, ...remoteInventory.sessions]
    .map((session) => applyPanelSessionState(session, panelState))
    .filter((session) => !session.kept && predicate(session));
  const results = await deleteRoutedSessionsBulk(
    targets.map((session) => ({
      id: session.id,
      machineId: session.machineId,
      agent: session.agent,
    })),
  );
  return {
    matched: targets.length,
    deleted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

function clearSessionCaches(): void {
  localSessionsCache = null;
  localFastSessionsCache = null;
  remoteSessionsCache = null;
}

function expireSessionCaches(): void {
  if (localSessionsCache) localSessionsCache.expiresAt = 0;
  if (localFastSessionsCache) localFastSessionsCache.expiresAt = 0;
  if (remoteSessionsCache) remoteSessionsCache.expiresAt = 0;
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function publicEvaluationRefreshJob(job: EvaluationRefreshJob): EvaluationRefreshJob {
  return { ...job };
}

function trimEvaluationRefreshJobs(): void {
  const finished = [...evaluationRefreshJobs.values()]
    .filter((job) => job.status === 'completed' || job.status === 'failed')
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt));
  for (const job of finished.slice(100)) {
    evaluationRefreshJobs.delete(job.id);
  }
}

async function refreshRemoteSessionEvaluation(job: EvaluationRefreshJob) {
  const agent = remoteAgents.find((candidate) => candidate.id === job.machineId);
  if (!agent) throw new Error(`Remote machine not configured: ${job.machineId}`);
  const remote = await findRemoteSession(job.sessionId, job.machineId, job.agent);
  if (!remote) throw new Error(`Remote session not found: ${job.machineId}/${job.sessionId}`);

  const inputQuery = new URLSearchParams();
  if (job.agent) inputQuery.set('agent', job.agent);
  const input = await fetchAgentJson<RemoteEvaluationInput>(
    agent,
    `/api/worker/evaluation-input/${encodeURIComponent(job.sessionId)}${
      inputQuery.size ? `?${inputQuery.toString()}` : ''
    }`,
  );
  if (
    input.sessionId !== job.sessionId ||
    input.machineId !== job.machineId ||
    (job.agent && input.agent !== job.agent)
  ) {
    throw new Error(`Remote evaluation identity mismatch for ${job.machineId}/${job.sessionId}`);
  }
  await recordSessionAuditEvent({
    event: 'evaluation-started',
    sessionId: input.sessionId,
    machineId: input.machineId,
    agent: input.agent,
    runId: job.id,
    evaluationOrigin: 'hub-remote',
    transcriptHash: input.transcriptHash,
    messageCount: input.messageCount,
    userTurns: input.userTurns,
    assistantTurns: input.assistantTurns,
    bytes: input.bytes,
    mtimeMs: input.mtimeMs,
    model: null,
    status: 'running',
    error: null,
    details: { evaluatedByMachineId: service.getMeta().machineId, reason: job.reason },
  }).catch(() => undefined);

  try {
    const { evaluateSession } = await import('./evaluator.js');
    const evaluation = await evaluateSession({
      sessionId: input.sessionId,
      machineId: input.machineId,
      evaluatedByMachineId: service.getMeta().machineId,
      runId: job.id,
      evaluationOrigin: 'hub-remote',
      transcriptHash: input.transcriptHash,
      messages: input.messages,
      userTurns: input.userTurns,
      assistantTurns: input.assistantTurns,
      cwd: input.cwd,
    });
    await postAgentJson(agent, `/api/worker/evaluations/${encodeURIComponent(job.sessionId)}`, {
      hubMachineId: service.getMeta().machineId,
      agent: input.agent,
      runId: job.id,
      transcriptHash: input.transcriptHash,
      reason: job.reason,
      evaluation,
    });
    await recordSessionAuditEvent({
      event: evaluation.status === 'failed' ? 'evaluation-failed' : 'evaluation-completed',
      sessionId: input.sessionId,
      machineId: input.machineId,
      agent: input.agent,
      runId: job.id,
      evaluationOrigin: 'hub-remote',
      transcriptHash: input.transcriptHash,
      messageCount: input.messageCount,
      userTurns: input.userTurns,
      assistantTurns: input.assistantTurns,
      bytes: input.bytes,
      mtimeMs: input.mtimeMs,
      model: evaluation.model,
      status: evaluation.status,
      error: evaluation.error,
      details: { evaluatedByMachineId: service.getMeta().machineId, published: true },
    }).catch(() => undefined);
    return {
      id: input.sessionId,
      machineId: input.machineId,
      status: evaluation.status,
      title: evaluation.title,
      model: evaluation.model,
      error: evaluation.error,
      runId: job.id,
      transcriptHash: input.transcriptHash,
      evaluationOrigin: evaluation.evaluationOrigin,
    };
  } catch (error) {
    await recordSessionAuditEvent({
      event: 'evaluation-failed',
      sessionId: input.sessionId,
      machineId: input.machineId,
      agent: input.agent,
      runId: job.id,
      evaluationOrigin: 'hub-remote',
      transcriptHash: input.transcriptHash,
      messageCount: input.messageCount,
      userTurns: input.userTurns,
      assistantTurns: input.assistantTurns,
      bytes: input.bytes,
      mtimeMs: input.mtimeMs,
      model: null,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Remote evaluation failed',
      details: { evaluatedByMachineId: service.getMeta().machineId, published: false },
    }).catch(() => undefined);
    throw error;
  }
}

function processEvaluationRefreshQueue(): void {
  const concurrency = readIntEnv('CURATOR_REFRESH_QUEUE_CONCURRENCY', 2, 1, 8);
  while (runningEvaluationRefreshJobs < concurrency && evaluationRefreshQueue.length > 0) {
    const jobId = evaluationRefreshQueue.shift();
    if (!jobId) return;
    const job = evaluationRefreshJobs.get(jobId);
    if (!job || job.status !== 'queued') continue;

    runningEvaluationRefreshJobs += 1;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    void (async () => {
      try {
        const result = job.machineId === service.getMeta().machineId
          ? await service.refreshSessionEvaluation(job.sessionId, job.reason, job.agent)
          : await refreshRemoteSessionEvaluation(job);
        job.result = result;
        job.status = result.status === 'failed' ? 'failed' : 'completed';
        job.error = result.error ?? null;
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Refresh failed';
      } finally {
        job.completedAt = new Date().toISOString();
        runningEvaluationRefreshJobs = Math.max(0, runningEvaluationRefreshJobs - 1);
        expireSessionCaches();
        trimEvaluationRefreshJobs();
        processEvaluationRefreshQueue();
      }
    })();
  }
}

async function enqueueEvaluationRefresh(
  sessionId: string,
  reason: string,
  machineId = service.getMeta().machineId,
  agent: AgentKind | null = null,
): Promise<EvaluationRefreshJob> {
  const existing = [...evaluationRefreshJobs.values()].find(
    (job) =>
      job.sessionId === sessionId &&
      job.machineId === machineId &&
      job.agent === agent &&
      (job.status === 'queued' || job.status === 'running')
  );
  if (existing) return existing;

  const job: EvaluationRefreshJob = {
    id: randomUUID(),
    sessionId,
    machineId,
    agent,
    reason,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
  };
  evaluationRefreshJobs.set(job.id, job);
  evaluationRefreshQueue.push(job.id);
  if (machineId === service.getMeta().machineId) {
    if (agent) {
      await service.markSessionEvaluationRefreshQueued(sessionId, agent, reason);
    }
  } else {
    await recordSessionAuditEvent({
      event: 'evaluation-queued',
      sessionId,
      machineId,
      agent,
      runId: job.id,
      evaluationOrigin: 'hub-remote',
      transcriptHash: null,
      messageCount: null,
      userTurns: null,
      assistantTurns: null,
      bytes: null,
      mtimeMs: null,
      model: null,
      status: 'queued',
      error: null,
      details: { evaluatedByMachineId: service.getMeta().machineId, reason },
    }).catch(() => undefined);
  }
  expireSessionCaches();
  processEvaluationRefreshQueue();
  return job;
}

let remoteEvaluationBackfillRunning = false;
async function runRemoteEvaluationBackfill(reason: string): Promise<void> {
  if (curatorRole !== 'hub' || remoteEvaluationBackfillRunning || !remoteAgents.length) return;
  remoteEvaluationBackfillRunning = true;
  try {
    const workerAgents = (
      await Promise.all(remoteAgents.map(async (agent) => {
        try {
          const meta = await fetchAgentJson<{ role?: string }>(agent, '/api/meta');
          return meta.role === 'worker' ? agent : null;
        } catch {
          return null;
        }
      }))
    ).filter((agent): agent is (typeof remoteAgents)[number] => Boolean(agent));
    if (!workerAgents.length) return;
    const workerIds = new Set(workerAgents.map((agent) => agent.id));
    const workerSessions = (await getRemoteSessionsCached())
      .filter((session) => workerIds.has(session.machineId));
    const nowMs = Date.now();
    const quietMs = readIntEnv('CURATOR_EVALUATION_QUIET_MS', 60_000, 0, 24 * 60 * 60 * 1000);
    const skippedEmpty = workerSessions.filter(
      (session) => session.messageCount <= 0 && hasPendingHubEvaluation(session),
    ).length;
    const deferredActive = workerSessions.filter(
      (session) => shouldQueueHubRemoteEvaluation(session) &&
        !shouldQueueHubRemoteEvaluation(session, { nowMs, quietMs }),
    ).length;
    const sessions = workerSessions
      .filter((session) => shouldQueueHubRemoteEvaluation(session, { nowMs, quietMs }))
      .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
    const limit = readIntEnv('CURATOR_REMOTE_EVALUATION_LIMIT', 4, 1, 100);
    for (const session of sessions.slice(0, limit)) {
      await enqueueEvaluationRefresh(
        session.id,
        `remote-backfill:${reason}`,
        session.machineId,
        session.agent,
      );
    }
    app.log.info(
      {
        reason,
        candidates: sessions.length,
        queued: Math.min(limit, sessions.length),
        skippedEmpty,
        deferredActive,
        workers: [...workerIds],
      },
      'Remote worker evaluation backfill completed',
    );
  } catch (error) {
    app.log.warn({ reason, error }, 'Remote worker evaluation backfill failed');
  } finally {
    remoteEvaluationBackfillRunning = false;
  }
}

async function runAutoBackfill(reason: string): Promise<void> {
  if (autoBackfillRunning) return;
  autoBackfillRunning = true;
  try {
    const limit = readIntEnv('CURATOR_AUTO_BACKFILL_LIMIT', 8, 1, 200);
    const includeFailed = process.env.CURATOR_AUTO_BACKFILL_INCLUDE_FAILED === '1';
    const result = await service.backfillEvaluations({ limit, includeFailed });
    if (result.processed > 0) expireSessionCaches();
    app.log.info({ reason, ...result }, 'Auto evaluation backfill completed');
  } catch (error) {
    app.log.warn({ reason, error }, 'Auto evaluation backfill failed');
  } finally {
    autoBackfillRunning = false;
  }
}

let sessionAuditRunning = false;
async function runSessionAudit(reason: string): Promise<void> {
  if (sessionAuditRunning) return;
  sessionAuditRunning = true;
  try {
    if (curatorRole === 'hub') {
      const report = await buildFleetAuditReport();
      app.log.info({ reason, ...report.summary }, 'Fleet session completeness audit completed');
    } else {
      const report = await service.auditCompleteness();
      app.log.info({ reason, ...report.counts, issues: report.issues.length }, 'Worker session completeness audit completed');
    }
  } catch (error) {
    app.log.warn({ reason, error }, 'Session completeness audit failed');
  } finally {
    sessionAuditRunning = false;
  }
}

async function getLocalSessionsCached(refreshWorkflow: boolean, fast: boolean) {
  if (sessionCacheTtlMs <= 0) {
    clearSessionCaches();
    return service.listSessions({ refreshWorkflow, fast });
  }
  const now = Date.now();
  if (refreshWorkflow) {
    clearSessionCaches();
    const cache: RefreshableCache<Awaited<ReturnType<SessionService['listSessions']>>> = {
      expiresAt: now + sessionCacheTtlMs,
      promise: service.listSessions({ refreshWorkflow: true, fast }),
      refreshing: null,
    };
    if (fast) localFastSessionsCache = cache;
    else localSessionsCache = cache;
    return cache.promise;
  }
  let cache = fast ? localFastSessionsCache : localSessionsCache;
  if (!cache) {
    cache = {
      expiresAt: now + sessionCacheTtlMs,
      promise: service.listSessions({ refreshWorkflow: false, fast }),
      refreshing: null,
    };
    if (fast) localFastSessionsCache = cache;
    else localSessionsCache = cache;
    return cache.promise;
  }
  if (cache.expiresAt <= now && !cache.refreshing) {
    const target = cache;
    target.expiresAt = now + sessionCacheTtlMs;
    target.refreshing = service.listSessions({ refreshWorkflow: false, fast })
      .then((sessions) => {
        target.promise = Promise.resolve(sessions);
        target.expiresAt = Date.now() + sessionCacheTtlMs;
      })
      .catch((error) => {
        target.expiresAt = Date.now() + Math.min(sessionCacheTtlMs, 5_000);
        app.log.warn({ error, fast }, 'Background local session cache refresh failed');
      })
      .finally(() => {
        target.refreshing = null;
      });
  }
  return cache.promise;
}

class SessionRoutingError extends Error {
  statusCode: number;
  code: string;
  details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SessionRoutingError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function sendSessionRoutingError(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof SessionRoutingError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  return reply.code(404).send({
    error: error instanceof Error ? error.message : fallback,
  });
}

async function getRemoteSessionsCached() {
  if (!remoteAgents.length) return [];
  if (remoteSessionCacheTtlMs <= 0) return (await Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent)))).flat();
  const now = Date.now();
  if (!remoteSessionsCache) {
    remoteSessionsCache = {
      expiresAt: now + remoteSessionCacheTtlMs,
      promise: Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent))),
      refreshing: null,
    };
  } else if (remoteSessionsCache.expiresAt <= now && !remoteSessionsCache.refreshing) {
    const target = remoteSessionsCache;
    target.expiresAt = now + remoteSessionCacheTtlMs;
    target.refreshing = Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent)))
      .then((sessions) => {
        target.promise = Promise.resolve(sessions);
        target.expiresAt = Date.now() + remoteSessionCacheTtlMs;
      })
      .catch((error) => {
        target.expiresAt = Date.now() + Math.min(remoteSessionCacheTtlMs, 5_000);
        app.log.warn({ error }, 'Background remote session cache refresh failed');
      })
      .finally(() => {
        target.refreshing = null;
      });
  }
  return (await remoteSessionsCache.promise).flat();
}

async function getRemoteSessionsStrict(
  agents: typeof remoteAgents = remoteAgents,
): Promise<
  | { status: 'ok'; sessions: CodexSession[] }
  | { status: 'unavailable'; machineIds: string[] }
> {
  const results = await Promise.all(agents.map(async (agent) => {
    try {
      const payload = await fetchAgentJson<{ sessions?: CodexSession[] }>(
        agent,
        '/api/sessions?detail=0&remote=0',
      );
      return {
        agent,
        sessions: (payload.sessions ?? []).map((session) => ({
          ...session,
          machineId: session.machineId || agent.id,
        })),
        unavailable: false,
      };
    } catch {
      return { agent, sessions: [] as CodexSession[], unavailable: true };
    }
  }));
  const machineIds = results
    .filter((result) => result.unavailable)
    .map((result) => result.agent.id);
  if (machineIds.length) return { status: 'unavailable', machineIds };
  return { status: 'ok', sessions: results.flatMap((result) => result.sessions) };
}

function orderedRemoteAgents(preferredMachineId?: string | null) {
  const preferred = preferredMachineId?.trim();
  if (!preferred) return remoteAgents;
  return [
    ...remoteAgents.filter((agent) => agent.id === preferred),
    ...remoteAgents.filter((agent) => agent.id !== preferred),
  ];
}

async function findRemoteSession(
  sessionId: string,
  preferredMachineId?: string | null,
  preferredAgent?: AgentKind | null,
): Promise<{ agent: (typeof remoteAgents)[number]; session: CodexSession } | null> {
  const sessions = await getRemoteSessionsCached();
  for (const agent of orderedRemoteAgents(preferredMachineId)) {
    const session = sessions.find(
      (candidate) =>
        candidate.id === sessionId &&
        (!candidate.machineId || candidate.machineId === agent.id) &&
        (!preferredAgent || candidate.agent === preferredAgent)
    );
    if (!session) continue;
    return { agent, session: { ...session, machineId: session.machineId || agent.id } };
  }
  return null;
}

async function findRoutableSession(
  sessionId: string,
  preferredMachineId?: string | null,
  agent?: AgentKind | null,
  includeRemote = true,
): Promise<{ kind: 'local' | 'remote'; session: CodexSession } | null> {
  const resolution = await resolveHermesSession(
    {
      sessionId,
      machineId: preferredMachineId,
      agent,
    },
    includeRemote,
  );
  if (resolution.status === 'missing') return null;
  if (resolution.status === 'unavailable') {
    throw new SessionRoutingError(
      503,
      'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
      `Remote session inventory unavailable: ${resolution.machineIds.join(', ')}`,
      { machineIds: resolution.machineIds },
    );
  }
  if (resolution.status === 'ambiguous') {
    throw new SessionRoutingError(
      409,
      'AMBIGUOUS_SESSION_IDENTITY',
      `Ambiguous session identity: ${sessionId}`,
      { candidates: resolution.candidates },
    );
  }
  return {
    kind: resolution.session.machineId === service.getMeta().machineId ? 'local' : 'remote',
    session: resolution.session,
  };
}

async function buildFleetAuditReport(refreshRemoteCache = false) {
  if (refreshRemoteCache) remoteSessionsCache = null;
  const [localReport, localSessions, aggregatedRemoteSessions] = await Promise.all([
    service.auditCompleteness(),
    getLocalSessionsCached(false, true),
    getRemoteSessionsCached(),
  ]);
  const localVisibleIds = new Set(localSessions.map((session) => sessionStateKey(session.id, session.agent)));
  const localVisibility = compareSessionVisibility(localReport.sessionIds, localVisibleIds);
  const remotes = await Promise.all(remoteAgents.map(async (agent) => {
    try {
      const direct = await fetchAgentJson<{ sessions?: CodexSession[] }>(agent, '/api/sessions?detail=0&remote=0');
      const report = await fetchAgentJson<SessionCompletenessReport>(agent, '/api/audit/completeness');
      const directIds = new Set(
        (direct.sessions ?? []).map((session) => sessionStateKey(session.id, session.agent)),
      );
      const panelIds = new Set(
        aggregatedRemoteSessions
          .filter((session) => session.machineId === agent.id)
          .map((session) => sessionStateKey(session.id, session.agent)),
      );
      const directVisibility = compareSessionVisibility(report.sessionIds, directIds);
      const panelVisibility = compareSessionVisibility(report.sessionIds, panelIds);
      return {
        machineId: agent.id,
        healthy: true,
        error: null,
        report,
        directVisibleCount: directIds.size,
        panelVisibleCount: panelIds.size,
        missingFromRemoteApi: directVisibility.missing,
        missingFromPanel: panelVisibility.missing,
        unexpectedInPanel: panelVisibility.unexpected,
      };
    } catch (error) {
      return {
        machineId: agent.id,
        healthy: false,
        error: error instanceof Error ? error.message : 'Remote audit failed',
        report: null,
        directVisibleCount: 0,
        panelVisibleCount: aggregatedRemoteSessions.filter((session) => session.machineId === agent.id).length,
        missingFromRemoteApi: [],
        missingFromPanel: [],
        unexpectedInPanel: [],
      };
    }
  }));
  const remoteIssueCount = remotes.reduce(
    (total, remote) => total + (remote.report?.counts.actionableIssues ?? 0),
    0,
  );
  const eligibleSessions = localReport.counts.eligibleSessions + remotes.reduce(
    (total, remote) => total + (remote.report?.counts.eligibleSessions ?? 0),
    0,
  );
  const fullyEvaluatedSessions = localReport.counts.fullyEvaluatedSessions + remotes.reduce(
    (total, remote) => total + (remote.report?.counts.fullyEvaluatedSessions ?? 0),
    0,
  );
  const pendingEvaluationSessions = localReport.counts.pendingEvaluationSessions + remotes.reduce(
    (total, remote) => total + (remote.report?.counts.pendingEvaluationSessions ?? 0),
    0,
  );
  const metadataOnlySessions = localReport.counts.metadataOnlySessions + remotes.reduce(
    (total, remote) => total + (remote.report?.counts.metadataOnlySessions ?? 0),
    0,
  );
  const settledEligibleSessions = Math.max(0, eligibleSessions - pendingEvaluationSessions);
  const missingFromPanel = localVisibility.missing.length + remotes.reduce((total, remote) => total + remote.missingFromPanel.length, 0);
  return {
    generatedAt: new Date().toISOString(),
    hubMachineId: service.getMeta().machineId,
    summary: {
      machines: 1 + remotes.length,
      discoveredSessions: localReport.counts.parsedSessions + remotes.reduce((total, remote) => total + (remote.report?.counts.parsedSessions ?? 0), 0),
      eligibleSessions,
      fullyEvaluatedSessions,
      pendingEvaluationSessions,
      metadataOnlySessions,
      settledEligibleSessions,
      analysisCoveragePercent: eligibleSessions > 0
        ? Math.round((fullyEvaluatedSessions / eligibleSessions) * 10_000) / 100
        : 100,
      settledCoveragePercent: settledEligibleSessions > 0
        ? Math.round((fullyEvaluatedSessions / settledEligibleSessions) * 10_000) / 100
        : 100,
      localIssues: localReport.counts.actionableIssues,
      remoteIssues: remoteIssueCount,
      missingFromPanel,
      unhealthyRemotes: remotes.filter((remote) => !remote.healthy).length,
    },
    local: {
      report: localReport,
      panelVisibleCount: localVisibleIds.size,
      missingFromPanel: localVisibility.missing,
      unexpectedInPanel: localVisibility.unexpected,
    },
    remotes,
  };
}

async function fetchRemoteJobRegistryCached(agent: (typeof remoteAgents)[number]): Promise<{
  jobs: Array<{ machineId: string; baseUrl: string | null; job: CodexResumeJob }>;
  health: { machineId: string; baseUrl: string; healthy: boolean; updatedAt: string; cached: boolean; error: string | null };
}> {
  const ttlMs = readIntEnv('CURATOR_REMOTE_JOB_REGISTRY_TTL_MS', 10_000, 0, 300_000);
  const now = Date.now();
  const cached = remoteJobRegistryCache.get(agent.id);
  if (cached && ttlMs > 0 && cached.expiresAt > now) {
    return {
      jobs: cached.jobs,
      health: {
        machineId: agent.id,
        baseUrl: agent.baseUrl,
        healthy: cached.healthy,
        updatedAt: cached.updatedAt,
        cached: true,
        error: cached.error,
      },
    };
  }

  try {
    const payload = await fetchAgentJson<{
      jobs?: Array<{ machineId?: string; baseUrl?: string | null; job?: CodexResumeJob }>;
    }>(agent, '/api/hermes/job-registry?remote=0');
    const jobs = (payload.jobs ?? [])
      .filter((item) => item.job)
      .map((item) => ({
        machineId: item.machineId || item.job?.machineId || agent.id,
        baseUrl: item.baseUrl ?? agent.baseUrl,
        job: item.job as CodexResumeJob,
      }));
    const updatedAt = new Date().toISOString();
    remoteJobRegistryCache.set(agent.id, {
      expiresAt: now + ttlMs,
      updatedAt,
      healthy: true,
      jobs,
      error: null,
    });
    return {
      jobs,
      health: { machineId: agent.id, baseUrl: agent.baseUrl, healthy: true, updatedAt, cached: false, error: null },
    };
  } catch (error) {
    try {
      const fallback = await fetchAgentJson<{ jobs?: CodexResumeJob[] }>(agent, '/api/hermes/jobs');
      const jobs = (fallback.jobs ?? []).map((job) => ({ machineId: job.machineId || agent.id, baseUrl: agent.baseUrl, job }));
      const updatedAt = new Date().toISOString();
      remoteJobRegistryCache.set(agent.id, {
        expiresAt: now + ttlMs,
        updatedAt,
        healthy: true,
        jobs,
        error: null,
      });
      return {
        jobs,
        health: { machineId: agent.id, baseUrl: agent.baseUrl, healthy: true, updatedAt, cached: false, error: null },
      };
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : error instanceof Error ? error.message : 'remote failed';
      if (cached) {
        remoteJobRegistryCache.set(agent.id, {
          ...cached,
          expiresAt: now + Math.min(ttlMs || 10_000, 60_000),
          healthy: false,
          error: message,
        });
        return {
          jobs: cached.jobs,
          health: {
            machineId: agent.id,
            baseUrl: agent.baseUrl,
            healthy: false,
            updatedAt: cached.updatedAt,
            cached: true,
            error: message,
          },
        };
      }
      return {
        jobs: [],
        health: {
          machineId: agent.id,
          baseUrl: agent.baseUrl,
          healthy: false,
          updatedAt: new Date().toISOString(),
          cached: false,
          error: message,
        },
      };
    }
  }
}

function codexJobMode(input: CodexJobMode | undefined): CodexJobMode {
  return input ?? (process.env.CURATOR_CODEX_JOB_MODE === 'pty' ? 'pty' : 'exec');
}

type SupervisorStrategy = z.infer<typeof supervisorStrategySchema>;
type PolicyProfile = NonNullable<z.infer<typeof policyProfileSchema>>;

function hermesJobMode(input: CodexJobMode | undefined): CodexJobMode {
  if (input) return input;
  const configured = process.env.CURATOR_HERMES_DEFAULT_JOB_MODE || process.env.CURATOR_CODEX_JOB_MODE;
  if (configured === 'exec' || configured === 'pty') return configured;
  return 'pty';
}

function policyForProfile(profile: PolicyProfile | undefined, cwd?: string | null): Record<string, unknown> {
  const allowedCwds = cwd ? [cwd] : [];
  const base = {
    profile: profile ?? 'code_edit',
    allowDeploy: false,
    allowDeletes: false,
    autoStop: true,
    maxRuntimeMs: defaultHermesMaxRuntimeMs,
    allowedCwds,
  };
  if (profile === 'read_only') {
    return {
      ...base,
      blockedCommands: ['apply_patch', 'writeFileSync', 'npm install', 'pnpm install', 'git commit', 'git push'],
    };
  }
  if (profile === 'test_only') {
    return {
      ...base,
      blockedCommands: ['apply_patch', 'writeFileSync', 'git commit', 'git push', 'npm publish'],
    };
  }
  if (profile === 'deploy_allowed') {
    return { ...base, allowDeploy: true };
  }
  if (profile === 'dangerous_ops_allowed') {
    return { ...base, allowDeploy: true, allowDeletes: true };
  }
  return base;
}

function mergeJobPolicy(profile: PolicyProfile | undefined, explicitPolicy: Record<string, unknown> | undefined, cwd?: string | null) {
  return {
    ...policyForProfile(profile, cwd),
    ...(explicitPolicy ?? {}),
  };
}

function isSupervisorStrategy(value: boolean | SupervisorStrategy | undefined): value is SupervisorStrategy {
  return typeof value === 'object' && value !== null;
}

function supervisorEnabled(value: boolean | SupervisorStrategy | undefined): boolean {
  return isSupervisorStrategy(value) ? true : value ?? true;
}

function supervisorStrategy(value: boolean | SupervisorStrategy | undefined): SupervisorStrategy | undefined {
  const defaults: SupervisorStrategy = {
    autoStop: true,
    autoRetry: false,
    staleOutputMs: defaultHermesStaleOutputMs,
    idleTimeoutMs: defaultHermesStaleOutputMs,
  };
  if (value === false) return defaults;
  return isSupervisorStrategy(value)
    ? { ...defaults, ...value, idleTimeoutMs: value.staleOutputMs ?? value.idleTimeoutMs ?? defaults.idleTimeoutMs }
    : defaults;
}

function compactJobForEvents(job: CodexResumeJob): CodexResumeJob {
  const maxTailBytes = readIntEnv('CURATOR_JOB_EVENTS_RESPONSE_TAIL_BYTES', 32 * 1024, 1024, 256 * 1024);
  const outputTail =
    Buffer.byteLength(job.outputTail) <= maxTailBytes
      ? job.outputTail
      : Buffer.from(job.outputTail).subarray(-maxTailBytes).toString('utf8');
  return { ...job, outputTail };
}

function auditMeta(request: FastifyRequest): Record<string, unknown> {
  const auth = authState(request);
  return {
    actor: auth.user ?? 'admin-token',
    source: request.headers['x-curator-source'] ?? request.headers['user-agent'] ?? 'api',
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

async function recordJobFailureCard(job: CodexResumeJob, reason: string): Promise<void> {
  if (job.status === 'completed') return;
  await service.appendFailureKnowledgeCard({
    sessionId: job.sessionId,
    agent: job.agent,
    jobId: job.id,
    error: job.error ?? reason,
    outputTail: job.outputTail,
    policyViolations: job.policyState?.violations ?? [],
  });
  expireSessionCaches();
}

function jobOutcomeFromJob(job: CodexResumeJob, goal: string) {
  const report = job.structuredReport;
  const tests = report?.tests?.length ? report.tests : [];
  const changedFiles = report?.changedFiles?.length ? report.changedFiles : job.changedFiles;
  const failureReason = job.status === 'completed' ? null : job.error ?? job.supervisor?.lastReason ?? 'worker 未成功完成';
  const needsReview =
    job.status !== 'completed' ||
    !report ||
    /failed|blocked|needs_review/i.test(report.status ?? '') ||
    tests.length === 0 ||
    tests.some((test) => /not run|未运行|failed/i.test(test));
  return {
    id: `${job.id}:${job.completedAt ?? job.updatedAt}`,
    at: job.completedAt ?? job.updatedAt,
    jobId: job.id,
    sessionId: job.sessionId,
    machineId: job.machineId,
    agent: job.agent,
    status: job.status,
    mode: job.mode,
    goal: goal.slice(0, 1200),
    cwd: job.cwd ?? null,
    changedFiles,
    tests,
    nextAction: report?.nextAction ?? null,
    failureReason,
    needsReview,
    summary: [
      `目标：${goal.slice(0, 220)}`,
      `状态：${job.status}`,
      changedFiles.length ? `改动：${changedFiles.slice(0, 8).join(', ')}` : '改动：none',
      tests.length ? `验证：${tests.slice(0, 6).join(', ')}` : '验证：not run',
      failureReason ? `失败/风险：${failureReason.slice(0, 220)}` : '',
    ].filter(Boolean).join('；'),
  };
}

async function recordJobOutcome(job: CodexResumeJob, goal: string): Promise<void> {
  const outcome = jobOutcomeFromJob(job, goal);
  await service.appendJobOutcome(outcome);
  const identity = hermesKnowledgeIdentity(outcome.machineId, outcome.agent, outcome.sessionId);
  await syncKnowledgeItems([
    {
      id: `${identity}:job:${outcome.jobId}`,
      legacyIds: [`${outcome.sessionId}:job:${outcome.jobId}`],
      type: 'job',
      scope: 'job_outcome',
      title: `${outcome.agent} worker ${outcome.status}: ${outcome.goal.slice(0, 120)}`,
      text: [
        `machineId: ${outcome.machineId}`,
        `agent: ${outcome.agent}`,
        `sessionId: ${outcome.sessionId}`,
        outcome.summary,
      ].join('\n'),
      project: outcome.cwd?.split('/').filter(Boolean).at(-1) ?? null,
      repo: null,
      cwd: outcome.cwd,
      machineId: outcome.machineId,
      updatedAt: outcome.at,
      tags: ['job_outcome', outcome.status, outcome.machineId, outcome.agent, outcome.sessionId].filter(Boolean),
      source: 'curator:auto-sync',
      confidence: 0.8,
      lastVerifiedAt: outcome.at,
    },
  ]);
  expireSessionCaches();
}

async function finalizeJobFacts(job: CodexResumeJob, goal: string, reason: string): Promise<void> {
  if (!job.agentVerified) {
    app.log.warn({ jobId: job.id, sessionId: job.sessionId }, 'Skipping job fact write because Agent identity is unverified');
    return;
  }
  await Promise.all([
    recordJobOutcome(job, goal),
    recordJobFailureCard(job, reason),
  ]);
}

await service.cleanupRecycleBin();
setInterval(
  () => {
    void service.cleanupRecycleBin().catch((error) => {
      app.log.warn({ error }, 'Recycle cleanup failed');
    });
  },
  6 * 60 * 60 * 1000
).unref();

const autoBackfillIntervalMs = readIntEnv('CURATOR_AUTO_BACKFILL_INTERVAL_MS', 0, 0, 24 * 60 * 60 * 1000);
if (curatorRole === 'hub' && autoBackfillIntervalMs > 0) {
  const initialDelayMs = readIntEnv('CURATOR_AUTO_BACKFILL_INITIAL_DELAY_MS', 30_000, 5_000, autoBackfillIntervalMs);
  setTimeout(() => void runAutoBackfill('startup'), initialDelayMs).unref();
  setInterval(() => void runAutoBackfill('interval'), autoBackfillIntervalMs).unref();
  app.log.info(
    {
      intervalMs: autoBackfillIntervalMs,
      initialDelayMs,
      limit: readIntEnv('CURATOR_AUTO_BACKFILL_LIMIT', 8, 1, 200),
      includeFailed: process.env.CURATOR_AUTO_BACKFILL_INCLUDE_FAILED === '1',
    },
    'Auto evaluation backfill enabled',
  );
}

const remoteEvaluationIntervalMs = readIntEnv('CURATOR_REMOTE_EVALUATION_INTERVAL_MS', 0, 0, 24 * 60 * 60 * 1000);
if (curatorRole === 'hub' && remoteEvaluationIntervalMs > 0) {
  const initialDelayMs = readIntEnv('CURATOR_REMOTE_EVALUATION_INITIAL_DELAY_MS', 20_000, 5_000, Math.max(5_000, remoteEvaluationIntervalMs));
  setTimeout(() => void runRemoteEvaluationBackfill('startup'), initialDelayMs).unref();
  setInterval(() => void runRemoteEvaluationBackfill('interval'), remoteEvaluationIntervalMs).unref();
  app.log.info(
    { intervalMs: remoteEvaluationIntervalMs, initialDelayMs, limit: readIntEnv('CURATOR_REMOTE_EVALUATION_LIMIT', 4, 1, 100) },
    'Remote worker evaluation backfill enabled',
  );
}

const sessionAuditIntervalMs = readIntEnv('CURATOR_SESSION_AUDIT_INTERVAL_MS', 0, 0, 24 * 60 * 60 * 1000);
if (sessionAuditIntervalMs > 0) {
  const initialDelayMs = readIntEnv('CURATOR_SESSION_AUDIT_INITIAL_DELAY_MS', 45_000, 5_000, Math.max(5_000, sessionAuditIntervalMs));
  setTimeout(() => void runSessionAudit('startup'), initialDelayMs).unref();
  setInterval(() => void runSessionAudit('interval'), sessionAuditIntervalMs).unref();
  app.log.info({ intervalMs: sessionAuditIntervalMs, initialDelayMs }, 'Session completeness audit enabled');
}

async function refreshSupervisorSessionCache(): Promise<void> {
  try {
    supervisorSessionCache = await getStateSessionsForHermes();
  } catch (error) {
    app.log.warn({ error }, 'Supervisor session cache refresh failed');
  }
}

await refreshSupervisorSessionCache();
setInterval(() => void refreshSupervisorSessionCache(), 60_000).unref();
const semanticSupervisorCheckedAt = new Map<string, number>();
startCodexSupervisorLoop({
  intervalMs: readIntEnv('CURATOR_CODEX_SUPERVISOR_INTERVAL_MS', 30_000, 1_000, 3_600_000),
  idleTimeoutMs: readIntEnv('CURATOR_CODEX_SUPERVISOR_IDLE_MS', 10 * 60_000, 10_000, 86_400_000),
  autoStop: process.env.CURATOR_CODEX_SUPERVISOR_AUTO_STOP === '1',
  autoRetry: process.env.CURATOR_CODEX_SUPERVISOR_AUTO_RETRY === '1',
  maxRetries: readIntEnv('CURATOR_CODEX_SUPERVISOR_MAX_RETRIES', 1, 0, 10),
  restart: (previousJob, prompt) => {
    if (!previousJob.agentVerified) {
      throw new Error(`Supervisor retry refused for unverified Agent identity: ${previousJob.id}`);
    }
    const session = supervisorSessionCache.find(
      (item) =>
        item.id === previousJob.sessionId &&
        item.machineId === previousJob.machineId &&
        item.agent === previousJob.agent,
    );
    if (!session) throw new Error(`Supervisor retry session not found: ${previousJob.sessionId}`);
    return startCodexResumeJob({
      session,
      prompt,
      mode: previousJob.mode,
      supervisor: {
        enabled: previousJob.supervisor.enabled,
        autoStop: previousJob.supervisor.autoStop,
        autoRetry: previousJob.supervisor.autoRetry,
        idleTimeoutMs: previousJob.supervisor.idleTimeoutMs ?? undefined,
        maxRetries: previousJob.supervisor.maxRetries ?? undefined,
      },
      policy: previousJob.policy,
      onExit: (completedJob: CodexResumeJob) => {
        void finalizeJobFacts(completedJob, prompt, 'supervisor loop job finished').catch((error) => {
          app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
        });
        void enqueueEvaluationRefresh(
          completedJob.sessionId,
          `supervisor-loop:${completedJob.id}:${completedJob.status}`,
          session.machineId,
          session.agent,
        ).catch((error) => {
          app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Supervisor loop evaluation refresh enqueue failed');
        });
      },
    });
  },
});
app.log.info({ intervalMs: readIntEnv('CURATOR_CODEX_SUPERVISOR_INTERVAL_MS', 30_000, 1_000, 3_600_000) }, 'Codex supervisor loop enabled');

const semanticSupervisorIntervalMs = readIntEnv('CURATOR_CODEX_SEMANTIC_SUPERVISOR_INTERVAL_MS', 0, 0, 3_600_000);
if (
  curatorRole === 'hub' &&
  (semanticSupervisorIntervalMs > 0 || process.env.CURATOR_CODEX_SEMANTIC_SUPERVISOR === '1')
) {
  const intervalMs = semanticSupervisorIntervalMs || 120_000;
  setInterval(() => {
    void (async () => {
      for (const job of listCodexResumeJobs()) {
        if (job.status !== 'running' || !job.supervisor?.enabled) continue;
        const last = semanticSupervisorCheckedAt.get(job.id) ?? 0;
        if (Date.now() - last < intervalMs) continue;
        semanticSupervisorCheckedAt.set(job.id, Date.now());
        const semantic = await evaluateJobSemantics({
          job,
          events: listCodexJobEvents(job.id, Math.max(0, (job.eventSeq ?? 0) - 80)),
          policy: job.policy,
        });
        if (!semantic) continue;
        recordCodexJobAudit(job.id, 'semantic-supervisor-loop', {
          decision: semantic.decision,
          reason: semantic.reason,
          confidence: semantic.confidence,
        });
        if (semantic.decision === 'needs_guidance' && semantic.guidance && job.mode === 'pty') {
          sendCodexJobGuidance(job.id, semantic.guidance, 'supervisor');
        }
        if ((semantic.decision === 'stop' || semantic.decision === 'failed') && job.supervisor.autoStop) {
          const stopped = stopCodexResumeJob(job.id);
          if (stopped) await finalizeJobFacts(stopped, stopped.prompt, semantic.reason);
        }
      }
    })().catch((error) => {
      app.log.warn({ error }, 'Semantic supervisor loop failed');
    });
  }, intervalMs).unref();
  app.log.info({ intervalMs }, 'Semantic Codex supervisor loop enabled');
}

await app.register(cors, { origin: true });
await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] });
await app.register(websocket);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
  done(null, body);
});

app.addHook('onRequest', async (request, reply) => {
  if (curatorRole === 'worker' && isHubOnlyApiPath(request.url)) {
    return reply.code(404).send({ error: 'Not found' });
  }
});

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isHttpsRequest(request: FastifyRequest): boolean {
  return request.headers['x-forwarded-proto'] === 'https' || request.headers['cf-visitor']?.includes('https') === true;
}

function authCookie(value: string, request: FastifyRequest, maxAge = 2_592_000): string {
  const secure = isHttpsRequest(request) ? ' Secure;' : '';
  return `curator_admin=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secure}`;
}

function authState(request: FastifyRequest): {
  enabled: boolean;
  authenticated: boolean;
  user: string | null;
  token: string | null;
} {
  const authUser = process.env.CURATOR_AUTH_USER;
  const authPassword = process.env.CURATOR_AUTH_PASSWORD;
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (!authUser || !authPassword || !adminToken) {
    return { enabled: false, authenticated: true, user: null, token: adminToken ?? null };
  }

  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.searchParams.get('admin_token') === adminToken) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }

  const cookies = parseCookies(request.headers.cookie);
  if (cookies.curator_admin === adminToken) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }

  const header = request.headers.authorization;
  if (header === `Bearer ${adminToken}`) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }
  const expected = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
  if (header === expected) {
    return { enabled: true, authenticated: true, user: authUser, token: adminToken };
  }

  return { enabled: true, authenticated: false, user: null, token: adminToken };
}

app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/assets/')) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
  if (request.url === '/' || request.url.startsWith('/?')) {
    reply.header('Cache-Control', 'no-cache');
  }
  return payload;
});

app.addHook('onRequest', async (request, reply) => {
  const auth = authState(request);
  if (!auth.enabled) return;

  const url = new URL(request.url, 'http://127.0.0.1');
  const isAuthRoute = url.pathname === '/api/auth/status' || url.pathname === '/api/auth/login' || url.pathname === '/api/auth/logout';
  const isAsset = url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico';
  const isPage = request.method === 'GET' && !url.pathname.startsWith('/api/') && !request.headers.upgrade;
  if (isAuthRoute || isAsset || isPage) {
    const adminToken = process.env.CURATOR_ADMIN_TOKEN;
    if (adminToken && url.searchParams.get('admin_token') === adminToken) {
      url.searchParams.delete('admin_token');
      reply.header('Set-Cookie', authCookie(adminToken, request));
      if (request.method === 'GET' && url.pathname === '/' && !request.headers.upgrade) {
        await reply.redirect(`${url.pathname}${url.search}${url.hash}` || '/');
        return;
      }
    }
    return;
  }

  const requestToken = url.searchParams.get('admin_token');
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (adminToken && requestToken === adminToken) {
    url.searchParams.delete('admin_token');
    const cleanPath = `${url.pathname}${url.search}${url.hash}`;
    reply.header('Set-Cookie', authCookie(adminToken, request));
    if (request.method === 'GET' && url.pathname === '/' && !request.headers.upgrade) {
      await reply.redirect(cleanPath || '/');
      return;
    }
    return;
  }

  if (auth.authenticated) return;

  await reply.code(401).send({ error: 'Authentication required' });
});

app.get('/api/auth/status', async (request) => {
  const auth = authState(request);
  return {
    enabled: auth.enabled,
    authenticated: auth.authenticated,
    user: auth.authenticated ? auth.user : null,
    tokenLogin: Boolean(process.env.CURATOR_ADMIN_TOKEN),
  };
});

app.post('/api/auth/login', async (request, reply) => {
  const authUser = process.env.CURATOR_AUTH_USER;
  const authPassword = process.env.CURATOR_AUTH_PASSWORD;
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (!authUser || !authPassword || !adminToken) {
    return { ok: true, authenticated: true, user: null };
  }

  const body = loginSchema.parse(request.body);
  if (body.username !== authUser || body.password !== authPassword) {
    return reply.code(401).send({ error: 'Invalid username or password' });
  }
  reply.header('Set-Cookie', authCookie(adminToken, request));
  return { ok: true, authenticated: true, user: authUser };
});

app.post('/api/auth/logout', async (request, reply) => {
  reply.header('Set-Cookie', authCookie('', request, 0));
  return { ok: true };
});

app.all('/api/codex/*', async (request, reply) => {
  const targetUrl = request.url.replace(/^\/api\/codex(?=\/|$)/, '/api/hermes');
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers = Object.fromEntries(
    Object.entries({
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      'content-type': payload ? 'application/json' : request.headers['content-type'],
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const injected = await app.inject({
    method: request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD',
    url: targetUrl,
    payload,
    headers,
  });
  const responseHeaders = injected.headers as Record<string, string | string[] | undefined>;
  const contentType = responseHeaders['content-type'];
  if (contentType) reply.header('content-type', contentType);
  return reply.code(injected.statusCode).send(injected.body);
});

app.get('/api/meta', async () => ({
  ...service.getMeta(),
  role: curatorRole,
  capabilities: curatorCapabilities,
}));

app.post('/api/commander-actions', async (request, reply) => {
  const body = commanderActionCreateSchema.parse(request.body ?? {});
  const now = new Date().toISOString();
  const status = body.status ?? 'started';
  const action: CommanderAction = {
    id: randomUUID(),
    kind: body.kind,
    status,
    goal: body.goal,
    reason: body.reason,
    scope: body.scope ?? null,
    targetRepo: body.targetRepo ?? null,
    cwd: body.cwd ?? null,
    changedFiles: body.changedFiles ?? [],
    tests: body.tests ?? [],
    verification: body.verification ?? [],
    followUp: body.followUp ?? null,
    startedAt: body.startedAt ?? now,
    completedAt: body.completedAt ?? (status === 'started' ? null : now),
  };
  await store.addCommanderAction(action);
  await syncKnowledgeItems([toKnowledgeItem(buildCommanderActionSearchDocument(action))]);
  return reply.code(201).send({ action });
});

app.patch('/api/commander-actions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = commanderActionUpdateSchema.parse(request.body ?? {});
  const patch: Partial<Omit<CommanderAction, 'id'>> = { ...body };
  if (
    patch.completedAt === undefined &&
    patch.status &&
    patch.status !== 'started'
  ) {
    patch.completedAt = new Date().toISOString();
  }
  const action = await store.updateCommanderAction(params.id, patch);
  if (!action) return reply.code(404).send({ error: 'Commander action not found' });
  await syncKnowledgeItems([toKnowledgeItem(buildCommanderActionSearchDocument(action))]);
  return { action };
});

app.get('/api/commander-actions', async () => ({
  actions: await store.listCommanderActions(),
}));

app.post('/api/knowledge/items', async (request, reply) => {
  const body = knowledgeItemCreateSchema.parse(request.body ?? {});
  const item = await requireKnowledgeStore().createItem(body);
  return reply.code(201).send({ item });
});

app.patch('/api/knowledge/items/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = knowledgeItemUpdateSchema.parse(request.body ?? {});
  const item = await requireKnowledgeStore().updateItem(params.id, body);
  if (!item) return reply.code(404).send({ error: 'Knowledge item not found' });
  return { item };
});

app.get('/api/knowledge/items/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const item = await requireKnowledgeStore().getItem(params.id);
  if (!item) return reply.code(404).send({ error: 'Knowledge item not found' });
  return { item };
});

function authorizeKnowledgeProposalApply(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isProposalApplyConfigured()) {
    void reply.code(503).send({ error: 'Knowledge proposal apply capability is not configured' });
    return false;
  }
  if (!proposalApplyTokenMatches(request.headers['x-curator-proposal-apply-token'])) {
    void reply.code(403).send({ error: 'Knowledge proposal apply capability is required' });
    return false;
  }
  return true;
}

app.post('/api/knowledge/proposals', async (request, reply) => {
  const body = knowledgeProposalCreateSchema.parse(request.body ?? {});
  let changes: KnowledgeProposalChange[];
  try {
    changes = normalizeProposalChanges(body.changes as KnowledgeProposalChange[]);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
  const candidate = {
    localId: body.localId,
    baseSourceHash: body.baseSourceHash,
    reason: body.reason.trim(),
    sourceMachineId: body.sourceMachineId.trim(),
    sourceSessionId: body.sourceSessionId?.trim() || null,
    changes,
  };
  const existing = await requireKnowledgeStore().getProposalBySourceLocalId(candidate.sourceMachineId, candidate.localId);
  if (existing) {
    if (!proposalPayloadMatches(existing, candidate)) {
      return reply.code(409).send({ error: 'A different proposal already uses this machine/local ID', proposal: existing });
    }
    return { proposal: existing, idempotent: true };
  }
  const proposal = await requireKnowledgeStore().createProposal({
    ...candidate,
    riskClass: classifyProposalRisk(changes),
  });
  return reply.code(201).send({ proposal, idempotent: false });
});

app.get('/api/knowledge/proposals', async (request) => {
  const query = knowledgeProposalListSchema.parse(request.query ?? {});
  return { proposals: await requireKnowledgeStore().listProposals(query) };
});

app.get('/api/knowledge/proposals/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const proposal = await requireKnowledgeStore().getProposal(params.id);
  if (!proposal) return reply.code(404).send({ error: 'Knowledge proposal not found' });
  return { proposal };
});

app.post('/api/knowledge/proposals/:id/apply', async (request, reply) => {
  if (!authorizeKnowledgeProposalApply(request, reply)) return;
  const params = sessionIdSchema.parse(request.params);
  const body = knowledgeProposalApplySchema.parse(request.body ?? {});
  const proposal = await requireKnowledgeStore().getProposal(params.id);
  if (!proposal) return reply.code(404).send({ error: 'Knowledge proposal not found' });
  if (proposal.status !== 'pending') {
    return reply.code(409).send({ error: `Knowledge proposal is ${proposal.status}, not pending`, proposal });
  }
  const claimed = await requireKnowledgeStore().claimProposalForApply(params.id);
  if (!claimed) {
    const current = await requireKnowledgeStore().getProposal(params.id);
    return reply.code(409).send({ error: 'Knowledge proposal was claimed concurrently', proposal: current });
  }
  enqueueKnowledgeProposalApply(params.id, body.publish as KnowledgeProposalPublishMode);
  return reply.code(202).send({ proposal: claimed });
});

app.post('/api/knowledge/proposals/:id/reject', async (request, reply) => {
  if (!authorizeKnowledgeProposalApply(request, reply)) return;
  const params = sessionIdSchema.parse(request.params);
  const body = knowledgeProposalRejectSchema.parse(request.body ?? {});
  const existing = await requireKnowledgeStore().getProposal(params.id);
  if (!existing) return reply.code(404).send({ error: 'Knowledge proposal not found' });
  const proposal = await requireKnowledgeStore().rejectProposal(params.id, body.reason.trim());
  if (!proposal) return reply.code(409).send({ error: `Knowledge proposal cannot be rejected from ${existing.status}`, proposal: existing });
  return { proposal };
});

function gatewayKnowledgeType(path: string): KnowledgeItemType {
  if (path.startsWith('knowledge/runbooks/')) return 'runbook';
  if (path.startsWith('knowledge/decisions/')) return 'decision';
  if (path.startsWith('knowledge/inventories/')) return 'service';
  if (path === 'knowledge/INDEX.md') return 'project';
  return 'note';
}

function gatewayMatchToKnowledgeItem(match: KnowledgeGatewayMatch): KnowledgeItem {
  const now = new Date().toISOString();
  const lineSuffix = match.startLine ? `#L${match.startLine}` : '';
  const headingSuffix = match.heading && match.heading !== match.title ? ` - ${match.heading}` : '';
  return {
    id: `gateway:${match.id}`,
    type: gatewayKnowledgeType(match.path),
    scope: 'canonical_markdown_chunk',
    title: `${match.title}${headingSuffix}`,
    text: match.text,
    project: 'agent-knowledge-stack',
    repo: getCanonicalKnowledgeRepoPath(),
    cwd: null,
    machineId: service.getMeta().machineId,
    tags: [...new Set(['knowledge-gateway', match.kind ?? '', ...match.tags].filter(Boolean))],
    source: `${match.path}${lineSuffix}`,
    confidence: Math.max(0, Math.min(1, match.score)),
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function requestedKnowledgeTypes(query: z.infer<typeof knowledgeSearchSchema>): Set<KnowledgeItemType> {
  const values = Array.isArray(query.type) ? query.type : query.type ? [query.type] : [];
  return new Set(values);
}

async function searchFederatedKnowledge(query: z.infer<typeof knowledgeSearchSchema>) {
  const limit = query.limit ?? 20;
  const localResults = await requireKnowledgeStore().search({ ...query, limit: Math.max(limit, Math.min(100, limit * 2)) });
  const gateway = query.q?.trim()
    ? await searchKnowledgeGateway({ query: query.q.trim(), limit: Math.max(limit, Math.min(50, limit * 2)), projectCwd: query.repo })
    : { available: false, queryId: null, retrieval: null, collection: null, matches: [], error: null };
  const requestedTypes = requestedKnowledgeTypes(query);
  const gatewayResults = gateway.matches
    .map((match) => ({ score: match.score, item: gatewayMatchToKnowledgeItem(match) }))
    .filter((result) => requestedTypes.size === 0 || requestedTypes.has(result.item.type));

  const localEntries = new Map<string, { score: number; item: KnowledgeItem; source: 'sqlite' }>();
  for (const result of localResults) {
    localEntries.set(result.item.id, { ...result, source: 'sqlite' });
  }
  const gatewayEntries = new Map<string, { score: number; item: KnowledgeItem; source: 'gateway' }>();
  for (const result of gatewayResults) {
    const key = `gateway:${result.item.source ?? result.item.id}:${result.item.title}`;
    const existing = gatewayEntries.get(key);
    if (!existing || result.score > existing.score) gatewayEntries.set(key, { ...result, source: 'gateway' });
  }
  const rankedLocal = [...localEntries.values()].sort(
    (left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt),
  );
  const rankedGateway = [...gatewayEntries.values()].sort((left, right) => right.score - left.score);
  const gatewayQuota = rankedGateway.length ? Math.max(1, Math.floor(limit / 3)) : 0;
  const results: Array<{ score: number; item: KnowledgeItem; source: 'sqlite' | 'gateway' }> = [
    ...rankedLocal.slice(0, Math.max(0, limit - gatewayQuota)),
    ...rankedGateway.slice(0, gatewayQuota),
  ];
  if (results.length < limit) {
    const selectedIds = new Set(results.map((result) => `${result.source}:${result.item.id}`));
    for (const result of [...rankedLocal, ...rankedGateway]) {
      const key = `${result.source}:${result.item.id}`;
      if (selectedIds.has(key)) continue;
      results.push(result);
      selectedIds.add(key);
      if (results.length >= limit) break;
    }
  }
  return {
    results,
    sources: {
      sqlite: { count: results.filter((result) => result.source === 'sqlite').length },
      gateway: {
        available: gateway.available,
        count: results.filter((result) => result.source === 'gateway').length,
        queryId: gateway.queryId,
        retrieval: gateway.retrieval,
        collection: gateway.collection,
        error: gateway.error,
      },
    },
  };
}

async function buildKnowledgeSearchResponse(rawQuery: unknown) {
  const query = knowledgeSearchSchema.parse(rawQuery);
  const federated = await searchFederatedKnowledge(query);
  return {
    query: query.q ?? '',
    count: federated.results.length,
    items: federated.results.map((result) => ({
      score: result.score,
      retrievalSource: result.source,
      ...result.item,
    })),
    sources: federated.sources,
  };
}

app.get('/api/knowledge/search', async (request) => {
  return buildKnowledgeSearchResponse(request.query);
});

app.get('/api/hermes/knowledge-search', async (request) => {
  return buildKnowledgeSearchResponse(request.query);
});

async function knowledgeDocumentResponse(rawQuery: unknown, reply: FastifyReply) {
  const query = knowledgeDocumentQuerySchema.parse(rawQuery);
  try {
    return { document: await readCanonicalKnowledgeDocument(query.path) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge document unavailable';
    const invalid = /invalid|only markdown|outside allowed|escapes|size limit/i.test(message);
    return reply.code(invalid ? 400 : 404).send({ error: message });
  }
}

app.get('/api/knowledge/document', async (request, reply) => {
  return knowledgeDocumentResponse(request.query, reply);
});

app.get('/api/hermes/knowledge-document', async (request, reply) => {
  return knowledgeDocumentResponse(request.query, reply);
});
app.get('/api/audit/completeness', async () => {
  return service.auditCompleteness();
});

app.get('/api/audit/events', async (request) => {
  const query = auditQuerySchema.parse(request.query);
  if (query.machineId && query.machineId !== service.getMeta().machineId) {
    const agent = remoteAgents.find((candidate) => candidate.id === query.machineId);
    if (!agent) return { events: [], error: `Remote machine not configured: ${query.machineId}` };
    const params = new URLSearchParams();
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.agent) params.set('agent', query.agent);
    if (query.limit) params.set('limit', String(query.limit));
    return fetchAgentJson(agent, `/api/audit/events?${params.toString()}`);
  }
  return {
    events: await readSessionAuditEvents({
      limit: query.limit,
      sessionId: query.sessionId,
      machineId: query.machineId,
      agent: query.agent,
    }),
  };
});

app.get('/api/audit/fleet', async (request) => {
  const query = fleetAuditQuerySchema.parse(request.query);
  return buildFleetAuditReport(query.refresh === '1' || query.refresh === 'true');
});

app.get('/api/analysis-runs', async () => {
  const { readAnalysisRuns } = await import('./analysis-log.js');
  const {
    getEvaluatorBaseUrl,
    getEvaluatorModel,
    getEvaluatorProvider,
    getEvaluatorRpmLimit,
    getRecommendedEvaluationConcurrency,
  } = await import('./evaluator.js');
  const records = await readAnalysisRuns(160);
  const now = Date.now();
  const finalRecords = records.filter((record) => record.final !== false);
  const lastHourRecords = finalRecords.filter((record) => now - Date.parse(record.timestamp) <= 60 * 60_000);
  return {
    provider: getEvaluatorProvider(),
    model: getEvaluatorModel(),
    baseUrl: getEvaluatorBaseUrl(),
    rpmLimit: getEvaluatorRpmLimit(),
    concurrency: getRecommendedEvaluationConcurrency(),
    records: records.slice(-40).reverse(),
    lastMinute: finalRecords.filter((record) => now - Date.parse(record.timestamp) <= 60_000).length,
    lastHour: lastHourRecords.length,
    successLastHour: lastHourRecords.filter((record) => record.status === 'ok').length,
    failedLastHour: lastHourRecords.filter((record) => record.status === 'failed').length,
  };
});

function includeDeprecated(query: z.infer<typeof includeDeprecatedSchema>): boolean {
  return query.includeDeprecated === '1' || query.includeDeprecated === 'true';
}

app.get('/api/server-identity/machines', async (request, reply) => {
  const query = includeDeprecatedSchema.parse(request.query);
  try {
    return { machines: await listServerIdentityMachines(includeDeprecated(query)) };
  } catch (error) {
    request.log.error({ error }, 'server identity list failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity list failed' });
  }
});

app.get('/api/server-identity/machines/:alias', async (request, reply) => {
  const params = serverIdentityAliasSchema.parse(request.params);
  try {
    const machine = await getServerIdentityMachine(params.alias);
    if (!machine) return reply.code(404).send({ error: 'Machine not found' });
    return { machine };
  } catch (error) {
    request.log.error({ error, alias: params.alias }, 'server identity get failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity get failed' });
  }
});

app.post('/api/server-identity/machines', async (request, reply) => {
  const body = serverIdentityMachineSchema.parse(request.body ?? {});
  try {
    return reply.code(201).send({ machine: await upsertServerIdentityMachine(body) });
  } catch (error) {
    request.log.error({ error, alias: body.alias }, 'server identity upsert failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity upsert failed' });
  }
});

app.patch('/api/server-identity/machines/:alias', async (request, reply) => {
  const params = serverIdentityAliasSchema.parse(request.params);
  const body = serverIdentityPatchSchema.parse(request.body ?? {});
  try {
    const machine = await patchServerIdentityMachine(params.alias, body);
    if (!machine) return reply.code(404).send({ error: 'Machine not found' });
    return { machine };
  } catch (error) {
    request.log.error({ error, alias: params.alias }, 'server identity patch failed');
    const message = error instanceof Error ? error.message : 'Server identity patch failed';
    return reply.code(message.includes('alias cannot be changed') ? 400 : 500).send({ error: message });
  }
});

app.post('/api/server-identity/export', async (request, reply) => {
  const body = includeDeprecatedSchema.parse(request.body ?? {});
  try {
    return await exportServerIdentityInventory(includeDeprecated(body));
  } catch (error) {
    request.log.error({ error }, 'server identity export failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity export failed' });
  }
});

app.get('/api/server-identity/ssh-config', async (request, reply) => {
  const query = includeDeprecatedSchema.parse(request.query);
  try {
    return reply.type('text/plain; charset=utf-8').send(await renderServerIdentitySshConfig(includeDeprecated(query)));
  } catch (error) {
    request.log.error({ error }, 'server identity ssh config render failed');
    return reply.code(500).send({ error: error instanceof Error ? error.message : 'Server identity SSH config render failed' });
  }
});

app.get('/api/hermes/search', async (request) => {
  const query = hermesSearchSchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const limit = query.limit ?? 5;
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote ? await getRemoteSessionsCached() : [];
  const sessions = [...localSessions, ...remoteSessions]
    .map((session) => ({ session, score: scoreHermesMatch(session, query.q) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''))
    .slice(0, limit)
    .map((item) => toHermesSession(item.session, query.q));

  return {
    query: query.q,
    sessions,
    count: sessions.length,
    memoryContext: buildHermesMemoryContext(sessions),
  };
});

app.get('/api/hermes/session-index', async (request) => {
  const query = hermesSessionIndexSchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote ? await getRemoteSessionsCached() : [];
  const needle = query.q?.trim() ?? '';
  const scored = [...localSessions, ...remoteSessions]
    .map((session) => ({ session, score: needle ? scoreHermesMatch(session, needle) : session.evaluation.score }))
    .filter((item) => !needle || item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''));
  const limit = query.limit ?? 200;
  const sessions = scored.slice(0, limit).map((item) => toHermesSessionIndexEntry(item.session, needle));
  await syncKnowledgeItems(
    scored
      .slice(0, limit)
      .flatMap((item) => buildHermesSearchDocuments(item.session).filter((document) => document.kind === 'session_index'))
      .map(toKnowledgeItem)
  );
  return {
    query: needle,
    count: sessions.length,
    total: scored.length,
    resumePolicy: {
      defaultAction: 'resume-matched-session',
      createChildSessionOnlyWhen: [
        'no indexed session matches the requested project or task context',
        'the user explicitly asks for a new session',
      ],
    },
    sessions,
  };
});

app.get('/api/hermes/search-documents', async (request) => {
  const query = z
    .object({
      q: z.string().max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      remote: z.enum(['0', '1', 'true', 'false']).optional(),
    })
    .parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote ? await getRemoteSessionsCached() : [];
  const needle = query.q?.toLowerCase().trim() ?? '';
  const documents = [...localSessions, ...remoteSessions]
    .flatMap(buildHermesSearchDocuments)
    .map((document) => ({
      ...document,
      score: scoreDocumentMatch(
        {
          id: document.id,
          title: document.title,
          text: document.text,
          machineId: document.machineId,
          sessionId: 'sessionId' in document ? document.sessionId : null,
        },
        needle
      ),
    }))
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
    .slice(0, query.limit ?? 50);
  return {
    query: query.q ?? '',
    count: documents.length,
    documents,
  };
});

async function buildContextPackResponse(
  rawQuery: unknown,
  strictRemoteSessions?: CodexSession[],
) {
  const query = contextPackSchema.parse(rawQuery);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const limit = query.limit ?? 8;
  const localSessions = await getStateSessionsForHermes();
  const remoteSessions = includeRemote
    ? (strictRemoteSessions ?? await getRemoteSessionsCached())
    : [];
  const needle = query.q?.trim() ?? '';
  const projectNeedle = [query.cwd, query.repo].filter(Boolean).join(' ');
  const searchNeedle = [needle, projectNeedle].filter(Boolean).join(' ');
  const allSessions = [...localSessions, ...remoteSessions];
  const scoredSessions = allSessions
    .map((session) => ({
      session,
      score: needle ? scoreHermesMatch(session, needle) : session.evaluation.score,
      projectScore: scoreRequestedSessionPath(session, query),
    }))
    .filter((item) => {
      if (query.cwd || query.repo) return item.projectScore > 0 && (!needle || item.score > 0 || item.projectScore > 0);
      return !searchNeedle || item.score > 0;
    })
    .sort(
      (a, b) =>
        b.projectScore - a.projectScore ||
        b.score - a.score ||
        Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? '')
    );
  const sessions = scoredSessions.slice(0, limit).map((item) => toHermesSessionIndexEntry(item.session, needle || projectNeedle));
  const commanderActions = await store.listCommanderActions();
  const scoredActions = commanderActions
    .map((action) => {
      const document = buildCommanderActionSearchDocument(action);
      return { action, document, score: scoreDocumentMatch(document, searchNeedle) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.action.startedAt) - Date.parse(a.action.startedAt));
  const syncedKnowledgeItems = [
    ...scoredSessions.flatMap((item) => buildHermesSearchDocuments(item.session).map(toKnowledgeItem)),
    ...scoredActions.map((item) => toKnowledgeItem(item.document)),
  ].slice(0, Math.max(80, limit * 12));
  await syncKnowledgeItems(syncedKnowledgeItems);
  const projectFilter = (query.repo ?? query.cwd)?.replace(/\/+$/, '').split('/').filter(Boolean).at(-1);
  const federatedKnowledge = await searchFederatedKnowledge({
    q: needle || projectFilter,
    limit: Math.max(20, limit * 4),
  });
  const projectKnowledge = projectFilter
    ? await requireKnowledgeStore().search({
        project: projectFilter,
        repo: query.repo,
        limit: Math.max(20, limit * 4),
      })
    : [];
  const storedKnowledgeItems = new Map<string, KnowledgeItem>();
  for (const result of [...federatedKnowledge.results, ...projectKnowledge]) {
    const canonicalPath = result.item.source?.startsWith('knowledge/')
      ? result.item.source.split('#', 1)[0]
      : null;
    const key = canonicalPath ? `canonical:${canonicalPath}` : result.item.id;
    if (!storedKnowledgeItems.has(key)) storedKnowledgeItems.set(key, result.item);
  }
  const knowledgeItems = [
    ...[...storedKnowledgeItems.values()].map(toContextKnowledgeItem),
    ...syncedKnowledgeItems.map(toContextKnowledgeItem),
  ];

  return buildContextPack({
    query: needle,
    cwd: query.cwd ?? null,
    repo: query.repo ?? null,
    limit,
    sessions,
    commanderActions: scoredActions.map((item) => item.action),
    knowledgeItems,
  });
}

app.get('/api/context-pack', async (request) => {
  return buildContextPackResponse(request.query);
});

app.get('/api/hermes/context-pack', async (request) => {
  return buildContextPackResponse(request.query);
});

interface HermesSessionIdentity {
  sessionId: string;
  machineId?: string | null;
  agent?: AgentKind | null;
}

type HermesSessionResolution =
  | { status: 'found'; session: SessionListItem }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: Array<{ sessionId: string; machineId: string; agent: AgentKind }> }
  | { status: 'unavailable'; machineIds: string[] };

function hermesSessionIdentityKey(
  session: Pick<SessionListItem, 'id' | 'machineId' | 'agent'>
): string {
  return `${session.machineId}|||${session.agent}|||${session.id}`;
}

function matchesHermesSessionIdentity(
  session: Pick<SessionListItem, 'id' | 'machineId' | 'agent'>,
  identity: HermesSessionIdentity
): boolean {
  return session.id === identity.sessionId &&
    (!identity.machineId || session.machineId === identity.machineId) &&
    (!identity.agent || session.agent === identity.agent);
}

function resolveHermesSessionFromCandidates(
  sessions: SessionListItem[],
  identity: HermesSessionIdentity
): HermesSessionResolution {
  const matches = sessions.filter((session) => matchesHermesSessionIdentity(session, identity));
  if (!matches.length) return { status: 'missing' };
  if (matches.length === 1) return { status: 'found', session: matches[0] };
  return {
    status: 'ambiguous',
    candidates: matches.map((session) => ({
      sessionId: session.id,
      machineId: session.machineId,
      agent: session.agent,
    })),
  };
}

async function resolveHermesSession(
  identity: HermesSessionIdentity,
  includeRemote: boolean
): Promise<HermesSessionResolution> {
  const localMachineId = service.getMeta().machineId;
  const localSessions = identity.machineId && identity.machineId !== localMachineId
    ? []
    : await getLocalSessionsCached(false, true);
  if (!includeRemote || identity.machineId === localMachineId || !remoteAgents.length) {
    return resolveHermesSessionFromCandidates(localSessions, identity);
  }

  const candidates = identity.machineId
    ? remoteAgents.filter((agent) => agent.id === identity.machineId)
    : remoteAgents;
  if (identity.machineId && !candidates.length) {
    return { status: 'missing' };
  }

  const remoteInventory = await getRemoteSessionsStrict(candidates);
  if (remoteInventory.status === 'unavailable') return remoteInventory;
  return resolveHermesSessionFromCandidates(
    [...localSessions, ...remoteInventory.sessions],
    identity,
  );
}

function sendHermesSessionResolutionError(
  reply: FastifyReply,
  identity: HermesSessionIdentity,
  resolution: Exclude<HermesSessionResolution, { status: 'found' }>
) {
  if (resolution.status === 'unavailable') {
    return reply.code(503).send({
      error: `Remote session inventory unavailable: ${resolution.machineIds.join(', ')}`,
      code: 'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
      sessionId: identity.sessionId,
      machineIds: resolution.machineIds,
    });
  }
  if (resolution.status === 'ambiguous') {
    return reply.code(409).send({
      error: `Ambiguous session identity: ${identity.sessionId}`,
      code: 'AMBIGUOUS_SESSION_IDENTITY',
      sessionId: identity.sessionId,
      candidates: resolution.candidates,
    });
  }
  return reply.code(404).send({
    error: `Session not found: ${identity.sessionId}`,
    code: 'SESSION_NOT_FOUND',
    sessionId: identity.sessionId,
  });
}

app.get('/api/hermes/sessions/:id/context', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionContextSchema.parse(request.query);
  const historyLimit = query.historyLimit ?? 20;
  const identity = {
    sessionId: params.id,
    machineId: query.machineId,
    agent: query.agent,
  };
  const resolution = await resolveHermesSession(identity, true);
  if (resolution.status !== 'found') {
    return sendHermesSessionResolutionError(reply, identity, resolution);
  }

  const localMachineId = service.getMeta().machineId;
  if (resolution.session.machineId !== localMachineId) {
    const remoteAgent = remoteAgents.find((agent) => agent.id === resolution.session.machineId);
    if (!remoteAgent) {
      return reply.code(404).send({ error: `Remote machine not configured: ${resolution.session.machineId}` });
    }
    const remoteQuery = new URLSearchParams({
      historyLimit: String(historyLimit),
      machineId: resolution.session.machineId,
      agent: resolution.session.agent,
    });
    try {
      return await fetchAgentJson(
        remoteAgent,
        `/api/hermes/sessions/${encodeURIComponent(params.id)}/context?${remoteQuery.toString()}`
      );
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : `Remote context unavailable: ${resolution.session.machineId}`,
      });
    }
  }

  const localSession = resolution.session;
  const history = historyLimit > 0
    ? await parseSessionHistory({ filePath: localSession.filePath, limit: historyLimit })
    : { messages: [], nextBefore: null, hasMore: false };
  const session = toHermesSession(localSession);
  const contextText = [
    `# ${session.title}`,
    `- id: ${session.id}`,
    `- machine: ${session.machineId}`,
    `- agent: ${session.agent}`,
    `- cwd: ${session.cwd ?? 'unknown'}`,
    `- resume: ${session.resumeCommand}`,
    `- recommendation: ${session.recommendation}`,
    '',
    session.summary,
    session.detailedSummary ? `\n${session.detailedSummary}` : '',
    history.messages.length ? '\n## Recent history' : '',
    ...history.messages.map((message) => `- ${message.role}: ${message.text}`),
  ]
    .filter(Boolean)
    .join('\n');

  return { session, history, contextText };
});

app.post('/api/hermes/jobs/resume', async (request, reply) => {
  const body = resumeJobSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const identity = {
    sessionId: body.sessionId,
    machineId: body.machineId,
    agent: body.agent,
  };
  const resolution = await resolveHermesSession(identity, allowRemote);
  if (resolution.status !== 'found') {
    return sendHermesSessionResolutionError(reply, identity, resolution);
  }

  const localMachineId = service.getMeta().machineId;
  if (resolution.session.machineId !== localMachineId) {
    if (!allowRemote) {
      return reply.code(404).send({ error: 'Selected session is remote and remote resume is disabled' });
    }
    const remoteAgent = remoteAgents.find((agent) => agent.id === resolution.session.machineId);
    if (!remoteAgent) {
      return reply.code(404).send({ error: `Remote machine not configured: ${resolution.session.machineId}` });
    }
    try {
      return await postAgentJson(remoteAgent, '/api/hermes/jobs/resume?remote=0', {
        ...body,
        machineId: resolution.session.machineId,
        agent: resolution.session.agent,
      });
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : `Remote resume failed: ${resolution.session.machineId}`,
      });
    }
  }

  const session = withEffectiveJobCwd(resolution.session);
  const resumePrompt = buildCodexWorkerPrompt({
    query: body.prompt,
    prompt: body.prompt,
    session: toHermesSession(session),
    template: body.template,
    policyProfile: body.policyProfile,
  });
  const startInput = {
    session,
    prompt: resumePrompt,
    model: body.model,
    extraArgs: body.extraArgs,
    mode: hermesJobMode(body.mode),
    supervisor: supervisorEnabled(body.supervisor),
    supervisorStrategy: supervisorStrategy(body.supervisor),
    policy: mergeJobPolicy(body.policyProfile, body.policy, session.cwd),
    onExit: (completedJob: CodexResumeJob) => {
      void finalizeJobFacts(completedJob, body.prompt, 'resume job finished').catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
      });
      void enqueueEvaluationRefresh(
        completedJob.sessionId,
        `job:${completedJob.id}:${completedJob.status}`,
        session.machineId,
        session.agent,
      ).catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Hermes job evaluation refresh enqueue failed');
      });
    },
  };
  const job = startCodexResumeJob(startInput);
  await service.markHermesSessionUsed(session.id, session.agent, job.id);
  expireSessionCaches();
  return { job };
});

app.post('/api/hermes/dispatch', async (request, reply) => {
  const body = hermesDispatchSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const localMachineId = service.getMeta().machineId;
  const limit = body.limit ?? 5;
  const threshold = body.requireConfirmationBelowScore ?? 10;
  let strictRemoteSessions: CodexSession[] | undefined;
  if (allowRemote && !body.sessionId) {
    const candidates = body.machineId && body.machineId !== localMachineId
      ? remoteAgents.filter((agent) => agent.id === body.machineId)
      : body.machineId === localMachineId
        ? []
        : remoteAgents;
    if (body.machineId && body.machineId !== localMachineId && !candidates.length) {
      return reply.code(404).send({
        error: `Remote machine not configured: ${body.machineId}`,
        code: 'SESSION_MACHINE_NOT_CONFIGURED',
      });
    }
    const inventory = await getRemoteSessionsStrict(candidates);
    if (inventory.status === 'unavailable') {
      return reply.code(503).send({
        error: `Remote session inventory unavailable: ${inventory.machineIds.join(', ')}`,
        code: 'REMOTE_SESSION_INVENTORY_UNAVAILABLE',
        machineIds: inventory.machineIds,
      });
    }
    strictRemoteSessions = inventory.sessions;
  }
  const contextPack = await buildContextPackResponse({
    q: body.query,
    cwd: body.cwd,
    repo: body.repo,
    limit,
    remote: allowRemote ? undefined : '0',
  }, strictRemoteSessions);
  const localSessions = await getLocalSessionsCached(false, true);
  const remoteSessions = allowRemote
    ? (strictRemoteSessions ?? await getRemoteSessionsCached())
    : [];
  const allSessions = [...localSessions, ...remoteSessions];
  const identityFilteredSessions = allSessions.filter(
    (session) =>
      (!body.machineId || session.machineId === body.machineId) &&
      (!body.agent || session.agent === body.agent)
  );

  let explicitSession: SessionListItem | null = null;
  if (body.sessionId) {
    const explicitIdentity = {
      sessionId: body.sessionId,
      machineId: body.machineId,
      agent: body.agent,
    };
    const resolution = await resolveHermesSession(explicitIdentity, allowRemote);
    if (resolution.status === 'ambiguous' || resolution.status === 'unavailable') {
      return sendHermesSessionResolutionError(reply, explicitIdentity, resolution);
    }
    if (resolution.status === 'missing') {
      return {
        status: 'needs_selection',
        reason: `Session not found: ${body.sessionId}`,
        query: body.query,
        contextPack,
        candidates: [],
      };
    }
    if (resolution.status === 'found') explicitSession = resolution.session;
  }

  const recommendedResume = !body.sessionId &&
    contextPack.recommendedResume &&
    (!body.machineId || contextPack.recommendedResume.machineId === body.machineId) &&
    (!body.agent || contextPack.recommendedResume.agent === body.agent)
      ? contextPack.recommendedResume
      : null;
  const recommendedIdentityKey = recommendedResume
    ? `${recommendedResume.machineId}|||${recommendedResume.agent}|||${recommendedResume.sessionId}`
    : null;
  const selectionPool = explicitSession ? [explicitSession] : identityFilteredSessions;
  const scored = selectionPool
    .map((session) => ({
      session,
      score: recommendedIdentityKey === hermesSessionIdentityKey(session)
        ? 10_000
        : scoreHermesMatch(session, body.query),
    }))
    .filter((item) => explicitSession || recommendedIdentityKey
      ? explicitSession === item.session || recommendedIdentityKey === hermesSessionIdentityKey(item.session)
      : item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.session.updatedAt ?? '') - Date.parse(a.session.updatedAt ?? ''));
  const candidates = scored.slice(0, limit).map((item) => toHermesSession(item.session, body.query));
  const selected = candidates[0] ?? null;
  const selectedSession = scored[0]?.session ?? null;

  if (!selected || !selectedSession) {
    return {
      status: 'needs_selection',
      reason: body.sessionId
        ? `Session not found: ${body.sessionId}`
        : (contextPack.newSessionReason ?? 'No relevant Codex session matched the request.'),
      query: body.query,
      contextPack,
      candidates: [],
    };
  }

  if (!body.sessionId && !recommendedResume && selected.score < threshold) {
    return {
      status: 'needs_selection',
      reason: `Best match score ${selected.score} is below confirmation threshold ${threshold}.`,
      query: body.query,
      contextPack,
      selectedSession: selected,
      candidates,
    };
  }

  const selectedForJob = withEffectiveHermesSessionCwd(selected);
  const workerPrompt = buildCodexWorkerPrompt({
    query: body.query,
    prompt: body.prompt,
    session: selectedForJob,
    template: body.template,
    policyProfile: body.policyProfile,
    contextPackText: contextPack.workerPromptContext,
  });

  if (selectedSession.machineId !== localMachineId) {
    if (!allowRemote) {
      return reply.code(404).send({ error: 'Selected session is not local and remote dispatch is disabled' });
    }
    const remoteAgent = remoteAgents.find((agent) => agent.id === selectedSession.machineId);
    if (!remoteAgent) {
      return reply.code(404).send({ error: `Remote machine not configured: ${selectedSession.machineId}` });
    }
    try {
      const remotePayload = await postAgentJson<{
        job?: unknown;
      }>(remoteAgent, '/api/hermes/jobs/resume?remote=0', {
        sessionId: selectedSession.id,
        machineId: selectedSession.machineId,
        agent: selectedSession.agent,
        prompt: body.prompt ?? body.query,
        model: body.model,
        extraArgs: body.extraArgs,
        mode: hermesJobMode(body.mode),
        supervisor: body.supervisor === false ? false : supervisorStrategy(body.supervisor),
        policy: mergeJobPolicy(body.policyProfile, body.policy, selectedForJob.cwd),
        policyProfile: body.policyProfile,
        template: body.template,
      });
      return {
        status: 'started',
        ...remotePayload,
        routedTo: remoteAgent.id,
        query: body.query,
        selectedSession: selected,
        contextPack,
        candidates,
        nextAction: remotePayload.job && typeof remotePayload.job === 'object' && 'id' in remotePayload.job
          ? `Poll /api/hermes/jobs/${String((remotePayload.job as { id?: unknown }).id)} until status is completed, failed, or stopped.`
          : 'Poll the remote job registry for completion.',
      };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : `Failed to dispatch session ${selected.id} to ${remoteAgent.id}`,
      });
    }
  }

  const localSession = selectedSession;
  const jobSession = withEffectiveJobCwd(localSession);
  const startInput = {
    session: jobSession,
    prompt: workerPrompt,
    model: body.model,
    extraArgs: body.extraArgs,
    mode: hermesJobMode(body.mode),
    supervisor: supervisorEnabled(body.supervisor),
    supervisorStrategy: supervisorStrategy(body.supervisor),
    policy: mergeJobPolicy(body.policyProfile, body.policy, jobSession.cwd),
    onExit: (completedJob: CodexResumeJob) => {
      void finalizeJobFacts(completedJob, body.prompt ?? body.query, 'dispatch job finished').catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
      });
      void enqueueEvaluationRefresh(
        completedJob.sessionId,
        `dispatch:${completedJob.id}:${completedJob.status}`,
        localSession.machineId,
        localSession.agent,
      ).catch((error) => {
        app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Hermes dispatch evaluation refresh enqueue failed');
      });
    },
  };
  const job = startCodexResumeJob(startInput);
  await service.markHermesSessionUsed(localSession.id, localSession.agent, job.id);
  expireSessionCaches();

  return {
    status: 'started',
    query: body.query,
    selectedSession: selected,
    contextPack,
    candidates,
    job,
    nextAction: `Poll /api/hermes/jobs/${job.id} until status is completed, failed, or stopped.`,
  };
});

app.get('/api/hermes/jobs', async () => ({ jobs: listCodexResumeJobs() }));

app.get('/api/hermes/job-registry', async (request) => {
  const query = remoteControlSchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const meta = service.getMeta();
  const jobs: Array<{ machineId: string; baseUrl: string | null; job: CodexResumeJob }> = listCodexResumeJobs().map((job) => ({
    machineId: job.machineId || meta.machineId,
    baseUrl: null,
    job,
  }));
  const errors: Array<{ machineId: string; baseUrl: string; error: string }> = [];
  const health: Array<{ machineId: string; baseUrl: string; healthy: boolean; updatedAt: string; cached: boolean; error: string | null }> = [];

  if (includeRemote) {
    for (const agent of remoteAgents) {
      const remote = await fetchRemoteJobRegistryCached(agent);
      jobs.push(...remote.jobs);
      health.push(remote.health);
      if (remote.health.error) errors.push({ machineId: agent.id, baseUrl: agent.baseUrl, error: remote.health.error });
    }
  }

  return {
    machineId: meta.machineId,
    baseUrl: null,
    jobs,
    count: jobs.length,
    health,
    errors,
  };
});

app.get('/api/hermes/jobs/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const job = getCodexResumeJob(params.id);
  if (!job) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await fetchAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}?remote=0`);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  return { job };
});

app.get('/api/hermes/jobs/:id/outcome', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const liveJob = getCodexResumeJob(params.id);
  if (liveJob) {
    return {
      jobId: params.id,
      sessionId: liveJob.sessionId,
      outcome: jobOutcomeFromJob(liveJob, liveJob.prompt),
      job: liveJob,
    };
  }
  const stored = await service.findJobOutcome(params.id);
  if (!stored) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await fetchAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/outcome?remote=0`);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job outcome not found' });
  }
  return { jobId: params.id, ...stored };
});

app.get('/api/sessions/:id/outcome', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionIdentityQuerySchema.parse(request.query);
  const identity = {
    sessionId: params.id,
    machineId: query.machineId,
    agent: query.agent,
  };
  const resolution = await resolveHermesSession(identity, true);
  if (resolution.status !== 'found') {
    return sendHermesSessionResolutionError(reply, identity, resolution);
  }

  const localMachineId = service.getMeta().machineId;
  if (resolution.session.machineId !== localMachineId) {
    const remoteAgent = remoteAgents.find((agent) => agent.id === resolution.session.machineId);
    if (!remoteAgent) {
      return reply.code(404).send({ error: `Remote machine not configured: ${resolution.session.machineId}` });
    }
    const remoteQuery = new URLSearchParams({
      machineId: resolution.session.machineId,
      agent: resolution.session.agent,
    });
    try {
      return await fetchAgentJson(
        remoteAgent,
        `/api/sessions/${encodeURIComponent(params.id)}/outcome?${remoteQuery.toString()}`
      );
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : `Remote outcome unavailable: ${resolution.session.machineId}`,
      });
    }
  }

  const evaluation = resolution.session.evaluation;
  return {
    sessionId: resolution.session.id,
    machineId: resolution.session.machineId,
    agent: resolution.session.agent,
    title: resolution.session.title,
    hermesLastJobId: evaluation.hermesLastJobId ?? null,
    jobOutcomes: evaluation.jobOutcomes ?? [],
    failureCards: evaluation.failureCards ?? [],
    summary: evaluation.summary,
    detailedSummary: evaluation.detailedSummary,
    searchText: evaluation.searchText,
  };
});

app.get('/api/hermes/jobs/:id/events', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = jobEventsQuerySchema.parse(request.query);
  const afterSeq = query.afterSeq ?? 0;
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const job = getCodexResumeJob(params.id);
  if (!job) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await fetchAgentJson(
            agent,
            `/api/hermes/jobs/${encodeURIComponent(params.id)}/events?afterSeq=${afterSeq}&remote=0`
          );
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  const events = listCodexJobEvents(params.id, afterSeq);
  return {
    jobId: params.id,
    afterSeq,
    nextSeq: events.reduce((max, event) => Math.max(max, event.seq + 1), afterSeq + 1),
    events,
    job: compactJobForEvents(job),
  };
});

app.get('/api/hermes/jobs/:id/events/stream', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = jobEventsQuerySchema.parse(request.query);
  const job = getCodexResumeJob(params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });

  let afterSeq = query.afterSeq ?? 0;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ jobId: params.id, afterSeq })}\n\n`);

  const send = (): void => {
    const current = getCodexResumeJob(params.id);
    if (!current) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
      clearInterval(timer);
      reply.raw.end();
      return;
    }
    const events = listCodexJobEvents(params.id, afterSeq);
    for (const event of events) {
      afterSeq = Math.max(afterSeq, event.seq);
      reply.raw.write(`event: job-event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString(), status: current.status, afterSeq })}\n\n`);
    if (current.status !== 'running') {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ job: compactJobForEvents(current), afterSeq })}\n\n`);
      clearInterval(timer);
      reply.raw.end();
    }
  };
  const timer = setInterval(send, readIntEnv('CURATOR_JOB_EVENTS_STREAM_INTERVAL_MS', 1000, 250, 10_000));
  request.raw.on('close', () => clearInterval(timer));
  send();
  return reply;
});

app.post('/api/hermes/jobs/:id/stop', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const job = stopCodexResumeJob(params.id);
  if (!job) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/stop?remote=0`, {});
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  recordCodexJobAudit(params.id, 'stop', auditMeta(request));
  await finalizeJobFacts(job, job.prompt, 'job stopped by API');
  return { job };
});

app.post('/api/hermes/jobs/:id/protocol', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = jobProtocolSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const localJob = getCodexResumeJob(params.id);
  if (!localJob) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/protocol?remote=0`, body);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }

  const protocolText = body.text.trim() || {
    continue: '继续当前任务，按既定目标完成并报告验证结果。',
    summarize: '请总结当前进展、已修改文件、验证结果和剩余风险。',
    handoff: '请输出结构化交接报告，包括上下文、已完成事项、未完成事项、命令结果和下一步。',
    verify: '请运行或说明最相关的验证，并报告结果。',
    pause: '请暂停当前操作，保留上下文，等待下一条继续或指导指令。',
    guide: '',
  }[body.kind];
  if (!protocolText) return reply.code(400).send({ error: 'Protocol text is required for guide' });

  const result = sendCodexJobProtocolMessage(params.id, body.kind as CodexJobProtocolKind, protocolText);
  if (!result) return reply.code(404).send({ error: 'Job not found' });
  recordCodexJobAudit(params.id, `protocol:${body.kind}`, {
    ...auditMeta(request),
    kind: body.kind,
    text: protocolText.slice(0, 1000),
  });
  return {
    kind: body.kind,
    action: result.injected ? 'guided' : 'recorded',
    injected: result.injected,
    error: result.error,
    event: result.event,
    job: result.job,
  };
});

app.post('/api/hermes/jobs/:id/guidance', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = jobGuidanceSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const job = sendCodexJobGuidance(params.id, body.text, body.source ?? 'hermes');
  if (!job) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/guidance?remote=0`, body);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  recordCodexJobAudit(params.id, 'guidance', {
    ...auditMeta(request),
    source: body.source ?? 'hermes',
    text: body.text.slice(0, 1000),
  });
  return { job };
});

app.post('/api/hermes/jobs/:id/supervise', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = jobSupervisorSchema.parse(request.body ?? {});
  const query = remoteControlSchema.parse(request.query);
  const allowRemote = query.remote !== '0' && query.remote !== 'false';
  const localSessions = body.autoRetry ? await getStateSessionsForHermes() : [];
  const superviseInput = {
    id: params.id,
    instruction: body.instruction,
    autoStop: body.autoStop,
    autoRetry: body.autoRetry,
    checkIntervalMs: body.checkIntervalMs,
    staleOutputMs: body.staleOutputMs,
    restart: (previousJob: CodexResumeJob, prompt: string) => {
      if (!previousJob.agentVerified) {
        throw new Error(`Supervisor retry refused for unverified Agent identity: ${previousJob.id}`);
      }
      const session = localSessions.find(
        (item) =>
          item.id === previousJob.sessionId &&
          item.machineId === previousJob.machineId &&
          item.agent === previousJob.agent,
      );
      if (!session) throw new Error(`Session not found for retry: ${previousJob.sessionId}`);
      return startCodexResumeJob({
        session,
        prompt,
        mode: codexJobMode(body.retryMode ?? previousJob.mode),
        supervisor: true,
        policy: previousJob.policy,
        onExit: (completedJob: CodexResumeJob) => {
          void finalizeJobFacts(completedJob, prompt, 'supervisor retry job finished').catch((error) => {
            app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Job fact write failed');
          });
          void enqueueEvaluationRefresh(
            completedJob.sessionId,
            `supervisor:${completedJob.id}:${completedJob.status}`,
            session.machineId,
            session.agent,
          ).catch((error) => {
            app.log.warn({ jobId: completedJob.id, sessionId: completedJob.sessionId, error }, 'Supervisor retry evaluation refresh enqueue failed');
          });
        },
      });
    },
  };
  const result = superviseCodexResumeJob(superviseInput);
  if (!result) {
    if (allowRemote) {
      for (const agent of remoteAgents) {
        try {
          return await postAgentJson(agent, `/api/hermes/jobs/${encodeURIComponent(params.id)}/supervise?remote=0`, body);
        } catch {
          // Try the next remote agent.
        }
      }
    }
    return reply.code(404).send({ error: 'Job not found' });
  }
  recordCodexJobAudit(params.id, 'supervise', {
    ...auditMeta(request),
    autoStop: body.autoStop,
    autoRetry: body.autoRetry,
    semantic: body.semantic,
  });

  let semantic = null;
  if (body.semantic || process.env.CURATOR_CODEX_SEMANTIC_SUPERVISOR === '1') {
    semantic = await evaluateJobSemantics({
      job: result.job,
      events: listCodexJobEvents(params.id, Math.max(0, (result.job.eventSeq ?? 0) - 80)),
      policy: result.job.policy,
    });
    if (semantic) {
      recordCodexJobAudit(params.id, 'semantic-supervisor', {
        decision: semantic.decision,
        reason: semantic.reason,
        confidence: semantic.confidence,
      });
      if (semantic.decision === 'needs_guidance' && semantic.guidance && result.job.mode === 'pty') {
        sendCodexJobGuidance(params.id, semantic.guidance, 'supervisor');
      }
      if ((semantic.decision === 'stop' || semantic.decision === 'failed') && body.autoStop) {
        const stopped = stopCodexResumeJob(params.id);
        if (stopped) await finalizeJobFacts(stopped, stopped.prompt, semantic.reason);
      }
    }
  }
  return { ...result, semantic };
});

app.post('/api/sessions/ai-search', async (request) => {
  const startedAt = Date.now();
  const body = aiSessionSearchSchema.parse(request.body ?? {});
  const limit = body.limit ?? 10;
  const [localSessions, remoteSessions, panelState] = await Promise.all([
    getLocalSessionsCached(false, true),
    getRemoteSessionsCached(),
    service.ensureLegacyStateMigrated(),
  ]);
  const sessions = [...localSessions, ...remoteSessions]
    .map((session) => applyPanelSessionState(session, panelState))
    .filter(
      (session) =>
        (!body.machineId || body.machineId === 'all' || session.machineId === body.machineId) &&
        (!body.agent || body.agent === 'all' || session.agent === body.agent),
    );
  const availableMachineIds = [...new Set(sessions.map((session) => session.machineId))].sort();
  const mentionedMachineIds = findMentionedMachineIds(body.query, availableMachineIds);
  const totalTimeoutMs = readIntEnv('CURATOR_AI_SEARCH_TIMEOUT_MS', 12_000, 1_500, 15_000);
  const machineProfiles = buildAiSearchMachineProfiles(sessions, body.query);
  let routing = {
    mode: (
      body.machineId && body.machineId !== 'all'
        ? 'user-filter'
        : mentionedMachineIds.length
          ? 'local-hint'
          : 'broad'
    ) as 'deepseek' | 'user-filter' | 'local-hint' | 'broad',
    scope: (mentionedMachineIds.length || (body.machineId && body.machineId !== 'all') ? 'focused' : 'broad') as 'focused' | 'broad',
    machineIds: (
      body.machineId && body.machineId !== 'all'
        ? availableMachineIds
        : mentionedMachineIds.length
          ? mentionedMachineIds
          : availableMachineIds
    ),
    confidence: body.machineId && body.machineId !== 'all' ? 1 : mentionedMachineIds.length ? 0.98 : 0.25,
    reason:
      body.machineId && body.machineId !== 'all'
        ? '使用面板中显式选择的机器范围'
        : mentionedMachineIds.length
          ? `从查询中识别到已注册机器 ${mentionedMachineIds.join('、')}`
          : '没有可靠的机器线索，保留全部机器',
    searchTerms: [] as string[],
    latencyMs: 0,
    fallbackReason: null as string | null,
  };
  let model: string | null = null;

  const expandedQuery = [body.query, ...routing.searchTerms].join(' ').trim();
  const candidateLimit = readIntEnv('CURATOR_AI_SEARCH_CANDIDATE_LIMIT', 18, 18, 60);
  const selected = selectAiSearchCandidatesForRoute(
    sessions,
    expandedQuery,
    candidateLimit,
    routing.machineIds,
    routing.confidence,
  );
  const candidates: AiSearchCandidate[] = selected.map(({ session, localScore }, index) => ({
    candidateId: `c${index + 1}`,
    ...aiSearchCandidateFields(session),
    localScore,
  }));
  const sessionByCandidateId = new Map(
    candidates.map((candidate, index) => [
      candidate.candidateId,
      {
        candidate,
        session: selected[index].session,
      },
    ]),
  );

  let mode: 'deepseek' | 'fallback-local' = 'deepseek';
  let intent = body.query;
  let fallbackReason: string | null = null;
  let rankingLatencyMs = 0;
  let rankedMatches: Array<{ candidateId: string; confidence: number; reason: string }> = [];
  if (candidates.length) {
    try {
      const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
      if (remainingMs < 500) {
        throw new AiSearchUnavailableError('timeout', 'DeepSeek search deadline was exhausted during machine routing');
      }
      const ranked = await rankAiSearchCandidates(body.query, candidates, limit, {
        timeoutMs: remainingMs,
        route: {
          intent,
          machineIds: routing.machineIds,
          confidence: routing.confidence,
          searchTerms: routing.searchTerms,
          reason: routing.reason,
        },
        machineProfiles,
      });
      intent = ranked.intent.trim() || body.query;
      model = ranked.model;
      rankingLatencyMs = ranked.durationMs;
      routing = {
        mode: 'deepseek',
        scope:
          ranked.machineConfidence >= 0.62 && ranked.machineIds.length < availableMachineIds.length
            ? 'focused'
            : 'broad',
        machineIds: ranked.machineIds,
        confidence: ranked.machineConfidence,
        reason: ranked.machineReason || 'DeepSeek 根据跨机器候选共同判断',
        searchTerms: ranked.searchTerms,
        latencyMs: ranked.durationMs,
        fallbackReason: null,
      };
      const seen = new Set<string>();
      rankedMatches = ranked.matches
        .filter((match) => {
          if (!sessionByCandidateId.has(match.candidateId) || seen.has(match.candidateId)) return false;
          seen.add(match.candidateId);
          return true;
        })
        .slice(0, limit);
      if (!rankedMatches.length) {
        mode = 'fallback-local';
        fallbackReason = 'empty-model-result';
      }
    } catch (error) {
      mode = 'fallback-local';
      fallbackReason = error instanceof AiSearchUnavailableError ? error.code : 'request-failed';
      request.log.warn(
        { code: fallbackReason, phase: 'candidate-ranking' },
        'DeepSeek fast session search fell back to local ranking',
      );
    }
  } else {
    mode = 'fallback-local';
    fallbackReason = 'no-candidates';
  }

  if (mode === 'fallback-local') {
    const hasLexicalMatches = candidates.some((candidate) => candidate.localScore > 0);
    const routedByDeepSeek = routing.mode === 'deepseek';
    const focusedMachines = routing.machineIds.join('、');
    rankedMatches = candidates.slice(0, limit).map((candidate) => ({
      candidateId: candidate.candidateId,
      confidence: localAiSearchConfidence(candidate.localScore, hasLexicalMatches),
      reason: routedByDeepSeek
        ? `DeepSeek 已判断优先机器为 ${focusedMachines || '全部机器'}；会话重排超时后按 AI 扩展词与本地相似度排序`
        : hasLexicalMatches && candidate.localScore > 0
          ? 'DeepSeek 暂不可用，按机器提示、标题、摘要、关键词和最近问题的本地相似度排序'
          : 'DeepSeek 暂不可用且没有明显字面匹配，先按机器范围、近期与保留会话排序',
    }));
  }

  const matches = rankedMatches.flatMap((match) => {
    const selectedMatch = sessionByCandidateId.get(match.candidateId);
    if (!selectedMatch) return [];
    const { candidate, session } = selectedMatch;
    return [{
      identity: {
        key: aiSearchSessionKey(session),
        sessionId: session.id,
        machineId: session.machineId,
        agent: session.agent,
      },
      confidence: match.confidence,
      reason: match.reason,
      localScore: candidate.localScore,
      session: toSessionSummary(session),
    }];
  });

  return {
    query: body.query,
    intent,
    mode,
    model,
    fallbackReason,
    routing: {
      ...routing,
    },
    phaseLatencyMs: {
      routing: routing.latencyMs,
      ranking: rankingLatencyMs,
    },
    latencyMs: Date.now() - startedAt,
    candidateCount: candidates.length,
    candidateMachineCounts: Object.fromEntries(
      availableMachineIds.map((machineId) => [
        machineId,
        candidates.filter((candidate) => candidate.machineId === machineId).length,
      ]),
    ),
    count: matches.length,
    matches,
  };
});

app.get('/api/sessions', async (request) => {
  const query = z
    .object({
      q: z.string().optional(),
      recommendation: z.enum(['all', 'keep', 'review', 'delete']).optional(),
      refresh: z.enum(['0', '1', 'true', 'false']).optional(),
      remote: z.enum(['0', '1', 'true', 'false']).optional(),
      detail: z.enum(['0', '1', 'true', 'false']).optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(500).optional(),
    })
    .parse(request.query);
  const refreshWorkflow = query.refresh === '1' || query.refresh === 'true';
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const includeDetails = query.detail !== '0' && query.detail !== 'false';
  const localSessions = await getLocalSessionsCached(refreshWorkflow, !includeDetails);
  const remoteSessions = refreshWorkflow || !includeRemote
    ? []
    : await getRemoteSessionsCached();
  const panelState = await service.ensureLegacyStateMigrated();
  const sessions = [...localSessions, ...remoteSessions].map((session) => applyPanelSessionState(session, panelState));
  const filtered = sessions.filter((session) => {
    const matchesRecommendation =
      !query.recommendation ||
      query.recommendation === 'all' ||
      session.evaluation.recommendation === query.recommendation;
    const text = sessionSearchText(session);
    const matchesQuery = !query.q || text.includes(query.q.toLowerCase());
    return matchesRecommendation && matchesQuery;
  });

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? (filtered.length || 1);
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  return {
    meta: { ...service.getMeta(), remoteAgents: remoteAgents.map((agent) => ({ id: agent.id, baseUrl: agent.baseUrl })) },
    sessions: includeDetails ? paged : paged.map(toSessionSummary),
    total: sessions.length,
    filteredTotal: filtered.length,
    page,
    pageSize,
  };
});

app.get('/api/remote-agents', async () => ({
  agents: await Promise.all(remoteAgents.map((agent) => checkRemoteAgent(agent))),
}));

app.get('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = machineRouteQuerySchema.parse(request.query);
  try {
    const panelState = await service.ensureLegacyStateMigrated();
    const routed = await findRoutableSession(params.id, query.machineId, query.agent);
    if (routed) return applyPanelSessionState(routed.session, panelState);
    return reply.code(404).send({ error: 'Session not found' });
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Session lookup failed');
  }
});

app.get('/api/sessions/:id/files', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionFilesQuerySchema.parse(request.query);
  let routed: Awaited<ReturnType<typeof findRoutableSession>>;
  try {
    routed = await findRoutableSession(params.id, query.machineId, query.agent);
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Session lookup failed');
  }
  if (!routed) return reply.code(404).send({ error: 'Session not found' });

  if (routed.kind === 'local') {
    try {
      return await listSessionWorkdir(routed.session, query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to list session cwd' });
    }
  }

  try {
    return await listRemoteSessionWorkdir(routed.session, query.path);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to list remote session cwd' });
  }
});

app.get('/api/sessions/:id/files/download', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionFilesQuerySchema.parse(request.query);
  let routed: Awaited<ReturnType<typeof findRoutableSession>>;
  try {
    routed = await findRoutableSession(params.id, query.machineId, query.agent);
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Session lookup failed');
  }
  if (!routed) return reply.code(404).send({ error: 'Session not found' });

  if (routed.kind === 'local') {
    try {
      const { targetReal } = await resolveSessionWorkdirPath(routed.session, query.path);
      const targetStat = await stat(targetReal);
      if (!targetStat.isFile()) return reply.code(400).send({ error: 'Path is not a file' });
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(targetStat.size));
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(basename(targetReal))}"`);
      return reply.send(createReadStream(targetReal));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to download file' });
    }
  }

  try {
    const file = await statRemoteSessionFile(routed.session, query.path);
    const child = spawnRemoteFileDownload(file.target, routed.session, query.path);
    child.stderr.on('data', (chunk: Buffer) => app.log.warn({ sessionId: params.id, error: chunk.toString('utf8') }, 'Remote file download stderr'));
    request.raw.on('close', () => child.kill());
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(file.size));
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    return reply.send(child.stdout);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to download remote file' });
  }
});

app.post('/api/sessions/:id/files/upload', { bodyLimit: 100 * 1024 * 1024 }, async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = sessionFileUploadQuerySchema.parse(request.query);
  const body = request.body;
  if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'Expected application/octet-stream upload body' });
  let routed: Awaited<ReturnType<typeof findRoutableSession>>;
  try {
    routed = await findRoutableSession(params.id, query.machineId, query.agent);
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Session lookup failed');
  }
  if (!routed) return reply.code(404).send({ error: 'Session not found' });
  const overwrite = query.overwrite === '1' || query.overwrite === 'true';

  if (routed.kind === 'local') {
    try {
      const { target, directoryReal, relativePath } = await resolveSessionUploadPath(routed.session, query.path, query.name);
      await mkdir(directoryReal, { recursive: true });
      const flags = fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW |
        (overwrite ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
      const handle = await open(target, flags, 0o644);
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      const uploaded = await stat(target);
      return {
        ok: true,
        entry: {
          name: basename(target),
          path: fileEntryPath(relativePath, basename(target)),
          type: 'file',
          size: uploaded.size,
          mtime: uploaded.mtime.toISOString(),
        },
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to upload file' });
    }
  }

  try {
    return await uploadRemoteSessionFile(routed.session, query.path, query.name, overwrite, body);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to upload remote file' });
  }
});

app.get('/api/sessions/:id/history', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.coerce.number().int().min(0).optional(),
      machineId: z.string().min(1).max(300).optional(),
      agent: z.enum(['codex', 'claude']).optional(),
    })
    .parse(request.query);
  let routed: Awaited<ReturnType<typeof findRoutableSession>>;
  try {
    routed = await findRoutableSession(params.id, query.machineId, query.agent);
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'History lookup failed');
  }
  if (!routed) return reply.code(404).send({ error: 'Session not found' });
  if (routed.kind === 'local') {
    try {
      return await service.getSessionHistory(params.id, {
        limit: query.limit,
        beforeIndex: query.before ?? null,
        agent: routed.session.agent,
      });
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'History failed' });
    }
  }
  const remoteAgent = remoteAgents.find((agent) => agent.id === routed.session.machineId);
  if (!remoteAgent) return reply.code(404).send({ error: `Remote machine not configured: ${routed.session.machineId}` });
  const remoteQuery = new URLSearchParams({
    limit: String(query.limit ?? 80),
    machineId: routed.session.machineId,
    agent: routed.session.agent,
    remote: '0',
  });
  if (query.before !== undefined) remoteQuery.set('before', String(query.before));
  try {
    return await fetchAgentJson(
      remoteAgent,
      `/api/sessions/${encodeURIComponent(params.id)}/history?${remoteQuery.toString()}`,
    );
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'History failed' });
  }
});

app.get('/api/sessions/:id/messages', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(5000).optional(),
      before: z.coerce.number().int().min(0).optional(),
      after: z.coerce.number().int().min(0).optional(),
      full: z.enum(['0', '1', 'true', 'false']).optional(),
      preserve: z.enum(['0', '1', 'true', 'false']).optional(),
      machineId: z.string().min(1).max(300).optional(),
      agent: z.enum(['codex', 'claude']).optional(),
    })
    .parse(request.query);
  const full = query.full === '1' || query.full === 'true';
  const preserveWhitespace = query.preserve === '1' || query.preserve === 'true';
  let routed: Awaited<ReturnType<typeof findRoutableSession>>;
  try {
    routed = await findRoutableSession(params.id, query.machineId, query.agent);
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Messages lookup failed');
  }
  if (!routed) return reply.code(404).send({ error: 'Session not found' });
  if (routed.kind === 'local') {
    try {
      return await service.getSessionMessages(params.id, {
        limit: query.limit,
        beforeIndex: query.before ?? null,
        afterIndex: query.after ?? null,
        full,
        preserveWhitespace,
        agent: routed.session.agent,
      });
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Messages failed' });
    }
  }
  const remoteAgent = remoteAgents.find((agent) => agent.id === routed.session.machineId);
  if (!remoteAgent) return reply.code(404).send({ error: `Remote machine not configured: ${routed.session.machineId}` });
  const remoteQuery = new URLSearchParams({
    machineId: routed.session.machineId,
    agent: routed.session.agent,
    remote: '0',
  });
  if (query.limit !== undefined) remoteQuery.set('limit', String(query.limit));
  if (query.before !== undefined) remoteQuery.set('before', String(query.before));
  if (query.after !== undefined) remoteQuery.set('after', String(query.after));
  if (query.full !== undefined) remoteQuery.set('full', query.full);
  if (query.preserve !== undefined) remoteQuery.set('preserve', query.preserve);
  try {
    return await fetchAgentJson(
      remoteAgent,
      `/api/sessions/${encodeURIComponent(params.id)}/messages?${remoteQuery.toString()}`,
    );
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Messages failed' });
  }
});

app.get('/api/sessions/:id/terminal', { websocket: true }, async (socket, request) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      cols: z.coerce.number().int().min(40).max(500).optional(),
      rows: z.coerce.number().int().min(12).max(160).optional(),
      machineId: z.string().min(1).max(300).optional(),
      agent: z.enum(['codex', 'claude']).optional(),
    })
    .parse(request.query);
  let routed: Awaited<ReturnType<typeof findRoutableSession>>;
  try {
    routed = await findRoutableSession(params.id, query.machineId, query.agent);
  } catch (error) {
    socket.send(JSON.stringify({
      type: 'error',
      data: error instanceof Error ? error.message : 'Session lookup failed',
    }));
    socket.close();
    return;
  }
  if (!routed) {
    socket.send(JSON.stringify({ type: 'error', data: 'Session not found' }));
    socket.close();
    return;
  }

  const terminal = startCodexTerminal(routed.session, (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }, query);

  socket.on('message', (raw: { toString(): string }) => {
    try {
      terminal.write(JSON.parse(raw.toString()) as TerminalInput);
    } catch {
      socket.send(JSON.stringify({ type: 'error', data: 'Invalid terminal input' }));
    }
  });
  socket.on('close', () => terminal.close());
  socket.on('error', () => terminal.close());
});

app.get('/api/recycle-bin', async (request) => {
  const query = machineRouteQuerySchema.parse(request.query);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const result = await listRecycleArchivesAggregated(includeRemote);
  return {
    meta: service.getMeta(),
    archives: result.archives,
    errors: result.errors,
  };
});

app.post('/api/recycle-bin/:id/restore', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = recycleArchiveRouteQuerySchema.parse(request.query);
  confirmSchema.parse(request.body);
  try {
    const allowRemote = query.remote !== '0' && query.remote !== 'false';
    const result = await restoreRecycleArchiveByMachine(params.id, query, allowRemote);
    clearSessionCaches();
    return result;
  } catch (error) {
    if (error instanceof SessionRoutingError) {
      return sendSessionRoutingError(reply, error, 'Restore failed');
    }
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Restore failed' });
  }
});

app.delete('/api/recycle-bin/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = recycleArchiveRouteQuerySchema.parse(request.query);
  confirmSchema.parse(request.body);
  try {
    const allowRemote = query.remote !== '0' && query.remote !== 'false';
    const result = await purgeRecycleArchiveByMachine(params.id, query, allowRemote);
    return result;
  } catch (error) {
    if (error instanceof SessionRoutingError) {
      return sendSessionRoutingError(reply, error, 'Purge failed');
    }
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Purge failed' });
  }
});

app.post('/api/sessions/:id/keep', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = keepSchema.parse(request.body);
  try {
    const routed = await findRoutableSession(params.id, body.machineId, body.agent);
    if (!routed) return reply.code(404).send({ error: 'Session not found' });
    if (routed.kind === 'remote') {
      const remoteAgent = remoteAgents.find((agent) => agent.id === routed.session.machineId);
      if (!remoteAgent) throw new Error(`Remote machine not configured: ${routed.session.machineId}`);
      const result = await postAgentJson(
        remoteAgent,
        `/api/sessions/${encodeURIComponent(params.id)}/keep`,
        {
          kept: body.kept,
          machineId: routed.session.machineId,
          agent: routed.session.agent,
        },
      );
      clearSessionCaches();
      return result;
    }
    await service.setKept(params.id, body.kept, routed.session.agent);
    clearSessionCaches();
    return {
      id: params.id,
      machineId: routed.session.machineId,
      agent: routed.session.agent,
      kept: body.kept,
    };
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Keep failed');
  }
});

app.post('/api/sessions/:id/title', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = titleSchema.parse(request.body);
  try {
    const routed = await findRoutableSession(params.id, body.machineId, body.agent);
    if (!routed) return reply.code(404).send({ error: 'Session not found' });
    if (routed.kind === 'remote') {
      const remoteAgent = remoteAgents.find((agent) => agent.id === routed.session.machineId);
      if (!remoteAgent) throw new Error(`Remote machine not configured: ${routed.session.machineId}`);
      const result = await postAgentJson(
        remoteAgent,
        `/api/sessions/${encodeURIComponent(params.id)}/title`,
        {
          title: body.title,
          machineId: routed.session.machineId,
          agent: routed.session.agent,
        },
      );
      clearSessionCaches();
      return result;
    }
    await service.setTitle(params.id, body.title, routed.session.agent);
    clearSessionCaches();
    return {
      id: params.id,
      machineId: routed.session.machineId,
      agent: routed.session.agent,
      title: body.title.trim().slice(0, 120),
    };
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Title failed');
  }
});

app.post('/api/sessions/:id/migrate', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = migrateSchema.parse(request.body);
  try {
    const routed = await findRoutableSession(params.id, body.machineId, body.agent);
    if (!routed) return reply.code(404).send({ error: 'Session not found' });
    if (routed.kind === 'remote') {
      const remoteAgent = remoteAgents.find((agent) => agent.id === routed.session.machineId);
      if (!remoteAgent) throw new Error(`Remote machine not configured: ${routed.session.machineId}`);
      const result = await postAgentJson(
        remoteAgent,
        `/api/sessions/${encodeURIComponent(params.id)}/migrate`,
        {
          targetProjectDir: body.targetProjectDir,
          machineId: routed.session.machineId,
          agent: routed.session.agent,
        },
      );
      clearSessionCaches();
      return result;
    }
    const result = await service.migrateSessionToProject(
      params.id,
      body.targetProjectDir,
      routed.session.agent,
    );
    clearSessionCaches();
    return {
      ...result,
      machineId: routed.session.machineId,
      agent: routed.session.agent,
    };
  } catch (error) {
    if (error instanceof SessionRoutingError) {
      return sendSessionRoutingError(reply, error, 'Migrate failed');
    }
    if (error instanceof UnsupportedSessionMigrationError) {
      return reply.code(422).send({ error: error.message, code: error.code });
    }
    if (error instanceof RemoteAgentHttpError && error.status === 422) {
      const remoteBody = error.body && typeof error.body === 'object'
        ? error.body as { error?: unknown; code?: unknown }
        : {};
      if (remoteBody.code === 'CLAUDE_SESSION_MIGRATION_UNSUPPORTED') {
        return reply.code(422).send({
          error: typeof remoteBody.error === 'string' ? remoteBody.error : error.message,
          code: remoteBody.code,
        });
      }
    }
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Migrate failed' });
  }
});

app.delete('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = machineRouteQuerySchema.parse(request.query);
  confirmSchema.parse(request.body);
  try {
    const includeRemote = query.remote !== '0' && query.remote !== 'false';
    const result = await deleteSessionById(params.id, query.machineId, query.agent, includeRemote);
    clearSessionCaches();
    return result;
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Delete failed');
  }
});

app.post('/api/sessions/prune', async (request, reply) => {
  const query = machineRouteQuerySchema.parse(request.query);
  confirmSchema.parse(request.body);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  try {
    const result = await pruneAggregatedSessions(
      includeRemote,
      (session) => session.evaluation.recommendation === 'delete'
    );
    clearSessionCaches();
    return result;
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Prune failed');
  }
});

app.post('/api/sessions/prune-non-kept', async (request, reply) => {
  const query = machineRouteQuerySchema.parse(request.query);
  confirmSchema.parse(request.body);
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  try {
    const result = await pruneAggregatedSessions(includeRemote, () => true);
    clearSessionCaches();
    return result;
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Prune failed');
  }
});

app.post('/api/sessions/bulk-delete', async (request, reply) => {
  const body = bulkDeleteSchema.parse(request.body);
  const query = request.query as { remote?: string };
  try {
    const results = body.sessions
      ? await deleteRoutedSessionsBulk(body.sessions)
      : await deleteSessionsByIdsBulk(body.ids ?? [], query.remote !== '0');
    clearSessionCaches();
    return {
      deleted: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Bulk delete failed');
  }
});

app.get('/api/worker/evaluation-input/:id', async (request, reply) => {
  if (curatorRole !== 'worker') return reply.code(404).send({ error: 'Not found' });
  const params = sessionIdSchema.parse(request.params);
  const query = z.object({
    agent: z.enum(['codex', 'claude']).optional(),
  }).parse(request.query);
  try {
    return await service.getRemoteEvaluationInput(params.id, query.agent);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Session not found' });
  }
});

app.post('/api/worker/evaluations/:id', async (request, reply) => {
  if (curatorRole !== 'worker') return reply.code(404).send({ error: 'Not found' });
  const params = sessionIdSchema.parse(request.params);
  const body = hubEvaluationImportSchema.parse(request.body);
  try {
    return await service.applyHubEvaluation({ sessionId: params.id, ...body });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to apply Hub evaluation';
    return reply.code(/changed while Hub evaluation/i.test(message) ? 409 : 400).send({ error: message });
  }
});

app.post('/api/evaluations/retry-failed', async () => {
  const result = await service.queueFailedSummaryRetry();
  expireSessionCaches();
  return result;
});

app.post('/api/evaluations/backfill', async (request) => {
  const body = backfillSchema.parse(request.body ?? {});
  const result = await service.backfillEvaluations({ limit: body.limit, includeFailed: body.includeFailed });
  expireSessionCaches();
  return result;
});

app.post('/api/evaluations/:id/refresh', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = evaluationRefreshSchema.parse(request.body ?? {});
  try {
    const routed = await findRoutableSession(params.id, body.machineId, body.agent);
    if (!routed) return reply.code(404).send({ error: 'Session not found' });
    const job = await enqueueEvaluationRefresh(
      params.id,
      'manual-api',
      routed.session.machineId,
      routed.session.agent,
    );
    return reply.code(202).send({ job: publicEvaluationRefreshJob(job) });
  } catch (error) {
    return sendSessionRoutingError(reply, error, 'Refresh failed');
  }
});

app.get('/api/evaluations/refresh-jobs/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const job = evaluationRefreshJobs.get(params.id);
  if (!job) return reply.code(404).send({ error: 'Refresh job not found' });
  return { job: publicEvaluationRefreshJob(job) };
});

const distPath = join(__dirname, '..', 'dist');
if (curatorRole === 'hub' && existsSync(distPath)) {
  const { default: fastifyStatic } = await import('@fastify/static');
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    setHeaders(response, pathName) {
      if (pathName.includes('/assets/')) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        response.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.sendFile('index.html');
  });
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 54177);

await app.listen({ host, port });
app.log.info({ role: curatorRole, capabilities: curatorCapabilities }, `Codex Session Curator listening on http://${host}:${port}`);
setTimeout(() => {
  const warmups: Promise<unknown>[] = [getLocalSessionsCached(false, true)];
  if (curatorRole === 'hub') warmups.push(getRemoteSessionsCached());
  void Promise.all(warmups)
    .then(() => app.log.info({ role: curatorRole }, 'Session list caches warmed'))
    .catch((error) => app.log.warn({ error, role: curatorRole }, 'Session list cache warmup failed'));
}, 100).unref();
