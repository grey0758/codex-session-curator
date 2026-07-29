import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { isClaudeSessionPath } from './file-ops.js';
import type { AgentKind, HistoryMessage, MessageRole, ParsedMessage, SessionMessagesPage } from './types.js';

export interface ParsedSessionFile {
  id: string;
  source: AgentKind;
  filePath: string;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  bytes: number;
  mtimeMs: number;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  lastUserMessage: ParsedMessage | null;
  lastAssistantMessage: ParsedMessage | null;
  messages: ParsedMessage[];
}

export function extractSessionId(filePath: string): string {
  const name = basename(filePath);
  const uuid = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (uuid) return uuid[1];
  const match = name.match(/rollout-[\dT-]+-(.+)\.jsonl$/);
  return match ? match[1] : name.replace(/\.jsonl$/, '');
}

function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    if (typeof record.input_text === 'string') parts.push(record.input_text);
  }

  return parts.join('\n').trim() || null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeMessageText(text: string, preserveWhitespace: boolean): string {
  return preserveWhitespace ? text.trim() : normalizeText(text);
}

// Normalize a raw JSONL record from either agent into a role + content turn.
// Codex uses `{ type: 'response_item', payload: { role, content } }`.
// Claude Code uses `{ type: 'user' | 'assistant', message: { role, content } }`
// with top-level cwd/timestamp; sidechain (sub-agent) and meta turns are skipped.
function extractTurnFromRecord(
  record: Record<string, unknown>,
): { role: MessageRole; content: unknown; timestamp: string | null } | null {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;

  if (record.type === 'response_item') {
    const payload = record.payload as Record<string, unknown> | undefined;
    const role = payload?.role;
    if (role !== 'user' && role !== 'assistant') return null;
    return { role, content: payload?.content, timestamp };
  }

  if (record.type === 'user' || record.type === 'assistant') {
    if (record.isSidechain === true || record.isMeta === true) return null;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') return null;
    const role = message.role === 'user' || message.role === 'assistant' ? message.role : record.type;
    return { role, content: message.content, timestamp };
  }

  return null;
}

async function collectSessionMessages(input: {
  filePath: string;
  preserveWhitespace?: boolean;
  accept?: (message: HistoryMessage) => boolean;
  onMessage: (message: HistoryMessage) => void;
}): Promise<number> {
  const stream = createReadStream(input.filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let messageIndex = 0;
  const preserveWhitespace = input.preserveWhitespace ?? false;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const turn = extractTurnFromRecord(record);
    if (!turn) continue;
    const text = textFromContent(turn.content);
    if (!text) continue;

    const current: HistoryMessage = {
      index: messageIndex,
      role: turn.role,
      text: normalizeMessageText(text, preserveWhitespace),
      timestamp: turn.timestamp,
    };
    messageIndex += 1;

    if (!input.accept || input.accept(current)) input.onMessage(current);
  }

  return messageIndex;
}

export async function parseSessionHistory(input: {
  filePath: string;
  limit: number;
  beforeIndex?: number | null;
}): Promise<{ messages: HistoryMessage[]; nextBefore: number | null; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(200, input.limit));
  const beforeIndex = typeof input.beforeIndex === 'number' ? input.beforeIndex : Number.POSITIVE_INFINITY;
  const window: HistoryMessage[] = [];
  let hasMore = false;

  await collectSessionMessages({
    filePath: input.filePath,
    accept: (message) => message.index < beforeIndex,
    onMessage: (message) => {
      window.push(message);
      if (window.length > limit) {
        window.shift();
        hasMore = true;
      }
    },
  });

  return {
    messages: window,
    nextBefore: window.length && hasMore ? window[0].index : null,
    hasMore,
  };
}

