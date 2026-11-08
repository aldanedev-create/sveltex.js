import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  safeRelativePath, validateProjectName, resolveInside, redactValue, REDACTED,
  buildAddCommand, defaultRunner, ChangeSet, inspectConfigText,
} from '../../dist/index.js';
import { tempDir, writeFiles, makeProject, run, recorder } from '../helpers.mjs';

test('SEC: project names cannot escape the target directory or inject shell syntax', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    for (const name of ['../escape', 'a/b', 'evil;rm -rf /', '$(whoami)', 'back`tick', '..', '-x', 'bad\0name']) {
      const result = await run(['create', name, '--no-install', '--no-git', '--json'], { cwd: dir });
      assert.equal(result.exitCode, 2, name);
      assert.equal(existsSync(join(dir, '..', 'escape')), false);
    }
    assert.equal(existsSync(join(dir, 'package.json')), false);
  } finally {
    await cleanup();
  }
});

test('SEC: generated paths reject traversal and encoded traversal', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir);
    for (const name of ['../evil', 'a/../../b', '/etc/passwd', 'a\\b', '%2e%2e/secret', 'a\0b']) {
      const result = await run(['generate', 'module', name, '--json'], { cwd: dir });
      assert.equal(result.exitCode, 2, name);
    }
    for (const bad of ['../x', 'a/../b', 'C:\\tmp', 'a//b', 'a/./b', '%2fetc']) {
      assert.throws(() => safeRelativePath(bad), (error) => error.code === 'SX_CLI_PATH_TRAVERSAL' || error.exitCode === 2, bad);
    }
    assert.ok(resolveInside(dir, 'src/routes/+page.svelte').startsWith(dir));
    assert.equal(validateProjectName('safe-name'), 'safe-name');
  } finally {
    await cleanup();
  }
});

test('SEC: package specifiers and script names never reach a shell', () => {
  for (const bad of ['pkg; rm -rf /', 'pkg && touch /tmp/x', 'pkg`id`', 'pkg|cat', '']) {
    assert.throws(() => buildAddCommand('pnpm', [bad]), (error) => error.exitCode === 2);
  }
  assert.throws(() => buildAddCommand('pnpm', ['@sveltex/core', '--ignore-scripts']), (error) => error.exitCode === 2);
});

test('SEC: defaultRunner does not interpret shell metacharacters', async () => {
  const marker = '/tmp/sveltex-cli-shell-probe';
  const result = await defaultRunner(`echo pwn > ${marker}`, [], { cwd: process.cwd() });
  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(marker), false);
});

test('SEC: config diagnostics never execute config and never print secret values', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, {
      files: {
        'sveltex.config.ts': [
          "import { defineConfig } from '@sveltex/config';",
          "throw new Error('CONFIG WAS EXECUTED');",
          'const value = eval("1+1");',
          'export default defineConfig({',
          "  app: { name: 'demo' },",
          "  apiToken: 'SUPER-SECRET-VALUE',",
          "  password: 'ANOTHER-SECRET',",
          '  redisUrl: process.env.REDIS_URL,',
          '  modules: []',
          '});',
        ].join('\n'),
      },
    });
    const { runner } = recorder();
    const config = await run(['config', '--json'], { cwd: dir, runner });
    assert.equal(config.exitCode, 0);
    assert.equal(config.data.executed, false);
    const serialized = JSON.stringify(config.data);
    assert.equal(serialized.includes('SUPER-SECRET-VALUE'), false);
    assert.equal(serialized.includes('ANOTHER-SECRET'), false);
    assert.equal(serialized.includes('CONFIG WAS EXECUTED'), false);
    assert.equal(config.data.inspection.unsafeExecDetected, true);
    assert.ok(config.data.inspection.secretFieldNames.includes('apiToken'));

    const doctor = await run(['doctor', '--json'], { cwd: dir, runner, env: { REDIS_URL: 'redis://user:password@host' } });
    assert.equal(JSON.stringify(doctor.data).includes('redis://user:password@host'), false);
    assert.equal(JSON.stringify(doctor.data).includes('SUPER-SECRET-VALUE'), false);
    const envDiagnostic = doctor.data.diagnostics.find((entry) => entry.code === 'SX_ENV_MISSING');
    assert.equal(envDiagnostic, undefined, 'env is set, so only names are ever reported');
    assert.equal(redactValue({ token: 'x' }).token, REDACTED);
  } finally {
    await cleanup();
  }
});

test('SEC: dry-run never writes files, and --force is required to overwrite', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, { files: { 'src/lib/server/modules/index.ts': '// user-owned\nexport const modules = [];\n' } });
    const { runner, calls } = recorder();
    const dry = await run(['init', '--dry-run', '--json'], { cwd: dir, runner });
    assert.equal(dry.data.applied, false);
    assert.equal(calls.length, 0);
    assert.equal(await readFile(join(dir, 'src/lib/server/modules/index.ts'), 'utf8'), '// user-owned\nexport const modules = [];\n');

    const generated = await run(['generate', 'module', 'users', '--json'], { cwd: dir, runner });
    assert.equal(generated.exitCode, 0);
    const original = await readFile(join(dir, 'src/lib/server/modules/users.ts'), 'utf8');
    assert.equal((await run(['generate', 'module', 'users'], { cwd: dir, runner })).exitCode, 3);
    assert.equal(await readFile(join(dir, 'src/lib/server/modules/users.ts'), 'utf8'), original);
  } finally {
    await cleanup();
  }
});

test('SEC: a failed install rolls back every CLI-owned file', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { runner } = recorder({ pnpm: { exitCode: 1, stdout: '', stderr: 'install failed' } });
    const result = await run(['create', 'rollback-app', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 1);
    assert.equal(result.error.code, 'SX_INSTALL_FAILED');
    assert.equal(existsSync(join(dir, 'rollback-app', 'package.json')), false);
    assert.equal(existsSync(join(dir, 'rollback-app', 'src', 'routes', '+page.svelte')), false);
    assert.equal(existsSync(join(dir, 'rollback-app', 'sveltex.config.ts')), false);
  } finally {
    await cleanup();
  }
});

test('SEC: ChangeSet restores previous content on rollback', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const existing = join(dir, 'config.txt');
    await writeFiles(dir, { 'config.txt': 'original\n' });
    const set = new ChangeSet(dir);
    set.add(existing, 'replacement\n');
    set.add(join(dir, 'new', 'file.txt'), 'new content\n');
    const report = await set.apply();
    assert.equal(report.applied, true);
    assert.equal(await readFile(existing, 'utf8'), 'replacement\n');
    const rollback = await set.rollback();
    assert.equal(rollback.rolledBack, true);
    assert.equal(await readFile(existing, 'utf8'), 'original\n');
    assert.equal(existsSync(join(dir, 'new', 'file.txt')), false);
  } finally {
    await cleanup();
  }
});

test('SEC: ChangeSet rolls back already-applied files when a later write fails', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const blocker = join(dir, 'blocker');
    await mkdir(blocker, { recursive: true });
    const first = join(dir, 'first.txt');
    const set = new ChangeSet(dir);
    set.add(first, 'first\n');
    set.add(blocker, 'cannot write into a directory');
    await assert.rejects(() => set.apply(), (error) => error.code === 'SX_CLI_APPLY_FAILED');
    assert.equal(existsSync(first), false);
  } finally {
    await cleanup();
  }
});
