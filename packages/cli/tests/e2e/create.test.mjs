import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TEMPLATES, OFFICIAL_DOCS_URL } from '../../dist/index.js';
import { tempDir, run, recorder } from '../helpers.mjs';

async function walk(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else output.push(relative(root, full).split('\\').join('/'));
    }
  }
  await visit(root);
  return output;
}

test('e2e: all six official templates generate real, complete projects through the CLI', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { runner, calls } = recorder();
    for (const template of TEMPLATES) {
      const name = `e2e-${template.id}`;
      const result = await run(['create', name, '--template', template.id, '--no-install', '--no-git', '--json'], { cwd: dir, runner });
      assert.equal(result.exitCode, 0, `${template.id}: ${JSON.stringify(result.error)}`);
      assert.equal(result.data.applied, true);
      assert.equal(result.data.template, template.id);
      assert.equal(result.data.welcome, template.defaultWelcome);
      assert.equal(result.data.installed, false);
      assert.ok(result.data.manualSteps.some((step) => step.includes('pnpm install')));

      const target = join(dir, name);
      const files = await walk(target);
      assert.ok(files.includes('package.json'), template.id);
      assert.ok(files.includes('sveltex.config.ts'), template.id);
      assert.ok(files.includes('src/routes/+page.svelte'), template.id);
      assert.ok(files.includes('src/hooks.server.ts'), template.id);
      assert.ok(files.includes('README.md'), template.id);

      for (const file of files) {
        const content = await readFile(join(target, file), 'utf8');
        assert.equal(/\{\{[A-Z_]+\}\}/.test(content), false, `${template.id}/${file}`);
      }
      const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      assert.equal(manifest.name, name);
      for (const entry of result.data.dependencies) {
        const [packageName, version] = entry.split('@^');
        assert.equal(manifest.dependencies[packageName], `^${version}`);
      }
      const page = await readFile(join(target, 'src/routes/+page.svelte'), 'utf8');
      assert.ok(page.includes('<style>'), template.id);
      assert.ok(page.length > 100, template.id);
    }
    assert.equal(calls.length, 0, 'no install and no git means no external process');
  } finally {
    await cleanup();
  }
});

test('e2e: --dry-run previews without creating a single file', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { runner, calls } = recorder();
    const result = await run(['create', 'preview-app', '--template', 'saas', '--dry-run', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.applied, false);
    assert.ok(result.data.files.length > 10);
    assert.equal(existsSync(join(dir, 'preview-app')), false);
    assert.equal(calls.length, 0);
  } finally {
    await cleanup();
  }
});

test('e2e: git init is delegated as a plain argument array when enabled', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { runner, calls } = recorder();
    const result = await run(['create', 'git-app', '--template', 'minimal', '--no-install', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.gitInitialized, true);
    const git = calls.find((call) => call.command === 'git');
    assert.deepEqual(git.args, ['init']);
    assert.equal(git.cwd, join(dir, 'git-app'));
  } finally {
    await cleanup();
  }
});

test('e2e: welcome-page choice and docs URL are honoured in generated source', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { runner } = recorder();
    const custom = 'https://docs.example.test/sveltex';
    const result = await run(['create', 'docs-app', '--template', 'fullstack', '--welcome', 'docs', '--docs-url', custom, '--no-install', '--no-git', '--json'], { cwd: dir, runner });
    assert.equal(result.exitCode, 0);
    const page = await readFile(join(dir, 'docs-app', 'src/routes/+page.svelte'), 'utf8');
    assert.ok(page.includes('Documentation starter'));
    assert.ok(page.includes(custom));
    assert.equal(page.includes(OFFICIAL_DOCS_URL), false);

    const blank = await run(['create', 'blank-app', '--template', 'fullstack', '--welcome', 'blank', '--no-install', '--no-git', '--json'], { cwd: dir, runner });
    assert.equal(blank.data.welcome, 'blank');
    const blankPage = await readFile(join(dir, 'blank-app', 'src/routes/+page.svelte'), 'utf8');
    assert.ok(blankPage.includes('Blank starter'));
  } finally {
    await cleanup();
  }
});

test('e2e: create refuses to touch an existing non-empty directory', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const { runner } = recorder();
    await run(['create', 'taken', '--template', 'minimal', '--no-install', '--no-git', '--json'], { cwd: dir, runner });
    const second = await run(['create', 'taken', '--template', 'saas', '--no-install', '--no-git', '--json'], { cwd: dir, runner });
    assert.equal(second.exitCode, 3);
    assert.equal(second.error.code, 'SX_TARGET_NOT_EMPTY');
    assert.ok((await readFile(join(dir, 'taken', 'README.md'), 'utf8')).includes('minimal'));
  } finally {
    await cleanup();
  }
});
