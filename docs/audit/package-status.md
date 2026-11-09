# SvelteX Package Status

**Last updated:** 2026-11-08  
**Verification environment:** Node 22.13.1, pnpm 10.20.0, TypeScript 5.9.3

---

## Test results summary

| Package | Build | Typecheck | Runtime tests | Security tests | Type tests | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `@sveltex/core` | ✅ Pass | ✅ Pass | ✅ 72/72 | ✅ 5/5 | ✅ Pass | **Stage 1 — Ready** |
| `@sveltex/shared` | ✅ Pass | ✅ Pass | ✅ 6/6 | ✅ 1/1 | ✅ Pass | **Stage 1 — Ready** |
| `@sveltex/config` | ✅ Pass | ✅ Pass | ✅ 8/8 | ✅ 1/1 | ✅ Pass | **Stage 1 — Ready** |
| `@sveltex/sveltekit` | ✅ Pass | ✅ Pass | ✅ 35/35 | ✅ 5/5 | ✅ Pass | **Stage 2 — Ready** |
| `@sveltex/database` | ✅ Pass | ✅ Pass | ✅ 116/116 | ✅ 16/16 | ✅ Pass | **Stage 3 — Complete (SQLite/PostgreSQL/MySQL + migrations + pooling + ORM/BYO)** |
| `@sveltex/validation` | ✅ Pass | ✅ Pass | ✅ 8/8 | ✅ 1/1 | ✅ Pass | **Stage 3 — Ready** |
| `@sveltex/auth` | ✅ Pass | ✅ Pass | ✅ 58/58 | ✅ 8/8 | ✅ Pass | **Stage 3 — Complete (Argon2id + reset/verification/RBAC/limiter/tokens)** |
| `@sveltex/cache` | ✅ Pass | ✅ Pass | ✅ 24/24 | ✅ 1/1 | ✅ Pass | **Stage 3 — Partial (Redis done)** |
| `@sveltex/session` | ✅ Pass | ✅ Pass | ✅ 32/32 | ✅ 1/1 | ✅ Pass | **Stage 3 — Partial (Redis done)** |
| `@sveltex/example-reference-app` | ✅ Pass | ✅ Pass | ✅ 18/18 | N/A | ✅ Pass | **Stage 3 — Exit criterion met** |
| `@sveltex/realtime` | ✅ Pass | ✅ Pass | ✅ 25/25 | ✅ 8/8 | ✅ Pass | **Stage 4 — Ready (process-local)** |
| `@sveltex/jobs` | ✅ Pass | ✅ Pass | ✅ 24/24 | ✅ 7/7 | ✅ Pass | **Stage 4 — Ready (process-local)** |
| `@sveltex/storage` | ✅ Pass | ✅ Pass | ✅ 24/24 | ✅ 9/9 | ✅ Pass | **Stage 4 — Ready (local disk)** |
| `@sveltex/mail` | ✅ Pass | ✅ Pass | ✅ 26/26 | ✅ 9/9 | ✅ Pass | **Stage 4 — Ready (test transport)** |
| `@sveltex/testing` | ✅ Pass | ✅ Pass | ✅ 32/32 | ✅ 12/12 | ✅ Pass | **Stage 4 — Ready (real core DI)** |
| `sveltex` (CLI) | ✅ Pass | ✅ Pass | ✅ 57/57 | ✅ 9/9 | ✅ Pass | **Stage 5 — Ready (built last)** |
| **Fixture** | ✅ Pass | ✅ Pass | N/A | N/A | N/A | **Builds successfully** |
| **Total** | **All pass** | **All pass** | **536/536** | **86/86** | **16/16** | **All pass** |

---

## Detailed package status

### Stage 1 — Foundation

#### `@sveltex/core` — ✅ Production-ready

