# SvelteX Testing Status

**Last updated:** 2026-11-12

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
| `@sveltex/realtime` | 70 | 20 | ✅ | ✅ Real WS/SSE gateways on ephemeral TCP ports + in-process | All pass |
| `@sveltex/jobs` | 51 | 17 | ✅ | ✅ Real Redis 7 + SQLite + PostgreSQL 16 | All pass |
| `@sveltex/storage` | 44 | 18 | ✅ | ✅ Real MinIO S3 + local filesystem | All pass |
| `@sveltex/mail` | 70 | 19 | ✅ | ✅ Real SMTP/HTTP servers + real @sveltex/auth (24 integration tests) | All pass |
| `@sveltex/testing` | 32 | 12 | ✅ | ✅ Real core DI | All pass |
| `sveltex` (CLI) | 58 | 9 | ✅ | ✅ Real fs + recorder runner + registry consistency | All pass |
| **Total** | **871** | **160** | **16/16** | — | **All pass** |

`pnpm test` is the per-package script count summed by `pnpm -r test` (the `pnpm check` gate);
`test:security` is the standalone `pnpm test:security` chain. Both were measured on 2026-11-12
with live services: **0 failures, 0 skipped**. `npm pack --dry-run` for `@sveltex/session` → 27 files; for `@sveltex/cache` → 43 files
(10 `dist/*.js` + 10 `dist/*.d.ts` pairs), for `@sveltex/realtime` → 27 files
(6 `dist/*.js` + 6 `dist/*.d.ts` pairs), and for `@sveltex/jobs` → 35 files
(8 `dist/*.js` + 8 `dist/*.d.ts` pairs, six new subpath declarations, no src/test leakage), and for `@sveltex/storage` → 15 files (no src/test leakage), and for `@sveltex/mail` → 27 files (four new subpath declarations, no src/test leakage).

---

## Test infrastructure

> **Counting note (updated 2026-11-12, Phase 8):** `871` is the measured total of `pnpm -r test` (the `pnpm check` gate): 546 Stage 1–3 + reference app, 267 Stage 4, 58 Stage 5 CLI. `160` is the measured total of the standalone `pnpm test:security` chain (65 Stage 1–3 + 86 Stage 4 + 9 Stage 5 CLI). These are **two distinct gates, not an additive total** — Stage 4 packages, the CLI, `@sveltex/session`, `@sveltex/cache`, `@sveltex/realtime`, `@sveltex/jobs`, `@sveltex/storage` and `@sveltex/mail` include their `tests/security/*.test.mjs` files inside the package `test` script, so those security cases are also counted within 871; the separate `test:security` gate re-runs them. Phase 2 added 29 runtime + 7 security (auth 29→58 / 1→8); Phase 3 added 72 runtime + 12 security (session 32→104 / 1→13); Phase 4 added 97 runtime + 14 security (cache 24→121 / 1→15); Phase 5 added 45 runtime + 12 security (realtime 25→70 / 8→20); Phase 6 added 27 runtime + 10 security (jobs 24→51 / 7→17) plus 17 real integration tests; Phase 7 added 20 runtime + 9 security (storage 24→44 / 9→18) plus 9 real MinIO S3 integration tests; Phase 8 added 45 runtime (44 mail + 1 CLI registry consistency) + 10 security (mail 26→70 / 9→19, CLI 57→58) plus 24 real SMTP/HTTP/auth integration tests. Both gates were re-run on 2026-11-12 with live PostgreSQL 16, MySQL 8.0, Redis 7 and MinIO: exit 0, 0 failures, 0 skipped, 16 test projects (`test:types`). No carried baseline, no skipped test.

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
- Mail header injection, template XSS escaping, retry failure semantics, attachment/base64/resource caps, MIME/BCC header smuggling, SMTP credential/TLS boundary and HTTP SSRF/redirect boundary (mail — SEC-072 – SEC-081)
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
| Stage 4 realtime transport | ✅ `InProcessTransport` + Phase 5 real `ws` WebSocket / `node:http` SSE gateways | ✅ 70 tests incl. real TCP pub/sub, handshake, replay, heartbeat timeout, reconnect/resubscribe, backpressure, strict protocol |
| Stage 4 jobs queue + worker | ✅ `InMemoryJobQueue` + `RedisJobQueue` (real `ioredis` + Lua) + `SqlJobQueue` (SQLite/PostgreSQL) | ✅ 51 runtime + 17 security + 17 integration tests incl. atomic claim, retries, dead-letter, graceful shutdown, cross-process Lua atomicity, `FOR UPDATE SKIP LOCKED`, dedupe index, concurrent-safe schema |
| Stage 4 storage drivers | ✅ `LocalStorageDriver` (real filesystem I/O) + `S3StorageDriver` (AWS SDK v3, real MinIO) + SigV4 presigned URLs | ✅ 44 runtime + 18 security tests + 9 real MinIO integration tests (round-trip, streaming, list/delete, presign tamper/expiry, traversal, size limits, missing-bucket diagnostics, persistence across instances) |
| Stage 4 mail adapters | ✅ `TestTransport` (deterministic in-memory) + Phase 8 real `SmtpTransport` (nodemailer, AUTH/STARTTLS/implicit TLS) + `HttpTransport` (strict v1 JSON envelope) + MIME serializer + real `@sveltex/auth` workflows | ✅ 70 unit/security tests + 24 real SMTP/HTTP/auth integration tests (real `smtp-server`, `node:http`, `mailparser`) |
| Stage 4 testing builders | ✅ real `@sveltex/core` DI/lifecycle | ✅ 32 tests; no live external service required |
| Stage 5 CLI create/init/generate (e2e) | ✅ real filesystem `ChangeSet` + recorder runner | ✅ 58 tests incl. six templates, dry-run, rollback, hooks composition, `--no-install`, Phase 8 registry/adapter consistency |

