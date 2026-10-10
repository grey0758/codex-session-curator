import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { getEvaluatorEndpoints } from './evaluator.js';
import type { CodexSession, HistoryMessage } from './types.js';

export const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
export const FOLLOW_UP_QUIET_MS = 10 * 60 * 1000;

const verdictSchema = z.object({
  needsFollowUp: z.boolean(),
  priority: z.enum(['high', 'normal', 'low']),
  previousTaskSummary: z.string().min(1).max(1200),
  reason: z.string().min(1).max(800),
  suggestedPrompt: z.string().min(1).max(3000),
});

export interface FollowUpItem extends z.infer<typeof verdictSchema> {
  key: string;
  sessionId: string;
  machineId: string;
  agent: CodexSession['agent'];
  title: string;
  cwd: string | null;
  ownerUser: string;
  endedAt: string;
  version: string;
  model: string;
  analyzedAt: string;
  dismissedAt: string | null;
}

export function followUpKey(session: Pick<CodexSession, 'machineId' | 'agent' | 'id'>): string {
  return `${session.machineId}|||${session.agent}|||${session.id}`;
}

export function followUpVersion(session: CodexSession): string {
  return `${session.updatedAt ?? ''}:${session.bytes}:${session.messageCount}`;
}

export function isFollowUpCandidate(session: CodexSession, now = Date.now()): boolean {
  const ended = Date.parse(session.lastAssistantMessage?.timestamp ?? '');
  const lastUser = Date.parse(session.lastUserMessage?.timestamp ?? '');
  const activity = Date.parse(session.updatedAt ?? '');
  return !session.deleted && session.assistantTurns > 0 &&
    Number.isFinite(ended) && Number.isFinite(activity) &&
    ended >= now - FOLLOW_UP_WINDOW_MS && ended <= now - FOLLOW_UP_QUIET_MS &&
    activity <= now - FOLLOW_UP_QUIET_MS &&
    (!session.lastUserMessage || (Number.isFinite(lastUser) && ended >= lastUser));
}

