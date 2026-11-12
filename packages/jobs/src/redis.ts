import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { toError } from '@sveltex/shared';
import { JobsClosedError, JobsConfigurationError, JobsStoreError } from './index.js';
import type { EnqueueOptions, EnqueueResult, FailOptions, Job, JobQueue } from './index.js';
import { decodeJob, encodeJobRecord, serializeJobPayload } from './serialization.js';
import type { JobRecord } from './serialization.js';
import { validateClaim, validateEnqueueOptions, validateFailOptions, validateJobId } from './validation.js';

/**
 * Options for a real Redis-backed job queue. Every queue creates its own
 * `ioredis` client, so two `RedisJobQueue` instances pointed at the same Redis
 * are genuinely independent workers competing for the same durable jobs.
 */
export interface RedisJobQueueOptions {
  /** Redis connection URL (e.g. `redis://localhost:6379`). */
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
  readonly db?: number;
  /** Namespace for every key. Use a `{hash-tag}` prefix on Redis Cluster. */
  readonly keyPrefix?: string;
  readonly connectTimeoutMs?: number;
  readonly maxRetriesPerRequest?: number;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

const KEY_PREFIX_RE = /^[A-Za-z0-9._:{}-]{0,128}$/;

const ENQUEUE_LUA = `
local hasDedupe = ARGV[5] == '1'
if hasDedupe then
  local existingId = redis.call('GET', KEYS[4])
  if existingId then
    local raw = redis.call('GET', ARGV[1] .. 'job:' .. existingId)
    if raw then
      local ok, rec = pcall(cjson.decode, raw)
      if ok and (rec.status == 'pending' or rec.status == 'active') then
        return {raw, '1'}
      end
    end
    redis.call('DEL', KEYS[4])
  end
  redis.call('SET', KEYS[4], ARGV[4])
end
redis.call('SET', KEYS[3], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return {ARGV[2], '0'}
`;

const CLAIM_LUA = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[2], 'LIMIT', 0, ARGV[3])
local out = {}
for i = 1, #ids do
  local id = ids[i]
  local k = ARGV[1] .. 'job:' .. id
  local raw = redis.call('GET', k)
  if raw then
    local ok, rec = pcall(cjson.decode, raw)
    if ok and rec.status == 'pending' and rec.availableAt <= tonumber(ARGV[2]) then
      rec.status = 'active'
      rec.attempts = rec.attempts + 1
      local encoded = cjson.encode(rec)
      redis.call('SET', k, encoded)
      redis.call('ZREM', KEYS[1], id)
      out[#out + 1] = encoded
    else
      redis.call('ZREM', KEYS[1], id)
    end
  else
    redis.call('ZREM', KEYS[1], id)
  end
end
return out
`;

const FINALIZE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, rec = pcall(cjson.decode, raw)
if not ok or rec.status ~= 'active' then return 0 end
rec.status = ARGV[2]
if ARGV[6] == '1' then rec.lastError = ARGV[3] end
if ARGV[2] == 'pending' then
  rec.availableAt = tonumber(ARGV[4])
  redis.call('ZADD', KEYS[2], rec.availableAt, ARGV[5])
else
  if rec.dedupeKey then redis.call('DEL', ARGV[1] .. 'dedupe:' .. rec.dedupeKey) end
end
redis.call('SET', KEYS[1], cjson.encode(rec))
return 1
`;

const CANCEL_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, rec = pcall(cjson.decode, raw)
if not ok or rec.status ~= 'pending' then return 0 end
rec.status = 'cancelled'
if rec.dedupeKey then redis.call('DEL', ARGV[1] .. 'dedupe:' .. rec.dedupeKey) end
redis.call('SET', KEYS[1], cjson.encode(rec))
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

function createClient(options: RedisJobQueueOptions): Redis {
  const common = {
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
    lazyConnect: true,
  };
  const conditional = {
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
  };
  if (options.url) return new Redis(options.url, { ...common, ...conditional });
  return new Redis({ ...common, ...conditional, host: options.host ?? '127.0.0.1', port: options.port ?? 6379 });
}

/**
 * A durable, cross-process {@link JobQueue} backed by a real Redis server.
 *
 * `enqueue`, `claim`, `complete`, `fail` and `cancel` are each a single Lua
 * script, so state transitions are atomic on the Redis server — concurrent
 * workers on different processes cannot claim the same job twice. Delayed
 * visibility uses a sorted set keyed by `availableAt`; payloads use the strict
 * `sveltex-jobs:v1:` envelope. Requires a single Redis instance (or a shared
 * hash-tag slot on Cluster); no fake provider is used.
 */
export class RedisJobQueue implements JobQueue {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #now: () => number;
  readonly #generateId: () => string;
  #connecting: Promise<void> | undefined;
  #closed = false;

  constructor(options: RedisJobQueueOptions = {}) {
    const prefix = options.keyPrefix ?? 'sveltex-jobs:';
    if (!KEY_PREFIX_RE.test(prefix)) {
      throw new JobsConfigurationError('keyPrefix must be a bounded Redis key segment (letters, digits, . _ : { } -).');
    }
    this.#prefix = prefix;
    this.#redis = createClient(options);
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? (() => randomUUID());
  }

  get isClosed(): boolean { return this.#closed; }
  get keyPrefix(): string { return this.#prefix; }

  /** Explicitly connect. Optional: the first operation connects lazily. Idempotent. */
  async connect(): Promise<void> {
    await this.#client();
  }

  async enqueue<TPayload>(options: EnqueueOptions<TPayload>, now: number = this.#now()): Promise<EnqueueResult> {
    this.#assertOpen();
    const validated = validateEnqueueOptions(options, now);
    const payload = serializeJobPayload(validated.payload);
    const id = this.#generateId();
    const record: JobRecord = {
      v: 1,
      id,
      name: validated.name,
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: validated.maxAttempts,
      createdAt: now,
      availableAt: now + validated.delayMs,
      dedupeKey: validated.dedupeKey,
      lastError: undefined,
    };
    const raw = encodeJobRecord(record);
    const hasDedupe = validated.dedupeKey !== undefined ? '1' : '0';
    const result = await this.#eval(
      ENQUEUE_LUA,
      [this.#ready(), this.#all(), this.#job(id), `${this.#prefix}dedupe:${validated.dedupeKey ?? '__none__'}`],
      [this.#prefix, raw, record.availableAt, id, hasDedupe],
      'enqueue',
    );
    const pair: unknown = result;
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') {
      throw new JobsStoreError('Redis enqueue returned an invalid result.', 'enqueue');
    }
    return Object.freeze({ job: decodeJob(pair[0] as string), deduplicated: String(pair[1]) === '1' });
  }

  async claim(now: number, limit: number): Promise<readonly Job[]> {
    this.#assertOpen();
    validateClaim(now, limit);
    if (limit === 0) return Object.freeze([]);
    const result = await this.#eval(CLAIM_LUA, [this.#ready(), this.#all()], [this.#prefix, now, limit], 'claim');
    const rows: unknown = result;
    if (!Array.isArray(rows)) throw new JobsStoreError('Redis claim returned an invalid result.', 'claim');
    return Object.freeze(rows.map((row) => {
      if (typeof row !== 'string') throw new JobsStoreError('Redis claim returned a non-string row.', 'claim');
      return decodeJob(row);
    }));
  }

  async complete(id: string): Promise<void> {
    this.#assertOpen();
    validateJobId(id);
    await this.#finalize(id, 'completed', undefined, false);
  }

  async fail(id: string, options: FailOptions): Promise<void> {
    this.#assertOpen();
    validateJobId(id);
    const validated = validateFailOptions(options);
    await this.#finalize(id, validated.retryAt === undefined ? 'dead' : 'pending', validated, true);
  }

  async cancel(id: string): Promise<boolean> {
    this.#assertOpen();
    validateJobId(id);
    const result = await this.#eval(
      CANCEL_LUA,
      [this.#job(id), this.#ready()],
      [this.#prefix, id],
      'cancel',
    );
    return Number(result) === 1;
  }

  async get(id: string): Promise<Job | undefined> {
    this.#assertOpen();
    validateJobId(id);
    const client = await this.#client();
    let raw: string | null;
    try {
      raw = await client.get(this.#job(id));
    } catch (cause) {
      throw new JobsStoreError('Redis get failed.', 'get', { cause: toError(cause) });
    }
    return raw === null ? undefined : decodeJob(raw);
  }

  async list(): Promise<readonly Job[]> {
    this.#assertOpen();
    const client = await this.#client();
    let ids: string[];
    let raws: (string | null)[];
    try {
      ids = await client.smembers(this.#all());
      if (ids.length === 0) return Object.freeze([]);
      raws = await client.mget(...ids.map((id) => this.#job(id)));
    } catch (cause) {
      throw new JobsStoreError('Redis list failed.', 'list', { cause: toError(cause) });
    }
    return Object.freeze(raws.filter((raw): raw is string => typeof raw === 'string').map(decodeJob));
  }

  /** Idempotent. Always disconnects the underlying client so no reconnect timers survive. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#redis.disconnect();
    } catch (cause) {
      throw new JobsStoreError('Redis disconnect failed.', 'close', { cause: toError(cause) });
    }
  }

  async #finalize(id: string, status: 'completed' | 'pending' | 'dead', validated: { readonly error: string; readonly retryAt: number | undefined } | undefined, setError: boolean): Promise<void> {
    await this.#eval(
      FINALIZE_LUA,
      [this.#job(id), this.#ready()],
      [this.#prefix, status, validated?.error ?? '', validated?.retryAt ?? '', id, setError ? '1' : '0'],
      status === 'completed' ? 'complete' : 'fail',
    );
  }

  async #eval(script: string, keys: readonly string[], args: readonly (string | number)[], operation: string): Promise<unknown> {
    const client = await this.#client();
    try {
      return await client.eval(script, keys.length, ...keys, ...args.map(String));
    } catch (cause) {
      throw new JobsStoreError(`Redis ${operation} failed.`, operation, { cause: toError(cause) });
    }
  }

  async #client(): Promise<Redis> {
    if (this.#closed) throw new JobsClosedError('The Redis job queue is closed.');
    if (!this.#connecting) {
      this.#connecting = this.#redis.connect().then(() => undefined).catch((cause: unknown) => {
        this.#connecting = undefined;
        throw new JobsStoreError('Failed to connect to Redis.', 'connect', { cause: toError(cause) });
      });
    }
    await this.#connecting;
    return this.#redis;
  }

  #assertOpen(): void {
    if (this.#closed) throw new JobsClosedError('The Redis job queue is closed.');
  }

  #ready(): string { return `${this.#prefix}ready`; }
  #all(): string { return `${this.#prefix}all`; }
  #job(id: string): string { return `${this.#prefix}job:${id}`; }
}
