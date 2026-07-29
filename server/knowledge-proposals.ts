import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { basename, join, posix } from 'node:path';
import type {
  KnowledgeProposal,
  KnowledgeProposalApplyResult,
  KnowledgeProposalChange,
  KnowledgeProposalPublishMode,
  KnowledgeProposalPublishResult,
  KnowledgeProposalRiskClass,
} from './types.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CHANGE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
];

const SECRET_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|sqlite3?|db))(?:$|\/)/i;

function normalizedProposalPath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new Error(`Invalid proposal path: ${value || '(empty)'}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Proposal path must be normalized and repository-relative: ${value}`);
  }
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`Proposal path contains a forbidden component: ${value}`);
  }
  if (SECRET_PATH_PATTERN.test(normalized)) {
    throw new Error(`Proposal path looks like secret or runtime data: ${value}`);
  }

  if (normalized.startsWith('knowledge/')) {
    if (!normalized.endsWith('.md')) {
      throw new Error(`Canonical knowledge proposals may only change Markdown: ${value}`);
    }
    return normalized;
  }

  if (normalized.startsWith('skills/shared/')) {
    const parts = normalized.split('/');
    if (parts.length < 4 || !SKILL_NAME_PATTERN.test(parts[2])) {
      throw new Error(`Shared skill proposal path is incomplete or invalid: ${value}`);
    }
    return normalized;
  }

  throw new Error(`Proposal path is outside knowledge/ and skills/shared/: ${value}`);
}

function assertNoSecrets(path: string, content: string): void {
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(content)) {
      throw new Error(`Proposal ${path} contains a possible ${secret.name}`);
    }
  }
}

