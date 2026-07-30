import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Archive,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  KeyRound,
  Loader2,
  LogOut,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import {
  filesPageUrl,
  readFilesPageRoute,
  readTerminalPageRoute,
  sessionFileDownloadUrl,
  sessionFilesDetailUrl,
  sessionFilesListUrl,
  sessionFileUploadUrl,
} from './session-files-routing';

type Recommendation = 'keep' | 'review' | 'delete';
type ActivityStatus = 'active' | 'inactive';
type TabId = 'all' | 'kept' | 'recycle' | Recommendation;
type UpdateCadence = 'new' | 'quiet' | 'low' | 'medium' | 'high';
type ReviewPriority = 'low' | 'normal' | 'review' | 'reunderstand';
type SessionListViewMode = 'folder' | 'activityDate';
type AiRefreshStatus = 'never' | 'pending' | 'running' | 'ok' | 'failed';
type MessageRole = 'user' | 'assistant';
type AgentKind = 'codex' | 'claude';
type AgentFilter = 'all' | AgentKind;
type CodexWorkerJobStatus = 'running' | 'completed' | 'failed' | 'stopped' | string;
type CodexWorkerMode = 'exec' | 'pty' | string;
type WorkerProtocolKind = 'guide' | 'pause' | 'continue' | 'summarize' | 'handoff' | 'verify';

interface RemoteMachine {
  label: string | null;
  host: string | null;
  ip: string | null;
  user: string | null;
  evidence: string;
}

interface Evaluation {
  title: string;
  summary: string;
  detailedSummary: string;
  hermesLastUsedAt?: string | null;
  hermesLastJobId?: string | null;
  hermesNeedsRefresh?: boolean;
  hermesRecalculatedAt?: string | null;
  hermesRefreshStatus?: AiRefreshStatus;
  hermesRefreshError?: string | null;
  recommendation: Recommendation;
  score: number;
  reasons: string[];
  actualWorkdirs: string[];
  directoryIndex: string[];
  techStack: string[];
  keywords: string[];
  searchText: string;
  updateCadence: UpdateCadence;
  reviewPriority: ReviewPriority;
  reviewSignals: string[];
  cwdMatchesWorkdir: boolean | null;
  recommendedWorkdir: string | null;
  remoteMachines: RemoteMachine[];
  evaluatedAt: string;
  workflow: string;
  model: string;
  status: 'ok' | 'fallback' | 'failed';
  error: string | null;
  evaluationOrigin?: 'local-llm' | 'worker-fast' | 'hub-remote' | 'rule-fallback' | null;
  evaluatedByMachineId?: string | null;
  evaluationRunId?: string | null;
  transcriptHash?: string | null;
}

interface SessionMessagePreview {
  role: MessageRole;
  text: string;
  timestamp: string | null;
}

interface CodexSession {
  id: string;
  agent: AgentKind;
  filePath: string;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  bytes: number;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  lastUserMessage: SessionMessagePreview | null;
  lastAssistantMessage: SessionMessagePreview | null;
  shellSnapshotCount: number;
  title: string;
  customTitle: string | null;
  resumeCommand: string;
  machineId: string;
  activityStatus: ActivityStatus;
  lastActiveAt: string | null;
  inactiveDays: number | null;
  kept: boolean;
  deleted: boolean;
  evaluation: Evaluation;
}

interface ApiPayload {
  meta: {
    codexHome: string;
    claudeProjectsRoot?: string;
    sessionsRoot: string;
    recycleRoot: string;
    recycleRetentionDays: number;
    deleteMode: string;
    remoteAgents?: Array<{ id: string; baseUrl: string }>;
  };
  sessions: CodexSession[];
  total: number;
  filteredTotal?: number;
  page?: number;
  pageSize?: number;
}

interface AiSessionSearchMatch {
  identity: {
    key: string;
    sessionId: string;
    machineId: string;
    agent: AgentKind;
  };
  confidence: number;
  reason: string;
  localScore: number;
  session: CodexSession;
}

interface AiSessionSearchPayload {
  query: string;
  intent: string;
  mode: 'deepseek' | 'fallback-local';
  model: string | null;
  fallbackReason: string | null;
  routing: {
    mode: 'deepseek' | 'user-filter' | 'local-hint' | 'broad';
    scope: 'focused' | 'broad';
    machineIds: string[];
    confidence: number;
    reason: string;
    searchTerms: string[];
    latencyMs: number;
    fallbackReason: string | null;
  };
  phaseLatencyMs: {
    routing: number;
    ranking: number;
  };
  latencyMs: number;
  candidateCount: number;
  candidateMachineCounts: Record<string, number>;
  count: number;
  matches: AiSessionSearchMatch[];
}

interface RecycleArchive {
  sessionId: string;
  agent: AgentKind | null;
  machineId: string;
  archiveDir: string;
  originalSessionFile: string | null;
  deletedAt: string | null;
  expiresAt: string | null;
  retentionDays: number | null;
  archivedFiles: string[];
  removedOriginalFiles: string[];
  removedHistoryEntries: number;
}

interface RecyclePayload {
  meta: ApiPayload['meta'];
  archives: RecycleArchive[];
  errors?: Array<{ machineId: string; error: string }>;
}

interface FleetAuditSummary {
  machines: number;
  discoveredSessions: number;
  eligibleSessions: number;
  fullyEvaluatedSessions: number;
  pendingEvaluationSessions: number;
  metadataOnlySessions: number;
  settledEligibleSessions: number;
  analysisCoveragePercent: number;
  settledCoveragePercent: number;
  localIssues: number;
  remoteIssues: number;
  missingFromPanel: number;
  unhealthyRemotes: number;
}

interface FleetAuditPayload {
  generatedAt: string;
  hubMachineId: string;
  summary: FleetAuditSummary;
}

interface SessionAuditEvent {
  id: string;
  at: string;
  event: string;
  sessionId: string | null;
  machineId: string;
  runId: string | null;
  evaluationOrigin: string | null;
  transcriptHash: string | null;
  model: string | null;
  status: string | null;
  error: string | null;
  details: Record<string, string | number | boolean | null>;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeEvaluation(session: Partial<CodexSession>): Evaluation {
  const flat = session as Partial<CodexSession> & Partial<Evaluation>;
  const evaluation = (session.evaluation ?? {}) as Partial<Evaluation>;
  const fallbackTitle = session.title || session.id || '未知会话';
  const fallbackSummary = '远端会话尚未生成摘要';
  const rawRecommendation = evaluation.recommendation ?? flat.recommendation;
  const recommendation: Recommendation =
    rawRecommendation === 'keep' || rawRecommendation === 'review' || rawRecommendation === 'delete'
      ? rawRecommendation
      : 'review';
  const remoteMachines = asArray(evaluation.remoteMachines ?? flat.remoteMachines).map((machine) => ({
    label: machine.label ?? null,
    host: machine.host ?? null,
    ip: machine.ip ?? null,
    user: machine.user ?? null,
    evidence: machine.evidence ?? '',
  }));
  return {
    title: evaluation.title ?? flat.title ?? fallbackTitle,
    summary: evaluation.summary ?? flat.summary ?? fallbackSummary,
    detailedSummary: evaluation.detailedSummary ?? flat.detailedSummary ?? evaluation.summary ?? flat.summary ?? fallbackSummary,
    hermesLastUsedAt: evaluation.hermesLastUsedAt ?? null,
    hermesLastJobId: evaluation.hermesLastJobId ?? null,
    hermesNeedsRefresh: evaluation.hermesNeedsRefresh ?? false,
    hermesRecalculatedAt: evaluation.hermesRecalculatedAt ?? null,
    hermesRefreshStatus: evaluation.hermesRefreshStatus ?? (evaluation.hermesNeedsRefresh ? 'pending' : 'never'),
    hermesRefreshError: evaluation.hermesRefreshError ?? null,
    recommendation,
    score: typeof evaluation.score === 'number' ? evaluation.score : typeof flat.score === 'number' ? flat.score : 0,
    reasons: asArray(evaluation.reasons ?? flat.reasons),
    actualWorkdirs: asArray(evaluation.actualWorkdirs ?? flat.actualWorkdirs),
    directoryIndex: asArray(evaluation.directoryIndex ?? flat.directoryIndex),
    techStack: asArray(evaluation.techStack ?? flat.techStack),
    keywords: asArray(evaluation.keywords ?? flat.keywords),
    searchText: evaluation.searchText ?? flat.searchText ?? '',
    updateCadence: evaluation.updateCadence ?? flat.updateCadence ?? 'quiet',
    reviewPriority: evaluation.reviewPriority ?? flat.reviewPriority ?? 'normal',
    reviewSignals: asArray(evaluation.reviewSignals ?? flat.reviewSignals),
    cwdMatchesWorkdir: evaluation.cwdMatchesWorkdir ?? flat.cwdMatchesWorkdir ?? null,
    recommendedWorkdir: evaluation.recommendedWorkdir ?? flat.recommendedWorkdir ?? null,
    remoteMachines,
    evaluatedAt: evaluation.evaluatedAt ?? flat.evaluatedAt ?? session.updatedAt ?? session.startedAt ?? new Date(0).toISOString(),
    workflow: evaluation.workflow ?? flat.workflow ?? 'frontend-compat',
    model: evaluation.model ?? flat.model ?? 'none',
    status: evaluation.status ?? flat.status ?? 'fallback',
    error: evaluation.error ?? flat.error ?? null,
    evaluationOrigin: evaluation.evaluationOrigin ?? null,
    evaluatedByMachineId: evaluation.evaluatedByMachineId ?? null,
    evaluationRunId: evaluation.evaluationRunId ?? null,
    transcriptHash: evaluation.transcriptHash ?? null,
  };
}

function normalizeSession(raw: unknown): CodexSession {
  const session = (raw ?? {}) as Partial<CodexSession>;
  if (session.agent !== 'codex' && session.agent !== 'claude') {
    throw new Error('会话缺少可验证的 Agent 身份');
  }
  const id = String(session.id ?? session.filePath ?? 'unknown-session');
  const title = session.title || session.customTitle || id;
  return {
    ...session,
    id,
    agent: session.agent,
    filePath: session.filePath ?? '',
    cwd: session.cwd ?? null,
    startedAt: session.startedAt ?? null,
    updatedAt: session.updatedAt ?? session.startedAt ?? null,
    bytes: typeof session.bytes === 'number' ? session.bytes : 0,
    messageCount: typeof session.messageCount === 'number' ? session.messageCount : 0,
    userTurns: typeof session.userTurns === 'number' ? session.userTurns : 0,
    assistantTurns: typeof session.assistantTurns === 'number' ? session.assistantTurns : 0,
    lastUserMessage: session.lastUserMessage ?? null,
    lastAssistantMessage: session.lastAssistantMessage ?? null,
    shellSnapshotCount: typeof session.shellSnapshotCount === 'number' ? session.shellSnapshotCount : 0,
    title,
    customTitle: session.customTitle ?? null,
    resumeCommand: session.resumeCommand ?? '',
    machineId: session.machineId ?? 'unknown',
    activityStatus: session.activityStatus === 'inactive' ? 'inactive' : 'active',
    lastActiveAt: session.lastActiveAt ?? session.updatedAt ?? session.startedAt ?? null,
    inactiveDays: typeof session.inactiveDays === 'number' ? session.inactiveDays : null,
    kept: Boolean(session.kept),
    deleted: Boolean(session.deleted),
    evaluation: normalizeEvaluation({ ...session, id, title }),
  };
}

function normalizeSessions(sessions: unknown): CodexSession[] {
  return Array.isArray(sessions) ? sessions.map(normalizeSession) : [];
}

interface HistoryMessage {
  index: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  injectedContext?: InjectedContextBlock | null;
  precedingContext?: InjectedContextBlock[];
}

interface InjectedContextBlock {
  kind: 'agents_instructions' | 'environment_context' | 'skill';
  label: string;
  text: string;
  characterCount: number;
}

interface HistoryPayload {
  messages: HistoryMessage[];
  nextBefore: number | null;
  hasMore: boolean;
  totalMessages?: number;
}

interface RecentUserMessagesPayload {
  messages: HistoryMessage[];
  totalUserMessages: number;
  hiddenContextMessages: number;
  fileSize: number;
  fileMtimeMs: number;
  cached: boolean;
}

interface RecentUserMessagesState {
  sessionKey: string | null;
  messages: HistoryMessage[];
  loading: boolean;
  error: boolean;
}

const recentUserMessageCache = new Map<string, RecentUserMessagesPayload>();
const recentUserMessageRequests = new Map<string, Promise<RecentUserMessagesPayload>>();

interface CodexWorkerGuidance {
  at?: string | null;
  text?: string | null;
  source?: string | null;
}

interface CodexWorkerSupervisor {
  enabled?: boolean;
  lastCheckedAt?: string | null;
  lastDecision?: string | null;
  lastReason?: string | null;
  checks?: number;
  retries?: number;
  autoStop?: boolean;
  autoRetry?: boolean;
  idleTimeoutMs?: number | null;
  maxRetries?: number | null;
  lastOutputAt?: string | null;
  lastOutputBytes?: number | null;
}

interface CodexWorkerPolicy {
  maxRuntimeMs?: number | null;
  maxOutputBytes?: number | null;
  allowDeploy?: boolean;
  allowDeletes?: boolean;
  allowedCwds?: string[];
  blockedCommands?: string[];
  autoStop?: boolean;
}

interface CodexWorkerPolicyViolation {
  at?: string | null;
  reason?: string | null;
  severity?: 'warn' | 'stop' | string | null;
  pattern?: string | null;
}

interface CodexWorkerPolicyState {
  lastCheckedAt?: string | null;
  violations?: CodexWorkerPolicyViolation[];
  stoppedAt?: string | null;
}

interface CodexWorkerStructuredReport {
  status?: string | null;
  changedFiles?: string[];
  tests?: string[];
  nextAction?: string | null;
  rawFooter?: string | null;
  parsedAt?: string | null;
}

interface CodexWorkerJob {
  id: string;
  sessionId?: string | null;
  agent?: AgentKind | null;
  agentVerified?: boolean;
  status?: CodexWorkerJobStatus | null;
  mode?: CodexWorkerMode | null;
  machineId?: string | null;
  machine?: string | null;
  cwd?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  outputTail?: string | null;
  changedFiles?: string[];
  guidance?: CodexWorkerGuidance[];
  supervisor?: CodexWorkerSupervisor | null;
  policy?: CodexWorkerPolicy | null;
  policyState?: CodexWorkerPolicyState | null;
  structuredReport?: CodexWorkerStructuredReport | null;
  error?: string | null;
  command?: string | null;
  prompt?: string | null;
  outputBytes?: number | null;
  exitCode?: number | null;
  signal?: string | null;
}

interface CommanderAction {
  id: string;
  kind: 'direct-action' | 'self-repair' | 'manual-note' | string;
  status: string;
  goal: string;
  reason: string;
  scope: string | null;
  targetRepo: string | null;
  cwd: string | null;
  changedFiles: string[];
  tests: string[];
  verification: string[];
  followUp: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

type KnowledgeItemType =
  | 'project'
  | 'preference'
  | 'service'
  | 'runbook'
  | 'decision'
  | 'session'
  | 'job'
  | 'commander_action'
  | 'note';

interface KnowledgeItemResult {
  id: string;
  type: KnowledgeItemType | string;
  scope: string | null;
  title: string;
  text: string;
  project: string | null;
  repo: string | null;
  cwd: string | null;
  machineId: string | null;
  tags: string[];
  source: string | null;
  confidence: number | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  score: number;
}

interface ContextPackSession {
  id: string;
  agent: AgentKind;
  title: string;
  machineId: string;
  cwd: string | null;
  recommendedWorkdir: string | null;
  resumeCommand: string;
  canResume: boolean;
  updatedAt: string | null;
  score: number;
  summary: string;
  directoryIndex: string[];
  actualWorkdirs: string[];
  keywords: string[];
  techStack: string[];
}

interface ContextPackKnowledgeItem {
  id: string;
  type: string;
  title: string;
  text: string;
  project: string | null;
  cwd: string | null;
  repo: string | null;
  updatedAt: string | null;
  tags: string[];
}

interface ContextPack {
  query: string;
  matchedProject: { name: string; cwd: string | null; repo: string | null; reason: string } | null;
  preferences: ContextPackKnowledgeItem[];
  projectFacts: ContextPackKnowledgeItem[];
  runbooks: ContextPackKnowledgeItem[];
  sessions: ContextPackSession[];
  commanderActions: CommanderAction[];
  recommendedResume: {
    confidence: number;
    sessionId: string;
    machineId: string;
    agent: AgentKind;
    resumeCommand: string;
    reason: string;
  } | null;
  newSessionReason: string | null;
  workerPromptContext: string;
}
interface CodexJobRegistryEntry {
  machineId?: string | null;
  baseUrl?: string | null;
  job?: CodexWorkerJob;
}

interface CodexJobRegistryHealth {
  machineId: string;
  baseUrl: string | null;
  healthy: boolean;
  updatedAt: string | null;
  cached: boolean;
  error: string | null;
}

interface CodexJobRegistryError {
  machineId: string;
  baseUrl: string | null;
  error: string;
}

interface CodexJobRegistryPayload {
  machineId?: string | null;
  baseUrl?: string | null;
  jobs?: CodexJobRegistryEntry[];
  count?: number;
  health?: CodexJobRegistryHealth[];
  errors?: CodexJobRegistryError[];
  error?: string;
}

interface CodexWorkerEvent {
  seq?: number;
  at?: string | null;
  type?: string | null;
  kind?: string | null;
  message?: string | null;
  data?: unknown;
  [key: string]: unknown;
}

interface TerminalEvent {
  type: 'ready' | 'output' | 'exit' | 'error';
  data?: string;
  code?: number | null;
  signal?: string | number | null;
}

interface RemoteAgentStatus {
  id: string;
  baseUrl: string;
  online: boolean;
  latencyMs: number | null;
  error: string | null;
  machineId: string | null;
}

type TerminalStatus = 'disconnected' | 'connecting' | 'connected' | 'codex-running';

interface TerminalSessionTarget {
  id: string;
  agent: AgentKind;
  machineId: string;
  cwd: string | null;
  title?: string;
  resumeCommand?: string;
}

interface TerminalCopyOptions {
  clearSelection?: boolean;
  preferLegacy?: boolean;
  silentEmpty?: boolean;
  notice?: string;
  text?: string;
}

interface TerminalCellPoint {
  col: number;
  row: number;
}

interface SessionFileEntry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  size: number | null;
  mtime: string | null;
}

interface SessionFilesPayload {
  sessionId: string;
  machineId: string;
  agent?: AgentKind;
  cwd: string;
  root: string;
  path: string;
  parent: string | null;
  entries: SessionFileEntry[];
}

interface LoginPanelProps {
  busy: boolean;
  message: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
}

const terminalStatusLabel: Record<TerminalStatus, string> = {
  disconnected: '断开',
  connecting: '连接中',
  connected: '已连接',
  'codex-running': 'Agent 运行中',
};

function agentLabel(agent: AgentKind | null | undefined): string {
  return agent === 'claude' ? 'Claude' : 'Codex';
}

const MACHINE_FILTER_STORAGE_KEY = 'codex-session-curator:last-machine-filter';
const AGENT_FILTER_STORAGE_KEY = 'codex-session-curator:last-agent-filter';

function readStoredMachineFilter(): string {
  try {
    return window.localStorage.getItem(MACHINE_FILTER_STORAGE_KEY) || 'all';
  } catch {
    return 'all';
  }
}

function readStoredAgentFilter(): AgentFilter {
  try {
    const stored = window.localStorage.getItem(AGENT_FILTER_STORAGE_KEY);
    return stored === 'codex' || stored === 'claude' ? stored : 'all';
  } catch {
    return 'all';
  }
}

function terminalCellFromMouseEvent(terminal: XTerm, container: HTMLDivElement, event: MouseEvent): TerminalCellPoint | null {
  const screen = container.querySelector<HTMLElement>('.xterm-screen') ?? container;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor(((event.clientX - rect.left) / rect.width) * terminal.cols)));
  const row = Math.max(0, Math.min(terminal.rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * terminal.rows)));
  return { col, row };
}

