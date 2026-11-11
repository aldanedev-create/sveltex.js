# Phase 3 — Sessions completion report

**Date:** 2026-11-11
**Plan:** [Existing Package Completion Plan](../completion-plan.md) · **Audit:** [Phase 0](./phase-0-audit.md)
**Package:** `@sveltex/session`
**Status:** implemented, tested against real SQLite / PostgreSQL / MySQL / Redis, documented. Phase 3 done; Phases 4–12 remain (historical status at the time of writing — Phase 4 has since been delivered; see the [Phase 4 report](./phase-4-cache.md)).

---

## Objective (from the plan)

> Provide secure session management integrated with SvelteKit: creation, retrieval, destruction,
> rotation, expiration, revocation, cookie configuration with secure defaults, CSRF protection,
> persistent session stores, concurrent-request safety, session storage adapters, and
> authentication integration.

**Core rule honoured:** no new package was created. Work extended the existing
`@sveltex/session` package only. Every claimed capability has a real implementation and a real
test; nothing is advertised that is not shipped.

---

## What was already present (verified in Phase 0)

- `SessionManager` — `create` / `get` / `update` / `rotate` / `destroy` / `touch`, revision-based
  compare-and-set, collision-retry id generation, URL-safe id validation, deeply cloned/frozen
  data, expiry purging, injected clock.
- `MemorySessionStore` — in-memory `SessionStore` for tests and single-process development.
- `RedisSessionStore` (`@sveltex/session/redis`) — real `ioredis` store whose
  `createIfAbsent` / `compareAndSet` / `rotate` are server-side **Lua `EVAL` scripts** (true
  cross-process atomicity), prefix-scoped `clear()` (never `FLUSHDB`).
- `SessionStore` / `SessionRecord` / `SessionConflictError` contracts.

**Phase 0 gaps:** cookie transport / secure cookie defaults, CSRF protection, persistent
(database-backed) store, authentication integration, first-class revocation, and tests for
cookie security, CSRF, store failures and shutdown.

---

## What Phase 3 added

| Capability | Module | Exports |
| --- | --- | --- |
| Secure cookie defaults + transport | `cookie.ts` | `SessionCookieOptions`, `SessionCookieConfig`, `resolveSessionCookieOptions`, `serializeSetCookie`, `parseCookieHeader`, `SessionCookieTransport`, `CookieJar`, `SessionCookieError`, `DEFAULT_SESSION_COOKIE_OPTIONS` |
| CSRF protection | `csrf.ts` | `CsrfProtection`, `serializeCsrfCookie`, `constantTimeEqual`, `CsrfError`, `CSRF_*` constants |
| Persistent SQL store | `database.ts` | `DatabaseSessionStore`, `SessionSqlExecutor`, `SessionDatabaseDialect`, `DatabaseSessionStoreOptions` |
| Auth integration + revocation | `auth.ts` | `createAuthSessionPort`, `supportsRevocation`, `revokeAllForUser`, `AuthSessionPortLike` |
| Revocation port (core) | `index.ts` | `RevocableSessionStore`, `SessionRevocationUnsupportedError`, `MemorySessionStore.revokeAllForUser`, `SessionManager.revokeAllForUser` |
| Redis revocation | `redis.ts` | `RedisSessionStore.revokeAllForUser` |

Subpath exports added: `/cookie`, `/csrf`, `/database`, `/auth` (alongside the existing `/redis`).

---

## Architecture decisions

