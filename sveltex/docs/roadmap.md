# SvelteX Roadmap

SvelteX is developed in five stages. The CLI is the final stage, even though it will be the main onboarding tool developers can choose to install first. The existing Core and SvelteKit adapter are retained and improved; they are not rebuilt.

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

**Remaining before Stage 4:** run the complete pnpm workspace pipeline and actual SvelteKit fixture build in CI; add and verify real provider adapters separately; build a reference app that demonstrates persistence, validation, authentication, authorization, and sessions. These packages are not declared production-certified merely because the contract tests pass.

## Stage 4 — Advanced capabilities

- `@sveltex/realtime`
- `@sveltex/jobs`
- `@sveltex/storage`
- `@sveltex/mail`
- `@sveltex/testing`

**Responsibilities:** realtime transports, durable job/worker contracts, object storage, email providers, and test application/fake adapter helpers.

**Current state:** not started. Do not begin until Stage 1–3 contracts and the SvelteKit fixture pass the full CI pipeline.

**Exit:** provider boundaries, retries, cleanup, failure behavior, authorization, and test doubles are verified.

## Stage 5 — Developer experience (build last)

- `sveltex` CLI
- Project generators
- Templates
- Interactive setup
- Diagnostics
- Upgrade tooling

The CLI is implemented only after the package APIs and integration metadata are stable. It should be the best first experience for creating a SvelteX application, but it must orchestrate the framework rather than contain framework logic.

**Exit:** generated projects install, type-check, run, test, and build on supported operating systems and package managers. File changes are previewable and non-destructive.

## Cross-stage quality requirements

Every package needs strict TypeScript checks, unit/integration/type tests, failure and cleanup tests, documented public APIs, changelog, and tested package exports. A directory or compiling stub does not count as a completed package.

See [the complete product and package specification](./specification.md) for package boundaries, CLI behavior, starter-page requirements, safety rules, and detailed acceptance criteria.
