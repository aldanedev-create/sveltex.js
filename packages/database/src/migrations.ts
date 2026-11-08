import { createHash } from 'node:crypto';
import type { Database, QueryValue } from './index.js';

/** The SQL dialect a migration set is written for. */
export type MigrationDialectKind = 'sqlite' | 'postgres' | 'mysql';

/**
 * An ordered, immutable migration. `id` must be unique and stable; `up` holds
 * one or more complete SQL statements in the target dialect. Statements are
 * never parsed, interpolated, or rewritten by the runner.
 *
 * @public
 */
export interface Migration {
  readonly id: string;
  readonly up: readonly string[];
}

/** A single SQL statement plus its bound parameters. */
export interface MigrationStatement {
  readonly sql: string;
  readonly parameters: readonly QueryValue[];
}

/** Dialect-specific DDL/DML used by {@link MigrationRunner}. */
export interface MigrationDialect {
  readonly kind: MigrationDialectKind;
  readonly createTable: (table: string) => MigrationStatement;
  readonly listApplied: (table: string) => MigrationStatement;
  readonly insertApplied: (table: string, id: string, checksum: string, appliedAt: string) => MigrationStatement;
}

export interface MigrationRunnerOptions {
  readonly dialect: MigrationDialect;
  /** Migration ledger table. Must be a simple SQL identifier (default: `sveltex_migrations`). */
  readonly table?: string;
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly table: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const sqliteDialect: MigrationDialect = Object.freeze({
  kind: 'sqlite',
  createTable: (table: string): MigrationStatement => Object.freeze({
    sql: `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, position INTEGER NOT NULL)`,
    parameters: [],
  }),
  listApplied: (table: string): MigrationStatement => Object.freeze({
    sql: `SELECT id, checksum FROM ${table} ORDER BY position ASC`,
    parameters: [],
  }),
  insertApplied: (table: string, id: string, checksum: string, appliedAt: string): MigrationStatement => Object.freeze({
    sql: `INSERT INTO ${table} (id, checksum, applied_at, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM ${table}))`,
    parameters: [id, checksum, appliedAt],
  }),
});

const postgresDialect: MigrationDialect = Object.freeze({
  kind: 'postgres',
  createTable: (table: string): MigrationStatement => Object.freeze({
    sql: `CREATE TABLE IF NOT EXISTS ${table} (position BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`,
    parameters: [],
  }),
  listApplied: (table: string): MigrationStatement => Object.freeze({
    sql: `SELECT id, checksum FROM ${table} ORDER BY position ASC`,
    parameters: [],
  }),
  insertApplied: (table: string, id: string, checksum: string, appliedAt: string): MigrationStatement => Object.freeze({
    sql: `INSERT INTO ${table} (id, checksum, applied_at) VALUES ($1, $2, $3)`,
    parameters: [id, checksum, appliedAt],
  }),
});

const mysqlDialect: MigrationDialect = Object.freeze({
  kind: 'mysql',
  createTable: (table: string): MigrationStatement => Object.freeze({
    sql: `CREATE TABLE IF NOT EXISTS ${table} (position BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, id VARCHAR(255) NOT NULL UNIQUE, checksum VARCHAR(64) NOT NULL, applied_at VARCHAR(64) NOT NULL)`,
    parameters: [],
  }),
  listApplied: (table: string): MigrationStatement => Object.freeze({
    sql: `SELECT id, checksum FROM ${table} ORDER BY position ASC`,
    parameters: [],
  }),
  insertApplied: (table: string, id: string, checksum: string, appliedAt: string): MigrationStatement => Object.freeze({
    sql: `INSERT INTO ${table} (id, checksum, applied_at) VALUES (?, ?, ?)`,
    parameters: [id, checksum, appliedAt],
  }),
});

/** Built-in dialects. Pick the one matching the driver behind your `Database`. */
export const MIGRATION_DIALECTS: Readonly<Record<MigrationDialectKind, MigrationDialect>> = Object.freeze({
  sqlite: sqliteDialect,
  postgres: postgresDialect,
  mysql: mysqlDialect,
});

/** Return the built-in dialect for `kind`. Unknown kinds throw instead of guessing. */
export function createMigrationDialect(kind: MigrationDialectKind): MigrationDialect {
  const dialect = MIGRATION_DIALECTS[kind];
  if (dialect === undefined) {
    throw new TypeError(`Unknown migration dialect: ${String(kind)}. Use sqlite, postgres, or mysql.`);
  }
  return dialect;
}

/** SHA-256 over the migration id and every statement, used to detect edits. */
export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(`${migration.id}\n${migration.up.join('\n')}`, 'utf8').digest('hex');
}

