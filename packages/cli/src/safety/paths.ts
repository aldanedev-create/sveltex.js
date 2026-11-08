import { isAbsolute, resolve, sep } from 'node:path';
import { usageError } from '../terminal/errors.js';

/** Directory names accepted by `create` and `generate`. Deliberately strict: no shell metacharacters, separators, or control characters. */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const FORBIDDEN_NAME_CHARS = /[\\/;$`|&<>()\r\n\t\0"'{}[\]*!?#]/;

/** Validate a user-supplied project or artifact name. Throws exit-2 on invalid input. */
export function validateProjectName(name: string): string {
  if (typeof name !== 'string' || name === '') throw usageError('A project name is required.');
  if (name === '.' || name === '..') throw usageError('Project name must not be "." or "..".');
  if (FORBIDDEN_NAME_CHARS.test(name)) throw usageError('Project name contains forbidden characters.');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw usageError('Project name must not contain control characters.');
  if (!PROJECT_NAME_PATTERN.test(name)) throw usageError(`Invalid project name: ${name}. Use letters, digits, ".", "_" or "-".`, 'SX_CLI_INVALID_NAME');
  if (name.startsWith('.') || name.endsWith('.')) throw usageError('Project name must not start or end with a dot.');
  return name;
}

/** Convert a directory name into a valid npm package name without executing anything. */
export function toPackageName(name: string): string {
  const lower = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const trimmed = lower.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  return trimmed === '' ? 'sveltex-app' : trimmed;
}

/** Validate a relative path used for generated files. Rejects traversal, absolute paths, encoded traversal and NUL. */
export function safeRelativePath(input: string): string {
  if (typeof input !== 'string' || input === '') throw usageError('A relative path is required.');
  if (input.includes('\0')) throw usageError('Path must not contain NUL bytes.');
  if (input.includes('\\')) throw usageError('Path must use forward slashes only.');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input) || isAbsolute(input)) throw usageError('Path must be relative, not absolute.');
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw usageError('Path contains invalid percent-encoding.');
  }
  if (/%2e|%2f|%5c/i.test(input)) throw usageError('Encoded traversal sequences are not allowed.', 'SX_CLI_PATH_TRAVERSAL');
  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw usageError('Path must not contain empty, "." or ".." segments.', 'SX_CLI_PATH_TRAVERSAL');
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) throw usageError('Path must not contain control characters.');
  }
  return input;
}

export function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

/** Resolve a relative generated path and guarantee it stays under root. */
export function resolveInside(root: string, relative: string): string {
  const safe = safeRelativePath(relative);
  const target = resolve(root, safe);
  if (!isInside(root, target)) throw usageError('Resolved path escapes the project root.', 'SX_CLI_PATH_TRAVERSAL');
  return target;
}
