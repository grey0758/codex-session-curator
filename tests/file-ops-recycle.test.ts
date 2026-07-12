import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  archiveSessionFiles,
  listRecycleArchives,
  permanentlyDeleteArchive,
  restoreArchive,
} from '../server/file-ops.js';

test('Claude archive, restore, and purge preserve Codex history and snapshots', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-claude-recycle-'));
  const codexHome = join(testRoot, 'codex-home');
  const claudeProjectsRoot = join(testRoot, 'claude-home', 'projects');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = 'claude-session-fixture';
  const sessionFile = join(claudeProjectsRoot, '-home-grey-work-fixture', `${sessionId}.jsonl`);
  const snapshotFile = join(codexHome, 'shell_snapshots', `${sessionId}.sh`);
  const historyFile = join(codexHome, 'history.jsonl');
  const historyText = `${JSON.stringify({ session_id: sessionId, ts: 1, text: 'must remain' })}\n`;

  await mkdir(join(codexHome, 'shell_snapshots'), { recursive: true });
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, '{"type":"user","message":{"content":"fixture"}}\n', 'utf8');
  await writeFile(snapshotFile, 'snapshot must remain\n', 'utf8');
  await writeFile(historyFile, historyText, 'utf8');

  try {
    const archived = await archiveSessionFiles({
      codexHome,
      claudeProjectsRoot,
      sessionId,
      filePath: sessionFile,
      recycleRoot,
      retentionDays: 30,
    });

    assert.equal(archived.agent, 'claude');
    assert.equal(archived.removedHistoryEntries, 0);
    assert.match(archived.archivedFiles[0], /claude-projects/);
    await assert.rejects(access(sessionFile));
    assert.equal(await readFile(snapshotFile, 'utf8'), 'snapshot must remain\n');
    assert.equal(await readFile(historyFile, 'utf8'), historyText);

    const recycleEntries = await listRecycleArchives({ recycleRoot });
    assert.equal(recycleEntries.length, 1);
    assert.equal(recycleEntries[0].agent, 'claude');
    assert.equal(recycleEntries[0].originalSessionFile, sessionFile);

    const restored = await restoreArchive({
      codexHome,
      claudeProjectsRoot,
      recycleRoot,
      sessionId,
    });
    assert.deepEqual(restored.restoredFiles, [sessionFile]);
    assert.match(await readFile(sessionFile, 'utf8'), /fixture/);
    assert.equal((await listRecycleArchives({ recycleRoot })).length, 0);
    assert.equal(await readFile(snapshotFile, 'utf8'), 'snapshot must remain\n');
    assert.equal(await readFile(historyFile, 'utf8'), historyText);

    const archivedAgain = await archiveSessionFiles({
      codexHome,
      claudeProjectsRoot,
      sessionId,
      filePath: sessionFile,
      recycleRoot,
    });
    const purged = await permanentlyDeleteArchive({ recycleRoot, sessionId });
    assert.equal(purged.purgedArchive, archivedAgain.archiveDir);
    await assert.rejects(access(archivedAgain.archiveDir));
    await assert.rejects(access(sessionFile));
    assert.equal(await readFile(snapshotFile, 'utf8'), 'snapshot must remain\n');
    assert.equal(await readFile(historyFile, 'utf8'), historyText);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('migrated recycle manifests rebase archived file paths to the stable root', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-rebase-'));
  const codexHome = join(testRoot, 'codex-home');
  const recycleRoot = join(testRoot, 'stable-recycle');
  const archiveName = '2026-07-12T00-00-00-000Z-migrated-session';
  const archiveDir = join(recycleRoot, archiveName);
  const archivedFile = join(archiveDir, 'sessions', 'migrated-session.jsonl');
  const oldArchivedFile = join(testRoot, 'old-release', 'session-recycle-bin', archiveName, 'sessions', 'migrated-session.jsonl');
  const originalSessionFile = join(codexHome, 'sessions', '2026', '07', '12', 'migrated-session.jsonl');

  await mkdir(join(archiveDir, 'sessions'), { recursive: true });
  await writeFile(archivedFile, 'migrated fixture\n', 'utf8');
  await writeFile(
    join(archiveDir, 'manifest.json'),
    `${JSON.stringify({
      sessionId: 'migrated-session',
      originalSessionFile,
      deletedAt: '2026-07-12T00:00:00.000Z',
      expiresAt: '2026-08-11T00:00:00.000Z',
      retentionDays: 30,
      archivedFiles: [oldArchivedFile],
      removedOriginalFiles: [originalSessionFile],
      removedHistoryEntries: 0,
    }, null, 2)}\n`,
    'utf8',
  );

  try {
    const [archive] = await listRecycleArchives({ recycleRoot });
    assert.equal(archive.archivedFiles[0], archivedFile);
    const restored = await restoreArchive({ codexHome, recycleRoot, sessionId: 'migrated-session' });
    assert.deepEqual(restored.restoredFiles, [originalSessionFile]);
    assert.equal(await readFile(originalSessionFile, 'utf8'), 'migrated fixture\n');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