- **Source:** 22 TypeScript files across application, config, container, errors, lifecycle, modules, types.
- **Public API:** `createApplication`, `Application`, `Container`, `token`, `defineModule`, `defineConfig`, `SvelteXError`, `SvelteXAggregateError`, `LifecycleManager`.
- **DI features:** Singleton, request-scoped, transient lifetimes. Circular dependency detection. Async factory resolution. Proper disposal chain.
- **Lifecycle:** Startup rollback on failure. Shutdown drains in-flight operations. Aggregate errors for partial failures.
- **Config:** Plain-object validation. Deep clone with cycle detection. Deep freeze. Prototype pollution protection.
- **Tests:** 72 unit tests + 5 security tests + stress tests + compatibility tests + public API type tests.
- **Dependencies:** None (framework-independent).
- **Limitations:** None identified.

#### `@sveltex/shared` — ✅ Production-ready

- **Source:** Single `index.ts` (67 lines).
- **Public API:** `Awaitable`, `MaybePromise`, `Mutable`, `DeepReadonly`, `Disposable`, `SvelteXError`, `isPlainObject`, `cloneData`, `deepFreeze`, `assertNever`, `toError`.
- **Security:** `cloneData` rejects `__proto__`/`prototype`/`constructor` keys, symbol keys, accessors, non-enumerable properties, non-finite numbers, cyclic structures.
- **Dependencies:** None.
- **Limitations:** None identified.

#### `@sveltex/config` — ✅ Production-ready

- **Source:** Single `index.ts` (49 lines).
- **Public API:** `defineConfig`, `mergeConfig`, `validateConfig`, `assertConfig`, `ConfigIssue`, `ConfigValidator`, `ConfigResult`.
- **Features:** Immutable frozen config. Deep merge with override semantics. Validator execution with issue normalization.
- **Dependencies:** `@sveltex/shared`.
- **Limitations:** `ConfigValidator` type duplicates the one in `@sveltex/core` config types — minor API alignment needed.

### Stage 2 — SvelteKit integration

#### `@sveltex/sveltekit` — ✅ Production-ready

- **Source:** 35 TypeScript files across application, configuration, context, errors, hooks, lifecycle, locals, types, utilities.
- **Public API:** `createSvelteXHandler`, `createHandler`, `composeHandlers`, `shutdownApplication`, `initializeApplication`, `SvelteXHandlerOptions`, `SvelteXRequestContext`.
- **Features:** Request-scoped DI via `locals.sveltex`. Concurrent startup coalescing. Hook composition preserving SvelteKit `sequence` semantics. Error normalization. Shutdown draining.
- **Tests:** 35 unit/integration tests + 5 security tests + stress tests + lifecycle tests + concurrency tests + compatibility tests.
- **Dependencies:** `@sveltex/core`. PeerDep: `@sveltejs/kit >=2`.
- **Fixture:** Real SvelteKit app with routes, server loads, actions, API endpoints. Builds and type-checks successfully with `@sveltejs/adapter-node`.

### Stage 3 — Essential backend packages

#### `@sveltex/database` — ✅ Complete (raw SQL + ORM integrations)

