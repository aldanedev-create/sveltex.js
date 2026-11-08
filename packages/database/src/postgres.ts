import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConnectionOptions as TlsOptions } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig as PgPoolConfig } from 'pg';
import type { DatabaseDriver, DatabaseExecutor, PoolConfig, QueryOptions, QueryResult, QueryValue } from './index.js';
import { assertNotAborted, resolvePoolConfig, withTimeout, type ResolvedPoolConfig } from './pool.js';

/**
 * PostgreSQL adapter options. Supply either `connectionString` or `host`
 * (plus any of the other fields). SQL must use PostgreSQL's `$1, $2, ...`
 * placeholders; the adapter never rewrites SQL.
 *
 * @public
 */
export interface PostgresAdapterOptions {
  /** Full connection URI. Takes precedence over the individual fields. */
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  /** `false` (default) disables TLS; `true` or a TLS options object enables it. */
  readonly ssl?: boolean | TlsOptions;
  readonly applicationName?: string;
  readonly statementTimeoutMs?: number;
  /** Pool limits and timeouts. */
  readonly pool?: PoolConfig;
}

interface TransactionContext {
  readonly client: PoolClient;
  readonly depth: number;
}

interface ScopedExecutor {
  readonly executor: DatabaseExecutor;
  readonly deactivate: () => void;
}

function convertParameters(parameters: readonly QueryValue[]): unknown[] {
  return parameters.map((value) => {
    if (value === null) return null;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return Buffer.from(value);
    return value;
  });
}

function mapRows<Row extends Record<string, unknown>>(rows: readonly unknown[]): Row[] {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }) as Row);
}

/**
 * Real PostgreSQL adapter backed by `pg.Pool`.
 *
 * Each top-level transaction acquires a dedicated pooled connection and runs
 * `BEGIN`/`COMMIT`/`ROLLBACK`. Nested transactions reuse that connection via
 * `AsyncLocalStorage` and `SAVEPOINT`, so they compose like the SQLite adapter.
 * Concurrent top-level transactions get separate connections and are isolated.
 *
 * @public
 */
export class PostgresAdapter implements DatabaseDriver {
  readonly #options: PostgresAdapterOptions;
  readonly #poolConfig: ResolvedPoolConfig;
  readonly #transactions = new AsyncLocalStorage<TransactionContext>();
  #pool: Pool | undefined;

  constructor(options: PostgresAdapterOptions = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('PostgresAdapter requires an options object.');
    }
    if (options.connectionString === undefined && options.host === undefined) {
      throw new TypeError('PostgresAdapter requires either "connectionString" or "host".');
    }
    if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65535)) {
      throw new TypeError('PostgresAdapter "port" must be a valid TCP port.');
    }
    this.#options = options;
    this.#poolConfig = resolvePoolConfig(options.pool);
  }

  async connect(): Promise<void> {
    if (this.#pool !== undefined) return;
    const o = this.#options;
    const config: PgPoolConfig = {
      ...(o.connectionString !== undefined ? { connectionString: o.connectionString } : {}),
      ...(o.host !== undefined ? { host: o.host } : {}),
      ...(o.port !== undefined ? { port: o.port } : {}),
      ...(o.database !== undefined ? { database: o.database } : {}),
      ...(o.user !== undefined ? { user: o.user } : {}),
      ...(o.password !== undefined ? { password: o.password } : {}),
      ...(o.ssl !== undefined ? { ssl: o.ssl } : {}),
      ...(o.applicationName !== undefined ? { application_name: o.applicationName } : {}),
      ...(o.statementTimeoutMs !== undefined ? { statement_timeout: o.statementTimeoutMs } : {}),
      max: this.#poolConfig.max,
      idleTimeoutMillis: this.#poolConfig.idleTimeoutMs,
      connectionTimeoutMillis: this.#poolConfig.connectionTimeoutMs,
    };
    const pool = new Pool(config);
    // pg emits 'error' for idle clients; without a listener it becomes uncaught.
    pool.on('error', () => {
      // Query-level failures are reported through DatabaseDriverError instead.
    });
    try {
      const client = await withTimeout(
        pool.connect(),
        this.#poolConfig.acquireTimeoutMs,
        'PostgreSQL connection probe',
        (late) => late.release(),
      );
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    } catch (cause) {
      await pool.end().catch(() => undefined);
      throw new Error(`PostgresAdapter failed to connect: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
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
    const result = context === undefined
      ? await pool.query(sql, values)
      : await context.client.query(sql, values);
    const rows = mapRows<Row>(result.rows);
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  async transaction<T>(
    callback: (executor: DatabaseExecutor) => Promise<T>,
    options?: QueryOptions,
  ): Promise<T> {
    assertNotAborted(options?.signal);
    const pool = this.#requirePool();
    const parent = this.#transactions.getStore();
    if (parent !== undefined) return this.#runNested(parent, callback);

    const client = await withTimeout(
      pool.connect(),
      this.#poolConfig.acquireTimeoutMs,
      'Acquiring a PostgreSQL transaction connection',
      (late) => late.release(),
    );
    try {
      await client.query('BEGIN');
      const scoped = this.#scopedExecutor(client);
      try {
        const value = await this.#transactions.run({ client, depth: 1 }, () => callback(scoped.executor));
        await client.query('COMMIT');
        return value;
      } catch (cause) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The original failure is more useful than a failed rollback.
        }
        throw cause;
      } finally {
        scoped.deactivate();
      }
    } finally {
      client.release();
    }
  }

  async #runNested<T>(parent: TransactionContext, callback: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    const depth = parent.depth + 1;
    const name = `sveltex_sp_${String(depth)}`;
    await parent.client.query(`SAVEPOINT ${name}`);
    const scoped = this.#scopedExecutor(parent.client);
    try {
      const value = await this.#transactions.run({ client: parent.client, depth }, () => callback(scoped.executor));
      await parent.client.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (cause) {
      try {
        await parent.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await parent.client.query(`RELEASE SAVEPOINT ${name}`);
      } catch {
        // The original failure is more useful than a failed savepoint rollback.
      }
      throw cause;
    } finally {
      scoped.deactivate();
    }
  }

  #scopedExecutor(client: PoolClient): ScopedExecutor {
    let active = true;
    const executor: DatabaseExecutor = Object.freeze({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters: readonly QueryValue[] = [],
        queryOptions?: QueryOptions,
      ): Promise<QueryResult<Row>> => {
        if (!active) throw new Error('The transaction executor is no longer active.');
        assertNotAborted(queryOptions?.signal);
        const result = await client.query(sql, convertParameters(parameters));
        const rows = mapRows<Row>(result.rows);
        return { rows, rowCount: result.rowCount ?? rows.length };
      },
    });
    return { executor, deactivate: () => { active = false; } };
  }

  #requirePool(): Pool {
    if (this.#pool === undefined) {
      throw new Error('PostgresAdapter is not connected. Call connect() first.');
    }
    return this.#pool;
  }
}
