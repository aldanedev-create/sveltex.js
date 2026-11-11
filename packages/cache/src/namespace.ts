import { CacheConfigurationError } from './errors.js';
import { validateCacheKey, validateCacheNamespace, validateCacheTtl } from './validation.js';
import type { CacheStore, CacheSetOptions } from './index.js';

/**
 * A store that can enumerate the logical keys it currently holds. Both
 * built-in stores implement this (`MemoryCache.keys()`, `RedisCache.keys()`),
 * which is what makes namespace-scoped and pattern-based invalidation possible
 * without a global flush.
 */
export interface KeyedCacheStore extends CacheStore {
  /** Logical keys held by the store. Ordering is not guaranteed. */
  keys(): Promise<readonly string[]>;
}

/**
 * Physical key layout: `__sveltex_cache_ns__:<encoded namespace>:<encoded key>`.
 * Both segments are `encodeURIComponent`-escaped, so neither user input can
 * inject a `:` and cross a namespace boundary.
 */
export const NAMESPACE_KEY_PREFIX = '__sveltex_cache_ns__:';

export function namespaceKeyPrefix(namespace: string): string {
  return `${NAMESPACE_KEY_PREFIX}${encodeURIComponent(namespace)}:`;
}

export function encodeNamespaceKey(namespace: string, key: string): string {
  return `${namespaceKeyPrefix(namespace)}${encodeURIComponent(key)}`;
}

export function decodeNamespaceKey(namespace: string, physicalKey: string): string | undefined {
  const prefix = namespaceKeyPrefix(namespace);
  if (typeof physicalKey !== 'string' || !physicalKey.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(physicalKey.slice(prefix.length));
  } catch {
    // Malformed percent-encoding: not one of our keys.
    return undefined;
  }
}

/**
 * A logical namespace over a shared {@link KeyedCacheStore}.
 *
 * All operations are isolated to `<namespace>`; `clear()` removes only this
 * namespace's keys and never calls the backing store's global `clear()`.
 */
export class CacheNamespace implements KeyedCacheStore {
  readonly #store: KeyedCacheStore;
  readonly #name: string;

  constructor(store: KeyedCacheStore, name: string) {
    validateCacheNamespace(name);
    if (
      store === null ||
      typeof store !== 'object' ||
      typeof store.keys !== 'function' ||
      typeof store.get !== 'function' ||
      typeof store.set !== 'function' ||
      typeof store.delete !== 'function' ||
      typeof store.has !== 'function'
    ) {
      throw new CacheConfigurationError(
        'CacheNamespace requires a KeyedCacheStore (a CacheStore that also implements keys()).',
      );
    }
    this.#store = store;
    this.#name = name;
  }

  get name(): string {
    return this.#name;
  }

  async keys(): Promise<readonly string[]> {
    const physical = await this.#store.keys();
    const decoded: string[] = [];
    for (const candidate of physical) {
      const key = decodeNamespaceKey(this.#name, candidate);
      if (key !== undefined) decoded.push(key);
    }
    return Object.freeze(decoded);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#store.get<T>(this.#physical(key));
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    if (options.ttlMs !== undefined) validateCacheTtl(options.ttlMs, true);
    await this.#store.set(this.#physical(key), value, options);
  }

  async delete(key: string): Promise<boolean> {
    return this.#store.delete(this.#physical(key));
  }

  async has(key: string): Promise<boolean> {
    return this.#store.has(this.#physical(key));
  }

  /** Namespace-scoped invalidation. Never flushes unrelated keys. */
  async clear(): Promise<void> {
    const keys = await this.keys();
    await Promise.all(keys.map((key) => this.#store.delete(this.#physical(key))));
  }

  #physical(key: string): string {
    validateCacheKey(key);
    return encodeNamespaceKey(this.#name, key);
  }
}

/** Create an isolated logical namespace over a shared keyed store. */
export function createNamespace(store: KeyedCacheStore, name: string): CacheNamespace {
  return new CacheNamespace(store, name);
}