interface AppliedRow extends Record<string, unknown> {
  id: string;
  checksum: string;
}

/**
 * Driver-neutral, ordered migration runner.
 *
 * It creates a ledger table, verifies that already-applied migrations are an
 * unchanged prefix of the current set, and applies each pending migration plus
 * its ledger row inside one transaction. It does not auto-detect the driver,
 * parse SQL, or coordinate concurrent deploy processes — see the README.
 *
 * @public
 */
export class MigrationRunner {
  readonly #db: Database;
  readonly #migrations: readonly Migration[];
  readonly #dialect: MigrationDialect;
  readonly #table: string;

  constructor(db: Database, migrations: readonly Migration[], options: MigrationRunnerOptions) {
    if (db === null || typeof db !== 'object' || typeof (db as Database).query !== 'function' || typeof (db as Database).transaction !== 'function') {
      throw new TypeError('MigrationRunner requires a Database-like instance.');
    }
    if (!Array.isArray(migrations)) throw new TypeError('Migrations must be an array.');
    if (options === null || typeof options !== 'object' || options.dialect === undefined || typeof options.dialect.createTable !== 'function') {
      throw new TypeError('MigrationRunner requires a migration dialect.');
    }
    const table = options.table ?? 'sveltex_migrations';
    if (!IDENTIFIER_PATTERN.test(table)) {
      throw new TypeError('Migration table name must be a simple SQL identifier.');
    }
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (migration === null || typeof migration !== 'object' || typeof migration.id !== 'string' || !MIGRATION_ID_PATTERN.test(migration.id)) {
        throw new TypeError('Every migration requires a valid, simple "id".');
      }
      if (seen.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
      seen.add(migration.id);
      if (!Array.isArray(migration.up) || migration.up.length === 0) {
        throw new TypeError(`Migration "${migration.id}" requires a non-empty "up" array.`);
      }
      for (const statement of migration.up) {
        if (typeof statement !== 'string' || statement.trim().length === 0 || statement.length > 1_000_000) {
          throw new TypeError(`Migration "${migration.id}" contains an invalid SQL statement.`);
        }
      }
    }
    this.#db = db;
    this.#migrations = Object.freeze([...migrations]);
    this.#dialect = options.dialect;
    this.#table = table;
  }

  async run(): Promise<MigrationReport> {
    const create = this.#dialect.createTable(this.#table);
    await this.#db.query(create.sql, create.parameters);

    const list = this.#dialect.listApplied(this.#table);
    const appliedResult = await this.#db.query<AppliedRow>(list.sql, list.parameters);
    const recorded = new Map<string, string>();
    for (const row of appliedResult.rows) {
      if (typeof row.id !== 'string' || typeof row.checksum !== 'string') {
        throw new Error('The migration ledger contains an invalid row.');
      }
      if (recorded.has(row.id)) throw new Error(`Duplicate applied migration id: ${row.id}`);
      recorded.set(row.id, row.checksum);
    }

    // Already-applied migrations must be an unchanged prefix of the current set.
    const orderedApplied = [...recorded.keys()];
    for (let index = 0; index < orderedApplied.length; index += 1) {
      const id = orderedApplied[index];
      const expected = this.#migrations[index];
      if (id === undefined || expected === undefined || expected.id !== id) {
        throw new Error(`Applied migration "${String(id)}" is not the expected prefix entry "${String(expected?.id)}".`);
      }
      if (recorded.get(id) !== migrationChecksum(expected)) {
        throw new Error(`Migration "${id}" was modified after it was applied; its checksum no longer matches.`);
      }
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const migration of this.#migrations) {
      if (recorded.has(migration.id)) {
        skipped.push(migration.id);
        continue;
      }
      const insert = this.#dialect.insertApplied(
        this.#table,
        migration.id,
        migrationChecksum(migration),
        new Date().toISOString(),
      );
      await this.#db.transaction(async (tx) => {
        for (const statement of migration.up) await tx.query(statement, []);
        await tx.query(insert.sql, insert.parameters);
      });
      applied.push(migration.id);
    }
    return Object.freeze({
      applied: Object.freeze(applied),
      skipped: Object.freeze(skipped),
      table: this.#table,
    });
  }
}
