import { randomUUID } from 'node:crypto';
import { toError } from '@sveltex/shared';
import { JobsClosedError, JobsConfigurationError, JobsStoreError } from './index.js';
import type { EnqueueOptions, EnqueueResult, FailOptions, Job, JobQueue, JobStatus } from './index.js';
import { deserializeJobPayload, serializeJobPayload } from './serialization.js';
import { validateClaim, validateEnqueueOptions, validateFailOptions, validateJobId, validateTableName } from './validation.js';

/**
 * A minimal structural port over a driver-neutral SQL executor. `@sveltex/database`'s
 * `Database` facade satisfies this interface without `@sveltex/jobs` taking a hard
 * runtime dependency on it. The transaction callback receives a query-only executor.
 */
export type JobSqlValue = string | number | boolean | bigint | Date | Uint8Array | null;
export interface JobSqlResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number; }
export interface JobSqlQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly JobSqlValue[], options?: { readonly signal?: AbortSignal }): Promise<JobSqlResult<Row>>;
}
export interface JobSqlExecutor extends JobSqlQueryExecutor {
  transaction<T>(callback: (executor: JobSqlQueryExecutor) => Promise<T>, options?: { readonly signal?: AbortSignal }): Promise<T>;
}

/** `?` placeholders (SQLite) or `$1..$n` placeholders (PostgreSQL). */
export type JobSqlDialect = 'sqlite' | 'postgres';

export interface SqlJobQueueOptions {
  /** Plain SQL identifier, at most 48 characters. Defaults to `sveltex_jobs`. */
  readonly tableName?: string;
  readonly dialect?: JobSqlDialect;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

interface JobRow extends Record<string, unknown> {
  id?: unknown;
  name?: unknown;
  payload?: unknown;
  status?: unknown;
  attempts?: unknown;
  max_attempts?: unknown;
  created_at?: unknown;
  available_at?: unknown;
  dedupe_key?: unknown;
  last_error?: unknown;
}

const STATUSES = new Set<string>(['pending', 'active', 'completed', 'dead', 'cancelled']);

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') { const n = Number(value); return Number.isSafeInteger(n) ? n : undefined; }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) { const n = Number(value); return Number.isSafeInteger(n) ? n : undefined; }
  return undefined;
}

function rowToJob(row: JobRow): Job {
  const { id, name, payload, status } = row;
  if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || typeof payload !== 'string' || typeof status !== 'string' || !STATUSES.has(status)) {
    throw new JobsStoreError('Persisted job row has invalid scalar fields.', 'decode');
  }
  const attempts = toFiniteNumber(row['attempts']);
  const maxAttempts = toFiniteNumber(row['max_attempts']);
  const createdAt = toFiniteNumber(row['created_at']);
  const availableAt = toFiniteNumber(row['available_at']);
  if (attempts === undefined || maxAttempts === undefined || createdAt === undefined || availableAt === undefined) {
    throw new JobsStoreError('Persisted job row has invalid numeric fields.', 'decode');
  }
  const dedupeKey = row['dedupe_key'];
  const lastError = row['last_error'];
  if (dedupeKey !== undefined && dedupeKey !== null && typeof dedupeKey !== 'string') {
    throw new JobsStoreError('Persisted job row has an invalid dedupe_key.', 'decode');
  }
  if (lastError !== undefined && lastError !== null && typeof lastError !== 'string') {
    throw new JobsStoreError('Persisted job row has an invalid last_error.', 'decode');
  }
  return Object.freeze({
    id, name,
    payload: deserializeJobPayload(payload),
    status: status as JobStatus,
    attempts, maxAttempts, createdAt, availableAt,
    ...(typeof dedupeKey === 'string' ? { dedupeKey } : {}),
    ...(typeof lastError === 'string' ? { lastError } : {}),
  }) as Job;
}

function errorMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (pattern.test(message)) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

function isUniqueViolation(error: unknown): boolean {
  return errorMatches(error, /unique|duplicate|constraint/i);
}

/**
 * PostgreSQL's `CREATE ... IF NOT EXISTS` is NOT concurrency-safe: two fresh
 * connections racing through their first `ensureSchema()` can collide on the
 * catalog (`23505 pg_type_typname_nsp_index`) or deadlock. These are benign
 * once the winning transaction commits, so DDL is retried a bounded number of
 * times. Other failures (permissions, syntax, connectivity) still surface.
 */
const SCHEMA_RACE = /duplicate key|unique constraint|already exists|deadlock detected|tuple concurrently updated|23505|40P01/i;
function isSchemaRace(error: unknown): boolean {
  return errorMatches(error, SCHEMA_RACE);
}

