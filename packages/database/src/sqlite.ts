import { DatabaseSync } from 'node:sqlite';
import type { DatabaseDriver, DatabaseExecutor, QueryResult, QueryOptions, QueryValue } from './index.js';

/**
 * SQLite adapter options.
 *
 * @public
 */
export interface SqliteAdapterOptions {
  /** Database file path. Use `:memory:` for an in-memory database. */
  readonly path: string;
  /** Optional readonly mode. */
  readonly readonly?: boolean;
  /** Optional busy timeout in milliseconds (default: 5000). */
  readonly timeoutMs?: number;
  /** Optional WAL journal mode (default: false). */
  readonly wal?: boolean;
}

/**
 * SQLite adapter implementing the {@link DatabaseDriver} contract.
 *
 * Uses Node.js built-in `node:sqlite` (Node.js 22.5+). No native dependencies.
 * SQL uses SQLite's `?` placeholders; the adapter never rewrites SQL. It is
 * single-connection and has no pool — use the PostgreSQL or MySQL adapter for
 * multi-connection deployments.
 *
 * `rowCount` is the number of returned rows for a `SELECT`/`RETURNING`
 * statement, or the number of affected rows for `INSERT`/`UPDATE`/`DELETE`
 * (measured with SQLite's `total_changes()` around each statement).
 *
 * Transactions use manual `BEGIN`/`COMMIT`/`ROLLBACK` to support async
 * callback bodies. Nested transactions use `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`
 * on the shared connection.
 *
 * @example
 * ```ts
 * import { Database } from '@sveltex/database';
 * import { SqliteAdapter } from '@sveltex/database/sqlite';
 *
 * const adapter = new SqliteAdapter({ path: ':memory:' });
 * const db = new Database(adapter);
 * await db.connect();
 * try {
 *   const created = await db.query("INSERT INTO users (name) VALUES (?)", ['Alice']);
 *   console.log(created.rowCount); // 1
 *   const result = await db.query('SELECT * FROM users');
 *   console.log(result.rows); // [{ id: 1, name: 'Alice' }]
 * } finally {
 *   await db.close();
 * }
 * ```
 *
 * @public
 */
export class SqliteAdapter implements DatabaseDriver {
  readonly #options: SqliteAdapterOptions;
  #db: DatabaseSync | undefined;
  #connected = false;
  #txDepth = 0;

  constructor(options: SqliteAdapterOptions) {
    if (!options || typeof options.path !== 'string' || options.path.length === 0) {
      throw new TypeError('SqliteAdapter requires a non-empty "path" option.');
    }
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    const { path, readonly } = this.#options;
    const db = new DatabaseSync(path, { readOnly: readonly ?? false });
    db.exec('PRAGMA foreign_keys = ON');
    if (this.#options.wal) {
      db.exec('PRAGMA journal_mode = WAL');
    }
    this.#db = db;
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.#connected || !this.#db) return;
    this.#db.close();
    this.#db = undefined;
    this.#connected = false;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly QueryValue[] = [],
    _options?: QueryOptions,
  ): Promise<QueryResult<Row>> {
    return this.#execute<Row>(sql, parameters);
  }

  async transaction<T>(
    callback: (executor: DatabaseExecutor) => Promise<T>,
    _options?: QueryOptions,
  ): Promise<T> {
    const db = this.#requireConnection();
    const isNested = this.#txDepth > 0;
    const spName = isNested ? `sveltex_sp_${String(this.#txDepth)}` : undefined;

    if (isNested) {
      db.exec(`SAVEPOINT ${spName}`);
    } else {
      db.exec('BEGIN');
    }
    this.#txDepth += 1;

    let completed = false;
    const scoped: DatabaseExecutor = Object.freeze({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters: readonly QueryValue[] = [],
        queryOptions?: QueryOptions,
      ): Promise<QueryResult<Row>> => {
        if (completed) throw new Error('The transaction executor is no longer active.');
        if (queryOptions?.signal?.aborted) {
          throw queryOptions.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        }
        return this.#execute<Row>(sql, parameters);
      },
    });

    try {
      const result = await callback(scoped);
      if (isNested) {
        db.exec(`RELEASE ${spName}`);
      } else {
        db.exec('COMMIT');
      }
      completed = true;
      return result;
    } catch (cause) {
      completed = true;
      try {
        if (isNested) {
          db.exec(`ROLLBACK TO ${spName}`);
          db.exec(`RELEASE ${spName}`);
        } else {
          db.exec('ROLLBACK');
        }
      } catch {
        // Rollback failure is secondary to the original error
      }
      throw cause;
    } finally {
      this.#txDepth -= 1;
    }
  }

  /** Execute one statement and derive `rowCount` without parsing the SQL. */
  #execute<Row extends Record<string, unknown>>(sql: string, parameters: readonly QueryValue[]): QueryResult<Row> {
    const db = this.#requireConnection();
    const before = this.#totalChanges(db);
    const stmt = db.prepare(sql);
    const rawRows = stmt.all(...this.#convertParameters(parameters));
    const after = this.#totalChanges(db);
    const rows = rawRows.map(row => {
      // node:sqlite returns null-prototype objects; convert to regular objects
      if (row !== null && typeof row === 'object') {
        return { ...row } as Row;
      }
      return row as Row;
    });
    return { rows, rowCount: rows.length > 0 ? rows.length : Math.max(0, after - before) };
  }

  #totalChanges(db: DatabaseSync): number {
    const row = db.prepare('SELECT total_changes() AS c').get() as { c?: unknown } | undefined;
    const value = row?.c;
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0);
  }

  #requireConnection(): DatabaseSync {
    if (!this.#connected || !this.#db) {
      throw new Error('SqliteAdapter is not connected. Call connect() first.');
    }
    return this.#db;
  }

  #convertParameters(parameters: readonly QueryValue[]): readonly (string | number | bigint | null | Uint8Array)[] {
    return parameters.map(p => {
      if (p === null) return null;
      if (typeof p === 'bigint') return p.toString();
      if (typeof p === 'boolean') return p ? 1 : 0;
      if (p instanceof Date) return p.toISOString();
      if (p instanceof Uint8Array) return p;
      return p;
    });
  }
}
