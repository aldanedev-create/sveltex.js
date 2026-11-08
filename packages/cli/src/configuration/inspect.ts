import { validateConfig, type ConfigResult } from '@sveltex/config';
import { SECRET_KEY_PATTERN } from './redact.js';

export interface SvelteXConfigShape extends Record<string, unknown> {
  readonly app: Readonly<Record<string, unknown>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSvelteXConfigShape(value: unknown): value is SvelteXConfigShape {
  if (!isPlainRecord(value)) return false;
  const app = value['app'];
  if (!isPlainRecord(app)) return false;
  const name = app['name'];
  if (typeof name !== 'string' || name.trim() === '') return false;
  const modules = value['modules'];
  if (modules !== undefined && !Array.isArray(modules)) return false;
  return true;
}

/**
 * Configuration validation is owned by `@sveltex/config`. The CLI supplies only
 * the shape predicate; it does not implement a parallel validation engine.
 */
export function validateSvelteXConfig(value: unknown): ConfigResult<SvelteXConfigShape> {
  return validateConfig(value, isSvelteXConfigShape, 'SvelteX config must be an object with a non-empty app.name.');
}

export interface ConfigInspection {
  readonly present: boolean;
  readonly hasDefaultExport: boolean;
  readonly importNames: readonly string[];
  readonly topLevelKeys: readonly string[];
  readonly referencedEnvNames: readonly string[];
  readonly secretFieldNames: readonly string[];
  readonly unsafeExecDetected: boolean;
  readonly issues: readonly string[];
}

/**
 * Static, read-only inspection of `sveltex.config.ts` source text.
 * The configuration module is NEVER imported, evaluated, or required here.
 */
export function inspectConfigText(source: string): ConfigInspection {
  const importNames = new Set<string>();
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const name = match[1];
    if (name !== undefined) importNames.add(name);
  }

  const topLevelKeys = new Set<string>();
  for (const match of source.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm)) {
    const key = match[1];
    if (key !== undefined) topLevelKeys.add(key);
  }

  const referencedEnvNames = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1];
    if (name !== undefined) referencedEnvNames.add(name);
  }

  const secretFieldNames = new Set<string>();
  for (const match of source.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) {
    const key = match[1];
    if (key !== undefined && SECRET_KEY_PATTERN.test(key)) secretFieldNames.add(key);
  }

  const hasDefaultExport = /export\s+default\b/.test(source);
  const unsafeExecDetected = /\b(?:eval|Function|child_process|execSync|spawnSync|require)\s*\(/.test(source);
  const issues: string[] = [];
  if (!hasDefaultExport) issues.push('SX_CONFIG_NO_DEFAULT_EXPORT');
  if (unsafeExecDetected) issues.push('SX_CONFIG_UNSAFE_EXEC');

  return Object.freeze({
    present: source.trim() !== '',
    hasDefaultExport,
    importNames: Object.freeze([...importNames].sort()),
    topLevelKeys: Object.freeze([...topLevelKeys].sort()),
    referencedEnvNames: Object.freeze([...referencedEnvNames].sort()),
    secretFieldNames: Object.freeze([...secretFieldNames].sort()),
    unsafeExecDetected,
    issues: Object.freeze(issues),
  });
}
