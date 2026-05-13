import { basename } from 'node:path';
import type { CommanderAction } from './types.js';

export interface ContextPackSession {
  id: string;
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

export interface ContextKnowledgeItem {
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

interface ContextPackInput {
  query: string;
  cwd?: string | null;
  repo?: string | null;
  limit: number;
  sessions: ContextPackSession[];
  commanderActions: CommanderAction[];
  knowledgeItems: ContextKnowledgeItem[];
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function pathMatches(candidate: string | null | undefined, requested: string | null | undefined): boolean {
  const left = normalize(candidate);
  const right = normalize(requested);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function projectNameFromPath(value: string | null | undefined): string | null {
  const clean = (value ?? '').trim().replace(/\/+$/, '');
  if (!clean) return null;
  return basename(clean) || clean;
}

function sessionProjectScore(session: ContextPackSession, input: Pick<ContextPackInput, 'cwd' | 'repo'>): number {
  let score = 0;
  const workdirs = [session.cwd, session.recommendedWorkdir, ...session.actualWorkdirs].filter(Boolean);
  if (input.cwd && workdirs.some((workdir) => pathMatches(workdir, input.cwd))) score += 40;
  if (input.repo && workdirs.some((workdir) => pathMatches(workdir, input.repo))) score += 35;
  const repoName = projectNameFromPath(input.repo);
  if (repoName) {
    const needle = normalize(repoName);
    if (workdirs.some((workdir) => normalize(workdir).split('/').includes(needle))) score += 20;
    if (session.directoryIndex.some((item) => normalize(item) === needle)) score += 16;
  }
  return score;
}

function chooseMatchedProject(input: ContextPackInput): {
  name: string;
  cwd: string | null;
  repo: string | null;
  reason: string;
} | null {
  if (input.repo || input.cwd) {
    return {
      name: projectNameFromPath(input.repo) ?? projectNameFromPath(input.cwd) ?? 'unknown',
      cwd: input.cwd ?? null,
      repo: input.repo ?? null,
      reason: input.repo ? 'repo query parameter' : 'cwd query parameter',
    };
  }
  const first = input.sessions.find((session) => session.cwd || session.recommendedWorkdir);
  if (!first) return null;
  const cwd = first.recommendedWorkdir ?? first.cwd;
  return {
    name: projectNameFromPath(cwd) ?? first.title,
    cwd,
    repo: null,
    reason: 'best matched session workdir',
  };
}

function shortList(items: string[], limit: number): string {
  return items.slice(0, limit).filter(Boolean).join(', ');
}

function knowledgeByType(items: ContextKnowledgeItem[], types: string[], limit: number): ContextKnowledgeItem[] {
  const wanted = new Set(types);
  return items.filter((item) => wanted.has(item.type)).slice(0, limit);
}

export function recommendResume(input: ContextPackInput): {
  confidence: number;
  sessionId: string;
  resumeCommand: string;
  reason: string;
} | null {
  const candidates = input.sessions
    .filter((session) => session.canResume)
    .map((session) => ({
      session,
      projectScore: sessionProjectScore(session, input),
    }))
    .filter((item) => !input.cwd && !input.repo ? true : item.projectScore > 0)
    .sort((a, b) => b.projectScore - a.projectScore || b.session.score - a.session.score);

  const best = candidates[0];
  if (!best) return null;

  const confidence = Math.min(0.98, Math.max(0.55, (best.session.score + best.projectScore) / 100));
  const reasonParts = [
    best.projectScore > 0 ? 'cwd/repo/project matches request' : 'highest scoring resumable session',
    `session-index score ${best.session.score}`,
  ];
  return {
    confidence,
    sessionId: best.session.id,
    resumeCommand: best.session.resumeCommand,
    reason: reasonParts.join('; '),
  };
}

export function buildWorkerPromptContext(input: ContextPackInput & {
  recommendedResume: ReturnType<typeof recommendResume>;
  preferences: ContextKnowledgeItem[];
  projectFacts: ContextKnowledgeItem[];
  runbooks: ContextKnowledgeItem[];
  newSessionReason: string | null;
}): string {
  const lines = [
    'Context pack for Codex dispatch:',
    `- Current task is highest priority: ${input.query || '(empty query)'}`,
    '- Historical sessions, commander actions, job outcomes, and knowledge items are only location/reference context.',
    '- Prefer resuming an indexed matching session when recommendedResume is present and confidence is sufficient.',
    input.recommendedResume
      ? `- Recommended resume: ${input.recommendedResume.resumeCommand} (${input.recommendedResume.reason})`
      : `- No matching resumable session found; a new child session may be created. ${input.newSessionReason ?? ''}`.trim(),
    input.preferences.length
      ? `- Personal preferences: ${input.preferences.map((item) => item.text || item.title).slice(0, 5).join(' | ')}`
      : '- Personal preferences: none found in matched knowledge.',
    input.projectFacts.length
      ? `- Project facts: ${input.projectFacts.map((item) => item.text || item.title).slice(0, 6).join(' | ')}`
      : '- Project facts: none found in matched knowledge.',
    input.runbooks.length
      ? `- Runbooks: ${input.runbooks.map((item) => item.title).slice(0, 6).join(' | ')}`
      : '- Runbooks: none found in matched knowledge.',
    input.sessions.length ? '- Relevant sessions:' : '- Relevant sessions: none.',
    ...input.sessions.slice(0, input.limit).map((session, index) =>
      `  ${index + 1}. ${session.title} [${session.id}] cwd=${session.cwd ?? 'unknown'} resume=${session.resumeCommand} tech=${shortList(session.techStack, 8)}`
    ),
    input.commanderActions.length ? '- Relevant commander actions:' : '- Relevant commander actions: none.',
    ...input.commanderActions.slice(0, Math.min(input.limit, 8)).map((action, index) =>
      `  ${index + 1}. ${action.status} ${action.kind}: ${action.goal} cwd=${action.cwd ?? action.targetRepo ?? 'unknown'}`
    ),
  ];
  return lines.join('\n');
}

export function buildContextPack(input: ContextPackInput) {
  const matchedProject = chooseMatchedProject(input);
  const recommendedResume = recommendResume(input);
  const preferences = knowledgeByType(input.knowledgeItems, ['preference'], 12);
  const projectFacts = knowledgeByType(input.knowledgeItems, ['project', 'service', 'decision', 'note'], 16);
  const runbooks = knowledgeByType(input.knowledgeItems, ['runbook'], 12);
  const newSessionReason = recommendedResume
    ? null
    : input.cwd || input.repo
      ? 'No canResume session matched the requested cwd/repo/project.'
      : 'No canResume session matched the query.';
  const workerPromptContext = buildWorkerPromptContext({
    ...input,
    recommendedResume,
    preferences,
    projectFacts,
    runbooks,
    newSessionReason,
  });
  return {
    query: input.query,
    matchedProject,
    preferences,
    projectFacts,
    runbooks,
    sessions: input.sessions.slice(0, input.limit),
    commanderActions: input.commanderActions.slice(0, Math.min(input.limit, 20)),
    recommendedResume,
    newSessionReason,
    workerPromptContext,
  };
}
