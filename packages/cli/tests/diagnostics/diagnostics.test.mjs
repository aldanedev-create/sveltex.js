import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, isSupportedNode, NODE_MINIMUM, collectRoutes } from '../../dist/index.js';
import { tempDir, writeFiles, makeProject, run, recorder } from '../helpers.mjs';

function healthyInput(overrides = {}) {
  return {
    // A consistent, healthy project: one package manager, aligned SvelteX
    // versions, TypeScript declared, no process-local adapters in production.
    project: {
      root: '/tmp/healthy-app',
      manifestPath: '/tmp/healthy-app/package.json',
      manifest: {},
      name: 'healthy-app',
      packageManager: 'pnpm',
      declaredPackageManager: undefined,
      lockfiles: [],
      scripts: {},
      dependencies: { '@sveltex/core': '0.1.0', typescript: '^5.8.0' },
      devDependencies: {},
      configPath: '/tmp/healthy-app/sveltex.config.ts',
      svelteConfigPath: undefined,
      hooksPath: '/tmp/healthy-app/src/hooks.server.ts',
    },
    nodeVersion: '22.13.1',
    configSource: "import { defineConfig } from '@sveltex/config';\nexport default defineConfig({\n  app: { name: 'demo' },\n  modules: []\n});",
    hooksSource: 'export const handle = sequence(createSvelteXHandler(app));',
    packageManager: 'pnpm',
    pmVersionExitCode: 0,
    env: {},
    ...overrides,
  };
}

test('node version gate accepts supported releases and rejects old ones', () => {
  assert.equal(isSupportedNode('22.13.1'), true);
  assert.equal(isSupportedNode('20.11.0'), true);
  assert.equal(isSupportedNode('20.10.0'), false);
  assert.equal(isSupportedNode('18.20.0'), false);
  assert.equal(NODE_MINIMUM, '20.11.0');
});

test('doctor reports stable codes, severities, paths and safe fixes', () => {
  const report = runDoctor(healthyInput());
  assert.equal(report.healthy, true);
  const codes = report.diagnostics.map((entry) => entry.code);
  assert.ok(codes.includes('SX_NODE_OK'));
  assert.ok(codes.includes('SX_SVELTEKIT_HOOKS_OK'));
  assert.ok(codes.includes('SX_PROJECT_MISSING') === false);
  for (const diagnostic of report.diagnostics) {
    assert.ok(['error', 'warning', 'info'].includes(diagnostic.severity));
    assert.ok(diagnostic.code.startsWith('SX_'));
    assert.ok(diagnostic.message.length > 0);
  }
});

test('doctor surfaces config, hook, env-name and multi-instance problems', () => {
  const { dir } = { dir: '/tmp/demo' };
  const project = {
    root: dir, manifestPath: `${dir}/package.json`, manifest: {}, name: 'demo',
    packageManager: 'pnpm', declaredPackageManager: undefined, lockfiles: [], scripts: {},
    dependencies: { '@sveltex/jobs': '^0.1.0', '@sveltex/core': '^9.0.0' }, devDependencies: {},
    configPath: undefined, svelteConfigPath: undefined, hooksPath: undefined,
  };
  const report = runDoctor(healthyInput({
    project,
    nodeVersion: '18.0.0',
    configSource: 'const x = 1;\nprocess.env.REDIS_URL;\n',
    hooksSource: undefined,
    pmVersionExitCode: 127,
    env: { SVELTEX_INSTANCES: '3' },
  }));
  const byCode = new Map(report.diagnostics.map((entry) => [entry.code, entry]));
  assert.equal(byCode.get('SX_NODE_UNSUPPORTED').severity, 'error');
  assert.equal(byCode.get('SX_CONFIG_NO_DEFAULT_EXPORT').severity, 'error');
  assert.equal(byCode.get('SX_ENV_MISSING').message.includes('REDIS_URL'), true);
  assert.equal(byCode.get('SX_ENV_MISSING').message.includes('value not read'), true);
  assert.equal(byCode.get('SX_PEER_MISMATCH').severity, 'warning');
  assert.equal(byCode.get('SX_IN_MEMORY_MULTI_INSTANCE').severity, 'warning');
  assert.equal(byCode.get('SX_SVELTEKIT_HOOKS_MISSING').severity, 'warning');
  assert.equal(report.healthy, false);
  assert.equal(report.counts.error >= 2, true);
});

test('doctor never prints environment variable values', () => {
  const report = runDoctor(healthyInput({
    configSource: 'export default defineConfig({\n  app: { name: "x" },\n  redisUrl: process.env.TOP_SECRET_VALUE\n});',
    env: { TOP_SECRET_VALUE: 'DO-NOT-PRINT' },
  }));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('DO-NOT-PRINT'), false);
  assert.equal(report.diagnostics.some((entry) => entry.code === 'SX_ENV_MISSING'), false);
});

test('routes are derived from the filesystem convention only', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await writeFiles(dir, {
      'src/routes/+page.svelte': '<h1>Home</h1>',
      'src/routes/+layout.svelte': '<slot />',
      'src/routes/about/+page.svelte': '<h1>About</h1>',
      'src/routes/api/health/+server.ts': 'export const GET = () => new Response();',
      'src/routes/blog/[slug]/+page.svelte': '<h1>Post</h1>',
      'src/routes/(marketing)/pricing/+page.svelte': '<h1>Pricing</h1>',
      'src/routes/notes.txt': 'ignored',
    });
    const routes = await collectRoutes(dir);
    const paths = routes.map((entry) => entry.path);
    assert.ok(paths.includes('/'));
    assert.ok(paths.includes('/about'));
    assert.ok(paths.includes('/api/health'));
    assert.ok(paths.includes('/blog/:slug'));
    assert.ok(paths.includes('/pricing'));
    assert.equal(paths.some((path) => path.includes('(marketing)')), false);
    const home = routes.find((entry) => entry.path === '/');
    assert.deepEqual(home.kinds, ['layout', 'page']);
    assert.equal(await collectRoutes(`${dir}/nonexistent`).then((r) => r.length), 0);
  } finally {
    await cleanup();
  }
});

test('doctor command returns exit code 3 when errors are present', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await makeProject(dir, { files: { 'sveltex.config.ts': 'const broken = true;\n' } });
    const { runner } = recorder();
    const result = await run(['doctor', '--json'], { cwd: dir, runner, nodeVersion: '18.0.0' });
    assert.equal(result.exitCode, 3);
    assert.equal(result.ok, false);
    assert.equal(result.data.healthy, false);
    assert.ok(result.data.diagnostics.some((entry) => entry.code === 'SX_NODE_UNSUPPORTED'));
  } finally {
    await cleanup();
  }
});