---

## Known testing gaps

1. ~~**No PostgreSQL/MySQL integration tests**~~ — resolved: 24 integration tests run against real PostgreSQL 16 and MySQL 8.0 servers (CI provisions both). An ORM integration layer (Drizzle/Kysely + BYO) with real PostgreSQL tests was delivered in Phase 1; a cross-process migration lock, connection retry/failover, and built-in Prisma/MikroORM/TypeORM adapters remain out of scope.
2. ~~**No session database-backed store / cookie transport / CSRF**~~ — **resolved in Phase 3.** `DatabaseSessionStore` ships with real SQLite/PostgreSQL/MySQL tests; `__Host-` cookie transport, double-submit CSRF (optional HMAC binding), stale-cookie clearing, per-user revocation and an auth bridge are all shipped and tested. Remaining: SvelteKit `handle` hook wiring (Phase 10), cookie signing/encryption, O(1) Redis revocation.
3. ~~**No reference application tests**~~ — Resolved: 18 integration tests (in-process + live Redis) cover the full assembly. The Redis suite self-skips when no server is reachable; it never substitutes a fake.
4. **No `npm pack` + clean installation tests in CI** — Local verification done, CI not configured.
5. **No cross-platform CI** — Current CI runs `pnpm check` only, no OS matrix.
6. **No durable/distributed provider adapters** — Phase 5 shipped real WebSocket (`ws`) and SSE (`node:http` + `fetch`) gateways for `@sveltex/realtime` (single-process fan-out). Phase 6 shipped real `RedisJobQueue` (`ioredis` + Lua) and `SqlJobQueue` (SQLite/PostgreSQL) for `@sveltex/jobs`, verified against live Redis 7 and PostgreSQL 16. A cross-instance realtime broker (Redis pub/sub / NATS) is still not shipped. Real SMTP (nodemailer) and HTTP (strict v1 JSON envelope) mail adapters shipped in Phase 8, verified against real SMTP/HTTP servers and real `@sveltex/auth` workflows (24 integration tests); the S3-compatible object-store adapter shipped in Phase 7 (verified against real MinIO). Each README documents limitations explicitly; no untested provider is advertised.
7. **No published-registry consumer install test for the CLI** — generated manifests, config, hooks, and all six templates were verified (zero unrendered placeholders), but a full `install → typecheck → build` of a generated app against published `@sveltex/*` packages requires a registry publish and remains a CI task. This is explicitly not claimed as passing.

---

## CI pipeline status

Current `.github/workflows/ci.yml`:

```yaml
# Runs: pnpm install && pnpm check && pnpm test:security && pnpm test:types
#        + real DB/Redis/MinIO/SMTP/HTTP integration gates (jobs, storage, mail)
# Missing: OS matrix, Node version matrix, npm pack verification, fixture build step
```

### Required CI improvements

1. Add Node.js version matrix (18.x, 20.x, 22.x).
2. Add OS matrix (ubuntu-latest, windows-latest, macos-latest).
3. Add separate fixture build/typecheck job.
4. Add `npm pack` + clean consumer installation verification.
5. Add coverage reporting with thresholds.
6. Ensure failures are visible and meaningful.
