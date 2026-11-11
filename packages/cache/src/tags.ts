import { CacheConfigurationError, CacheSerializationError } from './errors.js';
import { deserializeCacheValue, serializeCacheValue } from './serialization.js';
import { validateCacheKey, validateCacheTag, validateCacheTtl } from './validation.js';
import type { CacheStore, CacheSetOptions } from './index.js';

/** Set options that additionally attach invalidation tags to an entry. */
export interface TaggedCacheSetOptions extends CacheSetOptions {
  readonly tags?: readonly string[];
}

/**
 * Source of truth for tag generations.
 *
 * A tagged entry records the generation of every tag it depends on. Bumping a
 * tag's generation makes every dependent entry stale in O(1) without scanning
 * the keyspace. The default implementation is process-local; bind a
 * `RedisTagVersionSource` (from `@sveltex/cache/redis`) for cross-process
 * invalidation.
 */
export interface CacheTagVersionSource {
  /** Snapshot of the current generation for each requested tag (missing tags = 0). */
  versions(tags: readonly string[]): Promise<Readonly<Record<string, number>>>;
  /** Atomically increment a tag's generation; returns the new generation. */
  bump(tag: string): Promise<number>;
  /** Drop all generation state. */
  reset(): Promise<void>;
}

/** Single-process tag generation source. */
export class InMemoryTagVersionSource implements CacheTagVersionSource {
  readonly #generations = new Map<string, number>();

  async versions(tags: readonly string[]): Promise<Readonly<Record<string, number>>> {
    const snapshot = Object.create(null) as Record<string, number>;
    for (const tag of tags) {
      validateCacheTag(tag);
      snapshot[tag] = this.#generations.get(tag) ?? 0;
    }
    return Object.freeze(snapshot);
  }

  async bump(tag: string): Promise<number> {
    validateCacheTag(tag);
    const next = (this.#generations.get(tag) ?? 0) + 1;
    this.#generations.set(tag, next);
    return next;
  }

  async reset(): Promise<void> {
    this.#generations.clear();
  }
}

interface TaggedEnvelope {
  readonly gens: Readonly<Record<string, number>>;
  readonly hasData: boolean;
  readonly data: unknown;
}

const EMPTY_GENS: Readonly<Record<string, number>> = Object.freeze(
  Object.create(null) as Record<string, number>,
);

export interface TaggedCacheOptions {
  /** Generation source. Defaults to a process-local {@link InMemoryTagVersionSource}. */
  readonly versions?: CacheTagVersionSource;
}

/**
 * Cache decorator adding tag-based invalidation over any {@link CacheStore}.
 *
 * Invalidation is a *logical* generation bump (O(1), no keyspace scan); stale
 * entries are physically deleted lazily on the next read and are ultimately
 * bounded by their TTL. This is deliberately documented rather than presented
 * as an immediate physical purge.
 */
export class TaggedCache implements CacheStore {
  readonly #store: CacheStore;
  readonly #versions: CacheTagVersionSource;

  constructor(store: CacheStore, options: TaggedCacheOptions = {}) {
    if (
      store === null ||
      typeof store !== 'object' ||
      typeof store.get !== 'function' ||
      typeof store.set !== 'function' ||
      typeof store.delete !== 'function' ||
      typeof store.has !== 'function'
    ) {
      throw new CacheConfigurationError('TaggedCache requires a CacheStore.');
    }
    this.#store = store;
    this.#versions = options.versions ?? new InMemoryTagVersionSource();
  }

  /** Exposed so callers can explicitly `reset()` generations if they need to. */
  get versions(): CacheTagVersionSource {
    return this.#versions;
  }

  async set<T>(key: string, value: T, options: TaggedCacheSetOptions = {}): Promise<void> {
    validateCacheKey(key);
    if (options.ttlMs !== undefined) validateCacheTtl(options.ttlMs, true);
    const tags = options.tags ?? [];
    for (const tag of tags) validateCacheTag(tag);
    const unique = [...new Set(tags)];
    const gens = unique.length === 0 ? EMPTY_GENS : await this.#versions.versions(unique);

    const envelope: TaggedEnvelope = {
      gens,
      hasData: value !== undefined,
      data: value === undefined ? null : value,
    };
    const setOptions: CacheSetOptions =
      options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs };
    await this.#store.set(key, serializeCacheValue(envelope), setOptions);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.#read(key);
    return result.hit ? (result.value as T) : undefined;
  }

  async has(key: string): Promise<boolean> {
    return (await this.#read(key)).hit;
  }

  async delete(key: string): Promise<boolean> {
    validateCacheKey(key);
    return this.#store.delete(key);
  }

  /** Clears entries but deliberately keeps tag generations (shared sources must not be reset here). */
  async clear(): Promise<void> {
    await this.#store.clear();
  }

  /** Bump a tag's generation and return the new value. */
  async invalidateTag(tag: string): Promise<number> {
    validateCacheTag(tag);
    return this.#versions.bump(tag);
  }

  /** Bump several tags, returning their new generations. */
  async invalidateTags(tags: readonly string[]): Promise<readonly number[]> {
    for (const tag of tags) validateCacheTag(tag);
    return Promise.all([...new Set(tags)].map((tag) => this.#versions.bump(tag)));
  }

  async #read(key: string): Promise<{ readonly hit: boolean; readonly value: unknown }> {
    validateCacheKey(key);
    const raw = await this.#store.get<string>(key);
    if (raw === undefined) return { hit: false, value: undefined };

    const decoded: unknown = deserializeCacheValue(raw);
    if (!isTaggedEnvelope(decoded)) {
      throw new CacheSerializationError(
        'Cache entry is not a tagged envelope (the backing store was written to directly).',
      );
    }
    const gens = decoded.gens;
    const tags = Object.keys(gens);
    const current = tags.length === 0 ? EMPTY_GENS : await this.#versions.versions(tags);
    for (const tag of tags) {
      if (current[tag] !== gens[tag]) {
        // Lazy physical cleanup of the stale entry.
        await this.#store.delete(key);
        return { hit: false, value: undefined };
      }
    }
    return { hit: true, value: decoded.hasData ? decoded.data : undefined };
  }
}

function isTaggedEnvelope(value: unknown): value is TaggedEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['hasData'] === 'boolean' &&
    candidate['gens'] !== null &&
    typeof candidate['gens'] === 'object' &&
    !Array.isArray(candidate['gens']) &&
    'data' in candidate
  );
}
