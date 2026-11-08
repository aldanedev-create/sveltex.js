# Phase 1 — Database completion report

**Date:** 2026-11-08
**Plan:** [Existing Package Completion Plan](../completion-plan.md) · **Audit:** [Phase 0](./phase-0-audit.md)
**Package:** `@sveltex/database`
**Status:** implemented, tested against real services, documented. Phase 1 done; Phases 2–12 remain.

---

## Objective (from the plan)

> Build a unified database integration layer that provides built-in ORM integrations while allowing
> developers to bring their own ORM. SvelteX should not become another ORM.

**Core rule honoured:** no new packages were created. Work extended the existing
`@sveltex/database` package only. Every claimed capability has a real implementation and a real
test; nothing is advertised that is not shipped.

---

## Architecture decisions

| Decision | Rationale |
| --- | --- |
| **Two complementary layers** | The existing raw-SQL `Database`/`DatabaseDriver` layer stays intact. A new ORM integration layer (`contracts`/`core`/`testing`/`adapters`) is additive. No existing behaviour was removed or broken. |
| **Optional peers + subpath exports** | `drizzle-orm` and `kysely` are `peerDependencies` marked optional. The main entry imports neither. Each built-in adapter lives behind its own subpath and is loaded — and requires its peer — only when imported. Verified: with both ORMs removed, the main/contracts/core/testing entry points still load; the drizzle subpath correctly reports `ERR_MODULE_NOT_FOUND`. |
| **Native API preservation** | `DatabaseAdapterContext.client` is the untouched ORM object. `connection.native()` / `tx.client` expose it in and out of transactions. SvelteX provides lifecycle, not a wrapper/DSL. |
| **ORM migrations stay authoritative** | Built-in adapters accept an optional `migrate()` hook that delegates to the ORM's native migrator. The existing `MigrationRunner` remains a driver-neutral raw-SQL utility and is **not** advertised as a competing ORM migration engine. (This resolves the plan/repo tension noted in Phase 0.) |
| **Real PostgreSQL for ORM tests** | `better-sqlite3` segfaults under this sandbox's Node 22.13.1 (symbol collision with built-in `node:sqlite`). ORM integration tests therefore use the already-shipped `pg` driver against a real PostgreSQL 16 server — production-relevant and no native module. The raw-SQL SQLite layer uses built-in `node:sqlite`. |
| **BYO ORM is first-class** | `defineDatabaseAdapter` + a shared `runAdapterConformance` suite mean custom adapters get exactly the same validation as official ones. |
| **No fake capability support** | Declaring a capability without an implementation is rejected at definition time (`validateAdapterDefinition`); undeclared capabilities cannot be invoked. |

---

## Delivered

### 1.1 Database foundation · `src/core`
- `configFromEnv`, `connectionStringFromEnv`, `redactConfig` — passive, log-safe environment config.
- `AdapterRegistry` — named registration, duplicate detection, capability discovery (`matching()`).
- `createConnection` — state machine (`idle/connecting/connected/closing/closed/failed`), idempotent
  & concurrent-safe connect, draining close, redacted `HealthCheckReport`, transactions with
  `AbortSignal`, `native()`/`context()`/`info()`.
- `ConnectionManager` — multiple named connections, `connectAll()`, `healthCheckAll()`,
  `closeAll()` graceful shutdown (all closed even if one fails; errors aggregated).

### 1.2 Built-in ORM integrations · `src/adapters`
- `createDrizzleAdapter` (`@sveltex/database/adapters/drizzle`) — first priority.
- `createKyselyAdapter` (`@sveltex/database/adapters/kysely`) — type-safe query builder.
- Each: lazy `create(config)`, default `SELECT 1` health probe, native transaction wrapper exposing
  `tx.client`, default resource cleanup (`pool.end()` / `db.destroy()`), optional `migrate` delegate.
- **Not shipped:** Prisma, MikroORM, TypeORM adapters (plan: "Second"/"Subsequent"). They are
  supported through BYO ORM and are explicitly **not** advertised as built-in.

### 1.3 BYO ORM · `src/contracts`
- `defineDatabaseAdapter`, `defineAdapterContext`, `validateAdapterDefinition`,
  `DEFAULT_ADAPTER_CAPABILITIES`, `DatabaseAdapterCapabilities`, `MigrationRequest`/`MigrationStatus`.
