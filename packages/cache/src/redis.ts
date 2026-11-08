import { Redis } from 'ioredis';
import type { CacheStore, CacheSetOptions } from './index.js';

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

/**
 * Redis-backed cache implementing the {@link CacheStore} contract.
 *
 * Uses `ioredis` for Redis connectivity. Values are serialized as JSON.
 * TTL is handled natively by Redis `EXPIRE`/`SETEX`. The `keyPrefix` option
 * provides namespace isolation by prefixing all keys.
 *
 * This is a true distributed cache — data is shared across all processes
 * connected to the same Redis instance.
 *
 * @example
 * ```ts
 * import { RedisCache } from '@sveltex/cache/redis';
 *
 * const cache = new RedisCache({ url: 'redis://localhost:6379', keyPrefix: 'myapp:' });
 * await cache.set('user:1', { name: 'Alice' }, { ttlMs: 60000 });
 * const user = await cache.get('user:1');
 * console.log(user); // { name: 'Alice' }
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
      this.#redis = new Redis(options.url, { ...common, ...conditional });
    } else {
      this.#redis = new Redis({
        ...common,
        ...conditional,
        host: options.host ?? 'localhost',
        port: options.port ?? 6379,
      });
    }
    this.#keyPrefix = options.keyPrefix ?? '';
    this.#defaultTtlMs = options.defaultTtlMs;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    await this.#redis.connect();
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    await this.#redis.disconnect();
  }

  async get<T>(key: string): Promise<T | undefined> {
    validateKey(key);
    const raw = await this.#redis.get(this.#prefixKey(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    validateKey(key);
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (ttl !== undefined) {
      validateTtl(ttl);
      if (ttl === 0) return;
    }
    const serialized = JSON.stringify(value);
    const prefixedKey = this.#prefixKey(key);
    if (ttl !== undefined) {
      // Use SETEX for TTL in seconds (Redis uses seconds for EXPIRE)
      const ttlSeconds = Math.ceil(ttl / 1000);
      await this.#redis.setex(prefixedKey, ttlSeconds, serialized);
    } else {
      await this.#redis.set(prefixedKey, serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    validateKey(key);
    const result = await this.#redis.del(this.#prefixKey(key));
    return result > 0;
  }

  async clear(): Promise<void> {
    if (this.#keyPrefix) {
      // Only clear keys with our prefix
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
        if (keys.length > 0) {
          await this.#redis.del(...keys);
        }
      } while (cursor !== '0');
    } else {
      await this.#redis.flushdb();
    }
  }

  async has(key: string): Promise<boolean> {
    validateKey(key);
    const exists = await this.#redis.exists(this.#prefixKey(key));
    return exists === 1;
  }

  /**
   * Atomically increment a numeric value by the given amount.
   * Returns the value after increment.
   */
  async increment(key: string, amount = 1): Promise<number> {
    validateKey(key);
    const result = await this.#redis.incrby(this.#prefixKey(key), amount);
    return result;
  }

  /**
   * Get the values for multiple keys in a single round-trip.
   */
  async getMany<T>(keys: readonly string[]): Promise<(T | undefined)[]> {
    for (const key of keys) validateKey(key);
    const prefixedKeys = keys.map(k => this.#prefixKey(k));
    const values = await this.#redis.mget(...prefixedKeys);
    return values.map(v => {
      if (v === null) return undefined;
      try {
        return JSON.parse(v) as T;
      } catch {
        return undefined;
      }
    });
  }

  /**
   * Set multiple key-value pairs in a single round-trip.
   */
  async setMany<T>(entries: readonly { key: string; value: T; ttlMs?: number }[]): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.#redis.pipeline();
    for (const entry of entries) {
      validateKey(entry.key);
      const ttl = entry.ttlMs ?? this.#defaultTtlMs;
      const serialized = JSON.stringify(entry.value);
      const prefixedKey = this.#prefixKey(entry.key);
      if (ttl !== undefined && ttl > 0) {
        pipeline.setex(prefixedKey, Math.ceil(ttl / 1000), serialized);
      } else {
        pipeline.set(prefixedKey, serialized);
      }
    }
    await pipeline.exec();
  }

  #prefixKey(key: string): string {
    return this.#keyPrefix + key;
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
    throw new TypeError('Cache keys must be non-empty strings no longer than 1024 characters.');
  }
}

function validateTtl(ttl: number): void {
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new RangeError('ttlMs must be a non-negative finite number.');
  }
}
