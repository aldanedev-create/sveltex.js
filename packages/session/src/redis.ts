import { Redis } from 'ioredis';
import { cloneData, deepFreeze } from '@sveltex/shared';
import type { SessionRecord, SessionStore } from './index.js';

/**
 * Connection and behaviour options for {@link RedisSessionStore}.
 *
 * @public
 */
export interface RedisSessionStoreOptions {
  /** Redis connection URL (e.g., `redis://localhost:6379`). */
  readonly url?: string;
  /** Individual connection options as an alternative to `url`. */
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
  readonly db?: number;
  /** Prefix prepended to every Redis key for namespace isolation. Strongly recommended on shared instances. */
  readonly keyPrefix?: string;
  /** Connection timeout in milliseconds. */
  readonly connectTimeoutMs?: number;
  /** Maximum reconnect retry attempts per request. */
  readonly maxRetriesPerRequest?: number;
  /**
   * Clock used to derive relative TTLs and to validate logical expiry. Defaults to `Date.now`.
   * When used together with {@link SessionManager}, pass the **same** clock to both so that
   * logical expiry and Redis' physical TTL stay consistent.
   */
  readonly now?: () => number;
}

/**
 * A Redis-backed {@link SessionStore} whose mutating operations are genuinely atomic.
 *
 * Every record is stored as a single JSON value under `<keyPrefix><id>` with a physical TTL
 * derived from `record.expiresAt`. The three state-changing operations are implemented as
 * server-side Lua scripts executed with `EVAL`, so a check and its write cannot interleave
 * with another process — this is what prevents resurrected sessions and lost concurrent
 * updates across multiple application instances.
 *
 * - `createIfAbsent` inserts only when the key is absent (SET-NX semantics).
 * - `compareAndSet` swaps only when the stored `revision` equals `expectedRevision`.
 * - `rotate` atomically writes the new key and removes the old one, only when the old key
 *   exists at the expected revision and the new key is free.
 *
 * Requires an explicit {@link connect} / {@link disconnect} lifecycle, matching the other
 * real adapters in this workspace (`RedisCache`, `Database`).
 *
 * @example
 * ```ts
 * import { RedisSessionStore } from '@sveltex/session/redis';
 * import { SessionManager } from '@sveltex/session';
 *
 * const store = new RedisSessionStore({ url: 'redis://localhost:6379', keyPrefix: 'myapp:sess:' });
 * await store.connect();
 * const sessions = new SessionManager(store, { ttlMs: 60 * 60 * 1000 });
 * const session = await sessions.create({ userId: 'user-123' });
 * await store.disconnect();
 * ```
 *
 * @public
 */
export class RedisSessionStore<Data extends Record<string, unknown> = Record<string, unknown>> implements SessionStore<Data> {
  readonly #redis: Redis;
  readonly #keyPrefix: string;
  readonly #now: () => number;
  #connected = false;

  constructor(options: RedisSessionStoreOptions = {}) {
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
    this.#now = options.now ?? Date.now;
  }

  /** Open the connection. Idempotent. */
  async connect(): Promise<void> {
    if (this.#connected) return;
    await this.#redis.connect();
    this.#connected = true;
  }

  /** Close the connection and release the socket. Idempotent. */
  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    await this.#redis.disconnect();
  }

  async get(id: string): Promise<SessionRecord<Data> | undefined> {
    validateKey(id);
    const key = this.#key(id);
    const raw = await this.#redis.get(key);
    if (raw === null) return undefined;
    const record = this.#parse(raw, id);
    if (!record) {
      // Corrupt, tampered, or logically expired data must not be served.
      await this.#redis.del(key);
      return undefined;
    }
    return record;
  }

  async createIfAbsent(record: SessionRecord<Data>): Promise<boolean> {
    validateKey(record.id);
    const ttl = record.expiresAt - this.#now();
    if (ttl <= 0 || !Number.isFinite(ttl)) return false;
    const result = await this.#run(CREATE_IF_ABSENT_SCRIPT, 1,
      this.#key(record.id), serialize(record), String(Math.ceil(ttl)));
    return result === 1;
  }

