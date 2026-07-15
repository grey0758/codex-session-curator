#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const outputArg = process.argv.find((argument) => argument.startsWith('--output='));
const outputIndex = process.argv.indexOf('--output');
const outputValue = outputArg?.slice('--output='.length) || (outputIndex >= 0 ? process.argv[outputIndex + 1] : null);
const outputDir = resolve(outputValue || join(repoRoot, '.artifacts', 'curator-worker'));

await rm(outputDir, { recursive: true, force: true });
await mkdir(join(outputDir, 'bin'), { recursive: true });
await cp(join(repoRoot, 'server'), join(outputDir, 'server'), { recursive: true });
await rm(join(outputDir, 'server', 'evaluator.ts'), { force: true });
await rm(join(outputDir, 'server', 'analysis-log.ts'), { force: true });
await rm(join(outputDir, 'server', 'knowledge-store.ts'), { force: true });
await cp(join(repoRoot, 'worker', 'package.json'), join(outputDir, 'package.json'));
await cp(join(repoRoot, 'worker', 'package-lock.json'), join(outputDir, 'package-lock.json'));
await cp(join(repoRoot, 'worker', 'worker.env.example'), join(outputDir, 'worker.env.example'));
await cp(join(repoRoot, 'worker', 'client.env.example'), join(outputDir, 'client.env.example'));
await cp(join(repoRoot, 'control-plane', 'bin', 'curator'), join(outputDir, 'bin', 'curator'));
await chmod(join(outputDir, 'bin', 'curator'), 0o755);

const sourcePackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
await writeFile(
  join(outputDir, 'WORKER_BUILD.json'),
  `${JSON.stringify({ source: sourcePackage.name, sourceVersion: sourcePackage.version, role: 'worker' }, null, 2)}\n`,
  'utf8',
);

process.stdout.write(`${outputDir}\n`);