export async function parseSessionMessages(input: {
  filePath: string;
  limit?: number | null;
  beforeIndex?: number | null;
  afterIndex?: number | null;
  full?: boolean;
  preserveWhitespace?: boolean;
}): Promise<SessionMessagesPage> {
  const full = input.full === true;
  const limit = full ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(5000, input.limit ?? 200));
  const beforeIndex = typeof input.beforeIndex === 'number' ? input.beforeIndex : Number.POSITIVE_INFINITY;
  const afterIndex = typeof input.afterIndex === 'number' ? input.afterIndex : -1;
  const messages: HistoryMessage[] = [];
  let skippedBeforeWindow = false;
  let stoppedAfterLimit = false;

  const totalMessages = await collectSessionMessages({
    filePath: input.filePath,
    preserveWhitespace: input.preserveWhitespace,
    accept: (message) => message.index < beforeIndex && message.index > afterIndex,
    onMessage: (message) => {
      if (messages.length < limit) {
        messages.push(message);
        return;
      }
      if (Number.isFinite(limit) && typeof input.beforeIndex === 'number') {
        messages.shift();
        messages.push(message);
        skippedBeforeWindow = true;
        return;
      }
      stoppedAfterLimit = true;
    },
  });

  const firstIndex = messages[0]?.index ?? null;
  const lastIndex = messages.at(-1)?.index ?? null;

  return {
    messages,
    totalMessages,
    nextBefore: firstIndex !== null && (skippedBeforeWindow || firstIndex > afterIndex + 1) ? firstIndex : null,
    nextAfter: lastIndex !== null && (stoppedAfterLimit || lastIndex < Math.min(beforeIndex, totalMessages) - 1) ? lastIndex : null,
    hasMoreBefore: firstIndex !== null && (skippedBeforeWindow || firstIndex > afterIndex + 1),
    hasMoreAfter: lastIndex !== null && (stoppedAfterLimit || lastIndex < Math.min(beforeIndex, totalMessages) - 1),
  };
}

export async function parseSessionFile(filePath: string): Promise<ParsedSessionFile> {
  const fileStat = await stat(filePath);
  const source: AgentKind = isClaudeSessionPath(filePath) ? 'claude' : 'codex';
  let id = extractSessionId(filePath);
  let primarySessionMetaSeen = false;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let cwd: string | null = null;
  let startedAt: string | null = null;
  let updatedAt: string | null = null;
  let messageCount = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let lastUserMessage: ParsedMessage | null = null;
  let lastAssistantMessage: ParsedMessage | null = null;
  const messages: ParsedMessage[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (
      timestamp &&
      (!updatedAt || !Number.isFinite(Date.parse(updatedAt)) || Date.parse(timestamp) >= Date.parse(updatedAt))
    ) {
      updatedAt = timestamp;
    }
    if (!startedAt && timestamp) startedAt = timestamp;

    if (record.type === 'session_meta') {
      const payload = record.payload as Record<string, unknown> | undefined;
      // Newer Codex subagent rollouts append inherited parent-thread records,
      // including the parent's session_meta. Only the first metadata record
      // belongs to this file; later metadata must not replace its identity.
      if (!primarySessionMetaSeen) {
        id = typeof payload?.id === 'string' ? payload.id : id;
        cwd = typeof payload?.cwd === 'string' ? payload.cwd : cwd;
        startedAt = typeof payload?.timestamp === 'string' ? payload.timestamp : startedAt;
        primarySessionMetaSeen = true;
      }
      continue;
    }

    // Claude Code carries the session id and cwd on each conversation record
    // rather than in a dedicated meta line.
    if (source === 'claude' && typeof record.sessionId === 'string') id = record.sessionId;
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;

    const turn = extractTurnFromRecord(record);
    if (!turn) continue;

    const text = textFromContent(turn.content);
    if (!text) continue;

    messageCount += 1;
    if (turn.role === 'user') userTurns += 1;
    if (turn.role === 'assistant') assistantTurns += 1;
    const message: ParsedMessage = { role: turn.role, text: normalizeText(text), timestamp };
    if (turn.role === 'user') lastUserMessage = message;
    if (turn.role === 'assistant') lastAssistantMessage = message;
    messages.push(message);
  }

  return {
    id,
    source,
    filePath,
    cwd,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    bytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    messageCount,
    userTurns,
    assistantTurns,
    lastUserMessage,
    lastAssistantMessage,
    messages,
  };
}
