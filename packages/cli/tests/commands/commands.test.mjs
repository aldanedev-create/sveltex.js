import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMANDS, getCommandSpec, DELEGATED_SCRIPTS } from '../../dist/index.js';
import { tempDir, writeFiles, makeProject, run, recorder } from '../helpers.mjs';

test('command registry covers all specified commands', () => {
  assert.equal(COMMANDS.length, 17);
  for (const name of ['create', 'init', 'add', 'remove', 'generate', 'dev', 'build', 'preview', 'check', 'test', 'doctor', 'info', 'routes', 'modules', 'upgrade', 'migrate', 'config']) {
    assert.ok(getCommandSpec(name) !== undefined, name);
  }
  assert.equal(Object.keys(DELEGATED_SCRIPTS).length, 5);
});

test('exit codes: 0 success, 2 usage, and --json is a single stable object', async () => {
  const help = await run(['--help', '--json']);
  assert.equal(help.exitCode, 0);
  assert.equal(help.ok, true);
  assert.equal(help.data.commands.length, 17);
  assert.ok(Array.isArray(help.messages));

  assert.equal((await run([])).exitCode, 2);
  assert.equal((await run(['nope'])).exitCode, 2);
  assert.equal((await run(['create', 'x', '--unknown-flag'])).exitCode, 2);

  const info = await run(['info', '--json'], { cwd: process.cwd() });
  assert.equal(info.exitCode, 0);
  assert.equal(info.command, 'info');
  assert.equal(info.data.cli, '0.1.0');
  assert.equal(info.data.secrets, 'never printed');
});

test('init dry-run previews without writing files or invoking the package manager', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir);
    const { runner, calls } = recorder();
    const result = await run(['init', '--dry-run', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.applied, false);
    assert.equal(calls.length, 0);
    assert.equal((await readFile(join(dir, 'package.json'), 'utf8')).includes('@sveltex/core'), false);
  } finally {
    await cleanup();
  }
});

test('init --no-install writes files, composes hooks, and never invokes install or check', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, {
      files: {
        'src/hooks.server.ts': '// keep this comment\nexport const handle: Handle = auditHandle;\n',
      },
    });
    const { runner, calls } = recorder();
    const result = await run(['init', '--yes', '--no-install', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0, JSON.stringify(result.error));
    assert.equal(result.data.applied, true);
    assert.equal(result.data.installed, false);
    assert.equal(result.data.validation.ran, false);
    assert.equal(calls.length, 0);
    const hooks = await readFile(join(dir, 'src/hooks.server.ts'), 'utf8');
    assert.ok(hooks.includes('// keep this comment'));
    assert.ok(hooks.includes('const userHandle: Handle = auditHandle;'));
    assert.ok(hooks.includes('sequence(createSvelteXHandler(app), userHandle)'));
    assert.ok(result.data.manualSteps.some((step) => step.includes('--no-install')));
  } finally {
    await cleanup();
  }
});

test('init composes an existing handle as userHandle and never executes project config', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, {
      files: {
        'src/hooks.server.ts': "// keep this comment\nexport const handle: Handle = auditHandle;\n",
        'sveltex.config.ts': "throw new Error('CONFIG EXECUTED');\nexport default { app: { name: 'demo' } };\n",
      },
    });
    const { runner, calls } = recorder();
    const result = await run(['init', '--yes', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0, JSON.stringify(result.error));
    const hooks = await readFile(join(dir, 'src/hooks.server.ts'), 'utf8');
    assert.ok(hooks.includes('// keep this comment'));
    assert.ok(hooks.includes('const userHandle: Handle = auditHandle;'));
    assert.ok(hooks.includes('sequence(createSvelteXHandler(app), userHandle)'));
    assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@sveltex/core'], '^0.1.0');
    assert.ok(calls.some((call) => call.args.includes('add')));
    assert.ok(calls.some((call) => call.args.includes('check')));
  } finally {
    await cleanup();
  }
});