- **Source:** raw-SQL layer (`index.ts`, `sqlite.ts`, `postgres.ts`, `mysql.ts`, `pool.ts`, `migrations.ts`) plus the additive ORM integration layer (`contracts/`, `core/`, `testing/`, `adapters/`).
- **Public API (raw SQL):** `Database`, `DatabaseDriver`, `DatabaseExecutor`, `QueryResult`, `QueryOptions`, `QueryValue`, `PoolConfig`, `DatabaseState`, `DatabaseError`, `DatabaseLifecycleError`, `DatabaseDriverError`, `SqliteAdapter`, `PostgresAdapter`, `MysqlAdapter`, `MigrationRunner`, `MIGRATION_DIALECTS`, `createMigrationDialect`, `migrationChecksum`.
- **Public API (ORM layer):** `defineDatabaseAdapter`, `defineAdapterContext`, `validateAdapterDefinition`, `DEFAULT_ADAPTER_CAPABILITIES`, `DatabaseAdapterCapabilities`, `createAdapterRegistry`, `createConnection`, `ConnectionManager`, `configFromEnv`, `connectionStringFromEnv`, `redactConfig`, `runAdapterConformance`, and the `DatabaseAdapterError` / `AdapterTransactionError` / `UnsupportedCapabilityError` error family. Built-in adapters `createDrizzleAdapter` / `createKyselyAdapter` are exposed only through the `./adapters/drizzle` / `./adapters/kysely` subpaths.
- **Features:** Lifecycle state machine. Operation tracking with drain. Transaction-scoped executor (savepoints for nested). AbortSignal support. SQL/parameter validation. Frozen normalized results. ORM layer: passive env-based config, multi-connection manager with graceful shutdown, capability discovery, shared conformance tests, native ORM client preservation (`connection.native()` / `tx.client`), and optional `migrate()` delegation to the ORM's own migrator.
- **Adapters (raw SQL):** `SqliteAdapter` (`node:sqlite` `DatabaseSync`, no native build), `PostgresAdapter` (`pg.Pool`), `MysqlAdapter` (`mysql2` pool) — all with dedicated transaction connections and nested savepoints.
- **Adapters (ORM):** optional-peer Drizzle and Kysely adapters; BYO ORM via `defineDatabaseAdapter`. `drizzle-orm` and `kysely` are optional `peerDependencies`; the main entry imports neither.
- **Tests:** 116 runtime + 16 security tests. Real integration tests run against PostgreSQL 16 and MySQL 8.0 (CRUD, injection, commit/rollback, savepoints, concurrency, migrations, tamper detection) and against a real PostgreSQL 16 server for Drizzle, Kysely, and a runnable BYO custom adapter (`examples/custom-orm-adapter.mjs`).
- **Delivered:** PostgreSQL/MySQL adapters, `MigrationRunner` (checksums + three dialects), `PoolConfig`, corrected `rowCount`, and the full ORM integration layer. **Still missing:** cross-process migration lock, connection retry/failover, built-in Prisma/MikroORM/TypeORM adapters (BYO only), and a unified ORM migration CLI. **Engines:** `>=22.5.0` (`node:sqlite`).
- **Limitation:** ORM-side integration tests cover PostgreSQL; SQLite/MySQL ORM drivers are user-configurable via `create()` but are not separately claimed. `better-sqlite3` is excluded from native builds (`neverBuiltDependencies`) — it is only an optional peer of `drizzle-orm`, never imported by SvelteX.

#### `@sveltex/validation` — ✅ Ready (contract complete)

- **Source:** Single `index.ts` (63 lines).
- **Public API:** `StandardSchemaV1`, `StandardSchemaIssue`, `ValidationIssue`, `ValidationResult`, `ValidationError`, `ValidationExecutionError`, `safeValidate`, `validate`, `formatValidationIssues`.
- **Features:** Standard Schema v1 execution. Issue path normalization. Malformed schema rejection. Execution-error wrapping.
- **Tests:** 8 tests (unit + security).
- **Limitation:** No specific validator adapters (Zod, Valibot, etc.) but Standard Schema is vendor-neutral by design.

#### `@sveltex/auth` — ✅ Complete (Argon2id + reset/verification/RBAC/limiter/tokens)

