import { validateCacheKey } from './validation.js';
import type { CacheStore } from './index.js';
import type { KeyedCacheStore } from './namespace.js';

/**
 * Delete an explicit set of keys. Returns the number of keys that actually
 * existed. A failing backend rejects the promise rather than being ignored.
 */
export async function invalidateKeys(store: CacheStore, keys: readonly string[]): Promise<number> {
  for (const key of keys) validateCacheKey(key);
  const results = await Promise.all(keys.map((key) => store.delete(key)));
  return results.filter((deleted) => deleted).length;
}

/** Delete every key matching a predicate. */
export async function invalidateMatching(
  store: KeyedCacheStore,
  predicate: (key: string) => boolean,
): Promise<number> {
  if (typeof predicate !== 'function') {
    throw new TypeError('invalidateMatching requires a predicate function.');
  }
  const keys = await store.keys();
  const matching = keys.filter(predicate);
  return invalidateKeys(store, matching);
}

/** Delete every key starting with `prefix`. */
export async function invalidatePrefix(store: KeyedCacheStore, prefix: string): Promise<number> {
  if (typeof prefix !== 'string') throw new TypeError('invalidatePrefix requires a string prefix.');
  return invalidateMatching(store, (key) => key.startsWith(prefix));
}
