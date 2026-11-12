# Changelog

## Unreleased — Completion-plan Phase 6 (2026-11-11)

> Package version remains `0.1.0` (unpublished). Version bumps are deferred to the Phase 11
> release audit so the CLI integration registry's single-version policy stays satisfied.

### Added

- **Real Redis-backed queue** (`@sveltex/jobs/redis`): `RedisJobQueue` over real `ioredis` with
  four Lua scripts for atomic `enqueue` / `claim` / `complete`-`fail` / `cancel`. A ready ZSET
  keyed by `availableAt`, an id SET, strict per-job records and dedupe keys. Two independent
  clients cannot claim the same job twice; `close()` disconnects the client.
- **Real SQL-backed queue** (`@sveltex/jobs/sql`): `SqlJobQueue` over a BYO `JobSqlExecutor`
  (`@sveltex/database`'s `Database` satisfies it). Transactional atomic claim with
  `FOR UPDATE SKIP LOCKED` on PostgreSQL and a conditional-update row-count guard, a partial
  unique dedupe index for `pending`/`active` rows, `schemaStatements()` for migrations, bounded
  retry for PostgreSQL's concurrent-DDL catalog race. `sqlite` and `postgres` dialects.
- **Strict persisted wire format** (`@sveltex/jobs/serialization`): versioned
  `sveltex-jobs:v1:` envelope with `u` / `j` tags, 64 KiB payload and 128 KiB record bounds,
  rejection of values `JSON.stringify` would silently coerce, prototype-pollution key rejection,
  and full validation of every record field on decode (plaintext/legacy/tampered rows are never
  coerced).
- **Shared validation** (`@sveltex/jobs/validation`) used by every backend: name grammar,
  bounded ids/dedupe keys/errors, plain SQL identifiers, finite timestamps, integer claim limits.
- **Registration** (`@sveltex/jobs/registry`): `JobRegistry` with typed `SX_JOBS_UNREGISTERED`
  dispatch so unknown jobs dead-letter instead of being dropped.
- **Scheduling** (`@sveltex/jobs/scheduler`): clock-injectable `JobScheduler` with
  `enqueue` / `scheduleAt` / `scheduleIn` and `computeDelayMs`.
- Three typed errors: `JobsSerializationError`, `JobsConfigurationError`, `JobsStoreError`
  (the latter preserves `operation` and `cause`).
- `JobQueue.cancel(id)` added to the shared contract, implemented by all three backends.
- Six new subpath exports: `./validation`, `./serialization`, `./registry`, `./scheduler`,
  `./redis`, `./sql`.
- Real integration tests (7 Redis, 10 SQL) driven by live Redis / SQLite / PostgreSQL, plus
  an expanded public-API type-test project. CI runs them via
  `pnpm --filter @sveltex/jobs test:integration`; no test is skipped.

### Changed

- `ioredis` added as a runtime dependency; `@sveltex/database` added as a dev dependency for
  SQL integration tests.
- `InMemoryJobQueue` rewritten to use the shared validation module while preserving its
  existing runtime/security semantics; it now implements `cancel()`.
- CI gained an explicit integration-test step backed by `redis:7` and `postgres:16` services.
- Package README rewritten to document all three backends, the wire format, and honest limits.

### Fixed

- PostgreSQL concurrent first-time schema creation (`23505 pg_type_typname_nsp_index`) is now
  bounded-retry safe instead of surfacing a spurious `JobsStoreError`.
- `decodeJobRecord` now enforces the strict payload envelope, bounded id and name grammar, so a
  tampered persisted row cannot bypass validation.

### Not claimed

- No MySQL adapter for `SqlJobQueue`, no Redis Cluster cross-slot routing, no priority queue,
  no cron/periodic schedule persistence, no TLS/auth/rate-limiting layer, no dead-letter replay
  tooling, no job-progress store.
- `InMemoryJobQueue` remains process-local and non-durable.

## 0.1.0

- Initial independently installable SvelteX package.