function redact(text: string): string {
  return text
    .replace(/\b(?:sk-|nvapi-)[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=[redacted]');
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* providers may wrap JSON in Markdown */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export async function analyzeFollowUp(session: CodexSession, history: HistoryMessage[]): Promise<z.infer<typeof verdictSchema> & { model: string }> {
  const endpoints = getEvaluatorEndpoints().sort((a, b) => Number(b.model.toLowerCase().includes('flash')) - Number(a.model.toLowerCase().includes('flash')));
  if (!endpoints.length) throw new Error('No Curator LLM endpoint configured');
  const conversation = history
    .filter((message) => !message.injectedContext)
    .slice(-22)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}: ${redact(message.text.slice(0, 1700))}`)
    .join('\n');
  if (!conversation) throw new Error('Session history is empty');
  const prompt = [
    `会话标题：${session.title}`,
    `工作目录：${session.cwd ?? '未知'}`,
    `已有全程摘要：${session.evaluation.summary}`,
    '以下是最近的对话。请重点识别最后一个用户任务及其助手的完成情况；previousTaskSummary 概括这次会话的上一个任务、已做的修改和验证，不要只重复标题。',
    '若仍需验收、部署、检查、回复问题或推进下一步，needsFollowUp=true；若明确全部完成且无待办，设为 false。信息不足时优先提醒用户检查。',
    'suggestedPrompt 写成用户可直接发给原会话中 Codex/Claude 的中文消息，包含具体下一步及验证要求；不要杜撰已完成的事实。',
    '只返回 JSON：{"needsFollowUp":true,"priority":"high|normal|low","previousTaskSummary":"...","reason":"...","suggestedPrompt":"..."}',
    conversation,
  ].join('\n\n');
  let lastError = 'AI response unavailable';
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.apiKeys[0]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [
            { role: 'system', content: '你是会话结束后的任务提醒助手。只根据给出的证据判断，不输出密钥或原始日志，只输出合法 JSON。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 1600,
          stream: false,
          ...(endpoint.model.toLowerCase().includes('flash') ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `${endpoint.model}: HTTP ${response.status}`;
        continue;
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const result = verdictSchema.safeParse(parseJson(body.choices?.[0]?.message?.content ?? ''));
      if (result.success) return { ...result.data, model: endpoint.model };
      lastError = `${endpoint.model}: invalid JSON verdict`;
    } catch (error) {
      lastError = `${endpoint.model}: ${error instanceof Error ? error.name : 'request failed'}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}

export class FollowUpCenter {
  private readonly filePath: string;
  private readonly listSessions: () => Promise<CodexSession[]>;
  private readonly readHistory: (session: CodexSession) => Promise<HistoryMessage[]>;
  private readonly analyze: typeof analyzeFollowUp;
  private items = new Map<string, FollowUpItem>();
  private failedUntil = new Map<string, number>();
  private scanning: Promise<void> | null = null;
  private lastScanAt = 0;
  private lastError: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    listSessions: () => Promise<CodexSession[]>,
    readHistory: (session: CodexSession) => Promise<HistoryMessage[]>,
    analyze = analyzeFollowUp,
  ) {
    this.filePath = filePath;
    this.listSessions = listSessions;
    this.readHistory = readHistory;
    this.analyze = analyze;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { items?: FollowUpItem[] };
      for (const item of parsed.items ?? []) {
        if (item?.key && item?.endedAt && Date.parse(item.endedAt) >= Date.now() - FOLLOW_UP_WINDOW_MS) {
          this.items.set(item.key, item);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const next = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(next, JSON.stringify({ items: [...this.items.values()] }), { mode: 0o600 });
    await rename(next, this.filePath);
  }

  private save(): Promise<void> {
    this.writing = this.writing.catch(() => undefined).then(() => this.writeState());
    return this.writing;
  }

  snapshot() {
    const cutoff = Date.now() - FOLLOW_UP_WINDOW_MS;
    const items = [...this.items.values()]
      .filter((item) => Date.parse(item.endedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    return { items, scanning: this.scanning !== null, lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null, error: this.lastError, windowHours: 48 };
  }

  async dismiss(key: string, version: string, dismissed: boolean): Promise<FollowUpItem | null> {
    const item = this.items.get(key);
    if (!item || item.version !== version) return null;
    item.dismissedAt = dismissed ? new Date().toISOString() : null;
    await this.save();
    return item;
  }

  scan(force = false): Promise<void> {
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.lastScanAt < 60_000) return Promise.resolve();
    this.scanning = this.doScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    this.lastScanAt = Date.now();
    try {
      this.lastError = null;
      const sessions = await this.listSessions();
      const candidates = sessions.filter((session) => isFollowUpCandidate(session))
        .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
      const current = new Set(candidates.map(followUpKey));
      for (const [key, item] of this.items) {
        if (!current.has(key) || Date.parse(item.endedAt) < Date.now() - FOLLOW_UP_WINDOW_MS) this.items.delete(key);
      }
      await this.save();
      let assessed = 0;
      for (const session of candidates) {
        if (assessed >= 6) break;
        const key = followUpKey(session);
        const version = followUpVersion(session);
        if (this.items.get(key)?.version === version || (this.failedUntil.get(`${key}:${version}`) ?? 0) > Date.now()) continue;
        assessed += 1;
        try {
          const history = await this.readHistory(session);
          const result = await this.analyze(session, history);
          this.items.set(key, {
            ...result, key, version, sessionId: session.id, machineId: session.machineId,
            agent: session.agent, title: session.title, cwd: session.cwd, ownerUser: session.ownerUser,
            endedAt: session.lastAssistantMessage?.timestamp ?? session.updatedAt ?? new Date().toISOString(),
            analyzedAt: new Date().toISOString(), dismissedAt: null,
          });
          this.failedUntil.delete(`${key}:${version}`);
          await this.save();
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : 'Follow-up analysis failed';
          this.failedUntil.set(`${key}:${version}`, Date.now() + 10 * 60_000);
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Follow-up scan failed';
    }
  }
}