- Errors: `DatabaseAdapterError`, `AdapterTransactionError`, `UnsupportedCapabilityError` with stable
  codes.
- Working example: `packages/database/examples/custom-orm-adapter.mjs` (raw `pg.Pool`, no ORM) —
  runnable and exercised by tests.

### 1.4 / 1.5 / 1.6 Migrations, providers, reliability
- `migrate()` delegation keeps the ORM's migration system authoritative.
- Providers for ORM integrations: PostgreSQL (tested). SQLite/MySQL remain covered by the raw-SQL
  adapters (`node:sqlite`, `mysql2`); ORM-side SQLite/MySQL drivers are user-configurable via
  `create()` and are not separately claimed.
- Transactions: real commit/rollback verified; application errors preserved; driver errors wrapped;
  aborted signals rejected; active operations drained on close; failed connect enters `failed` state.

### 1.7 Testing · `src/testing` + `tests/`
- `runAdapterConformance(factory)` — shared suite (definition validity, capability consistency,
  connect idempotency, health, transaction + error propagation, native access, draining shutdown,
  post-close rejection, secret redaction).
- New test suites: `tests/contracts`, `tests/core`, `tests/testing`, `tests/adapters`,
  `tests/security/adapter-security.test.mjs`, plus expanded `tests/types/public-api.test.ts`.
- Real PostgreSQL integration tests for Drizzle, Kysely, and the BYO custom adapter.
- Security tests: forged-capability rejection, injection-shaped names, connection-string redaction,
  undeclared-capability enforcement, config redaction.

---

## Verification (measured, not claimed)

| Check | Result |
| --- | --- |
| `pnpm --filter @sveltex/database test` | **116/116** runtime tests, 0 fail, 0 skipped (was 68) |
| `pnpm --filter @sveltex/database test:security` | **16/16** security tests (was 7) |
| Type tests (`tsc -p tests/types/tsconfig.json`) | pass |
| Real Drizzle transaction commit + rollback on PostgreSQL | pass |
| Real Kysely transaction commit + rollback on PostgreSQL | pass |
| Real BYO adapter conformance + rollback on PostgreSQL | pass |
| `examples/custom-orm-adapter.mjs` standalone run | `{"healthy":true,"transactionResult":2,"native":"function"}` |
| Optional-dependency isolation (ORMs hidden) | main/contracts/core/testing load; drizzle subpath requires its peer |
| `npm pack --dry-run` | all new subpath `.js`/`.d.ts` present; main entry ORM-free |
| `pnpm install --frozen-lockfile --offline` | lockfile up to date, clean |

Full-monorepo verification after Phase 1: `pnpm check` = **536/536 runtime tests**
(0 failures, 0 skipped, 16 packages) and `pnpm test:security` = **86/86** (0 failures,
0 skipped), recorded in [`docs/audit/testing-status.md`](../audit/testing-status.md).
Security findings SEC-031 – SEC-034 cover the new ORM adapter layer.

---

## Not claimed / still open (honesty)

- **Prisma / MikroORM / TypeORM built-in adapters** — BYO only. Adding them is a subsequent batch
  per the plan's own priority ordering, and each would require real integration tests before being
  advertised.
- **ORM-side SQLite/MySQL adapters** are configurable via `create()` but only PostgreSQL has
  dedicated ORM integration tests. No untested provider support is claimed.
- **Unified ORM migration CLI** — intentionally deferred; the ORM's own migrator stays authoritative.
- **Savepoints** declared `false` for built-in ORM adapters (single-level transactions); nested
  behaviour remains ORM-specific.
- `pg`/`mysql2` remain regular dependencies of the raw-SQL layer.

---

## File map

```
packages/database/
├── src/
│   ├── contracts/{adapter,connection,transaction,index}.ts   # BYO contract
│   ├── core/{config,registry,lifecycle,index}.ts             # foundation
│   ├── testing/{conformance,index}.ts                        # shared conformance
│   ├── adapters/{drizzle,kysely}.ts                          # optional, subpath-only
│   └── index.ts                                             # re-exports contracts/core/testing
├── tests/{contracts,core,testing,adapters,security}/…        # new suites
├── examples/custom-orm-adapter.mjs                          # working BYO example
├── package.json                                             # subpath exports + optional peers
├── README.md · CHANGELOG.md
```
