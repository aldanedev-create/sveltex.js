import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/index.js';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SVELTEX_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'sveltex-cli-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const destination = join(root, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
  }
}

/** A process runner that records invocations and never touches the network. */
export function recorder(overrides = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const override = overrides[command] ?? overrides.default;
    if (typeof override === 'function') return override(command, args, options);
    return override ?? { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

export function run(argv, { cwd, env = {}, runner, nodeVersion = '22.13.1' } = {}) {
  return runCli({
    argv,
    cwd: cwd ?? process.cwd(),
    env,
    runner: runner ?? recorder().runner,
    nodeVersion,
    now: () => 0,
  });
}

export async function makeProject(root, { manifest = {}, files = {} } = {}) {
  const base = {
    name: 'demo-app',
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: { dev: 'vite dev', build: 'vite build', check: 'svelte-check', test: 'vitest run' },
    devDependencies: { '@sveltejs/kit': '^2.0.0', typescript: '^5.8.0' },
    ...manifest,
  };
  const defaults = {
    'package.json': `${JSON.stringify(base, null, 2)}\n`,
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'sveltex.config.ts': "import { defineConfig } from '@sveltex/config';\n\nexport default defineConfig({\n  app: { name: 'demo-app' },\n  modules: ['./src/lib/server/modules/index']\n});\n",
    'src/hooks.server.ts': "import { sequence } from '@sveltejs/kit/hooks';\nimport { createSvelteXHandler } from '@sveltex/sveltekit';\nimport { app } from '$lib/server/sveltex';\n\nexport const handle = sequence(createSvelteXHandler(app));\n",
    'src/lib/server/modules/index.ts': "import type { ModuleDefinition } from '@sveltex/core';\nexport const modules: readonly ModuleDefinition[] = [];\n",
    '.gitignore': 'node_modules\n',
  };
  await writeFiles(root, { ...defaults, ...files });
  return base;
}
