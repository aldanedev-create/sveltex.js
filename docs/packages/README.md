# SvelteX packages

SvelteX is split into independently installable packages. Build the application engine and SvelteKit integration first, then the backend package contracts, then advanced infrastructure. Implement the CLI last.

| Stage | Package | Status |
| --- | --- | --- |
| 1 | `@sveltex/core` | Production-ready — 72 runtime + 5 security tests, DI/lifecycle/modules |
| 1 | `@sveltex/shared` | Production-ready — data utilities, errors, strict input tests |
| 1 | `@sveltex/config` | Production-ready — immutable config, safe merge, validation |
| 2 | `@sveltex/sveltekit` | Production-ready — 35 tests; real SvelteKit fixture builds and type-checks |
| 3 | `@sveltex/database` | Driver contract + real `SqliteAdapter`/`PostgresAdapter`/`MysqlAdapter`, `MigrationRunner`, `PoolConfig`, and optional ORM integrations (Drizzle/Kysely + BYO); 116 tests |
| 3 | `@sveltex/validation` | Standard Schema v1 execution and issue normalization; 8 tests |
| 3 | `@sveltex/auth` | Credential orchestration + real `Argon2Hasher` (Argon2id); limiter/tokens/reset/verification/RBAC; 58 tests (8 security) |
| 3 | `@sveltex/cache` | Bounded memory LRU/TTL + real `RedisCache` (`ioredis`); Phase 4 adds strict serialization envelopes, escaped namespaces, tag/prefix/predicate invalidation, graceful fallback and single-flight; 121 tests (15 security, real Redis integration) |
| 3 | `@sveltex/session` | Revisioned lifecycle + real atomic `RedisSessionStore` (Lua `EVAL`) + `DatabaseSessionStore` (SQLite/PG/MySQL), `__Host-` cookie transport, CSRF, revocation, auth bridge; 104 tests (13 security) |
| 4 | `@sveltex/realtime` | Implemented — typed channels, required authorization hook, `InProcessTransport`; 25 tests |
| 4 | `@sveltex/jobs` | Implemented — `JobQueue`/`InMemoryJobQueue`, retrying `Worker`; 24 tests |
| 4 | `@sveltex/storage` | Implemented — `StorageDriver`/`LocalStorageDriver` (real filesystem I/O); 24 tests |
| 4 | `@sveltex/mail` | Implemented — message/template contracts, retrying `Mailer`, `TestTransport`; 26 tests |
| 4 | `@sveltex/testing` | Implemented — builders over real core DI, deterministic clock/fakes; 32 tests |
| 5 | `sveltex` CLI | **Complete, built last** — 17 commands, six official templates, 57 tests; development tool only (generated apps never depend on it at runtime) |

Do not add placeholder packages for future stages. Each package must have a useful implementation, stable public contracts, strict type checks, public API type tests, unit/integration/security tests, package export checks, and documentation before it is considered complete.

All five stages are now implemented and verified (734 runtime tests, 119 security tests, 16 type-test projects, measured after completion-plan Phase 4). The CLI was deliberately built last; it consumes the stable package contracts and lists only real shipped integrations. `@sveltex/database` ships real PostgreSQL and MySQL adapters plus migrations, pooling, and optional ORM integrations (Drizzle/Kysely + BYO ORM); built-in Prisma/MikroORM/TypeORM adapters are not claimed. No external provider adapter (SMTP/S3/WebSocket/hosted Redis) is shipped or advertised.

See [`../specification.md`](../specification.md) for package responsibilities, API rules, acceptance criteria, and the complete CLI specification.