test('editing an existing hooks file without --yes is cancelled with exit code 4', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, { files: { 'src/hooks.server.ts': 'export const handle = auditHandle;\n' } });
    const result = await run(['init'], { cwd: dir });
    assert.equal(result.exitCode, 4);
    assert.equal(await readFile(join(dir, 'src/hooks.server.ts'), 'utf8'), 'export const handle = auditHandle;\n');
  } finally {
    await cleanup();
  }
});

test('init refuses non-SvelteKit projects with exit code 3', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, { manifest: { devDependencies: { typescript: '^5.8.0' } } });
    const result = await run(['init', '--yes'], { cwd: dir });
    assert.equal(result.exitCode, 3);
    assert.equal(result.error.code, 'SX_NOT_SVELTEKIT');
  } finally {
    await cleanup();
  }
});

test('add validates integrations, compatibility, dry-run and env-name-only reporting', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir);
    assert.equal((await run(['add', 'smtp'], { cwd: dir })).exitCode, 3);

    const { runner, calls } = recorder();
    const preview = await run(['add', 'cache', 'session', '--dry-run', '--json'], { cwd: dir, runner });
    assert.equal(preview.exitCode, 0);
    assert.equal(preview.data.applied, false);
    assert.equal(calls.length, 0);
    assert.ok(preview.data.manualSteps.some((step) => step.includes('REDIS_URL')));
    assert.equal(JSON.stringify(preview.data).includes('redis://'), false);

    const applied = await run(['add', 'cache', '--json'], { cwd: dir, runner });
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.data.installed, true);
    assert.ok(calls.some((call) => call.command === 'pnpm' && call.args[0] === 'add'));
    assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@sveltex/cache'], '^0.1.0');

    await makeProject(dir, { manifest: { dependencies: { '@sveltex/core': '^9.9.9' } } });
    const incompatible = await run(['add', 'validation'], { cwd: dir });
    assert.equal(incompatible.exitCode, 3);
    assert.equal(incompatible.error.code, 'SX_COMPAT_MISMATCH');
  } finally {
    await cleanup();
  }
});

test('remove only edits the manifest and never deletes user source files', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, { manifest: { dependencies: { '@sveltex/cache': '^0.1.0' } } });
    const before = await readFile(join(dir, 'src/hooks.server.ts'), 'utf8');
    const { runner } = recorder();
    const result = await run(['remove', 'cache', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.data.deletedUserFiles, []);
    assert.equal(await readFile(join(dir, 'src/hooks.server.ts'), 'utf8'), before);
    assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@sveltex/cache'], undefined);
  } finally {
    await cleanup();
  }
});

test('generate refuses overwrites, honours --force and supports dry-run', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir);
    const first = await run(['generate', 'module', 'users', '--json'], { cwd: dir });
    assert.equal(first.exitCode, 0);
    assert.equal(first.data.path, 'src/lib/server/modules/users.ts');
    const content = await readFile(join(dir, 'src/lib/server/modules/users.ts'), 'utf8');
    assert.ok(content.includes('defineModule'));
    assert.equal((await run(['generate', 'module', 'users'], { cwd: dir })).exitCode, 3);
    const forced = await run(['generate', 'module', 'users', '--force', '--json'], { cwd: dir });
    assert.equal(forced.exitCode, 0);
    assert.equal(forced.data.overwritten, true);

    const dry = await run(['generate', 'service', 'billing', '--dry-run', '--json'], { cwd: dir });
    assert.equal(dry.data.applied, false);
    assert.equal(await readFile(join(dir, 'src/lib/server/modules/users.ts'), 'utf8'), content);
  } finally {
    await cleanup();
  }
});

test('delegated commands invoke project scripts and propagate failures', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir);
    const { runner, calls } = recorder();
    const ok = await run(['dev', '--json'], { cwd: dir, runner });
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(calls[0].args.slice(0, 2), ['run', 'dev']);

    const failing = await run(['test'], { cwd: dir, runner: recorder({ default: { exitCode: 5, stdout: '', stderr: 'boom' } }).runner });
    assert.equal(failing.exitCode, 1);
    assert.equal(failing.error.code, 'SX_DELEGATED_COMMAND_FAILED');

    await makeProject(dir, { manifest: { scripts: {} } });
    assert.equal((await run(['build'], { cwd: dir })).exitCode, 3);
  } finally {
    await cleanup();
  }
});

