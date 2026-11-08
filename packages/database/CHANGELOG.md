# Changelog

## Unreleased — ORM integration layer (Completion Plan, Phase 1)

> Package version remains `0.1.0` (unpublished). This section records unreleased changes; a
> version bump is deferred to the release audit (Phase 11).

- Added a public **Bring-Your-Own-ORM contract**: `defineDatabaseAdapter`, `defineAdapterContext`,
  `validateAdapterDefinition`, capability declarations (`transactions`, `savepoints`, `healthCheck`,
  `migrations`), optional `migrate()` delegation, and `DatabaseAdapterError`/`AdapterTransactionError`/
  `UnsupportedCapabilityError`.
- Added `src/core`: `AdapterRegistry` (named, capability-discoverable registration), `createConnection`
  (idempotent/concurrent-safe connect, draining close, redacted health reports, transactions with
  `AbortSignal`, native-client access), `ConnectionManager` (multi-connection graceful shutdown),
  `configFromEnv`/`connectionStringFromEnv`/`redactConfig`.
- Added `runAdapterConformance` (`./testing`): a shared, framework-agnostic conformance suite for
  official and custom adapters.
- Added official **optional** adapters `createDrizzleAdapter` (`./adapters/drizzle`) and
  `createKyselyAdapter` (`./adapters/kysely`). `drizzle-orm` and `kysely` are optional peers behind
  subpath exports; the main entry point imports neither.
- Added a working custom-adapter example at `examples/custom-orm-adapter.mjs`.
- Real integration tests against live PostgreSQL for Drizzle, Kysely and the BYO adapter (health
  checks, native API preservation, transaction commit/rollback, shared conformance).
- ORM migration authority: adapters delegate to the ORM-native migrator; `MigrationRunner` remains a
  driver-neutral raw-SQL utility and is not advertised as an ORM migration replacement.
- Removed the unused `better-sqlite3` dev dependency; `pnpm-workspace.yaml` now skips its native
  build (it only exists as an optional peer of `drizzle-orm`).

## 0.1.0

- Initial driver-neutral lifecycle and transaction facade.
- Added real `PostgresAdapter` (`pg.Pool`) and `MysqlAdapter` (`mysql2/promise` pool) with pooled
  connections, dedicated transaction connections, `AsyncLocalStorage`-backed nested savepoints, and
  correct reported row counts.
- Added driver-neutral `MigrationRunner` with SHA-256 checksums, ordered-prefix validation,
  transactional application, and built-in `sqlite`/`postgres`/`mysql` dialects.
- Added shared `PoolConfig` contract (`max`, `idleTimeoutMs`, `connectionTimeoutMs`,
  `acquireTimeoutMs`) with strict validation.
- Fixed `SqliteAdapter` `rowCount`: plain `INSERT`/`UPDATE`/`DELETE` now report affected rows via
  `total_changes()` instead of `0`.
- Raised this package's Node.js requirement to `>=22.5.0` to match `node:sqlite`; the other
  SvelteX packages still declare `>=20.11`.
- PostgreSQL/MySQL integration tests run against real servers; CI provisions PostgreSQL 16,
  MySQL 8.0 and Redis 7 services so integration tests execute instead of being skipped.
