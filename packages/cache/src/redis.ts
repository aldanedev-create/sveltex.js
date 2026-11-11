import { Redis } from 'ioredis';
import type { CacheStore, CacheSetOptions } from './index.js';
import type { CacheTagVersionSource } from './tags.js';
import {
  CACHE_ENVELOPE_PREFIX,
  deserializeCacheValue,
  serializeCacheValue,
} from './serialization.js';
import { validateCacheKey, validateCacheTag, validateCacheTtl } from './validation.js';

/**
 * Redis cache adapter options.
 *
 * @public
 */
export interface RedisCacheOptions {
  /** Redis connection URL (e.g., `redis://localhost:6379`). */
  readonly url?: string;
  /** Individual connection options as an alternative to `url`. */
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
  readonly db?: number;
  /** Optional key prefix for namespace isolation. */
  readonly keyPrefix?: string;
  /** Default TTL in milliseconds if not specified per-set. */
  readonly defaultTtlMs?: number;
  /** Connection timeout in milliseconds. */
  readonly connectTimeoutMs?: number;
  /** Maximum reconnect retry attempts. */
  readonly maxRetriesPerRequest?: number;
}

/** Prefix used for tag generation keys inside Redis. */
export const REDIS_TAG_VERSION_PREFIX = '__sveltex_cache_tagver__:';

/**
 * Atomically increment a counter that is stored in the SvelteX cache envelope.
 * Keeping counters in the same wire format as `set`/`get` means
 * `cache.increment('n', 5)` followed by `cache.get('n')` works without special
 * casing, while the whole read-modify-write stays atomic on the Redis server.
 */
const INCREMENT_LUA = `
local raw = redis.call('GET', KEYS[1])
local prefix = ARGV[1]
local cur = 0
if raw then
  local tag = string.sub(raw, #prefix + 1, #prefix + 1)
  if tag ~= 'j' then
    return redis.error_reply('ERR sveltex-cache: counter key does not hold a numeric envelope')
  end
  local parsed = tonumber(string.sub(raw, #prefix + 2))
  if not parsed then
    return redis.error_reply('ERR sveltex-cache: counter key does not hold a number')
  end
  cur = parsed
end
local delta = tonumber(ARGV[2])
local next = cur + delta
if next ~= next or next == math.huge or next == -math.huge or next > 9007199254740991 or next < -9007199254740991 then
  return redis.error_reply('ERR sveltex-cache: counter overflow')
end
redis.call('SET', KEYS[1], prefix .. 'j' .. string.format('%d', next))
return next
`;

function createRedisClient(options: RedisCacheOptions): Redis {
  const common = {
    connectTimeout: options.connectTimeoutMs ?? 10000,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
    lazyConnect: true,
  };
  const conditional = {
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
  };
  if (options.url) {
    return new Redis(options.url, { ...common, ...conditional });
  }
  return new Redis({
    ...common,
    ...conditional,
    host: options.host ?? 'localhost',
    port: options.port ?? 6379,
  });
}

/**
 * Redis-backed cache implementing the {@link CacheStore} contract.
 *
 * Values use the strict SvelteX envelope from `serializeCacheValue`, so a
 * corrupt or legacy payload raises `CacheSerializationError` instead of being
 * silently treated as a miss. TTL is handled natively by Redis `SETEX`.
 * This is a true distributed cache — data is shared across all processes
 * connected to the same Redis instance.
 *
 * @example
 * ```ts
 * import { RedisCache } from '@sveltex/cache/redis';
 * const cache = new RedisCache({ url: 'redis://localhost:6379', keyPrefix: 'myapp:' });
 * await cache.connect();
 * await cache.set('user:1', { name: 'Alice' }, { ttlMs: 60000 });
 * await cache.disconnect();
 * ```
 *
 * @public
 */
export class RedisCache implements CacheStore {
  readonly #redis: Redis;
  readonly #keyPrefix: string;
  readonly #defaultTtlMs: number | undefined;
  #connected = false;

  constructor(options: RedisCacheOptions = {}) {
    this.#redis = createRedisClient(options);
    this.#keyPrefix = options.keyPrefix ?? '';
    this.#defaultTtlMs = options.defaultTtlMs;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    await this.#redis.connect();
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    // Always close the underlying client: with lazyConnect a failed probe may
    // leave reconnect timers alive even though connect() never succeeded.
    await this.#redis.disconnect();
  }

