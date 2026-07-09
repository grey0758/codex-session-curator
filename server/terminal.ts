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

export interface TerminalStartOptions {
  cols?: number;
  rows?: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MIN_COLS = 40;
const MAX_COLS = 240;
const MIN_ROWS = 12;
const MAX_ROWS = 100;
const SHELL_ENV_CACHE_MS = 60_000;

let cachedUserShellEnv: { loadedAt: number; env: NodeJS.ProcessEnv } | null = null;

type TerminalTransport = 'auto' | 'ssh' | 'local';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCommandWord(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : shellQuote(value);
}

function envNameForMachine(machineId: string | null | undefined): string | null {
  const normalized = machineId?.trim().replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return normalized ? `CURATOR_TERMINAL_SSH_TARGET_${normalized}` : null;
}

function terminalTransport(): TerminalTransport {
  const configured = process.env.CURATOR_TERMINAL_TRANSPORT?.trim().toLowerCase();
  return configured === 'ssh' || configured === 'local' || configured === 'auto' ? configured : 'auto';
}

function sshTargetForSession(session: CodexSession): string | null {
  const machineEnvName = envNameForMachine(session.machineId);
  const configured = (machineEnvName ? process.env[machineEnvName] : null) || process.env.CURATOR_TERMINAL_SSH_TARGET;
  return configured?.trim() || null;
}

function canRunCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync(command, ['--version'], { env, stdio: 'ignore' }).status === 0;
}

function findCodexBin(env: NodeJS.ProcessEnv): string | null {
  const shell = env.SHELL || process.env.SHELL || '/bin/bash';
  const result = spawnSync(shell, ['-lc', 'command -v codex'], {
    cwd: env.HOME || process.env.HOME || process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: 20_000,
  });
  const found = result.status === 0 ? result.stdout.trim().split('\n')[0] : '';
  return found || null;
}

export function getCodexBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = process.env.CODEX_BIN || env.CODEX_BIN;
  if (configured && canRunCommand(configured, env)) return configured;
  return findCodexBin(env) ?? configured ?? 'codex';
}

function parseNullDelimitedEnv(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of raw.split('\0')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

function loadUserShellEnv(): NodeJS.ProcessEnv {
  const now = Date.now();
  if (cachedUserShellEnv && now - cachedUserShellEnv.loadedAt < SHELL_ENV_CACHE_MS) return cachedUserShellEnv.env;

  const shell = process.env.SHELL || '/bin/bash';
  const result = spawnSync(shell, ['-lic', 'env -0'], {
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  const env = result.status === 0 ? parseNullDelimitedEnv(result.stdout) : {};
  cachedUserShellEnv = { loadedAt: now, env };
  return env;
}

export function createTerminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...loadUserShellEnv(),
  };

  if (!env.CODEX_API_KEY && env.API_KEY) env.CODEX_API_KEY = env.API_KEY;
  if (!env.CODEX_BASE_URL && env.BASE_URL) env.CODEX_BASE_URL = env.BASE_URL;
  env.TERM = 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  return env;
}

export function createCodexResumeCommand(session: CodexSession, env: NodeJS.ProcessEnv = process.env): string {
  const cwd = session.cwd || process.cwd();
  return `${shellCommandWord(getCodexBin(env))} resume --include-non-interactive --no-alt-screen -C ${shellQuote(cwd)} ${shellQuote(session.id)}`;
}

function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function tmuxSessionName(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return `codex-curator-${safeId}`;
}

function tmuxSocketName(): string {
  const configured = process.env.CURATOR_TERMINAL_TMUX_SOCKET?.trim() || 'codex-curator';
  return configured.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'codex-curator';
}

function tmuxArgs(args: string[]): string[] {
  return ['-L', tmuxSocketName(), ...args];
}

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { env: createTerminalEnv(), stdio: 'ignore' }).status === 0;
}

