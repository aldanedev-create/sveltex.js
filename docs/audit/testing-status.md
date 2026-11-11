# SvelteX Testing Status

**Last updated:** 2026-11-11  
**Verification environment:** Node 22.13.1, pnpm 10.20.0, TypeScript 5.9.3

---

## Current test results

| Package | `pnpm test` | `test:security` | Type tests | Real integration | Status |
| --- | ---: | ---: | --- | --- | --- |
| `@sveltex/core` | 72 | 5 | ✅ | ✅ | All pass |
| `@sveltex/shared` | 6 | 1 | ✅ | — | All pass |
| `@sveltex/config` | 8 | 1 | ✅ | — | All pass |
| `@sveltex/sveltekit` | 35 | 5 | ✅ | ✅ fixture | All pass |
| `@sveltex/database` | 116 | 16 | ✅ | ✅ SQLite + real PG/MySQL + real Drizzle/Kysely PG | All pass |
| `@sveltex/validation` | 8 | 1 | ✅ | — | All pass |
| `@sveltex/auth` | 58 | 8 | ✅ | ✅ Argon2id | All pass |
| `@sveltex/cache` | 121 | 15 | ✅ | ✅ Redis (real) + unreachable-port fallback | All pass |
| `@sveltex/session` | 104 | 13 | ✅ | ✅ SQLite + real PG/MySQL/Redis + real AuthService | All pass |
| `@sveltex/example-reference-app` | 18 | — | ✅ | ✅ Memory + Redis | All pass |
| `@sveltex/realtime` | 25 | 8 | ✅ | ✅ In-process transport | All pass |
| `@sveltex/jobs` | 24 | 7 | ✅ | ✅ In-memory queue | All pass |
| `@sveltex/storage` | 24 | 9 | ✅ | ✅ Real filesystem I/O | All pass |
| `@sveltex/mail` | 26 | 9 | ✅ | ✅ Test transport | All pass |
| `@sveltex/testing` | 32 | 12 | ✅ | ✅ Real core DI | All pass |
| `sveltex` (CLI) | 57 | 9 | ✅ | ✅ Real fs + recorder runner | All pass |
| **Total** | **734** | **119** | **16/16** | — | **All pass** |

`pnpm test` is the per-package script count summed by `pnpm -r test` (the `pnpm check` gate);
`test:security` is the standalone `pnpm test:security` chain. Both were measured on 2026-11-11
with live services: **0 failures, 0 skipped**. `npm pack --dry-run` for `@sveltex/session` → 27 files; for `@sveltex/cache` → 43 files
(10 `dist/*.js` + 10 `dist/*.d.ts` pairs, no src/test leakage).

---

## Test infrastructure

> **Counting note (updated 2026-11-11, Phase 4):** `734` is the measured total of `pnpm -r test` (the `pnpm check` gate): 546 Stage 1–3 + reference app, 131 Stage 4, 57 Stage 5 CLI. `119` is the measured total of the standalone `pnpm test:security` chain (65 Stage 1–3 + 45 Stage 4 + 9 Stage 5 CLI). These are **two distinct gates, not an additive total** — Stage 4 packages, the CLI, `@sveltex/session` and now `@sveltex/cache` include their `tests/security/*.test.mjs` files inside the package `test` script, so those security cases are also counted within 734; the separate `test:security` gate re-runs them. Phase 2 added 29 runtime + 7 security (auth 29→58 / 1→8); Phase 3 added 72 runtime + 12 security (session 32→104 / 1→13); Phase 4 added 97 runtime + 14 security (cache 24→121 / 1→15). Both gates were re-run on 2026-11-11 with live PostgreSQL 16, MySQL 8.0 and Redis 7: exit 0, 0 failures, 0 skipped, 16 test projects (`test:types`). No carried baseline, no skipped test.

### Runner

All packages use `node --test` (Node.js built-in test runner) with `node --import tsx/esm` for TypeScript execution. No external test framework dependency required.

### Test scripts

| Script | Scope | Command |
| --- | --- | --- |
| `test` | Package unit tests | `node --import tsx/esm --test tests/**/*.test.ts` |
| `test:security` | Cross-package security tests | `pnpm -r --parallel test:security` |
| `test:types` | Public API type tests | `pnpm -r --parallel test:types` |
| `typecheck` | TypeScript strict check | `tsc --noEmit` |
| `check` | Full pipeline | `pnpm -r build && pnpm -r typecheck && pnpm test:types && pnpm test:security && pnpm -r test` |

---

## Coverage by test category

### Unit tests

All packages have comprehensive unit tests covering:
- Public API functions and classes
- Error handling and error types
- Input validation
- State transitions
- Configuration and defaults

### Security tests

Each package has a dedicated `tests/security/` directory testing:
- Prototype pollution (shared, core)
- SQL injection (database)
- Credential exposure (auth)
- Timing attack mitigation (auth)
- Session fixation, secure cookie defaults, Set-Cookie injection, CSRF forgery/mismatch, `__proto__` cookie pollution, stale-cookie clearing, concurrent CAS conflicts (session)
- Cache key manipulation (cache)
- Config tampering (config, core)
- Request isolation (sveltekit)
- Realtime authorization, duplicate delivery, and payload freezing (realtime)
- Job claim atomicity, retries, dead-lettering, and graceful shutdown (jobs)
- Storage key traversal, hashed filenames, atomic writes, and symlink rejection (storage)
- Mail header injection, template XSS escaping, and retry failure semantics (mail)
- Core-contract enforcement, guaranteed cleanup, and frozen fake snapshots (testing)
- CLI path traversal, shell/option injection, static config inspection + secret redaction, dry-run, overwrite protection, rollback, and `ChangeSet` atomicity (CLI)

### Type tests