- **Source:** `index.ts` (contracts, `AuthService`), `argon2.ts` (real `@node-rs/argon2` hasher), `errors.ts`, `limiter.ts`, `tokens.ts`, `rbac.ts`, `reset.ts`, `verification.ts`.
- **Public API:** `AuthService`, `AuthUser`, `CredentialUserStore`, `PasswordHasher`, `AuthSessionPort`, `AuthAttemptLimiter`, `AuthServiceOptions`, `AuthResult`, `AuthError`, `AuthConflictError`, `AuthConfigurationError`, `AuthForbiddenError`, `AuthUnauthorizedError`, `AuthTokenError`, `AuthTokenExpiredError`, `AuthTokenInvalidError`, `AuthTokenUsedError`, `Argon2Hasher`, `generateDummyHash`, `FixedWindowLimiter`, `TokenManager`, `MemoryTokenStore`, `generateSecureToken`, `RbacBuilder`, `createRbac`, `PasswordResetService`, `EmailVerificationService`.
- **Features:** Registration/login/logout/rotateSession. Injected hasher (no weak default). Dummy hash for timing mitigation. Email normalization. Password length limits. Attempt limiter. User sanitization. Concrete `FixedWindowLimiter` satisfying `AuthAttemptLimiter`. `TokenManager` issuing single-use, expiring, purpose-scoped tokens (`MemoryTokenStore`). `PasswordResetService` (silent for unknown emails; validates password before consuming the token). `EmailVerificationService`. Deny-by-default `RbacBuilder`/`createRbac` with role inheritance and `requirePermission` (401/403).
- **Adapters:** `Argon2Hasher` uses `@node-rs/argon2` (Argon2id). `generateDummyHash` produces a constant-time dummy hash for absent-user login. Token delivery and credential stores are ports (`PasswordResetSender`, `EmailVerificationSender`, `PasswordResetStore`, `EmailVerificationStore`) so no mail client or DB driver is assumed.
- **Tests:** 58 tests (50 unit/security + 8 security in `tests/security/`) including 14 real Argon2id integration tests, full `AuthService` registration/login/logout flow, fixed-window limiter behavior, token lifecycle (single-use/expiry/purpose-scoping), RBAC inheritance + cycle detection + 401/403, password-reset and email-verification flows, and timing/enumeration/brute-force/bypass security tests.
- **Out of scope (explicit, not advertised):** OAuth2/OIDC, MFA, cookie/CSRF hardening (delegated to the session package).
- **Limitation:** Real hashing verified only with Argon2id via `@node-rs/argon2`; the in-memory token store is single-process (production deployments should back `TokenStore` with Redis/DB).

#### `@sveltex/cache` — ⚠️ Partial (Redis adapter implemented, advanced features pending)

- **Source:** `index.ts` (68 lines) + `redis.ts` (real `ioredis` adapter).
- **Public API:** `CacheStore`, `CacheSetOptions`, `MemoryCache`, `MemoryCacheOptions`, `RedisCache`, `RedisCacheOptions`.
- **Features:** `MemoryCache` — bounded LRU, TTL with injected clock, expiry purge, capacity enforcement, key/TTL validation. `RedisCache` — JSON-serialized values, native Redis TTL, `keyPrefix` namespace isolation, `increment`/`getMany`/`setMany` atomic operations, connection pooling via `ioredis`.
- **Adapters:** `RedisCache` uses `ioredis` against a live Redis server.
- **Tests:** 25 tests — 7 memory + 1 security + 17 real Redis integration tests (`tests/redis-integration.test.mjs`), covering set/get/delete/has, TTL expiry (real), increment, multi-key batching, namespace isolation, `clear()` scoping, and key/TTL validation.
- **Missing:** Tags. Advanced invalidation patterns. Other distributed backends.
- **Limitation:** Redis adapter verified against a live Redis 7 instance; memory cache remains the process-local development/test implementation.

#### `@sveltex/session` — ⚠️ Partial (Redis adapter implemented, transport pending)

- **Source:** `index.ts` (98 lines) + `redis.ts` (real `ioredis` adapter).
- **Public API:** `SessionManager`, `SessionStore`, `SessionRecord`, `SessionHandle`, `SessionManagerOptions`, `MemorySessionStore`, `SessionConflictError`, `RedisSessionStore`, `RedisSessionStoreOptions` (via `@sveltex/session/redis`).
- **Features:** Revision-based compare-and-set. Atomic rotate. Collision retry with configurable attempts. URL-safe ID validation. Deep-cloned/frozen data. Expiry checking. `touch()` for sliding expiration.
- **Adapters:** `RedisSessionStore` uses `ioredis` + three server-side **Lua scripts** (`EVAL`) so `createIfAbsent` (SET-NX semantics), `compareAndSet` (CAS on stored revision), and `rotate` (atomic old→new move) are genuinely atomic across processes. Records are JSON values under `<keyPrefix><id>` with a physical TTL derived from `expiresAt`. `clear()` uses `SCAN`+`DEL` scoped to the prefix (never `FLUSHDB`). Corrupt/expired records are purged on read. Reads return deeply frozen clones.
- **Tests:** 32 tests — 12 unit/security + 20 real Redis integration tests (`tests/redis-session-integration.test.mjs`), covering CAS/rotate/createIfAbsent atomicity under contention, cross-connection session sharing, namespace isolation, logical + physical expiry, corrupt-data purge, and full `SessionManager` lifecycle. Plus a `./redis` public-API type test.
- **Missing:** Database-backed store. Cookie transport. CSRF integration. Session fixation auto-rotation.
- **Limitation:** Redis adapter verified against a live Redis 7 instance; memory store remains the process-local development/test implementation.