  async compareAndSet(id: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean> {
    validateKey(id);
    if (record.id !== id) return false;
    const ttl = record.expiresAt - this.#now();
    if (ttl <= 0 || !Number.isFinite(ttl)) return false;
    const result = await this.#run(COMPARE_AND_SET_SCRIPT, 1,
      this.#key(id), String(expectedRevision), serialize(record), String(Math.ceil(ttl)), id);
    return result === 1;
  }

  async delete(id: string): Promise<void> {
    validateKey(id);
    await this.#redis.del(this.#key(id));
  }

  async rotate(oldId: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean> {
    validateKey(oldId);
    validateKey(record.id);
    if (record.id === oldId) return false;
    const ttl = record.expiresAt - this.#now();
    if (ttl <= 0 || !Number.isFinite(ttl)) return false;
    const result = await this.#run(ROTATE_SCRIPT, 2,
      this.#key(oldId), this.#key(record.id), String(expectedRevision), serialize(record), String(Math.ceil(ttl)), oldId);
    return result === 1;
  }

  /**
   * Remove every key owned by this store's namespace. Uses `SCAN` + `DEL` (never `FLUSHDB`),
   * so it is safe on a shared Redis instance. Requires a non-empty `keyPrefix`.
   */
  async clear(): Promise<void> {
    if (!this.#keyPrefix) {
      throw new TypeError('clear() requires a keyPrefix to avoid deleting unrelated keys on a shared instance.');
    }
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.#redis.scan(cursor, 'MATCH', `${this.#keyPrefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await this.#redis.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Revoke every session belonging to a user (logout-all-devices). Because the Redis
   * store keeps no secondary user index, this performs a namespace-scoped `SCAN` and
   * inspects each record — correct but O(N) in the number of active sessions. For large
   * deployments, maintain a per-user set at write time instead. Requires a `keyPrefix`.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) throw new TypeError('A valid userId is required.');
    if (!this.#keyPrefix) {
      throw new TypeError('revokeAllForUser() requires a keyPrefix to avoid scanning unrelated keys on a shared instance.');
    }
    let removed = 0;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.#redis.scan(cursor, 'MATCH', `${this.#keyPrefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const raw = await this.#redis.get(key);
        if (raw === null) continue;
        const record = this.#parse(raw, key.slice(this.#keyPrefix.length));
        if (!record) continue;
        if ((record.data as Record<string, unknown>)['userId'] === userId) removed += Number(await this.#redis.del(key));
      }
    } while (cursor !== '0');
    return removed;
  }

  async #run(script: string, keyCount: number, ...args: string[]): Promise<number> {
    const result: unknown = await this.#redis.eval(script, keyCount, ...args);
    return Number(result);
  }

  #parse(raw: string, id: string): SessionRecord<Data> | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    const createdAt = obj['createdAt'];
    const expiresAt = obj['expiresAt'];
    const revision = obj['revision'];
    const data = obj['data'];
    if (obj['id'] !== id) return undefined;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return undefined;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= createdAt) return undefined;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
    if (expiresAt <= this.#now()) return undefined;
    let frozen: Readonly<Data>;
    try {
      frozen = deepFreeze(cloneData(data)) as Readonly<Data>;
    } catch {
      return undefined;
    }
    return Object.freeze({ id, data: frozen, createdAt, expiresAt, revision });
  }

  #key(id: string): string {
    return this.#keyPrefix + id;
  }
}

/** Insert only when the key is absent. KEYS[1]=key, ARGV[1]=value, ARGV[2]=ttl(ms). */
const CREATE_IF_ABSENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
return 1
`;

/** Swap only when the stored revision matches. KEYS[1]=key; ARGV=expectedRev,value,ttl,id. */
const COMPARE_AND_SET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok or type(current) ~= 'table' then return 0 end
if current.id ~= ARGV[4] then return 0 end
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return 0 end
redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[2])
return 1
`;

/** Atomically move oldId -> newId. KEYS[1]=oldKey, KEYS[2]=newKey; ARGV=expectedRev,value,ttl,oldId. */
const ROTATE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok or type(current) ~= 'table' then return 0 end
if current.id ~= ARGV[4] then return 0 end
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return 0 end
redis.call('PSETEX', KEYS[2], ARGV[3], ARGV[2])
redis.call('DEL', KEYS[1])
return 1
`;

function serialize<Data extends Record<string, unknown>>(record: SessionRecord<Data>): string {
  return JSON.stringify({
    id: record.id,
    data: record.data,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revision: record.revision,
  });
}

function validateKey(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw new TypeError('Session identifiers must be non-empty strings no longer than 256 characters.');
  }
}
