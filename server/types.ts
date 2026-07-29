export type Recommendation = 'keep' | 'review' | 'delete';
export type ActivityStatus = 'active' | 'inactive';
export type UpdateCadence = 'new' | 'quiet' | 'low' | 'medium' | 'high';
export type ReviewPriority = 'low' | 'normal' | 'review' | 'reunderstand';
export type HermesRefreshStatus = 'never' | 'pending' | 'running' | 'ok' | 'failed';
export type EvaluationOrigin = 'local-llm' | 'worker-fast' | 'hub-remote' | 'rule-fallback';
export type KnowledgeItemType =
  | 'project'
  | 'preference'
  | 'service'
  | 'runbook'
  | 'decision'
  | 'session'
  | 'job'
  | 'commander_action'
  | 'note';

export type MessageRole = 'user' | 'assistant';

// Which agent CLI produced a session. Codex sessions live under ~/.codex/sessions;
// Claude Code sessions live under ~/.claude/projects. Derived from the file path.
export type AgentKind = 'codex' | 'claude';

export interface ParsedMessage {
  role: MessageRole;
  text: string;
  timestamp: string | null;
}

export interface HistoryMessage extends ParsedMessage {
  index: number;
}

export interface SessionMessagesPage {
  messages: HistoryMessage[];
  totalMessages: number;
  nextBefore: number | null;
  nextAfter: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface Evaluation {
  title: string;
  summary: string;
  detailedSummary: string;
  hermesContext?: string;
  hermesContextUpdatedAt?: string | null;
  hermesLastUsedAt?: string | null;
  hermesLastJobId?: string | null;
  hermesNeedsRefresh?: boolean;
  hermesRecalculatedAt?: string | null;
  hermesRefreshStatus?: HermesRefreshStatus;
  hermesRefreshError?: string | null;
  recommendation: Recommendation;
  score: number;
  reasons: string[];
  actualWorkdirs: string[];
  directoryIndex: string[];
  techStack: string[];
  keywords: string[];
  failureCards?: FailureKnowledgeCard[];
  jobOutcomes?: JobOutcome[];
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
  evaluationOrigin?: EvaluationOrigin;
  evaluatedByMachineId?: string | null;
  evaluationRunId?: string | null;
  transcriptHash?: string | null;
}

export interface RemoteEvaluationInput {
  sessionId: string;
  machineId: string;
  agent: AgentKind;
  cwd: string | null;
  updatedAt: string | null;
  bytes: number;
  mtimeMs: number;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  transcriptHash: string;
  messages: ParsedMessage[];
}

export type SessionAuditEventType =
  | 'session-discovered'
  | 'session-indexed'
  | 'history-read'
  | 'evaluation-queued'
  | 'evaluation-deferred'
  | 'evaluation-started'
  | 'evaluation-completed'
  | 'evaluation-failed'
  | 'evaluation-published'
  | 'completeness-scan'
  | 'completeness-issue'
  | 'completeness-pending'
  | 'completeness-skipped'
  | 'completeness-recovered';

export interface SessionAuditEvent {
  id: string;
  at: string;
  event: SessionAuditEventType;
  sessionId: string | null;
  machineId: string;
  agent: AgentKind | null;
  runId: string | null;
  evaluationOrigin: EvaluationOrigin | null;
  transcriptHash: string | null;
  messageCount: number | null;
  userTurns: number | null;
  assistantTurns: number | null;
  bytes: number | null;
  mtimeMs: number | null;
  model: string | null;
  status: string | null;
  error: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface SessionCompletenessIssue {
  sessionId: string;
  agent: AgentKind | null;
  filePath: string | null;
  classification: 'actionable' | 'pending' | 'skipped';
  reasons: string[];
  transcriptHash: string | null;
  evaluationStatus: Evaluation['status'] | 'missing';
  evaluationOrigin: EvaluationOrigin | null;
  messageCount: number;
  mtimeMs: number;
  ageMs: number;
}

export interface SessionCompletenessReport {
  generatedAt: string;
  machineId: string;
  role: 'hub' | 'worker';
  sessionIds: string[];
  counts: {
    discoveredFiles: number;
    parsedSessions: number;
    indexedSessions: number;
    searchableSessions: number;
    historyReadableSessions: number;
    evaluationOk: number;
    evaluationFallback: number;
      evaluationFailed: number;
      evaluationMissing: number;
      eligibleSessions: number;
      fullyEvaluatedSessions: number;
      pendingEvaluationSessions: number;
      metadataOnlySessions: number;
      activeWriteSessions: number;
      actionableIssues: number;
      transcriptVerified: number;
      staleIndex: number;
      unreadableFiles: number;
      orphanedEvaluations: number;
    };
    issues: SessionCompletenessIssue[];
    pending: SessionCompletenessIssue[];
    skipped: SessionCompletenessIssue[];
    unreadableFiles: Array<{ filePath: string; error: string }>;
  orphanedEvaluationIds: string[];
}

export interface JobOutcome {
  id: string;
  at: string;
  jobId: string;
  sessionId: string;
  machineId: string;
  agent: AgentKind;
  status: 'completed' | 'failed' | 'stopped' | 'running' | string;
  mode: 'exec' | 'pty' | string;
  goal: string;
  cwd: string | null;
  changedFiles: string[];
  tests: string[];
  nextAction: string | null;
  failureReason: string | null;
  needsReview: boolean;
  summary: string;
}

export type CommanderActionKind = 'direct-action' | 'self-repair' | 'manual-note';
export type CommanderActionStatus = 'started' | 'completed' | 'failed' | 'blocked';

export interface CommanderAction {
  id: string;
  kind: CommanderActionKind;
  status: CommanderActionStatus;
  goal: string;
  reason: string;
  scope: string | null;
  targetRepo: string | null;
  cwd: string | null;
  changedFiles: string[];
  tests: string[];
  verification: string[];
  followUp: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface KnowledgeItem {
  id: string;
  type: KnowledgeItemType;
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
}

export interface KnowledgeSearchResult {
  score: number;
  item: KnowledgeItem;
}

export type KnowledgeProposalStatus =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'conflict'
  | 'failed';

export type KnowledgeProposalRiskClass = 'ordinary' | 'shared_skill' | 'protected';
export type KnowledgeProposalPublishMode = 'none' | 'workers' | 'fleet';

export interface KnowledgeProposalChange {
  path: string;
  operation: 'upsert' | 'delete';
  baseSha256: string | null;
  content: string | null;
  mode: '100644' | '100755';
}

export interface KnowledgeProposalPublishResult {
  mode: KnowledgeProposalPublishMode;
  status: 'skipped' | 'completed' | 'failed';
  outputTail: string;
  error: string | null;
}

export interface KnowledgeProposalApplyResult {
  preSourceHash: string;
  postSourceHash: string;
  changedFiles: string[];
  backupPath: string;
  validations: string[];
  publish: KnowledgeProposalPublishResult;
}

export interface KnowledgeProposal {
  id: string;
  localId: string;
  status: KnowledgeProposalStatus;
  riskClass: KnowledgeProposalRiskClass;
  baseSourceHash: string;
  reason: string;
  sourceMachineId: string;
  sourceSessionId: string | null;
  changes: KnowledgeProposalChange[];
  submittedAt: string;
  updatedAt: string;
  applyStartedAt: string | null;
  completedAt: string | null;
  rejectedReason: string | null;
  result: KnowledgeProposalApplyResult | null;
  error: string | null;
}
export interface FailureKnowledgeCard {
  id: string;
  at: string;
  jobId: string;
  category: 'auth' | 'env' | 'dependency' | 'test' | 'remote' | 'policy' | 'timeout' | 'worker' | 'unknown';
  title: string;
  summary: string;
  evidence: string;
}

export interface RemoteMachine {
  label: string | null;
  host: string | null;
  ip: string | null;
  user: string | null;
  evidence: string;
}

export interface CodexSession {
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
  lastUserMessage: ParsedMessage | null;
  lastAssistantMessage: ParsedMessage | null;
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

export interface StoredEvaluation extends Evaluation {
  filePath: string;
  mtimeMs: number;
  bytes: number;
  cwd?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  messageCount?: number;
  userTurns?: number;
  assistantTurns?: number;
  lastUserMessage?: ParsedMessage | null;
  lastAssistantMessage?: ParsedMessage | null;
  shellSnapshotCount?: number;
}

export interface PersistedState {
  keptIds: string[];
  deletedIds: string[];
  titles: Record<string, string>;
  evaluations: Record<string, StoredEvaluation>;
  commanderActions: Record<string, CommanderAction>;
}
