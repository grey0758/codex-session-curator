export type Recommendation = 'keep' | 'review' | 'delete';
export type ActivityStatus = 'active' | 'inactive';

export type MessageRole = 'user' | 'assistant';

export interface ParsedMessage {
  role: MessageRole;
  text: string;
  timestamp: string | null;
}

export interface HistoryMessage extends ParsedMessage {
  index: number;
}

export interface Evaluation {
  title: string;
  summary: string;
  detailedSummary: string;
  recommendation: Recommendation;
  score: number;
  reasons: string[];
  actualWorkdirs: string[];
  cwdMatchesWorkdir: boolean | null;
  recommendedWorkdir: string | null;
  remoteMachines: RemoteMachine[];
  evaluatedAt: string;
  workflow: string;
  model: string;
  status: 'ok' | 'fallback' | 'failed';
  error: string | null;
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
  filePath: string;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  bytes: number;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
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
  shellSnapshotCount?: number;
}

export interface PersistedState {
  keptIds: string[];
  deletedIds: string[];
  titles: Record<string, string>;
  evaluations: Record<string, StoredEvaluation>;
}
