import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectInfo } from '../types/index.js';
import { detectLockfiles, resolvePackageManager } from '../package-manager/detect.js';
import { projectError } from '../terminal/errors.js';

const MAX_DEPTH = 16;
const SVELTE_CONFIG_FILES = ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs'] as const;
const HOOKS_FILES = ['src/hooks.server.ts', 'src/hooks.server.js'] as const;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') output[key] = entry;
    }
  }
  return Object.freeze(output);
}

async function firstExisting(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await readFile(join(root, candidate), 'utf8');
      return join(root, candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return undefined;
}

async function buildProjectInfo(root: string, manifestPath: string, raw: string): Promise<ProjectInfo> {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) throw new Error('package.json must contain an object.');
    manifest = parsed;
  } catch (cause) {
    throw projectError(`Invalid ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`, 'SX_MANIFEST_INVALID');
  }

  const files = await readdir(root);
  const lockfiles = detectLockfiles(files);
  const declaredPackageManager = typeof manifest['packageManager'] === 'string' ? manifest['packageManager'] : undefined;
  let packageManager: ProjectInfo['packageManager'];
  try {
    packageManager = resolvePackageManager({ lockfiles, ...(declaredPackageManager !== undefined ? { declared: declaredPackageManager } : {}) });
  } catch {
    // A conflict is reported by `doctor`/`add` with a stable code; discovery stays non-throwing.
    packageManager = undefined;
  }

  const [configPath, svelteConfigPath, hooksPath] = await Promise.all([
    firstExisting(root, ['sveltex.config.ts']),
    firstExisting(root, SVELTE_CONFIG_FILES),
    firstExisting(root, HOOKS_FILES),
  ]);

  return Object.freeze({
    root,
    manifestPath,
    manifest: Object.freeze(manifest),
    name: typeof manifest['name'] === 'string' && manifest['name'] !== '' ? manifest['name'] : basename(root),
    packageManager,
    declaredPackageManager,
    lockfiles,
    scripts: stringRecord(manifest['scripts']),
    dependencies: stringRecord(manifest['dependencies']),
    devDependencies: stringRecord(manifest['devDependencies']),
    configPath,
    svelteConfigPath,
    hooksPath,
  });
}

/** Walk up from startDir to the nearest package.json. Never executes project code. */
export async function discoverProject(startDir: string): Promise<ProjectInfo | undefined> {
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const manifestPath = join(current, 'package.json');
    try {
      const raw = await readFile(manifestPath, 'utf8');
      return await buildProjectInfo(current, manifestPath, raw);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** Read the version of an installed package from its own package.json, without executing it. */
export async function readInstalledVersion(root: string, packageName: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(root, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isPlainRecord(parsed) && typeof parsed['version'] === 'string') return parsed['version'];
    return undefined;
  } catch {
    return undefined;
  }
}
