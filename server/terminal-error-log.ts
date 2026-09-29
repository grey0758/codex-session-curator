import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface TerminalErrorEvent {
  time: string;
  sessionId: string;
  machineId: string;
  agent: 'codex' | 'claude';
  code: string;
  closeCode?: number;
}

const logPath = process.env.CURATOR_TERMINAL_ERROR_LOG_PATH ||
  join(process.env.HOME || '/tmp', '.local/state/codex-session-curator/terminal-errors.jsonl');
let pending: Promise<void> = Promise.resolve();

export function recordTerminalError(event: TerminalErrorEvent): Promise<void> {
  pending = pending.catch(() => {}).then(async () => {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    const existing = await stat(logPath).catch(() => null);
    if (existing && existing.size > 2_000_000) {
      await rename(logPath, `${logPath}.1`);
    }
    await appendFile(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  });
  return pending;
}

export async function readTerminalErrors(sessionId: string, machineId: string, agent: string): Promise<TerminalErrorEvent[]> {
  await pending.catch(() => {});
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return raw.slice(-250_000).split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line) as TerminalErrorEvent;
      return event.sessionId === sessionId && event.machineId === machineId && event.agent === agent ? [event] : [];
    } catch {
      return [];
    }
  }).slice(-40).reverse();
}
