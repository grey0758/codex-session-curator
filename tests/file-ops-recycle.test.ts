import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  archiveSessionFiles,
  listRecycleArchives,
  permanentlyDeleteArchive,
  restoreArchive,
} from '../server/file-ops.js';

async function writeRecycleArchiveFixture(input: {
  recycleRoot: string;
  codexHome: string;
  claudeProjectsRoot: string;
  archiveName: string;
  sessionId: string;
  agent: 'codex' | 'claude';
  contents: string;
}) {
  const archiveDir = join(input.recycleRoot, input.archiveName);
  const fileName = `${input.archiveName}.jsonl`;
  const archivedFile = input.agent === 'claude'
    ? join(archiveDir, 'claude-projects', 'fixture', fileName)
    : join(archiveDir, 'sessions', fileName);
  const originalSessionFile = input.agent === 'claude'
    ? join(input.claudeProjectsRoot, 'fixture', fileName)
    : join(input.codexHome, 'sessions', '2026', '07', '29', fileName);
  await mkdir(dirname(archivedFile), { recursive: true });
  await writeFile(archivedFile, input.contents, 'utf8');
  await writeFile(
    join(archiveDir, 'manifest.json'),
    `${JSON.stringify({
      sessionId: input.sessionId,
      agent: input.agent,
      originalSessionFile,
      deletedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
      retentionDays: 30,
      archivedFiles: [archivedFile],
      removedOriginalFiles: [originalSessionFile],
      removedHistoryEntries: 0,
    }, null, 2)}\n`,
    'utf8',
  );
  return { archiveDir, archivedFile, originalSessionFile };
}

