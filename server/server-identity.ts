import { spawn } from 'node:child_process';

export type ServerIdentityMachine = Record<string, unknown> & {
  alias: string;
  aliases?: string[];
};

const DEFAULT_SERVER_IDENTITY_CLI = '/home/grey/work/codex-control-plane/bin/server-identity';

function serverIdentityCliPath(): string {
  return process.env.CURATOR_SERVER_IDENTITY_CLI || DEFAULT_SERVER_IDENTITY_CLI;
}

function serverIdentityGlobalArgs(): string[] {
  const args: string[] = [];
  const inventory = process.env.SERVER_IDENTITY_INVENTORY || process.env.CURATOR_SERVER_IDENTITY_INVENTORY;
  const db = process.env.SERVER_IDENTITY_DB || process.env.CURATOR_SERVER_IDENTITY_DB;
  if (inventory?.trim()) args.push('--inventory', inventory.trim());
  if (db?.trim()) args.push('--db', db.trim());
  return args;
}

function runServerIdentityCli(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(serverIdentityCliPath(), [...serverIdentityGlobalArgs(), ...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `server-identity exited with ${code}`).trim()));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runJson<T>(args: string[], input?: string): Promise<T> {
  const { stdout } = await runServerIdentityCli(args, input);
  return JSON.parse(stdout) as T;
}

export async function listServerIdentityMachines(includeDeprecated = false): Promise<ServerIdentityMachine[]> {
  const args = ['list', '--json'];
  if (includeDeprecated) args.push('--include-deprecated');
  return runJson<ServerIdentityMachine[]>(args);
}

export async function getServerIdentityMachine(alias: string): Promise<ServerIdentityMachine | null> {
  try {
    return await runJson<ServerIdentityMachine>(['get', alias, '--json']);
  } catch (error) {
    if (error instanceof Error && error.message.includes('machine not found')) return null;
    throw error;
  }
}

export async function upsertServerIdentityMachine(machine: ServerIdentityMachine): Promise<ServerIdentityMachine> {
  return runJson<ServerIdentityMachine>(['upsert', '--json'], JSON.stringify(machine));
}

export async function patchServerIdentityMachine(
  alias: string,
  patch: Record<string, unknown>,
): Promise<ServerIdentityMachine | null> {
  const existing = await getServerIdentityMachine(alias);
  if (!existing) return null;
  if (typeof patch.alias === 'string' && patch.alias !== existing.alias) {
    throw new Error('alias cannot be changed with PATCH');
  }
  return upsertServerIdentityMachine({ ...existing, ...patch, alias: existing.alias });
}

export async function exportServerIdentityInventory(includeDeprecated = false): Promise<Record<string, unknown>> {
  const args = ['export-json'];
  if (includeDeprecated) args.push('--include-deprecated');
  return runJson<Record<string, unknown>>(args);
}

export async function renderServerIdentitySshConfig(includeDeprecated = false): Promise<string> {
  const args = ['render-ssh-config'];
  if (includeDeprecated) args.push('--include-deprecated');
  const { stdout } = await runServerIdentityCli(args);
  return stdout;
}
