# Phase 0 — Existing Package Audit (based on actual repository state)

**Date:** 2026-11-08
**Method:** static scan of every `packages/*/package.json` and `src/**/*.ts`, real `node --test`
runtime counts, `pnpm check` totals, XERJ code search, and README "not claimed" statements.
**Rule applied:** *"Do not assume a feature is complete merely because it appears in the
documentation."* Every number below was re-measured from the working tree, not copied from docs.

This document is the deliverable for Phase 0 of the
[Existing Package Completion Plan](../completion-plan.md). It is a **checklist of what is
actually implemented**, and the gap list that Phases 1–12 must close. It is intentionally
blunt: passing unit tests are not treated as proof of production readiness.

---

## 1. Measured inventory

Workspace contains **15 implemented packages** (the plan's "no new packages" rule — none were
added). Runtime tests are counted from real `pnpm -r test`, `pnpm check` = **488/488**,
`pnpm test:security` = **77/77**, type-test projects = **16/16**. These are the **Phase 0
snapshot** (a historical baseline retained for audit traceability); after Phase 1 the measured
totals were **536/536 runtime / 86/86 security**, after Phase 2 **565/565 / 93/93**, and after
Phase 3 **637/637 runtime / 105/105 security**, after Phase 4 **734/734 runtime / 119/119 security**, and after Phase 5 (current)
**779/779 runtime / 131/131 security** — see the [Phase 5 report](./phase-5-realtime.md).

| Package | src files | src lines | runtime tests | subpath exports | engines |
|---|---:|---:|---:|---|---|
| `@sveltex/shared` | 1 | 66 | 6 | `.` | >=20.11 |
| `@sveltex/config` | 1 | 48 | 8 | `.` | >=20.11 |
| `@sveltex/core` | 23 | 664 | 72 | `.` | >=20.11 |
| `@sveltex/sveltekit` | 35 | 401 | 35 | `.` | >=20.11 (peer `@sveltejs/kit`) |
| `@sveltex/database` | 6 | 1078 | 68 | `.`, `./sqlite`, `./postgres`, `./mysql`, `./migrations` | >=22.5.0 |
| `@sveltex/validation` | 1 | 62 | 8 | `.` | >=20.11 |
| `@sveltex/auth` | 2 | 208 | 29 | `.`, `./argon2` | >=20.11 |
| `@sveltex/cache` | 2 | 285 | 24 | `.`, `./redis` | >=20.11 |
| `@sveltex/session` | 2 | 355 | 32 | `.`, `./redis` | >=20.11 |
| `@sveltex/realtime` | 2 | 422 | 25 | `.`, `./in-process` | >=20.11 |
| `@sveltex/jobs` | 2 | 436 | 24 | `.`, `./in-memory` | >=20.11 |
| `@sveltex/storage` | 2 | 534 | 24 | `.`, `./local` | >=20.11 |
| `@sveltex/mail` | 2 | 430 | 26 | `.`, `./test-transport` | >=20.11 |
| `@sveltex/testing` | 3 | 419 | 32 | `.` | >=20.11 |
| `sveltex` (CLI) | 32 | 2964 | 57 | `.`, `./package.json` | >=20.11 |
| `examples/reference-app` | — | — | 18 | — | — |
| **TOTAL** | | | **488** | | |

