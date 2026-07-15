import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('worker package excludes frontend, full control plane, and evaluator dependencies', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'curator-worker-package-'));
  const output = join(testRoot, 'worker');
  try {
    await execFileAsync(process.execPath, ['scripts/build-worker-package.mjs', '--output', output], { cwd: repoRoot });
    const packageJson = JSON.parse(await readFile(join(output, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(packageJson.dependencies.react, undefined);
    assert.equal(packageJson.dependencies.vite, undefined);
    assert.equal(packageJson.dependencies['@fastify/static'], undefined);
    assert.equal(packageJson.dependencies['@langchain/langgraph'], undefined);
    assert.equal((await stat(join(output, 'bin', 'curator'))).mode & 0o111, 0o111);
    await access(join(output, 'server', 'index.ts'));
    await assert.rejects(access(join(output, 'server', 'evaluator.ts')));
    await assert.rejects(access(join(output, 'server', 'knowledge-store.ts')));
    await assert.rejects(access(join(output, 'dist')));
    await assert.rejects(access(join(output, 'src')));
    await assert.rejects(access(join(output, 'control-plane')));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
