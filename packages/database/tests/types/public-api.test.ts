import {
  Database,
  type DatabaseDriver,
  type QueryResult,
  type PoolConfig,
} from '../../dist/index.js';
import { SqliteAdapter, type SqliteAdapterOptions } from '../../dist/sqlite.js';
import { PostgresAdapter, type PostgresAdapterOptions } from '../../dist/postgres.js';
import { MysqlAdapter, type MysqlAdapterOptions } from '../../dist/mysql.js';
import {
  MigrationRunner,
  MIGRATION_DIALECTS,
  createMigrationDialect,
  migrationChecksum,
  type Migration,
  type MigrationDialect,
  type MigrationDialectKind,
  type MigrationReport,
  type MigrationRunnerOptions,
  type MigrationStatement,
} from '../../dist/migrations.js';
import {
  defineDatabaseAdapter,
  defineAdapterContext,
  validateAdapterDefinition,
  createAdapterRegistry,
  createConnection,
  createConnectionManager,
  configFromEnv,
  redactConfig,
  runAdapterConformance,
  type DatabaseAdapter,
  type DatabaseAdapterConfig,
  type DatabaseAdapterContext,
  type DatabaseAdapterCapabilities,
  type ManagedConnection,
  type ConnectionState,
  type HealthCheckReport,
  type ConformanceReport,
  type TransactionOptions,
} from '../../dist/index.js';
import { createDrizzleAdapter, type DrizzleAdapterOptions } from '../../dist/adapters/drizzle.js';
import { createKyselyAdapter, type KyselyAdapterOptions } from '../../dist/adapters/kysely.js';
import { runAdapterConformance as runConformanceSubpath } from '../../dist/testing/index.js';

interface UserRow extends Record<string, unknown> { id: number; email: string; }
declare const driver: DatabaseDriver;
const db = new Database(driver);
const result: Promise<QueryResult<UserRow>> = db.query<UserRow>('select id, email from users where id = ?', [1]);
void result;

const pool: PoolConfig = { max: 5, idleTimeoutMs: 1000, connectionTimeoutMs: 2000, acquireTimeoutMs: 3000 };
void pool;

const sqliteOptions: SqliteAdapterOptions = { path: ':memory:' };
const sqlite = new Database(new SqliteAdapter(sqliteOptions));
void sqlite;

const pgOptions: PostgresAdapterOptions = { connectionString: 'postgresql://localhost/app', ssl: true, pool };
const pg = new Database(new PostgresAdapter(pgOptions));
void pg;

const mysqlOptions: MysqlAdapterOptions = { uri: 'mysql://localhost/app', pool };
const mysql = new Database(new MysqlAdapter(mysqlOptions));
void mysql;

const migration: Migration = { id: '001', up: ['CREATE TABLE t (id INT)'] };
const checksum: string = migrationChecksum(migration);
void checksum;
const kind: MigrationDialectKind = 'postgres';
const dialect: MigrationDialect = createMigrationDialect(kind);
const allDialects: Readonly<Record<MigrationDialectKind, MigrationDialect>> = MIGRATION_DIALECTS;
void allDialects;
const runnerOptions: MigrationRunnerOptions = { dialect, table: 'app_migrations' };
const runner = new MigrationRunner(db, [migration], runnerOptions);
const report: Promise<MigrationReport> = runner.run();
void report;
const statement: MigrationStatement = dialect.createTable('app_migrations');
void statement;

// --- Phase 1: BYO ORM contracts, core lifecycle, testing utilities ---
interface CustomClient { query(sql: string): Promise<{ rows: unknown[] }>; }
declare const customClient: CustomClient;

validateAdapterDefinition({
  name: 'custom',
  async connect(config) { return defineAdapterContext('custom', customClient, config); },
  async disconnect() {},
});

const adapterConfig: DatabaseAdapterConfig = Object.freeze({ host: 'localhost' });
const customContext: DatabaseAdapterContext<CustomClient> = defineAdapterContext<CustomClient>('custom', customClient, adapterConfig);
void customContext;

const custom: DatabaseAdapter<CustomClient> = defineDatabaseAdapter<CustomClient>({
  name: 'custom',
  capabilities: { transactions: true, healthCheck: true },
  async connect(config) { return defineAdapterContext('custom', customClient, config); },
  async disconnect() {},
  async healthCheck() { return true; },
  async transaction<T>(
    ctx: DatabaseAdapterContext<CustomClient>,
    cb: (tx: DatabaseAdapterContext<CustomClient>) => Promise<T>,
  ): Promise<T> { return cb(ctx); },
});
const caps: DatabaseAdapterCapabilities = custom.capabilities;
void caps;

const registry = createAdapterRegistry().register(custom);
void registry;
const manager = createConnectionManager();
void manager;

const managed: ManagedConnection<CustomClient> = createConnection<CustomClient>(custom, adapterConfig);
const connState: ConnectionState = managed.state;
const health: Promise<HealthCheckReport> = managed.healthCheck();
const txOpts: TransactionOptions = { savepoint: 'sp1' };
const txResult: Promise<number> = managed.transaction(async (tx) => {
  await tx.client.query('select 1');
  return 1;
}, txOpts);
void connState; void health; void txResult;

const envConfig: DatabaseAdapterConfig = configFromEnv({ env: { SVELTEX_DB_HOST: 'localhost' } });
const redacted: Readonly<Record<string, string>> = redactConfig(envConfig);
void redacted;

const conformance: Promise<ConformanceReport> = runAdapterConformance<CustomClient>({
  name: 'custom',
  async create() { return { adapter: custom, config: adapterConfig }; },
});
void conformance;
const conformance2: Promise<ConformanceReport> = runConformanceSubpath({
  name: 'custom',
  async create() { return { adapter: custom, config: adapterConfig }; },
});
void conformance2;

const drizzleOptions: DrizzleAdapterOptions = { create: () => ({}) };
const drizzleAdapter: DatabaseAdapter<unknown> = createDrizzleAdapter(drizzleOptions);
void drizzleAdapter;
const kyselyOptions: KyselyAdapterOptions = { create: () => ({}) };
const kyselyAdapter: DatabaseAdapter<unknown> = createKyselyAdapter(kyselyOptions);
void kyselyAdapter;
