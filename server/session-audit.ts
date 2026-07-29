import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getCodexHome } from './file-ops.js';
import type { ParsedMessage, SessionAuditEvent } from './types.js';

export function getSessionAuditLogPath(): string {
  return resolve(process.env.CURATOR_SESSION_AUDIT_LOG || `${getCodexHome()}/session-curator-audit.jsonl`);
}

export function hashTranscript(messages: ParsedMessage[]): string {
  const canonical = messages.map((message) => ({
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function compareSessionVisibility(discoveredIds: string[], visibleIds: Iterable<string>) {
  const discovered = new Set(discoveredIds);
  const visible = new Set(visibleIds);
  return {
    missing: [...discovered].filter((id) => !visible.has(id)).sort(),
    unexpected: [...visible].filter((id) => !discovered.has(id)).sort(),
  };
}

export async function recordSessionAuditEvent(
  event: Omit<SessionAuditEvent, 'id' | 'at'> & { id?: string; at?: string },
): Promise<SessionAuditEvent> {
  const record: SessionAuditEvent = {
    ...event,
    id: event.id ?? randomUUID(),
    at: event.at ?? new Date().toISOString(),
    error: event.error ? event.error.slice(0, 240) : null,
  };
  const path = getSessionAuditLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export async function readSessionAuditEvents(options: {
  limit?: number;
  sessionId?: string | null;
  machineId?: string | null;
} = {}): Promise<SessionAuditEvent[]> {
  let raw: string;
  try {
    raw = await readFile(getSessionAuditLogPath(), 'utf8');
  } catch {
    return [];
  }
  const limit = Math.max(1, Math.min(5000, options.limit ?? 200));
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SessionAuditEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is SessionAuditEvent => Boolean(event))
    .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
    .filter((event) => !options.machineId || event.machineId === options.machineId)
    .slice(-limit);
}
