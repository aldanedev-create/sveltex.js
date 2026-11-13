# SvelteX Roadmap

SvelteX is developed in five stages. The CLI is the final stage, even though it will be the main onboarding tool developers can choose to install first. The existing Core and SvelteKit adapter are retained and improved; they are not rebuilt.

> **Status (2026-11-12): all five stages are implemented and verified; completion-plan Phases 0–8 delivered.** 871 runtime tests, 160 security tests, and 16 type-test projects pass with live PostgreSQL 16 / MySQL 8.0 / Redis 7 / MinIO services (0 failures, 0 skipped). See [`docs/specification.md`](./specification.md) for the authoritative package inventory and CLI specification, and [`docs/audit/README.md`](./audit/README.md) for the detailed status log.

## Stage 1 — Foundation

**Build first**

- `@sveltex/core` — existing application engine, dependency injection, modules, lifecycle, and core config primitives.
- `@sveltex/shared` — shared types, errors, and framework-neutral utilities.
- `@sveltex/config` — configuration composition, validation, and environment-independent helpers.

**Current state:** Core, Shared, and Config implementations exist. Shared/Config have data-only input guards, defensive cloning, immutable config, and focused security tests. Continue full workspace type/compatibility verification before stable releases.

**Exit:** strict builds, type tests, lifecycle/config tests, no SvelteKit runtime dependency in Core.

## Stage 2 — Framework integration

- `@sveltex/sveltekit` — existing SvelteKit integration.

**Responsibilities:** hook composition, request lifecycle, request-scoped locals/context, SSR, cleanup, error/redirect propagation, concurrency isolation.

**Current state:** package exists and its unit, security, lifecycle, and stress suites pass locally. The real SvelteKit fixture build still needs CI verification with installed workspace dependencies.

**Exit:** native SvelteKit behavior remains intact; fixture typecheck/build passes in CI; no request context leakage.

## Stage 3 — Essential backend packages

- `@sveltex/database`
- `@sveltex/validation`
- `@sveltex/auth`
- `@sveltex/cache`
- `@sveltex/session`

Each package is independently installable. Provider-specific drivers should be optional or separate packages. Core must not become coupled to a particular ORM, validator, auth provider, or cache backend.

**Current state:** all five packages now have initial implementations: Database, Validation, Auth, Cache, and Session. Their public APIs are deliberately driver/provider-neutral. Session stores require atomic create, compare-and-set update, and rotation operations; Auth requires an injected password hasher, a precomputed dummy hash, and an optional rate limiter. The in-memory cache/session stores are explicitly single-process development/test implementations.

**Stage 3 outcome:** real `SqliteAdapter` (`node:sqlite`), `Argon2Hasher` (Argon2id), `RedisCache`, and `RedisSessionStore` (atomic Lua scripts) ship with integration tests; `examples/reference-app/` demonstrates persistence, validation, authentication, authorization, sessions, and caching end-to-end (18 integration tests). PostgreSQL/MySQL adapters, migrations and pooling were delivered in the database production-hardening pass; built-in ORM integrations (Drizzle/Kysely) and BYO ORM were delivered in Phase 1. The `@sveltex/auth` completion (Phase 2) added a concrete `FixedWindowLimiter`, a `TokenManager` for single-use/expiring tokens, `PasswordResetService`, `EmailVerificationService`, and a deny-by-default `RbacBuilder`/`createRbac`; OAuth2/OIDC are explicitly out of scope. The `@sveltex/session` completion (Phase 3) delivered `__Host-` secure cookie defaults + transport, double-submit CSRF with optional HMAC binding, a persistent SQL `DatabaseSessionStore` tested against real SQLite/PostgreSQL/MySQL, per-user revocation, and an `AuthSessionPort` bridge verified with a real `AuthService` + `Argon2Hasher` — the previously deferred cookie transport and CSRF items are now shipped. SvelteKit `handle` wiring remains Phase 10. See [`Phase 3 report`](./completion/phase-3-session.md). The `@sveltex/cache` completion (Phase 4) delivered a strict versioned serialization envelope, namespaces, key/prefix/predicate/tag invalidation (tag generations backed by real Redis `INCR`/`MGET`), graceful fallback with an observable `healthy`/`degraded`/`probing` circuit breaker, and process-local single-flight plus TTL jitter — see [`Phase 4 report`](./completion/phase-4-cache.md). The `@sveltex/realtime` completion (Phase 5) delivered real WebSocket (`ws`) and SSE (`node:http` + `fetch`) gateways and client transports with a strict versioned wire protocol, deny-by-default authentication, heartbeats, capped reconnect with re-subscribe/queue drain, and bounded backpressure — see [`Phase 5 report`](./completion/phase-5-realtime.md). The `@sveltex/storage` completion (Phase 7) delivered a real S3-compatible `S3StorageDriver` (official AWS SDK v3), SigV4 presigned GET/PUT URLs with bounded TTL, S3 user-metadata integrity and 9 real MinIO integration tests — see [`Phase 7 report`](./completion/phase-7-storage.md). The workspace packages are unpublished, so a clean consumer install is a CI/release task.