test('inspection commands are static, redacted and never execute project code', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, {
      manifest: { dependencies: { '@sveltex/core': '^0.1.0' } },
      files: {
        'sveltex.config.ts': "import { defineConfig } from '@sveltex/config';\nconst secret = 'DO-NOT-LEAK-123';\nexport default defineConfig({\n  app: { name: 'demo' },\n  apiToken: secret,\n  redisUrl: process.env.TOP_SECRET_ENV,\n  modules: ['./src/lib/server/modules/index']\n});\n",
        'src/routes/+page.svelte': '<h1>Home</h1>',
        'src/lib/server/modules/users.ts': "export const usersModule = defineModule({ name: 'users' });\n",
      },
    });
    const { runner } = recorder();

    const config = await run(['config', '--json'], { cwd: dir, runner });
    assert.equal(config.exitCode, 0);
    assert.equal(config.data.executed, false);
    assert.equal(config.data.redacted, true);
    assert.equal(JSON.stringify(config.data).includes('DO-NOT-LEAK-123'), false);
    assert.ok(config.data.inspection.secretFieldNames.includes('apiToken'));

    const modules = await run(['modules', '--json'], { cwd: dir, runner });
    assert.equal(modules.data.staticInspectionOnly, true);
    assert.ok(modules.data.sourceModules.includes('users'));
    assert.ok(modules.data.configModules.some((entry) => entry.includes('modules/index')));

    const routes = await run(['routes', '--json'], { cwd: dir, runner });
    assert.ok(routes.data.routes.some((entry) => entry.path === '/'));

    const doctor = await run(['doctor', '--json'], { cwd: dir, runner });
    assert.equal(doctor.exitCode, 0);
    assert.equal(doctor.data.healthy, true);

    const info = await run(['info', '--json'], { cwd: dir, runner, env: { TOP_SECRET_ENV: 'DO-NOT-PRINT' } });
    assert.equal(JSON.stringify(info.data).includes('DO-NOT-PRINT'), false);
  } finally {
    await cleanup();
  }
});

test('upgrade uses CLI metadata only, and migrations are preview-first with rollback support', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, { manifest: { dependencies: { '@sveltex/core': '^0.0.1' } } });
    const { runner, calls } = recorder();
    const preview = await run(['upgrade', '--json'], { cwd: dir, runner });
    assert.equal(preview.exitCode, 0);
    assert.equal(preview.data.applied, false);
    assert.equal(preview.data.items[0].needsUpgrade, true);
    assert.equal(preview.data.versionSource.includes('no registry lookup'), true);
    assert.equal(calls.length, 0);

    const applied = await run(['upgrade', '--apply', '--json'], { cwd: dir, runner });
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.data.applied, true);
    assert.ok(calls.some((call) => call.args.includes('@sveltex/core@^0.1.0')));

    const list = await run(['migrate', '--json'], { cwd: dir, runner });
    assert.equal(list.data.available.length, 2);

    const migratePreview = await run(['migrate', 'gitignore-env', '--json'], { cwd: dir, runner });
    assert.equal(migratePreview.data.previewOnly, true);
    assert.equal((await readFile(join(dir, '.gitignore'), 'utf8')).includes('/.env'), false);
    const migrateApplied = await run(['migrate', 'gitignore-env', '--apply', '--json'], { cwd: dir, runner });
    assert.equal(migrateApplied.data.applied, true);
    assert.ok((await readFile(join(dir, '.gitignore'), 'utf8')).includes('/.env'));
    assert.equal((await run(['migrate', 'not-real'], { cwd: dir })).exitCode, 2);
  } finally {
    await cleanup();
  }
});
