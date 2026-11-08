# @sveltex/database

Driver-neutral database lifecycle, query and transaction contracts for SvelteX,
plus **three real adapters** and an ordered migration runner.

| Subpath | Adapter | Driver | Placeholders |
| --- | --- | --- | --- |
| `@sveltex/database/sqlite` | `SqliteAdapter` | built-in `node:sqlite` | `?` |
| `@sveltex/database/postgres` | `PostgresAdapter` | `pg` (`Pool`) | `$1, $2, …` |
| `@sveltex/database/mysql` | `MysqlAdapter` | `mysql2/promise` (`createPool`) | `?` |
| `@sveltex/database/migrations` | `MigrationRunner` | any `Database` | dialect-specific |

```ts
import { Database } from '@sveltex/database';
import { PostgresAdapter } from '@sveltex/database/postgres';

const db = new Database(new PostgresAdapter({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  pool: { max: 20, connectionTimeoutMs: 5_000 },
}));
await db.connect();
try {
  const users = await db.query('select id, email from users where id = $1', [userId]);
  await db.transaction(async tx => {
    await tx.query('update accounts set balance = balance - $1 where id = $2', [amount, accountId]);
  });
} finally { await db.close(); }
```

## Contract and safety

`Database` owns the lifecycle state machine (`idle → connecting → ready → closing → closed → failed`),
drains in-flight operations on close, validates SQL and bound parameters, freezes results, and wraps
driver failures. Transaction executors become invalid as soon as the callback settles.

**The package never parses, interpolates, or rewrites SQL.** Always use parameterized queries.
Because placeholders are dialect-specific, SQL written for one adapter is not portable to another;
the package does not pretend otherwise. `QueryValue` accepts strings, finite numbers, booleans,
bigints, valid `Date`s, `Uint8Array`s and `null`.

`QueryResult.rowCount` is the number of rows **returned** by a `SELECT`/`RETURNING` statement, or
the number of rows **affected** by `INSERT`/`UPDATE`/`DELETE`. SQLite uses `total_changes()` around
each statement, PostgreSQL uses `pg`'s `rowCount`, and MySQL uses `ResultSetHeader.affectedRows`.
Plain writes no longer report `0`.

## Connection pools

`PostgresAdapter` and `MysqlAdapter` manage real driver pools. `PoolConfig` (exported from the root
subpath) provides `max` (default 10, max 1000), `idleTimeoutMs` (30000), `connectionTimeoutMs`
(5000) and `acquireTimeoutMs` (10000). Invalid values throw instead of being coerced. `connect()`
verifies the pool with a real `SELECT 1`; `disconnect()` calls `pool.end()`.

Each top-level transaction acquires a **dedicated** pooled connection and runs
`BEGIN`/`COMMIT`/`ROLLBACK`. Nested transactions reuse that connection through `AsyncLocalStorage`
and `SAVEPOINT`, matching the SQLite adapter's semantics. Concurrent top-level transactions get
separate connections and are isolated. `SqliteAdapter` is single-connection and has no pool.

TLS is configured through `connectionString`/`uri` or the PostgreSQL `ssl` option; the MySQL adapter
does not invent transport defaults.

## Migrations

```ts
import { MigrationRunner, createMigrationDialect } from '@sveltex/database/migrations';

const runner = new MigrationRunner(db, [
  { id: '001_users', up: ['CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT)'] },
  { id: '002_index', up: ['CREATE INDEX users_email ON users (email)'] },
], { dialect: createMigrationDialect('postgres'), table: 'sveltex_migrations' });

const report = await runner.run(); // { applied, skipped, table }
```

The runner creates its ledger, records a SHA-256 checksum for every applied migration, and verifies
on each run that already-applied migrations are an **unchanged prefix** of the current set. Each
pending migration and its ledger row are applied inside one transaction. Ledger table names are
restricted to simple SQL identifiers; unknown dialects throw instead of being guessed. Built-in
dialects are `sqlite`, `postgres` and `mysql` (`MIGRATION_DIALECTS`, `createMigrationDialect`).

## Node.js requirement

This package requires **Node.js >= 22.5.0** because `node:sqlite` first appeared there. The rest of
the SvelteX packages still declare `>=20.11`. `node:sqlite` remains experimental and emits an
`ExperimentalWarning` on Node 22.

## Limitations (not claimed)

- **No ORM.** There is no query builder, entity mapping, or Drizzle/Prisma integration.
- **No automatic dialect detection.** You pick the adapter and the migration dialect explicitly.
- **No SQL rewriting.** Placeholders and SQL syntax are your responsibility.
- **MySQL DDL implicitly commits.** A migration containing DDL cannot be rolled back atomically on
  MySQL; write idempotent, re-runnable migrations. PostgreSQL and SQLite support transactional DDL.
- **No cross-process migration lock.** Coordinate concurrent deploys externally; the runner does
  not claim distributed correctness.
- **`pg` and `mysql2` are regular dependencies.** They are installed even when only SQLite is used.
- No connection retry/backoff policy, read replicas, or failover are built in.

## Testing

`pnpm test` runs unit, SQLite, migration and pool tests. PostgreSQL/MySQL integration tests connect
to **real servers** — they are not mocks. They read `SVELTEX_TEST_POSTGRES_URL` and
`SVELTEX_TEST_MYSQL_URL` (defaults point at local test servers). Set
`SVELTEX_SKIP_DB_INTEGRATION=1` only as an explicit opt-out; otherwise a missing server fails the
test rather than silently turning the suite green. CI provides PostgreSQL 16, MySQL 8.0 and Redis 7
services so all integration tests run for real.
