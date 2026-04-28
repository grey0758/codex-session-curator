import { spawnSync } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import type { CodexSession } from './types.js';

export interface TerminalMessage {
  type: 'ready' | 'output' | 'exit' | 'error';
  data?: string;
  code?: number | null;
  signal?: string | number | null;
}

export interface TerminalInput {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MIN_COLS = 40;
const MAX_COLS = 240;
const MIN_ROWS = 12;
const MAX_ROWS = 100;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCommandWord(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : shellQuote(value);
}

function getCodexBin(): string {
  return process.env.CODEX_BIN || 'codex';
}

export function createCodexResumeCommand(session: CodexSession): string {
  const cwd = session.cwd || process.cwd();
  return `${shellCommandWord(getCodexBin())} resume --include-non-interactive --no-alt-screen -C ${shellQuote(cwd)} ${shellQuote(session.id)}`;
}

function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function tmuxSessionName(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return `codex-curator-${safeId}`;
}

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function configureTmuxSession(name: string): void {
  spawnSync('tmux', ['set-option', '-t', name, 'status', 'off'], { stdio: 'ignore' });
}

function ensureTmuxSession(session: CodexSession, cols: number, rows: number): string | null {
  if (!hasTmux()) return null;

  const name = tmuxSessionName(session.id);
  const exists = spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
  if (exists.status === 0) {
    configureTmuxSession(name);
    return name;
  }

  const cwd = session.cwd || process.cwd();
  const command = createCodexResumeCommand(session);
  const created = spawnSync(
    'tmux',
    ['new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols), '-y', String(rows), command],
    {
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
      encoding: 'utf8',
    }
  );

  if (created.status !== 0) {
    const reason = created.stderr?.trim() || created.error?.message || 'unknown tmux error';
    throw new Error(`tmux session create failed: ${reason}`);
  }

  configureTmuxSession(name);
  return name;
}

export function startCodexTerminal(
  session: CodexSession,
  send: (message: TerminalMessage) => void
): { write: (input: TerminalInput) => void; close: () => void } {
  const command = createCodexResumeCommand(session);
  const cols = DEFAULT_COLS;
  const rows = DEFAULT_ROWS;
  let tmuxName: string | null = null;
  try {
    tmuxName = ensureTmuxSession(session, cols, rows);
  } catch (error) {
    send({ type: 'error', data: error instanceof Error ? error.message : 'Failed to start tmux session' });
  }

  const ptyProcess = tmuxName
    ? spawnPty('tmux', ['attach-session', '-t', tmuxName], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: session.cwd || process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: process.env.COLORTERM || 'truecolor',
        },
      })
    : spawnPty(getCodexBin(), ['resume', '--include-non-interactive', '--no-alt-screen', '-C', session.cwd || process.cwd(), session.id], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: session.cwd || process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: process.env.COLORTERM || 'truecolor',
        },
      });

  send({ type: 'ready', data: tmuxName ? `tmux attach-session -t ${tmuxName}` : command });
  ptyProcess.onData((data) => send({ type: 'output', data }));
  ptyProcess.onExit(({ exitCode, signal }) => send({ type: 'exit', code: exitCode, signal: signal === 0 ? null : String(signal) }));

  return {
    write(input) {
      if (input.type === 'input' && typeof input.data === 'string') {
        ptyProcess.write(input.data);
      }
      if (input.type === 'resize') {
        ptyProcess.resize(
          clampDimension(input.cols, DEFAULT_COLS, MIN_COLS, MAX_COLS),
          clampDimension(input.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS)
        );
      }
    },
    close() {
      ptyProcess.kill();
    },
  };
}
