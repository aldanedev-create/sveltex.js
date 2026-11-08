export type QueryValue = string | number | boolean | bigint | Date | Uint8Array | null;
export interface QueryResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number; }
export interface QueryOptions { readonly signal?: AbortSignal; }

/**
 * Driver-neutral connection-pool tuning. Pooled adapters map these values onto
 * their underlying driver; the SQLite adapter has no pool and ignores them.
 *
 * `rowCount` returned by any adapter is the number of rows returned by a
 * `SELECT`/`RETURNING` statement, or the number of rows affected by an
 * `INSERT`/`UPDATE`/`DELETE` statement.
 *
 * @public
 */
export interface PoolConfig {
  /** Maximum pooled connections (default: 10, maximum: 1000). */
  readonly max?: number;
  /** Milliseconds an idle connection may stay open (default: 30000). */
  readonly idleTimeoutMs?: number;
  /** Milliseconds allowed to establish a connection (default: 5000). */
  readonly connectionTimeoutMs?: number;
  /** Milliseconds allowed to wait for a free connection (default: 10000). */
  readonly acquireTimeoutMs?: number;
}

export interface DatabaseExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly QueryValue[], options?: QueryOptions): Promise<QueryResult<Row>>;
}
export interface DatabaseDriver extends DatabaseExecutor {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  transaction<T>(callback: (executor: DatabaseExecutor) => Promise<T>, options?: QueryOptions): Promise<T>;
}
export type DatabaseState = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed';

/** Lifecycle-safe facade over a database-specific driver. It never constructs SQL from user input. */
export class Database {
  readonly #driver: DatabaseDriver;
  #state: DatabaseState = 'idle';
  #connectPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #activeOperations = 0;
  #drainOperations: (() => void) | undefined;
  constructor(driver: DatabaseDriver) {
    if (!driver || typeof driver.connect !== 'function' || typeof driver.disconnect !== 'function' || typeof driver.query !== 'function' || typeof driver.transaction !== 'function') throw new TypeError('A complete database driver is required.');
    this.#driver = driver;
  }
  get state(): DatabaseState { return this.#state; }
  async connect(): Promise<void> {
    if (this.#state === 'ready') return;
    if (this.#state === 'closing' || this.#state === 'closed') throw new DatabaseLifecycleError('Database is closed and cannot be reconnected.');
    if (this.#connectPromise) return this.#connectPromise;
    this.#state = 'connecting';
    this.#connectPromise = this.#driver.connect().then(() => { if (this.#state === 'connecting') this.#state = 'ready'; }).catch(cause => { this.#state = 'failed'; throw new DatabaseDriverError('Database connection failed.', { cause }); }).finally(() => { this.#connectPromise = undefined; });
    return this.#connectPromise;
  }
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly QueryValue[] = [], options?: QueryOptions): Promise<QueryResult<Row>> {
    this.#beginOperation();
    try {
      validateQuery(sql, parameters); assertNotAborted(options?.signal);
      let result: QueryResult<Row>;
      try { result = await this.#driver.query<Row>(sql, parameters, options); }
      catch (cause) { throw new DatabaseDriverError('Database query failed.', { cause }); }
      return normalizeResult(result);
    } finally { this.#endOperation(); }
  }
  async transaction<T>(callback: (executor: DatabaseExecutor) => Promise<T>, options?: QueryOptions): Promise<T> {
    if (typeof callback !== 'function') throw new TypeError('A transaction callback is required.');
    this.#beginOperation();
    try {
      assertNotAborted(options?.signal);
      let callbackFailure: unknown;
      let callbackFailed = false;
      try {
        return await this.#driver.transaction(async executor => {
          let active = true;
          const scoped: DatabaseExecutor = Object.freeze({ query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly QueryValue[] = [], queryOptions?: QueryOptions) => {
            if (!active) throw new DatabaseLifecycleError('The transaction executor is no longer active.');
            validateQuery(sql, parameters); assertNotAborted(queryOptions?.signal ?? options?.signal);
            let result: QueryResult<Row>;
            try { result = await executor.query<Row>(sql, parameters, queryOptions ?? options); }
            catch (cause) { throw new DatabaseDriverError('Database transaction query failed.', { cause }); }
            return normalizeResult(result);
          } });
          try { return await callback(scoped); }
          catch (cause) { callbackFailed = true; callbackFailure = cause; throw cause; }
          finally { active = false; }
        }, options);
      } catch (cause) {
        if (callbackFailed && cause === callbackFailure) throw cause;
        if (cause instanceof DatabaseError) throw cause;
        throw new DatabaseDriverError('Database transaction failed.', { cause });
      }
    } finally { this.#endOperation(); }
  }
  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = (async () => {
      try { if (this.#connectPromise) await this.#connectPromise.catch(() => undefined); if (this.#activeOperations > 0) await new Promise<void>(resolve => { this.#drainOperations = resolve; }); await this.#driver.disconnect(); this.#state = 'closed'; }
      catch (cause) { this.#state = 'failed'; throw new DatabaseDriverError('Database shutdown failed.', { cause }); }
    })();
    return this.#closePromise;
  }
  #beginOperation(): void { if (this.#state !== 'ready') throw new DatabaseLifecycleError(`Database operations require the ready state; current state is ${this.#state}.`); this.#activeOperations += 1; }
  #endOperation(): void { this.#activeOperations -= 1; if (this.#activeOperations === 0) { const resolve = this.#drainOperations; this.#drainOperations = undefined; resolve?.(); } }
}

export class DatabaseError extends Error { readonly code: string; constructor(message: string, code: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = 'DatabaseError'; this.code = code; } }
export class DatabaseLifecycleError extends DatabaseError { constructor(message: string) { super(message, 'DATABASE_LIFECYCLE'); this.name = 'DatabaseLifecycleError'; } }
export class DatabaseDriverError extends DatabaseError { constructor(message: string, options: { cause?: unknown } = {}) { super(message, 'DATABASE_DRIVER', options.cause); this.name = 'DatabaseDriverError'; } }
function validateQuery(sql: string, parameters: readonly QueryValue[]): void {
  if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 1_000_000) throw new TypeError('SQL must be a non-empty string no longer than 1,000,000 characters.');
  if (!Array.isArray(parameters)) throw new TypeError('Query parameters must be an array.');
  for (const value of parameters) if (!(value === null || ['string', 'boolean', 'bigint'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value) || value instanceof Date && Number.isFinite(value.getTime()) || value instanceof Uint8Array)) throw new TypeError('Unsupported SQL parameter value.');
}
function normalizeResult<Row>(result: QueryResult<Row>): QueryResult<Row> {
  if (!result || !Array.isArray(result.rows) || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0) throw new DatabaseDriverError('Database driver returned an invalid query result.');
  return Object.freeze({ rows: Object.freeze([...result.rows]), rowCount: result.rowCount });
}
function assertNotAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'); }
