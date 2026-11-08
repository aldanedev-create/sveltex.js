import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolOptions } from 'mysql2';
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise';
import type { DatabaseDriver, DatabaseExecutor, PoolConfig, QueryOptions, QueryResult, QueryValue } from './index.js';
import { assertNotAborted, resolvePoolConfig, withTimeout, type ResolvedPoolConfig } from './pool.js';

/**
 * MySQL adapter options. Supply either `uri` or `host` (plus any of the other
 * fields). SQL must use MySQL's `?` placeholders. Configure TLS through the URI
 * (for example `?ssl={"rejectUnauthorized":true}`); the adapter never rewrites
 * SQL or invents transport defaults.
 *
 * @public
 */
export interface MysqlAdapterOptions {
  /** Full `mysql://` URI. Takes precedence over the individual fields. */
  readonly uri?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  readonly charset?: string;
  readonly timezone?: string;
  /** Pool limits and timeouts. */
  readonly pool?: PoolConfig;
}

interface TransactionContext {
  readonly connection: PoolConnection;
  readonly depth: number;
}

interface ScopedExecutor {
  readonly executor: DatabaseExecutor;
  readonly deactivate: () => void;
}

function convertParameters(parameters: readonly QueryValue[]): unknown[] {
  return parameters.map((value) => {
    if (value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return Buffer.from(value);
    return value;
  });
}

function normalize<Row extends Record<string, unknown>>(first: unknown): QueryResult<Row> {
  if (Array.isArray(first)) {
    const rows = first.map((row) => ({ ...(row as Record<string, unknown>) }) as Row);
    return { rows, rowCount: rows.length };
  }
  if (first !== null && typeof first === 'object') {
    const affected = (first as { affectedRows?: unknown }).affectedRows;
    const rowCount = typeof affected === 'number' && Number.isSafeInteger(affected) && affected >= 0 ? affected : 0;
    return { rows: [], rowCount };
  }
  return { rows: [], rowCount: 0 };
}

/**
 * Real MySQL adapter backed by `mysql2/promise` `createPool`.
 *
 * Each top-level transaction acquires a dedicated pooled connection and uses
 * `beginTransaction()`/`commit()`/`rollback()`. Nested transactions reuse that
 * connection via `AsyncLocalStorage` and `SAVEPOINT`. Concurrent top-level
 * transactions get separate connections.
 *
 * @public
 */
export class MysqlAdapter implements DatabaseDriver {
  readonly #options: MysqlAdapterOptions;
  readonly #poolConfig: ResolvedPoolConfig;
  readonly #transactions = new AsyncLocalStorage<TransactionContext>();
  #pool: Pool | undefined;

  constructor(options: MysqlAdapterOptions = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('MysqlAdapter requires an options object.');
    }
    if (options.uri === undefined && options.host === undefined) {
      throw new TypeError('MysqlAdapter requires either "uri" or "host".');
    }
    if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65535)) {
      throw new TypeError('MysqlAdapter "port" must be a valid TCP port.');
    }
    this.#options = options;
    this.#poolConfig = resolvePoolConfig(options.pool);
  }

  async connect(): Promise<void> {
    if (this.#pool !== undefined) return;
    const o = this.#options;
    const cfg = this.#poolConfig;
    const settings: PoolOptions = {
      ...(o.uri !== undefined ? { uri: o.uri } : {}),
      ...(o.host !== undefined ? { host: o.host } : {}),
      ...(o.port !== undefined ? { port: o.port } : {}),
      ...(o.database !== undefined ? { database: o.database } : {}),
      ...(o.user !== undefined ? { user: o.user } : {}),
      ...(o.password !== undefined ? { password: o.password } : {}),
      ...(o.charset !== undefined ? { charset: o.charset } : {}),
      ...(o.timezone !== undefined ? { timezone: o.timezone } : {}),
      waitForConnections: true,
      connectionLimit: cfg.max,
      queueLimit: 0,
      connectTimeout: cfg.connectionTimeoutMs,
      idleTimeout: cfg.idleTimeoutMs,
    };
    const pool = createPool(settings);
    try {
      const connection = await withTimeout(
        pool.getConnection(),
        cfg.acquireTimeoutMs,
        'MySQL connection probe',
        (late) => late.release(),
      );
      try {
        await connection.query('SELECT 1');
      } finally {
        connection.release();
      }
    } catch (cause) {
      await pool.end().catch(() => undefined);
      throw new Error(`MysqlAdapter failed to connect: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    this.#pool = pool;
  }

  async disconnect(): Promise<void> {
    const pool = this.#pool;
    if (pool === undefined) return;
    this.#pool = undefined;
    await pool.end();
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly QueryValue[] = [],
    options?: QueryOptions,
  ): Promise<QueryResult<Row>> {
    assertNotAborted(options?.signal);
    const pool = this.#requirePool();
    const context = this.#transactions.getStore();
    const values = convertParameters(parameters);
    const [first] = context === undefined
      ? await pool.query(sql, values)
      : await context.connection.query(sql, values);
    return normalize<Row>(first);
  }

  async transaction<T>(
    callback: (executor: DatabaseExecutor) => Promise<T>,
    options?: QueryOptions,
  ): Promise<T> {
    assertNotAborted(options?.signal);
    const pool = this.#requirePool();
    const parent = this.#transactions.getStore();
    if (parent !== undefined) return this.#runNested(parent, callback);

    const connection = await withTimeout(
      pool.getConnection(),
      this.#poolConfig.acquireTimeoutMs,
      'Acquiring a MySQL transaction connection',
      (late) => late.release(),
    );
    try {
      await connection.beginTransaction();
      const scoped = this.#scopedExecutor(connection);
      try {
        const value = await this.#transactions.run({ connection, depth: 1 }, () => callback(scoped.executor));
        await connection.commit();
        return value;
      } catch (cause) {
        try {
          await connection.rollback();
        } catch {
          // The original failure is more useful than a failed rollback.
        }
        throw cause;
      } finally {
        scoped.deactivate();
      }
    } finally {
      connection.release();
    }
  }

  async #runNested<T>(parent: TransactionContext, callback: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    const depth = parent.depth + 1;
    const name = `sveltex_sp_${String(depth)}`;
    await parent.connection.query(`SAVEPOINT ${name}`);
    const scoped = this.#scopedExecutor(parent.connection);
    try {
      const value = await this.#transactions.run({ connection: parent.connection, depth }, () => callback(scoped.executor));
      await parent.connection.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (cause) {
      try {
        await parent.connection.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await parent.connection.query(`RELEASE SAVEPOINT ${name}`);
      } catch {
        // The original failure is more useful than a failed savepoint rollback.
      }
      throw cause;
    } finally {
      scoped.deactivate();
    }
  }

  #scopedExecutor(connection: PoolConnection): ScopedExecutor {
    let active = true;
    const executor: DatabaseExecutor = Object.freeze({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters: readonly QueryValue[] = [],
        queryOptions?: QueryOptions,
      ): Promise<QueryResult<Row>> => {
        if (!active) throw new Error('The transaction executor is no longer active.');
        assertNotAborted(queryOptions?.signal);
        const [first] = await connection.query(sql, convertParameters(parameters));
        return normalize<Row>(first);
      },
    });
    return { executor, deactivate: () => { active = false; } };
  }

  #requirePool(): Pool {
    if (this.#pool === undefined) {
      throw new Error('MysqlAdapter is not connected. Call connect() first.');
    }
    return this.#pool;
  }
}