All packages are ESM (`"type": "module"`), compile with `module: NodeNext`,
`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. `@sveltex/sveltekit` uses a
slightly relaxed config (4 of the checked strict flags) because of SvelteKit fixture code.

---

## 2. Real public exports (read from `src/index.ts`, not docs)

| Package | Exported symbols (abridged) |
|---|---|
| database | `QueryValue`, `QueryResult`, `QueryOptions`, `PoolConfig`, `DatabaseExecutor`, `DatabaseDriver`, `DatabaseState`, `Database`, `DatabaseError`, `DatabaseLifecycleError`, `DatabaseDriverError` |
| auth | `AuthUser`, `CredentialUserStore`, `PasswordHasher`, `AuthSessionPort`, `AuthAttemptLimiter`, `AuthServiceOptions`, `AuthResult`, `AuthService`, `AuthError`, `AuthConflictError`, `AuthConfigurationError` |
| cache | `CacheSetOptions`, `CacheStore`, `MemoryCacheOptions`, `MemoryCache` |
| others | contracts + one real in-process/local/memory adapter each |

**Observation:** the packages are **contract-first**. Driver/provider adapters are only shipped
for a subset. This is the single biggest gap the completion plan targets.

---

## 3. Placeholder / TODO scan

A regex scan for `TODO|FIXME|NotImplemented|stub|placeholder|not implemented` returned **5 raw
hits**, all in `@sveltex/database` and `@sveltex/mail`. Manual inspection proved **all 5 are
false positives**:

- comments that merely *contain the word* "placeholders" (SQL parameter placeholders),
- the `renderTemplate` `PLACEHOLDER` regex constant in mail.

**Conclusion:** there is **no real unfinished implementation, no stub, and no fake provider**
in the shipped source. This is a genuine strength of the current tree. However, "no stub" is
not the same as "no missing feature" — the gap list below is about features the plan requires
but which were never promised/implemented, not about broken code.

---

## 4. Per-package gap checklist (vs. the completion plan)

Legend: ✅ implemented+tested · ◐ partial · ✗ not implemented (and **not** falsely claimed).

### Phase 1 — `@sveltex/database`
| Requirement | State | Reality |
|---|:---:|---|
| Raw SQL drivers | ✅ | SQLite (`node:sqlite`), PostgreSQL (`pg.Pool`), MySQL (`mysql2` pool) — real integration tests against real servers |
| Connection lifecycle / pooling / graceful shutdown | ✅ | `PoolConfig`, pooled adapters, `Database` state machine |
| Migrations | ✅ | `MigrationRunner` — checksums, ordered prefixes, 3 dialects |
| Transactions / nested savepoints / concurrent safety | ✅ | `AsyncLocalStorage` + savepoints; PG/MySQL dedicated connections |
| **Built-in ORM integrations (Drizzle first, Prisma, MikroORM, TypeORM, Kysely)** | ✗ | none; ORMs are not even declared as optional peers |
| **BYO ORM adapter contract / registration / conformance utilities** | ✗ | none |
| Health-check API, env-based config, multiple named connections | ◐ | `connect()` does `SELECT 1`; no public health-check result, no env config helper, no multi-connection registry |
| Provider support via ORM | ✗ | only via raw drivers |

**Architecture tension (documented, not hidden):** the plan says the ORM's migration system
should stay authoritative and SvelteX should not build a competing engine. The tree already
ships a real `MigrationRunner`. Resolution: ORM adapters must **preserve native migration
systems**; `MigrationRunner` stays a driver-neutral utility and is **not** advertised as a
replacement for Drizzle Kit / Prisma Migrate / etc.

> **Phase 1 outcome (2026-11-08) — implemented, see [Phase 1 report](./phase-1-database.md).**
> The gaps above marked ✗/◐ are now closed: `defineDatabaseAdapter` + registration + capability
> validation, `createConnection`/`ConnectionManager` lifecycle, `configFromEnv`/`redactConfig`,
> shared `runAdapterConformance`, official **optional** Drizzle and Kysely adapters behind subpath
> exports, and a working BYO example are shipped with real PostgreSQL integration tests. Database
> tests rose from 68 → 116 runtime and 7 → 16 security. Prisma/MikroORM/TypeORM remain **BYO-only
> and are not advertised** as built-in. The migration tension above was resolved exactly as written:
> ORM adapters delegate to the ORM-native migrator; `MigrationRunner` is not a replacement. The main
> entry point imports no ORM.

### Phase 2 — `@sveltex/auth` (completed 2026-11-09)
| Requirement | State | Reality |
|---|:---:|---|
| Registration, login, password hashing (Argon2id) | ✅ | `AuthService` + `Argon2Hasher`, parameterized stores |
| Role self-assignment rejection, fresh-record privileged reads | ✅ | verified in reference app |
| Timing / enumeration protections, rate-limiting port | ✅ | `AuthAttemptLimiter` port + concrete `FixedWindowLimiter` (fixed-window, injectable clock) wired into `AuthService` |
| OAuth2 / OIDC | ✗ | not implemented, not advertised — explicitly out of scope for this completion plan |
| Password reset / email verification workflows | ✅ | `PasswordResetService` + `EmailVerificationService` over `TokenManager` (single-use, expiring, purpose-scoped) |
| Token expiration / revocation / session fixation | ✅ | `TokenManager` enforces expiry + single-use revocation; reset/verify tokens are subject-bound |
| RBAC / permission checks | ✅ | `RbacBuilder` / `createRbac`: deny-by-default, role inheritance, `requirePermission` (401/403) |

### Phase 3 — `@sveltex/session` (completed 2026-11-11)
| Requirement | State | Reality |
|---|:---:|---|
| Create / get / destroy / rotate / expire / revoke | ✅ | `SessionManager` + `RedisSessionStore` (Lua atomicity); `revokeAllForUser` now a first-class `SessionManager` method |
| Concurrent request safety | ✅ | tested; 8-way concurrent `createIfAbsent` yields exactly 1 winner |
| **Cookie configuration, secure defaults, CSRF integration** | ✅ | **closed**: `__Host-` frozen defaults + `SessionCookieTransport`, `CsrfProtection` (double-submit + optional HMAC binding) |
| Persistent stores | ✅ | `./redis` + **`./database` `DatabaseSessionStore`** (real SQLite/PostgreSQL/MySQL integration tests) |
| Authentication integration | ✅ | `./auth` `createAuthSessionPort`, verified with a real `AuthService` + `Argon2Hasher` |

> **Phase 3 outcome (2026-11-11):** see the [Phase 3 report](./phase-3-session.md). All four
> original gaps are closed with real implementations, real tests (real PostgreSQL 16 / MySQL 8.0 /
> Redis 7 / SQLite), security findings SEC-035 – SEC-040, and public subpath exports. No new
> package was created. Runtime 32 → 104, security 1 → 13.

### Phase 4 — `@sveltex/cache` (completed 2026-11-11)
| Requirement | State | Reality |
|---|:---:|---|
| Memory cache, Redis adapter, TTL, atomic ops | ✅ | `MemoryCache`, `RedisCache` (Lua `increment`, prefix-scoped `keys()`/`clear()`) |
| **Namespaces** | ✅ | `CacheNamespace` / `createNamespace` with `encodeURIComponent`-escaped physical key segments and scoped `clear()` |
| **Cache invalidation** | ✅ | `invalidateKeys`, `invalidatePrefix`, `invalidateMatching` |
| **Tag-based invalidation** | ✅ | `TaggedCache` + `InMemoryTagVersionSource` / `RedisTagVersionSource` (real `INCR`/`MGET`/`SCAN` generations, lazy stale deletion) |
| **Serialization safety** | ✅ | Strict `sveltex-cache:v1:` envelope; cached `undefined` encoded exactly; corrupt/legacy/unsafe payloads throw `CacheSerializationError` |
| **Error handling / graceful fallback** | ✅ | Typed `CacheError` hierarchy; `FallbackCache` with `healthy`/`degraded`/`probing`, `lastError`, observers and `probe()` |
| **Stampede protection** | ✅ | `StampedeGuard` single-flight + `computeTtlWithJitter` (process-local; distributed lock explicitly **not** claimed) |
| Real integration, no fakes | ✅ | Real Redis 7 for envelope/increment/keys/tag generations; genuinely unreachable port for fallback failure tests; 121 tests (15 security) |

> **Phase 4 outcome (2026-11-11):** see the [Phase 4 report](./phase-4-cache.md). All former
> gaps are closed with real implementations, real tests (real Redis 7), security findings
> SEC-041 – SEC-046, and six new subpath exports. No new package was created. Runtime 24 → 121,
> security 1 → 15; monorepo 637 → 734 runtime / 105 → 119 security.

### Phase 5 — `@sveltex/realtime` (completed 2026-11-11)
| Requirement | State | Reality |
|---|:---:|---|
| Typed channels, authorization, retries, shutdown | ✅ | `InProcessTransport` (unchanged, 17 pre-existing tests) |
| **WebSocket transport** | ✅ | Real `ws` gateway (`createWebSocketGateway` / `attachWebSocketGateway`) + `WebSocketClientTransport`; versioned handshake, sub/unsub/pub/pong frames, real ephemeral TCP ports |
| **SSE transport** | ✅ | Real `node:http` gateway (`createSseGateway`) + `SseClientTransport` over `fetch` streams; `/events`, `/subscribe`, `/unsubscribe`, `/publish`, `text/event-stream`, keepalive comments |
| **Heartbeats** | ✅ | `HeartbeatMonitor` (injectable clock/scheduler) + gateway ping/timeout termination on both transports |
| **Reconnection** | ✅ | Capped exponential backoff with jitter, re-subscribe and queued-publish drain; SSE `Last-Event-ID` replay (channel-filtered) |
| **Backpressure** | ✅ | `BoundedQueue` with three explicit overflow policies; `bufferedAmount` (WS) and `write()` return value + bounded pending frames (SSE) |
| **Message validation / auth** | ✅ | Strict versioned wire protocol (direction, byte bounds, envelope, no silent JSON coercion); deny-by-default gateway `authenticate` |
| Real integration, no fakes | ✅ | Real `ws` sockets + real `node:http` servers on ephemeral ports; genuinely unreachable port for reconnect/backpressure; 70 tests (50 runtime + 20 security) |

> **Phase 5 outcome (2026-11-11):** see the [Phase 5 report](./phase-5-realtime.md). All former
> gaps are closed with real implementations, real tests, security findings SEC-047 – SEC-052,
> and four new subpath exports. No new package was created. Runtime 25 → 70,
> security 8 → 20; monorepo 734 → 779 runtime / 119 → 131 security.

### Phase 6 — `@sveltex/jobs`
| Requirement | State | Reality |
|---|:---:|---|
| Queue, retries, exponential backoff, dedup, concurrency, worker shutdown | ✅ | in-memory queue |
| **Redis-backed queue, DB-backed queue, persistence** | ✗ | README: "no broker/provider adapter" |

### Phase 7 — `@sveltex/storage`
| Requirement | State | Reality |
|---|:---:|---|
| Local FS, streaming, metadata, path-traversal safety | ✅ | `./local` |
| **S3-compatible adapter, presigned URLs, content-type validation, size limits** | ✗ | README: "no S3/GCS/Azure provider adapter" |

### Phase 8 — `@sveltex/mail`
| Requirement | State | Reality |
|---|:---:|---|
| Message contract, HTML/text, templates, retries, test transport | ✅ | `./test-transport` |
| **SMTP integration, attachments, provider adapter** | ✗ | README: "no SMTP/HTTP provider" |

### Phase 9 — `@sveltex/validation` / `@sveltex/testing`
| Requirement | State | Reality |
|---|:---:|---|
| Standard Schema v1 vendor-neutral validation | ✅ | working |
| Nested schemas, array validation, request/endpoint helpers, SvelteKit integration | ◐ | contract-level; no request/endpoint helper |
| Testing: app builder, DI, request fixtures, deterministic lifecycle | ✅ | shipped |
| Testing: DB/session/job/realtime/storage/mail helpers, factories, cleanup | ◐ | partial; no per-subsystem helpers |

### Phase 10 — cross-package integration
| Requirement | State |
|---|:---:|
| Auth+Sessions+Database, Auth+Validation (reference app) | ✅ |
| Auth+Mail, Database+Jobs, Database+Cache, Storage+Auth, Realtime+Auth, Testing+* | ✗ |

### Phase 11 — production / release audit
| Requirement | State | Reality |
|---|:---:|---|
| Unit / integration / security / type tests, builds, exports | ✅ | 536/86/16, all pass (Phase 1) |
| CI with real PG/MySQL/Redis services, frozen install | ✅ | `.github/workflows/ci.yml` |
| Node/OS matrix, coverage, `npm pack` verification, clean consumer install, publishing | ✗ | not present |
| Generated app verification against **published** artifacts | ✗ | templates verified only inside monorepo |

### Phase 12 — CLI / blueprint ecosystem
| Requirement | State | Reality |
|---|:---:|---|
| 17 commands, 6 templates, ChangeSet preview/rollback, JSON, exit codes, secret redaction | ✅ | Stage 5, 57/57 tests |
| Blueprint engine (multi-file, hooks, versioning, conflict detection) | ◐ | generator framework exists, no blueprint abstraction |
| Expanded generators, template real-capability demos, consumer-side build/run | ✗ | templates are static scaffolds |

**Documented tension:** the plan says Phase 12 (CLI) comes last, but the CLI was already built
in Stage 5 and is stable/pushed. Resolution: **do not undo working code.** Phase 12 is treated
as **expansion/hardening** on top of the stable CLI (blueprint engine + richer generators +
real template capability demos), not as a from-scratch build.

---

## 5. Duplicated functionality / integration problems found

1. **"Adapter" name collision (low):** raw SQL classes are named `*Adapter`
   (`SqliteAdapter`) while the plan calls ORM integrations "adapters". Phase 1 resolves this by
   using the distinct `DatabaseAdapter`/`defineDatabaseAdapter` contract names and documenting
   both layers.
2. **Optional dependencies are absent everywhere:** no package declares `peerDependencies` or
   `peerDependenciesMeta.optional`. Adding ORM/external integrations must introduce optional
   peers so `@sveltex/database` (and others) keep a lean mandatory dependency graph.
3. **Root `engines` says `>=20.11` but database requires `>=22.5.0`:** documented, not a defect —
   the database package sets its own stricter engine. Consumers on Node 20 using only other
   packages are unaffected.
4. **Docs drift (resolved during Phase 1 doc sync):** `docs/audit/package-status.md` detailed
   `@sveltex/database` section contained stale lines (`index.ts + sqlite.ts`, `30 tests`, "real
   integration verified only for SQLite") while its summary table was current. These were
   corrected when Phase 1 landed — the section now describes the raw-SQL + ORM layers, 116/16
   tests, and real PG/MySQL/ORM integration coverage. Any remaining per-package drift is tracked
   under Phase 11.
5. **`docs/testing/verification-report.md`** historically claimed no real DB adapters; already
   marked superseded.
6. **better-sqlite3 prebuild segfaults under this Node 22.13.1 build** (symbol collision with
   built-in `node:sqlite`). Consequence for Phase 1: ORM integration tests use **real
   PostgreSQL** (`pg`, already a dependency) rather than a native SQLite module. This is a
   sandbox/tooling fact, not a repository defect.

---

## 6. Completion criteria status (honest snapshot)

| Criterion | Now |
|---|:---:|
| All packages audited | ✅ this document |
| Required functionality implemented | ◐ (Phases 0–5 done; 6–12 pending) |
| Database supports built-in ORM integrations + custom adapters | ✅ Phase 1 done (Drizzle/Kysely + BYO) |
| Public APIs / TypeScript types stable | ✅ (current surface) |
| Unit/integration/security/type tests pass | ✅ 779 / 131 / 16 (Phase 5) |
| Packages build and install independently | ◐ (frozen install works; clean consumer install not verified) |
| Cross-package scenarios work | ✗ (2 of 13) |
| Documentation matches implementation | ✅ (Phase 5 doc sync complete) |
| Generated apps build and run | ◐ (in-monorepo only) |
| Production-readiness checks pass | ✗ |

**Bottom line:** the repository is clean, honest, and fully tested for what it currently
promises. Completion-plan Phases 0–5 (audit, database ORM integrations, auth, sessions, cache,
realtime) are delivered with real implementations, real integration tests and synced documentation;
the measured gate is 779/779 runtime, 131/131 security, 16/16 type-test projects. Phases 6–12
(jobs, storage, mail, validation/testing, cross-package integration,
production/release audit, CLI/blueprint ecosystem) remain — the next action is Phase 6.
