import type { LockfileDetection, PackageManagerId } from '../types/index.js';
import { projectError, usageError } from '../terminal/errors.js';

export const LOCKFILE_MAP: readonly { readonly file: string; readonly manager: PackageManagerId }[] = Object.freeze([
  Object.freeze({ file: 'pnpm-lock.yaml', manager: 'pnpm' }),
  Object.freeze({ file: 'package-lock.json', manager: 'npm' }),
  Object.freeze({ file: 'yarn.lock', manager: 'yarn' }),
  Object.freeze({ file: 'bun.lock', manager: 'bun' }),
  Object.freeze({ file: 'bun.lockb', manager: 'bun' }),
]);

export const PACKAGE_MANAGERS: readonly PackageManagerId[] = Object.freeze(['pnpm', 'npm', 'yarn', 'bun']);

export function isPackageManagerId(value: string): value is PackageManagerId {
  return PACKAGE_MANAGERS.includes(value as PackageManagerId);
}

/** Detect lockfiles from a directory listing. Multiple files for one manager are not a conflict. */
export function detectLockfiles(files: readonly string[]): readonly LockfileDetection[] {
  const found: LockfileDetection[] = [];
  for (const entry of LOCKFILE_MAP) {
    if (files.includes(entry.file)) found.push(Object.freeze({ manager: entry.manager, file: entry.file }));
  }
  return Object.freeze(found);
}

/** Parse the `packageManager` field, e.g. `pnpm@10.20.0`. */
export function parsePackageManagerField(value: string | undefined): PackageManagerId | undefined {
  if (value === undefined) return undefined;
  const id = value.split('@')[0]?.trim().toLowerCase();
  return id !== undefined && isPackageManagerId(id) ? id : undefined;
}

export interface ResolvePackageManagerOptions {
  readonly lockfiles: readonly LockfileDetection[];
  readonly declared?: string;
  readonly explicit?: string;
}

/**
 * Decide which package manager to use. Conflicting lockfiles stop the command
 * unless the user explicitly chose one; nothing is ever deleted silently.
 */
export function resolvePackageManager(options: ResolvePackageManagerOptions): PackageManagerId | undefined {
  if (options.explicit !== undefined) {
    if (!isPackageManagerId(options.explicit)) {
      throw usageError(`Unsupported package manager: ${options.explicit}. Use pnpm, npm, yarn, or bun.`, 'SX_PM_UNSUPPORTED');
    }
    return options.explicit;
  }

  const declaredId = parsePackageManagerField(options.declared);
  const detected = [...new Set(options.lockfiles.map((entry) => entry.manager))];

  if (detected.length > 1) {
    const files = options.lockfiles.map((entry) => entry.file).join(', ');
    throw projectError(
      `Conflicting lockfiles found (${files}). Choose one with --package-manager; no lockfile was removed.`,
      'SX_PM_LOCKFILE_CONFLICT',
    );
  }

  const found = detected[0];
  if (found !== undefined) {
    if (declaredId !== undefined && declaredId !== found) {
      throw projectError(
        `packageManager declares "${declaredId}" but the lockfile belongs to "${found}". Choose with --package-manager.`,
        'SX_PM_DECLARATION_MISMATCH',
      );
    }
    return found;
  }
  return declaredId;
}
