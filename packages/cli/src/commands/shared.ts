import { readFile } from 'node:fs/promises';
import type { PackageManagerId, ParsedArgs, ProjectInfo } from '../types/index.js';
import { flagString } from '../terminal/args.js';
import { projectError } from '../terminal/errors.js';
import { resolvePackageManager } from '../package-manager/detect.js';
import { discoverProject } from '../project/discovery.js';

export async function requireProject(cwd: string): Promise<ProjectInfo> {
  const project = await discoverProject(cwd);
  if (project === undefined) {
    throw projectError('No project (package.json) was found from the current directory.', 'SX_PROJECT_MISSING');
  }
  return project;
}

export function requirePackageManager(args: ParsedArgs, project: ProjectInfo, fallback?: PackageManagerId): PackageManagerId {
  const explicit = flagString(args, 'package-manager') ?? flagString(args, 'pm');
  const resolved = resolvePackageManager({
    lockfiles: project.lockfiles,
    ...(project.declaredPackageManager !== undefined ? { declared: project.declaredPackageManager } : {}),
    ...(explicit !== undefined ? { explicit } : {}),
  });
  if (resolved !== undefined) return resolved;
  if (fallback !== undefined) return fallback;
  throw projectError(
    'Could not determine the package manager. Add a lockfile, set "packageManager", or pass --package-manager.',
    'SX_PM_UNDETERMINED',
  );
}

export async function readOptional(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function isSvelteKitProject(project: ProjectInfo): boolean {
  return Object.hasOwn(project.dependencies, '@sveltejs/kit') || Object.hasOwn(project.devDependencies, '@sveltejs/kit');
}
