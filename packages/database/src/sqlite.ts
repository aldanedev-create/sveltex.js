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
 * Uses Node.js built-in `node:sqlite` (available in Node.js 22+). No native
 * dependencies required. The adapter wraps the synchronous SQLite API in
 * async-compatible methods to match the `DatabaseDriver` contract.
 *
 * Transactions use manual `BEGIN`/`COMMIT`/`ROLLBACK` to support async
 * callback bodies. Nested transactions use `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`.
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
 *   await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
 *   await db.query('INSERT INTO users (name) VALUES (?)', ['Alice']);
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
    const db = this.#requireConnection();
    const stmt = db.prepare(sql);
    const rawRows = stmt.all(...this.#convertParameters(parameters));
    const rows = rawRows.map(row => {
      // node:sqlite returns null-prototype objects; convert to regular objects
      if (row !== null && typeof row === 'object') {
        return { ...row } as Row;
      }
      return row as Row;
    });
    return { rows, rowCount: rows.length };
  }

  async transaction<T>(
    callback: (executor: DatabaseExecutor) => Promise<T>,
    _options?: QueryOptions,
  ): Promise<T> {
    const db = this.#requireConnection();
    const isNested = this.#txDepth > 0;
    const spName = isNested ? `sveltex_sp_${this.#txDepth}` : undefined;

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
        const stmt = db.prepare(sql);
        const rawRows = stmt.all(...this.#convertParameters(parameters));
        const rows = rawRows.map(row => {
          if (row !== null && typeof row === 'object') {
            return { ...row } as Row;
          }
          return row as Row;
        });
        return { rows, rowCount: rows.length };
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
