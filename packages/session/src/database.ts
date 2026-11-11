import { cloneData, deepFreeze } from '@sveltex/shared';
import type { SessionRecord, SessionStore } from './index.js';

/**
 * A minimal structural port over a driver-neutral SQL executor. `@sveltex/database`'s
 * `Database` facade satisfies this interface without `@sveltex/session` taking a hard
 * runtime dependency on it. The `transaction` callback receives a query-only executor,
 * matching the facade's scoped transaction executor.
 */
export type SessionSqlValue = string | number | boolean | bigint | Date | Uint8Array | null;
export interface SessionSqlResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number; }
export interface SessionSqlQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly SessionSqlValue[], options?: { readonly signal?: AbortSignal }): Promise<SessionSqlResult<Row>>;
}
export interface SessionSqlExecutor extends SessionSqlQueryExecutor {
  transaction<T>(callback: (executor: SessionSqlQueryExecutor) => Promise<T>, options?: { readonly signal?: AbortSignal }): Promise<T>;
}

/** `?` placeholders (SQLite, MySQL) or `$1..$n` placeholders (PostgreSQL). */
export type SessionDatabaseDialect = 'sqlite' | 'postgres' | 'mysql';

export interface DatabaseSessionStoreOptions {
  /** Plain SQL identifier. Defaults to `sveltex_sessions`. */
  readonly tableName?: string;
  readonly dialect?: SessionDatabaseDialect;
  readonly now?: () => number;
}

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Row shape returned by the SELECT statements. Drivers may return BIGINT as string or bigint. */
interface SessionRow extends Record<string, unknown> {
  id?: unknown;
  payload?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
  revision?: unknown;
}

/**
 * A persistent, cross-process {@link SessionStore} backed by any SQL database that
 * implements the {@link SessionSqlExecutor} port (`@sveltex/database`'s `Database` does).
 *
 * All state changes are single conditional SQL statements (or one transaction for
 * rotation), so concurrent requests cannot resurrect destroyed sessions or lose updates.
 * `user_id` is denormalized from `data.userId` to support O(1) per-user revocation.
 */
export class DatabaseSessionStore<Data extends Record<string, unknown> = Record<string, unknown>> implements SessionStore<Data> {
  readonly #executor: SessionSqlExecutor;
  readonly #table: string;
  readonly #dialect: SessionDatabaseDialect;
  readonly #now: () => number;
  #schemaReady: Promise<void> | undefined;

  constructor(executor: SessionSqlExecutor, options: DatabaseSessionStoreOptions = {}) {
    if (!executor || typeof executor.query !== 'function' || typeof executor.transaction !== 'function') {
      throw new TypeError('A SQL executor with query() and transaction() is required.');
    }
    const table = options.tableName ?? 'sveltex_sessions';
    if (!TABLE_RE.test(table)) throw new TypeError('tableName must be a plain SQL identifier (letters, digits, underscore).');
    const dialect = options.dialect ?? 'sqlite';
    if (dialect !== 'sqlite' && dialect !== 'postgres' && dialect !== 'mysql') throw new TypeError('dialect must be sqlite, postgres or mysql.');
    const now = options.now ?? Date.now;
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.#executor = executor;
    this.#table = table;
    this.#dialect = dialect;
    this.#now = now;
  }

