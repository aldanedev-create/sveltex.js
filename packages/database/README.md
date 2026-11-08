# @sveltex/database

Database integration for SvelteX, in **two complementary layers**:

1. **SQL layer** — driver-neutral `Database` facade, three real SQL adapters, pooling and an
   ordered `MigrationRunner` (raw SQL, no ORM).
2. **ORM integration layer** — a public Bring-Your-Own-ORM contract, a managed connection
   lifecycle, a shared conformance suite, and official optional adapters for **Drizzle** and
   **Kysely**. SvelteX provides *integrations*, not a replacement ORM: the native ORM client is
   always preserved and reachable.

| Subpath | Contents | Requires |
| --- | --- | --- |
| `@sveltex/database` | `Database`, SQL contracts, **ORM contracts/core/testing** (dependency-free) | `pg`, `mysql2` |
| `@sveltex/database/sqlite` | `SqliteAdapter` (built-in `node:sqlite`, `?`) | — |
| `@sveltex/database/postgres` | `PostgresAdapter` (`pg` pool, `$1, $2, …`) | — |
| `@sveltex/database/mysql` | `MysqlAdapter` (`mysql2` pool, `?`) | — |
| `@sveltex/database/migrations` | `MigrationRunner` (dialect-specific) | — |
| `@sveltex/database/contracts` | BYO ORM contracts, errors, capability types | — |
| `@sveltex/database/core` | registry, lifecycle, environment config | — |
| `@sveltex/database/testing` | shared adapter conformance suite | — |
| `@sveltex/database/adapters/drizzle` | `createDrizzleAdapter` | **optional peer** `drizzle-orm` |
| `@sveltex/database/adapters/kysely` | `createKyselyAdapter` | **optional peer** `kysely` |

---

## 1. SQL layer

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

`Database` owns the lifecycle state machine (`idle → connecting → ready → closing → closed → failed`),
drains in-flight operations on close, validates SQL and bound parameters, freezes results, and wraps
driver failures. **The package never parses, interpolates, or rewrites SQL.** Use parameterized
queries; placeholders are dialect-specific and the package does not pretend SQL is portable.
`QueryResult.rowCount` reports returned rows for `SELECT`/`RETURNING` and affected rows for writes
(SQLite via `total_changes()`, PostgreSQL via `rowCount`, MySQL via `affectedRows`).

`PostgresAdapter`/`MysqlAdapter` manage real driver pools (`PoolConfig`: `max`, `idleTimeoutMs`,
`connectionTimeoutMs`, `acquireTimeoutMs`). Each top-level transaction acquires a dedicated pooled
connection; nested transactions use `AsyncLocalStorage` + `SAVEPOINT`. `connect()` probes `SELECT 1`;
`disconnect()` calls `pool.end()`.

