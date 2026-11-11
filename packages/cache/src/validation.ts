/** Shared input validation for every cache implementation and decorator. */

const MAX_KEY_LENGTH = 1024;
const MAX_TAG_LENGTH = 256;
const TAG_PATTERN = /^[A-Za-z0-9._:-]+$/;
const FORBIDDEN_TAGS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate a cache key. Throws `TypeError` on invalid input — this is kept
 * consistent across `MemoryCache`, `RedisCache` and every decorator so that
 * callers see one behaviour regardless of the backend.
 */
export function validateCacheKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError(
      `Cache keys must be non-empty strings no longer than ${MAX_KEY_LENGTH} characters.`,
    );
  }
}

/** Validate a TTL in milliseconds. `allowZero` mirrors "delete immediately" semantics. */
export function validateCacheTtl(ttl: number, allowZero = true): void {
  if (!Number.isFinite(ttl) || ttl < 0 || (!allowZero && ttl === 0)) {
    throw new RangeError('ttlMs must be a non-negative finite number.');
  }
}

/**
 * Validate a tag name. The character allow-list keeps tag version keys safe to
 * embed in Redis key names, and the forbidden names prevent prototype
 * pollution when tag generations are stored as a plain object.
 */
export function validateCacheTag(tag: string): void {
  if (
    typeof tag !== 'string' ||
    tag.length === 0 ||
    tag.length > MAX_TAG_LENGTH ||
    !TAG_PATTERN.test(tag) ||
    FORBIDDEN_TAGS.has(tag)
  ) {
    throw new TypeError(
      `Cache tags must be non-empty strings of letters, digits, ".", "_", ":" or "-" (max ${MAX_TAG_LENGTH} chars) and must not be prototype-polluting names.`,
    );
  }
}

/** Validate a namespace name. */
export function validateCacheNamespace(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TAG_LENGTH) {
    throw new TypeError('Cache namespace names must be non-empty strings no longer than 256 characters.');
  }
}
