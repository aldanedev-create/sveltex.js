import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseArgs, flagString, flagBoolean, globalOptions,
  validateProjectName, toPackageName, safeRelativePath, resolveInside, isInside,
  redactValue, redactEnvAssignments, isSecretKey, REDACTED,
  inspectConfigText, validateSvelteXConfig, composeHooks,
  insertDependencies, removeDependencies,
  TEMPLATES, TEMPLATE_IDS, INTEGRATIONS, SVELTEX_PACKAGE_VERSION, getIntegration, integrationIds,
  isTemplateId, isWelcomeId, getTemplate,
} from '../../dist/index.js';
import { SVELTEX_ROOT } from '../helpers.mjs';

test('parseArgs separates command, positionals, value flags and boolean flags', () => {
  const args = parseArgs(['create', 'my-app', '--template=fullstack', '--package-manager', 'pnpm', '--no-install', '--json', '--', '--literal']);
  assert.equal(args.command, 'create');
  assert.deepEqual(args.positionals, ['my-app', '--literal']);
  assert.equal(flagString(args, 'template'), 'fullstack');
  assert.equal(flagString(args, 'package-manager'), 'pnpm');
  assert.equal(flagBoolean(args, 'no-install'), true);
  assert.equal(flagBoolean(args, 'json'), true);
  assert.equal(globalOptions(args, '/tmp').dryRun, false);
});

test('parseArgs rejects unknown flags, missing values and bad boolean values with exit code 2', () => {
  for (const argv of [['create', 'x', '--nope'], ['create', 'x', '--template'], ['create', 'x', '--template='], ['create', 'x', '--json=yes']]) {
    assert.throws(() => parseArgs(argv), (error) => error.exitCode === 2, argv.join(' '));
  }
});

test('project names reject traversal, separators, shell metacharacters and control characters', () => {
  for (const bad of ['', '.', '..', '../evil', 'a/b', 'foo;rm', 'a$b', 'A B', 'bad`name', 'a\0b', '-leading', 'trailing.']) {
    assert.throws(() => validateProjectName(bad), (error) => error.exitCode === 2, bad);
  }
  assert.equal(validateProjectName('My-App_2'), 'My-App_2');
  assert.equal(toPackageName('My App'), 'my-app');
});

test('safeRelativePath rejects traversal, absolute paths, encoded traversal and NUL', () => {
  for (const bad of ['../x', 'a/../b', '/etc/passwd', 'a\\b', '%2e%2e/x', 'a//b', 'a/./b', 'a/../', 'a\0b', 'C:/x']) {
    assert.throws(() => safeRelativePath(bad), (error) => error.exitCode === 2, bad);
  }
  assert.equal(safeRelativePath('src/routes/+page.svelte'), 'src/routes/+page.svelte');
  assert.ok(isInside('/tmp/root', resolveInside('/tmp/root', 'src/a.ts')));
  assert.equal(isInside('/tmp/root', '/tmp/root-other/a.ts'), false);
});

test('secret redaction deep-clones, never mutates input, and covers configured fields', () => {
  const input = { apiToken: 'TOPSECRET', password: 'p', nested: { clientSecret: 'x' }, safe: 'visible', customThing: 'hidden' };
  const output = redactValue(input, ['customThing']);
  assert.equal(output.apiToken, REDACTED);
  assert.equal(output.password, REDACTED);
  assert.equal(output.nested.clientSecret, REDACTED);
  assert.equal(output.customThing, REDACTED);
  assert.equal(output.safe, 'visible');
  assert.equal(input.apiToken, 'TOPSECRET');
  assert.ok(Object.isFrozen(output));
  assert.equal(isSecretKey('PRIVATE_KEY'), true);
  assert.equal(isSecretKey('connectionString'), true);
  assert.equal(isSecretKey('appName'), false);
  assert.equal(redactEnvAssignments('API_TOKEN=abc\nNAME=visible\nEMPTY='), `API_TOKEN=${REDACTED}\nNAME=visible\nEMPTY=`);
});

