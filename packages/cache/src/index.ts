export interface CacheSetOptions { readonly ttlMs?: number; }
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
}
export interface MemoryCacheOptions { readonly maxEntries?: number; readonly defaultTtlMs?: number; readonly now?: () => number; }
type Entry = { value: unknown; expiresAt: number | null };

/** Bounded LRU cache for tests and single-process use; it is not a distributed cache. */
export class MemoryCache implements CacheStore {
  readonly #entries = new Map<string, Entry>;
  readonly #maxEntries: number;
  readonly #defaultTtlMs: number | undefined;
  readonly #now: () => number;
  constructor(options: MemoryCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) throw new RangeError('maxEntries must be a positive safe integer.');
    this.#defaultTtlMs = options.defaultTtlMs;
    if (this.#defaultTtlMs !== undefined) validateTtl(this.#defaultTtlMs, true);
    this.#now = options.now ?? Date.now;
    this.#readClock();
  }
  async get<T>(key: string): Promise<T | undefined> {
    validateKey(key);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#isExpired(entry)) { this.#entries.delete(key); return undefined; }
    this.#entries.delete(key); this.#entries.set(key, entry);
    return entry.value as T;
  }
  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    validateKey(key);
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (ttl !== undefined) validateTtl(ttl, true);
    this.#entries.delete(key);
    if (ttl === 0) return;
    const now = this.#readClock();
    const expiresAt = ttl === undefined ? null : now + ttl;
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new RangeError('ttlMs produces an invalid expiration time.');
    this.#entries.set(key, { value, expiresAt });
    this.#purgeExpired();
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
  async delete(key: string): Promise<boolean> { validateKey(key); return this.#entries.delete(key); }
  async clear(): Promise<void> { this.#entries.clear(); }
  async has(key: string): Promise<boolean> {
    validateKey(key);
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (this.#isExpired(entry)) { this.#entries.delete(key); return false; }
    this.#entries.delete(key); this.#entries.set(key, entry);
    return true;
  }
  async size(): Promise<number> { this.#purgeExpired(); return this.#entries.size; }
  #readClock(): number { const now = this.#now(); if (!Number.isFinite(now)) throw new RangeError('The cache clock must return a finite number.'); return now; }
  #isExpired(entry: Entry): boolean { return entry.expiresAt !== null && entry.expiresAt <= this.#readClock(); }
  #purgeExpired(): void { for (const [key, entry] of this.#entries) if (this.#isExpired(entry)) this.#entries.delete(key); }
}
function validateKey(key: string): void { if (typeof key !== 'string' || key.length === 0 || key.length > 1024) throw new TypeError('Cache keys must be non-empty strings no longer than 1024 characters.'); }
function validateTtl(ttl: number, allowZero: boolean): void { if (!Number.isFinite(ttl) || ttl < 0 || (!allowZero && ttl === 0)) throw new RangeError('ttlMs must be a non-negative finite number.'); }