| Decision | Rationale |
| --- | --- |
| **`__Host-` secure defaults** | The default session cookie is `__Host-sveltex_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and **no** `Domain`. Browsers reject `__Host-` cookies that are not Secure / not root-path / domain-scoped, so a misconfiguration fails closed. `resolveSessionCookieOptions` additionally rejects `SameSite=None` without `Secure`, `Partitioned` without `Secure`, and any CRLF/semicolon injection in names, values or paths. |
| **Framework-agnostic `CookieJar`** | SvelteKit's `event.cookies.get/set/delete` satisfies the port directly, but the transport also ships a pure `serializeSetCookie` / `parseCookieHeader` pair for raw HTTP runtimes. No hard SvelteKit dependency is introduced. |
| **Stale cookies are cleared, not trusted** | `SessionCookieTransport.read()` validates the cookie id shape, resolves it through `SessionManager` (enforcing expiry and tamper checks), and clears the cookie when the session is missing or the id is malformed — an attacker-controlled cookie cannot cause a 500 or a fabricated session. |
| **Rotation on privilege change** | `SessionCookieTransport.rotate()` and `createAuthSessionPort().rotate()` both rewrite the cookie with the new id and invalidate the old one — the session-fixation defence. |
| **Double-submit CSRF with optional HMAC binding** | Safe methods (GET/HEAD/OPTIONS/TRACE) bypass; every other method must echo a token that matches the double-submit cookie in constant time (`sha256` digest + `timingSafeEqual`). The CSRF cookie is deliberately **not** HttpOnly (JS must read it) but is `__Host-`-prefixed and `SameSite=Strict`. When a `secret` is configured, tokens are HMAC-bound to a session id, so a token injected for one session cannot protect another. |
| **Structural SQL executor port** | `DatabaseSessionStore` accepts anything with `query()` + `transaction()`, so `@sveltex/database`'s `Database` facade satisfies it without `@sveltex/session` taking a hard runtime dependency on the database package. The type test proves this assignability against the real `Database` class. |
| **Dialect-aware, single-statement atomicity** | `createIfAbsent` uses `INSERT … SELECT … WHERE NOT EXISTS` (one statement → atomic), `compareAndSet` uses `UPDATE … WHERE revision = ?`, and `rotate` uses one transaction with a conditional `DELETE … WHERE revision = ?`. `?` placeholders serve SQLite/MySQL, `$1..$n` PostgreSQL; table names are validated identifiers so no SQL can be injected. `user_id` is denormalized from `data.userId` for O(1) per-user revocation. |
| **Honest revocation** | `revokeAllForUser` is a first-class `SessionManager` method. Stores that cannot support it throw `SessionRevocationUnsupportedError` rather than silently succeeding. The Redis implementation is a namespace-scoped `SCAN` and is documented as O(N). |
| **Three real SQL dialects tested** | SQLite (`node:sqlite`, no native module), PostgreSQL 16 and MySQL 8.0 were all started and exercised end-to-end. PostgreSQL/MySQL suites skip cleanly when the service is unreachable; nothing is faked. |

---

## Delivered

### 3.1 Cookie configuration and transport — `cookie.ts`
- `resolveSessionCookieOptions(config)` — secure, frozen defaults plus strict validation of
  name (RFC 6265 token), value, path, domain, `maxAge`, `sameSite`, `secure`, `partitioned`.
- `serializeSetCookie(name, value, options)` — pure, injection-safe Set-Cookie serializer.
- `parseCookieHeader(header)` — null-prototype record, first-duplicate-wins, percent-decoding,
  `__proto__` pollution blocked.
- `SessionCookieTransport` — `create` / `read` / `write` / `clear` / `rotate` / `destroy`,
  with `Max-Age` derived from the session's remaining TTL and the same injected clock for
  manager and transport.

### 3.2 CSRF protection — `csrf.ts`
- `CsrfProtection.issue(sessionId?)` → `{ value, cookie }`; `verify`, `assertValid`,
  `assertValidRequest`, `isSafeMethod`.
- `constantTimeEqual` (fixed-length digest compare), `serializeCsrfCookie`.
- Stable `CsrfError` codes: `CSRF_TOKEN_MISSING`, `CSRF_COOKIE_MISSING`,
  `CSRF_TOKEN_MISMATCH`, `CSRF_TOKEN_INVALID`, `CSRF_CONFIG`, `CSRF_REQUEST_INVALID`.

### 3.3 Persistent SQL store — `database.ts`
- `DatabaseSessionStore implements SessionStore` over a `SessionSqlExecutor`.
- `ensureSchema()` (memoized) + `schemaStatements()` (portable DDL for migrations).
- `get` (expiry/corrupt purge), `createIfAbsent`, `compareAndSet`, `delete`, `rotate`
  (transactional), `revokeAllForUser`, `purgeExpired`.
- `SessionDatabaseDialect`: `sqlite` / `postgres` / `mysql`.

### 3.4 Authentication integration + revocation — `auth.ts`, `index.ts`, `redis.ts`
- `createAuthSessionPort(manager)` — bridges `SessionManager` to `@sveltex/auth`'s
  `AuthSessionPort` (proven assignable in the type test): `create` stores `userId`,
  `destroy` logs out, `rotate` prevents fixation.
- `RevocableSessionStore` port, `SessionManager.revokeAllForUser`, `MemorySessionStore`,
  `RedisSessionStore` and `DatabaseSessionStore` implementations.
- Verified end-to-end with a **real `AuthService` + `Argon2Hasher`** (register → login →
  rotate → revoke-all → logout).

### 3.5 Tests
- `tests/cookie.test.mjs` (18), `tests/csrf.test.mjs` (16), `tests/database.test.mjs` (17),
  `tests/auth.test.mjs` (8), `tests/security/phase3-security.test.mjs` (12),
  `tests/types/phase3.test.ts`.
- Real integration: SQLite always; PostgreSQL / MySQL / Redis when reachable.

---

## Verification (measured, not claimed)

| Check | Result |
| --- | --- |
| `pnpm --filter @sveltex/session test` (build + runtime + security + type tests) | **104/104**, 0 failures, 0 skipped |
| Session `pnpm -r test` gate (before → after) | 32 → 104 (+72) |
| Session non-security test files `tests/*.test.mjs` (before → after) | 32 → 91 (+59: cookie 18, csrf 16, database 17, auth 8) |
| Session `pnpm test:security` gate (before → after) | 1 → 13 (+12) |
| `tsc -p tsconfig.json` / `tsc -p tests/types/tsconfig.json` | clean, strict |
| Real SQLite (`node:sqlite`) full lifecycle + concurrency + shutdown | pass |
| Real PostgreSQL 16 full lifecycle (`$n` placeholders) | pass |
| Real MySQL 8.0 full lifecycle (`?` + `FROM DUAL`) | pass |
| Real Redis 7 `revokeAllForUser` | pass (2 of 3 sessions removed) |
| Full monorepo `pnpm check` (live PG/MySQL/Redis) | **637/637** runtime, 0 failures, 0 skipped, 16 test projects |
| Full monorepo `pnpm test:security` | **105/105**, 0 failures, 0 skipped, 15 packages |
| Full monorepo `pnpm test:types` | **16/16** projects |
| Real `@sveltex/auth` `AuthService` + `Argon2Hasher` integration | pass |
| Type compatibility: `Database` → `SessionSqlExecutor`, bridge → `AuthSessionPort` | pass |
| Concurrent same-id `createIfAbsent` (8 racers) | exactly 1 winner |
| `npm pack --dry-run` (measured 2026-11-11) | **27 files**: `README.md`, `CHANGELOG.md`, `package.json` + 6 subpath `.js`/`.d.ts`/`.map` sets (`index`, `redis`, `cookie`, `csrf`, `database`, `auth`); all four new subpaths present, no `src`/`tests` leakage |

Full-monorepo totals after Phase 3 (**637/637 runtime, 105/105 security, 16/16 type-test
projects**, measured 2026-11-11 with live PostgreSQL 16 / MySQL 8.0 / Redis 7) are recorded in
[`docs/specification.md`](../specification.md) and
[`docs/audit/testing-status.md`](../audit/testing-status.md). Phase 2 → Phase 3 added 72 runtime
and 12 security tests; no test was skipped and no baseline was carried forward. Security findings
SEC-035 – SEC-040 in [`docs/audit/security-findings.md`](../audit/security-findings.md) record
the Phase 3 review.

---

## Not claimed / still open (honesty)

- **SvelteKit-specific adapter** — `CookieJar` is shaped so `event.cookies` works directly, but
  no `@sveltex/sveltekit` helper is shipped here; wiring the transport into a SvelteKit `handle`
  hook remains an application/framework integration (Phase 10).
- **Automatic CSRF/session middleware** — the primitives are provided; no framework `handle`
  hook auto-applies them. Applications must call `assertValidRequest` on state-changing routes.
- **Unbound double-submit CSRF** — without a `secret`, only token *shape* is verified;
  protection then relies on the `__Host-` prefix + `SameSite=Strict`. Configure `secret` for
  HMAC binding in hostile-origin environments. This is documented, not hidden.
- **Redis revocation is O(N)** — a namespace `SCAN`; maintain a per-user set at write time for
  very large deployments.
- **Cookie signing / encryption** — session ids are opaque random UUIDs looked up in the store;
  no signed-cookie (stateless) mode is offered.
- **Cross-process rotate isolation** — conditional SQL is atomic per statement and `rotate` runs
  in a transaction; exact guarantees under concurrent multi-writer deployments depend on the
  database's isolation level (documented, not overstated).

---

## File map

```
packages/session/
├── src/
│   ├── cookie.ts       # secure defaults, Set-Cookie, CookieJar transport (NEW)
│   ├── csrf.ts         # double-submit + HMAC CSRF (NEW)
│   ├── database.ts     # DatabaseSessionStore (NEW)
│   ├── auth.ts         # AuthSessionPort bridge + revocation helper (NEW)
│   ├── index.ts        # + RevocableSessionStore, revokeAllForUser (EXTENDED)
│   ├── redis.ts        # + revokeAllForUser (EXTENDED)
├── tests/
│   ├── cookie.test.mjs · csrf.test.mjs · database.test.mjs · auth.test.mjs
│   ├── security/phase3-security.test.mjs
│   └── types/phase3.test.ts
├── package.json        # subpath exports + dev deps for real integration tests
└── README.md · CHANGELOG.md
```
