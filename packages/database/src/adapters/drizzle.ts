import { sql } from 'drizzle-orm';
import {
  defineDatabaseAdapter,
  defineAdapterContext,
  type DatabaseAdapter,
  type DatabaseAdapterConfig,
  type DatabaseAdapterContext,
  type MigrationRequest,
  type MigrationStatus,
} from '../contracts/adapter.js';

/**
 * Options for the official Drizzle ORM integration. Drizzle itself is an
 * **optional peer dependency** of this subpath; the native Drizzle `db` object
 * is always preserved and reachable through `connection.context().client`.
 *
 * @public
 */
export interface DrizzleAdapterOptions<DB = unknown> {
  /** Adapter/connection name (default: `drizzle`). */
  readonly name?: string;
  /** Create the native Drizzle client. Called lazily on `connect()`. */
  readonly create: (config: DatabaseAdapterConfig) => DB | Promise<DB>;
  /** Close the underlying pool/driver. Defaults to `$client.end()` / `$client.close()`. */
  readonly destroy?: (client: DB) => void | Promise<void>;
  /** Health probe. Defaults to `select 1` via `execute`/`run`/`get`/`all`. */
  readonly probe?: (client: DB) => void | Promise<void>;
  /** Transaction runner. Defaults to `client.transaction(callback)`. */
  readonly transaction?: <T>(client: DB, callback: (tx: DB) => Promise<T>) => Promise<T>;
  /** Delegate to Drizzle Kit / the ORM-native migrator (never a competing engine). */
  readonly migrate?: (client: DB, request?: MigrationRequest) => Promise<MigrationStatus>;
}

interface DrizzleLike {
  execute?: (query: unknown) => unknown;
  run?: (query: unknown) => unknown;
  get?: (query: unknown) => unknown;
  all?: (query: unknown) => unknown;
  transaction?: <T>(callback: (tx: unknown) => Promise<T>) => Promise<T>;
  $client?: { end?: () => unknown; close?: () => unknown };
}

function defaultProbe(client: unknown): Promise<void> {
  const db = client as DrizzleLike;
  const query = sql`select 1`;
  for (const method of ['execute', 'run', 'get', 'all'] as const) {
    const fn = db[method];
    if (typeof fn === 'function') return Promise.resolve(fn.call(db, query)).then(() => undefined);
  }
  return Promise.reject(new TypeError('The Drizzle client exposes no executable query method for the health probe.'));
}

function defaultDestroy(client: unknown): Promise<void> {
  const db = client as DrizzleLike;
  const raw = db.$client;
  if (raw !== undefined && raw !== null) {
    if (typeof raw.end === 'function') return Promise.resolve(raw.end.call(raw)).then(() => undefined);
    if (typeof raw.close === 'function') return Promise.resolve(raw.close.call(raw)).then(() => undefined);
  }
  return Promise.resolve();
}

function defaultTransaction<T, DB>(client: DB, callback: (tx: DB) => Promise<T>): Promise<T> {
  const db = client as unknown as DrizzleLike;
  if (typeof db.transaction !== 'function') {
    return Promise.reject(new TypeError('The Drizzle client does not expose transaction().'));
  }
  return db.transaction<T>((tx: unknown) => callback(tx as DB));
}

/**
 * Build a validated adapter for a native Drizzle client. Transactions expose
 * the native Drizzle transaction object as `tx.client`, so the full ORM API
 * remains available inside a transaction. @public
 */
export function createDrizzleAdapter<DB = unknown>(options: DrizzleAdapterOptions<DB>): DatabaseAdapter<DB> {
  if (options === null || typeof options !== 'object') throw new TypeError('Drizzle adapter options are required.');
  if (typeof options.create !== 'function') throw new TypeError('createDrizzleAdapter requires a create(config) factory.');
  const name = options.name ?? 'drizzle';
  const create = options.create;
  const destroy = options.destroy ?? defaultDestroy;
  const probe = options.probe ?? defaultProbe;
  const runTransaction = options.transaction ?? defaultTransaction;
  const migrate = options.migrate;

  return defineDatabaseAdapter<DB>({
    name,
    capabilities: {
      transactions: true,
      savepoints: false,
      healthCheck: true,
      migrations: migrate !== undefined,
    },
    async connect(config) {
      const client = await create(config);
      if (client === undefined || client === null) throw new TypeError('Drizzle create() must return a native client.');
      return defineAdapterContext(name, client, config);
    },
    async disconnect(context: DatabaseAdapterContext<DB>) {
      await destroy(context.client);
    },
    async healthCheck(context: DatabaseAdapterContext<DB>) {
      await probe(context.client);
      return true;
    },
    async transaction<T>(context: DatabaseAdapterContext<DB>, callback: (tx: DatabaseAdapterContext<DB>) => Promise<T>): Promise<T> {
      return runTransaction<T>(context.client, (tx) => callback(defineAdapterContext(name, tx, context.config)));
    },
    ...(migrate === undefined ? {} : {
      migrate: (context: DatabaseAdapterContext<DB>, request?: MigrationRequest) => migrate(context.client, request),
    }),
  });
}