  get tableName(): string { return this.#table; }
  get dialect(): SessionDatabaseDialect { return this.#dialect; }

  /** Create the table if needed. Memoized; safe to call before every operation. */
  async ensureSchema(): Promise<void> {
    if (!this.#schemaReady) this.#schemaReady = this.#createSchema();
    return this.#schemaReady;
  }

  /** Recommended DDL, exposed so applications can run it as a migration instead. */
  schemaStatements(): readonly string[] {
    return Object.freeze([this.#render(`CREATE TABLE IF NOT EXISTS ${this.#table} (
  id VARCHAR(255) PRIMARY KEY,
  payload TEXT NOT NULL,
  user_id VARCHAR(255),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revision INTEGER NOT NULL
)`)]);
  }

  async get(id: string): Promise<SessionRecord<Data> | undefined> {
    validateKey(id);
    await this.ensureSchema();
    const sql = this.#render(`SELECT id, payload, created_at, expires_at, revision FROM ${this.#table} WHERE id = ?`);
    const result = await this.#executor.query<SessionRow>(sql, [id]);
    const row = result.rows[0];
    if (!row) return undefined;
    const record = this.#parse(row, id);
    if (!record) { await this.#deleteRow(id); return undefined; }
    return record;
  }

  async createIfAbsent(record: SessionRecord<Data>): Promise<boolean> {
    validateKey(record.id);
    if (record.expiresAt <= this.#now()) return false;
    await this.ensureSchema();
    const result = await this.#executor.query(this.#insertSql(), this.#insertParams(record));
    return result.rowCount === 1;
  }

  async compareAndSet(id: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean> {
    validateKey(id);
    if (record.id !== id || record.expiresAt <= this.#now()) return false;
    await this.ensureSchema();
    const sql = this.#render(`UPDATE ${this.#table} SET payload = ?, user_id = ?, expires_at = ?, revision = ? WHERE id = ? AND revision = ?`);
    const result = await this.#executor.query(sql, [this.#payload(record), this.#userId(record), record.expiresAt, record.revision, id, expectedRevision]);
    return result.rowCount === 1;
  }

  async delete(id: string): Promise<void> {
    validateKey(id);
    await this.ensureSchema();
    await this.#deleteRow(id);
  }

  async rotate(oldId: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean> {
    validateKey(oldId);
    validateKey(record.id);
    if (oldId === record.id || record.expiresAt <= this.#now()) return false;
    await this.ensureSchema();
    const rollback = Symbol('session-rotate-rollback');
    try {
      return await this.#executor.transaction(async (tx) => {
        const current = await tx.query<SessionRow>(
          this.#render(`SELECT revision, expires_at FROM ${this.#table} WHERE id = ?`), [oldId]);
        const row = current.rows[0];
        if (!row) return false;
        const revision = toFiniteNumber(row.revision);
        const expiresAt = toFiniteNumber(row.expires_at);
        if (revision === undefined || revision !== expectedRevision || expiresAt === undefined || expiresAt <= this.#now()) return false;

        const inserted = await tx.query(this.#insertSql(), this.#insertParams(record));
        if (inserted.rowCount !== 1) return false;

        const removed = await tx.query(
          this.#render(`DELETE FROM ${this.#table} WHERE id = ? AND revision = ?`), [oldId, expectedRevision]);
        if (removed.rowCount !== 1) throw rollback;
        return true;
      });
    } catch (cause) {
      if (cause === rollback) return false;
      throw cause;
    }
  }

  /** Revoke every session belonging to a user (logout-all-devices). Returns the number removed. */
  async revokeAllForUser(userId: string): Promise<number> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) throw new TypeError('A valid userId is required.');
    await this.ensureSchema();
    const result = await this.#executor.query(this.#render(`DELETE FROM ${this.#table} WHERE user_id = ?`), [userId]);
    return result.rowCount;
  }

  /** Housekeeping: remove logically expired rows. Safe to run on shutdown or a cron. */
  async purgeExpired(): Promise<number> {
    await this.ensureSchema();
    const result = await this.#executor.query(this.#render(`DELETE FROM ${this.#table} WHERE expires_at <= ?`), [this.#now()]);
    return result.rowCount;
  }

  #insertSql(): string {
    const dual = this.#dialect === 'mysql' ? ' FROM DUAL' : '';
    return this.#render(`INSERT INTO ${this.#table} (id, payload, user_id, created_at, expires_at, revision)
      SELECT ?, ?, ?, ?, ?, ?${dual} WHERE NOT EXISTS (SELECT 1 FROM ${this.#table} WHERE id = ?)`);
  }

  #insertParams(record: SessionRecord<Data>): readonly SessionSqlValue[] {
    return [record.id, this.#payload(record), this.#userId(record), record.createdAt, record.expiresAt, record.revision, record.id];
  }

  #payload(record: SessionRecord<Data>): string {
    return JSON.stringify(record.data);
  }

  #userId(record: SessionRecord<Data>): string | null {
    const value = (record.data as Record<string, unknown>)['userId'];
    return typeof value === 'string' && value.length <= 255 ? value : null;
  }

  #render(sql: string): string {
    if (this.#dialect !== 'postgres') return sql;
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  async #createSchema(): Promise<void> {
    for (const statement of this.schemaStatements()) await this.#executor.query(statement);
  }

  async #deleteRow(id: string): Promise<void> {
    await this.#executor.query(this.#render(`DELETE FROM ${this.#table} WHERE id = ?`), [id]);
  }

  #parse(row: SessionRow, id: string): SessionRecord<Data> | undefined {
    if (row.id !== id) return undefined;
    const createdAt = toFiniteNumber(row.created_at);
    const expiresAt = toFiniteNumber(row.expires_at);
    const revision = toFiniteNumber(row.revision);
    if (createdAt === undefined || createdAt < 0 || expiresAt === undefined || revision === undefined) return undefined;
    if (expiresAt <= createdAt || expiresAt <= this.#now()) return undefined;
    if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
    let raw: unknown = row.payload;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) as unknown; } catch { return undefined; }
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    let frozen: Readonly<Data>;
    try { frozen = deepFreeze(cloneData(raw)) as Readonly<Data>; } catch { return undefined; }
    return Object.freeze({ id, data: frozen, createdAt, expiresAt, revision });
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') { const n = Number(value); return Number.isSafeInteger(n) ? n : undefined; }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) { const n = Number(value); return Number.isSafeInteger(n) ? n : undefined; }
  return undefined;
}

function validateKey(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) {
    throw new TypeError('Session identifiers must be non-empty strings no longer than 256 characters.');
  }
}