Each package has `tests/types/public-api.test.ts` verifying:
- Public exports are accessible
- Generic type parameters work correctly
- Invalid configurations are rejected by types
- Consumer usage patterns type-check

### Stress tests

`@sveltex/core` and `@sveltex/sveltekit` have dedicated stress tests:
- Core: 1000+ concurrent provider resolutions, module initialization ordering
- SvelteKit: 100+ concurrent requests, request isolation under load

### Integration tests

| Area | Real provider | Status |
| --- | --- | --- |
| SvelteKit fixture build | ✅ Real SvelteKit app | ✅ Passes |
| SvelteKit fixture typecheck | ✅ svelte-check | ✅ Passes |
| Database queries | ✅ `node:sqlite` (SQLite) | ✅ 14 integration tests pass |
| Database pooled adapters | ✅ real PG 16 / MySQL 8.0 servers | ✅ 24 integration tests pass (CRUD, injection, rollback, savepoints, concurrency, migrations) |
| Database ORM integrations | ✅ real PG 16 server (`pg`) | ✅ Drizzle + Kysely + BYO custom adapter integration tests pass (commit/rollback, conformance, native client) |
| Auth password hashing | ✅ `@node-rs/argon2` (Argon2id) | ✅ 13 integration tests pass |
| Cache distributed | ✅ `ioredis` (Redis 7) | ✅ 17 integration tests pass |
| Session shared store | ✅ `ioredis` (Redis 7) + Lua atomic scripts | ✅ 20 integration tests pass |
| Session persistent SQL store | ✅ `node:sqlite`, real PostgreSQL 16, real MySQL 8.0 | ✅ 17 tests incl. full lifecycle, concurrency, `$n`/`?` dialects, `FROM DUAL` |
| Session cookie transport + CSRF | ✅ `__Host-` cookies, `CsrfProtection`, stale-cookie clearing | ✅ 34 tests + 12 security cases |
| Session ↔ auth bridge | ✅ real `AuthService` + `Argon2Hasher` | ✅ register → login → rotate → revoke → logout |
| Stage 3 reference app (in-process) | ✅ `node:sqlite` + `@node-rs/argon2` + Memory stores | ✅ 16 integration tests pass |
| Stage 3 reference app (distributed) | ✅ live Redis for BOTH session + cache | ✅ 2 integration tests pass (survive app restart; atomic sharing across concurrent instances) |
| Stage 4 realtime transport | ✅ `InProcessTransport` (real process-local pub/sub) | ✅ 25 tests incl. duplicate-delivery, per-subscriber authorization, frozen payloads |
| Stage 4 jobs queue + worker | ✅ `InMemoryJobQueue` (real in-memory queue) | ✅ 24 tests incl. atomic claim, retries, dead-letter, graceful shutdown |
| Stage 4 local storage driver | ✅ `LocalStorageDriver` (real filesystem I/O) | ✅ 24 tests incl. persistence, path traversal, atomic writes, streaming |
| Stage 4 mail test transport | ✅ `TestTransport` (deterministic in-memory) | ✅ 26 tests incl. retries, header injection, HTML escaping |
| Stage 4 testing builders | ✅ real `@sveltex/core` DI/lifecycle | ✅ 32 tests; no live external service required |
| Stage 5 CLI create/init/generate (e2e) | ✅ real filesystem `ChangeSet` + recorder runner | ✅ 57 tests incl. six templates, dry-run, rollback, hooks composition, `--no-install` |

---

## Known testing gaps

1. ~~**No PostgreSQL/MySQL integration tests**~~ — resolved: 24 integration tests run against real PostgreSQL 16 and MySQL 8.0 servers (CI provisions both). An ORM integration layer (Drizzle/Kysely + BYO) with real PostgreSQL tests was delivered in Phase 1; a cross-process migration lock, connection retry/failover, and built-in Prisma/MikroORM/TypeORM adapters remain out of scope.
2. ~~**No session database-backed store / cookie transport / CSRF**~~ — **resolved in Phase 3.** `DatabaseSessionStore` ships with real SQLite/PostgreSQL/MySQL tests; `__Host-` cookie transport, double-submit CSRF (optional HMAC binding), stale-cookie clearing, per-user revocation and an auth bridge are all shipped and tested. Remaining: SvelteKit `handle` hook wiring (Phase 10), cookie signing/encryption, O(1) Redis revocation.
3. ~~**No reference application tests**~~ — Resolved: 18 integration tests (in-process + live Redis) cover the full assembly. The Redis suite self-skips when no server is reachable; it never substitutes a fake.
4. **No `npm pack` + clean installation tests in CI** — Local verification done, CI not configured.
5. **No cross-platform CI** — Current CI runs `pnpm check` only, no OS matrix.
6. **No external Stage 4 provider adapters** — WebSocket/SSE, a durable/distributed job broker, S3/object storage, and SMTP/HTTP mail adapters are not shipped. Each README documents the process-local limitation; no untested provider is advertised.
7. **No published-registry consumer install test for the CLI** — generated manifests, config, hooks, and all six templates were verified (zero unrendered placeholders), but a full `install → typecheck → build` of a generated app against published `@sveltex/*` packages requires a registry publish and remains a CI task. This is explicitly not claimed as passing.

---

## CI pipeline status

Current `.github/workflows/ci.yml`:

```yaml
# Runs: pnpm install && pnpm check
# Missing: OS matrix, Node version matrix, npm pack verification, fixture build step
```

### Required CI improvements

1. Add Node.js version matrix (18.x, 20.x, 22.x).
2. Add OS matrix (ubuntu-latest, windows-latest, macos-latest).
3. Add separate fixture build/typecheck job.
4. Add `npm pack` + clean consumer installation verification.
5. Add coverage reporting with thresholds.
6. Ensure failures are visible and meaningful.
