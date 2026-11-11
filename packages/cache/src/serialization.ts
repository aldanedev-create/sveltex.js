import { CacheSerializationError } from './errors.js';

/**
 * Wire format for serialized cache values.
 *
 * Every value written through `serializeCacheValue` is prefixed so that a
 * corrupt or legacy payload is *detected* rather than silently treated as a
 * cache miss. The payload tag distinguishes a cached `undefined` (`u`) from a
 * JSON value (`j`), which plain `JSON.stringify` cannot do.
 *
 * Format: `sveltex-cache:v1:<tag><body>`
 *   - `u` : empty body, decodes to `undefined`
 *   - `j` : body is `JSON.stringify(value)` produced by the strict replacer
 */
export const CACHE_ENVELOPE_VERSION = 1;
export const CACHE_ENVELOPE_PREFIX = `sveltex-cache:v${CACHE_ENVELOPE_VERSION}:`;

const UNSAFE_OBJECTS: readonly string[] = ['Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'Promise', 'ArrayBuffer'];

/** Test whether a raw payload uses the current SvelteX cache envelope. */
export function isCacheEnvelope(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(CACHE_ENVELOPE_PREFIX);
}

/**
 * Encode a value for storage in a string-based backend.
 *
 * Supported (round-trips exactly): `undefined` (top level only), `null`,
 * booleans, finite numbers, strings, plain objects and arrays containing only
 * those values.
 *
 * Rejected with {@link CacheSerializationError} instead of silent coercion:
 * `bigint`, `function`, `symbol`, `NaN`/`Infinity`, circular references,
 * nested `undefined`, `Date`, `Map`/`Set`, typed arrays, class instances and
 * any object with a non-plain prototype. `JSON.stringify` would otherwise turn
 * these into `null`, `{}`, an ISO string, or drop them entirely.
 */
export function serializeCacheValue(value: unknown): string {
  if (value === undefined) return `${CACHE_ENVELOPE_PREFIX}u`;
  if (typeof value === 'bigint') {
    throw new CacheSerializationError('BigInt values cannot be serialized; convert to a decimal string explicitly.');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new CacheSerializationError('Functions and symbols cannot be serialized.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CacheSerializationError('Non-finite numbers (NaN/Infinity) cannot be serialized.');
  }
  // The replacer cannot see the original root object: JSON.stringify calls
  // toJSON() before invoking it, so a top-level Date would already be a string.
  // Validate the root explicitly as well.
  assertSerializable(value, '');

  let json: string;
  try {
    json = JSON.stringify(value, strictReplacer);
  } catch (cause) {
    if (cause instanceof CacheSerializationError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CacheSerializationError(`Value cannot be safely serialized: ${detail}`, cause);
  }
  if (json === undefined) {
    throw new CacheSerializationError('Value cannot be serialized (unsupported root type).');
  }
  return `${CACHE_ENVELOPE_PREFIX}j${json}`;
}

/**
 * Decode a value produced by {@link serializeCacheValue}.
 *
 * A payload that does not carry the current envelope is treated as corrupt /
 * legacy data and raises {@link CacheSerializationError}; it is never silently
 * converted into a cache miss. Keys named `__proto__` are dropped during parse
 * so a cached object cannot pollute prototypes when later merged.
 */
export function deserializeCacheValue(raw: string): unknown {
  if (typeof raw !== 'string' || !raw.startsWith(CACHE_ENVELOPE_PREFIX)) {
    throw new CacheSerializationError(
      'Unrecognized cache envelope (corrupt payload or data written by an older @sveltex/cache version).',
    );
  }
  const body = raw.slice(CACHE_ENVELOPE_PREFIX.length);
  const tag = body.slice(0, 1);
  const payload = body.slice(1);

  if (tag === 'u' && payload.length === 0) return undefined;
  if (tag === 'u') throw new CacheSerializationError('Malformed undefined envelope.');
  if (tag !== 'j') throw new CacheSerializationError(`Unknown cache envelope tag "${tag}".`);

  try {
    return JSON.parse(payload, (_key: string, parsed: unknown) =>
      _key === '__proto__' ? undefined : parsed,
    ) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CacheSerializationError(`Corrupt cache payload: ${detail}`, cause);
  }
}

/**
 * The replacer inspects the *original* value (`this[key]`) rather than the
 * already-coerced `value` argument. `JSON.stringify` calls `toJSON()` before
 * invoking the replacer, so `Date` would otherwise arrive as a string and be
 * stored without the caller noticing the type change.
 */
function strictReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  assertSerializable(key === '' ? value : this[key], key);
  return value;
}

function assertSerializable(original: unknown, key: string): void {
  if (typeof original === 'bigint') {
    throw new CacheSerializationError('BigInt values cannot be serialized; convert to a decimal string explicitly.');
  }
  if (typeof original === 'function' || typeof original === 'symbol') {
    throw new CacheSerializationError('Functions and symbols cannot be serialized.');
  }
  if (typeof original === 'number' && !Number.isFinite(original)) {
    throw new CacheSerializationError('Non-finite numbers (NaN/Infinity) cannot be serialized.');
  }
  if (original === undefined && key !== '') {
    throw new CacheSerializationError(
      'Nested undefined cannot round-trip through JSON (it would be dropped or become null).',
    );
  }
  if (original === null || typeof original !== 'object') return;

  if (ArrayBuffer.isView(original) || original instanceof ArrayBuffer) {
    throw new CacheSerializationError('Typed arrays and ArrayBuffers cannot be serialized safely.');
  }
  const tagged = Object.prototype.toString.call(original).slice(8, -1);
  if (UNSAFE_OBJECTS.includes(tagged)) {
    throw new CacheSerializationError(
      `${tagged} values cannot be serialized safely; convert them to plain data explicitly.`,
    );
  }
  if (!Array.isArray(original)) {
    const proto: unknown = Object.getPrototypeOf(original) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new CacheSerializationError('Only plain objects and arrays can be serialized.');
    }
  }
}
