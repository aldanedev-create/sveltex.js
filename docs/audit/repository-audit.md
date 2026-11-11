# SvelteX Repository Audit

**Audit date:** 2026-11-08  
**Auditor:** Senior software architect / security engineer  
**Repository:** `aldanedev-create/sveltex.js` @ `7e87fdd`  
**Tooling:** XERJ v1.0.0-rc.101 (initial index: 599 records / 199 files; final `--fresh` reindex after Stage 5: 0 junk records), pnpm 10.20.0, Node 22.13.1

---

## 1. Executive summary

SvelteX is a modular SvelteKit-native application framework with a DI container, module system, lifecycle management, and progressively built backend packages. The repository has a **solid architectural foundation** in `@sveltex/core` and `@sveltex/sveltekit`, with initial implementations for all Stage 3 packages.

However, the repository had a **P0 blocking defect** that prevented `pnpm install` from succeeding, plus fixture build/typecheck failures. These have been **fixed in this audit session**. The codebase is now in a **buildable and testable state**: **all five stages are implemented and verified** with 734 runtime tests, 119 security tests, and 16 type-test projects passing under `pnpm check` (measured after completion-plan Phase 4; the Phase 3 baseline was 637/105 and this document's original audit baseline was 536/86), with the SvelteKit fixture building successfully. The Stage 5 `sveltex` CLI was built strictly **last**, after the Stage 1–4 package APIs and templates were stable and verified.

### Critical findings (fixed)

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| AUD-001 | **P0 / Critical** | Package name inconsistency: `core`, `shared`, `config`, `cache` used `@sveltexjs/*` in package.json while all documentation, root scripts, and other packages used `@sveltex/*`. This caused `pnpm install` to fail with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. | **Fixed** — unified all packages to `@sveltex/*` |
| AUD-002 | **P1 / High** | SvelteKit fixture `app.html` missing `%sveltekit.head%` placeholder, causing `vite build` to fail. | **Fixed** — added `%sveltekit.head%` |
| AUD-003 | **P1 / High** | SvelteKit fixture used `@sveltejs/adapter-auto` which fails in CI without platform-specific packages. | **Fixed** — switched to `@sveltejs/adapter-node@^5` |
| AUD-004 | **P2 / Medium** | SvelteKit fixture `.svelte` files used `$props<T>()` generic syntax incompatible with Svelte 5, causing 2 svelte-check errors. | **Fixed** — updated to Svelte 5 `$props()` with typed destructuring |

### Remaining findings (initial audit — status updated 2026-11-07)

> The findings below were recorded at the initial audit. Sessions 2–4 resolved the Stage 3 items; the status column reflects the current verified state. See [progress.md](./progress.md) for the session log.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| AUD-005 | Medium | No real database provider adapters (PostgreSQL/MySQL/SQLite). Tests use fake drivers only. | **Fixed** — real `SqliteAdapter` (`node:sqlite`), `PostgresAdapter` (`pg.Pool`), and `MysqlAdapter` (`mysql2` pool), each with real integration tests; migrations and pooling shipped |
| AUD-006 | Medium | No real password-hashing integration. Auth tests use fake hasher. | **Fixed** — real `Argon2Hasher` (Argon2id, `@node-rs/argon2`) + 13 integration tests |
| AUD-007 | Low | In-memory cache and session stores are single-process only; no Redis/distributed adapter. | **Fixed** — real `RedisCache` (17 tests) + `RedisSessionStore` with atomic Lua scripts (20 tests) |
| AUD-008 | Low | No reference application demonstrating persistence, validation, auth, and sessions together. | **Fixed** — `examples/reference-app/`, 18 integration tests (memory + live Redis); Stage 3 exit criterion met |
| AUD-009 | Low | CI workflow only runs `pnpm check`; missing security test, stress test, and fixture build steps. | Open — CI improvement |
| AUD-010 | Info | No `CHANGELOG.md` in Stage 3 packages (database, validation, auth, cache, session). | Open — documentation |
| AUD-011 | Info | `@sveltex/config` duplicates `ConfigValidator` type also defined in `@sveltex/core` config types. | Open — minor API alignment |

---

## 2. Repository structure

```
sveltex/
├── packages/
│   ├── core/          # Stage 1 — substantial implementation (22 source files, 72 tests)
│   ├── shared/        # Stage 1 — single index.ts (67 lines), 6 tests
│   ├── config/        # Stage 1 — single index.ts (49 lines), 8 tests
│   ├── sveltekit/     # Stage 2 — substantial implementation (35 source files, 35 tests)
│   ├── database/      # Stage 3 — index.ts + sqlite.ts (real node:sqlite adapter), 30 tests
│   ├── validation/    # Stage 3 — single index.ts (63 lines), 8 tests
│   ├── auth/          # Stage 3 — index.ts + argon2.ts (real Argon2id hasher), 29 tests
│   ├── cache/         # Stage 3 — index/redis + Phase 4 envelope/namespace/invalidation/tags/fallback/stampede, 121 tests
│   ├── session/       # Stage 3 — index/redis/cookie/csrf/database/auth.ts, 104 tests
│   ├── realtime/      # Stage 4 — typed channels + InProcessTransport, 25 tests
│   ├── jobs/          # Stage 4 — InMemoryJobQueue + Worker, 24 tests
│   ├── storage/       # Stage 4 — LocalStorageDriver (real fs I/O), 24 tests
│   ├── mail/          # Stage 4 — Mailer + TestTransport, 26 tests
│   ├── testing/       # Stage 4 — builders over real core DI, 32 tests
│   └── cli/           # Stage 5 — `sveltex` CLI (17 commands, 6 templates), 57 tests
├── examples/
│   └── reference-app/ # Stage 3 — exit-criterion reference app, 18 integration tests
├── docs/              # specification, architecture, ADRs, testing docs, audit/
├── .github/workflows/ci.yml
├── package.json       # workspace root
├── pnpm-workspace.yaml  # packages/*, sveltekit fixtures, examples/*
└── turbo.json
```

**Package count:** 15 implemented packages + 1 SvelteKit fixture app + 1 reference application.  
**Runtime tests:** 734 passing (Stage 1–3 + reference app: 546; Stage 4: 131; Stage 5 CLI: 57), 119 security tests, 16 type-test projects — measured after completion-plan Phase 4 with live PostgreSQL/MySQL/Redis services.  
**Stage 4 packages** (realtime, jobs, storage, mail, testing): **delivered**. **Stage 5** (`sveltex` CLI): **delivered, built last** — 17 commands, six official templates, 57 tests, `npm pack --dry-run` verified.

---

## 3. Architecture assessment

### Dependency direction (verified)

```
@sveltex/shared  (no dependencies)
      ↑
@sveltex/config  → @sveltex/shared
@sveltex/core    (no internal dependencies)
      ↑
@sveltex/sveltekit → @sveltex/core (peerDep: @sveltejs/kit >=2)
      ↑
@sveltex/auth    → @sveltex/shared
@sveltex/session → @sveltex/shared
@sveltex/database, @sveltex/validation, @sveltex/cache (no internal deps)
@sveltex/realtime, @sveltex/jobs, @sveltex/storage, @sveltex/mail → @sveltex/shared
@sveltex/testing → @sveltex/core + @sveltex/shared
sveltex (CLI)   → @sveltex/config  (development tool only; generated apps never depend on it)
```

**No circular dependencies detected.** Dependency direction is correct and follows the specification.

### Core engine quality

The `@sveltex/core` package is the strongest part of the repository:

- **DI Container**: Async resolution, singleton/request/transient scopes, circular dependency detection with path reporting, proper disposal with in-flight factory tracking, child container cleanup.
- **Module system**: Topological ordering with cycle detection, dependency validation, module locking after startup.
- **Lifecycle management**: Startup rollback on failure (stops modules in reverse order + disposes container), aggregate errors for partial cleanup failures.
- **Configuration**: Plain-object validation, deep cloning with cycle detection, deep freeze, rejection of functions/symbols/bigints in metadata, prototype pollution protection (`__proto__`/`constructor`/`prototype` key rejection).

### SvelteKit adapter quality

The `@sveltex/sveltekit` package is well-structured:

- Request-scoped DI through `event.locals.sveltex`.
- Concurrent startup coalescing (single `start()` promise shared).
- Proper disposal in `finally` blocks.
- Hook composition with `composeHandlers` that preserves SvelteKit's native `sequence` semantics.
- Error normalization that preserves original route errors even when disposal fails.
- Shutdown draining: stops new requests, waits for in-flight, then stops Core.

### Stage 3 package quality

At the initial audit each Stage 3 package was a single-file implementation with **substantive content** (below). Sessions 2–4 added real adapters (`sqlite.ts`, `argon2.ts`, `redis.ts` in cache and session) plus the reference application; see [package-status.md](./package-status.md) for the current per-package detail. Initial assessment:

- **database**: Full lifecycle state machine (idle→connecting→ready→closing→closed→failed), operation counting with drain, transaction-scoped executor with active-flag guard, AbortSignal support, query validation (SQL length, parameter type checking), normalized frozen results.
- **validation**: Standard Schema v1 execution, issue path normalization (string/number/object key), malformed schema rejection, execution-error wrapping.
- **auth**: Credential orchestration with injected hasher (no weak default), dummy hash for timing attack mitigation, email normalization, password length limits, attempt limiter, user sanitization (strips passwordHash).
- **cache**: Bounded LRU with TTL, injected clock, expiry purge, capacity enforcement, key/TTL validation.
- **session**: Revision-based compare-and-set, atomic rotate, collision retry, URL-safe ID validation, deep-cloned data, expiry checking.

---

## 4. Implementation completeness

### Placeholder/stub search results

XERJ search for `TODO`, `FIXME`, `placeholder`, `stub`, `unimplemented` found **zero instances in source code**. All hits were in documentation discussing planned features.

### `any` usage

No `any` types found in source code. The codebase uses `unknown` and proper type guards throughout.

### Unsafe casts

Minimal and justified:
- `container.ts:87` — `new provider.useClass(...dependencies as never[])` — necessary for dynamic constructor invocation with validated dependencies.
- `database/index.ts:55` — `Object.freeze({ query: async <Row>... })` — scoped executor construction.

### Error handling

Comprehensive across all packages:
- All async operations have try/catch with normalized error wrapping.
- Cleanup runs in `finally` blocks.
- Aggregate errors collect multiple cleanup failures rather than swallowing them.
- State transitions are guarded against invalid order.

---

## 5. Security assessment

### Positive findings

- **Prototype pollution protection**: `cloneData` in `@sveltex/shared` rejects `__proto__`, `prototype`, `constructor` keys. `validateConfig` in Core checks `Object.getPrototypeOf`.
- **No secret exposure**: Auth sanitizes user objects before returning (strips `passwordHash`).
- **Timing attack mitigation**: Auth verifies dummy hash when user is absent.
- **Input validation**: All packages validate inputs (key lengths, SQL length, email format, password length, TTL ranges, ID formats).
- **No hardcoded credentials**: Auth requires injected hasher with no weak default.
- **Immutable results**: All returned objects are frozen.
- **AbortSignal support**: Database operations support cancellation.

### Areas requiring attention

- **No rate limiting in Auth by default**: The limiter is optional. Production deployments must supply one.
- **Session fixation**: Session rotation is implemented but not automatic. Applications must call `rotate()` explicitly.
- ~~**No CSRF protection**: Session package explicitly states cookie transport and CSRF are adapter responsibilities.~~ **Resolved in completion-plan Phase 3**: `__Host-` secure cookie transport and double-submit CSRF (optional HMAC binding) are now shipped with 12 dedicated security tests. See [package-status.md](./package-status.md) and the [Phase 3 report](../completion/phase-3-session.md).
- **No SQL injection vectors**: Database package never constructs SQL from user input; parameterized queries only.

---

## 6. Production readiness summary

| Package | Implemented | Tested | Integration-tested | Production-ready | Notes |
| --- | --- | --- | --- | --- | --- |
| `@sveltex/core` | Yes | Yes (72) | Yes (fixture) | **Yes** | Solid DI, lifecycle, modules |
| `@sveltex/shared` | Yes | Yes (6) | N/A | **Yes** | Utility functions, well-tested |
| `@sveltex/config` | Yes | Yes (8) | N/A | **Yes** | Config composition/validation |
| `@sveltex/sveltekit` | Yes | Yes (35) | Yes (fixture builds) | **Yes** | Request isolation, hook composition |
| `@sveltex/database` | Yes | Yes (116) | ✅ SQLite, PostgreSQL 16, MySQL 8.0 (real servers) + real ORM (Drizzle/Kysely/BYO) PG tests | **Complete** | Built-in ORM integrations + BYO shipped; cross-process migration lock, retry/failover, built-in Prisma/MikroORM/TypeORM not claimed |
| `@sveltex/validation` | Yes | Yes (8) | N/A | **Yes** | Standard Schema execution |
| `@sveltex/auth` | Yes | Yes (29) | ✅ Argon2id (real), 13 integration tests | **Partial** | Reset/verification/OAuth/policies pending |
| `@sveltex/cache` | Yes | Yes (121) | ✅ Redis (real) envelope/increment/keys/tag generations + unreachable-port fallback | **Complete (Phase 4)** | Distributed lock (single-flight is process-local), other distributed backends not shipped |
| `@sveltex/session` | Yes | Yes (104) | ✅ Redis/Lua (20) + SQLite/PG/MySQL `DatabaseSessionStore` | **Complete (Phase 3)** | SvelteKit `handle` wiring (Phase 10) |
| `@sveltex/example-reference-app` | Yes | Yes (18) | ✅ Memory + live Redis | **Stage 3 exit met** | Private verification app, not published |
| `@sveltex/realtime` | Yes | Yes (25) | ✅ `InProcessTransport` (process-local) | **Stage 4 — ready** | 8 security tests; no WebSocket/SSE adapter |
| `@sveltex/jobs` | Yes | Yes (24) | ✅ `InMemoryJobQueue` (process-local) | **Stage 4 — ready** | 7 security tests; not durable/distributed |
| `@sveltex/storage` | Yes | Yes (24) | ✅ `LocalStorageDriver` (real fs I/O) | **Stage 4 — ready** | 9 security tests; local disk only |
| `@sveltex/mail` | Yes | Yes (26) | ✅ `TestTransport` (deterministic in-memory) | **Stage 4 — ready** | 9 security tests; no SMTP/HTTP adapter |
| `@sveltex/testing` | Yes | Yes (32) | ✅ real `@sveltex/core` DI/lifecycle | **Stage 4 — ready** | 12 security tests; dev dependency only |
| `sveltex` (CLI) | Yes | Yes (57) | ✅ six templates, dry-run, init/add/remove/generate, rollback | **Stage 5 — ready** | 9 security tests; no registry lookup, no fake providers; consumer install pending publish |

---

## 7. Recommended order of work

1. **✅ Fixed (this session):** Package name unification, fixture build/typecheck fixes.
2. **CI pipeline improvement**: Add security tests, stress tests, fixture build, and `npm pack` verification to CI workflow.
3. **Stage 1 finalization**: Add CHANGELOG.md to shared/config if missing. Verify `npm pack` produces correct file lists.
4. **Stage 2 finalization**: CI verification of fixture build with installed workspace dependencies (now passing locally).
5. **✅ Stage 3 enhancement (done in sessions 2–4)**: real `SqliteAdapter` (`node:sqlite`), `Argon2Hasher` (`@node-rs/argon2`), `RedisCache` and `RedisSessionStore` (`ioredis` + Lua), each with real integration tests; plus `examples/reference-app/` wiring all five packages (18 integration tests). PostgreSQL/MySQL, migrations and pooling were delivered in the database production-hardening pass (Session 7); built-in ORM integrations (Drizzle/Kysely) and BYO ORM were delivered in the completion plan's Phase 1 (Session 8); cookie transport and CSRF were delivered in the completion plan's Phase 3 (Session 10); strict serialization, namespaces, tag/prefix/predicate invalidation, graceful fallback and stampede protection were delivered in the completion plan's Phase 4 (Session 11).
6. **✅ Stage 4 (done, session 5):** `realtime`, `jobs`, `storage`, `mail`, `testing` — all five delivered with real process-local implementations, 131 runtime + 45 security tests, type tests, READMEs documenting deployment limits, and no untested provider claims.
7. **✅ Stage 5 (done, session 6):** the `sveltex` CLI — built strictly last, after all package APIs and templates were stable and verified. 17 commands, six official templates, 57 tests, documented safety model and limitations.
