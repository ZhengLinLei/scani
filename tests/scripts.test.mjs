import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  readdir,
  access,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scani docker scripts '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'context'));
  await mkdir(join(dir, 'bin'));
  for (const file of [
    'BUILD.sh',
    'CLEAN.sh',
    'EXPORT.sh',
    'RUN.dev.sh',
    'scripts/common.sh',
    'scripts/clean.mjs',
    'package.json',
    'compose.yaml',
    'compose.dev.yaml',
    'Caddyfile',
    '.env.example',
    'LICENSE',
    'README.md',
    'context/ocr-repair.txt'
  ]) {
    await copyFile(join(root, file), join(dir, file));
  }
  await writeFile(
    join(dir, 'bin/docker'),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> docker-calls
if [[ "$1" == compose && " $* " == *" build "* && -f fail-build ]]; then exit 7; fi
if [[ "$1" == image && "$2" == save ]]; then echo image > "$4"; fi
`,
    { mode: 0o755 }
  );
  return { dir, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } };
}

async function calls(dir) {
  return readFile(join(dir, 'docker-calls'), 'utf8');
}

test('build uses Docker from outside the repo and propagates failed image builds', async (t) => {
  const { dir, env } = await fixture(t);
  await run('bash', [join(dir, 'BUILD.sh'), '--no-cache'], { cwd: tmpdir(), env });
  assert.match(await calls(dir), /compose -p scani .* build --no-cache app/);
  await writeFile(join(dir, 'fail-build'), '');
  await assert.rejects(run('bash', [join(dir, 'BUILD.sh')], { env }), { code: 7 });
});

test('development lifecycle targets only its stack and rejects invalid ports', async (t) => {
  const { dir, env } = await fixture(t);
  await writeFile(join(dir, '.env'), 'UNTRUSTED=$(touch unexpected)\n');
  await run('bash', [join(dir, 'RUN.dev.sh'), '-p', '4201', '--https-port', '8444'], { env });
  assert.match(await calls(dir), /compose -p scani-dev .* up -d --build --wait --wait-timeout 180/);
  await run('bash', [join(dir, 'RUN.dev.sh'), '--stop'], { env });
  assert.match(await calls(dir), /compose -p scani-dev .* stop/);
  await assert.rejects(run('bash', [join(dir, 'RUN.dev.sh'), '-p'], { env }));
  await assert.rejects(run('bash', [join(dir, 'RUN.dev.sh'), '-p', '0'], { env }));
  await assert.rejects(run('bash', [join(dir, 'RUN.dev.sh'), '-p', '65536'], { env }));
  await assert.rejects(access(join(dir, 'unexpected')), { code: 'ENOENT' });
});

test('clean preserves Docker volumes and host scans by default; reset requires consent', async (t) => {
  const { dir, env } = await fixture(t);
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data/scan.jpg'), 'saved');
  await writeFile(join(dir, '.env'), 'SECRET=private');
  await mkdir(join(dir, 'exports'));
  await run('bash', [join(dir, 'CLEAN.sh')], { cwd: tmpdir(), env });
  const cleanCalls = await calls(dir);
  assert.match(cleanCalls, /compose -p scani-dev .* down --remove-orphans/);
  assert.match(cleanCalls, /compose -p scani .* down --remove-orphans/);
  assert.doesNotMatch(cleanCalls, /down .* -v|prune/);
  assert.equal(await readFile(join(dir, 'data/scan.jpg'), 'utf8'), 'saved');
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'SECRET=private');
  await assert.rejects(access(join(dir, 'exports')), { code: 'ENOENT' });
  await assert.rejects(run('bash', [join(dir, 'CLEAN.sh'), '--reset'], { env, timeout: 2000 }));
  assert.doesNotMatch(await calls(dir), /down .* -v/);
  await run('bash', [join(dir, 'RUN.dev.sh'), '--reset', '--yes'], { env });
  const resetCalls = await calls(dir);
  assert.match(resetCalls, /compose -p scani-dev .* down -v --remove-orphans/);
  assert.doesNotMatch(resetCalls, /compose -p scani .* down -v/);
});

test('export packages images and deployment config, excluding scans and secrets', async (t) => {
  const { dir, env } = await fixture(t);
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, '.env'), 'SECRET=private');
  await writeFile(join(dir, 'data/scan.jpg'), 'private');
  await writeFile(join(dir, 'root.key'), 'private');
  await run('bash', [join(dir, 'EXPORT.sh')], { cwd: tmpdir(), env });
  const archives = await readdir(join(dir, 'exports'));
  assert.equal(archives.length, 1);
  const { stdout } = await run('tar', ['-tzf', join(dir, 'exports', archives[0])]);
  assert.deepEqual(
    stdout.trim().split('\n').sort(),
    ['images.tar', 'compose.yaml', 'Caddyfile', '.env.example', 'README.md', 'LICENSE', 'context/ocr-repair.txt'].sort()
  );
  assert.match(await calls(dir), /image save --output .*images.tar scani:local caddy:2-alpine/);
  await writeFile(join(dir, 'fail-build'), '');
  await assert.rejects(run('bash', [join(dir, 'EXPORT.sh')], { env }), { code: 7 });
  assert.deepEqual(await readdir(join(dir, 'exports')), archives);
});
