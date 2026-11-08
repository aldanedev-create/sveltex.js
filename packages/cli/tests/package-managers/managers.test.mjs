import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  LOCKFILE_MAP, PACKAGE_MANAGERS, detectLockfiles, parsePackageManagerField, resolvePackageManager,
  buildAddCommand, buildRemoveCommand, buildRunCommand, buildInstallCommand, buildVersionCommand,
  devCommand, defaultRunner,
} from '../../dist/index.js';
import { tempDir, run } from '../helpers.mjs';

test('lockfile detection recognizes all four supported managers', () => {
  assert.equal(LOCKFILE_MAP.length, 5);
  assert.deepEqual(PACKAGE_MANAGERS, ['pnpm', 'npm', 'yarn', 'bun']);
  const found = detectLockfiles(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'README.md']);
  assert.equal(found.length, 5);
  assert.equal(detectLockfiles(['README.md']).length, 0);
  assert.equal(parsePackageManagerField('pnpm@10.20.0'), 'pnpm');
  assert.equal(parsePackageManagerField('yarn@4.0.0'), 'yarn');
  assert.equal(parsePackageManagerField('deno@1.0.0'), undefined);
  assert.equal(parsePackageManagerField(undefined), undefined);
});

test('conflicting lockfiles stop the command unless the user explicitly chooses', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { writeFiles } = await import('../helpers.mjs');
    await writeFiles(dir, {
      'package.json': '{"name":"demo","version":"1.0.0"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0',
      'package-lock.json': '{}',
    });
    const detected = detectLockfiles(['pnpm-lock.yaml', 'package-lock.json']);
    assert.throws(() => resolvePackageManager({ lockfiles: detected }), (error) => error.code === 'SX_PM_LOCKFILE_CONFLICT' && error.exitCode === 3);
    assert.equal(resolvePackageManager({ lockfiles: detected, explicit: 'pnpm' }), 'pnpm');
    assert.throws(() => resolvePackageManager({ lockfiles: [], explicit: 'deno' }), (error) => error.exitCode === 2);

    const result = await run(['add', 'database', '--package-manager', 'npm', '--dry-run', '--json'], { cwd: dir });
    assert.equal(result.exitCode, 0);
    assert.ok(result.data.files.length >= 0);
  } finally {
    await cleanup();
  }
});

test('packageManager declaration mismatch is reported, never silently resolved', () => {
  const lockfiles = detectLockfiles(['yarn.lock']);
  assert.throws(
    () => resolvePackageManager({ lockfiles, declared: 'pnpm@10.20.0' }),
    (error) => error.code === 'SX_PM_DECLARATION_MISMATCH' && error.exitCode === 3,
  );
  assert.equal(resolvePackageManager({ lockfiles: [], declared: 'bun@1.0.0' }), 'bun');
  assert.equal(resolvePackageManager({ lockfiles: [], declared: undefined }), undefined);
});

test('package-manager invocations are argument arrays for every supported manager', () => {
  for (const pm of PACKAGE_MANAGERS) {
    const add = buildAddCommand(pm, ['@sveltex/core@^0.1.0'], { dev: true });
    assert.equal(add.command, pm);
    assert.ok(add.args.includes('@sveltex/core@^0.1.0'));
    const remove = buildRemoveCommand(pm, ['@sveltex/core']);
    assert.ok(remove.args.includes('@sveltex/core'));
    const script = buildRunCommand(pm, 'dev', ['--host']);
    assert.ok(script.args.includes('dev'));
    assert.ok(script.args.includes('--'));
    assert.ok(script.args.includes('--host'));
    assert.equal(buildInstallCommand(pm).args[0], 'install');
    assert.equal(buildVersionCommand(pm).args[0], '--version');
  }
  assert.equal(devCommand('npm'), 'npm run dev');
  assert.equal(devCommand('pnpm'), 'pnpm dev');
});

test('unsafe package specifiers and script names are rejected', () => {
  assert.throws(() => buildAddCommand('pnpm', ['pkg; rm -rf /']), (error) => error.exitCode === 2);
  assert.throws(() => buildAddCommand('pnpm', []), (error) => error.exitCode === 2);
  assert.throws(() => buildRunCommand('pnpm', 'dev; evil'), (error) => error.exitCode === 2);
});

test('defaultRunner uses a real process with no shell interpretation', async () => {
  const ok = await defaultRunner('node', ['-e', "process.stdout.write('hello')"], { cwd: process.cwd() });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'hello');

  const marker = '/tmp/sveltex-shell-injection-probe';
  const blocked = await defaultRunner(`printf pwned > ${marker}`, [], { cwd: process.cwd() });
  assert.notEqual(blocked.exitCode, 0);
  assert.equal(existsSync(marker), false);

  const failure = await defaultRunner('node', ['-e', 'process.stdout.write("x"); process.exit(7)'], { cwd: process.cwd() });
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.stdout, 'x');
});
