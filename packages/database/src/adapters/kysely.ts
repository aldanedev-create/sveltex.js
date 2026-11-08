import { sql } from 'kysely';
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
 * Options for the official Kysely integration. Kysely is a type-safe SQL query
 * builder (not a traditional ORM) and is an **optional peer dependency** of
 * this subpath. The native `Kysely` instance is preserved via `context().client`.
 *
 * @public
 */
export interface KyselyAdapterOptions<DB = unknown> {
  /** Adapter/connection name (default: `kysely`). */
  readonly name?: string;
  /** Create the native Kysely instance. Called lazily on `connect()`. */
  readonly create: (config: DatabaseAdapterConfig) => DB | Promise<DB>;
  /** Dispose the instance. Defaults to `client.destroy()`. */
  readonly destroy?: (client: DB) => void | Promise<void>;
  /** Health probe. Defaults to `sql\`select 1\`.execute(client)`. */
  readonly probe?: (client: DB) => void | Promise<void>;
  /** Transaction runner. Defaults to `client.transaction().execute(callback)`. */
  readonly transaction?: <T>(client: DB, callback: (tx: DB) => Promise<T>) => Promise<T>;
  /** Delegate to Kysely's native migrator (never a competing engine). */
  readonly migrate?: (client: DB, request?: MigrationRequest) => Promise<MigrationStatus>;
}

interface KyselyLike {
  destroy?: () => unknown;
  transaction?: () => { execute<T>(callback: (tx: unknown) => Promise<T>): Promise<T> };
}

function defaultProbe(client: unknown): Promise<void> {
  const executor = client as { execute?: unknown };
  // Kysely's `sql` objects carry `.execute(executorProvider)`.
  const query = sql`select 1` as unknown as { execute: (target: unknown) => Promise<unknown> };
  if (typeof query.execute !== 'function') return Promise.reject(new TypeError('Kysely sql tag is unavailable.'));
  void executor;
  return query.execute(client).then(() => undefined);
}

function defaultDestroy(client: unknown): Promise<void> {
  const db = client as KyselyLike;
  if (typeof db.destroy === 'function') return Promise.resolve(db.destroy.call(db)).then(() => undefined);
  return Promise.resolve();
}

function defaultTransaction<T, DB>(client: DB, callback: (tx: DB) => Promise<T>): Promise<T> {
  const db = client as unknown as KyselyLike;
  if (typeof db.transaction !== 'function') {
    return Promise.reject(new TypeError('The Kysely client does not expose transaction().'));
  }
  return db.transaction().execute<T>((tx: unknown) => callback(tx as DB));
}

/**
 * Build a validated adapter for a native Kysely instance. @public
 */
export function createKyselyAdapter<DB = unknown>(options: KyselyAdapterOptions<DB>): DatabaseAdapter<DB> {
  if (options === null || typeof options !== 'object') throw new TypeError('Kysely adapter options are required.');
  if (typeof options.create !== 'function') throw new TypeError('createKyselyAdapter requires a create(config) factory.');
  const name = options.name ?? 'kysely';
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
      if (client === undefined || client === null) throw new TypeError('Kysely create() must return a native instance.');
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
