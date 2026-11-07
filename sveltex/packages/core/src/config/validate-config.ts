import { SvelteXError } from '../errors/framework-error.js';
import { isRecord } from '../types/common.js';
import type { SvelteXConfig } from './config.types.js';

export function validateConfig(input: unknown): SvelteXConfig {
  if (!isRecord(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new SvelteXError('SX_CONFIG_INVALID', 'Configuration must be a plain object.');
  const issues: string[] = [];
  if (typeof input.name !== 'string' || input.name.trim().length === 0) issues.push('name must be a non-empty string');
  if (input.environment !== undefined && (typeof input.environment !== 'string' || !input.environment.trim())) issues.push('environment must be a non-empty string');
  if (input.debug !== undefined && typeof input.debug !== 'boolean') issues.push('debug must be a boolean');
  if (input.metadata !== undefined && !isRecord(input.metadata)) issues.push('metadata must be an object');
  if (issues.length) throw new SvelteXError('SX_CONFIG_INVALID', `Invalid configuration: ${issues.join('; ')}.`, { details: { issues } });
  return Object.freeze({
    name: (input.name as string).trim(),
    ...(input.environment === undefined ? {} : { environment: input.environment as string }),
    ...(input.debug === undefined ? {} : { debug: input.debug as boolean }),
    ...(input.metadata === undefined ? {} : { metadata: deepFreeze(cloneRecord(input.metadata as Record<string, unknown>)) }),
  });
}

function cloneRecord(value: Record<string, unknown>, seen = new WeakMap<object, unknown>()): Record<string, unknown> {
  const existing = seen.get(value);
  if (existing) return existing as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new SvelteXError('SX_CONFIG_INVALID', 'Metadata must contain only plain objects, arrays, and primitives.');
  const result: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, result);
  for (const [key, child] of Object.entries(value)) {
    let cloned: unknown;
    if (Array.isArray(child)) cloned = cloneArray(child, seen);
    else if (child && typeof child === 'object') cloned = cloneRecord(child as Record<string, unknown>, seen);
    else if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') throw new SvelteXError('SX_CONFIG_INVALID', 'Metadata values must be JSON-compatible.');
    else cloned = child;
    Object.defineProperty(result, key, { value: cloned, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function cloneArray(value: unknown[], seen: WeakMap<object, unknown>): unknown[] {
  const existing = seen.get(value);
  if (existing) return existing as unknown[];
  const result: unknown[] = [];
  seen.set(value, result);
  for (const child of value) {
    if (Array.isArray(child)) result.push(cloneArray(child, seen));
    else if (child && typeof child === 'object') result.push(cloneRecord(child as Record<string, unknown>, seen));
    else if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') throw new SvelteXError('SX_CONFIG_INVALID', 'Metadata values must be JSON-compatible.');
    else result.push(child);
  }
  return result;
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
