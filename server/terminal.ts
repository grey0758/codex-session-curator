import { spawn } from 'node:child_process';
import type { CodexSession } from './types.js';

export interface TerminalMessage {
  type: 'ready' | 'output' | 'exit' | 'error';
  data?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface TerminalInput {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createCodexResumeCommand(session: CodexSession): string {
  const cwd = session.cwd || process.cwd();
  return `codex resume --include-non-interactive --no-alt-screen -C ${shellQuote(cwd)} ${shellQuote(session.id)}`;
}

export function startCodexTerminal(
  session: CodexSession,
  send: (message: TerminalMessage) => void
): { write: (input: TerminalInput) => void; close: () => void } {
  const command = createCodexResumeCommand(session);
  const child = spawn('script', ['-qfec', command, '/dev/null'], {
    cwd: session.cwd || process.cwd(),
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
      COLORTERM: process.env.COLORTERM || 'truecolor',
      COLUMNS: process.env.COLUMNS || '120',
      LINES: process.env.LINES || '32',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  send({ type: 'ready', data: command });
  child.stdout.on('data', (chunk) => send({ type: 'output', data: chunk.toString('utf8') }));
  child.stderr.on('data', (chunk) => send({ type: 'output', data: chunk.toString('utf8') }));
  child.on('error', (error) => send({ type: 'error', data: error.message }));
  child.on('close', (code, signal) => send({ type: 'exit', code, signal }));

  return {
    write(input) {
      if (input.type === 'input' && typeof input.data === 'string' && child.stdin.writable) {
        child.stdin.write(input.data);
      }
    },
    close() {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}
