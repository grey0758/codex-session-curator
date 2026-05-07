import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export function getCodexHome(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
}

export function getStatePath(codexHome: string): string {
  return resolve(process.env.CODEX_CURATOR_STATE || join(codexHome, 'session-curator-state.json'));
}

export function getSessionsRoot(codexHome: string): string {
  return join(codexHome, 'sessions');
}

export function getShellSnapshotsRoot(codexHome: string): string {
  return join(codexHome, 'shell_snapshots');
}

export function getRecycleRoot(): string {
  return resolve(process.env.CURATOR_RECYCLE_ROOT || join(process.cwd(), 'session-recycle-bin'));
}

export function assertInside(childPath: string, parentPath: string): void {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  if (child !== parent && !child.startsWith(`${parent}/`)) {
    throw new Error(`Path escapes allowed root: ${child}`);
  }
}

export async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }

  await walk(root);
  return files;
}

export async function findShellSnapshots(codexHome: string, sessionId: string): Promise<string[]> {
  const root = getShellSnapshotsRoot(codexHome);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${sessionId}.`))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export async function countShellSnapshots(codexHome: string): Promise<Map<string, number>> {
  const root = getShellSnapshotsRoot(codexHome);
  const counts = new Map<string, number>();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const sessionId = entry.name.split('.')[0];
      if (!sessionId) continue;
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    }
  } catch {
    // Missing shell snapshot directory is fine.
  }
  return counts;
}

export async function removeHistoryEntriesBatch(codexHome: string, sessionIds: string[]): Promise<Map<string, number>> {
  const targetIds = new Set(sessionIds.filter(Boolean));
  const removedBySessionId = new Map<string, number>();
  if (!targetIds.size) return removedBySessionId;

  const historyPath = join(codexHome, 'history.jsonl');
  let historyStat;
  try {
    historyStat = await stat(historyPath);
  } catch {
    return removedBySessionId;
  }

  const backupPath = `${historyPath}.bak`;
  const tempPath = `${historyPath}.tmp-${process.pid}-${Date.now()}`;
  const keptLines: string[] = [];
  const rl = createInterface({ input: createReadStream(historyPath, { encoding: 'utf8' }), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { session_id?: string };
      if (record.session_id && targetIds.has(record.session_id)) {
        removedBySessionId.set(record.session_id, (removedBySessionId.get(record.session_id) ?? 0) + 1);
        continue;
      }
    } catch {
      // Keep malformed history lines instead of risking data loss.
    }
    keptLines.push(line);
  }

  if (removedBySessionId.size === 0) return removedBySessionId;
  await writeFile(tempPath, `${keptLines.join('\n')}${keptLines.length ? '\n' : ''}`, 'utf8');
  try {
    await readFile(backupPath);
  } catch {
    await writeFile(backupPath, await readFile(historyPath, 'utf8'), 'utf8');
  }
  await rename(tempPath, historyPath);
  await writeFile(`${historyPath}.mtime`, `${historyStat.mtimeMs}\n`, 'utf8');
  return removedBySessionId;
}

export async function removeHistoryEntries(codexHome: string, sessionId: string): Promise<number> {
  return (await removeHistoryEntriesBatch(codexHome, [sessionId])).get(sessionId) ?? 0;
}

export async function deleteSessionFiles(input: {
  codexHome: string;
  sessionId: string;
  filePath: string;
}): Promise<{ deletedFiles: string[]; removedHistoryEntries: number }> {
  const sessionsRoot = getSessionsRoot(input.codexHome);
  assertInside(input.filePath, sessionsRoot);

  const deletedFiles: string[] = [];
  await rm(input.filePath, { force: true });
  deletedFiles.push(input.filePath);

  const snapshots = await findShellSnapshots(input.codexHome, input.sessionId);
  for (const snapshot of snapshots) {
    assertInside(snapshot, getShellSnapshotsRoot(input.codexHome));
    await rm(snapshot, { force: true });
    deletedFiles.push(snapshot);
  }

  const removedHistoryEntries = await removeHistoryEntries(input.codexHome, input.sessionId);
  return { deletedFiles, removedHistoryEntries };
}

async function moveFileToArchive(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

export async function archiveSessionFiles(input: {
  codexHome: string;
  sessionId: string;
  filePath: string;
  recycleRoot?: string;
  retentionDays?: number;
  skipHistoryCleanup?: boolean;
}): Promise<{
  archiveDir: string;
  archivedFiles: string[];
  removedOriginalFiles: string[];
  removedHistoryEntries: number;
  expiresAt: string;
}> {
  const sessionsRoot = getSessionsRoot(input.codexHome);
  assertInside(input.filePath, sessionsRoot);

  const recycleRoot = input.recycleRoot ?? getRecycleRoot();
  const deletedAt = new Date();
  const retentionDays = input.retentionDays ?? 30;
  const expiresAt = new Date(deletedAt.getTime() + retentionDays * 86_400_000).toISOString();
  const archiveDir = join(
    recycleRoot,
    `${deletedAt.toISOString().replace(/[:.]/g, '-')}-${input.sessionId}`
  );
  const archivedFiles: string[] = [];
  const removedOriginalFiles: string[] = [];

  const archivedSession = join(archiveDir, 'sessions', basename(input.filePath));
  await moveFileToArchive(input.filePath, archivedSession);
  archivedFiles.push(archivedSession);
  removedOriginalFiles.push(input.filePath);

  const snapshots = await findShellSnapshots(input.codexHome, input.sessionId);
  for (const snapshot of snapshots) {
    assertInside(snapshot, getShellSnapshotsRoot(input.codexHome));
    const archivedSnapshot = join(archiveDir, 'shell_snapshots', basename(snapshot));
    await moveFileToArchive(snapshot, archivedSnapshot);
    archivedFiles.push(archivedSnapshot);
    removedOriginalFiles.push(snapshot);
  }

  const removedHistoryEntries = input.skipHistoryCleanup ? 0 : await removeHistoryEntries(input.codexHome, input.sessionId);
  await writeFile(
    join(archiveDir, 'manifest.json'),
    `${JSON.stringify(
      {
        sessionId: input.sessionId,
        originalSessionFile: input.filePath,
        deletedAt: deletedAt.toISOString(),
        expiresAt,
        retentionDays,
        archivedFiles,
        removedOriginalFiles,
        removedHistoryEntries,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  return { archiveDir, archivedFiles, removedOriginalFiles, removedHistoryEntries, expiresAt };
}

async function updateArchiveHistoryCount(archiveDir: string, removedHistoryEntries: number): Promise<void> {
  const manifestPath = join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.removedHistoryEntries = removedHistoryEntries;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function archiveSessionFilesBulk(input: {
  codexHome: string;
  sessions: Array<{ sessionId: string; filePath: string }>;
  recycleRoot?: string;
  retentionDays?: number;
}): Promise<Array<{
  sessionId: string;
  archiveDir: string;
  archivedFiles: string[];
  removedOriginalFiles: string[];
  removedHistoryEntries: number;
  expiresAt: string;
}>> {
  const archived = [];
  for (const session of input.sessions) {
    const result = await archiveSessionFiles({
      codexHome: input.codexHome,
      sessionId: session.sessionId,
      filePath: session.filePath,
      recycleRoot: input.recycleRoot,
      retentionDays: input.retentionDays,
      skipHistoryCleanup: true,
    });
    archived.push({ sessionId: session.sessionId, ...result });
  }

  const removedBySessionId = await removeHistoryEntriesBatch(
    input.codexHome,
    archived.map((item) => item.sessionId)
  );
  for (const item of archived) {
    item.removedHistoryEntries = removedBySessionId.get(item.sessionId) ?? 0;
    await updateArchiveHistoryCount(item.archiveDir, item.removedHistoryEntries);
  }

  return archived;
}

export async function purgeExpiredArchives(input: {
  recycleRoot?: string;
  now?: Date;
} = {}): Promise<{ purgedArchives: string[] }> {
  const recycleRoot = input.recycleRoot ?? getRecycleRoot();
  const now = input.now ?? new Date();
  const purgedArchives: string[] = [];
  let entries;
  try {
    entries = await readdir(recycleRoot, { withFileTypes: true });
  } catch {
    return { purgedArchives };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const archiveDir = join(recycleRoot, entry.name);
    const manifestPath = join(archiveDir, 'manifest.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { expiresAt?: string };
      const expiresAt = manifest.expiresAt ? Date.parse(manifest.expiresAt) : NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
        await rm(archiveDir, { recursive: true, force: true });
        purgedArchives.push(archiveDir);
      }
    } catch {
      const archiveStat = await stat(archiveDir);
      if (now.getTime() - archiveStat.mtimeMs > 30 * 86_400_000) {
        await rm(archiveDir, { recursive: true, force: true });
        purgedArchives.push(archiveDir);
      }
    }
  }

  return { purgedArchives };
}

export interface RecycleArchive {
  sessionId: string;
  archiveDir: string;
  originalSessionFile: string | null;
  deletedAt: string | null;
  expiresAt: string | null;
  retentionDays: number | null;
  archivedFiles: string[];
  removedOriginalFiles: string[];
  removedHistoryEntries: number;
}

export async function listRecycleArchives(input: { recycleRoot?: string } = {}): Promise<RecycleArchive[]> {
  const recycleRoot = input.recycleRoot ?? getRecycleRoot();
  let entries;
  try {
    entries = await readdir(recycleRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const archives: RecycleArchive[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const archiveDir = join(recycleRoot, entry.name);
    const manifestPath = join(archiveDir, 'manifest.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<RecycleArchive>;
      archives.push({
        sessionId: typeof manifest.sessionId === 'string' ? manifest.sessionId : entry.name.split('-').at(-1) ?? entry.name,
        archiveDir,
        originalSessionFile: typeof manifest.originalSessionFile === 'string' ? manifest.originalSessionFile : null,
        deletedAt: typeof manifest.deletedAt === 'string' ? manifest.deletedAt : null,
        expiresAt: typeof manifest.expiresAt === 'string' ? manifest.expiresAt : null,
        retentionDays: typeof manifest.retentionDays === 'number' ? manifest.retentionDays : null,
        archivedFiles: Array.isArray(manifest.archivedFiles) ? manifest.archivedFiles.filter((item): item is string => typeof item === 'string') : [],
        removedOriginalFiles: Array.isArray(manifest.removedOriginalFiles)
          ? manifest.removedOriginalFiles.filter((item): item is string => typeof item === 'string')
          : [],
        removedHistoryEntries: typeof manifest.removedHistoryEntries === 'number' ? manifest.removedHistoryEntries : 0,
      });
    } catch {
      archives.push({
        sessionId: entry.name,
        archiveDir,
        originalSessionFile: null,
        deletedAt: null,
        expiresAt: null,
        retentionDays: null,
        archivedFiles: [],
        removedOriginalFiles: [],
        removedHistoryEntries: 0,
      });
    }
  }

  return archives.sort((a, b) => Date.parse(b.deletedAt ?? '') - Date.parse(a.deletedAt ?? ''));
}

async function findArchiveBySessionId(recycleRoot: string, sessionId: string): Promise<RecycleArchive | null> {
  const archives = await listRecycleArchives({ recycleRoot });
  return archives.find((archive) => archive.sessionId === sessionId) ?? null;
}

export async function restoreArchive(input: {
  codexHome: string;
  recycleRoot?: string;
  sessionId: string;
}): Promise<{ sessionId: string; restoredFiles: string[]; archiveDir: string }> {
  const recycleRoot = input.recycleRoot ?? getRecycleRoot();
  const archive = await findArchiveBySessionId(recycleRoot, input.sessionId);
  if (!archive) throw new Error(`Recycle archive not found: ${input.sessionId}`);

  const sessionsRoot = getSessionsRoot(input.codexHome);
  const snapshotsRoot = getShellSnapshotsRoot(input.codexHome);
  const restoredFiles: string[] = [];

  for (const archivedFile of archive.archivedFiles) {
    assertInside(archivedFile, archive.archiveDir);
    const fileName = basename(archivedFile);
    const targetRoot = archivedFile.includes('/shell_snapshots/') ? snapshotsRoot : sessionsRoot;
    const preferredOriginal = archive.removedOriginalFiles.find((file) => basename(file) === fileName);
    const target = preferredOriginal ?? join(targetRoot, fileName);
    assertInside(target, targetRoot);
    await mkdir(dirname(target), { recursive: true });
    await moveFileToArchive(archivedFile, target);
    restoredFiles.push(target);
  }

  await rm(archive.archiveDir, { recursive: true, force: true });
  return { sessionId: input.sessionId, restoredFiles, archiveDir: archive.archiveDir };
}

export async function permanentlyDeleteArchive(input: {
  recycleRoot?: string;
  sessionId: string;
}): Promise<{ sessionId: string; purgedArchive: string }> {
  const recycleRoot = input.recycleRoot ?? getRecycleRoot();
  const archive = await findArchiveBySessionId(recycleRoot, input.sessionId);
  if (!archive) throw new Error(`Recycle archive not found: ${input.sessionId}`);
  assertInside(archive.archiveDir, recycleRoot);
  await rm(archive.archiveDir, { recursive: true, force: true });
  return { sessionId: input.sessionId, purgedArchive: archive.archiveDir };
}

export function sameResolvedPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return resolve(a).replace(/\/+$/, '') === resolve(b).replace(/\/+$/, '');
}

export async function copySessionToProject(input: {
  codexHome: string;
  sessionId: string;
  filePath: string;
  targetProjectDir: string;
}): Promise<{
  sourceSessionId: string;
  sourceSessionFile: string;
  targetProjectDir: string;
  newSessionId: string;
  newSessionFile: string;
  verified: boolean;
  verifiedCwd: string | null;
  resumeCommand: string;
  alreadyInTarget: boolean;
}> {
  const sessionsRoot = getSessionsRoot(input.codexHome);
  assertInside(input.filePath, sessionsRoot);
  const target = resolve(input.targetProjectDir);
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) throw new Error(`Target project directory is not a directory: ${target}`);

  const sourceText = await readFile(input.filePath, 'utf8');
  const lineEnd = sourceText.indexOf('\n');
  const firstLine = lineEnd === -1 ? sourceText : sourceText.slice(0, lineEnd);
  const rest = lineEnd === -1 ? '' : sourceText.slice(lineEnd + 1);
  const firstRecord = JSON.parse(firstLine) as Record<string, unknown>;
  if (firstRecord.type !== 'session_meta') throw new Error('First JSONL line is not session_meta');
  const currentCwd =
    firstRecord.payload && typeof firstRecord.payload === 'object'
      ? ((firstRecord.payload as Record<string, unknown>).cwd as string | undefined)
      : undefined;
  if (sameResolvedPath(currentCwd, target)) {
    return {
      sourceSessionId: input.sessionId,
      sourceSessionFile: input.filePath,
      targetProjectDir: target,
      newSessionId: input.sessionId,
      newSessionFile: input.filePath,
      verified: true,
      verifiedCwd: target,
      resumeCommand: `codex resume -C ${target} ${input.sessionId}`,
      alreadyInTarget: true,
    };
  }

  const newSessionId = randomUUID();
  const payload = (firstRecord.payload && typeof firstRecord.payload === 'object'
    ? firstRecord.payload
    : {}) as Record<string, unknown>;
  payload.id = newSessionId;
  payload.cwd = target;
  firstRecord.payload = payload;

  const now = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const newSessionFile = join(dirname(input.filePath), `rollout-${now}-${newSessionId}.jsonl`);
  await writeFile(
    newSessionFile,
    `${JSON.stringify(firstRecord, null, 0)}\n${rest}`,
    'utf8'
  );

  const verifyLine = (await readFile(newSessionFile, 'utf8')).split('\n', 1)[0];
  const verifyRecord = JSON.parse(verifyLine) as { type?: string; payload?: { id?: string; cwd?: string } };
  const verified =
    verifyRecord.type === 'session_meta' &&
    verifyRecord.payload?.id === newSessionId &&
    verifyRecord.payload?.cwd === target;

  return {
    sourceSessionId: input.sessionId,
    sourceSessionFile: input.filePath,
    targetProjectDir: target,
    newSessionId,
    newSessionFile,
    verified,
    verifiedCwd: verifyRecord.payload?.cwd ?? null,
    resumeCommand: `codex resume -C ${target} ${newSessionId}`,
    alreadyInTarget: false,
  };
}

export async function ensureProjectDataDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
