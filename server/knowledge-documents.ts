import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface KnowledgeDocumentHeading {
  level: number;
  text: string;
  line: number;
}

export interface CanonicalKnowledgeDocument {
  path: string;
  text: string;
  sourceHash: string;
  gitCommit: string | null;
  bytes: number;
  lineCount: number;
  headings: KnowledgeDocumentHeading[];
  modifiedAt: string;
}

export function getCanonicalKnowledgeRepoPath(): string {
  return resolve(process.env.CURATOR_KNOWLEDGE_REPO || '/home/grey/work/agent-knowledge-stack');
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function allowedPrefixes(): string[] {
  return (process.env.CURATOR_KNOWLEDGE_DOCUMENT_PREFIXES || 'knowledge')
    .split(',')
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function cleanDocumentPath(requestedPath: string): string {
  const clean = requestedPath.trim().replace(/\\/g, '/');
  if (!clean || clean.includes('\0') || isAbsolute(clean)) throw new Error('Invalid knowledge document path');
  const segments = clean.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid knowledge document path');
  }
  if (!clean.toLowerCase().endsWith('.md')) throw new Error('Only Markdown knowledge documents are readable');
  const prefixes = allowedPrefixes();
  if (!prefixes.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`))) {
    throw new Error('Knowledge document path is outside allowed prefixes');
  }
  return clean;
}

function extractHeadings(text: string): KnowledgeDocumentHeading[] {
  const headings: KnowledgeDocumentHeading[] = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].replace(/\s+#+\s*$/, ''), line: index + 1 });
  }
  return headings;
}

async function readGitCommit(repoRoot: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const commit = result.stdout.trim();
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export async function readCanonicalKnowledgeDocument(requestedPath: string): Promise<CanonicalKnowledgeDocument> {
  const cleanPath = cleanDocumentPath(requestedPath);
  const configuredRoot = getCanonicalKnowledgeRepoPath();
  const repoRoot = await realpath(configuredRoot);
  const target = resolve(repoRoot, cleanPath.split('/').join(sep));
  const targetReal = await realpath(target);
  if (!isInside(repoRoot, targetReal)) throw new Error('Knowledge document path escapes canonical repository');

  const info = await stat(targetReal);
  if (!info.isFile()) throw new Error('Knowledge document is not a file');
  const maxBytes = Math.max(1024, Math.min(10 * 1024 * 1024, Number(process.env.CURATOR_KNOWLEDGE_DOCUMENT_MAX_BYTES || 2 * 1024 * 1024)));
  if (info.size > maxBytes) throw new Error('Knowledge document exceeds configured size limit');

  const text = await readFile(targetReal, 'utf8');
  return {
    path: cleanPath,
    text,
    sourceHash: createHash('sha256').update(text).digest('hex'),
    gitCommit: await readGitCommit(repoRoot),
    bytes: Buffer.byteLength(text),
    lineCount: text.split(/\r?\n/).length,
    headings: extractHeadings(text),
    modifiedAt: info.mtime.toISOString(),
  };
}