function extractTerminalBufferRange(terminal: XTerm, start: TerminalCellPoint, end: TerminalCellPoint): string {
  const first = start.row < end.row || (start.row === end.row && start.col <= end.col) ? start : end;
  const last = first === start ? end : start;
  const buffer = terminal.buffer.active;
  const topRow = buffer.viewportY;
  const lines: string[] = [];

  for (let row = first.row; row <= last.row; row += 1) {
    const line = buffer.getLine(topRow + row);
    if (!line) {
      lines.push('');
      continue;
    }
    const startCol = row === first.row ? first.col : 0;
    const endCol = row === last.row ? last.col + 1 : terminal.cols;
    lines.push(line.translateToString(true, startCol, endCol));
  }

  return lines.join('\n').replace(/\n+$/, '');
}

function copyViaHiddenTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function writeClipboardText(text: string, preferLegacy = false): Promise<void> {
  if (preferLegacy && copyViaHiddenTextarea(text)) return;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand below; HTTP tunnels often reject Clipboard API writes.
    }
  }
  if (copyViaHiddenTextarea(text)) return;
  throw new Error('copy command failed');
}

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'all', label: '会话' },
  { id: 'kept', label: '已保留' },
  { id: 'recycle', label: '回收站' },
];

const SHOW_ADVANCED_UI = import.meta.env.VITE_CURATOR_ADVANCED_UI === '1';

const workerStatusLabel: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const workerStatusTone: Record<string, string> = {
  running: 'tone-review',
  completed: 'tone-keep',
  failed: 'tone-delete',
  stopped: 'tone-delete',
};

const workerProtocolKinds: Array<{ id: WorkerProtocolKind; label: string }> = [
  { id: 'guide', label: '指导' },
  { id: 'pause', label: '暂停' },
  { id: 'continue', label: '继续' },
  { id: 'summarize', label: '总结' },
  { id: 'handoff', label: '交接' },
  { id: 'verify', label: '验证' },
];

const supervisorDecisionLabel: Record<string, string> = {
  continue: '继续',
  needs_guidance: '需要指导',
  stop: '停止',
  retry: '重试',
  completed: '已完成',
  failed: '失败',
};

const supervisorDecisionTone: Record<string, string> = {
  continue: 'tone-review',
  needs_guidance: 'tone-review',
  stop: 'tone-delete',
  retry: 'tone-review',
  completed: 'tone-keep',
  failed: 'tone-delete',
};

const commanderActionKindLabel: Record<string, string> = {
  'direct-action': 'direct action',
  'self-repair': 'self repair',
  'manual-note': 'manual note',
};

const commanderActionStatusTone: Record<string, string> = {
  completed: 'tone-keep',
  ok: 'tone-keep',
  failed: 'tone-delete',
  error: 'tone-delete',
  running: 'tone-review',
  pending: 'tone-review',
};

const cadenceLabel: Record<UpdateCadence, string> = {
  new: '新会话',
  quiet: '无新增',
  low: '低频更新',
  medium: '中频更新',
  high: '高频更新',
};

const priorityLabel: Record<ReviewPriority, string> = {
  low: '低复核',
  normal: '常规复核',
  review: '需要复核新增',
  reunderstand: '需要重新理解',
};

