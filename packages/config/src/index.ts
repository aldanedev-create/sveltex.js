import { cloneData, deepFreeze, isPlainObject, SvelteXError } from '@sveltex/shared';

export type ConfigIssue = { path: string; message: string; code: string };
export type ConfigValidator<T> = (value: unknown) => value is T;
export type ConfigResult<T> = { success: true; data: T } | { success: false; issues: readonly ConfigIssue[] };

/** Defines immutable, data-only configuration without environment or filesystem access. */
export function defineConfig<T extends Record<string, unknown>>(config: T): Readonly<T> {
  if (!isPlainObject(config)) throw new SvelteXError('Configuration must be a plain object.', { code: 'CONFIG_INVALID_ROOT' });
  return deepFreeze(cloneData(config));
}

/** Deeply merges plain objects; arrays and scalar override values replace base values. */
export function mergeConfig<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) throw new SvelteXError('Both configuration values must be plain objects.', { code: 'CONFIG_INVALID_ROOT' });
  return mergeObjects(base, override) as T;
}

export function validateConfig<T>(value: unknown, validator: ConfigValidator<T>, message = 'Configuration is invalid.'): ConfigResult<T> {
  try {
    if (validator(value)) return { success: true, data: value };
  } catch (cause) {
    return { success: false, issues: Object.freeze([{ path: '', message: cause instanceof Error ? cause.message : message, code: 'CONFIG_VALIDATOR_FAILED' }]) };
  }
  return { success: false, issues: Object.freeze([{ path: '', message, code: 'CONFIG_INVALID' }]) };
}

export function assertConfig<T>(value: unknown, validator: ConfigValidator<T>, message?: string): asserts value is T {
  const result = validateConfig(value, validator, message);
  if (!result.success) throw new SvelteXError(result.issues.map(issue => issue.message).join('; '), { code: 'CONFIG_INVALID', details: { issues: result.issues } });
}

function mergeObjects(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return cloneData(override, { allowUndefined: true });
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    const descriptor = Object.getOwnPropertyDescriptor(base, key);
    if (!descriptor || !('value' in descriptor)) throw new SvelteXError('Configuration accessors are not supported.', { code: 'CONFIG_ACCESSOR' });
    Object.defineProperty(output, key, { value: cloneData(descriptor.value, { allowUndefined: true }), enumerable: true, writable: true, configurable: true });
  }
  for (const key of Object.keys(override)) {
    const descriptor = Object.getOwnPropertyDescriptor(override, key);
    if (!descriptor || !('value' in descriptor)) throw new SvelteXError('Configuration accessors are not supported.', { code: 'CONFIG_ACCESSOR' });
    const merged = Object.hasOwn(output, key) ? mergeObjects(output[key], descriptor.value) : cloneData(descriptor.value, { allowUndefined: true });
    Object.defineProperty(output, key, { value: merged, enumerable: true, writable: true, configurable: true });
  }
  return output;
}
