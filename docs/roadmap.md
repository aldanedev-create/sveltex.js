# SvelteX Roadmap

SvelteX is developed in five stages. The CLI is the final stage, even though it will be the main onboarding tool developers can choose to install first. The existing Core and SvelteKit adapter are retained and improved; they are not rebuilt.

> **Status (2026-11-08): all five stages are implemented and verified.** 488 runtime tests, 77 security tests, and 16 type-test projects pass under `pnpm check`. See [`docs/specification.md`](./specification.md) for the authoritative package inventory and CLI specification, and [`docs/audit/README.md`](./audit/README.md) for the detailed status log.

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

**Stage 3 outcome:** real `SqliteAdapter` (`node:sqlite`), `Argon2Hasher` (Argon2id), `RedisCache`, and `RedisSessionStore` (atomic Lua scripts) ship with integration tests; `examples/reference-app/` demonstrates persistence, validation, authentication, authorization, sessions, and caching end-to-end (18 integration tests). PostgreSQL/MySQL adapters, migrations and pooling were delivered in the database production-hardening pass; an ORM path, cookie transport and CSRF remain optional hardening. The workspace packages are unpublished, so a clean consumer install is a CI/release task.

## Stage 4 — Advanced capabilities

- `@sveltex/realtime`
- `@sveltex/jobs`
- `@sveltex/storage`
- `@sveltex/mail`
- `@sveltex/testing`

**Responsibilities:** realtime transports, durable job/worker contracts, object storage, email providers, and test application/fake adapter helpers.

**Current state:** complete. All five packages (`@sveltex/realtime`, `@sveltex/jobs`, `@sveltex/storage`, `@sveltex/mail`, `@sveltex/testing`) ship real process-local implementations behind explicit adapter contracts, with 131 runtime + 45 security tests, public-API type tests, and READMEs documenting deployment limitations. No WebSocket/SSE, durable broker, S3, or SMTP/HTTP adapter is shipped or advertised.

**Exit:** provider boundaries, retries, cleanup, failure behavior, authorization, and test doubles are verified.

## Stage 5 — Developer experience (build last)

- `sveltex` CLI
- Project generators
- Templates
- Interactive setup
- Diagnostics
- Upgrade tooling

The CLI is implemented only after the package APIs and integration metadata are stable. It should be the best first experience for creating a SvelteX application, but it must orchestrate the framework rather than contain framework logic.

**Current state:** complete, built last. `packages/cli/` publishes `sveltex` with 17 commands, six official templates (41 `.tmpl` assets), four welcome pages, static/redacted diagnostics, integration add/remove, generators, upgrade/migration tooling, preview/dry-run/rollback safety, and stable `--json` output with exit codes `0`–`4`. 57 CLI tests pass; `npm pack --dry-run` verified. Generated apps never depend on the CLI at runtime. No external provider adapter is shipped or advertised.

**Exit status:** file changes are previewable and non-destructive; templates are tested (zero unrendered placeholders); `dev`/`build`/`preview`/`check`/`test` delegate to the project's own scripts. **Not yet claimed:** a consumer-side `install → typecheck → build` of a generated app against registry-published `@sveltex/*` packages — the workspace packages are unpublished, so this remains CI/release work.

## Cross-stage quality requirements

Every package needs strict TypeScript checks, unit/integration/type tests, failure and cleanup tests, documented public APIs, changelog, and tested package exports. A directory or compiling stub does not count as a completed package.

See [the complete product and package specification](./specification.md) for package boundaries, CLI behavior, starter-page requirements, safety rules, and detailed acceptance criteria.