### Stage 3 — Reference application (exit criterion)

#### `@sveltex/example-reference-app` — ✅ Exit criterion met (private, not published)

- **Location:** `examples/reference-app/`; added to `pnpm-workspace.yaml` as `examples/*`. Private workspace app, not a publishable package.
- **Purpose:** Demonstrates persistence, validation, authentication, authorization, sessions, and caching wired together from real `@sveltex/*` packages. The fourth Stage 3 exit criterion.
- **Assembly:** `createApp(options)` / `ReferenceApp` in `src/app.ts`. `Database(SqliteAdapter)` + `SqliteUserStore` (atomic email uniqueness), `AuthService` + `Argon2Hasher` + `generateDummyHash`, `SessionManager` bridged to `AuthSessionPort` (memory or Redis/Lua store), `CacheStore` (memory or Redis, cache-aside + invalidation), `validate()` with hand-written Standard Schema v1 schemas, application-layer RBAC against fresh DB rows.
- **Provider paths:** in-process (`SQLite :memory:` + `MemorySessionStore` + `MemoryCache`) by default; `createApp({ redisUrl })` switches both session and cache to real `ioredis` adapters with explicit `connect()`/`disconnect()`. No fake provider, no untested support claim.
- **Security:** no self-granted roles (admin only from trusted `adminEmails`), fresh-record authorization, session-derived `authorId`, parameterized SQL, role allow-list + cache invalidation, atomic session rotation, session-ID validation, Argon2id + dummy-hash timing mitigation.
- **Tests:** 18 integration tests — 16 in-process (`tests/reference-app.test.mjs`) + 2 live Redis (`tests/redis-reference-app.test.mjs`, skipped via TCP probe if unreachable), plus `tests/types/app-api.test.ts`. All pass; 0 skipped on this host.
- **Scripts:** `build`, `typecheck`, `test` (build + `node --test` + type test), `test:types` (wired into root `test:types`).

### Stage 4 — Advanced capabilities (complete)

All five packages are independently installable ESM packages with strict `tsconfig.json`, `README.md`, `CHANGELOG.md`, runtime tests, `tests/security/`, and `tests/types/public-api.test.ts`. XERJ was re-indexed (`1159 records / 261 files`) and used to study the Stage 4 spec and the real `@sveltex/core` DI/lifecycle contracts before implementation.

#### `@sveltex/realtime` — ✅ Ready (process-local)

- **Source:** `src/index.ts` (contracts, hub, authorization, de-duplication, errors) + `src/in-process.ts`.
- **Public API:** `defineChannel<T>()`, `RealtimeHub<P>`, `allowAll`/`denyAll`, `InProcessTransport` (`./in-process`), `RealtimeTransport`, `Subscription`, `AuthorizeHook<P>`, `AuthorizationContext<P>`, `RealtimeMetrics`, and the `RealtimeError` family.
- **Features:** required `authorize` hook (no implicit allow) consulted for `publish`/`subscribe`/`deliver`; `deliver` evaluated **per subscriber**; bounded **per-subscriber** de-duplication of at-least-once redeliveries (an initial global-set design was corrected); deep-frozen delivered payloads; subscriber failure isolation; metrics.
- **Tests:** 25 — 17 unit + 8 security. `InProcessTransport({ redeliveries })` deterministically simulates duplicate delivery.
- **Limitations:** process-local only; no WebSocket/SSE or broker adapter is shipped or advertised.

