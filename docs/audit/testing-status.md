# SvelteX Testing Status

**Last updated:** 2026-11-08  
**Verification environment:** Node 22.13.1, pnpm 10.20.0, TypeScript 5.9.3

---

## Current test results

| Package | Unit | Security | Type | Stress | Integration | Total | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@sveltex/core` | 72 | 5 | ✅ | ✅ | ✅ | 77+ | All pass |
| `@sveltex/shared` | 6 | 1 | ✅ | — | — | 7 | All pass |
| `@sveltex/config` | 8 | 1 | ✅ | — | — | 9 | All pass |
| `@sveltex/sveltekit` | 35 | 5 | ✅ | ✅ | ✅ | 40+ | All pass |
| `@sveltex/database` | 30 | 1 | ✅ | — | ✅ SQLite | 31 | All pass |
| `@sveltex/validation` | 8 | 1 | ✅ | — | — | 9 | All pass |
| `@sveltex/auth` | 29 | 1 | ✅ | — | ✅ Argon2id | 30 | All pass |
| `@sveltex/cache` | 24 | 1 | ✅ | — | ✅ Redis | 25 | All pass |
| `@sveltex/session` | 32 | 1 | ✅ | — | ✅ Redis | 33 | All pass |
| `@sveltex/example-reference-app` | 18 | — | ✅ | — | ✅ Memory + Redis | 18 | All pass |
| `@sveltex/realtime` | 17 | 8 | ✅ | — | ✅ In-process transport | 25 | All pass |
| `@sveltex/jobs` | 17 | 7 | ✅ | — | ✅ In-memory queue | 24 | All pass |
| `@sveltex/storage` | 15 | 9 | ✅ | — | ✅ Real filesystem I/O | 24 | All pass |
| `@sveltex/mail` | 17 | 9 | ✅ | — | ✅ Test transport | 26 | All pass |
| `@sveltex/testing` | 20 | 12 | ✅ | — | ✅ Real core DI | 32 | All pass |
| `sveltex` (CLI) | 48 | 9 | ✅ | — | ✅ Real fs + recorder runner | 57 | All pass |
| **Total** | **450** | **71** | **16/16** | **2** | **Partial** | **521+** | **All pass** |

---

## Test infrastructure

> **Counting note (updated 2026-11-08):** `450` is the measured total of `pnpm -r test` (the `pnpm check` gate): 393 Stage 1–4 + 57 Stage 5 CLI. Stage 4 packages and the CLI include their `tests/security/*.test.mjs` files inside the package `test` script, so the CLI's 9 security cases are part of that 450; Stage 1–3 packages run security cases only through the separate `test:security` gate. `71` is the measured total of the standalone `pnpm test:security` chain (17 Stage 1–3 + 45 Stage 4 + 9 Stage 5 CLI). These are two distinct gates, not an additive total.

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
- Session fixation (session)
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
| Auth password hashing | ✅ `@node-rs/argon2` (Argon2id) | ✅ 13 integration tests pass |
| Cache distributed | ✅ `ioredis` (Redis 7) | ✅ 17 integration tests pass |
| Session shared store | ✅ `ioredis` (Redis 7) + Lua atomic scripts | ✅ 20 integration tests pass |
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

1. **No PostgreSQL/MySQL integration tests** — Only SQLite adapter implemented so far.
2. **No session database-backed store** — Redis-backed store is implemented and tested; a SQL-backed store is still pending. Cookie transport and CSRF remain out of scope for the `session` package (reference-app wiring is now delivered as an application-level concern).
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
