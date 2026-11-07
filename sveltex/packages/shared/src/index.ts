export type Awaitable<T> = T | Promise<T>;
export type MaybePromise<T> = T | PromiseLike<T>;
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export interface Disposable { dispose(): Awaitable<void>; }

export class SvelteXError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(message: string, options: { code: string; cause?: unknown; details?: Record<string, unknown> }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SvelteXError';
    this.code = options.code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone data-only values without invoking getters or retaining caller-owned references. */
export function cloneData<T>(value: T, options: { allowUndefined?: boolean } = {}, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new SvelteXError('Data values must not contain non-finite numbers.', { code: 'DATA_INVALID_NUMBER' });
    return value;
  }
  if (value === undefined && options.allowUndefined) return value;
  if (typeof value !== 'object') throw new SvelteXError('Only plain data values are supported.', { code: 'DATA_UNSUPPORTED_VALUE' });
  if (seen.has(value)) throw new SvelteXError('Cyclic data values are not supported.', { code: 'DATA_CYCLE' });
  if (!Array.isArray(value) && !isPlainObject(value)) throw new SvelteXError('Only arrays and plain objects are supported.', { code: 'DATA_UNSUPPORTED_OBJECT' });
  const output: unknown = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  if (Array.isArray(value)) {
    for (const item of value) (output as unknown[]).push(cloneData(item, options, seen));
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new SvelteXError('Symbol keys are not supported.', { code: 'DATA_SYMBOL_KEY' });
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new SvelteXError(`Unsafe property name: ${key}`, { code: 'DATA_UNSAFE_KEY' });
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new SvelteXError('Accessors and non-enumerable properties are not supported.', { code: 'DATA_ACCESSOR' });
      Object.defineProperty(output, key, { value: cloneData(descriptor.value, options, seen), enumerable: true, writable: true, configurable: true });
    }
  }
  seen.delete(value);
  return output as T;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new SvelteXError(`${message}: ${String(value)}`, { code: 'UNREACHABLE_STATE' });
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : 'An unknown error occurred', { cause: value });
}