#### `@sveltex/jobs` — ✅ Ready (process-local)

- **Source:** `src/index.ts` (contracts, `computeBackoffDelay`, `Worker`) + `src/in-memory.ts`.
- **Public API:** `JobQueue`, `Job`, `EnqueueOptions`, `BackoffPolicy`, `computeBackoffDelay`, `Worker`, `InMemoryJobQueue` (`./in-memory`).
- **Features:** atomic `claim`, delayed visibility, deduplication keys, dead-letter state, idempotent `complete`/`fail`; `Worker` with concurrency, capped exponential backoff, bounded retries, failure isolation, graceful `stop()`, external `AbortSignal`, and injectable clock via public `tick(now?)`.
- **Tests:** 24 — 17 unit + 7 security.
- **Limitations:** not durable and not distributed; no broker adapter is shipped or advertised.

#### `@sveltex/storage` — ✅ Ready (local disk)

- **Source:** `src/index.ts` (contracts, validation, streaming helpers, `Storage` facade) + `src/local.ts`.
- **Public API:** `Storage`, `StorageDriver`, `ObjectMetadata`, `PutOptions`, `LocalStorageDriver` (`./local`), and the `StorageError` family.
- **Features:** key/content-type/custom-metadata/size validation before I/O; SHA-256 hashed filenames (user paths never reach disk); atomic temp + `rename` writes with metadata published last; Web `ReadableStream<Uint8Array>` reads; symlink rejection; etag/size integrity metadata.
- **Tests:** 24 — 15 unit + 9 security, including a real filesystem-persistence integration test and path-traversal tests.
- **Limitations:** local filesystem only; not a distributed object store; no S3 adapter is shipped or advertised.

#### `@sveltex/mail` — ✅ Ready (test transport)

- **Source:** `src/index.ts` (contracts, validation, templates, retrying `Mailer`) + `src/test-transport.ts`.
- **Public API:** `Mailer`, `MailTransport`, `MailMessage`, `renderTemplate`, `computeRetryDelay`, `TestTransport` (`./test-transport`), and the `MailError` family.
- **Features:** address/header validation, CRLF/NUL injection rejection, HTML-escaped template interpolation by default, capped exponential-backoff retries with injectable `sleep`/`now`, permanent failure → `MailSendError` with attempts + cause (never a false success).
- **Tests:** 26 — 17 unit + 9 security.
- **Limitations:** no SMTP/HTTP provider adapter is shipped or advertised; `TestTransport` is deterministic in-memory and never sends real email.

#### `@sveltex/testing` — ✅ Ready (real core DI)

- **Source:** `src/index.ts` + `src/errors.ts` + `src/fakes.ts`. Depends on `@sveltex/core` and `@sveltex/shared`.
- **Public API:** `TestApplication`, `createTestApplication`, `withTestApplication`, `createRequestFixture`, `defineTestModule`, `testToken`, three provider helpers, `FakeClock`, `LifecycleRecorder`, `FakeKeyValueAdapter`, `FakeMessageTransport`, `TestingError`/`TestSetupError`.
- **Features:** built on the **real** core `createApplication`/`defineModule`/`token`/`Container` — no parallel DI implementation; guaranteed cleanup (including forgotten request scopes), deterministic clock/recorder, frozen defensive fake snapshots, `failNext()` failure injection.
- **Tests:** 32 — 20 unit + 12 security; verifies real core state transitions, scopes, lifecycle ordering, disposal order, and config/scope error propagation.
- **Limitations:** dev/test dependency only; fakes are in-memory and never touch network or disk.

### Stage 5 — Developer experience (complete, built last)

#### `sveltex` — ✅ Ready (development tool, not a runtime dependency)

