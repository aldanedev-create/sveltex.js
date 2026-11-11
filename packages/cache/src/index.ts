import { validateCacheKey, validateCacheTtl } from './validation.js';

/** Options accepted by {@link CacheStore.set}. */
export interface CacheSetOptions {
  /** Time-to-live in milliseconds. `0` deletes immediately; omitted means no expiry. */
  readonly ttlMs?: number;
}

/** Driver-neutral cache contract implemented by every store and decorator. */
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
}

export interface MemoryCacheOptions {
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number;
  readonly now?: () => number;
}

type Entry = { value: unknown; expiresAt: number | null };

/**
 * Bounded LRU cache for tests and single-process use; it is not a distributed
 * cache. Values are kept by reference (no serialization), so cached `undefined`
 * is distinguishable from a missing key via `has()`.
 */
export class MemoryCache implements CacheStore {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #defaultTtlMs: number | undefined;
  readonly #now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer.');
    }
    this.#defaultTtlMs = options.defaultTtlMs;
    if (this.#defaultTtlMs !== undefined) validateCacheTtl(this.#defaultTtlMs, true);
    this.#now = options.now ?? Date.now;
    this.#readClock();
  }

  async get<T>(key: string): Promise<T | undefined> {
    validateCacheKey(key);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#isExpired(entry)) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    validateCacheKey(key);
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (ttl !== undefined) validateCacheTtl(ttl, true);
    this.#entries.delete(key);
    if (ttl === 0) return;
    const now = this.#readClock();
    const expiresAt = ttl === undefined ? null : now + ttl;
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      throw new RangeError('ttlMs produces an invalid expiration time.');
    }
    this.#entries.set(key, { value, expiresAt });
    this.#enforceCapacity();
  }

  async delete(key: string): Promise<boolean> {
    validateCacheKey(key);
    return this.#entries.delete(key);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  async has(key: string): Promise<boolean> {
    validateCacheKey(key);
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (this.#isExpired(entry)) {
      this.#entries.delete(key);
      return false;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return true;
  }

  async size(): Promise<number> {
    this.#purgeExpired();
    return this.#entries.size;
  }

  /** Logical keys currently held, most-recently-used last. Satisfies `KeyedCacheStore`. */
  async keys(): Promise<readonly string[]> {
    this.#purgeExpired();
    return Object.freeze([...this.#entries.keys()]);
  }

  /**
   * Atomically (within this process) increment a numeric counter. A missing or
   * expired key starts at 0; a non-numeric live value is rejected rather than
   * silently reset.
   */
  async increment(key: string, amount = 1): Promise<number> {
    validateCacheKey(key);
    if (!Number.isSafeInteger(amount)) {
      throw new RangeError('increment amount must be a safe integer.');
    }
    const entry = this.#entries.get(key);
    const live = entry !== undefined && !this.#isExpired(entry);
    if (live && entry !== undefined && typeof entry.value !== 'number') {
      throw new TypeError('Cannot increment a non-numeric cached value.');
    }
    const current = live && entry !== undefined && typeof entry.value === 'number' ? entry.value : 0;
    const next = current + amount;
    if (!Number.isSafeInteger(next)) throw new RangeError('Counter overflow.');
    this.#entries.delete(key);
    this.#entries.set(key, {
      value: next,
      expiresAt: live && entry !== undefined ? entry.expiresAt : null,
    });
    this.#enforceCapacity();
    return next;
  }

  #readClock(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new RangeError('The cache clock must return a finite number.');
    return now;
  }

  #isExpired(entry: Entry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.#readClock();
  }

  #purgeExpired(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#isExpired(entry)) this.#entries.delete(key);
    }
  }

  #enforceCapacity(): void {
    this.#purgeExpired();
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

export * from './errors.js';
export * from './validation.js';
export * from './serialization.js';
export * from './namespace.js';
export * from './invalidation.js';
export * from './tags.js';
export * from './fallback.js';
export * from './stampede.js';