function formatDate(value: string | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function RecentUserMessageCard({ sessionId, message }: { sessionId: string; message: HistoryMessage }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(message.text.length > 240);

  useEffect(() => {
    if (expanded || !textRef.current) return;
    const element = textRef.current;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setCanExpand(message.text.length > 240 || element.scrollHeight > element.clientHeight + 1);
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [expanded, message.text]);

  return (
    <article
      className={expanded ? 'expanded' : undefined}
      data-recent-user-message
      data-role="user"
      data-session-id={sessionId}
    >
      <span>用户发送</span>
      <p className="recent-message-text" ref={textRef}>{message.text}</p>
      {message.precedingContext?.length ? (
        <details className="recent-context-details">
          <summary>
            <FileText size={14} />
            系统上下文 ({message.precedingContext.length})
          </summary>
          <div className="recent-context-content">
            {message.precedingContext.map((context, index) => (
              <section key={`${context.kind}:${index}`}>
                <strong>{context.label}</strong>
                <pre>{context.text}</pre>
              </section>
            ))}
          </div>
        </details>
      ) : null}
      <div className="recent-message-footer">
        {message.timestamp ? <em>{formatDate(message.timestamp)}</em> : <span />}
        {canExpand ? (
          <button
            type="button"
            className="recent-message-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown size={15} />
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function previewText(message: SessionMessagePreview | null, fallback = '暂无记录'): string {
  const text = message?.text.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileSizeLabel(bytes: number | null): string {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? formatBytes(bytes) : '-';
}

function formatOptionalBytes(bytes: number | null | undefined): string {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? formatBytes(bytes) : '未限制';
}

function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未限制';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function booleanPolicyLabel(value: boolean | null | undefined, enabledText = '允许', disabledText = '禁止'): string {
  if (value === true) return enabledText;
  if (value === false) return disabledText;
  return '未配置';
}

function normalizePath(value: string | null | undefined): string {
  return (value ?? '').replace(/\/+$/, '');
}

function formatUnknownValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '无';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function workerJobTime(job: CodexWorkerJob): number {
  return Date.parse(job.updatedAt ?? job.startedAt ?? '') || 0;
}

function commanderActionTime(action: CommanderAction): number {
  return Date.parse(action.completedAt ?? action.startedAt ?? '') || 0;
}

function isWorkerJobRunning(job: CodexWorkerJob): boolean {
  return job.status === 'running';
}

function normalizeWorkerJob(job: CodexWorkerJob): CodexWorkerJob {
  const agent = job.agent === 'codex' || job.agent === 'claude' ? job.agent : null;
  return {
    ...job,
    agent,
    agentVerified: agent !== null && job.agentVerified === true,
  };
}

interface VerifiedWorkerJobIdentity {
  machineId: string;
  agent: AgentKind;
  sessionId: string;
}

function workerJobMachineId(job: CodexWorkerJob): string | null {
  const machineId = (job.machineId ?? job.machine)?.trim();
  return machineId || null;
}

function verifiedWorkerJobIdentity(job: CodexWorkerJob): VerifiedWorkerJobIdentity | null {
  const jobId = typeof job.id === 'string' ? job.id.trim() : '';
  const machineId = job.machineId?.trim() || null;
  const sessionId = job.sessionId?.trim() || null;
  const agent = job.agent === 'codex' || job.agent === 'claude' ? job.agent : null;
  if (!jobId || !machineId || !sessionId || !agent || job.agentVerified !== true) return null;
  return { machineId, agent, sessionId };
}

function requireVerifiedWorkerJobIdentity(job: CodexWorkerJob): VerifiedWorkerJobIdentity {
  const identity = verifiedWorkerJobIdentity(job);
  if (!identity) {
    throw new Error(`Worker job 身份未验证或不完整：${job.id}`);
  }
  return identity;
}

function workerJobKey(job: CodexWorkerJob): string {
  const machineId = workerJobMachineId(job) ?? 'unknown';
  const agent = job.agent === 'codex' || job.agent === 'claude' ? job.agent : 'unknown';
  const sessionId = job.sessionId?.trim() || 'unknown';
  const jobId = typeof job.id === 'string' && job.id.trim() ? job.id : 'unknown';
  return `${machineId}|||${agent}|||${sessionId}|||${jobId}`;
}

function workerJobActionKey(job: CodexWorkerJob, action: string): string {
  return `${workerJobKey(job)}|||${action}`;
}

function workerJobRequestUrl(
  job: CodexWorkerJob,
  suffix = '',
  extraQuery: Record<string, string> = {},
): string {
  const identity = requireVerifiedWorkerJobIdentity(job);
  const query = new URLSearchParams({
    ...extraQuery,
    machineId: identity.machineId,
    agent: identity.agent,
    sessionId: identity.sessionId,
  });
  return `/api/codex/jobs/${encodeURIComponent(job.id)}${suffix}?${query.toString()}`;
}

function verifyWorkerJobResponse(
  expected: CodexWorkerJob,
  received: CodexWorkerJob,
  options: { allowDifferentJobId?: boolean } = {},
): CodexWorkerJob {
  const expectedIdentity = requireVerifiedWorkerJobIdentity(expected);
  const normalized = normalizeWorkerJob(received);
  const receivedIdentity = requireVerifiedWorkerJobIdentity(normalized);
  if (
    (!options.allowDifferentJobId && normalized.id !== expected.id) ||
    receivedIdentity.machineId !== expectedIdentity.machineId ||
    receivedIdentity.agent !== expectedIdentity.agent ||
    receivedIdentity.sessionId !== expectedIdentity.sessionId
  ) {
    throw new Error(`Worker job 响应身份不匹配：${expected.id}`);
  }
  return normalized;
}

function sortWorkerJobs(jobs: CodexWorkerJob[]): CodexWorkerJob[] {
  return [...jobs].sort((a, b) => {
    const runningDelta = Number(isWorkerJobRunning(b)) - Number(isWorkerJobRunning(a));
    return runningDelta || workerJobTime(b) - workerJobTime(a);
  });
}

function statusLabel(status: string | null | undefined): string {
  return status ? (workerStatusLabel[status] ?? status) : '未知';
}

function machineKey(machineId: string | null | undefined, baseUrl: string | null | undefined): string {
  return `${machineId || 'unknown'}|||${baseUrl || 'local'}`;
}

function sessionKey(session: Pick<CodexSession, 'id' | 'agent' | 'machineId'>): string {
  return `${session.machineId || 'unknown'}|||${session.agent}|||${session.id}`;
}

function LoginPanel({ busy, message, onLogin }: LoginPanelProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(username, password);
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-brand">
          <div className="brand-mark">
            <KeyRound size={22} />
          </div>
          <div>
            <h1>Agent Session Curator</h1>
            <p>整理、检索和归档 Codex / Claude 会话</p>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>用户名</span>
            <input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            <span>密码</span>
            <input
              value={password}
              type="password"
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {message ? <div className="login-message">{message}</div> : null}
          <button type="submit" className="primary-button login-submit" disabled={busy || !username || !password}>
            {busy ? <Loader2 size={17} className="spin" /> : <ShieldCheck size={17} />}
            登录
          </button>
        </form>
        <p className="login-note">也可以通过管理员 token 链接进入，服务端会换取 HttpOnly 登录 cookie。</p>
      </section>
    </main>
  );
}

function sessionGroupKey(session: CodexSession): string {
  return `folder|||${session.machineId}|||${normalizePath(session.cwd) || 'unknown cwd'}`;
}

function activityDateGroup(session: CodexSession): { key: string; label: string; title: string; sortTime: number } {
  const raw = session.lastActiveAt ?? session.updatedAt ?? session.startedAt;
  if (!raw) return { key: 'activity|||unknown', label: '活跃日期', title: '未知活跃时间', sortTime: 0 };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { key: `activity|||${raw}`, label: '活跃日期', title: raw, sortTime: 0 };
  const dateKey = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((todayStart - dayStart) / 86_400_000);
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date);
  const prefix = dayDiff === 0 ? '今天' : dayDiff === 1 ? '昨天' : dayDiff > 1 && dayDiff <= 6 ? `${dayDiff}天前` : dateKey;
  return {
    key: `activity|||${dateKey}`,
    label: '活跃日期',
    title: `${prefix} · ${weekday}`,
    sortTime: dayStart,
  };
}

function matchesSearch(session: CodexSession, query: string): boolean {
  if (!query.trim()) return true;
  const text = [
    session.id,
    session.title,
    session.resumeCommand,
    session.cwd ?? '',
    session.machineId,
    session.agent,
    session.lastUserMessage?.text ?? '',
    session.lastAssistantMessage?.text ?? '',
    session.evaluation.summary,
    session.evaluation.detailedSummary,
    session.evaluation.searchText ?? '',
    ...session.evaluation.actualWorkdirs,
    ...(session.evaluation.directoryIndex ?? []),
    ...(session.evaluation.techStack ?? []),
    ...(session.evaluation.keywords ?? []),
    session.evaluation.recommendedWorkdir ?? '',
    ...session.evaluation.remoteMachines.map((machine) =>
      [machine.label, machine.host, machine.ip, machine.user].filter(Boolean).join(' ')
    ),
  ]
    .join(' ')
    .toLowerCase();
  return text.includes(query.toLowerCase());
}

function filterByTab(session: CodexSession, tab: TabId): boolean {
  if (tab === 'all') return true;
  if (tab === 'kept') return session.kept;
  if (tab === 'recycle') return false;
  return session.evaluation.recommendation === tab;
}

function metricLabel(value: number, label: string) {
  return (
    <span className="metric">
      <strong>{value}</strong>
      {label}
    </span>
  );
}

function TerminalConsole({ session, active, onClose }: { session: TerminalSessionTarget; active: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const terminalCleanupRef = useRef<(() => void) | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const pendingOutputRef = useRef('');
  const outputFlushTimerRef = useRef<number | null>(null);
  const initialOutputRefreshesRef = useRef(0);
  const lastFitGeometryRef = useRef('');
  const lastSelectionCopyRef = useRef('');
  const dragCopyStartRef = useRef<TerminalCellPoint | null>(null);
  const latestSelectionRef = useRef('');
  const selectionStartedRef = useRef(false);
  const activeRef = useRef(active);
  const manualCloseRef = useRef(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('disconnected');
  const [fullscreen, setFullscreen] = useState(false);
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [contextMenu]);

  const closeSocketAndPty = useCallback(() => {
    terminalCleanupRef.current?.();
    terminalCleanupRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    if (outputFlushTimerRef.current !== null) {
      window.clearTimeout(outputFlushTimerRef.current);
      outputFlushTimerRef.current = null;
    }
    pendingOutputRef.current = '';
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    lastFitGeometryRef.current = '';
    latestSelectionRef.current = '';
    lastSelectionCopyRef.current = '';
    dragCopyStartRef.current = null;
    selectionStartedRef.current = false;
    setTerminalStatus('disconnected');
  }, []);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    closeSocketAndPty();
  }, [closeSocketAndPty]);

  useEffect(() => disconnect, [disconnect]);

  const pasteIntoTerminal = useCallback(async () => {
    const socket = socketRef.current;
    const terminal = terminalRef.current;
    if (!socket || !terminal || socket.readyState !== WebSocket.OPEN) {
      setTerminalNotice('终端未连接');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setTerminalNotice('剪贴板为空');
        return;
      }
      socket.send(JSON.stringify({ type: 'input', data: text }));
      terminal.focus();
      setTerminalNotice('已粘贴到终端');
    } catch {
      setTerminalNotice('浏览器阻止读取剪贴板，请使用 Ctrl+V 或切换到 HTTPS 隧道');
    }
  }, []);

  const copyTerminalSelection = useCallback(async (options: TerminalCopyOptions = {}) => {
    const terminal = terminalRef.current;
    const text = options.text || terminal?.getSelection() || latestSelectionRef.current;
    if (!terminal || !text) {
      if (!options.silentEmpty) setTerminalNotice('没有选中的终端文本');
      return false;
    }
    try {
      await writeClipboardText(text, options.preferLegacy);
      if (options.clearSelection !== false && terminal.hasSelection()) terminal.clearSelection();
      terminal.focus();
      setTerminalNotice(options.notice ?? '已复制终端选中文本');
      return true;
    } catch {
      setTerminalNotice('浏览器阻止写入剪贴板');
      return false;
    }
  }, []);

  const connect = useCallback(() => {
    if (!containerRef.current || socketRef.current) return;
    manualCloseRef.current = false;
    setTerminalStatus('connecting');
    setTerminalNotice(null);
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      theme: { background: '#0b1220', foreground: '#d6deeb' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.attachCustomWheelEventHandler((event) => {
      if (event.deltaY === 0) return false;
      if (terminal.buffer.active.type === 'normal' && terminal.buffer.active.baseY > 0) {
        event.preventDefault();
        event.stopPropagation();
        const lines = Math.max(1, Math.ceil(Math.abs(event.deltaY) / 40));
        terminal.scrollLines(event.deltaY > 0 ? lines : -lines);
        return false;
      }
      return true;
    });
    fitRef.current = fit;
    terminal.open(containerRef.current);
    const runFit = () => {
      try {
        const before = `${terminal.cols}x${terminal.rows}`;
        fit.fit();
        const after = `${terminal.cols}x${terminal.rows}`;
        if (after !== before && after !== lastFitGeometryRef.current && terminal.rows > 0) {
          lastFitGeometryRef.current = after;
          terminal.refresh(0, terminal.rows - 1);
        }
      } catch {
        // The fit addon can throw while the terminal is being disposed.
      }
    };
    runFit();
    initialOutputRefreshesRef.current = 2;
    terminal.focus();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const terminalParams = new URLSearchParams({
      cols: String(terminal.cols || 120),
      rows: String(terminal.rows || 40),
      machineId: session.machineId,
      agent: session.agent,
    });
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/api/sessions/${encodeURIComponent(session.id)}/terminal?${terminalParams.toString()}`
    );
    socketRef.current = socket;
    terminalRef.current = terminal;

    const container = containerRef.current;
    const writeInput = (data: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    };
    const flushOutput = () => {
      outputFlushTimerRef.current = null;
      const data = pendingOutputRef.current;
      pendingOutputRef.current = '';
      if (!data || terminalRef.current !== terminal) return;
      terminal.write(data, () => {
        if (initialOutputRefreshesRef.current > 0 && terminal.rows > 0) {
          initialOutputRefreshesRef.current -= 1;
          terminal.refresh(0, terminal.rows - 1);
        }
      });
    };
    const queueOutput = (data: string) => {
      pendingOutputRef.current += data;
      if (outputFlushTimerRef.current !== null) return;
      outputFlushTimerRef.current = window.setTimeout(flushOutput, 16);
    };

    terminal.onData((data) => {
      writeInput(data);
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      latestSelectionRef.current = terminal.getSelection();
      if (!latestSelectionRef.current) lastSelectionCopyRef.current = '';
    });

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      writeInput(text);
      terminal.focus();
      setTerminalNotice('已粘贴到终端');
    };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      terminal.focus();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        setContextMenu({ x: event.clientX, y: event.clientY });
        return;
      }
      void pasteIntoTerminal();
    };
    const stopRightMouseForTmux = (event: MouseEvent | PointerEvent) => {
      if (event.button !== 2) return false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      terminal.focus();
      return true;
    };
    const handlePointerDown = (event: PointerEvent) => {
      stopRightMouseForTmux(event);
    };
    const handlePointerUp = (event: PointerEvent) => {
      stopRightMouseForTmux(event);
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (stopRightMouseForTmux(event)) return;
      if (event.button !== 0) return;
      selectionStartedRef.current = true;
      dragCopyStartRef.current = terminalCellFromMouseEvent(terminal, container, event);
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (stopRightMouseForTmux(event)) return;
      if (event.button !== 0 || !selectionStartedRef.current) return;
      selectionStartedRef.current = false;
      const dragStart = dragCopyStartRef.current;
      const dragEnd = terminalCellFromMouseEvent(terminal, container, event);
      dragCopyStartRef.current = null;
      const draggedText = dragStart && dragEnd && (dragStart.row !== dragEnd.row || dragStart.col !== dragEnd.col)
        ? extractTerminalBufferRange(terminal, dragStart, dragEnd)
        : '';
      const selectedText = terminal.getSelection() || latestSelectionRef.current || draggedText;
      if (!selectedText || selectedText === lastSelectionCopyRef.current) return;
      void copyTerminalSelection({
        clearSelection: false,
        preferLegacy: true,
        silentEmpty: true,
        notice: '已复制选中的终端内容',
        text: selectedText,
      }).then((copied) => {
        if (copied) lastSelectionCopyRef.current = selectedText;
      });
    };
    container.addEventListener('paste', handlePaste);
    container.addEventListener('contextmenu', handleContextMenu);
    container.addEventListener('pointerdown', handlePointerDown, true);
    container.addEventListener('pointerup', handlePointerUp, true);
    container.addEventListener('mousedown', handleMouseDown, true);
    container.addEventListener('mouseup', handleMouseUp, true);
    window.addEventListener('mouseup', handleMouseUp, true);
    terminalCleanupRef.current = () => {
      selectionDisposable.dispose();
      container.removeEventListener('paste', handlePaste);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('pointerdown', handlePointerDown, true);
      container.removeEventListener('pointerup', handlePointerUp, true);
      container.removeEventListener('mousedown', handleMouseDown, true);
      container.removeEventListener('mouseup', handleMouseUp, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };

    let lastResize = '';
    const sendResize = (cols: number, rows: number) => {
      const resize = `${cols}x${rows}`;
      if (resize === lastResize || socket.readyState !== WebSocket.OPEN) return;
      lastResize = resize;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    };
    const queueResize = (cols: number, rows: number) => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        sendResize(cols, rows);
      }, 120);
    };
    terminal.onResize(({ cols, rows }) => queueResize(cols, rows));

    const fitAndQueueResize = () => {
      runFit();
      sendResize(terminal.cols || 120, terminal.rows || 40);
    };
    window.setTimeout(fitAndQueueResize, 0);
    window.setTimeout(fitAndQueueResize, 50);
    window.setTimeout(fitAndQueueResize, 120);
    window.setTimeout(fitAndQueueResize, 240);
    window.setTimeout(fitAndQueueResize, 360);
    window.setTimeout(fitAndQueueResize, 700);
    window.setTimeout(fitAndQueueResize, 1200);
    window.setTimeout(fitAndQueueResize, 2400);
    window.setTimeout(fitAndQueueResize, 5000);
    void document.fonts?.ready.then(fitAndQueueResize).catch(() => {});
    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(fitAndQueueResize));
    resizeObserver.observe(containerRef.current);
    resizeObserverRef.current = resizeObserver;

    socket.onopen = () => {
      setTerminalStatus('connected');
      runFit();
      sendResize(terminal.cols || 120, terminal.rows || 40);
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as TerminalEvent;
      if (message.type === 'output' && message.data) queueOutput(message.data);
      if (message.type === 'ready' && message.data) {
        setTerminalStatus('codex-running');
      }
      if (message.type === 'error') terminal.writeln(`\r\n[error] ${message.data ?? 'unknown error'}`);
      if (message.type === 'exit') {
        terminal.writeln(`\r\n[exit] code=${message.code ?? 'null'} signal=${message.signal ?? 'null'}`);
        setTerminalStatus('disconnected');
      }
    };
    socket.onclose = () => {
      socketRef.current = null;
      setTerminalStatus('disconnected');
      if (!manualCloseRef.current && activeRef.current) {
        setTerminalNotice('连接已断开，正在自动重连到 tmux...');
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connectRef.current();
        }, 1200);
      }
    };
    socket.onerror = () => {
      terminal.writeln('\r\n[error] WebSocket 连接失败');
      setTerminalStatus('disconnected');
    };
  }, [copyTerminalSelection, pasteIntoTerminal, session]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(() => {
    manualCloseRef.current = false;
    closeSocketAndPty();
    window.setTimeout(() => connectRef.current(), 80);
  }, [closeSocketAndPty]);

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!active) return;
    const handle = window.setTimeout(() => {
      if (!socketRef.current) connect();
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [active, connect]);

  return (
    <div className={`terminal-panel${fullscreen ? ' fullscreen' : ''}${active ? '' : ' inactive'}`}>
      <div className="terminal-toolbar">
        <span>
          SSH 终端代理 · {terminalStatus === 'codex-running' ? `${agentLabel(session.agent)} 运行中` : terminalStatusLabel[terminalStatus]}
        </span>
        <button
          type="button"
          className="icon-button terminal-icon-button"
          onClick={() => setFullscreen((value) => !value)}
          title={fullscreen ? '退出全屏' : '全屏'}
          aria-label={fullscreen ? '退出全屏' : '全屏'}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button type="button" className="primary-button" onClick={() => void copyTerminalSelection()} disabled={terminalStatus === 'disconnected'}>
          复制选中
        </button>
        <button type="button" className="primary-button" onClick={() => void pasteIntoTerminal()} disabled={terminalStatus === 'disconnected'}>
          粘贴
        </button>
        <button type="button" className="primary-button" onClick={reconnect}>
          重连
        </button>
        <button type="button" className="danger-button" onClick={disconnect} disabled={terminalStatus === 'disconnected'}>
          断开
        </button>
        <button type="button" className="icon-button terminal-icon-button" onClick={onClose} title="关闭终端标签" aria-label="关闭终端标签">
          <X size={16} />
        </button>
      </div>
      <div className={`terminal-notice${terminalNotice ? '' : ' terminal-notice-empty'}`}>{terminalNotice ?? '\u00a0'}</div>
      {contextMenu ? (
        <div className="terminal-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" onClick={() => { setContextMenu(null); void copyTerminalSelection(); }}>复制</button>
          <button type="button" onClick={() => { setContextMenu(null); void pasteIntoTerminal(); }}>粘贴</button>
          <button type="button" onClick={clearTerminal}>清屏</button>
          <button type="button" onClick={() => { setContextMenu(null); reconnect(); }}>重连</button>
          <button type="button" onClick={() => { setContextMenu(null); onClose(); }}>关闭</button>
        </div>
      ) : null}
      <div className="terminal-surface" ref={containerRef} />
    </div>
  );
}

function SessionFileBrowser({
  sessionId,
  machineId,
  agent,
  onUnauthorized,
}: {
  sessionId: string;
  machineId: string;
  agent: AgentKind;
  onUnauthorized: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [payload, setPayload] = useState<SessionFilesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        sessionFilesListUrl(sessionId, machineId, agent, path)
      );
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const nextPayload = (await response.json()) as SessionFilesPayload & { error?: string };
      if (!response.ok) throw new Error(nextPayload.error || `HTTP ${response.status}`);
      if (
        nextPayload.sessionId !== sessionId ||
        nextPayload.machineId !== machineId ||
        (nextPayload.agent && nextPayload.agent !== agent)
      ) {
        throw new Error('文件目录会话身份不匹配');
      }
      setPayload(nextPayload);
      setCurrentPath(nextPayload.path || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '目录加载失败');
    } finally {
      setLoading(false);
    }
  }, [agent, machineId, onUnauthorized, sessionId]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadFiles(''), 0);
    return () => window.clearTimeout(handle);
  }, [loadFiles]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(sessionFileUploadUrl(
        sessionId,
        machineId,
        agent,
        currentPath,
        file.name
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setNotice(`已上传 ${file.name}`);
      await loadFiles(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [agent, currentPath, loadFiles, machineId, onUnauthorized, sessionId]);

  const downloadUrl = (entry: SessionFileEntry) => {
    return sessionFileDownloadUrl(sessionId, machineId, agent, entry.path);
  };

  return (
    <section className="primary-panel file-browser-panel">
      <div className="panel-heading">
        <div>
          <h3>会话工作目录</h3>
          <span>{payload?.cwd ?? sessionId}</span>
        </div>
        <div className="file-browser-actions">
          <button type="button" className="primary-button" disabled={loading} onClick={() => void loadFiles(currentPath)}>
            <RefreshCw size={16} />
            刷新
          </button>
          <button type="button" className="primary-button" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <Upload size={16} />
            上传文件
          </button>
          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
            }}
          />
        </div>
      </div>

      <div className="file-browser-path">
        <FolderOpen size={16} />
        <code>{payload ? `${payload.root}${payload.path ? `/${payload.path}` : ''}` : 'loading'}</code>
      </div>

      {notice ? <div className="terminal-notice">{notice}</div> : null}
      {error ? <div className="notice danger">目录操作失败：{error}</div> : null}

      <div className="file-browser-list" aria-busy={loading || uploading}>
        {payload?.parent !== null && payload ? (
          <button type="button" className="file-row" onClick={() => void loadFiles(payload.parent ?? '')}>
            <Folder size={17} />
            <strong>..</strong>
            <span>上级目录</span>
            <em />
          </button>
        ) : null}
        {loading ? <div className="empty">正在读取目录...</div> : null}
        {!loading && payload?.entries.length === 0 ? <div className="empty">目录为空</div> : null}
        {payload?.entries.map((entry) => (
          <div className="file-row" key={entry.path}>
            <button
              type="button"
              className="file-name-button"
              disabled={entry.type !== 'directory'}
              onClick={() => entry.type === 'directory' && void loadFiles(entry.path)}
            >
              {entry.type === 'directory' ? <Folder size={17} /> : <FileText size={17} />}
              <strong>{entry.name}</strong>
            </button>
            <span>{entry.type}</span>
            <span>{entry.mtime ? formatDate(entry.mtime) : '-'}</span>
            <em>{fileSizeLabel(entry.size)}</em>
            {entry.type === 'file' ? (
              <a className="icon-button file-download-button" title="下载文件" href={downloadUrl(entry)}>
                <Download size={16} />
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [terminalOnlyRoute] = useState(readTerminalPageRoute);
  const terminalOnlySessionId = terminalOnlyRoute.sessionId;
  const terminalOnlyMachineId = terminalOnlyRoute.machineId;
  const terminalOnlyAgent = terminalOnlyRoute.agent;
  const [filesOnlyRoute] = useState(readFilesPageRoute);
  const filesOnlySessionId = filesOnlyRoute.sessionId;
  const filesOnlyMachineId = filesOnlyRoute.machineId;
  const filesOnlyAgent = filesOnlyRoute.agent;
  const isTerminalOnlyPage = Boolean(terminalOnlySessionId);
  const isFilesOnlyPage = Boolean(filesOnlySessionId);
  const [terminalOnlySession, setTerminalOnlySession] = useState<TerminalSessionTarget | null>(null);
  const [terminalOnlyLoading, setTerminalOnlyLoading] = useState(
    Boolean(terminalOnlySessionId && terminalOnlyMachineId && terminalOnlyAgent)
  );
  const [terminalOnlyError, setTerminalOnlyError] = useState<string | null>(
    terminalOnlySessionId && (!terminalOnlyMachineId || !terminalOnlyAgent)
      ? '缺少机器或 Agent 标识，请返回面板重新打开终端'
      : null
  );
  const [filesOnlySession, setFilesOnlySession] = useState<CodexSession | null>(null);
  const [filesOnlyLoading, setFilesOnlyLoading] = useState(
    Boolean(filesOnlySessionId && filesOnlyMachineId && filesOnlyAgent)
  );
  const [filesOnlyError, setFilesOnlyError] = useState<string | null>(
    filesOnlySessionId && (!filesOnlyMachineId || !filesOnlyAgent)
      ? '缺少机器或 Agent 标识，请返回面板重新打开会话文件页'
      : null
  );
  const [allSessions, setAllSessions] = useState<CodexSession[]>([]);
  const [sessionDetails, setSessionDetails] = useState<Record<string, CodexSession>>({});
  const [recycleArchives, setRecycleArchives] = useState<RecycleArchive[]>([]);
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteAgentStatus[]>([]);
  const [meta, setMeta] = useState<ApiPayload['meta'] | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [machineFilter, setMachineFilter] = useState(readStoredMachineFilter);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>(readStoredAgentFilter);
  const [listViewMode, setListViewMode] = useState<SessionListViewMode>('folder');
  const [query, setQuery] = useState('');
  const [aiSearchQuery, setAiSearchQuery] = useState('');
  const [aiSearchResult, setAiSearchResult] = useState<AiSessionSearchPayload | null>(null);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiSearchError, setAiSearchError] = useState<string | null>(null);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [migrationTargets, setMigrationTargets] = useState<Record<string, string>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [copiedResumeKey, setCopiedResumeKey] = useState<string | null>(null);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<string[]>([]);
  const [historyMessages, setHistoryMessages] = useState<HistoryMessage[]>([]);
  const [historyBefore, setHistoryBefore] = useState<number | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadedSessionKey, setHistoryLoadedSessionKey] = useState<string | null>(null);
  const [recentUserMessages, setRecentUserMessages] = useState<RecentUserMessagesState>({
    sessionKey: null,
    messages: [],
    loading: false,
    error: false,
  });
  const [recycleQuery, setRecycleQuery] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [workerJobs, setWorkerJobs] = useState<CodexWorkerJob[]>([]);
  const [jobRegistryMachineId, setJobRegistryMachineId] = useState<string | null>(null);
  const [jobRegistryBaseUrl, setJobRegistryBaseUrl] = useState<string | null>(null);
  const [jobRegistryHealth, setJobRegistryHealth] = useState<CodexJobRegistryHealth[]>([]);
  const [jobRegistryErrors, setJobRegistryErrors] = useState<CodexJobRegistryError[]>([]);
  const [workerJobsLoading, setWorkerJobsLoading] = useState(false);
  const [workerJobsError, setWorkerJobsError] = useState<string | null>(null);
  const [workerJobBusyKey, setWorkerJobBusyKey] = useState<string | null>(null);
  const [selectedWorkerJobKey, setSelectedWorkerJobKey] = useState<string | null>(null);
  const [workerGuidanceDrafts, setWorkerGuidanceDrafts] = useState<Record<string, string>>({});
  const [workerProtocolKindsByJob, setWorkerProtocolKindsByJob] = useState<Record<string, WorkerProtocolKind>>({});
  const [workerSupervisorDrafts, setWorkerSupervisorDrafts] = useState<Record<string, string>>({});
  const [workerSupervisorAutoStop, setWorkerSupervisorAutoStop] = useState<Record<string, boolean>>({});
  const [workerActionMessage, setWorkerActionMessage] = useState<string | null>(null);
  const [workerJobEvents, setWorkerJobEvents] = useState<Record<string, CodexWorkerEvent[]>>({});
  const [workerJobEventSeq, setWorkerJobEventSeq] = useState<Record<string, number>>({});
  const [workerJobEventsUnavailable, setWorkerJobEventsUnavailable] = useState<Record<string, boolean>>({});
  const [commanderActions, setCommanderActions] = useState<CommanderAction[]>([]);
  const [commanderActionsLoading, setCommanderActionsLoading] = useState(false);
  const [commanderActionsError, setCommanderActionsError] = useState<string | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeItemResult[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [contextPack, setContextPack] = useState<ContextPack | null>(null);
  const [contextPackLoading, setContextPackLoading] = useState(false);
  const [contextPackError, setContextPackError] = useState<string | null>(null);
  const [contextPromptCopied, setContextPromptCopied] = useState(false);
  const [fleetAudit, setFleetAudit] = useState<FleetAuditPayload | null>(null);
  const [fleetAuditLoading, setFleetAuditLoading] = useState(false);
  const [fleetAuditError, setFleetAuditError] = useState<string | null>(null);
  const [sessionAuditEvents, setSessionAuditEvents] = useState<SessionAuditEvent[]>([]);

  const loadFleetAudit = useCallback(async (refresh = false) => {
    setFleetAuditLoading(true);
    setFleetAuditError(null);
    try {
      const response = await fetch(`/api/audit/fleet${refresh ? '?refresh=1' : ''}`);
      const payload = (await response.json().catch(() => ({}))) as FleetAuditPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setFleetAudit(payload);
    } catch (err) {
      setFleetAuditError(err instanceof Error ? err.message : '会话完整性审计失败');
    } finally {
      setFleetAuditLoading(false);
    }
  }, []);

  const loadSessionAudit = useCallback(async (session: CodexSession) => {
    try {
      const params = new URLSearchParams({
        sessionId: session.id,
        machineId: session.machineId,
        agent: session.agent,
        limit: '80',
      });
      const response = await fetch(`/api/audit/events?${params.toString()}`);
      const payload = (await response.json().catch(() => ({}))) as { events?: SessionAuditEvent[] };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSessionAuditEvents(Array.isArray(payload.events) ? payload.events.slice().reverse() : []);
    } catch {
      setSessionAuditEvents([]);
    }
  }, []);

  const refreshRemoteStatuses = useCallback(async () => {
    try {
      const response = await fetch('/api/remote-agents');
      if (!response.ok) return;
      const payload = (await response.json()) as { agents: RemoteAgentStatus[] };
      setRemoteStatuses(payload.agents);
    } catch {
      setRemoteStatuses((current) => current.map((agent) => ({ ...agent, online: false, error: '状态刷新失败', latencyMs: null })));
    }
  }, []);

  const loadCommanderActions = useCallback(async () => {
    setCommanderActionsLoading(true);
    setCommanderActionsError(null);
    try {
      const response = await fetch('/api/commander-actions');
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { actions?: CommanderAction[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const actions = Array.isArray(payload.actions) ? payload.actions : [];
      setCommanderActions([...actions].sort((a, b) => commanderActionTime(b) - commanderActionTime(a)));
    } catch (err) {
      setCommanderActionsError(err instanceof Error ? err.message : 'commander actions 加载失败');
    } finally {
      setCommanderActionsLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (refreshWorkflow = false) => {
    setLoading(true);
    setError(null);
    const baseParams = new URLSearchParams();
    if (refreshWorkflow) baseParams.set('refresh', '1');

    try {
      const localParams = new URLSearchParams(baseParams);
      localParams.set('remote', '0');
      localParams.set('detail', '0');
      const [localResponse, recycleResponse] = await Promise.all([
        fetch(`/api/sessions?${localParams.toString()}`),
        fetch('/api/recycle-bin'),
      ]);
      if (localResponse.status === 401 || recycleResponse.status === 401) {
        setAuthRequired(true);
        setLoading(false);
        return;
      }
      if (!localResponse.ok) throw new Error(`HTTP ${localResponse.status}`);
      if (!recycleResponse.ok) throw new Error(`Recycle HTTP ${recycleResponse.status}`);
      const payload = (await localResponse.json()) as ApiPayload;
      const recyclePayload = (await recycleResponse.json()) as RecyclePayload;
      setAuthRequired(false);
      setAuthMessage(null);
      setAllSessions(normalizeSessions(payload.sessions));
      setRecycleArchives(recyclePayload.archives);
      setMeta(payload.meta);
      setLoading(false);
      void refreshRemoteStatuses();

      if (!refreshWorkflow) {
        const remoteResponse = await fetch('/api/sessions?detail=0');
        if (remoteResponse.ok) {
          const remotePayload = (await remoteResponse.json()) as ApiPayload;
          setAllSessions(normalizeSessions(remotePayload.sessions));
          setMeta(remotePayload.meta);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      setLoading(false);
    }
  }, [refreshRemoteStatuses]);

  const runAiSessionSearch = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const searchText = aiSearchQuery.trim();
    if (searchText.length < 2 || aiSearchLoading) return;
    setAiSearchLoading(true);
    setAiSearchError(null);
    try {
      const response = await fetch('/api/sessions/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchText,
          limit: 12,
          machineId: machineFilter,
          agent: agentFilter,
        }),
      });
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as Partial<AiSessionSearchPayload> & { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const matches = Array.isArray(payload.matches)
        ? payload.matches.map((match) => ({
            ...match,
            session: normalizeSession(match.session),
          }))
        : [];
      const normalized: AiSessionSearchPayload = {
        query: payload.query ?? searchText,
        intent: payload.intent ?? searchText,
        mode: payload.mode === 'fallback-local' ? 'fallback-local' : 'deepseek',
        model: payload.model ?? null,
        fallbackReason: payload.fallbackReason ?? null,
        routing: {
          mode:
            payload.routing?.mode === 'deepseek' ||
            payload.routing?.mode === 'user-filter' ||
            payload.routing?.mode === 'local-hint'
              ? payload.routing.mode
              : 'broad',
          scope: payload.routing?.scope === 'focused' ? 'focused' : 'broad',
          machineIds: Array.isArray(payload.routing?.machineIds) ? payload.routing.machineIds : [],
          confidence: typeof payload.routing?.confidence === 'number' ? payload.routing.confidence : 0,
          reason: payload.routing?.reason ?? '',
          searchTerms: Array.isArray(payload.routing?.searchTerms) ? payload.routing.searchTerms : [],
          latencyMs: typeof payload.routing?.latencyMs === 'number' ? payload.routing.latencyMs : 0,
          fallbackReason: payload.routing?.fallbackReason ?? null,
        },
        phaseLatencyMs: {
          routing: typeof payload.phaseLatencyMs?.routing === 'number' ? payload.phaseLatencyMs.routing : 0,
          ranking: typeof payload.phaseLatencyMs?.ranking === 'number' ? payload.phaseLatencyMs.ranking : 0,
        },
        latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
        candidateCount: typeof payload.candidateCount === 'number' ? payload.candidateCount : 0,
        candidateMachineCounts:
          payload.candidateMachineCounts && typeof payload.candidateMachineCounts === 'object'
            ? payload.candidateMachineCounts
            : {},
        count: matches.length,
        matches,
      };
      setAiSearchResult(normalized);
      setActiveTab('all');
      setQuery('');
      setSelectedSessionKey(matches[0] ? sessionKey(matches[0].session) : null);
    } catch (err) {
      setAiSearchError(err instanceof Error ? err.message : 'AI 快速检索失败');
    } finally {
      setAiSearchLoading(false);
    }
  }, [agentFilter, aiSearchLoading, aiSearchQuery, machineFilter]);

  const loadTerminalOnlySession = useCallback(async () => {
    if (!terminalOnlySessionId || !terminalOnlyMachineId || !terminalOnlyAgent) return;
    setTerminalOnlyLoading(true);
    setTerminalOnlyError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const params = new URLSearchParams({
        machineId: terminalOnlyMachineId,
        agent: terminalOnlyAgent,
      });
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(terminalOnlySessionId)}?${params.toString()}`,
        { signal: controller.signal }
      );
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const session = normalizeSession(await response.json());
      if (
        session.machineId !== terminalOnlyMachineId ||
        session.agent !== terminalOnlyAgent
      ) {
        throw new Error('终端会话身份不匹配');
      }
      setTerminalOnlySession(session);
      setAuthRequired(false);
      setAuthMessage(null);
    } catch (err) {
      setTerminalOnlyError(err instanceof DOMException && err.name === 'AbortError'
        ? '终端会话加载超时'
        : err instanceof Error ? err.message : '终端会话加载失败');
    } finally {
      window.clearTimeout(timeout);
      setTerminalOnlyLoading(false);
    }
  }, [terminalOnlyAgent, terminalOnlyMachineId, terminalOnlySessionId]);

  const loadFilesOnlySession = useCallback(async () => {
    if (!filesOnlySessionId || !filesOnlyMachineId || !filesOnlyAgent) return;
    setFilesOnlyLoading(true);
    setFilesOnlyError(null);
    try {
      const response = await fetch(
        sessionFilesDetailUrl(
          filesOnlySessionId,
          filesOnlyMachineId,
          filesOnlyAgent
        )
      );
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const session = normalizeSession(await response.json());
      if (
        session.machineId !== filesOnlyMachineId ||
        session.agent !== filesOnlyAgent
      ) {
        throw new Error('文件页会话身份不匹配');
      }
      setFilesOnlySession(session);
      setAuthRequired(false);
      setAuthMessage(null);
    } catch (err) {
      setFilesOnlyError(
        err instanceof Error ? err.message : '文件页会话加载失败'
      );
    } finally {
      setFilesOnlyLoading(false);
    }
  }, [filesOnlyAgent, filesOnlyMachineId, filesOnlySessionId]);

  const upsertWorkerJob = useCallback((job: CodexWorkerJob) => {
    const normalizedJob = normalizeWorkerJob(job);
    requireVerifiedWorkerJobIdentity(normalizedJob);
    const key = workerJobKey(normalizedJob);
    setWorkerJobs((current) => sortWorkerJobs([
      normalizedJob,
      ...current.filter((item) => workerJobKey(item) !== key),
    ]));
  }, []);

  const loadWorkerJobs = useCallback(async () => {
    setWorkerJobsLoading(true);
    setWorkerJobsError(null);
    try {
      const response = await fetch('/api/codex/job-registry');
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const payload = (await response.json()) as CodexJobRegistryPayload;
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setJobRegistryMachineId(payload.machineId ?? null);
      setJobRegistryBaseUrl(payload.baseUrl ?? null);
      setJobRegistryHealth(Array.isArray(payload.health) ? payload.health : []);
      setJobRegistryErrors(Array.isArray(payload.errors) ? payload.errors : []);
      const jobsByKey = new Map<string, CodexWorkerJob>();
      (Array.isArray(payload.jobs) ? payload.jobs : [])
        .filter((entry) => entry.job)
        .map((entry) => normalizeWorkerJob({
          ...entry.job,
          machineId: entry.job?.machineId ?? entry.machineId ?? null,
          machine: entry.job?.machine ?? entry.machineId ?? undefined,
        } as CodexWorkerJob))
        .forEach((job) => jobsByKey.set(workerJobKey(job), job));
      setWorkerJobs(sortWorkerJobs([...jobsByKey.values()]));
    } catch (err) {
      setWorkerJobsError(err instanceof Error ? err.message : 'worker job 加载失败');
    } finally {
      setWorkerJobsLoading(false);
    }
  }, []);

  const refreshWorkerJob = useCallback(async (job: CodexWorkerJob) => {
    const response = await fetch(workerJobRequestUrl(job));
    const payload = (await response.json()) as { job?: CodexWorkerJob; error?: string };
    if (!response.ok || !payload.job) throw new Error(payload.error || `HTTP ${response.status}`);
    const verifiedJob = verifyWorkerJobResponse(job, payload.job);
    upsertWorkerJob(verifiedJob);
    return verifiedJob;
  }, [upsertWorkerJob]);

  const loadWorkerJobEvents = useCallback(async (job: CodexWorkerJob) => {
    const key = workerJobKey(job);
    if (workerJobEventsUnavailable[key]) return;
    const afterSeq = workerJobEventSeq[key] ?? 0;
    try {
      const response = await fetch(workerJobRequestUrl(job, '/events', {
        afterSeq: String(afterSeq),
      }));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        events?: CodexWorkerEvent[];
        nextSeq?: number;
        job?: CodexWorkerJob;
      };
      if (!payload.job) throw new Error('Worker job 事件响应缺少身份');
      upsertWorkerJob(verifyWorkerJobResponse(job, payload.job));
      const events = Array.isArray(payload.events) ? payload.events : [];
      setWorkerJobEventsUnavailable((current) => ({ ...current, [key]: false }));
      if (!events.length) return;

      setWorkerJobEvents((current) => {
        const existing = current[key] ?? [];
        const seen = new Set(
          existing.map((event) => (typeof event.seq === 'number' ? `seq:${event.seq}` : `raw:${formatUnknownValue(event)}`))
        );
        const merged = [
          ...existing,
          ...events.filter((event) => {
            const key = typeof event.seq === 'number' ? `seq:${event.seq}` : `raw:${formatUnknownValue(event)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        ].slice(-160);
        return { ...current, [key]: merged };
      });

      const maxEventSeq = events.reduce((max, event) => (
        typeof event.seq === 'number' ? Math.max(max, event.seq) : max
      ), afterSeq);
      const nextSeq = typeof payload.nextSeq === 'number' ? payload.nextSeq : maxEventSeq;
      setWorkerJobEventSeq((current) => ({ ...current, [key]: Math.max(current[key] ?? 0, nextSeq) }));
    } catch {
      setWorkerJobEventsUnavailable((current) => ({ ...current, [key]: true }));
    }
  }, [upsertWorkerJob, workerJobEventSeq, workerJobEventsUnavailable]);

  async function stopWorkerJob(job: CodexWorkerJob) {
    setWorkerJobBusyKey(workerJobActionKey(job, 'stop'));
    setWorkerActionMessage(null);
    try {
      const response = await fetch(workerJobRequestUrl(job, '/stop'), { method: 'POST' });
      const payload = (await response.json()) as { job?: CodexWorkerJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || `HTTP ${response.status}`);
      upsertWorkerJob(verifyWorkerJobResponse(job, payload.job));
      setWorkerActionMessage(`已停止 job：${job.id}`);
    } catch (err) {
      setWorkerActionMessage(`停止失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setWorkerJobBusyKey(null);
    }
  }

  async function sendWorkerGuidance(job: CodexWorkerJob) {
    const key = workerJobKey(job);
    const text = (workerGuidanceDrafts[key] ?? '').trim();
    if (!text) return;
    setWorkerJobBusyKey(workerJobActionKey(job, 'guidance'));
    setWorkerActionMessage(null);
    try {
      const response = await fetch(workerJobRequestUrl(job, '/guidance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'api' }),
      });
      const payload = (await response.json()) as { job?: CodexWorkerJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || `HTTP ${response.status}`);
      upsertWorkerJob(verifyWorkerJobResponse(job, payload.job));
      setWorkerGuidanceDrafts((current) => ({ ...current, [key]: '' }));
      setWorkerActionMessage('已发送指导');
    } catch (err) {
      setWorkerActionMessage(`指导发送失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setWorkerJobBusyKey(null);
    }
  }

  async function sendWorkerProtocolKind(job: CodexWorkerJob) {
    const key = workerJobKey(job);
    const kind = workerProtocolKindsByJob[key] ?? 'guide';
    const label = workerProtocolKinds.find((item) => item.id === kind)?.label ?? kind;
    setWorkerJobBusyKey(workerJobActionKey(job, 'protocol'));
    setWorkerActionMessage(null);
    try {
      const protocolResponse = await fetch(workerJobRequestUrl(job, '/protocol'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      if (protocolResponse.ok) {
        const payload = (await protocolResponse.json()) as { job?: CodexWorkerJob };
        if (payload.job) upsertWorkerJob(verifyWorkerJobResponse(job, payload.job));
        else await refreshWorkerJob(job);
        setWorkerActionMessage(`已发送 protocol：${label}`);
        return;
      }
      if (![404, 405, 501].includes(protocolResponse.status)) {
        const payload = (await protocolResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `HTTP ${protocolResponse.status}`);
      }

      const fallbackResponse = await fetch(workerJobRequestUrl(job, '/guidance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `[protocol:${kind}] ${label}`, source: 'api' }),
      });
      const fallbackPayload = (await fallbackResponse.json()) as { job?: CodexWorkerJob; error?: string };
      if (!fallbackResponse.ok || !fallbackPayload.job) throw new Error(fallbackPayload.error || `HTTP ${fallbackResponse.status}`);
      upsertWorkerJob(verifyWorkerJobResponse(job, fallbackPayload.job));
      setWorkerActionMessage(`后端未提供 protocol endpoint，已按 guidance 记录：${label}`);
    } catch (err) {
      setWorkerActionMessage(`protocol 发送失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setWorkerJobBusyKey(null);
    }
  }

  async function superviseWorkerJob(job: CodexWorkerJob) {
    const key = workerJobKey(job);
    const instruction = (workerSupervisorDrafts[key] ?? '').trim();
    setWorkerJobBusyKey(workerJobActionKey(job, 'supervise'));
    setWorkerActionMessage(null);
    try {
      const response = await fetch(workerJobRequestUrl(job, '/supervise'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(instruction ? { instruction } : {}),
          autoStop: workerSupervisorAutoStop[key] ?? false,
        }),
      });
      const payload = (await response.json()) as {
        job?: CodexWorkerJob;
        decision?: string;
        reason?: string;
        followupJob?: CodexWorkerJob;
        error?: string;
      };
      if (!response.ok || !payload.job) throw new Error(payload.error || `HTTP ${response.status}`);
      upsertWorkerJob(verifyWorkerJobResponse(job, payload.job));
      if (payload.followupJob) {
        upsertWorkerJob(verifyWorkerJobResponse(job, payload.followupJob, {
          allowDifferentJobId: true,
        }));
      }
      setWorkerActionMessage(`监督结果：${payload.decision ?? '未知'} · ${payload.reason ?? '无原因'}`);
    } catch (err) {
      setWorkerActionMessage(`supervise 失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setWorkerJobBusyKey(null);
    }
  }

  async function login(username: string, password: string) {
    setAuthBusy(true);
    setAuthMessage(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        setAuthMessage(response.status === 401 ? '用户名或密码不正确' : `登录失败：HTTP ${response.status}`);
        return;
      }
      setAuthRequired(false);
      if (terminalOnlySessionId) {
        await loadTerminalOnlySession();
        return;
      }
      if (filesOnlySessionId) {
        await loadFilesOnlySession();
        return;
      }
      await loadSessions();
      if (SHOW_ADVANCED_UI) void Promise.all([loadCommanderActions(), loadFleetAudit()]);
    } catch (err) {
      setAuthMessage(err instanceof Error ? err.message : '登录失败');
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAuthRequired(true);
    setAllSessions([]);
    setSessionDetails({});
    setRecycleArchives([]);
    setCommanderActions([]);
    setFleetAudit(null);
    setSessionAuditEvents([]);
    setAiSearchResult(null);
    setAiSearchError(null);
    setSelectedSessionKey(null);
  }

  useEffect(() => {
    if (isTerminalOnlyPage || isFilesOnlyPage) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      if (SHOW_ADVANCED_UI) {
        void Promise.all([loadSessions(), loadCommanderActions()]).finally(() => {
          if (!cancelled) void loadFleetAudit();
        });
      } else {
        void loadSessions();
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [isFilesOnlyPage, isTerminalOnlyPage, loadCommanderActions, loadFleetAudit, loadSessions]);

  useEffect(() => {
    if (
      !terminalOnlySessionId ||
      !terminalOnlyMachineId ||
      !terminalOnlyAgent ||
      authRequired
    ) return;
    const handle = window.setTimeout(() => void loadTerminalOnlySession(), 0);
    return () => window.clearTimeout(handle);
  }, [
    authRequired,
    loadTerminalOnlySession,
    terminalOnlyAgent,
    terminalOnlyMachineId,
    terminalOnlySessionId,
  ]);

  useEffect(() => {
    if (
      !filesOnlySessionId ||
      !filesOnlyMachineId ||
      !filesOnlyAgent ||
      authRequired
    ) return;
    const handle = window.setTimeout(() => void loadFilesOnlySession(), 0);
    return () => window.clearTimeout(handle);
  }, [
    authRequired,
    filesOnlyAgent,
    filesOnlyMachineId,
    filesOnlySessionId,
    loadFilesOnlySession,
  ]);

  const machineOptions = useMemo(() => ['all', ...Array.from(new Set(allSessions.map((session) => session.machineId))).sort()], [allSessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MACHINE_FILTER_STORAGE_KEY, machineFilter);
    } catch {
      // Browser storage may be unavailable in private contexts.
    }
  }, [machineFilter]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AGENT_FILTER_STORAGE_KEY, agentFilter);
    } catch {
      // Browser storage may be unavailable in private contexts.
    }
  }, [agentFilter]);

  useEffect(() => {
    if (!allSessions.length) return;
    if (machineOptions.includes(machineFilter)) return;
    const handle = window.setTimeout(() => setMachineFilter('all'), 0);
    return () => window.clearTimeout(handle);
  }, [allSessions.length, machineFilter, machineOptions]);

  const aiSearchSessions = useMemo(() => {
    if (!aiSearchResult) return [];
    const currentSessions = new Map(allSessions.map((session) => [sessionKey(session), session]));
    return aiSearchResult.matches.map((match) => currentSessions.get(sessionKey(match.session)) ?? match.session);
  }, [aiSearchResult, allSessions]);

  const aiSearchMatchByKey = useMemo(
    () => new Map((aiSearchResult?.matches ?? []).map((match) => [sessionKey(match.session), match])),
    [aiSearchResult],
  );

  const agentFilterCounts = useMemo(() => {
    const source = aiSearchResult ? aiSearchSessions : allSessions;
    const sessions = source.filter(
      (session) =>
        filterByTab(session, activeTab) &&
        (machineFilter === 'all' || session.machineId === machineFilter) &&
        (aiSearchResult ? true : matchesSearch(session, query))
    );
    return {
      all: sessions.length,
      codex: sessions.filter((session) => session.agent === 'codex').length,
      claude: sessions.filter((session) => session.agent === 'claude').length,
    };
  }, [activeTab, aiSearchResult, aiSearchSessions, allSessions, machineFilter, query]);

  const visibleSessions = useMemo(() => {
    const source = aiSearchResult ? aiSearchSessions : allSessions;
    return source.filter(
        (session) =>
          filterByTab(session, activeTab) &&
          (machineFilter === 'all' || session.machineId === machineFilter) &&
          (agentFilter === 'all' || session.agent === agentFilter) &&
          (aiSearchResult ? true : matchesSearch(session, query))
      );
  }, [activeTab, agentFilter, aiSearchResult, aiSearchSessions, allSessions, machineFilter, query]);

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; title: string; sortTime: number; sessions: CodexSession[] }>();
    for (const session of visibleSessions) {
      const group =
        listViewMode === 'activityDate'
          ? activityDateGroup(session)
          : {
              key: sessionGroupKey(session),
              label: session.machineId,
              title: normalizePath(session.cwd) || 'unknown cwd',
              sortTime: Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0,
            };
      const key = group.key;
      const current =
        groups.get(key) ??
        {
          key,
          label: group.label,
          title: group.title,
          sortTime: group.sortTime,
          sessions: [],
        };
      current.sessions.push(session);
      current.sortTime = Math.max(current.sortTime, group.sortTime);
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) =>
      listViewMode === 'activityDate'
        ? b.sortTime - a.sortTime || b.sessions.length - a.sessions.length
        : b.sessions.length - a.sessions.length || a.title.localeCompare(b.title)
    );
  }, [listViewMode, visibleSessions]);

  const selectedSummary = useMemo(
    () => visibleSessions.find((session) => sessionKey(session) === selectedSessionKey) ?? visibleSessions[0] ?? null,
    [selectedSessionKey, visibleSessions]
  );
  const selected = selectedSummary ? (sessionDetails[sessionKey(selectedSummary)] ?? selectedSummary) : null;
  const selectedIdentityKey = selected ? sessionKey(selected) : null;
  const visibleSessionKeys = useMemo(() => visibleSessions.map(sessionKey), [visibleSessions]);
  const selectedKeySet = useMemo(() => new Set(selectedSessionKeys), [selectedSessionKeys]);
  const selectedVisibleCount = useMemo(
    () => visibleSessionKeys.filter((key) => selectedKeySet.has(key)).length,
    [selectedKeySet, visibleSessionKeys]
  );
  const allVisibleSelected = visibleSessionKeys.length > 0 && selectedVisibleCount === visibleSessionKeys.length;
  const visibleRecycleArchives = useMemo(() => {
    const needle = (recycleQuery || query).trim().toLowerCase();
    if (!needle) return recycleArchives;
    return recycleArchives.filter((archive) =>
      [archive.sessionId, archive.machineId, archive.agent ?? '', archive.archiveDir, archive.originalSessionFile ?? '', ...archive.archivedFiles, ...archive.removedOriginalFiles]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [query, recycleArchives, recycleQuery]);

  const titleDraft = selected ? (titleDrafts[sessionKey(selected)] ?? selected.customTitle ?? selected.title) : '';
  const migrationTarget = selected
    ? (migrationTargets[sessionKey(selected)] ??
      selected.evaluation.recommendedWorkdir ??
      selected.evaluation.actualWorkdirs[0] ??
      selected.cwd ??
      '')
    : '';
  const migrationAlreadyInPlace = selected ? normalizePath(selected.cwd) === normalizePath(migrationTarget) : false;
  const selectedSameDirectoryMigrationSessions = useMemo(
    () => (
      selected
        ? allSessions.filter(
            (session) =>
              selectedKeySet.has(sessionKey(session)) &&
              session.machineId === selected.machineId &&
              normalizePath(session.cwd) === normalizePath(selected.cwd)
          )
        : []
    ),
    [allSessions, selected, selectedKeySet]
  );
  const selectedCodexMigrationCount = selectedSameDirectoryMigrationSessions.filter(
    (session) => session.agent === 'codex'
  ).length;
  const selectedClaudeMigrationCount = selectedSameDirectoryMigrationSessions.filter(
    (session) => session.agent === 'claude'
  ).length;
  const knowledgeSearchText = (knowledgeQuery.trim() || query.trim() || selected?.title || '').trim();
  const selectedProjectPath = selected?.evaluation.recommendedWorkdir ?? selected?.cwd ?? null;
  const contextPackSummary = contextPack
    ? [
        `${contextPack.preferences.length} preferences`,
        `${contextPack.projectFacts.length} project facts`,
        `${contextPack.runbooks.length} runbooks`,
        `${contextPack.sessions.length} sessions`,
      ].join(' · ')
    : '未构建 context pack';

  const loadKnowledgeSearch = useCallback(async () => {
    const q = knowledgeSearchText;
    if (!q) {
      setKnowledgeError('请输入搜索词，或选择一个有标题的会话');
      return;
    }
    setKnowledgeLoading(true);
    setKnowledgeError(null);
    try {
      const params = new URLSearchParams({ q, limit: '12' });
      const response = await fetch(`/api/knowledge/search?${params.toString()}`);
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { items?: KnowledgeItemResult[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setKnowledgeResults(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setKnowledgeError(err instanceof Error ? err.message : 'knowledge search 加载失败');
    } finally {
      setKnowledgeLoading(false);
    }
  }, [knowledgeSearchText]);

  const loadContextPack = useCallback(async () => {
    const q = knowledgeSearchText || selected?.title || selected?.evaluation.summary || '';
    if (!q && !selectedProjectPath) {
      setContextPackError('请输入任务或选择一个项目会话');
      return;
    }
    setContextPackLoading(true);
    setContextPackError(null);
    try {
      const params = new URLSearchParams({ limit: '8', remote: '0' });
      if (q) params.set('q', q);
      if (selected?.cwd) params.set('cwd', selected.cwd);
      if (selectedProjectPath) params.set('repo', selectedProjectPath);
      const response = await fetch(`/api/context-pack?${params.toString()}`);
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as ContextPack & { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setContextPack(payload);
    } catch (err) {
      setContextPackError(err instanceof Error ? err.message : 'context pack 构建失败');
    } finally {
      setContextPackLoading(false);
    }
  }, [knowledgeSearchText, selected, selectedProjectPath]);

  const copyContextPrompt = useCallback(async () => {
    if (!contextPack?.workerPromptContext) return;
    try {
      await navigator.clipboard.writeText(contextPack.workerPromptContext);
      setContextPromptCopied(true);
      window.setTimeout(() => setContextPromptCopied(false), 1800);
    } catch {
      setContextPackError('复制失败：浏览器阻止访问剪贴板');
    }
  }, [contextPack]);

  const selectedWorkerJobs = useMemo(
    () => (
      selected
        ? sortWorkerJobs(
            workerJobs.filter((job) => {
              const identity = verifiedWorkerJobIdentity(job);
              return identity !== null &&
                identity.agent === selected.agent &&
                identity.sessionId === selected.id &&
                identity.machineId === selected.machineId;
            })
          )
        : []
    ),
    [selected, workerJobs]
  );
  const currentWorkerJob = useMemo(() => {
    if (!selectedWorkerJobs.length) return null;
    return selectedWorkerJobs.find((job) => workerJobKey(job) === selectedWorkerJobKey)
      ?? selectedWorkerJobs.find(isWorkerJobRunning)
      ?? selectedWorkerJobs[0];
  }, [selectedWorkerJobKey, selectedWorkerJobs]);
  const currentWorkerJobKey = currentWorkerJob ? workerJobKey(currentWorkerJob) : null;
  const currentWorkerEvents = currentWorkerJobKey ? (workerJobEvents[currentWorkerJobKey] ?? []) : [];
  const currentWorkerProtocolKind = currentWorkerJobKey ? (workerProtocolKindsByJob[currentWorkerJobKey] ?? 'guide') : 'guide';
  const currentWorkerGuidanceDraft = currentWorkerJobKey ? (workerGuidanceDrafts[currentWorkerJobKey] ?? '') : '';
  const currentWorkerSupervisorDraft = currentWorkerJobKey ? (workerSupervisorDrafts[currentWorkerJobKey] ?? '') : '';
  const currentWorkerSupervisorAutoStop = currentWorkerJobKey ? (workerSupervisorAutoStop[currentWorkerJobKey] ?? false) : false;
  const recentCommanderActions = useMemo(() => commanderActions.slice(0, 8), [commanderActions]);
  const jobRegistryMachines = useMemo(() => {
    const machines = new Map<string, CodexJobRegistryHealth & { runningJobs: number; totalJobs: number }>();
    const localMachineId = jobRegistryMachineId ?? 'local';

    machines.set(machineKey(localMachineId, jobRegistryBaseUrl), {
      machineId: localMachineId,
      baseUrl: jobRegistryBaseUrl,
      healthy: true,
      updatedAt: null,
      cached: false,
      error: null,
      runningJobs: 0,
      totalJobs: 0,
    });

    jobRegistryHealth.forEach((item) => {
      machines.set(machineKey(item.machineId, item.baseUrl), {
        ...item,
        runningJobs: 0,
        totalJobs: 0,
      });
    });

    workerJobs.forEach((job) => {
      const id = job.machineId ?? job.machine ?? localMachineId;
      const key = [...machines.keys()].find((item) => item.startsWith(`${id}|||`)) ?? machineKey(id, null);
      const existing = machines.get(key) ?? {
        machineId: id,
        baseUrl: null,
        healthy: true,
        updatedAt: null,
        cached: false,
        error: null,
        runningJobs: 0,
        totalJobs: 0,
      };
      machines.set(key, {
        ...existing,
        totalJobs: existing.totalJobs + 1,
        runningJobs: existing.runningJobs + (isWorkerJobRunning(job) ? 1 : 0),
      });
    });

    return [...machines.values()].sort((a, b) => {
      const healthDelta = Number(b.healthy) - Number(a.healthy);
      return healthDelta || b.runningJobs - a.runningJobs || a.machineId.localeCompare(b.machineId);
    });
  }, [jobRegistryBaseUrl, jobRegistryHealth, jobRegistryMachineId, workerJobs]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setActionMessage(null);
      setCopiedResumeKey(null);
      setWorkerActionMessage(null);
      setSelectedWorkerJobKey(null);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [selectedIdentityKey]);

  useEffect(() => {
    if (!SHOW_ADVANCED_UI || isTerminalOnlyPage || activeTab === 'recycle' || !selectedIdentityKey) return;
    const firstLoad = window.setTimeout(() => {
      void loadWorkerJobs();
    }, 0);
    const interval = window.setInterval(() => {
      void loadWorkerJobs();
    }, 8000);
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(interval);
    };
  }, [
    activeTab,
    isTerminalOnlyPage,
    loadWorkerJobs,
    selectedIdentityKey,
  ]);

  useEffect(() => {
    if (!SHOW_ADVANCED_UI || isTerminalOnlyPage || activeTab === 'recycle' || !currentWorkerJob) return;
    const firstLoad = window.setTimeout(() => {
      void loadWorkerJobEvents(currentWorkerJob);
    }, 0);
    const interval = window.setInterval(() => {
      void loadWorkerJobEvents(currentWorkerJob);
    }, 4000);
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(interval);
    };
  }, [activeTab, currentWorkerJob, currentWorkerJobKey, isTerminalOnlyPage, loadWorkerJobEvents]);

  const toggleSessionSelection = useCallback((key: string) => {
    setSelectedSessionKeys((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }, []);

  const toggleVisibleSelection = useCallback(() => {
    setSelectedSessionKeys((current) => {
      const currentSet = new Set(current);
      const shouldSelect = !visibleSessionKeys.every((key) => currentSet.has(key));
      for (const key of visibleSessionKeys) {
        if (shouldSelect) currentSet.add(key);
        else currentSet.delete(key);
      }
      return [...currentSet];
    });
  }, [visibleSessionKeys]);

  const toggleGroupSelection = useCallback((keys: string[]) => {
    setSelectedSessionKeys((current) => {
      const currentSet = new Set(current);
      const shouldSelect = !keys.every((key) => currentSet.has(key));
      for (const key of keys) {
        if (shouldSelect) currentSet.add(key);
        else currentSet.delete(key);
      }
      return [...currentSet];
    });
  }, []);

  const openSessionFiles = useCallback((session: CodexSession) => {
    setMachineFilter(session.machineId);
    setSelectedSessionKey(sessionKey(session));
    const opened = window.open(
      filesPageUrl(session.id, session.machineId, session.agent),
      '_blank'
    );
    if (opened) opened.opener = null;
    opened?.focus();
    if (!opened) setActionMessage('浏览器阻止了新目录页面，请允许弹出窗口后重试');
  }, []);

  const copyResumeCommand = useCallback(async (session: CodexSession) => {
    const key = sessionKey(session);
    try {
      await navigator.clipboard.writeText(session.resumeCommand);
      setCopiedResumeKey(key);
      setActionMessage(`已复制恢复命令：${session.resumeCommand}`);
      window.setTimeout(() => {
        setCopiedResumeKey((current) => (current === key ? null : current));
      }, 1800);
    } catch {
      setActionMessage('复制失败：浏览器阻止访问剪贴板');
    }
  }, []);

  const loadHistory = useCallback(async (session: CodexSession, before: number | null = null) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: '60',
        machineId: session.machineId,
        agent: session.agent,
      });
      if (before !== null) params.set('before', String(before));
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/history?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as HistoryPayload;
      setHistoryLoadedSessionKey(sessionKey(session));
      setHistoryMessages((current) => (before === null ? payload.messages : [...payload.messages, ...current]));
      setHistoryBefore(payload.nextBefore);
      setHistoryHasMore(payload.hasMore);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadAllMessages = useCallback(async (session: CodexSession) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        full: '1',
        preserve: '1',
        machineId: session.machineId,
        agent: session.agent,
      });
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/messages?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as HistoryPayload;
      setHistoryLoadedSessionKey(sessionKey(session));
      setHistoryMessages(payload.messages);
      setHistoryBefore(null);
      setHistoryHasMore(false);
      setActionMessage(`已加载 ${payload.messages.length}/${payload.totalMessages ?? payload.messages.length} 条会话消息`);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setHistoryMessages([]);
      setHistoryBefore(null);
      setHistoryHasMore(false);
      setHistoryLoadedSessionKey(null);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [activeTab, selectedIdentityKey]);

  useEffect(() => {
    if (isTerminalOnlyPage || activeTab === 'recycle' || !selectedSummary?.id) {
      const resetHandle = window.setTimeout(() => {
        setRecentUserMessages({ sessionKey: null, messages: [], loading: false, error: false });
      }, 0);
      return () => window.clearTimeout(resetHandle);
    }

    const sessionId = selectedSummary.id;
    const selectedKey = sessionKey(selectedSummary);
    const cacheKey = [
      selectedKey,
      selectedSummary.updatedAt ?? '',
      selectedSummary.messageCount,
    ].join('|||');
    const params = new URLSearchParams({
      limit: '4',
      machineId: selectedSummary.machineId,
      agent: selectedSummary.agent,
    });
    let cancelled = false;
    const cached = recentUserMessageCache.get(cacheKey);
    const loadingHandle = window.setTimeout(() => {
      if (cancelled) return;
      if (cached) {
        setRecentUserMessages({
          sessionKey: selectedKey,
          messages: [...cached.messages].reverse(),
          loading: false,
          error: false,
        });
      } else {
        setRecentUserMessages({ sessionKey: selectedKey, messages: [], loading: true, error: false });
      }
    }, 0);

    let request = recentUserMessageRequests.get(cacheKey);
    if (!request) {
      request = fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/recent-user-messages?${params.toString()}`,
      )
      .then((payload) => {
        if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
        return payload.json() as Promise<RecentUserMessagesPayload>;
      })
      .then((payload) => {
        recentUserMessageCache.set(cacheKey, payload);
        while (recentUserMessageCache.size > 64) {
          const oldestKey = recentUserMessageCache.keys().next().value;
          if (typeof oldestKey !== 'string') break;
          recentUserMessageCache.delete(oldestKey);
        }
        return payload;
      })
      .finally(() => {
        recentUserMessageRequests.delete(cacheKey);
      });
      recentUserMessageRequests.set(cacheKey, request);
    }

    void request
      .then((payload) => {
        if (cancelled) return;
        window.clearTimeout(loadingHandle);
        const messages = [...payload.messages].reverse();
        setRecentUserMessages({ sessionKey: selectedKey, messages, loading: false, error: false });
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(loadingHandle);
        setRecentUserMessages({ sessionKey: selectedKey, messages: [], loading: false, error: true });
      });

    return () => {
      cancelled = true;
      window.clearTimeout(loadingHandle);
    };
  }, [activeTab, isTerminalOnlyPage, selectedSummary]);

  useEffect(() => {
    if (!selectedSummary || activeTab === 'recycle') return;
    const detailKey = sessionKey(selectedSummary);
    if (sessionDetails[detailKey]) return;
    let cancelled = false;
    const params = new URLSearchParams({
      machineId: selectedSummary.machineId,
      agent: selectedSummary.agent,
    });
    void fetch(`/api/sessions/${encodeURIComponent(selectedSummary.id)}?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((session) => {
        const normalized = normalizeSession(session);
        if (sessionKey(normalized) !== detailKey) {
          throw new Error('Session detail identity mismatch');
        }
        if (!cancelled) setSessionDetails((current) => ({ ...current, [detailKey]: normalized }));
      })
      .catch(() => {
        // Detail loading is opportunistic; the summary row remains usable.
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedSummary, sessionDetails]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!SHOW_ADVANCED_UI || !selected || activeTab === 'recycle') {
        setSessionAuditEvents([]);
        return;
      }
      void loadSessionAudit(selected);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [activeTab, loadSessionAudit, selected]);

  const stats = useMemo(() => {
    const source = aiSearchResult
      ? visibleSessions
      : allSessions.filter(
          (session) =>
            (machineFilter === 'all' || session.machineId === machineFilter) &&
            (agentFilter === 'all' || session.agent === agentFilter) &&
            matchesSearch(session, query)
        );
    return source.reduce(
      (acc, session) => {
        acc[session.evaluation.recommendation] += 1;
        if (session.kept) acc.kept += 1;
        if (session.activityStatus === 'active') acc.active += 1;
        return acc;
      },
      { keep: 0, review: 0, delete: 0, kept: 0, active: 0 } as Record<Recommendation, number> & {
        kept: number;
        active: number;
      }
      );
  }, [agentFilter, aiSearchResult, allSessions, machineFilter, query, visibleSessions]);

  async function setKept(session: CodexSession, kept: boolean) {
    const actionKey = sessionKey(session);
    setBusyId(actionKey);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/keep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kept,
          machineId: session.machineId,
          agent: session.agent,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targetKey = sessionKey(session);
      setAllSessions((current) => current.map((item) => (sessionKey(item) === targetKey ? { ...item, kept } : item)));
      setSessionDetails((current) => {
        const detailKey = sessionKey(session);
        const detail = current[detailKey];
        return detail ? { ...current, [detailKey]: { ...detail, kept } } : current;
      });
    } finally {
      setBusyId(null);
    }
  }

  async function refreshEvaluation(session: CodexSession) {
    const actionKey = `${sessionKey(session)}:refresh`;
    setBusyId(actionKey);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/evaluations/${encodeURIComponent(session.id)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: session.machineId,
          agent: session.agent,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { job?: { id?: string }; error?: string };
      if (!response.ok || !payload.job?.id) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`AI 重算已排队：${session.machineId}/${session.id}`);
      let completed = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const statusResponse = await fetch(`/api/evaluations/refresh-jobs/${encodeURIComponent(payload.job.id)}`);
        const statusPayload = (await statusResponse.json().catch(() => ({}))) as {
          job?: { status?: string; error?: string | null };
        };
        if (!statusResponse.ok) throw new Error(`重算状态 HTTP ${statusResponse.status}`);
        if (statusPayload.job?.status === 'completed') {
          setActionMessage(`AI 重算完成：${session.machineId}/${session.id}`);
          completed = true;
          break;
        }
        if (statusPayload.job?.status === 'failed') {
          throw new Error(statusPayload.job.error || 'AI 重算失败');
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      if (!completed) throw new Error('AI 重算等待超时');
      setSessionDetails((current) => {
        const next = { ...current };
        delete next[sessionKey(session)];
        return next;
      });
      await Promise.all([loadSessions(), loadFleetAudit(true), loadSessionAudit(session)]);
    } catch (err) {
      setActionMessage(`AI 重算失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  function removeSessionsFromPanel(keys: string[]) {
    const removedKeys = new Set(keys);
    if (!removedKeys.size) return;
    setAllSessions((current) => current.filter((item) => !removedKeys.has(sessionKey(item))));
    setSessionDetails((current) => {
      const next = { ...current };
      for (const key of removedKeys) delete next[key];
      return next;
    });
    setSelectedSessionKeys((current) => current.filter((key) => !removedKeys.has(key)));
    setSelectedSessionKey((current) => current && removedKeys.has(current) ? null : current);
  }

  async function deleteSession(session: CodexSession) {
    if (!window.confirm(`只删除当前机器 ${session.machineId} 上的会话：${session.id}？会先移入回收站，原 Codex / Claude 活跃目录会被清除。`)) return;
    const actionKey = sessionKey(session);
    setBusyId(actionKey);
    setActionMessage(null);
    try {
      const params = new URLSearchParams({
        machineId: session.machineId,
        agent: session.agent,
      });
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}?${params.toString()}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          machineId: session.machineId,
          agent: session.agent,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      removeSessionsFromPanel([sessionKey(session)]);
      setActionMessage(`已将 ${session.machineId} 上的 ${agentLabel(session.agent)} 会话移入回收站`);
      void loadSessions();
    } catch (err) {
      setActionMessage(`删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSelectedSessions() {
    const selectedSessions = allSessions.filter((session) => selectedKeySet.has(sessionKey(session)));
    if (!selectedSessions.length) return;
    if (!window.confirm(`将已选中的 ${selectedSessions.length} 个会话移入回收站？原位置会被清除。`)) return;
    setBusyId('bulk-delete');
    setActionMessage(null);
    try {
      const response = await fetch('/api/sessions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          sessions: selectedSessions.map((session) => ({
            id: session.id,
            machineId: session.machineId,
            agent: session.agent,
          })),
        }),
      });
      const payload = (await response.json()) as {
        deleted?: number;
        failed?: number;
        error?: string;
        results?: Array<{
          id: string;
          machineId?: string;
          agent?: AgentKind;
          ok: boolean;
        }>;
      };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const deletedRoutes = new Set(
        (payload.results ?? [])
          .filter((item) => item.ok)
          .flatMap((item) => {
            if (item.agent) {
              return [`${item.machineId ?? 'unknown'}|||${item.agent}|||${item.id}`];
            }
            const compatibleMatches = selectedSessions.filter(
              (session) =>
                session.machineId === (item.machineId ?? 'unknown') &&
                session.id === item.id
            );
            return compatibleMatches.length === 1
              ? [sessionKey(compatibleMatches[0])]
              : [];
          })
      );
      const deletedKeys = selectedSessions
        .filter((session) => deletedRoutes.has(sessionKey(session)))
        .map(sessionKey);
      removeSessionsFromPanel(deletedKeys);
      setActionMessage(`已移入回收站 ${payload.deleted ?? 0} 个会话，失败 ${payload.failed ?? 0} 个`);
      setSelectedSessionKeys([]);
      void loadSessions();
    } catch (err) {
      setActionMessage(`批量删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function pruneRecommended() {
    if (!window.confirm('将本机及已连接 worker 上所有未手动保留、且被建议删除的 Codex / Claude 会话移入回收站？原位置会被清除。')) return;
    setBusyId('prune');
    setActionMessage(null);
    try {
      const sessions = allSessions
        .filter(
          (session) =>
            !session.kept &&
            session.evaluation.recommendation === 'delete'
        )
        .map((session) => ({
          id: session.id,
          machineId: session.machineId,
          agent: session.agent,
        }));
      const response = await fetch('/api/sessions/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          ...(sessions.length ? { sessions } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { deleted?: number; failed?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`建议删除清理完成：已移入回收站 ${payload.deleted ?? 0} 个，失败 ${payload.failed ?? 0} 个`);
      await loadSessions();
    } catch (err) {
      setActionMessage(`建议删除清理失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function pruneNonKept() {
    if (!window.confirm('将本机及已连接 worker 上所有未进入保留面板的 Codex / Claude 会话移入回收站？原位置会被清除。')) return;
    setBusyId('prune-non-kept');
    setActionMessage(null);
    try {
      const sessions = allSessions
        .filter((session) => !session.kept)
        .map((session) => ({
          id: session.id,
          machineId: session.machineId,
          agent: session.agent,
        }));
      const response = await fetch('/api/sessions/prune-non-kept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          ...(sessions.length ? { sessions } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { deleted?: number; failed?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`非保留清理完成：已移入回收站 ${payload.deleted ?? 0} 个，失败 ${payload.failed ?? 0} 个`);
      await loadSessions();
    } catch (err) {
      setActionMessage(`非保留清理失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function saveTitle(session: CodexSession) {
    setBusyId(`${sessionKey(session)}:title`);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titleDraft,
          machineId: session.machineId,
          agent: session.agent,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } finally {
      setBusyId(null);
    }
  }

  async function migrateSession(session: CodexSession) {
    if (session.agent !== 'codex') {
      setActionMessage('Claude 会话暂不支持跨目录迁移；请在原 cwd 使用 Claude 恢复命令继续。');
      return;
    }
    if (!migrationTarget.trim()) return;
    setBusyId(`${sessionKey(session)}:migrate`);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetProjectDir: migrationTarget.trim(),
          machineId: session.machineId,
          agent: session.agent,
        }),
      });
      const payload = (await response.json()) as {
        resumeCommand?: string;
        newSessionId?: string;
        alreadyInTarget?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(
        payload.alreadyInTarget
          ? `当前会话已经绑定到这个目录，无需迁移：${payload.resumeCommand ?? session.resumeCommand}`
          : `已创建项目目录副本：${payload.resumeCommand ?? payload.newSessionId}`
      );
      await loadSessions();
    } catch (err) {
      setActionMessage(`迁移失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function migrateSelectedSameDirectory(session: CodexSession) {
    const target = migrationTarget.trim();
    if (!target || !selectedSessionKeys.length) return;
    const sameDirectorySelections = allSessions
      .filter((item) => selectedKeySet.has(sessionKey(item)) && item.machineId === session.machineId && normalizePath(item.cwd) === normalizePath(session.cwd));
    const targetRoutes = sameDirectorySelections
      .filter((item) => item.agent === 'codex')
      .map((item) => ({
        id: item.id,
        machineId: item.machineId,
        agent: item.agent,
      }));
    const skippedClaude = sameDirectorySelections.length - targetRoutes.length;
    if (!targetRoutes.length) {
      setActionMessage(
        skippedClaude
          ? '未执行迁移：当前目录已选会话均为 Claude；Claude 暂不支持跨目录迁移。'
          : '未找到可迁移的已选 Codex 会话。'
      );
      return;
    }
    const skipNote = skippedClaude ? `（将跳过 ${skippedClaude} 个 Claude 会话）` : '';
    if (!window.confirm(`将当前目录下已选中的 ${targetRoutes.length} 个 Codex 会话批量迁移到：${target}？${skipNote}`)) return;
    setBusyId('bulk-migrate');
    let ok = 0;
    let failed = 0;
    for (const route of targetRoutes) {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(route.id)}/migrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetProjectDir: target,
            machineId: route.machineId,
            agent: route.agent,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setActionMessage(
      `批量迁移完成：成功 ${ok} 个，失败 ${failed} 个${skippedClaude ? `，已跳过 Claude ${skippedClaude} 个` : ''}`
    );
    setBusyId(null);
    await loadSessions();
  }

  async function restoreArchive(archive: RecycleArchive) {
    if (!window.confirm(`恢复 ${archive.machineId} 回收站归档 ${archive.archiveDir} 中的会话 ${archive.sessionId} 到原 Codex / Claude 目录？`)) return;
    const actionId = `${archive.machineId}:${archive.archiveDir}:restore`;
    setBusyId(actionId);
    setActionMessage(null);
    try {
      const params = new URLSearchParams({
        machineId: archive.machineId,
        archiveDir: archive.archiveDir,
      });
      if (archive.agent) params.set('agent', archive.agent);
      const response = await fetch(`/api/recycle-bin/${encodeURIComponent(archive.sessionId)}/restore?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`已恢复 ${archive.machineId} 上的回收站会话 ${archive.sessionId}`);
      await loadSessions();
    } catch (err) {
      setActionMessage(`恢复失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function purgeArchive(archive: RecycleArchive) {
    if (!window.confirm(`立即永久删除 ${archive.machineId} 上的回收站归档 ${archive.archiveDir}（会话 ${archive.sessionId}）？这个操作不可恢复。`)) return;
    const actionId = `${archive.machineId}:${archive.archiveDir}:purge`;
    setBusyId(actionId);
    setActionMessage(null);
    try {
      const params = new URLSearchParams({
        machineId: archive.machineId,
        archiveDir: archive.archiveDir,
      });
      if (archive.agent) params.set('agent', archive.agent);
      const response = await fetch(`/api/recycle-bin/${encodeURIComponent(archive.sessionId)}?${params.toString()}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setActionMessage(`已永久删除 ${archive.machineId} 上的回收站归档 ${archive.sessionId}`);
      await loadSessions();
    } catch (err) {
      setActionMessage(`永久删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusyId(null);
    }
  }

  if (authRequired) {
    return <LoginPanel busy={authBusy} message={authMessage} onLogin={login} />;
  }

  if (isFilesOnlyPage && filesOnlySessionId) {
    return (
      <main className="terminal-page-shell">
        <section className="terminal-page-workspace">
          <header className="terminal-page-heading">
            <div>
              <p className="eyebrow">Session Files</p>
              <h1>{filesOnlySession?.title || '会话工作目录'}</h1>
              <span>
                {filesOnlyMachineId ?? '未知机器'} ·{' '}
                {filesOnlyAgent ? agentLabel(filesOnlyAgent) : '未知 Agent'} ·{' '}
                {filesOnlySession?.cwd ?? filesOnlySessionId}
                {filesOnlyLoading ? ' · 正在加载会话详情' : ''}
              </span>
            </div>
            <div className="terminal-page-actions">
              <button type="button" className="primary-button" onClick={() => window.location.assign('/')}>
                返回面板
              </button>
            </div>
          </header>
          <div className={`terminal-page-inline-notice${filesOnlyError ? '' : ' terminal-page-inline-notice-empty'}`}>
            {filesOnlyError ?? '\u00a0'}
          </div>
          {filesOnlyMachineId && filesOnlyAgent && filesOnlySession ? (
            <SessionFileBrowser
              sessionId={filesOnlySessionId}
              machineId={filesOnlyMachineId}
              agent={filesOnlyAgent}
              onUnauthorized={() => setAuthRequired(true)}
            />
          ) : !filesOnlyMachineId || !filesOnlyAgent ? (
            <div className="terminal-page-message">文件页缺少机器或 Agent 标识</div>
          ) : (
            <div className="terminal-page-message">
              {filesOnlyLoading ? '正在验证文件页会话身份...' : '未能验证文件页会话身份'}
            </div>
          )}
        </section>
      </main>
    );
  }

  if (isTerminalOnlyPage) {
    const terminalTitle = terminalOnlySession?.title || terminalOnlySessionId || 'SSH 终端';
    const terminalMeta = terminalOnlySession
      ? `${terminalOnlySession.machineId} · ${agentLabel(terminalOnlySession.agent)} · ${terminalOnlySession.cwd ?? 'unknown cwd'}`
      : [
          terminalOnlyMachineId,
          terminalOnlyAgent ? agentLabel(terminalOnlyAgent) : null,
          terminalOnlySessionId,
        ].filter(Boolean).join(' · ');
    return (
      <main className="terminal-page-shell">
        <section className="terminal-page-workspace">
          <header className="terminal-page-heading">
            <div>
              <p className="eyebrow">SSH Terminal</p>
              <h1>{terminalTitle}</h1>
              {terminalMeta ? <span>{terminalMeta}{terminalOnlyLoading ? ' · 正在补充会话详情' : ''}</span> : null}
            </div>
            <div className="terminal-page-actions">
              <button type="button" className="primary-button" onClick={() => window.location.assign('/')}>
                返回面板
              </button>
            </div>
          </header>

          <div className={`terminal-page-inline-notice${terminalOnlyError ? '' : ' terminal-page-inline-notice-empty'}`}>
            {terminalOnlyError ?? '\u00a0'}
          </div>
          {terminalOnlySession ? (
            <TerminalConsole
              session={terminalOnlySession}
              active
              onClose={() => {
                window.close();
                window.setTimeout(() => window.location.assign('/'), 120);
              }}
            />
          ) : (
            <div className="terminal-page-message">{terminalOnlyLoading ? '正在加载终端会话...' : '未找到终端会话'}</div>
          )}
        </section>
      </main>
    );
  }

    return (
      <main className="shell">
        <aside className="rail">
          <div className="brand">
            <div className="brand-mark">
              <KeyRound size={22} />
            </div>
            <div>
              <h1>Curator</h1>
              <p>会话</p>
            </div>
          </div>

          <div className="search-box">
            <Search size={18} />
          <input
            data-session-filter
            value={query}
            onChange={(event) => {
                setQuery(event.target.value);
                if (aiSearchResult) setAiSearchResult(null);
              }}
              placeholder="搜索会话"
            />
          </div>

          <form className="ai-search-box" data-ai-session-search onSubmit={(event) => void runAiSessionSearch(event)}>
            <label htmlFor="ai-session-search-input">
              <Sparkles size={16} />
              <span>智能搜索</span>
            </label>
            <div className="ai-search-control">
              <input
                id="ai-session-search-input"
                value={aiSearchQuery}
                onChange={(event) => setAiSearchQuery(event.target.value)}
                placeholder="描述你记得的内容"
              />
              <button type="submit" disabled={aiSearchLoading || aiSearchQuery.trim().length < 2}>
                {aiSearchLoading ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
                {aiSearchLoading ? '搜索中' : '搜索'}
              </button>
            </div>
          {aiSearchResult || aiSearchError ? (
            <div
              className={`ai-search-status ${aiSearchResult?.mode === 'fallback-local' || aiSearchError ? 'fallback' : ''}`}
              data-ai-search-mode={aiSearchResult?.mode ?? 'error'}
            >
              <span>
                {aiSearchError
                  ? `检索失败：${aiSearchError}`
                  : aiSearchResult?.mode === 'deepseek'
                    ? `理解为“${aiSearchResult.intent}” · 机器 ${aiSearchResult.routing.machineIds.join('、') || '全部'} · ${aiSearchResult.count} 条 · ${aiSearchResult.latencyMs}ms`
                    : aiSearchResult?.routing.mode === 'deepseek'
                      ? `DeepSeek 已判断机器 ${aiSearchResult.routing.machineIds.join('、') || '全部'}；会话重排超时，增强索引返回 ${aiSearchResult.count} 条 · ${aiSearchResult.latencyMs}ms`
                      : `DeepSeek 暂不可用，增强本地索引返回 ${aiSearchResult?.count ?? 0} 条 · ${aiSearchResult?.latencyMs ?? 0}ms`}
              </span>
              <button
                type="button"
                className="ai-search-clear"
                aria-label="清除 AI 检索结果"
                title="返回普通会话列表"
                onClick={() => {
                  setAiSearchResult(null);
                  setAiSearchError(null);
                }}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}
        </form>

          <details
            className="machine-picker"
            onToggle={(event) => {
              if (event.currentTarget.open) void refreshRemoteStatuses();
            }}
          >
            <summary>
              <Server size={16} />
              <span>{machineFilter === 'all' ? '全部机器' : machineFilter}</span>
              <ChevronDown size={15} />
            </summary>
            <div className="machine-options">
              {machineOptions.map((machine) => {
                const remote = remoteStatuses.find((agent) => agent.machineId === machine);
                const isLocal = machine !== 'all' && !meta?.remoteAgents?.some((agent) => agent.id === machine);
                const statusTone = isLocal ? 'online' : remote ? (remote.online ? 'online' : 'offline') : 'unknown';
                return (
                  <button
                    key={machine}
                    type="button"
                    className={machineFilter === machine ? 'active' : ''}
                    onClick={(event) => {
                      setMachineFilter(machine);
                      event.currentTarget.closest('details')?.removeAttribute('open');
                    }}
                  >
                    {machine === 'all' ? (
                      <Server size={14} />
                    ) : (
                      <span className={`remote-dot ${statusTone}`} />
                    )}
                    <strong>{machine === 'all' ? '全部机器' : machine}</strong>
                    {machine === 'all' ? null : (
                      <em>
                        {isLocal
                          ? '本机'
                          : remote
                          ? remote.online
                            ? remote.latencyMs === null
                              ? '在线'
                              : `${remote.latencyMs}ms`
                            : '离线'
                          : '状态未知'}
                      </em>
                    )}
                  </button>
                );
              })}
            </div>
          </details>

        {activeTab !== 'recycle' ? (
          <div className="agent-switch" role="group" aria-label="会话代理筛选">
            <button
              type="button"
              data-agent-filter="all"
              className={agentFilter === 'all' ? 'active' : ''}
              aria-pressed={agentFilter === 'all'}
              onClick={() => setAgentFilter('all')}
            >
              <FolderOpen size={15} />
              <span>全部</span>
              <em>{agentFilterCounts.all}</em>
            </button>
            <button
              type="button"
              data-agent-filter="codex"
              className={agentFilter === 'codex' ? 'active' : ''}
              aria-pressed={agentFilter === 'codex'}
              onClick={() => setAgentFilter('codex')}
            >
              <TerminalIcon size={15} />
              <span>Codex</span>
              <em>{agentFilterCounts.codex}</em>
            </button>
            <button
              type="button"
              data-agent-filter="claude"
              className={agentFilter === 'claude' ? 'active' : ''}
              aria-pressed={agentFilter === 'claude'}
              onClick={() => setAgentFilter('claude')}
            >
              <Sparkles size={15} />
              <span>Claude</span>
              <em>{agentFilterCounts.claude}</em>
            </button>
          </div>
        ) : null}

        <div className="view-switch" role="group" aria-label="列表显示方式">
          <button
            type="button"
            className={listViewMode === 'folder' ? 'active' : ''}
            onClick={() => setListViewMode('folder')}
          >
            <FolderOpen size={15} />
            按文件夹
          </button>
          <button
            type="button"
            className={listViewMode === 'activityDate' ? 'active' : ''}
            onClick={() => setListViewMode('activityDate')}
          >
            <Clock3 size={15} />
            按活跃日期
          </button>
        </div>

          <div className="tabs" role="tablist" aria-label="session filters">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? 'active' : ''}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.id === 'all' ? <Clock3 size={14} /> : tab.id === 'kept' ? <ShieldCheck size={14} /> : <Trash2 size={14} />}
                {tab.label}
              </button>
            ))}
          </div>

          {SHOW_ADVANCED_UI ? (
            <>
              <div className="summary-strip">
                {metricLabel(activeTab === 'recycle' ? visibleRecycleArchives.length : visibleSessions.length, '当前列表')}
                {metricLabel(stats.kept, '手动保留')}
                {metricLabel(stats.active, '三天活跃')}
                {metricLabel(stats.delete, '删除')}
              </div>
              <button
                type="button"
                className={`audit-summary${
                  fleetAudit && (fleetAudit.summary.missingFromPanel || fleetAudit.summary.localIssues || fleetAudit.summary.remoteIssues || fleetAudit.summary.unhealthyRemotes)
                    ? ' has-issues'
                    : fleetAudit?.summary.pendingEvaluationSessions
                      ? ' has-pending'
                      : ''
                }`}
                disabled={fleetAuditLoading}
                onClick={() => void loadFleetAudit(true)}
              >
                {fleetAuditLoading ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
                <span>{fleetAuditError ?? '会话链路审计'}</span>
              </button>
            </>
          ) : null}

          {SHOW_ADVANCED_UI && activeTab !== 'recycle' ? (
            <div className="bulk-toolbar">
              <button type="button" className="primary-button" disabled={!visibleSessionKeys.length} onClick={toggleVisibleSelection}>
                {allVisibleSelected ? '取消当前列表' : '选择当前列表'}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={!selectedSessionKeys.length || busyId === 'bulk-delete'}
              onClick={() => void deleteSelectedSessions()}
            >
              删除已选 {selectedSessionKeys.length}
            </button>
          </div>
        ) : null}

        <div className="session-list" aria-busy={loading}>
          {loading ? (
            <div className="empty">
              <Loader2 className="spin" size={22} />
              扫描并评估本机 Codex / Claude 会话
            </div>
          ) : null}
          {!loading && activeTab !== 'recycle' && visibleSessions.length === 0 ? (
            <div className="empty">{aiSearchResult ? 'AI 没有找到可信的候选会话，请换一种描述' : '没有匹配的会话'}</div>
          ) : null}
          {!loading && activeTab === 'recycle' ? (
            <div className="recycle-search">
              <Search size={16} />
              <input value={recycleQuery} onChange={(event) => setRecycleQuery(event.target.value)} placeholder="搜索回收站 session / 路径" />
            </div>
          ) : null}
          {!loading && activeTab === 'recycle' && visibleRecycleArchives.length === 0 ? <div className="empty">回收站为空</div> : null}
            {activeTab === 'recycle'
              ? visibleRecycleArchives.map((archive) => (
                <div key={`${archive.machineId}:${archive.archiveDir}`} className="archive-row">
                  <span className="session-key">{archive.sessionId}</span>
                  <span className="session-summary">
                    {archive.machineId} · {archive.agent ? agentLabel(archive.agent) : '未知来源'} · 删除：{formatDate(archive.deletedAt)} · 过期：{formatDate(archive.expiresAt)}
                  </span>
                  <span className="session-summary">{archive.archiveDir}</span>
                  <span className="archive-actions">
                    <button type="button" className="primary-button" disabled={busyId === `${archive.machineId}:${archive.archiveDir}:restore`} onClick={() => void restoreArchive(archive)}>
                      恢复
                    </button>
                    <button type="button" className="danger-button" disabled={busyId === `${archive.machineId}:${archive.archiveDir}:purge`} onClick={() => void purgeArchive(archive)}>
                      永久删除
                    </button>
                  </span>
                </div>
                ))
              : groupedSessions.map((group) => {
                  const collapsed = aiSearchResult || query.trim() ? false : collapsedGroups[group.key] ?? false;
                  const groupKeys = group.sessions.map(sessionKey);
                  const selectedInGroup = groupKeys.filter((key) => selectedKeySet.has(key)).length;
                  const groupChecked = selectedInGroup === groupKeys.length && groupKeys.length > 0;
                return (
                  <div key={group.key} className="session-group">
                    <div
                      className="group-header"
                      onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !collapsed }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setCollapsedGroups((current) => ({ ...current, [group.key]: !collapsed }));
                        }
                      }}
                        role="button"
                        tabIndex={0}
                      >
                        {SHOW_ADVANCED_UI ? (
                          <input
                            type="checkbox"
                            className="session-checkbox"
                            checked={groupChecked}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleGroupSelection(groupKeys)}
                            aria-label={`选择分组 ${group.title}`}
                            title={selectedInGroup ? `已选择 ${selectedInGroup}/${groupKeys.length}` : '选择这个分组'}
                          />
                        ) : null}
                        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                      <span>{group.label}</span>
                      <strong>{group.title}</strong>
                      <em>{group.sessions.length}</em>
                    </div>
                    {collapsed
                      ? null
                      : group.sessions.map((session) => {
                          const aiMatch = aiSearchMatchByKey.get(sessionKey(session));
                          return (
                            <div
                              key={sessionKey(session)}
                              data-session-id={session.id}
                              data-machine-id={session.machineId}
                              data-agent={session.agent}
                              className={`session-row ${selectedSessionKey === sessionKey(session) ? 'selected' : ''}`}
                              onClick={() => setSelectedSessionKey(sessionKey(session))}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  setSelectedSessionKey(sessionKey(session));
                                }
                              }}
                                role="button"
                                tabIndex={0}
                              >
                                {SHOW_ADVANCED_UI ? (
                                  <input
                                    type="checkbox"
                                    className="session-checkbox"
                                    checked={selectedKeySet.has(sessionKey(session))}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={() => toggleSessionSelection(sessionKey(session))}
                                    aria-label={`选择 ${session.title}`}
                                  />
                                ) : null}
                                <span className="session-main">
                                  <span className="session-key">{session.title}</span>
                                  <span className="session-summary">{session.evaluation.summary}</span>
                                {aiMatch ? (
                                  <span className="ai-match-reason" data-ai-search-result>
                                    <Sparkles size={13} />
                                    <strong>{Math.round(aiMatch.confidence * 100)}%</strong>
                                    <span>{aiMatch.reason}</span>
                                  </span>
                                ) : null}
                                  {SHOW_ADVANCED_UI ? (
                                    <>
                                      <span className="session-preview-line">
                                        <strong>用户</strong>
                                        <span>{previewText(session.lastUserMessage)}</span>
                                      </span>
                                      <span className="session-preview-line agent">
                                        <strong>Agent</strong>
                                        <span>{previewText(session.lastAssistantMessage)}</span>
                                      </span>
                                    </>
                                  ) : null}
                                </span>
                              <span className="session-time">
                                {agentLabel(session.agent)} · {session.kept ? '已保留 · ' : ''}
                                {session.activityStatus === 'active' ? '活跃' : '非活跃'} · {formatDate(session.updatedAt)}
                              </span>
                            </div>
                          );
                        })}
                  </div>
                );
              })}
        </div>
      </aside>

        <section className="detail">
          <header className="topbar">
            <div className="topbar-title">
              <p className="eyebrow">
                {selected ? `${selected.machineId} · ${agentLabel(selected.agent)}` : '会话详情'}
              </p>
              <h2>{selected ? selected.title : '未选择会话'}</h2>
            </div>
            <div className="topbar-actions">
              {SHOW_ADVANCED_UI && selected ? (
                <>
                  <button type="button" className="primary-button" title="打开这个会话的 cwd 文件目录" onClick={() => openSessionFiles(selected)}>
                    <FolderOpen size={17} />
                    打开工作目录
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busyId === `${sessionKey(selected)}:refresh`}
                    title="在 Hub 上读取完整 transcript 并执行可追踪的 AI 重算"
                    onClick={() => void refreshEvaluation(selected)}
                  >
                    <Sparkles size={17} />
                    {busyId === `${sessionKey(selected)}:refresh` ? 'AI 重算中' : 'AI 重算'}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="icon-button"
                aria-label="刷新"
                title="刷新"
                onClick={() => {
                  if (SHOW_ADVANCED_UI) {
                    void Promise.all([loadSessions(true), loadCommanderActions(), loadFleetAudit(true)]);
                  } else {
                    void loadSessions(true);
                  }
                }}
              >
                <RefreshCw size={18} />
              </button>
              {SHOW_ADVANCED_UI ? (
                <>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busyId === 'prune'}
                    onClick={() => void pruneRecommended()}
                  >
                    <Trash2 size={17} />
                    清理建议删除
                  </button>
                  <button
                    type="button"
                    className="danger-button strong-danger"
                    disabled={busyId === 'prune-non-kept'}
                    onClick={() => void pruneNonKept()}
                  >
                    <Archive size={17} />
                    清理非保留
                  </button>
                </>
              ) : null}
              <button type="button" className="icon-button" aria-label="退出登录" title="退出登录" onClick={() => void logout()}>
                <LogOut size={18} />
              </button>
            </div>
          </header>

          {error ? <div className="notice danger">加载失败：{error}</div> : null}

        {activeTab === 'recycle' ? (
          <div className="detail-grid">
            <section className="primary-panel">
              <h3>回收站会话记录</h3>
              <p className="long-summary">
                回收站汇总本机与 worker 的归档元数据和路径；原始会话已从 Codex / Claude 活跃目录清除，归档文件会在过期时间后自动删除。
              </p>
              <div className="archive-detail-list">
                {visibleRecycleArchives.map((archive) => (
                  <div className="archive-detail" key={`${archive.machineId}:${archive.archiveDir}`}>
                    <strong>{archive.sessionId}</strong>
                    <span>机器：{archive.machineId} · 来源：{archive.agent ? agentLabel(archive.agent) : '未知'}</span>
                    <span>删除时间：{formatDate(archive.deletedAt)}</span>
                    <span>自动清理：{formatDate(archive.expiresAt)}</span>
                    <code>{archive.archiveDir}</code>
                    <div className="archive-actions">
                      <button type="button" className="primary-button" disabled={busyId === `${archive.machineId}:${archive.archiveDir}:restore`} onClick={() => void restoreArchive(archive)}>
                        恢复
                      </button>
                      <button type="button" className="danger-button" disabled={busyId === `${archive.machineId}:${archive.archiveDir}:purge`} onClick={() => void purgeArchive(archive)}>
                        立即永久删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
          ) : selected ? (
            <div className="detail-grid">
              <section className="primary-panel focus-card session-overview">
                <div className="status-line session-meta-line">
                  <span className="status-pill agent-pill">
                    {selected.agent === 'codex' ? <TerminalIcon size={14} /> : <Sparkles size={14} />}
                    {agentLabel(selected.agent)}
                  </span>
                  <span className="score">score {selected.evaluation.score}</span>
                  <span className={`activity ${selected.activityStatus}`}>
                    {selected.activityStatus === 'active' ? '最近活跃' : `非活跃 ${selected.inactiveDays ?? '?'} 天`}
                  </span>
                  <span className={`activity cadence-${selected.evaluation.updateCadence ?? 'quiet'}`}>
                    {cadenceLabel[selected.evaluation.updateCadence ?? 'quiet']}
                </span>
                <span className={`activity priority-${selected.evaluation.reviewPriority ?? 'normal'}`}>
                  {priorityLabel[selected.evaluation.reviewPriority ?? 'normal']}
                </span>
                {selected.kept ? <span className="kept">手动保留</span> : null}
              </div>

              <p className="detail-summary">{selected.evaluation.summary}</p>

              <div className="title-editor">
                <label htmlFor="session-title">保留标题</label>
                <div>
                  <input
                    id="session-title"
                    value={titleDraft}
                    onChange={(event) =>
                      setTitleDrafts((current) => ({ ...current, [sessionKey(selected)]: event.target.value }))
                    }
                    placeholder="给这个会话起一个标题"
                  />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busyId === `${sessionKey(selected)}:title`}
                    onClick={() => void saveTitle(selected)}
                  >
                    保存标题
                  </button>
                </div>
              </div>

              <div className="key-block">
                <TerminalIcon size={18} />
                <code>{selected.resumeCommand}</code>
                <button
                  type="button"
                  className="icon-button"
                  title={copiedResumeKey === sessionKey(selected) ? '已复制' : '复制恢复命令'}
                  onClick={() => void copyResumeCommand(selected)}
                >
                  <Copy size={17} />
                </button>
                {copiedResumeKey === sessionKey(selected) ? <span className="copy-feedback">已复制</span> : null}
              </div>

              <div className="action-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyId === sessionKey(selected)}
                  onClick={() => void setKept(selected, !selected.kept)}
                >
                  <ShieldCheck size={17} />
                  {selected.kept ? '取消保留' : '保留到面板'}
                </button>
                  <button
                    type="button"
                    className="danger-button"
                  disabled={busyId === sessionKey(selected)}
                  onClick={() => void deleteSession(selected)}
                >
                    <Trash2 size={17} />
                    移入回收站
                  </button>
                  <button type="button" className="primary-button" title="打开这个会话的 cwd 文件目录" onClick={() => openSessionFiles(selected)}>
                    <FolderOpen size={17} />
                    打开工作目录
                  </button>
                </div>
                {actionMessage ? <div className="notice inline-info action-notice">{actionMessage}</div> : null}
              </section>

              {SHOW_ADVANCED_UI ? (
                <section className="primary-panel">
                  <h3>整段会话做了什么</h3>
                  <p className="long-summary">{selected.evaluation.detailedSummary || selected.evaluation.summary}</p>
                </section>
              ) : null}

              <section className="primary-panel focus-card recent-panel">
                <div className="panel-heading">
                  <h3>最近对话</h3>
              </div>
              <div
                className="recent-dialogue"
                data-session-id={selected.id}
                aria-busy={recentUserMessages.sessionKey !== sessionKey(selected) || recentUserMessages.loading}
              >
                {recentUserMessages.sessionKey === sessionKey(selected)
                  ? recentUserMessages.messages.map((message) => (
                      <RecentUserMessageCard
                        key={`${sessionKey(selected)}:${message.index}`}
                        sessionId={selected.id}
                        message={message}
                      />
                    ))
                  : null}
                {recentUserMessages.sessionKey !== sessionKey(selected) || recentUserMessages.loading ? (
                  <div className="empty compact">正在读取最近用户消息...</div>
                ) : null}
                {recentUserMessages.sessionKey === sessionKey(selected) && !recentUserMessages.loading && recentUserMessages.error ? (
                  <div className="empty compact">最近用户消息读取失败</div>
                ) : null}
                {recentUserMessages.sessionKey === sessionKey(selected) &&
                !recentUserMessages.loading &&
                !recentUserMessages.error &&
                !recentUserMessages.messages.length ? (
                    <div className="empty compact">暂无用户消息</div>
                  ) : null}
                </div>
                {SHOW_ADVANCED_UI ? (
                  <>
                    <div className="workflow">
                      <Sparkles size={16} />
                      摘要更新时间：{formatDate(selected.evaluation.evaluatedAt)}
                      {selected.evaluation.hermesLastUsedAt ? ` · 最近调度：${formatDate(selected.evaluation.hermesLastUsedAt)}` : ''}
                      {selected.evaluation.hermesRecalculatedAt ? ` · 重算完成：${formatDate(selected.evaluation.hermesRecalculatedAt)}` : ''}
                      {selected.evaluation.hermesLastJobId ? ` · job：${selected.evaluation.hermesLastJobId}` : ''}
                      {selected.evaluation.evaluationOrigin ? ` · 来源：${selected.evaluation.evaluationOrigin}` : ''}
                      {selected.evaluation.evaluatedByMachineId ? ` · 执行机器：${selected.evaluation.evaluatedByMachineId}` : ''}
                    </div>
                    {selected.evaluation.evaluationRunId || selected.evaluation.transcriptHash ? (
                      <div className="workflow audit-identifiers">
                        {selected.evaluation.evaluationRunId ? <code>run {selected.evaluation.evaluationRunId}</code> : null}
                        {selected.evaluation.transcriptHash ? <code>sha256 {selected.evaluation.transcriptHash.slice(0, 16)}…</code> : null}
                      </div>
                    ) : null}
                    {selected.evaluation.hermesRefreshError ? (
                      <div className="warning-line">
                        <AlertTriangle size={15} />
                        {selected.evaluation.hermesRefreshError}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>

              {SHOW_ADVANCED_UI ? (
                <>
              <section className="primary-panel">
              <div className="panel-heading">
                <div>
                  <h3>会话链路审计</h3>
                  <span>只记录计数、状态与哈希，不保存新的对话正文副本</span>
                </div>
                <button type="button" className="primary-button" onClick={() => void loadSessionAudit(selected)}>
                  <RefreshCw size={16} />
                  刷新审计
                </button>
              </div>
              {sessionAuditEvents.length ? (
                <div className="audit-event-list">
                  {sessionAuditEvents.slice(0, 12).map((event) => (
                    <div key={event.id} className={`audit-event ${event.error || event.status === 'failed' ? 'failed' : ''}`}>
                      <strong>{event.event}</strong>
                      <span>{formatDate(event.at)} · {event.machineId}{event.model ? ` · ${event.model}` : ''}{event.status ? ` · ${event.status}` : ''}</span>
                      {event.runId ? <code>run {event.runId}</code> : null}
                      {event.transcriptHash ? <code>sha256 {event.transcriptHash.slice(0, 16)}…</code> : null}
                      {event.error ? <em>{event.error}</em> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty compact">暂无审计事件；运行完整性巡检或 AI 重算后会写入。</div>
              )}
            </section>

            <section className="primary-panel knowledge-plane">
              <div className="panel-heading worker-heading">
                <div>
                  <h3>Knowledge Context Plane</h3>
                  <span>{contextPackSummary}</span>
                </div>
                <div className="worker-heading-actions">
                  <button type="button" className="primary-button" disabled={knowledgeLoading} onClick={() => void loadKnowledgeSearch()}>
                    {knowledgeLoading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
                    搜索
                  </button>
                  <button type="button" className="primary-button" disabled={contextPackLoading} onClick={() => void loadContextPack()}>
                    <RefreshCw size={16} className={contextPackLoading ? 'spin' : ''} />
                    Context Pack
                  </button>
                  <button type="button" className="primary-button" disabled={!contextPack?.workerPromptContext} onClick={() => void copyContextPrompt()}>
                    <Copy size={16} />
                    {contextPromptCopied ? '已复制' : '复制 Prompt'}
                  </button>
                </div>
              </div>

              <div className="knowledge-query-row">
                <input
                  value={knowledgeQuery}
                  onChange={(event) => setKnowledgeQuery(event.target.value)}
                  placeholder={selected ? `${selected.title} / ${selected.cwd ?? 'unknown cwd'}` : '搜索个人偏好、项目事实、runbook 或历史会话'}
                />
                {selectedProjectPath ? <code>{selectedProjectPath}</code> : null}
              </div>

              {knowledgeError ? <div className="worker-message danger">knowledge search 失败：{knowledgeError}</div> : null}
              {contextPackError ? <div className="worker-message danger">context pack 失败：{contextPackError}</div> : null}

              {contextPack?.recommendedResume ? (
                <div className="resume-recommendation">
                  <div>
                    <span>recommended resume</span>
                    <strong>{Math.round(contextPack.recommendedResume.confidence * 100)}% · {contextPack.recommendedResume.reason}</strong>
                  </div>
                  <span>{contextPack.recommendedResume.machineId} · {agentLabel(contextPack.recommendedResume.agent)} · {contextPack.recommendedResume.sessionId}</span>
                  <code>{contextPack.recommendedResume.resumeCommand}</code>
                </div>
              ) : contextPack ? (
                <div className="resume-recommendation muted">
                  <div>
                    <span>new session reason</span>
                    <strong>{contextPack.newSessionReason ?? '未找到可恢复会话'}</strong>
                  </div>
                </div>
              ) : null}

              <div className="knowledge-context-grid">
                <div className="knowledge-column">
                  <h4>Durable Knowledge</h4>
                  {knowledgeLoading && !knowledgeResults.length ? <div className="empty compact">正在搜索知识库...</div> : null}
                  {!knowledgeLoading && !knowledgeResults.length && !knowledgeError ? <div className="empty compact">暂无搜索结果</div> : null}
                  <div className="knowledge-item-list">
                    {knowledgeResults.slice(0, 6).map((item) => (
                      <article className="knowledge-item" key={item.id}>
                        <div className="knowledge-item-title">
                          <span className="status-pill">{item.type}</span>
                          <strong>{item.title}</strong>
                        </div>
                        <p>{item.text}</p>
                        <div className="knowledge-item-meta">
                          {item.project ? <span>{item.project}</span> : null}
                          {item.repo ? <code>{item.repo}</code> : null}
                          <span>{formatDate(item.updatedAt)}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>

                <div className="knowledge-column">
                  <h4>Context Pack</h4>
                  {contextPackLoading && !contextPack ? <div className="empty compact">正在构建 context pack...</div> : null}
                  {!contextPack && !contextPackLoading && !contextPackError ? <div className="empty compact">尚未构建</div> : null}
                  {contextPack ? (
                    <div className="context-pack-stack">
                      {contextPack.matchedProject ? (
                        <div className="context-pack-card">
                          <span>matched project</span>
                          <strong>{contextPack.matchedProject.name}</strong>
                          <code>{contextPack.matchedProject.repo ?? contextPack.matchedProject.cwd ?? contextPack.matchedProject.reason}</code>
                        </div>
                      ) : null}
                      <div className="context-pack-card">
                        <span>preferences</span>
                        <p>{contextPack.preferences.map((item) => item.text || item.title).slice(0, 3).join('\n') || 'none'}</p>
                      </div>
                      <div className="context-pack-card">
                        <span>project facts</span>
                        <p>{contextPack.projectFacts.map((item) => item.text || item.title).slice(0, 4).join('\n') || 'none'}</p>
                      </div>
                      <div className="context-pack-card">
                        <span>runbooks</span>
                        <p>{contextPack.runbooks.map((item) => item.title).slice(0, 4).join('\n') || 'none'}</p>
                      </div>
                      <div className="context-pack-card">
                        <span>sessions</span>
                        <p>{contextPack.sessions.map((session) => `${agentLabel(session.agent)} · ${session.title} · ${session.canResume ? 'resume' : 'no resume'}`).slice(0, 5).join('\n') || 'none'}</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="primary-panel commander-audit">
              <div className="panel-heading worker-heading">
                <div>
                  <h3>Commander Actions 审计</h3>
                  <span>{commanderActions.length ? `最近 ${recentCommanderActions.length}/${commanderActions.length} 条控制节点记录` : '控制节点 direct-action / self-repair / manual-note'}</span>
                </div>
                <button type="button" className="primary-button" disabled={commanderActionsLoading} onClick={() => void loadCommanderActions()}>
                  <RefreshCw size={16} className={commanderActionsLoading ? 'spin' : ''} />
                  刷新
                </button>
              </div>

              {commanderActionsError ? <div className="worker-message danger">commander actions 加载失败：{commanderActionsError}</div> : null}
              {commanderActionsLoading && !recentCommanderActions.length ? (
                <div className="empty compact">正在加载 commander actions...</div>
              ) : null}
              {!commanderActionsLoading && !recentCommanderActions.length && !commanderActionsError ? (
                <div className="empty compact">暂无 commander action 记录</div>
              ) : null}
              {recentCommanderActions.length ? (
                <div className="commander-action-list">
                  {recentCommanderActions.map((action) => (
                    <article className="commander-action" key={action.id}>
                      <div className="commander-action-title">
                        <span className="status-pill">{commanderActionKindLabel[action.kind] ?? action.kind}</span>
                        <span className={`status-pill ${commanderActionStatusTone[action.status] ?? ''}`}>{action.status || 'unknown'}</span>
                        <time>{formatDate(action.completedAt ?? action.startedAt)}</time>
                      </div>
                      <div className="commander-action-body">
                        <div>
                          <span>goal</span>
                          <p>{action.goal || '无'}</p>
                        </div>
                        <div>
                          <span>reason</span>
                          <p>{action.reason || '无'}</p>
                        </div>
                        <div>
                          <span>scope</span>
                          <p>{action.scope || '无'}</p>
                        </div>
                        <div>
                          <span>changed files</span>
                          <p>{(action.changedFiles ?? []).join('\n') || 'none'}</p>
                        </div>
                        <div>
                          <span>tests</span>
                          <p>{(action.tests ?? []).join('\n') || 'not run'}</p>
                        </div>
                        <div>
                          <span>verification</span>
                          <p>{(action.verification ?? []).join('\n') || '无'}</p>
                        </div>
                        <div>
                          <span>time</span>
                          <p>
                            {formatDate(action.startedAt)}
                            {action.completedAt ? ` - ${formatDate(action.completedAt)}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="commander-action-meta">
                        <code>{action.targetRepo || action.cwd || 'unknown target'}</code>
                        {action.followUp ? <span>{action.followUp}</span> : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>
            <section className="primary-panel worker-console">
              <div className="panel-heading worker-heading">
                <div>
                  <h3>{agentLabel(selected.agent)} Worker 控制台</h3>
                  <span>{selectedWorkerJobs.length ? `当前会话 ${selectedWorkerJobs.length} 个 job` : '当前会话暂无 job'}</span>
                </div>
                <div className="worker-heading-actions">
                  {selectedWorkerJobs.length > 1 ? (
                    <select
                      className="worker-job-select"
                      value={currentWorkerJobKey ?? ''}
                      onChange={(event) => setSelectedWorkerJobKey(event.target.value || null)}
                      aria-label="选择 worker job"
                    >
                      {selectedWorkerJobs.map((job) => (
                        <option key={workerJobKey(job)} value={workerJobKey(job)}>
                          {statusLabel(job.status)} · {formatDate(job.updatedAt ?? job.startedAt ?? null)} · {job.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button type="button" className="primary-button" disabled={workerJobsLoading} onClick={() => void loadWorkerJobs()}>
                    <RefreshCw size={16} className={workerJobsLoading ? 'spin' : ''} />
                    刷新
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={!currentWorkerJob || !isWorkerJobRunning(currentWorkerJob) || workerJobBusyKey === workerJobActionKey(currentWorkerJob, 'stop')}
                    onClick={() => currentWorkerJob ? void stopWorkerJob(currentWorkerJob) : undefined}
                  >
                    <X size={16} />
                    停止 job
                  </button>
                </div>
              </div>

              {workerJobsError ? <div className="worker-message danger">job 列表加载失败：{workerJobsError}</div> : null}
              {workerActionMessage ? <div className="worker-message">{workerActionMessage}</div> : null}

              <div className="job-registry-panel">
                <div className="job-registry-heading">
                  <div>
                    <h4>多机器 Job Registry</h4>
                    <span>
                      {jobRegistryMachines.length} 台机器 · {workerJobs.filter(isWorkerJobRunning).length} 个 running job
                      {workerJobs.length ? ` / ${workerJobs.length} total` : ''}
                    </span>
                  </div>
                  <span className="status-pill">{workerJobsLoading ? '刷新中' : 'registry'}</span>
                </div>
                <div className="job-registry-grid">
                  {jobRegistryMachines.map((machine) => (
                    <div
                      className={`job-registry-machine ${machine.healthy ? 'healthy' : 'unhealthy'}`}
                      key={machineKey(machine.machineId, machine.baseUrl)}
                    >
                      <div className="job-registry-machine-title">
                        <span className={`remote-dot ${machine.healthy ? 'online' : 'offline'}`} />
                        <strong>{machine.machineId}</strong>
                        <em>{machine.cached ? 'cached' : 'live'}</em>
                      </div>
                      <div className="job-registry-fields">
                        <div>
                          <span>baseUrl</span>
                          <strong>{machine.baseUrl || 'local'}</strong>
                        </div>
                        <div>
                          <span>updatedAt</span>
                          <strong>{formatDate(machine.updatedAt)}</strong>
                        </div>
                        <div>
                          <span>running jobs</span>
                          <strong>{machine.runningJobs}</strong>
                        </div>
                        <div>
                          <span>errors</span>
                          <strong>{machine.error || '无'}</strong>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {jobRegistryErrors.length ? (
                  <div className="job-registry-errors">
                    {jobRegistryErrors.map((item) => (
                      <div className="worker-event danger" key={`${item.machineId}-${item.baseUrl ?? 'local'}-${item.error}`}>
                        <span>{item.machineId} · {item.baseUrl || 'local'}</span>
                        <p>{item.error}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {currentWorkerJob ? (
                <div className="worker-console-grid">
                  <div className="worker-facts">
                    <div>
                      <span>status</span>
                      <strong className={`status-pill ${workerStatusTone[currentWorkerJob.status ?? ''] ?? ''}`}>
                        {statusLabel(currentWorkerJob.status)}
                      </strong>
                    </div>
                    <div>
                      <span>mode</span>
                      <strong>{currentWorkerJob.mode ?? '未知'}</strong>
                    </div>
                    <div>
                      <span>machine</span>
                      <strong>{currentWorkerJob.machineId ?? currentWorkerJob.machine ?? '未知'}</strong>
                    </div>
                    <div>
                      <span>cwd</span>
                      <strong>{currentWorkerJob.cwd ?? '未知'}</strong>
                    </div>
                    <div>
                      <span>startedAt</span>
                      <strong>{formatDate(currentWorkerJob.startedAt ?? null)}</strong>
                    </div>
                    <div>
                      <span>updatedAt</span>
                      <strong>{formatDate(currentWorkerJob.updatedAt ?? null)}</strong>
                    </div>
                  </div>

                  <div className="worker-controls">
                    <label>
                      <span>发送指导</span>
                      <textarea
                        value={currentWorkerGuidanceDraft}
                        onChange={(event) =>
                          setWorkerGuidanceDrafts((current) => ({ ...current, [workerJobKey(currentWorkerJob)]: event.target.value }))
                        }
                        placeholder="给运行中的 Codex worker 发送中文指导"
                      />
                    </label>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!currentWorkerGuidanceDraft.trim() || workerJobBusyKey === workerJobActionKey(currentWorkerJob, 'guidance')}
                      onClick={() => void sendWorkerGuidance(currentWorkerJob)}
                    >
                      <TerminalIcon size={16} />
                      发送指导
                    </button>

                    <div className="worker-protocol-row">
                      <select
                        value={currentWorkerProtocolKind}
                        onChange={(event) =>
                          setWorkerProtocolKindsByJob((current) => ({
                            ...current,
                            [workerJobKey(currentWorkerJob)]: event.target.value as WorkerProtocolKind,
                          }))
                        }
                        aria-label="protocol kind"
                      >
                        {workerProtocolKinds.map((kind) => (
                          <option key={kind.id} value={kind.id}>
                            {kind.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={workerJobBusyKey === workerJobActionKey(currentWorkerJob, 'protocol')}
                        onClick={() => void sendWorkerProtocolKind(currentWorkerJob)}
                      >
                        <Sparkles size={16} />
                        发送 protocol
                      </button>
                    </div>

                    <label>
                      <span>supervise instruction</span>
                      <textarea
                        value={currentWorkerSupervisorDraft}
                        onChange={(event) =>
                          setWorkerSupervisorDrafts((current) => ({ ...current, [workerJobKey(currentWorkerJob)]: event.target.value }))
                        }
                        placeholder="可选：监督指令"
                      />
                    </label>
                    <div className="worker-supervise-row">
                      <label className="worker-checkbox">
                        <input
                          type="checkbox"
                          checked={currentWorkerSupervisorAutoStop}
                          onChange={(event) =>
                            setWorkerSupervisorAutoStop((current) => ({ ...current, [workerJobKey(currentWorkerJob)]: event.target.checked }))
                          }
                        />
                        autoStop
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={workerJobBusyKey === workerJobActionKey(currentWorkerJob, 'supervise')}
                        onClick={() => void superviseWorkerJob(currentWorkerJob)}
                      >
                        <ShieldCheck size={16} />
                        supervise
                      </button>
                    </div>
                  </div>

                  <div className="worker-section">
                    <h4>outputTail</h4>
                    <pre className="worker-code">{currentWorkerJob.outputTail || '暂无输出'}</pre>
                  </div>

                  <div className="worker-section">
                    <h4>changedFiles</h4>
                    <div className="worker-file-list">
                      {(currentWorkerJob.changedFiles ?? []).length ? (
                        (currentWorkerJob.changedFiles ?? []).map((file) => <code key={file}>{file}</code>)
                      ) : (
                        <span>暂无 changed files</span>
                      )}
                    </div>
                  </div>

                  <div className="worker-section">
                    <h4>guidance</h4>
                    <div className="worker-event-list">
                      {(currentWorkerJob.guidance ?? []).length ? (
                        (currentWorkerJob.guidance ?? []).slice(-8).map((item, index) => (
                          <div className="worker-event" key={`${item.at ?? 'guidance'}-${index}`}>
                            <span>{formatDate(item.at ?? null)} · {item.source ?? 'unknown'}</span>
                            <p>{item.text ?? '无内容'}</p>
                          </div>
                        ))
                      ) : (
                        <div className="empty compact">暂无 guidance</div>
                      )}
                    </div>
                  </div>

                  <div className="worker-section">
                    <h4>supervisor</h4>
                    <div className="worker-metric-grid">
                      <div>
                        <span>启用</span>
                        <strong>{booleanPolicyLabel(currentWorkerJob.supervisor?.enabled, '启用', '关闭')}</strong>
                      </div>
                      <div>
                        <span>决策</span>
                        <strong className={`status-pill ${supervisorDecisionTone[currentWorkerJob.supervisor?.lastDecision ?? ''] ?? ''}`}>
                          {supervisorDecisionLabel[currentWorkerJob.supervisor?.lastDecision ?? ''] ?? currentWorkerJob.supervisor?.lastDecision ?? '暂无'}
                        </strong>
                      </div>
                      <div>
                        <span>检查次数</span>
                        <strong>{currentWorkerJob.supervisor?.checks ?? 0}</strong>
                      </div>
                      <div>
                        <span>重试次数</span>
                        <strong>{currentWorkerJob.supervisor?.retries ?? 0}</strong>
                      </div>
                      <div>
                        <span>空闲阈值</span>
                        <strong>{formatDurationMs(currentWorkerJob.supervisor?.idleTimeoutMs)}</strong>
                      </div>
                      <div>
                        <span>最后输出</span>
                        <strong>{formatOptionalBytes(currentWorkerJob.supervisor?.lastOutputBytes)}</strong>
                      </div>
                    </div>
                    {currentWorkerJob.supervisor?.lastReason ? <p className="worker-note">{currentWorkerJob.supervisor.lastReason}</p> : null}
                  </div>

                  <div className="worker-section">
                    <h4>structuredReport</h4>
                    {currentWorkerJob.structuredReport ? (
                      <div className="worker-report">
                        <div><span>STATUS</span><strong>{currentWorkerJob.structuredReport.status ?? '未填写'}</strong></div>
                        <div><span>NEXT_ACTION</span><strong>{currentWorkerJob.structuredReport.nextAction ?? 'none'}</strong></div>
                        <div>
                          <span>CHANGED_FILES</span>
                          <p>{(currentWorkerJob.structuredReport.changedFiles ?? []).join('\n') || 'none'}</p>
                        </div>
                        <div>
                          <span>TESTS</span>
                          <p>{(currentWorkerJob.structuredReport.tests ?? []).join('\n') || 'not run'}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="warning-line"><AlertTriangle size={15} /> 完成报告缺失，控制面不应直接宣称任务成功。</div>
                    )}
                  </div>

                  <div className="worker-section">
                    <h4>安全策略</h4>
                    <div className="worker-metric-grid">
                      <div><span>deploy</span><strong>{booleanPolicyLabel(currentWorkerJob.policy?.allowDeploy)}</strong></div>
                      <div><span>delete</span><strong>{booleanPolicyLabel(currentWorkerJob.policy?.allowDeletes)}</strong></div>
                      <div><span>autoStop</span><strong>{booleanPolicyLabel(currentWorkerJob.policy?.autoStop, '启用', '关闭')}</strong></div>
                      <div><span>最长运行</span><strong>{formatDurationMs(currentWorkerJob.policy?.maxRuntimeMs)}</strong></div>
                      <div><span>最大输出</span><strong>{formatOptionalBytes(currentWorkerJob.policy?.maxOutputBytes)}</strong></div>
                      <div><span>最后检查</span><strong>{formatDate(currentWorkerJob.policyState?.lastCheckedAt ?? null)}</strong></div>
                    </div>
                    {(currentWorkerJob.policy?.allowedCwds ?? []).length ? (
                      <div className="worker-chip-list">
                        {(currentWorkerJob.policy?.allowedCwds ?? []).map((path) => <code key={path}>{path}</code>)}
                      </div>
                    ) : null}
                    {(currentWorkerJob.policyState?.violations ?? []).length ? (
                      <div className="worker-event-list compact-list">
                        {(currentWorkerJob.policyState?.violations ?? []).slice(-6).map((item, index) => (
                          <div className="worker-event danger" key={`${item.at ?? 'policy'}-${index}`}>
                            <span>{formatDate(item.at ?? null)} · {item.severity ?? 'warn'} · {item.pattern ?? 'policy'}</span>
                            <p>{item.reason ?? '触发策略'}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty compact">暂无策略违规</div>
                    )}
                  </div>

                  <div className="worker-section">
                    <h4>事件流</h4>
                    <div className="worker-event-list">
                      {currentWorkerEvents.length ? (
                        currentWorkerEvents.map((event, index) => (
                          <div className="worker-event" key={typeof event.seq === 'number' ? event.seq : index}>
                            <span>
                              #{event.seq ?? index + 1} · {formatDate(event.at ?? null)} · {event.kind ?? event.type ?? 'event'}
                            </span>
                            <p>{event.message ?? formatUnknownValue(event.data ?? event)}</p>
                          </div>
                        ))
                      ) : (
                        <div className="empty compact">
                          {workerJobEventsUnavailable[workerJobKey(currentWorkerJob)] ? '事件接口未启用或暂不可用' : '暂无事件流'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="empty compact">{workerJobsLoading ? '正在加载 worker jobs...' : '当前会话没有匹配的 worker job'}</div>
              )}
            </section>

            <section className="primary-panel">
              <h3>搜索索引</h3>
              <div className="index-section">
                <span>技术栈</span>
                <div className="chip-row">
                  {(selected.evaluation.techStack ?? []).length ? (
                    (selected.evaluation.techStack ?? []).map((item) => <em key={item}>{item}</em>)
                  ) : (
                    <strong>未识别到明确技术栈</strong>
                  )}
                </div>
              </div>
              <div className="index-section">
                <span>关键词</span>
                <div className="chip-row">
                  {(selected.evaluation.keywords ?? []).length ? (
                    (selected.evaluation.keywords ?? []).slice(0, 18).map((item) => <em key={item}>{item}</em>)
                  ) : (
                    <strong>暂无关键词</strong>
                  )}
                </div>
              </div>
              <div className="index-section">
                <span>目录索引</span>
                <div className="chip-row">
                  {(selected.evaluation.directoryIndex ?? []).length ? (
                    (selected.evaluation.directoryIndex ?? []).slice(0, 16).map((item) => <em key={item}>{item}</em>)
                  ) : (
                    <strong>暂无目录索引</strong>
                  )}
                </div>
              </div>
            </section>

            <section className="primary-panel">
              <div className="panel-heading">
                <h3>会话历史</h3>
                <button
                  type="button"
                  className="primary-button"
                  disabled={historyLoading || historyLoadedSessionKey === sessionKey(selected)}
                  onClick={() => void loadHistory(selected)}
                >
                  {historyLoadedSessionKey === sessionKey(selected) ? '已加载最近记录' : '加载最近记录'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={historyLoadedSessionKey !== sessionKey(selected) || !historyHasMore || historyLoading || historyBefore === null}
                  onClick={() => void loadHistory(selected, historyBefore)}
                >
                  更早记录
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={historyLoading}
                  onClick={() => void loadAllMessages(selected)}
                >
                  加载全部消息
                </button>
              </div>
              <div className="history-list" aria-busy={historyLoading}>
                {historyMessages.map((message) => (
                  <div className={`history-message ${message.role}`} key={message.index}>
                    <span>{message.role === 'user' ? '用户' : agentLabel(selected.agent)} · {formatDate(message.timestamp)}</span>
                    {message.injectedContext ? (
                      <details className="history-context-details">
                        <summary>{message.injectedContext.label}</summary>
                        <pre>{message.injectedContext.text}</pre>
                      </details>
                    ) : (
                      <p>{message.text}</p>
                    )}
                  </div>
                ))}
                {!historyMessages.length ? (
                  <div className="empty compact">{historyLoading ? '正在加载会话历史...' : '点击“加载最近记录”后查看历史'}</div>
                ) : null}
              </div>
            </section>

            <section className="secondary-panel">
              <h3>工作目录判断</h3>
              <div className="fact">
                <CheckCircle2 size={16} />
                <span>
                  目录匹配：
                  {selected.evaluation.cwdMatchesWorkdir === null
                    ? '证据不足'
                    : selected.evaluation.cwdMatchesWorkdir
                      ? '会话 cwd 与识别目录一致'
                      : '会话 cwd 可能不是实际工作目录'}
                </span>
              </div>
              <div className="fact">
                <FolderOpen size={17} />
                <span>会话 cwd：{selected.cwd ?? 'unknown cwd'}</span>
              </div>
              {selected.evaluation.actualWorkdirs.length ? (
                selected.evaluation.actualWorkdirs.map((workdir) => (
                  <div className="fact" key={workdir}>
                    <CheckCircle2 size={16} />
                    <span>识别目录：{workdir}</span>
                  </div>
                ))
              ) : (
                <div className="fact muted-fact">
                  <AlertTriangle size={16} />
                  <span>未从整段会话中识别到明确工作目录</span>
                </div>
              )}
              {selected.evaluation.recommendedWorkdir ? (
                <div className={`notice ${migrationAlreadyInPlace ? 'inline-info' : 'inline-warning'}`}>
                  {migrationAlreadyInPlace
                    ? `当前会话已经在对应目录：${selected.evaluation.recommendedWorkdir}`
                    : `建议迁移/继续工作目录：${selected.evaluation.recommendedWorkdir}`}
                </div>
              ) : null}
              <div className="notice inline-info migration-basis">
                迁移依据：
                {selected.evaluation.recommendedWorkdir
                  ? 'AI 从整段会话识别出推荐继续目录'
                  : selected.evaluation.actualWorkdirs.length
                    ? 'AI 从整段会话识别出实际工作目录'
                    : '未识别到明确目录，默认使用会话 cwd'}
              </div>
              {selected.agent === 'claude' ? (
                <div className="notice inline-warning">
                  Claude 会话暂不支持跨目录迁移。请在原 cwd 使用
                  {' '}
                  {selected.resumeCommand || `claude --resume ${selected.id}`}
                  {' '}
                  继续；批量迁移只会提交已选 Codex 会话。
                </div>
              ) : null}
              {selectedClaudeMigrationCount > 0 ? (
                <div className="notice inline-info">
                  批量迁移将跳过当前目录中已选的 {selectedClaudeMigrationCount} 个 Claude 会话。
                </div>
              ) : null}
              <div className="migration-box">
                <input
                  value={migrationTarget}
                  onChange={(event) =>
                    setMigrationTargets((current) => ({ ...current, [sessionKey(selected)]: event.target.value }))
                  }
                  placeholder="输入本机项目目录"
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    selected.agent !== 'codex' ||
                    busyId === `${sessionKey(selected)}:migrate` ||
                    !migrationTarget.trim() ||
                    migrationAlreadyInPlace
                  }
                  title={selected.agent === 'claude' ? 'Claude 会话暂不支持跨目录迁移' : undefined}
                  onClick={() => void migrateSession(selected)}
                >
                  {selected.agent === 'claude'
                    ? 'Claude 不支持迁移'
                    : migrationAlreadyInPlace
                      ? '无需迁移'
                      : '迁移到目录'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyId === 'bulk-migrate' || selectedCodexMigrationCount === 0 || !migrationTarget.trim()}
                  onClick={() => void migrateSelectedSameDirectory(selected)}
                >
                  批量迁移 Codex{selectedCodexMigrationCount ? ` (${selectedCodexMigrationCount})` : ''}
                </button>
              </div>
              {actionMessage ? <div className="notice inline-info">{actionMessage}</div> : null}
            </section>

            <section className="secondary-panel">
              <h3>评估依据</h3>
              <ul className="reason-list">
                {selected.evaluation.reasons.map((reason) => (
                  <li key={reason}>
                    <CheckCircle2 size={16} />
                    {reason}
                  </li>
                ))}
              </ul>
              {(selected.evaluation.reviewSignals ?? []).length ? (
                <div className="review-signals">
                  {(selected.evaluation.reviewSignals ?? []).map((signal) => (
                    <span key={signal}>{signal}</span>
                  ))}
                </div>
              ) : null}
              <div className="workflow">
                <Sparkles size={16} />
                摘要版本：{selected.evaluation.workflow} · 模型：{selected.evaluation.model} · 状态：
                {selected.evaluation.status === 'ok' ? '成功' : selected.evaluation.status === 'failed' ? '失败后回退' : '规则回退'} · 更新时间：
                {formatDate(selected.evaluation.evaluatedAt)}
              </div>
              {selected.evaluation.error ? <div className="notice inline-warning">摘要失败原因：{selected.evaluation.error}</div> : null}
            </section>

            <section className="facts-panel">
              <h3>机器与远程环境</h3>
              <div className="fact">
                <Server size={17} />
                <span>当前客户端：{selected.machineId}</span>
              </div>
              {selected.evaluation.remoteMachines.length ? (
                selected.evaluation.remoteMachines.map((machine, index) => (
                  <div className="remote-item" key={`${machine.label ?? machine.host ?? machine.ip ?? index}-${index}`}>
                    <strong>{machine.label ?? machine.host ?? machine.ip ?? '远程机器'}</strong>
                    <span>
                      {[machine.user ? `用户 ${machine.user}` : '', machine.host ? `host ${machine.host}` : '', machine.ip ? `ip ${machine.ip}` : '']
                        .filter(Boolean)
                        .join(' · ') || '会话中提到远程环境'}
                    </span>
                    {machine.evidence ? <em>{machine.evidence}</em> : null}
                  </div>
                ))
              ) : (
                <div className="fact muted-fact">
                  <AlertTriangle size={16} />
                  <span>未识别到 SSH、IP 或云端机器线索</span>
                </div>
              )}
            </section>

            <section className="facts-panel">
              <h3>本机位置</h3>
              <div className="fact">
                <FolderOpen size={17} />
                <span>{selected.cwd ?? 'unknown cwd'}</span>
              </div>
              <div className="fact">
                <FileJson size={17} />
                <span>{selected.filePath}</span>
              </div>
              <div className="fact">
                <Archive size={17} />
                <span>{selected.shellSnapshotCount} shell snapshots</span>
              </div>
            </section>

              <section className="metrics-panel">
                <div>{metricLabel(selected.userTurns, '用户回合')}</div>
              <div>{metricLabel(selected.assistantTurns, '助手回合')}</div>
              <div>{metricLabel(selected.messageCount, '消息')}</div>
              <div>{metricLabel(Number(formatBytes(selected.bytes).split(' ')[0]), formatBytes(selected.bytes).split(' ')[1])}</div>
              <div className="wide">
                <Clock3 size={17} />
                  {formatDate(selected.startedAt)} - {formatDate(selected.updatedAt)}
                </div>
              </section>
                </>
              ) : null}
            </div>
        ) : (
          <div className="blank-state">没有可显示的 Codex / Claude 会话</div>
        )}

          {SHOW_ADVANCED_UI ? (
            <footer className="footer">
              <span>Codex home: {meta?.codexHome ?? 'loading'}</span>
              <span>Claude projects: {meta?.claudeProjectsRoot ?? 'loading'}</span>
              <span>回收站: {meta?.recycleRoot ?? 'loading'} · {meta?.recycleRetentionDays ?? 30}天</span>
              <span>删除模式: {meta?.deleteMode ?? 'archive-then-local-clean'}</span>
            </footer>
          ) : null}
      </section>
    </main>
  );
}

export default App;