## Stage 4 — Advanced capabilities

- `@sveltex/realtime`
- `@sveltex/jobs`
- `@sveltex/storage`
- `@sveltex/mail`
- `@sveltex/testing`

**Responsibilities:** realtime transports, durable job/worker contracts, object storage, email providers, and test application/fake adapter helpers.

**Current state:** complete. All five packages ship real implementations behind explicit adapter contracts, with 267 runtime + 86 security tests, public-API type tests, and READMEs documenting deployment limitations. `@sveltex/realtime` ships **real WebSocket and SSE gateways** (verified on ephemeral TCP ports) in addition to its in-process transport; `@sveltex/jobs` ships **real Redis (`ioredis` + Lua) and SQL (SQLite/PostgreSQL) durable queues** (verified against live Redis 7 / PostgreSQL 16); `@sveltex/storage` ships a **real S3-compatible adapter with SigV4 presigned URLs** (official AWS SDK v3, verified against live MinIO). `@sveltex/mail` ships **real SMTP (nodemailer) and HTTP (strict v1 JSON envelope) adapters, attachments, an RFC 5322/2045 MIME serializer and auth-workflow senders** (verified against real SMTP/HTTP servers and real `@sveltex/auth` workflows in 24 integration tests).

**Exit:** provider boundaries, retries, cleanup, failure behavior, authorization, and test doubles are verified.

## Stage 5 — Developer experience (build last)

- `sveltex` CLI
- Project generators
- Templates
- Interactive setup
- Diagnostics
- Upgrade tooling

The CLI is implemented only after the package APIs and integration metadata are stable. It should be the best first experience for creating a SvelteX application, but it must orchestrate the framework rather than contain framework logic.

**Current state:** complete, built last. `packages/cli/` publishes `sveltex` with 17 commands, six official templates (41 `.tmpl` assets), four welcome pages, static/redacted diagnostics, integration add/remove, generators, upgrade/migration tooling, preview/dry-run/rollback safety, and stable `--json` output with exit codes `0`–`4`. 58 CLI tests pass (including a Phase 8 registry/adapter consistency test); `npm pack --dry-run` verified. Generated apps never depend on the CLI at runtime. The registry advertises only real in-package adapter subpaths (SMTP/HTTP mail, S3 storage, WS/SSE realtime, Redis/SQL jobs) as self-hosted clients — no hosted/managed provider is shipped or advertised.

**Exit status:** file changes are previewable and non-destructive; templates are tested (zero unrendered placeholders); `dev`/`build`/`preview`/`check`/`test` delegate to the project's own scripts. **Not yet claimed:** a consumer-side `install → typecheck → build` of a generated app against registry-published `@sveltex/*` packages — the workspace packages are unpublished, so this remains CI/release work.

## Cross-stage quality requirements

Every package needs strict TypeScript checks, unit/integration/type tests, failure and cleanup tests, documented public APIs, changelog, and tested package exports. A directory or compiling stub does not count as a completed package.

See [the complete product and package specification](./specification.md) for package boundaries, CLI behavior, starter-page requirements, safety rules, and detailed acceptance criteria.