function tmuxHasSession(name: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync('tmux', tmuxArgs(['has-session', '-t', name]), { env, stdio: 'ignore' }).status === 0;
}

function configureTmuxSession(name: string, env: NodeJS.ProcessEnv): void {
  spawnSync('tmux', tmuxArgs(['set-option', '-t', name, 'status', 'off']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['set-option', '-t', name, 'prefix', 'None']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['set-option', '-t', name, 'prefix2', 'None']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['set-option', '-t', name, 'mouse', 'on']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['set-option', '-t', name, 'history-limit', '50000']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['set-window-option', '-t', name, 'alternate-screen', 'off']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['unbind-key', '-T', 'root', 'MouseDown3Pane']), { env, stdio: 'ignore' });
  spawnSync('tmux', tmuxArgs(['unbind-key', '-T', 'root', 'M-MouseDown3Pane']), { env, stdio: 'ignore' });
}

function resizeTmuxSession(name: string, cols: number, rows: number, env: NodeJS.ProcessEnv): void {
  spawnSync('tmux', tmuxArgs(['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)]), {
    env,
    stdio: 'ignore',
  });
}

function ensureTmuxSession(session: CodexSession, cols: number, rows: number, env: NodeJS.ProcessEnv): string | null {
  if (!hasTmux()) return null;

  const name = tmuxSessionName(session.id);
  const exists = spawnSync('tmux', tmuxArgs(['has-session', '-t', name]), { env, stdio: 'ignore' });
  if (exists.status === 0) {
    configureTmuxSession(name, env);
    resizeTmuxSession(name, cols, rows, env);
    return name;
  }

  const cwd = session.cwd || process.cwd();
  const command = createCodexResumeCommand(session, env);
  const created = spawnSync(
    'tmux',
    tmuxArgs(['new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols), '-y', String(rows), command]),
    {
      env,
      encoding: 'utf8',
    }
  );

  if (created.status !== 0) {
    const reason = created.stderr?.trim() || created.error?.message || 'unknown tmux error';
    throw new Error(`tmux session create failed: ${reason}`);
  }

  configureTmuxSession(name, env);
  resizeTmuxSession(name, cols, rows, env);
  return name;
}

function createDirectCodexPty(session: CodexSession, cols: number, rows: number, env: NodeJS.ProcessEnv) {
  return spawnPty(getCodexBin(env), ['resume', '--include-non-interactive', '--no-alt-screen', '-C', session.cwd || process.cwd(), session.id], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: session.cwd || process.cwd(),
    env,
  });
}

function remoteCodexCommand(session: CodexSession, cols: number, rows: number): string {
  const cwdArg = session.cwd ? shellQuote(session.cwd) : '"$HOME"';
  const tmuxName = tmuxSessionName(session.id);
  const socketName = shellQuote(tmuxSocketName());
  const codexCommand = `codex resume --include-non-interactive --no-alt-screen -C ${cwdArg} ${shellQuote(session.id)}`;
  const script = [
    'set -e',
    'export TERM=xterm-256color',
    'export COLORTERM="${COLORTERM:-truecolor}"',
    `cd ${cwdArg}`,
    'if command -v tmux >/dev/null 2>&1; then',
    `  TMUX_SOCKET=${socketName}`,
    '  tmux_cmd() { tmux -L "$TMUX_SOCKET" "$@"; }',
    `  if ! tmux_cmd has-session -t ${shellQuote(tmuxName)} 2>/dev/null; then`,
    `    tmux_cmd new-session -d -s ${shellQuote(tmuxName)} -c ${cwdArg} -x ${shellQuote(String(cols))} -y ${shellQuote(String(rows))} ${shellQuote(codexCommand)}`,
    '  fi',
    `  tmux_cmd set-option -t ${shellQuote(tmuxName)} status off >/dev/null 2>&1 || true`,
    `  tmux_cmd set-option -t ${shellQuote(tmuxName)} prefix None >/dev/null 2>&1 || true`,
    `  tmux_cmd set-option -t ${shellQuote(tmuxName)} prefix2 None >/dev/null 2>&1 || true`,
    `  tmux_cmd set-option -t ${shellQuote(tmuxName)} mouse on >/dev/null 2>&1 || true`,
    `  tmux_cmd set-option -t ${shellQuote(tmuxName)} history-limit 50000 >/dev/null 2>&1 || true`,
    `  tmux_cmd set-window-option -t ${shellQuote(tmuxName)} alternate-screen off >/dev/null 2>&1 || true`,
    `  tmux_cmd unbind-key -T root MouseDown3Pane >/dev/null 2>&1 || true`,
    `  tmux_cmd unbind-key -T root M-MouseDown3Pane >/dev/null 2>&1 || true`,
    `  tmux_cmd resize-window -t ${shellQuote(tmuxName)} -x ${shellQuote(String(cols))} -y ${shellQuote(String(rows))} >/dev/null 2>&1 || true`,
    `  exec tmux -L "$TMUX_SOCKET" attach-session -t ${shellQuote(tmuxName)}`,
    'fi',
    `exec ${codexCommand}`,
  ].join('\n');

  return `exec "\${SHELL:-/bin/bash}" -l -c ${shellQuote(script)}`;
}

function createSshCodexPty(session: CodexSession, cols: number, rows: number, env: NodeJS.ProcessEnv, target: string) {
  const args = [
    '-tt',
    '-o',
    'RequestTTY=force',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    target,
    remoteCodexCommand(session, cols, rows),
  ];
  return spawnPty('ssh', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: env.HOME || process.cwd(),
    env,
  });
}

function createLocalCodexPty(session: CodexSession, cols: number, rows: number, env: NodeJS.ProcessEnv, send: (message: TerminalMessage) => void) {
  const command = createCodexResumeCommand(session, env);
  let tmuxName: string | null = null;
  try {
    tmuxName = ensureTmuxSession(session, cols, rows, env);
  } catch (error) {
    send({ type: 'error', data: error instanceof Error ? error.message : 'Failed to start tmux session' });
  }

  if (tmuxName && !tmuxHasSession(tmuxName, env)) {
    send({
      type: 'error',
      data: `tmux session disappeared before attach: ${tmuxName}. Falling back to direct codex resume.`,
    });
    tmuxName = null;
  }

  const ptyProcess = tmuxName
    ? spawnPty('tmux', tmuxArgs(['attach-session', '-t', tmuxName]), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: session.cwd || process.cwd(),
        env,
      })
    : createDirectCodexPty(session, cols, rows, env);

  send({ type: 'ready', data: tmuxName ? `local tmux -L ${tmuxSocketName()} attach-session -t ${tmuxName}` : command });
  return ptyProcess;
}

export function startCodexTerminal(
  session: CodexSession,
  send: (message: TerminalMessage) => void,
  options: TerminalStartOptions = {}
): { write: (input: TerminalInput) => void; close: () => void } {
  const cols = clampDimension(options.cols, DEFAULT_COLS, MIN_COLS, MAX_COLS);
  const rows = clampDimension(options.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
  const env = createTerminalEnv();
  const transport = terminalTransport();
  const sshTarget = sshTargetForSession(session);
  const shouldUseSsh = transport === 'ssh' || (transport === 'auto' && sshTarget);
  const ptyProcess =
    shouldUseSsh && sshTarget
      ? createSshCodexPty(session, cols, rows, env, sshTarget)
      : createLocalCodexPty(session, cols, rows, env, send);

  if (shouldUseSsh && sshTarget) {
    send({ type: 'ready', data: `ssh ${sshTarget} -> login shell -> codex resume ${session.id}` });
  } else if (transport === 'ssh' && !sshTarget) {
    send({ type: 'error', data: 'CURATOR_TERMINAL_TRANSPORT=ssh but no CURATOR_TERMINAL_SSH_TARGET is configured' });
  }

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