test('configuration is inspected statically and never executed', () => {
  const source = [
    "import { defineConfig } from '@sveltex/config';",
    "throw new Error('CONFIG WAS EXECUTED');",
    'export default defineConfig({',
    "  app: { name: 'demo' },",
    "  apiToken: 'SUPERSECRET',",
    "  database: { password: 'hunter2' },",
    '  modules: [],',
    '  redisUrl: process.env.REDIS_URL',
    '});',
  ].join('\n');
  const inspection = inspectConfigText(source);
  assert.equal(inspection.hasDefaultExport, true);
  assert.ok(inspection.importNames.includes('@sveltex/config'));
  assert.ok(inspection.topLevelKeys.includes('app'));
  assert.ok(inspection.secretFieldNames.includes('apiToken'));
  assert.ok(inspection.referencedEnvNames.includes('REDIS_URL'));
  assert.equal(inspection.issues.length, 0);
  assert.equal(inspectConfigText('export default {}').unsafeExecDetected, false);
  assert.equal(inspectConfigText('const x = eval(input);').unsafeExecDetected, true);
  assert.deepEqual(inspectConfigText('const x = 1;').issues, ['SX_CONFIG_NO_DEFAULT_EXPORT']);
});

test('config shape validation is delegated to @sveltex/config', () => {
  assert.equal(validateSvelteXConfig({ app: { name: 'demo' }, modules: [] }).success, true);
  assert.equal(validateSvelteXConfig({ app: {} }).success, false);
  assert.equal(validateSvelteXConfig({ app: { name: 'x' }, modules: 'wrong' }).success, false);
  assert.equal(validateSvelteXConfig(null).success, false);
});

test('hooks composition preserves existing user handles instead of replacing them', () => {
  const missing = composeHooks(undefined);
  assert.equal(missing.reason, 'missing');
  assert.ok(missing.content.includes('createSvelteXHandler'));
  assert.ok(missing.content.includes('sequence'));

  const already = composeHooks('export const handle = createSvelteXHandler(app);');
  assert.equal(already.changed, false);
  assert.equal(already.reason, 'already-composed');

  const original = '// my comment\nexport const handle: Handle = auditHandle;\n';
  const composed = composeHooks(original);
  assert.equal(composed.reason, 'composed');
  assert.ok(composed.content.includes('// my comment'));
  assert.ok(composed.content.includes('const userHandle: Handle = auditHandle;'));
  assert.ok(composed.content.includes('sequence(createSvelteXHandler(app), userHandle)'));
  assert.equal(composeHooks('export async function handle() {}').changed, false);
});

test('manifest edits are minimal, idempotent and keep valid JSON', () => {
  const source = '{\n  "name": "demo",\n  "dependencies": {\n    "a": "1"\n  },\n  "devDependencies": {\n    "t": "2"\n  }\n}\n';
  const inserted = insertDependencies(source, [{ name: '@sveltex/core', version: '^0.1.0' }]);
  const parsed = JSON.parse(inserted);
  assert.equal(parsed.dependencies.a, '1');
  assert.equal(parsed.dependencies['@sveltex/core'], '^0.1.0');
  assert.equal(parsed.devDependencies.t, '2');
  assert.equal(insertDependencies(inserted, [{ name: '@sveltex/core', version: '^0.1.0' }]), inserted);
  assert.equal(insertDependencies(source, [{ name: '@sveltex/testing', version: '^0.1.0' }], 'devDependencies').includes('@sveltex/testing'), true);

  const removed = removeDependencies(inserted, ['@sveltex/core', 't']);
  const after = JSON.parse(removed);
  assert.deepEqual(after.dependencies, { a: '1' });
  assert.deepEqual(after.devDependencies, {});

  const created = insertDependencies('{\n  "name": "empty"\n}\n', [{ name: '@sveltex/core', version: '^0.1.0' }]);
  assert.equal(JSON.parse(created).dependencies['@sveltex/core'], '^0.1.0');
});