  async get<T>(key: string): Promise<T | undefined> {
    validateCacheKey(key);
    const raw = await this.#redis.get(this.#prefixKey(key));
    if (raw === null) return undefined;
    return deserializeCacheValue(raw) as T;
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    validateCacheKey(key);
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (ttl !== undefined) {
      validateCacheTtl(ttl, true);
      if (ttl === 0) return;
    }
    const serialized = serializeCacheValue(value);
    const prefixedKey = this.#prefixKey(key);
    if (ttl !== undefined) {
      const ttlSeconds = Math.ceil(ttl / 1000);
      await this.#redis.setex(prefixedKey, ttlSeconds, serialized);
    } else {
      await this.#redis.set(prefixedKey, serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    validateCacheKey(key);
    const result = await this.#redis.del(this.#prefixKey(key));
    return result > 0;
  }

  async clear(): Promise<void> {
    if (this.#keyPrefix) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.#redis.scan(
          cursor,
          'MATCH',
          `${this.#keyPrefix}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) await this.#redis.del(...keys);
      } while (cursor !== '0');
    } else {
      await this.#redis.flushdb();
    }
  }

  async has(key: string): Promise<boolean> {
    validateCacheKey(key);
    const exists = await this.#redis.exists(this.#prefixKey(key));
    return exists === 1;
  }

  /**
   * Logical keys held under this adapter's `keyPrefix`. Without a prefix this
   * enumerates the entire selected database — the same scope `clear()` uses.
   * Satisfies `KeyedCacheStore`.
   */
  async keys(): Promise<readonly string[]> {
    const pattern = this.#keyPrefix ? `${this.#keyPrefix}*` : '*';
    const found: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.#redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const physical of batch) {
        if (!physical.startsWith(this.#keyPrefix)) continue;
        const logical = physical.slice(this.#keyPrefix.length);
        if (logical.length > 0) found.push(logical);
      }
    } while (cursor !== '0');
    return Object.freeze(found);
  }

  /**
   * Atomically increment a numeric value by the given amount and return the
   * new value. Implemented as a server-side Lua script so the counter stays in
   * the same envelope as values written by `set()`.
   */
  async increment(key: string, amount = 1): Promise<number> {
    validateCacheKey(key);
    if (!Number.isSafeInteger(amount)) {
      throw new RangeError('increment amount must be a safe integer.');
    }
    const result: unknown = await this.#redis.eval(
      INCREMENT_LUA,
      1,
      this.#prefixKey(key),
      CACHE_ENVELOPE_PREFIX,
      String(amount),
    );
    return Number(result);
  }

  /** Get the values for multiple keys in a single round-trip. */
  async getMany<T>(keys: readonly string[]): Promise<(T | undefined)[]> {
    for (const key of keys) validateCacheKey(key);
    if (keys.length === 0) return [];
    const prefixedKeys = keys.map((k) => this.#prefixKey(k));
    const values = await this.#redis.mget(...prefixedKeys);
    return values.map((v) => {
      if (v === null) return undefined;
      return deserializeCacheValue(v) as T;
    });
  }

  /** Set multiple key-value pairs in a single round-trip. */
  async setMany<T>(entries: readonly { key: string; value: T; ttlMs?: number }[]): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.#redis.pipeline();
    for (const entry of entries) {
      validateCacheKey(entry.key);
      const ttl = entry.ttlMs ?? this.#defaultTtlMs;
      const prefixedKey = this.#prefixKey(entry.key);
      if (ttl !== undefined) {
        validateCacheTtl(ttl, true);
        if (ttl === 0) {
          pipeline.del(prefixedKey);
          continue;
        }
      }
      const serialized = serializeCacheValue(entry.value);
      if (ttl !== undefined) {
        pipeline.setex(prefixedKey, Math.ceil(ttl / 1000), serialized);
      } else {
        pipeline.set(prefixedKey, serialized);
      }
    }
    await pipeline.exec();
  }

  /**
   * Bind a distributed tag-generation source to this adapter's connection.
   * Pass it to `TaggedCache` to get O(1), cross-process tag invalidation.
   */
  createTagVersionSource(): RedisTagVersionSource {
    return new RedisTagVersionSource({ redis: this.#redis, keyPrefix: this.#keyPrefix });
  }

  #prefixKey(key: string): string {
    return this.#keyPrefix + key;
  }
}

/** Options for {@link RedisTagVersionSource}. */
export type RedisTagVersionSourceOptions =
  | RedisCacheOptions
  | { readonly redis: Redis; readonly keyPrefix?: string };

/**
 * Distributed tag-generation source backed by real Redis `INCR`/`MGET`.
 *
 * A tag's generation is a plain integer key; bumping it is atomic, so several
 * processes invalidating the same tag cannot lose an update. This is the
 * cross-process counterpart of `InMemoryTagVersionSource`.
 */
export class RedisTagVersionSource implements CacheTagVersionSource {
  readonly #redis: Redis;
  readonly #ownsConnection: boolean;
  readonly #prefix: string;

  constructor(options: RedisTagVersionSourceOptions = {}) {
    if ('redis' in options) {
      this.#redis = options.redis;
      this.#ownsConnection = false;
      this.#prefix = `${options.keyPrefix ?? ''}${REDIS_TAG_VERSION_PREFIX}`;
    } else {
      this.#redis = createRedisClient(options);
      this.#ownsConnection = true;
      this.#prefix = `${options.keyPrefix ?? ''}${REDIS_TAG_VERSION_PREFIX}`;
    }
  }

  async connect(): Promise<void> {
    if (this.#ownsConnection) await this.#redis.connect();
  }

  async disconnect(): Promise<void> {
    if (this.#ownsConnection) await this.#redis.disconnect();
  }

  async versions(tags: readonly string[]): Promise<Readonly<Record<string, number>>> {
    for (const tag of tags) validateCacheTag(tag);
    const snapshot = Object.create(null) as Record<string, number>;
    if (tags.length === 0) return Object.freeze(snapshot);
    const keys = tags.map((tag) => `${this.#prefix}${tag}`);
    const values = await this.#redis.mget(...keys);
    for (let index = 0; index < tags.length; index += 1) {
      const tag = tags[index];
      if (tag === undefined) continue;
      const raw = values[index];
      const parsed = raw === null || raw === undefined ? 0 : Number(raw);
      snapshot[tag] = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    }
    return Object.freeze(snapshot);
  }

  async bump(tag: string): Promise<number> {
    validateCacheTag(tag);
    return this.#redis.incr(`${this.#prefix}${tag}`);
  }

  async reset(): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.#redis.scan(
        cursor,
        'MATCH',
        `${this.#prefix}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) await this.#redis.del(...keys);
    } while (cursor !== '0');
  }
}