/**
 * A durable, cross-process {@link JobQueue} backed by a real SQL database through
 * a BYO {@link JobSqlExecutor} (`@sveltex/database`'s `Database` satisfies it).
 *
 * `claim()` selects due rows and conditionally updates them inside one transaction
 * (with `FOR UPDATE SKIP LOCKED` on PostgreSQL), so concurrent workers cannot
 * claim the same job. A partial unique index on `dedupe_key` for pending/active
 * rows makes concurrent de-duplication atomic. `close()` only marks the queue
 * closed — the caller owns the executor's lifecycle.
 */
export class SqlJobQueue implements JobQueue {
  readonly #executor: JobSqlExecutor;
  readonly #table: string;
  readonly #dialect: JobSqlDialect;
  readonly #now: () => number;
  readonly #generateId: () => string;
  #schemaReady: Promise<void> | undefined;
  #closed = false;

  constructor(executor: JobSqlExecutor, options: SqlJobQueueOptions = {}) {
    if (!executor || typeof executor.query !== 'function' || typeof executor.transaction !== 'function') {
      throw new JobsConfigurationError('A SQL executor with query() and transaction() is required.');
    }
    const table = options.tableName ?? 'sveltex_jobs';
    validateTableName(table);
    const dialect = options.dialect ?? 'sqlite';
    if (dialect !== 'sqlite' && dialect !== 'postgres') {
      throw new JobsConfigurationError('dialect must be sqlite or postgres.');
    }
    this.#executor = executor;
    this.#table = table;
    this.#dialect = dialect;
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? (() => randomUUID());
  }

  get isClosed(): boolean { return this.#closed; }
  get tableName(): string { return this.#table; }
  get dialect(): JobSqlDialect { return this.#dialect; }

  /** Recommended DDL, exposed so applications can run it as a migration instead. */
  schemaStatements(): readonly string[] {
    return Object.freeze([
      `CREATE TABLE IF NOT EXISTS ${this.#table} (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  payload TEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  available_at BIGINT NOT NULL,
  dedupe_key VARCHAR(256),
  last_error TEXT
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${this.#table}_dq ON ${this.#table}(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','active')`,
    ]);
  }

  /** Create the table and dedupe index if needed. Memoized; safe before every operation. */
  async ensureSchema(): Promise<void> {
    if (!this.#schemaReady) this.#schemaReady = this.#createSchema();
    return this.#schemaReady;
  }

  async enqueue<TPayload>(options: EnqueueOptions<TPayload>, now: number = this.#now()): Promise<EnqueueResult> {
    this.#assertOpen();
    const validated = validateEnqueueOptions(options, now);
    const payload = serializeJobPayload(validated.payload);
    const id = this.#generateId();
    await this.ensureSchema();
    if (validated.dedupeKey !== undefined) {
      const existing = await this.#dedupeLookup(validated.dedupeKey);
      if (existing !== undefined) return Object.freeze({ job: existing, deduplicated: true });
    }
    const insert = this.#render(`INSERT INTO ${this.#table}
      (id, name, payload, status, attempts, max_attempts, created_at, available_at, dedupe_key, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const parameters: readonly JobSqlValue[] = [
      id, validated.name, payload, 'pending', 0, validated.maxAttempts, now,
      now + validated.delayMs, validated.dedupeKey ?? null, null,
    ];
    try {
      await this.#executor.query(insert, parameters);
    } catch (cause) {
      if (validated.dedupeKey !== undefined && isUniqueViolation(cause)) {
        const existing = await this.#dedupeLookup(validated.dedupeKey);
        if (existing !== undefined) return Object.freeze({ job: existing, deduplicated: true });
      }
      throw new JobsStoreError('SQL enqueue failed.', 'enqueue', { cause: toError(cause) });
    }
    const job = Object.freeze({
      id, name: validated.name, payload: validated.payload, status: 'pending' as const,
      attempts: 0, maxAttempts: validated.maxAttempts, createdAt: now, availableAt: now + validated.delayMs,
      ...(validated.dedupeKey !== undefined ? { dedupeKey: validated.dedupeKey } : {}),
    }) as Job;
    return Object.freeze({ job, deduplicated: false });
  }

  async claim(now: number, limit: number): Promise<readonly Job[]> {
    this.#assertOpen();
    validateClaim(now, limit);
    if (limit === 0) return Object.freeze([]);
    await this.ensureSchema();
    try {
      return await this.#executor.transaction(async (tx) => {
        const lock = this.#dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';
        const due = await tx.query<JobRow>(this.#render(
          `SELECT id FROM ${this.#table} WHERE status = ? AND available_at <= ? ORDER BY available_at, created_at, id LIMIT ?${lock}`),
        ['pending', now, limit]);
        const ids = due.rows.map((row) => {
          if (typeof row.id !== 'string' || row.id.length === 0) throw new JobsStoreError('Claim query returned an invalid id.', 'claim');
          return row.id;
        });
        if (ids.length === 0) return Object.freeze([]);
        const placeholders = ids.map(() => '?').join(', ');
        const updated = await tx.query(this.#render(
          `UPDATE ${this.#table} SET status = ?, attempts = attempts + 1 WHERE id IN (${placeholders}) AND status = ?`),
        ['active', ...ids, 'pending']);
        if (updated.rowCount !== ids.length) {
          // Defensive: if another transaction changed a candidate between the
          // SELECT and the UPDATE, never return rows this transaction did not own.
          throw new JobsStoreError('Concurrent claim modified candidate rows.', 'claim');
        }
        const rows = await tx.query<JobRow>(this.#render(
          `SELECT id, name, payload, status, attempts, max_attempts, created_at, available_at, dedupe_key, last_error
           FROM ${this.#table} WHERE id IN (${placeholders})`), ids);
        return Object.freeze(rows.rows.map(rowToJob));
      });
    } catch (cause) {
      if (cause instanceof JobsStoreError) throw cause;
      throw new JobsStoreError('SQL claim failed.', 'claim', { cause: toError(cause) });
    }
  }