test('integration registry matches the real workspace package versions and names', async () => {
  assert.equal(SVELTEX_PACKAGE_VERSION, '0.1.0');
  assert.equal(INTEGRATIONS.length, 14);
  assert.equal(integrationIds().length, 14);
  assert.equal(getIntegration('database').packageName, '@sveltex/database');
  assert.equal(getIntegration('@sveltex/cache').envNames.includes('REDIS_URL'), true);
  assert.equal(getIntegration('mail').adapters.includes('@sveltex/mail/test-transport'), true);
  assert.equal(getIntegration('smtp'), undefined);

  const directories = await readdir(join(SVELTEX_ROOT, 'packages'));
  let checked = 0;
  for (const directory of directories) {
    let raw;
    try { raw = await readFile(join(SVELTEX_ROOT, 'packages', directory, 'package.json'), 'utf8'); } catch { continue; }
    const manifest = JSON.parse(raw);
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@sveltex/')) {
      assert.equal(manifest.version, SVELTEX_PACKAGE_VERSION, manifest.name);
      assert.ok(getIntegration(manifest.name) !== undefined, manifest.name);
      checked += 1;
    }
  }
  assert.equal(checked, 14);
});

test('integration registry advertises only real package subpath exports (no fake providers)', async () => {
  // Each advertised adapter must resolve to a real entry in that package's
  // `exports` map. This keeps CLI hints honest as packages gain new adapters.
  for (const entry of INTEGRATIONS) {
    const directory = entry.packageName.replace(/^@sveltex\//, '');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(SVELTEX_ROOT, 'packages', directory, 'package.json'), 'utf8'));
    } catch {
      assert.fail(`${entry.packageName}: manifest missing under packages/${directory}`);
    }
    assert.ok(manifest.exports && typeof manifest.exports === 'object', `${entry.packageName}: no exports map`);
    for (const adapter of entry.adapters) {
      assert.ok(adapter.startsWith(`${entry.packageName}/`), `${adapter} must be a subpath of ${entry.packageName}`);
      const subpath = `.${adapter.slice(entry.packageName.length)}`;
      assert.ok(Object.hasOwn(manifest.exports, subpath), `${entry.packageName} does not export ${subpath}`);
    }
  }
  // Phase 8: real SMTP/HTTP/MIME/auth adapters must be advertised, not denied.
  for (const name of ['test-transport', 'smtp', 'http', 'mime', 'auth']) {
    assert.equal(getIntegration('mail').adapters.includes(`@sveltex/mail/${name}`), true, name);
  }
  assert.equal(getIntegration('storage').adapters.includes('@sveltex/storage/s3'), true);
  assert.equal(getIntegration('realtime').adapters.includes('@sveltex/realtime/websocket'), true);
  assert.equal(getIntegration('jobs').adapters.includes('@sveltex/jobs/redis'), true);
  assert.ok(!getIntegration('mail').configHint.includes('No SMTP/HTTP provider is shipped'));
});

test('six templates are distinct, complete and only reference shipped integrations', () => {
  assert.equal(TEMPLATES.length, 6);
  assert.equal(TEMPLATE_IDS.length, 6);
  assert.equal(isTemplateId('saas'), true);
  assert.equal(isTemplateId('billing'), false);
  assert.equal(isWelcomeId('docs'), true);
  assert.equal(isWelcomeId('pricing'), false);
  for (const template of TEMPLATES) {
    assert.equal(getTemplate(template.id).id, template.id);
    assert.ok(template.exampleRoutes.length > 0);
    assert.ok(template.welcomeChoices.includes(template.defaultWelcome));
    assert.ok(template.sveltexPackages.length >= 2);
    for (const id of template.sveltexPackages) assert.ok(getIntegration(id) !== undefined, id);
  }
  assert.notDeepEqual(getTemplate('minimal').sveltexPackages, getTemplate('fullstack').sveltexPackages);
});
