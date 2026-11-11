/**
 * Typed error hierarchy for `@sveltex/cache`.
 *
 * Decorators never silently swallow backend failures: a failing primary store
 * is wrapped in {@link CacheStoreError} (with the original error as `cause`)
 * and surfaced through `FallbackCache` observability hooks. Values that cannot
 * be represented without data loss raise {@link CacheSerializationError}
 * instead of being quietly coerced to `null` or `{}`.
 */

/** Base class for all cache errors. `cause` follows the standard `Error` option. */
export class CacheError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CacheError';
    this.code = code;
  }
}

/** Invalid options or an unsupported combination of collaborators. */
export class CacheConfigurationError extends CacheError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CACHE_CONFIGURATION', cause);
    this.name = 'CacheConfigurationError';
  }
}

/** A value cannot be encoded/decoded without losing information, or a payload is corrupt. */
export class CacheSerializationError extends CacheError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CACHE_SERIALIZATION', cause);
    this.name = 'CacheSerializationError';
  }
}

/** A backend operation failed. The original error is retained as `cause`. */
export class CacheStoreError extends CacheError {
  readonly operation: string;

  constructor(operation: string, cause?: unknown, message?: string) {
    super(message ?? `Cache store operation "${operation}" failed.`, 'CACHE_STORE', cause);
    this.name = 'CacheStoreError';
    this.operation = operation;
  }
}