export function normalizeProposalChanges(changes: KnowledgeProposalChange[]): KnowledgeProposalChange[] {
  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized = changes.map((change) => {
    const path = normalizedProposalPath(change.path);
    if (seen.has(path)) throw new Error(`Proposal contains duplicate path: ${path}`);
    seen.add(path);
    if (change.baseSha256 !== null && !SHA256_PATTERN.test(change.baseSha256)) {
      throw new Error(`Proposal ${path} has an invalid baseSha256`);
    }
    if (change.mode !== '100644' && change.mode !== '100755') {
      throw new Error(`Proposal ${path} has an unsupported mode`);
    }
    if (change.operation === 'upsert') {
      if (typeof change.content !== 'string') throw new Error(`Proposal ${path} upsert requires text content`);
      if (change.content.includes('\0')) throw new Error(`Proposal ${path} contains NUL bytes`);
      const bytes = Buffer.byteLength(change.content, 'utf8');
      if (bytes > MAX_CHANGE_BYTES) throw new Error(`Proposal ${path} exceeds ${MAX_CHANGE_BYTES} bytes`);
      totalBytes += bytes;
      assertNoSecrets(path, change.content);
    } else if (change.operation === 'delete') {
      if (change.content !== null) throw new Error(`Proposal ${path} delete content must be null`);
      if (change.baseSha256 === null) throw new Error(`Proposal ${path} cannot delete a missing base file`);
    } else {
      throw new Error(`Proposal ${path} has an unsupported operation`);
    }
    return { ...change, path };
  });
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Proposal content exceeds ${MAX_TOTAL_BYTES} bytes`);
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

export function classifyProposalRisk(changes: KnowledgeProposalChange[]): KnowledgeProposalRiskClass {
  if (changes.some((change) => (
    change.path.startsWith('knowledge/decisions/')
    || change.path.startsWith('knowledge/inventories/')
    || /(?:security|secret|credential|openbao|disaster-recovery)/i.test(change.path)
  ))) return 'protected';
  if (changes.some((change) => change.path.startsWith('skills/shared/'))) return 'shared_skill';
  return 'ordinary';
}

export function proposalPayloadMatches(
  proposal: KnowledgeProposal,
  candidate: Pick<KnowledgeProposal, 'localId' | 'baseSourceHash' | 'reason' | 'sourceMachineId' | 'sourceSessionId' | 'changes'>,
): boolean {
  return JSON.stringify({
    localId: proposal.localId,
    baseSourceHash: proposal.baseSourceHash,
    reason: proposal.reason,
    sourceMachineId: proposal.sourceMachineId,
    sourceSessionId: proposal.sourceSessionId,
    changes: proposal.changes,
  }) === JSON.stringify(candidate);
}

export function proposalApplyTokenMatches(header: string | string[] | undefined): boolean {
  const configured = process.env.CURATOR_PROPOSAL_APPLY_TOKEN;
  const presented = Array.isArray(header) ? header[0] : header;
  if (!configured || !presented) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isProposalApplyConfigured(): boolean {
  return Boolean(process.env.CURATOR_PROPOSAL_APPLY_TOKEN);
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return Buffer.byteLength(next) <= MAX_OUTPUT_BYTES ? next : next.slice(-MAX_OUTPUT_BYTES);
}

async function runCommand(command: string, args: string[], input: string | null, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout,
        stderr: signal ? `${stderr}\nterminated by ${signal}`.trim() : stderr,
      });
    });
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

function parseHelperPayload(output: string): Record<string, unknown> | null {
  const lines = output.trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Keep looking for the helper's final JSON record.
    }
  }
  return null;
}

export class KnowledgeProposalApplyError extends Error {
  readonly kind: 'conflict' | 'failed';

  constructor(kind: 'conflict' | 'failed', message: string) {
    super(message);
    this.name = 'KnowledgeProposalApplyError';
    this.kind = kind;
  }
}

async function applyCanonicalProposal(proposal: KnowledgeProposal): Promise<Omit<KnowledgeProposalApplyResult, 'publish'>> {
  const opsDir = process.env.CURATOR_OPS_DIR || '/home/grey/work/ops-agent-knowledge-stack';
  const command = process.env.CURATOR_KNOWLEDGE_PROPOSAL_APPLY_COMMAND
    || join(opsDir, 'scripts', 'apply-knowledge-proposal.py');
  const timeoutMs = Number(process.env.CURATOR_KNOWLEDGE_PROPOSAL_APPLY_TIMEOUT_MS || 300_000);
  const processResult = await runCommand(command, [], JSON.stringify(proposal), timeoutMs);
  const payload = parseHelperPayload(processResult.stdout);
  if (processResult.code !== 0 || payload?.ok !== true) {
    const kind = processResult.code === 3 || payload?.kind === 'conflict' ? 'conflict' : 'failed';
    const detail = typeof payload?.error === 'string'
      ? payload.error
      : processResult.stderr.trim() || `proposal apply helper exited ${processResult.code}`;
    throw new KnowledgeProposalApplyError(kind, detail.slice(0, 4000));
  }

  const preSourceHash = typeof payload.preSourceHash === 'string' ? payload.preSourceHash : '';
  const postSourceHash = typeof payload.postSourceHash === 'string' ? payload.postSourceHash : '';
  const changedFiles = Array.isArray(payload.changedFiles)
    ? payload.changedFiles.filter((value): value is string => typeof value === 'string')
    : [];
  const validations = Array.isArray(payload.validations)
    ? payload.validations.filter((value): value is string => typeof value === 'string')
    : [];
  const backupPath = typeof payload.backupPath === 'string' ? payload.backupPath : '';
  if (!SHA256_PATTERN.test(preSourceHash) || !SHA256_PATTERN.test(postSourceHash) || !backupPath) {
    throw new KnowledgeProposalApplyError('failed', 'proposal apply helper returned an invalid result');
  }
  return { preSourceHash, postSourceHash, changedFiles, validations, backupPath };
}

async function publishCanonicalKnowledge(mode: KnowledgeProposalPublishMode): Promise<KnowledgeProposalPublishResult> {
  if (mode === 'none') return { mode, status: 'skipped', outputTail: '', error: null };
  const opsDir = process.env.CURATOR_OPS_DIR || '/home/grey/work/ops-agent-knowledge-stack';
  const command = join(opsDir, 'scripts', mode === 'workers' ? 'worker-knowledge-mirrors-sync.sh' : 'fleet-knowledge-sync.sh');
  const timeoutMs = Number(process.env.CURATOR_KNOWLEDGE_PROPOSAL_PUBLISH_TIMEOUT_MS || 1_200_000);
  const processResult = await runCommand(command, [], null, timeoutMs);
  const outputTail = `${processResult.stdout}\n${processResult.stderr}`.trim().slice(-16_000);
  if (processResult.code !== 0) {
    return {
      mode,
      status: 'failed',
      outputTail,
      error: `${basename(command)} exited ${processResult.code}`,
    };
  }
  return { mode, status: 'completed', outputTail, error: null };
}

export async function executeKnowledgeProposal(
  proposal: KnowledgeProposal,
  publishMode: KnowledgeProposalPublishMode,
): Promise<{ result: KnowledgeProposalApplyResult; warning: string | null }> {
  const applied = await applyCanonicalProposal(proposal);
  const publish = await publishCanonicalKnowledge(publishMode);
  return {
    result: { ...applied, publish },
    warning: publish.error,
  };
}