test('archive directory uses an opaque UUID and remains inside the recycle root', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-opaque-id-'));
  const codexHome = join(testRoot, 'codex-home');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = '../../../escape-session';
  const sessionFile = join(codexHome, 'sessions', '2026', '07', '29', 'fixture.jsonl');

  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, '{"type":"session_meta"}\n', 'utf8');

  try {
    const archived = await archiveSessionFiles({
      codexHome,
      sessionId,
      filePath: sessionFile,
      recycleRoot,
    });

    const relativeArchiveDir = relative(resolve(recycleRoot), resolve(archived.archiveDir));
    assert.notEqual(relativeArchiveDir, '');
    assert.equal(relativeArchiveDir === '..' || relativeArchiveDir.startsWith(`..${sep}`), false);
    assert.equal(relativeArchiveDir.includes('escape-session'), false);
    assert.match(relativeArchiveDir, /-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const manifest = JSON.parse(await readFile(join(archived.archiveDir, 'manifest.json'), 'utf8')) as {
      sessionId: string;
    };
    assert.equal(manifest.sessionId, sessionId);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('restore fails closed and preserves an archive with no archived files', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-empty-'));
  const codexHome = join(testRoot, 'codex-home');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = 'empty-archive';
  const archiveDir = join(recycleRoot, 'empty-archive-fixture');
  const manifestPath = join(archiveDir, 'manifest.json');

  await mkdir(archiveDir, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      sessionId,
      agent: 'codex',
      originalSessionFile: null,
      deletedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
      retentionDays: 30,
      archivedFiles: [],
      removedOriginalFiles: [],
      removedHistoryEntries: 0,
    }, null, 2)}\n`,
    'utf8',
  );

  try {
    await assert.rejects(
      restoreArchive({ codexHome, recycleRoot, sessionId, archiveDir, agent: 'codex' }),
      /no archived files/i,
    );
    await access(archiveDir);
    await access(manifestPath);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('restore fails closed and preserves an archive containing only shell snapshots', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-snapshot-only-'));
  const codexHome = join(testRoot, 'codex-home');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = 'snapshot-only-archive';
  const archiveDir = join(recycleRoot, 'snapshot-only-fixture');
  const archivedSnapshot = join(archiveDir, 'shell_snapshots', `${sessionId}.sh`);
  const originalSnapshot = join(codexHome, 'shell_snapshots', `${sessionId}.sh`);

  await mkdir(dirname(archivedSnapshot), { recursive: true });
  await writeFile(archivedSnapshot, 'archived snapshot\n', 'utf8');
  await writeFile(
    join(archiveDir, 'manifest.json'),
    `${JSON.stringify({
      sessionId,
      agent: 'codex',
      originalSessionFile: null,
      deletedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
      retentionDays: 30,
      archivedFiles: [archivedSnapshot],
      removedOriginalFiles: [originalSnapshot],
      removedHistoryEntries: 0,
    }, null, 2)}\n`,
    'utf8',
  );

  try {
    await assert.rejects(
      restoreArchive({ codexHome, recycleRoot, sessionId, archiveDir, agent: 'codex' }),
      /no Codex or Claude transcript/i,
    );
    assert.equal(await readFile(archivedSnapshot, 'utf8'), 'archived snapshot\n');
    await access(archiveDir);
    await assert.rejects(access(originalSnapshot));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

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

test('duplicate session archives require an exact in-root archive identity', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-identity-'));
  const codexHome = join(testRoot, 'codex-home');
  const claudeProjectsRoot = join(testRoot, 'claude-home', 'projects');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = 'duplicate-session';

  try {
    const codexArchive = await writeRecycleArchiveFixture({
      recycleRoot,
      codexHome,
      claudeProjectsRoot,
      archiveName: 'codex-copy',
      sessionId,
      agent: 'codex',
      contents: 'codex archive\n',
    });
    const claudeArchive = await writeRecycleArchiveFixture({
      recycleRoot,
      codexHome,
      claudeProjectsRoot,
      archiveName: 'claude-copy',
      sessionId,
      agent: 'claude',
      contents: 'claude archive\n',
    });

    await assert.rejects(
      restoreArchive({ codexHome, claudeProjectsRoot, recycleRoot, sessionId }),
      /Multiple recycle archives.*archiveDir is required/,
    );
    await assert.rejects(
      permanentlyDeleteArchive({ recycleRoot, sessionId }),
      /Multiple recycle archives.*archiveDir is required/,
    );
    await assert.rejects(
      permanentlyDeleteArchive({
        recycleRoot,
        sessionId,
        archiveDir: join(testRoot, 'outside-recycle-root'),
        agent: 'codex',
      }),
      /path escapes root/,
    );
    await assert.rejects(
      restoreArchive({
        codexHome,
        claudeProjectsRoot,
        recycleRoot,
        sessionId,
        archiveDir: codexArchive.archiveDir,
        agent: 'claude',
      }),
      /agent mismatch/,
    );
    await assert.rejects(
      permanentlyDeleteArchive({
        recycleRoot,
        sessionId: 'different-session',
        archiveDir: codexArchive.archiveDir,
        agent: 'codex',
      }),
      /session mismatch/,
    );

    await mkdir(dirname(codexArchive.originalSessionFile), { recursive: true });
    await writeFile(codexArchive.originalSessionFile, 'new active session\n', 'utf8');
    await assert.rejects(
      restoreArchive({
        codexHome,
        claudeProjectsRoot,
        recycleRoot,
        sessionId,
        archiveDir: codexArchive.archiveDir,
        agent: 'codex',
      }),
      /EEXIST|exist/i,
    );
    assert.equal(await readFile(codexArchive.originalSessionFile, 'utf8'), 'new active session\n');
    await access(codexArchive.archiveDir);
    await rm(codexArchive.originalSessionFile);

    const restored = await restoreArchive({
      codexHome,
      claudeProjectsRoot,
      recycleRoot,
      sessionId,
      archiveDir: codexArchive.archiveDir,
      agent: 'codex',
    });
    assert.equal(restored.archiveDir, codexArchive.archiveDir);
    assert.equal(await readFile(codexArchive.originalSessionFile, 'utf8'), 'codex archive\n');
    await assert.rejects(access(codexArchive.archiveDir));
    await access(claudeArchive.archiveDir);

    const purged = await permanentlyDeleteArchive({
      recycleRoot,
      sessionId,
      archiveDir: claudeArchive.archiveDir,
      agent: 'claude',
    });
    assert.equal(purged.purgedArchive, claudeArchive.archiveDir);
    await assert.rejects(access(claudeArchive.archiveDir));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('multi-file restore preflights every target before copying any file', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-transaction-'));
  const codexHome = join(testRoot, 'codex-home');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = 'transactional-restore';
  const archiveDir = join(recycleRoot, 'transactional-archive');
  const firstArchived = join(archiveDir, 'sessions', `${sessionId}.jsonl`);
  const secondArchived = join(archiveDir, 'shell_snapshots', `${sessionId}.sh`);
  const firstTarget = join(codexHome, 'sessions', '2026', '07', '29', `${sessionId}.jsonl`);
  const secondTarget = join(codexHome, 'shell_snapshots', `${sessionId}.sh`);

  await mkdir(dirname(firstArchived), { recursive: true });
  await mkdir(dirname(secondArchived), { recursive: true });
  await mkdir(dirname(secondTarget), { recursive: true });
  await writeFile(firstArchived, 'archived session\n', 'utf8');
  await writeFile(secondArchived, 'archived snapshot\n', 'utf8');
  await writeFile(secondTarget, 'new active snapshot\n', 'utf8');
  await writeFile(
    join(archiveDir, 'manifest.json'),
    `${JSON.stringify({
      sessionId,
      agent: 'codex',
      originalSessionFile: firstTarget,
      deletedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
      retentionDays: 30,
      archivedFiles: [firstArchived, secondArchived],
      removedOriginalFiles: [firstTarget, secondTarget],
      removedHistoryEntries: 0,
    }, null, 2)}\n`,
    'utf8',
  );

  try {
    await assert.rejects(
      restoreArchive({
        codexHome,
        recycleRoot,
        sessionId,
        archiveDir,
        agent: 'codex',
      }),
      /target already exists/i,
    );
    await assert.rejects(access(firstTarget));
    assert.equal(await readFile(secondTarget, 'utf8'), 'new active snapshot\n');
    assert.equal(await readFile(firstArchived, 'utf8'), 'archived session\n');
    assert.equal(await readFile(secondArchived, 'utf8'), 'archived snapshot\n');
    await access(archiveDir);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('multi-file restore rolls back earlier targets when a later copy fails', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-recycle-copy-rollback-'));
  const codexHome = join(testRoot, 'codex-home');
  const recycleRoot = join(testRoot, 'recycle');
  const sessionId = 'copy-rollback-restore';
  const archiveDir = join(recycleRoot, 'copy-rollback-archive');
  const firstArchived = join(archiveDir, 'sessions', `${sessionId}.jsonl`);
  const secondArchived = join(archiveDir, 'shell_snapshots', `${sessionId}.sh`);
  const firstTarget = join(codexHome, 'sessions', '2026', '07', '29', `${sessionId}.jsonl`);
  const secondTarget = join(codexHome, 'shell_snapshots', `${sessionId}.sh`);

  await mkdir(dirname(firstArchived), { recursive: true });
  await mkdir(dirname(secondArchived), { recursive: true });
  await writeFile(firstArchived, 'archived session\n', 'utf8');
  await writeFile(secondArchived, 'archived snapshot\n', 'utf8');
  await writeFile(
    join(archiveDir, 'manifest.json'),
    `${JSON.stringify({
      sessionId,
      agent: 'codex',
      originalSessionFile: firstTarget,
      deletedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-08-28T00:00:00.000Z',
      retentionDays: 30,
      archivedFiles: [firstArchived, secondArchived],
      removedOriginalFiles: [firstTarget, secondTarget],
      removedHistoryEntries: 0,
    }, null, 2)}\n`,
    'utf8',
  );

  let copyAttempts = 0;
  try {
    await assert.rejects(
      restoreArchive({
        codexHome,
        recycleRoot,
        sessionId,
        archiveDir,
        agent: 'codex',
        copyArchivedFile: async (source, destination) => {
          copyAttempts += 1;
          if (copyAttempts === 2) throw new Error('injected second copy failure');
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(source, destination);
        },
      }),
      /injected second copy failure/,
    );
    assert.equal(copyAttempts, 2);
    await assert.rejects(access(firstTarget));
    await assert.rejects(access(secondTarget));
    assert.equal(await readFile(firstArchived, 'utf8'), 'archived session\n');
    assert.equal(await readFile(secondArchived, 'utf8'), 'archived snapshot\n');
    await access(archiveDir);
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
