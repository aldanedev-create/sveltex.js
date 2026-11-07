import type { ConfigDefinition, ConfigValidator } from './config.types.js';

/** Defines and freezes configuration without performing I/O or reading environment globals. */
export function defineConfig<T extends Record<string, unknown>>(
  value: T,
  validate?: ConfigValidator<T>,
): ConfigDefinition<T> {
  const copy = cloneValue(value);
  validate?.(copy);
  return Object.freeze({ value: deepFreeze(copy), ...(validate ? { validate } : {}) });
}

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === 'function') throw new TypeError('Functions are not supported in configuration values.');
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) return existing as T;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneValue(item, seen));
    return result as T;
  }
  if (value && typeof value === 'object') {
    const existing = seen.get(value);
    if (existing) return existing as T;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Configuration values must be plain objects, arrays, or primitives.');
    }
    const result: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
    seen.set(value, result);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(result, key, { value: cloneValue(child, seen), enumerable: true, configurable: true, writable: true });
    }
    return result as T;
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