  async complete(id: string): Promise<void> {
    this.#assertOpen();
    validateJobId(id);
    await this.ensureSchema();
    await this.#run(this.#render(
      `UPDATE ${this.#table} SET status = ? WHERE id = ? AND status = ?`),
    ['completed', id, 'active'], 'complete');
  }

  async fail(id: string, options: FailOptions): Promise<void> {
    this.#assertOpen();
    validateJobId(id);
    const validated = validateFailOptions(options);
    await this.ensureSchema();
    if (validated.retryAt === undefined) {
      await this.#run(this.#render(
        `UPDATE ${this.#table} SET status = ?, last_error = ? WHERE id = ? AND status = ?`),
      ['dead', validated.error, id, 'active'], 'fail');
    } else {
      await this.#run(this.#render(
        `UPDATE ${this.#table} SET status = ?, last_error = ?, available_at = ? WHERE id = ? AND status = ?`),
      ['pending', validated.error, validated.retryAt, id, 'active'], 'fail');
    }
  }

  async cancel(id: string): Promise<boolean> {
    this.#assertOpen();
    validateJobId(id);
    await this.ensureSchema();
    const result = await this.#run(this.#render(
      `UPDATE ${this.#table} SET status = ? WHERE id = ? AND status = ?`),
    ['cancelled', id, 'pending'], 'cancel');
    return result.rowCount === 1;
  }

  async get(id: string): Promise<Job | undefined> {
    this.#assertOpen();
    validateJobId(id);
    await this.ensureSchema();
    const result = await this.#run(this.#render(
      `SELECT id, name, payload, status, attempts, max_attempts, created_at, available_at, dedupe_key, last_error
       FROM ${this.#table} WHERE id = ?`), [id], 'get');
    const row = result.rows[0];
    return row === undefined ? undefined : rowToJob(row);
  }

  async list(): Promise<readonly Job[]> {
    this.#assertOpen();
    await this.ensureSchema();
    const result = await this.#run(`SELECT id, name, payload, status, attempts, max_attempts, created_at, available_at, dedupe_key, last_error FROM ${this.#table}`, [], 'list');
    return Object.freeze(result.rows.map(rowToJob));
  }

  /** Marks the queue closed. The caller owns (and must close) the BYO executor. */
  async close(): Promise<void> {
    this.#closed = true;
  }

  async #createSchema(): Promise<void> {
    for (const statement of this.schemaStatements()) {
      let failure: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.#executor.query(statement);
          failure = undefined;
          break;
        } catch (cause) {
          failure = cause;
          if (!isSchemaRace(cause)) break;
          // The winning connection committed; `IF NOT EXISTS` now resolves.
        }
      }
      if (failure !== undefined) {
        throw new JobsStoreError('Failed to create the job queue schema.', 'schema', { cause: toError(failure) });
      }
    }
  }

  async #dedupeLookup(key: string): Promise<Job | undefined> {
    const result = await this.#run(this.#render(
      `SELECT id, name, payload, status, attempts, max_attempts, created_at, available_at, dedupe_key, last_error
       FROM ${this.#table} WHERE dedupe_key = ? AND status IN ('pending','active') LIMIT 1`), [key], 'dedupe');
    const row = result.rows[0];
    return row === undefined ? undefined : rowToJob(row);
  }

  async #run(sql: string, parameters: readonly JobSqlValue[], operation: string): Promise<JobSqlResult<JobRow>> {
    try {
      return await this.#executor.query<JobRow>(sql, parameters);
    } catch (cause) {
      throw new JobsStoreError(`SQL ${operation} failed.`, operation, { cause: toError(cause) });
    }
  }

  #render(sql: string): string {
    if (this.#dialect !== 'postgres') return sql;
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  #assertOpen(): void {
    if (this.#closed) throw new JobsClosedError('The SQL job queue is closed.');
  }
}
