import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  templatesRoot, planCreate, generateFile, GENERATOR_KINDS, isGeneratorKind, validateArtifactName,
  TEMPLATES, TEMPLATE_IDS, getTemplate, OFFICIAL_DOCS_URL,
} from '../../dist/index.js';
import { tempDir, writeFiles } from '../helpers.mjs';

function options(overrides = {}) {
  return {
    name: 'my-app',
    template: 'fullstack',
    welcome: 'welcome',
    packageManager: 'pnpm',
    noInstall: true,
    noGit: true,
    dryRun: true,
    cwd: '/tmp',
    docsUrl: OFFICIAL_DOCS_URL,
    ...overrides,
  };
}

async function walk(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(relative(root, full).split('\\').join('/'));
    }
  }
  await visit(root);
  return output;
}

test('template assets contain all six starters plus shared base and welcome pages', async () => {
  const root = templatesRoot();
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directories, ['_base', '_pages', 'api', 'dashboard', 'documentation', 'fullstack', 'minimal', 'saas'].sort());
  const pages = (await readdir(join(root, '_pages'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(pages, ['blank', 'dashboard', 'docs', 'welcome']);
  for (const id of TEMPLATE_IDS) {
    const files = await readdir(join(root, id));
    assert.ok(files.length >= 2, `${id} has its own files`);
  }
});

test('planCreate produces distinct, complete file plans for all six templates', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const fingerprints = new Set();
    for (const template of TEMPLATES) {
      const plan = await planCreate(options({ cwd: dir, name: `app-${template.id}`, template: template.id, welcome: template.defaultWelcome }));
      const paths = plan.files.map((entry) => entry.path);
      for (const required of ['package.json', 'sveltex.config.ts', 'src/hooks.server.ts', 'src/routes/+page.svelte', 'README.md', 'src/lib/server/sveltex.ts', '.gitignore']) {
        assert.ok(paths.includes(required), `${template.id} missing ${required}`);
      }
      assert.ok(plan.dependencies.length >= 2);
      assert.ok(plan.files.every((entry) => entry.action === 'create'));
      fingerprints.add(paths.join('\n'));
    }
    assert.equal(fingerprints.size, 6, 'every template generates a distinct file set');
  } finally {
    await cleanup();
  }
});

test('planCreate rejects invalid names, unsupported welcome pages and non-empty targets', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await assert.rejects(() => planCreate(options({ cwd: dir, name: '../evil' })), (error) => error.exitCode === 2);
    await assert.rejects(() => planCreate(options({ cwd: dir, template: 'minimal', welcome: 'dashboard' })), (error) => error.exitCode === 2);
    await writeFiles(dir, { 'existing/keep.txt': 'user content' });
    await assert.rejects(() => planCreate(options({ cwd: dir, name: 'existing' })), (error) => error.exitCode === 3);
  } finally {
    await cleanup();
  }
});

test('rendered templates have no unresolved placeholders, a valid manifest and real example routes', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    for (const template of TEMPLATES) {
      const name = `render-${template.id}`;
      const plan = await planCreate(options({ cwd: dir, name, template: template.id, welcome: template.defaultWelcome, dryRun: false }));
      await plan.changeSet.apply();
      const files = await walk(plan.targetDir);
      for (const file of files) {
        const content = await readFile(join(plan.targetDir, file), 'utf8');
        assert.equal(/\{\{[A-Z_]+\}\}/.test(content), false, `${template.id}/${file} has an unresolved placeholder`);
      }
      const manifest = JSON.parse(await readFile(join(plan.targetDir, 'package.json'), 'utf8'));
      assert.equal(manifest.name, name);
      assert.equal(manifest.scripts.dev, 'vite dev');
      for (const spec of plan.dependencies) {
        const [packageName, version] = spec.split('@^');
        assert.equal(manifest.dependencies[packageName], `^${version}`, `${template.id}/${packageName}`);
      }
      for (const route of template.exampleRoutes) {
        const page = route === '/' ? 'src/routes/+page.svelte' : `src/routes${route}/+page.svelte`;
        const endpoint = `src/routes${route}/+server.ts`;
        assert.ok(files.includes(page) || files.includes(endpoint), `${template.id} advertises ${route} but has no file`);
      }
      const config = await readFile(join(plan.targetDir, 'sveltex.config.ts'), 'utf8');
      assert.ok(config.includes('defineConfig'));
      assert.ok(config.includes(name));
      const hooks = await readFile(join(plan.targetDir, 'src/hooks.server.ts'), 'utf8');
      assert.ok(hooks.includes('createSvelteXHandler'));
      assert.ok(hooks.includes('sequence'));
    }
  } finally {
    await cleanup();
  }
});

test('all four welcome choices produce different real SvelteKit pages', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const pages = [];
    for (const welcome of ['welcome', 'blank', 'dashboard', 'docs']) {
      const plan = await planCreate(options({ cwd: dir, name: `welcome-${welcome}`, welcome, dryRun: false }));
      await plan.changeSet.apply();
      pages.push(await readFile(join(plan.targetDir, 'src/routes/+page.svelte'), 'utf8'));
    }
    assert.equal(new Set(pages).size, 4);
    assert.ok(pages[0].includes('pnpm dev'));
    assert.ok(pages[0].includes(OFFICIAL_DOCS_URL));
    assert.ok(pages[0].includes('SvelteKit'));
    assert.ok(pages[0].includes('<style>'));
    assert.ok(pages[0].includes('prefers-color-scheme'));
    assert.ok(pages[0].includes('aria-labelledby'));
    assert.ok(pages[2].includes('UI shell only'));
    assert.ok(pages[1].length < pages[0].length);
  } finally {
    await cleanup();
  }
});

test('generators produce compiling-shaped files for every kind and reject traversal', () => {
  assert.equal(GENERATOR_KINDS.length, 6);
  assert.equal(isGeneratorKind('module'), true);
  assert.equal(isGeneratorKind('billing'), false);
  for (const kind of GENERATOR_KINDS) {
    const file = generateFile({ kind, name: 'user-profile' });
    assert.ok(file.relativePath.startsWith('src/') || file.relativePath.startsWith('tests/'));
    assert.ok(file.content.length > 40);
    assert.equal(file.relativePath.includes('..'), false);
  }
  assert.ok(generateFile({ kind: 'module', name: 'user' }).content.includes('defineModule'));
  assert.ok(generateFile({ kind: 'route', name: 'health' }).content.includes('RequestHandler'));
  assert.ok(generateFile({ kind: 'component', name: 'card' }).content.includes('$props()'));
  assert.equal(validateArtifactName('nested/service'), 'nested/service');
  for (const bad of ['../evil', 'a/../../b', '1bad', 'a$b']) {
    assert.throws(() => validateArtifactName(bad), (error) => error.exitCode === 2, bad);
  }
});

test('saas starter makes no fake billing or implied-auth claims', async () => {
  const root = templatesRoot();
  const readme = await readFile(join(root, 'saas', 'README.md.tmpl'), 'utf8');
  assert.match(readme, /NOT included and NOT implied/);
  assert.match(readme, /Billing, subscriptions, or payments of any kind/);
  const page = await readFile(join(root, 'saas', 'README.md.tmpl'), 'utf8');
  assert.equal(/Stripe|checkout|invoice/i.test(page), false);
  assert.equal(getTemplate('saas').sveltexPackages.includes('auth'), false);
  assert.equal(getTemplate('saas').sveltexPackages.includes('database'), false);
});