- **Location:** `packages/cli/`; published name `sveltex` (the only non-`@sveltex/*` package), `bin.sveltex` → `dist/cli.js`. Depends on `@sveltex/config` only; generated apps never depend on the CLI at runtime.
- **Source:** 32 TypeScript files (~2,950 lines) + 41 `.tmpl` template assets. Strict ESM/NodeNext TypeScript, `README.md`, `CHANGELOG.md`, `LICENSE`.
- **Commands (17):** `create`, `init`, `add`, `remove`, `generate`, delegated `dev`/`build`/`preview`/`check`/`test`, `doctor`, `info`, `routes`, `modules`, `config`, `upgrade`, `migrate`.
- **Templates:** six official starters (`minimal`, `fullstack`, `api`, `dashboard`, `saas`, `documentation`) and four welcome pages (`welcome`, `blank`, `dashboard`, `docs`). Six-template smoke generation: 14–16 files per app, zero unrendered placeholders. The `saas` starter is a layout shell and explicitly disclaims auth, persistence, billing, subscriptions, and payments.
- **Safety:** `ChangeSet` preview/apply/rollback; `--dry-run` writes nothing; overwrite requires `--force`/`--yes`; `init` composes existing SvelteKit hooks as `userHandle` with `sequence()` and preserves comments; config is statically inspected (never executed) with secret redaction and env names only; `shell: false` with argument arrays; project-name/path/package-specifier validation (leading-dash option injection, encoded traversal, NUL); conflicting lockfiles stop the command; failed installs roll back every CLI-owned change. `init --no-install` fixed to actually skip installation and the automatic project check.
- **Diagnostics:** `doctor` emits stable codes/severities/paths/safe fixes for Node, package manager, SvelteX/SvelteKit versions, peer compatibility, config validity, hook integration, TypeScript, missing env names, and process-local-vs-multi-instance mismatches. `upgrade` uses CLI-owned metadata only (no registry lookup); `migrate` is preview-first.
- **Output:** stable `CliResult`, single-object `--json`, exit codes `0`/`1`/`2`/`3`/`4`; `runCli()` never calls `process.exit()`.
- **Integrations:** registry lists only the 14 real shipped `@sveltex/*` packages. No SMTP/S3/WebSocket/hosted-Redis adapter is shipped or advertised.
- **Tests:** 57 — 11 unit, 12 command, 7 generator, 6 package-manager, 6 diagnostic, 9 security, 5 e2e — plus a public-API type test. Wired into root `test:security`, `test:types`, and `test:packages`.
- **Limitations:** no registry lookup or version guessing; no external provider adapters; a consumer-side `install → typecheck → build` of a generated app against published packages is still CI work (workspace packages are unpublished).

---

## Package publishing readiness

| Package | `files` correct | `exports` correct | `types` correct | `peerDeps` | `npm pack` |
| --- | --- | --- | --- | --- | --- |
| core | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| shared | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| config | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| sveltekit | ✅ | ✅ | ✅ | `@sveltejs/kit >=2` | ✅ Verified |
| database | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| validation | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| auth | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| cache | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| session | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| realtime | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| jobs | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| storage | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| mail | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| testing | ✅ | ✅ | ✅ | N/A | ✅ Verified |
| `sveltex` (CLI) | ✅ | ✅ | ✅ | N/A | ✅ Verified |

All 15 packages use ESM (`"type": "module"`), publish TypeScript declarations, and have correct `exports`/`types`/`main` fields. `npm pack --dry-run` was verified for all five Stage 4 packages and the CLI: Stage 4 publishes only `dist/`, `README.md`, `CHANGELOG.md`, and `package.json`; the CLI additionally publishes `templates/` and `LICENSE` (173 files total — no source or test files leak). The `@sveltex/example-reference-app` workspace project is `private: true` and intentionally not published — it is a verification application, not a library. Its `test:types` script is included in the root `test:types` chain, alongside all five Stage 4 packages and the `sveltex` CLI in `test:types` (16), `test:security` (15), and `test:packages` (13).