`MigrationRunner` (`./migrations`) records SHA-256 checksums, validates an unchanged ordered prefix,
and applies each migration transactionally with built-in `sqlite`/`postgres`/`mysql` dialects. It is
a **driver-neutral utility** — see [§ Migrations](#4-migrations-and-the-orms-authority) for why ORM
adapters do **not** use it.

---

## 2. Bring Your Own ORM

Any ORM or data layer SvelteX does not ship an official adapter for is a first-class citizen. Define
an adapter with `defineDatabaseAdapter`; SvelteX handles the common lifecycle, you keep the native
API.

```ts
import {
  defineDatabaseAdapter, defineAdapterContext, createConnection,
} from '@sveltex/database';

const adapter = defineDatabaseAdapter({
  name: 'my-orm',
  capabilities: { transactions: true, healthCheck: true, savepoints: false, migrations: false },

  async connect(config) {
    const client = await MyOrm.connect(config);          // native ORM API
    return defineAdapterContext('my-orm', client, config);
  },
  async disconnect(ctx) { await ctx.client.close(); },
  async healthCheck(ctx) { return ctx.client.ping(); },
  async transaction(ctx, callback) {
    return ctx.client.$transaction((tx) =>
      callback(defineAdapterContext('my-orm', tx, ctx.config)));
  },
});

const connection = createConnection(adapter, { connectionString: process.env.DATABASE_URL });
await connection.connect();
await connection.transaction(async (tx) => {
  await tx.client.myOrmQuery(...);                       // native client, never wrapped
});
await connection.close();
```

A complete, runnable example lives at [`examples/custom-orm-adapter.mjs`](./examples/custom-orm-adapter.mjs)
(raw `pg.Pool`, no ORM, so every contract obligation is visible).

**Contract rules**

- `connect(config)` initialises the native client and returns a `DatabaseAdapterContext`
  (`{ client, config, adapter }`). `client` is the *native* ORM object.
- `disconnect(ctx)` releases native resources.
- `healthCheck(ctx)`, `transaction(ctx, cb)`, and `migrate(ctx, request)` are **optional
  capabilities**. Declaring a capability without an implementation is rejected by
  `validateAdapterDefinition` (no forged support).
- Capabilities are resolved into `DatabaseAdapterCapabilities` (`transactions`, `savepoints`,
  `healthCheck`, `migrations`); unimplemented ones default to `false`.

### Managed lifecycle & multiple connections

`createConnection(adapter, config)` wraps any adapter with: idempotent/concurrent-safe `connect()`,
`close()` that drains active operations before disconnecting, `healthCheck()` returning a redacted
`HealthCheckReport` (never raw connection strings), `transaction()` with application-error
preservation and `AbortSignal` support, and `native()`/`context()` for full access to the ORM client.
`AdapterRegistry` and `ConnectionManager` provide named registration, capability discovery
(`matching()`), `connectAll()`/`healthCheckAll()`/`closeAll()` (graceful shutdown — every connection
is closed even if one fails). `configFromEnv()` and `redactConfig()` provide passive,
log-safe environment configuration.

### Shared conformance suite

`runAdapterConformance(factory)` validates **any** adapter — official or custom — with the same
checks: definition validity, capability consistency, connect idempotency, health checks, transaction
execution + application-error propagation, native-client access, draining shutdown and post-close
rejection. It returns a `ConformanceReport` and has no test-runner dependency.

---

## 3. Official ORM integrations (optional)

`drizzle-orm` and `kysely` are **optional peer dependencies**. The main entry point imports **none**
of them; each adapter is isolated behind its own subpath and is loaded — and requires its peer —
only when imported. Installing `@sveltex/database` never pulls in an ORM.

### Drizzle

```ts
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createDrizzleAdapter } from '@sveltex/database/adapters/drizzle';
import { createConnection } from '@sveltex/database';

const adapter = createDrizzleAdapter({
  // `create` uses Drizzle's native API; the returned db is preserved verbatim.
  create: (config) => drizzle(new pg.Pool({ connectionString: config.connectionString })),
  // Optional: delegate to drizzle-kit / the ORM-native migrator.
  // migrate: async (db, request) => ({ ... }),
});
const connection = createConnection(adapter, { connectionString: process.env.DATABASE_URL });
await connection.connect();

const db = connection.native();                 // native Drizzle db
await connection.transaction(async (tx) => {
  await tx.client.execute(sql`insert into users (email) values ('a@b.c')`);
});
await connection.close();                       // calls pool.end() via db.$client
```

### Kysely

```ts
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createKyselyAdapter } from '@sveltex/database/adapters/kysely';

const adapter = createKyselyAdapter({
  create: (config) => new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: config.connectionString }),
    }),
  }),
});
const connection = createConnection(adapter, { connectionString: process.env.DATABASE_URL });
await connection.connect();
await connection.transaction(async (tx) => {
  await sql`insert into users (email) values ('a@b.c')`.execute(tx.client);
});
await connection.close();                       // calls db.destroy()
```

Both adapters provide real `connect`/`disconnect`, `SELECT 1` health checks, and native transaction
wrappers with the transaction object exposed as `tx.client`. Override `create`, `destroy`, `probe`,
`transaction`, or `migrate` to support other drivers/dialects. **Prisma, MikroORM and TypeORM are
not shipped as built-in adapters** — integrate them through the BYO contract above; they are not
advertised as supported integrations here.

---

## 4. Migrations and the ORM's authority

The ORM's own migration system remains authoritative. Built-in ORM adapters accept an optional
`migrate` hook that **delegates** to Drizzle Kit / Kysely's migrator / Prisma Migrate / etc.; SvelteX
does not run a competing engine for them. The existing `MigrationRunner` stays a driver-neutral
utility for the raw-SQL layer and is **not** advertised as an ORM migration replacement.

---

## Node.js requirement

This package requires **Node.js >= 22.5.0** because `node:sqlite` first appeared there. The rest of
the SvelteX packages still declare `>=20.11`. `node:sqlite` remains experimental and emits an
`ExperimentalWarning` on Node 22.

---

## Limitations (not claimed)

- **No shipped Prisma/MikroORM/TypeORM adapter.** They are supported through BYO ORM, not built in.
- **SvelteX is not an ORM.** No query builder, entity mapping, or schema DSL is provided; native
  ORM APIs are preserved, not reimplemented.
- **ORM adapters do not reimplement migrations.** They delegate to the ORM's native migrator.
- **No automatic dialect detection.** You pick the adapter and migration dialect explicitly.
- **No SQL rewriting.** Placeholders and SQL syntax are your responsibility in the SQL layer.
- **MySQL DDL implicitly commits.** A migration containing DDL cannot be rolled back atomically on
  MySQL; PostgreSQL and SQLite support transactional DDL.
- **No cross-process migration lock.** Coordinate concurrent deploys externally.
- **`pg` and `mysql2` are regular dependencies.** `drizzle-orm` and `kysely` are optional peers.
- No connection retry/backoff policy, read replicas, or failover are built in.
- Savepoints are declared `false` for the built-in ORM adapters (single-level transactions only);
  nested/savepoint behaviour stays ORM-specific.

---

## Testing

`pnpm test` runs unit, SQLite, migration, pool, ORM contract/lifecycle/conformance tests, plus real
Drizzle/Kysely/BYO integration tests against **real PostgreSQL**. PostgreSQL/MySQL integration tests
connect to real servers — they are not mocks. They read `SVELTEX_TEST_POSTGRES_URL` and
`SVELTEX_TEST_MYSQL_URL` (defaults point at local test servers). Set
`SVELTEX_SKIP_DB_INTEGRATION=1` only as an explicit opt-out; otherwise a missing server fails the
test rather than silently turning the suite green. CI provides PostgreSQL 16, MySQL 8.0 and Redis 7
services. `test:security` covers config redaction, forged-capability rejection, and connection-error
sanitisation.
