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
