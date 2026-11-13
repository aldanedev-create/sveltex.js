# SvelteX Product and Package Specification

> **Status:** Working architecture specification  
> **Version:** 0.1.0  
> **Package policy:** Build the framework packages first. Build the `sveltex` CLI last.

This document is the central implementation contract for the SvelteX monorepo. It defines the delivery stages, package boundaries, public API expectations, quality gates, and the final CLI experience. Package-specific specifications and architecture decision records remain authoritative for their narrower subjects; changes that conflict with this document should be recorded as an ADR.

## 1. Product direction

SvelteX is an application framework built around SvelteKit. SvelteKit remains responsible for routing, rendering, endpoints, actions, and its native request lifecycle. SvelteX adds cohesive application infrastructure: application composition, dependency injection, modules, configuration, validation, persistence, authentication, caching, sessions, background work, realtime capabilities, storage, mail, and testing utilities.

SvelteX is not intended to replace SvelteKit or hide its APIs. Developers must be able to use ordinary SvelteKit routes, `load` functions, actions, endpoints, hooks, and Svelte components without adopting every SvelteX package.

### Product principles

1. **SvelteKit-native:** integrate through supported SvelteKit APIs; do not fork its routing or rendering model.
2. **Independent packages:** optional capabilities are separately installable and do not force users to install the whole framework.
3. **Framework-independent core:** core application services must not import SvelteKit, Vite, browser APIs, or provider SDKs.
4. **Explicit composition:** dependencies, lifecycle, modules, and external services are discoverable and testable.
5. **Safe defaults:** secure behavior by default; no hard-coded credentials, silent weakening, or hidden production behavior.
6. **Progressive adoption:** users can start with SvelteKit and add only the SvelteX packages they need.
7. **CLI as the entry point, not the foundation:** the CLI will be the polished first-install experience, but it is implemented only after the underlying packages and their APIs are stable.
8. **Honest compatibility:** support claims must be backed by CI against an explicit Node.js, SvelteKit, Svelte, and package-manager matrix.

## 2. Five-stage delivery plan

The stages below are the required order for implementation. Existing packages are retained; they are not recreated simply to make the stage numbering look sequential. Work in a later stage must not force premature implementation of the CLI.

### Stage 1 — Foundation

**Build first**

- `@sveltex/core` — existing package; application engine, dependency injection, modules, lifecycle, and core configuration primitives.
- `@sveltex/shared` — shared types, errors, and small framework-neutral utilities.
- `@sveltex/config` — configuration composition, validation helpers, and environment-independent configuration utilities.

**Responsibilities**

- Application construction and lifecycle state.
- Dependency injection and provider lifetimes.
- Module descriptors, registration, and dependency graph.
- Shared error and type contracts.
- Configuration definition, merging, and validation.
- No dependency on SvelteKit or a concrete database/cache/auth provider.

**Exit criteria**

- Core and shared contracts are stable enough for downstream packages.
- Dependency injection, module registration, configuration, startup rollback, and disposal are covered by tests.
- Packages build with strict TypeScript settings and publish valid ESM/type exports.
- `@sveltex/core` remains usable without installing SvelteKit.

**Current status**

- `@sveltex/core`: already exists; preserve and harden it.
- `@sveltex/shared`: initial package foundation added.
- `@sveltex/config`: initial package foundation added.

### Stage 2 — Framework integration

**Existing package**

- `@sveltex/sveltekit` — already exists; preserve and harden it.

**Responsibilities**

- SvelteKit `handle` integration and safe hook composition.
- Request lifecycle creation and disposal.
- Request-scoped dependencies exposed through `event.locals`.
- Request context isolation across concurrent requests.
- SSR integration, native route/action/endpoint compatibility, and error/redirect propagation.
- No global mutable request state.

**Exit criteria**

- Existing SvelteKit hooks can be composed without accidental replacement.
- Request-scoped providers cannot leak between requests or into singleton services.
- Cleanup runs on success and failure paths.
- A real SvelteKit fixture type-checks and builds in CI for the supported version matrix.

**Current status**

- `@sveltex/sveltekit`: already exists; do not recreate it. Continue compatibility and fixture verification.

### Stage 3 — Essential backend packages

**Build after the foundation and adapter contracts are sufficiently stable**

- `@sveltex/database`
- `@sveltex/validation`
- `@sveltex/auth`
- `@sveltex/cache`
- `@sveltex/session`

These packages must be independently installable. A developer should not need the CLI or all five packages to use one capability.

**Responsibilities and boundaries**

| Package | Responsibility | Boundary |
| --- | --- | --- |
| `@sveltex/database` | Database contracts, connection lifecycle, transactions, migration/seed integration points, and provider adapters | Core does not own SQL or a specific ORM. Database drivers are optional dependencies or separate adapter packages. |
| `@sveltex/validation` | Normalize input validation around Standard Schema-compatible contracts and typed validation errors | No mandatory schema library; adapters may be added for specific validators. |
| `@sveltex/auth` | Authentication primitives, identity/provider contracts, authorization policies, and secure server-side guards | Auth must not assume a single database, session store, OAuth provider, or UI. |
| `@sveltex/cache` | Cache contract, TTL semantics, invalidation, and optional drivers | In-memory cache is for development/single-process use; production shared cache requires a shared driver. |
| `@sveltex/session` | Session lifecycle and storage contracts | Cookie transport and framework request integration belong in adapters; production stores must support shared deployment topology. |

**Current status**

- `@sveltex/validation`: Standard Schema v1 contract complete, 8 tests passing. Vendor-neutral by design.
- `@sveltex/cache`: Bounded LRU in-memory cache and production `RedisCache` adapter (`ioredis`) complete. Completion-plan Phase 4 adds a typed `CacheError` hierarchy, a strict versioned serialization envelope (`sveltex-cache:v1:`), namespaces with escaped physical key segments, key/prefix/predicate invalidation, tag-based invalidation with a real Redis `INCR`/`MGET` generation source, graceful fallback with an observable `healthy`/`degraded`/`probing` circuit breaker, and process-local single-flight plus TTL jitter. 121 tests passing (15 security). See [Phase 4 report](./completion/phase-4-cache.md).
- `@sveltex/session`: Session lifecycle + in-memory store + production `RedisSessionStore` (ioredis + atomic Lua scripts) complete. Completion-plan Phase 3 adds secure `__Host-` cookie defaults + `SessionCookieTransport`, double-submit CSRF with optional HMAC binding, a persistent `DatabaseSessionStore` (real SQLite/PostgreSQL/MySQL), per-user revocation, and an `AuthSessionPort` bridge verified with a real `AuthService` + `Argon2Hasher`. 104 tests passing (91 runtime + 13 security). SvelteKit `handle` hook wiring remains an application/framework integration (Phase 10).
- `@sveltex/database`: Driver contract, lifecycle, transactions complete; `SqliteAdapter` (`node:sqlite`), `PostgresAdapter` (`pg.Pool`), and `MysqlAdapter` (`mysql2` pool) ship with real integration tests, `MigrationRunner`, and `PoolConfig`. An additive ORM integration layer (`defineDatabaseAdapter`, optional Drizzle/Kysely adapters, BYO ORM conformance) ships behind subpath exports. 116 tests passing (24 run against real PostgreSQL/MySQL servers). Built-in Prisma/MikroORM/TypeORM adapters are not claimed (BYO ORM only).
- `@sveltex/auth`: Registration/login/rotation and `Argon2Hasher` (Argon2id via `@node-rs/argon2`) complete. Phase 2 adds a concrete `FixedWindowLimiter` (satisfying `AuthAttemptLimiter`), a `TokenManager` for single-use/expiring/purpose-scoped tokens, `PasswordResetService`, `EmailVerificationService`, and a deny-by-default `RbacBuilder`/`createRbac`. 58 tests passing (8 security). OAuth2/OIDC remain explicitly out of scope for this completion plan.
- `examples/reference-app`: **Stage 3 exit criterion met.** A real workspace application wiring all five packages end-to-end (SQLite + Argon2id + Redis/memory cache + Redis/memory sessions + Standard Schema validation + fresh-record RBAC). 18 integration tests pass, including 2 against a live Redis instance. See [Stage 3 reference application](#stage-3-reference-application).

**Exit criteria**

- Each package has independent install/build/typecheck/test coverage. ✅
- Database transactions, validation failures, authentication boundaries, cache expiry/invalidation, and session expiry/rotation are tested. ✅
- No package silently imports an optional provider as a mandatory runtime dependency. ✅
- A reference application demonstrates persistence, validation, authentication, authorization, and sessions. ✅ `examples/reference-app/` — 18 integration tests (16 in-process + 2 real Redis).

**Stage 3 exit status (verified 2026-11-07; database hardening 2026-11-08; auth Phase 2 2026-11-09; session Phase 3 2026-11-11):** all four criteria are satisfied. PostgreSQL/MySQL adapters, migrations and pooling ship with real integration tests. Built-in ORM integrations (Drizzle/Kysely) and BYO ORM support were delivered in Phase 1; `@sveltex/auth` was completed in Phase 2 (limiter, tokens, reset/verification, RBAC); `@sveltex/session` was completed in Phase 3 (secure cookies, CSRF, SQL store, revocation, auth bridge) — the previously deferred cookie transport and CSRF items are now shipped and tested. Stages 4 and 5 therefore remain correctly ordered — the CLI stays last. Completion-plan Phase 4 later completed `@sveltex/cache` (namespaces, tags, strict serialization, fallback, single-flight) — see the [Phase 4 report](./completion/phase-4-cache.md).

### Stage 4 — Advanced capabilities

**Build after essential backend packages**

- `@sveltex/realtime`
- `@sveltex/jobs`
- `@sveltex/storage`
- `@sveltex/mail`
- `@sveltex/testing`

**Responsibilities**

| Package | Responsibility |
| --- | --- |
| `@sveltex/realtime` | Typed channels/events, authorization hooks, transport contracts, and real WebSocket/SSE gateways with client transports (strict wire protocol, heartbeats, reconnect, backpressure). |
| `@sveltex/jobs` | Job registration, scheduling, queue contracts, retries, backoff, deduplication, concurrency, worker lifecycle, and real Redis / SQL durable queues with strict persisted serialization. |
| `@sveltex/storage` | File/object storage contracts, safe upload metadata, streaming, and provider adapters. |
| `@sveltex/mail` | Email message/attachment contracts, MIME serialization, template integration, real SMTP/HTTP provider adapters, auth-workflow senders, retries, and a deterministic test transport. |
| `@sveltex/testing` | Test application builders, module/DI helpers, request fixtures, fake adapters, and deterministic lifecycle tests. |

**Exit criteria**

- External transports/providers are behind adapters. ✅
- Retries, shutdown, duplicate delivery, failure handling, and authorization are tested. ✅
- Testing helpers can exercise the real packages without requiring live external services. ✅
- Deployment limitations are documented (for example, in-process workers are not a durable distributed queue). ✅

**Stage 4 exit status (verified 2026-11-07; updated after Phase 8):** all five packages are implemented, independently installable, and covered by runtime, security, and public-API type tests (267 runtime + 86 security tests across Stage 4 after Phase 8). Each ships a real implementation behind an explicit adapter contract. Phase 5 added real WebSocket/SSE gateways to `@sveltex/realtime` (single-process fan-out, tested on real ephemeral TCP ports); Phase 7 added a real S3-compatible adapter with SigV4 presigned URLs to `@sveltex/storage` (verified against live MinIO); Phase 8 added real `SmtpTransport` (nodemailer), `HttpTransport` (strict v1 JSON envelope), an RFC 5322/2045 MIME serializer, attachments and auth-workflow senders to `@sveltex/mail` (verified against real SMTP/HTTP servers and real `@sveltex/auth` services, 24 integration tests). Only a cross-instance realtime broker remains unshipped; no fake provider is advertised.

| Package | Delivered | Explicitly not claimed |
| --- | --- | --- |
| `@sveltex/realtime` | `defineChannel`, `RealtimeHub` with a **required** `authorize` hook, per-subscriber de-duplication, frozen payloads, `InProcessTransport`; Phase 5 adds real WebSocket/SSE gateways + client transports, strict wire protocol, heartbeats, reconnect, backpressure | No cross-instance broker/persistence; gateways are single-process fan-out |
| `@sveltex/jobs` | `JobQueue` contract + `InMemoryJobQueue` (atomic claim, delayed visibility, dedupe keys, dead-letter), `Worker` with concurrency, capped exponential backoff, retries, graceful shutdown, injectable clock; Phase 6 adds `RedisJobQueue` (real `ioredis` + Lua), `SqlJobQueue` (SQLite/PostgreSQL, `FOR UPDATE SKIP LOCKED`), strict `sveltex-jobs:v1:` serialization, `JobRegistry`, `JobScheduler` | MySQL not implemented for SQL queue; no distributed lock, cron, or workflow DAG |
| `@sveltex/storage` | `Storage` facade (key/content-type/metadata/size/TTL validation) + `LocalStorageDriver` (real filesystem I/O, SHA-256 hashed filenames, key-traversal rejection, atomic temp+rename writes, metadata sidecars, Web-stream reads, symlink rejection, integrity checks) + Phase 7 `S3StorageDriver` (`./s3`, official AWS SDK v3: real Put/Get/Head/Delete/List, SigV4 presigned GET/PUT with bounded TTL, S3 user-metadata integrity, reserved-metadata and prototype-pollution hardening) — 9 real MinIO integration tests | No multipart uploads, bucket creation, versioning, object locking, SSE configuration, replication, CDN or virus scanning; presigned PUT exposes the service ETag rather than a SvelteX SHA-256 |
| `@sveltex/mail` | `MailMessage` / `MailAttachment` / `MailTransport` contracts + `Mailer` with capped exponential-backoff retries, `renderTemplate` with HTML escaping by default, CRLF/NUL/reserved-header injection rejection and aggregate attachment caps; `TestTransport` (deterministic, never sends real mail); Phase 8 adds a real RFC 5322/2045 MIME serializer, `SmtpTransport` (`./smtp`, nodemailer: AUTH/STARTTLS/implicit TLS, `verify()`, delivery metadata), `HttpTransport` (`./http`, strict `application/vnd.sveltex.mail.v1+json`, SSRF guard, no redirects), and auth-workflow senders (`./auth`) - 24 real SMTP/HTTP/auth integration tests | No hosted/managed mail provider; no DKIM/SPF signing, no delivery tracking beyond the SMTP response, no queued/bulk send |
| `@sveltex/testing` | Builders over the **real** `@sveltex/core` DI/lifecycle (`createApplication`, `defineModule`, `token`), `FakeClock`, `LifecycleRecorder`, provider helpers, `TestApplication`/`withTestApplication` with guaranteed cleanup, request fixtures, in-memory fakes | No fake DI container; fakes never touch network/disk |

Stage 5 therefore remains correctly ordered — the CLI stays last.

### Stage 5 — Developer experience

**Build last**

- `sveltex` CLI package.
- Project generators.
- Starter templates.
- Interactive setup.
- Diagnostics.
- Upgrade and migration tooling.

The CLI is intentionally last because it must consume stable package APIs and package metadata rather than inventing framework behavior. Its product role is still central: the CLI should be the easiest way for a developer to start a SvelteX project and discover compatible integrations.

**Stage 5 status (verified 2026-11-08; updated 2026-11-12 after Phase 8): implemented, built last.** The `sveltex` CLI (`packages/cli/`, published as `sveltex`) now ships 17 commands, six official templates, four welcome-page choices, static/redacted diagnostics, integration add/remove, generators, upgrade/migration tooling, preview/dry-run/rollback safety, and stable `--json` output with exit codes `0`–`4`. It was implemented only after Stages 1–4 were complete and verified. 58 CLI tests (unit, command, generator, package-manager, diagnostic, security, e2e, and public-API type, plus a Phase 8 registry/adapter consistency test) pass; `npm pack --dry-run` publishes `dist/`, `templates/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json` only. Generated apps never depend on the CLI at runtime.

**Exit criteria**

- Every official starter is generated from tested templates.
- Generated projects install, type-check, run, test, and build on supported operating systems and package managers.
- Add/remove/generate operations are safe, previewable, and non-destructive.
- Diagnostics explain problems and offer safe fixes without hiding the underlying SvelteKit commands.
- Upgrade tooling detects incompatible versions and applies explicit, reviewable migrations.

**Exit-criterion status:** starters are generated from tested `.tmpl` assets (six distinct templates, 41 files, zero unrendered placeholders); add/remove/generate are previewable and non-destructive (dry-run, `--force`/`--yes`, `ChangeSet` rollback); `doctor` reports stable codes/severities/paths/safe fixes without hiding SvelteKit; `migrate` is preview-first. `dev`/`build`/`preview`/`check`/`test` delegate to the project's own scripts rather than reimplementing Vite/SvelteKit/test-runner behavior. **Not yet claimed:** a full consumer-side `install → typecheck → build` of a generated app against registry-published `@sveltex/*` packages — the workspace packages are not published to a registry, so this remains a CI/consumer-verification task. No fake success is reported.

## 3. Monorepo package inventory

```text
packages/
├── core/          # ✅ Existing — Stage 1 — Production-ready
├── shared/        # ✅ Stage 1 — Production-ready
├── config/        # ✅ Stage 1 — Production-ready
├── sveltekit/     # ✅ Existing — Stage 2 — Production-ready
├── database/      # ✅ Stage 3 — Contract + SQLite (node:sqlite) adapter complete
├── validation/    # ✅ Stage 3 — Contract complete
├── auth/          # ✅ Stage 3 — Contract + Argon2id hasher complete
├── cache/         # ✅ Stage 3 — In-memory + Redis adapter complete
├── session/       # ✅ Stage 3 — memory + Redis (Lua) + SQL stores, secure cookies, CSRF, revocation
├── realtime/      # ✅ Stage 4 — typed channels + auth + in-process transport + Phase 5 WS/SSE gateways, 70 tests
├── jobs/          # ✅ Stage 4 — queue + retries/backoff + worker lifecycle + Phase 6 Redis/SQL durable queues, 51 tests
├── storage/       # ✅ Stage 4 — storage contract + local + S3 driver (Phase 7), presigned URLs
├── mail/          # ✅ Stage 4 — message/attachments/MIME + real SMTP/HTTP adapters (Phase 8) + test transport
├── testing/       # ✅ Stage 4 — builders over real core + deterministic fakes
└── cli/           # ✅ Stage 5 — CLI complete (built last after Stages 1–4)
examples/
└── reference-app/ # ✅ Stage 3 — exit-criterion reference app (18 tests)
```

**Implementation status as of 2026-11-08 (verified):**

| Package | Build | Typecheck | Tests | Security | Status |
| --- | --- | --- | --- | --- | --- |
| core | ✅ | ✅ | 72/72 | ✅ | Production-ready |
| shared | ✅ | ✅ | 6/6 | ✅ | Production-ready |
| config | ✅ | ✅ | 8/8 | ✅ | Production-ready |
| sveltekit | ✅ | ✅ | 35/35 | ✅ | Production-ready |
| database | ✅ | ✅ | 116/116 | ✅ | Complete — SQLite/PostgreSQL/MySQL + migrations + pooling + ORM integrations (Drizzle/Kysely + BYO) |
| validation | ✅ | ✅ | 8/8 | ✅ | Ready — Standard Schema vendor-neutral |
| auth | ✅ | ✅ | 58/58 | ✅ | Complete — Argon2id, registration/login/rotation, `FixedWindowLimiter`, `TokenManager`, password reset, email verification, deny-by-default RBAC |
| cache | ✅ | ✅ | 121/121 | ✅ 15/15 | **Complete (Phase 4)** — strict envelope, namespaces, tags, fallback, single-flight; distributed lock not claimed |
| session | ✅ | ✅ | 104/104 | ✅ 13/13 | **Complete** — secure cookies, CSRF, SQL store (SQLite/PG/MySQL), Redis, revocation, auth bridge |
| examples/reference-app | ✅ | ✅ | 18/18 | — | **Stage 3 exit criterion met** |
| realtime | ✅ | ✅ | 70/70 | ✅ 20/20 | **Complete (Phase 5)** — real WS/SSE gateways + clients, strict protocol, lifecycle; single-process fan-out |
| jobs | ✅ | ✅ | 51/51 | ✅ 17/17 | **Complete (Phase 6)** — real Redis + SQL queues, strict serialization, registry, scheduler |
| storage | ✅ | ✅ | 44/44 | ✅ 18/18 | **Complete (Phase 7)** — real S3-compatible adapter, SigV4 presigned URLs, 9 real MinIO integration tests; local driver preserved |
| mail | ✅ | ✅ | 70/70 | ✅ 19/19 | **Complete (Phase 8)** — real SMTP/HTTP adapters, attachments, MIME serializer, auth senders, `TestTransport`; 24 real integration tests |
| testing | ✅ | ✅ | 32/32 | ✅ 12/12 | **Stage 4 — ready (real core DI)** |
| cli (`sveltex`) | ✅ | ✅ | 58/58 | ✅ 9/9 | **Stage 5 — ready (built last)** — registry advertises only real in-package adapter subpaths (consistency test) |

**Total: 871/871 runtime tests passing** (Stage 1–3 + reference app: 546; Stage 4: 267; Stage 5 CLI: 58), **160/160 security tests** (Stage 1–3: 65; Stage 4: 86; Stage 5 CLI: 9), **16/16 type-test projects**. Measured 2026-11-12 with live PostgreSQL 16, MySQL 8.0, Redis 7 and MinIO services: full `pnpm check` (exit 0), `pnpm test:security` (exit 0), `pnpm test:types` (exit 0), the mail integration gate (24/24 on real SMTP/HTTP servers), and the jobs/storage integration gates re-run after Phase 8 — 0 failures, 0 skipped, no carried baseline. *Phase 2 added 29 runtime + 7 security tests (auth 29→58 / 1→8); Phase 3 added 72 runtime + 12 security tests (session 32→104 / 1→13); Phase 4 added 97 runtime + 14 security tests (cache 24→121 / 1→15); Phase 5 added 45 runtime + 12 security tests (realtime 25→70 / 8→20); Phase 6 added 27 runtime + 10 security tests (jobs 24→51 / 7→17) plus 17 real integration tests; Phase 7 added 20 runtime + 9 security tests (storage 24→44 / 9→18) plus 9 real MinIO S3 integration tests; Phase 8 added 45 runtime (44 mail + 1 CLI registry consistency) + 10 security tests (mail 26→70 / 9→19, CLI 57→58) plus 24 real SMTP/HTTP/auth integration tests. Every new capability has a real implementation and a real test.*

Each package must have its own `package.json`, source entry point, README, changelog, TypeScript configuration, and tests. A package directory is not considered implemented merely because it exists. The root workspace should build and test packages in dependency order.

## 4. Package design and release rules

### Naming and installation

- Public package names use the `@sveltex/*` scope, except the final executable CLI package, named `sveltex`.
- Users install only the capabilities they need, for example:

```sh
pnpm add @sveltex/core @sveltex/sveltekit
pnpm add @sveltex/validation @sveltex/session
```

- Packages use ESM and publish TypeScript declarations.
- Internal workspace dependencies use `workspace:*` during monorepo development and must be rewritten/resolved correctly by the chosen publish workflow.
- Keep runtime dependencies small. Provider SDKs and framework integrations must be optional or separate packages when practical.
- Do not publish a package until its README, API, changelog, exports, and compatibility claims match the implementation.

### API stability

- Keep public exports explicit through each package's `src/index.ts`.
- Avoid exposing internal implementation files as supported entry points.
- Mark experimental APIs clearly before 1.0.
- Breaking changes require migration notes and tests.
- Cross-package contracts should live in `@sveltex/shared` only when multiple packages genuinely need them; do not turn it into a dumping ground.

### Dependency direction

```text
@sveltex/shared
      ↑
@sveltex/config      @sveltex/core
                         ↑
                  @sveltex/sveltekit
                         ↑
       Stage 3 and Stage 4 packages consume stable contracts
                         ↑
              sveltex CLI (Stage 5 only)
```

The diagram expresses a dependency rule, not a requirement that every package import every package below it. Prefer narrow peer dependencies and adapter interfaces. Avoid circular package dependencies.

## 5. Stage 5 CLI product specification

### 5.1 Purpose

The `sveltex` CLI is the primary onboarding and project-management interface for SvelteX. Developers may install/use it first, but it is built after the framework packages. It coordinates the official packages; it must not contain duplicate application-engine, DI, routing, database, auth, or validation implementations.

The CLI should make common work discoverable and reliable:

- Create a new SvelteX project.
- Initialize SvelteX in an existing SvelteKit project.
- Add or remove official integrations.
- Generate conventional application files.
- Run or delegate development, build, check, and test commands.
- Inspect package versions and framework configuration.
- Diagnose common setup and compatibility problems.
- Upgrade packages and apply explicit migrations.

### 5.2 Installation and first command

The intended zero-global-install experience is:

```sh
pnpm dlx sveltex create my-app
```

Equivalent execution through `npm exec`, `npx`, Yarn, and Bun should be supported after tested compatibility is established. Global installation is optional, not required.

The CLI is a development tool. Generated applications should not require the CLI at runtime or deploy it unless a project explicitly uses a CLI task during build/deployment.

### 5.3 Commands

| Command | Purpose |
| --- | --- |
| `sveltex create <name>` | Create a project from an official template. |
| `sveltex init` | Add SvelteX to an existing SvelteKit project safely. |
| `sveltex add <integration...>` | Install and configure selected official packages. |
| `sveltex remove <integration...>` | Remove selected integrations without deleting unrelated user code. |
| `sveltex generate <kind> <name>` | Generate module, service, middleware, route/API, component, or test files. |
| `sveltex dev` | Delegate to the project's SvelteKit/Vite development server. |
| `sveltex build` | Delegate to the project's build tool. |
| `sveltex preview` | Delegate to the project's preview command. |
| `sveltex check` | Run configured type and framework checks. |
| `sveltex test` | Run the project's test command. |
| `sveltex doctor` | Diagnose Node, package manager, dependencies, config, and integration health. |
| `sveltex info` | Display SvelteX and framework versions without exposing secrets. |
| `sveltex routes` | Display route information only when it can be derived reliably from SvelteKit's project structure/build metadata. |
| `sveltex modules` | Inspect registered SvelteX modules. |
| `sveltex upgrade` | Report and apply supported package upgrades. |
| `sveltex migrate` | Preview and apply a named migration. |
| `sveltex config` | Validate and inspect configuration with secret redaction. |

The CLI should delegate to native package-manager, SvelteKit, Vite, and test-runner commands wherever possible. It must not reimplement their behavior merely to provide a branded command.

### 5.4 Project creation options

Initial templates:

| Template | Purpose | Status |
| --- | --- | --- |
| `minimal` | Smallest possible SvelteKit + SvelteX application | **Shipped (Stage 5)** |
| `fullstack` | Recommended full-stack application with welcome page | **Shipped (Stage 5)** |
| `api` | API-oriented SvelteKit application | **Shipped (Stage 5)** |
| `dashboard` | Dashboard application shell with example sections | **Shipped (Stage 5)** |
| `saas` | SaaS layout/structure foundation — explicitly no billing, auth, or persistence | **Shipped (Stage 5)** |
| `documentation` | Documentation website foundation | **Shipped (Stage 5)** |

Each template must have a clear purpose, correct dependencies, working examples, and its own generation tests. Do not create all templates as superficial variations of the same empty application. Do not include fake billing or pretend payments work in the SaaS starter. Do not imply authentication or data persistence exists unless the relevant integrations are actually installed.

Expected options include:

```sh
sveltex create my-app --template fullstack
sveltex create my-app --template minimal --no-install
sveltex create my-app --template api --package-manager pnpm
sveltex create my-app --yes --no-git
```

Interactive prompts should ask only for decisions that affect the generated project. Typical prompts: template, TypeScript (default on), package manager, welcome-page choice, and optional integrations. Database/auth/cache selections should only appear when their packages and templates are ready.

### 5.5 Welcome and starter pages

The fullstack starter should include a real, editable SvelteKit welcome page at `src/routes/+page.svelte`. This is generated project source, not a terminal-only preview and not a runtime dependency on the CLI.

The default welcome page should:

- Identify the project by its configured application name.
- Explain that the project uses SvelteKit and SvelteX without claiming features that were not installed.
- Provide working links to the project's local example routes and the official SvelteX documentation URL configured at generation time.
- Show the exact package-manager command to start development (for example, `pnpm dev`).
- Include a small architecture/next-steps section that points developers to routes, server modules, and installed integrations.
- Be responsive, keyboard accessible, and readable in light and dark color schemes.
- Use Svelte 5 conventions and scoped component styles.
- Avoid unnecessary client-side JavaScript and avoid placeholder links that appear functional but are not.

Welcome page choices:

- `welcome` — default for `fullstack` and `dashboard`.
- `blank` — clean page for users who do not want onboarding content.
- `dashboard` — a UI shell only; do not imply authentication or data persistence until configured.
- `docs` — documentation-style landing page.

The minimal template should remain minimal and should not force a large starter dashboard into every application. Users can change or delete generated page source freely.

### 5.6 Integration installation workflow

`sveltex add` must perform a predictable sequence:

1. Discover the project root and package manager.
2. Read installed SvelteKit/SvelteX versions and the package's declared compatibility metadata.
3. Resolve a compatible package version; never guess a version range.
4. Show the intended package and file changes in preview/dry-run mode.
5. Install the dependency using the detected package manager.
6. Apply only the required configuration changes.
7. Generate any explicitly requested starter files.
8. Run the package's available validation/check command.
9. Report changed files and any manual steps, including required environment variables without inventing values.

If installation or configuration fails, the CLI should explain what succeeded and what needs repair. File updates should be atomic where practical and should not silently leave half-written configuration.

### 5.7 Project discovery and package manager support

- Detect `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, and `bun.lock`/`bun.lockb`.
- If multiple lockfiles conflict, stop and ask the user to choose; do not silently delete one.
- Respect the project's declared `packageManager` field when consistent with the lockfile.
- Support pnpm, npm, Yarn, and Bun through a tested package-manager abstraction.
- Support Windows PowerShell, macOS, and Linux shells.
- Validate Node.js version against the actual installed package requirements.

### 5.8 Configuration behavior

- The canonical application config is `sveltex.config.ts` unless an ADR chooses another format.
- Config types and validation must be owned by framework packages, not duplicated in the CLI.
- Preserve comments and formatting where feasible; do not rewrite entire files for a small integration addition.
- Never print secrets. Redact values for keys matching token, secret, password, private key, credentials, or configured secret fields.
- Do not execute arbitrary project configuration merely to display it in a diagnostic mode unless execution is explicitly required and clearly disclosed.

### 5.9 File generation and safety

- Never overwrite a user file without explicit confirmation.
- Provide `--dry-run` and a clear preview for destructive or multi-file operations.
- Detect existing content before editing hooks, config files, route files, and package manifests.
- Preserve existing SvelteKit hooks; compose with them instead of replacing them.
- Validate generated paths and reject path traversal.
- Avoid shell interpolation of untrusted project names or arguments.
- Do not run generated application code during project discovery.
- Keep a change summary and make rollback possible for CLI-owned changes when a multi-step operation fails.

### 5.10 Diagnostics

`sveltex doctor` should check:

- Node.js version and package manager availability.
- Svelte, SvelteKit, and SvelteX package versions.
- Peer dependency compatibility.
- Presence and validity of the SvelteX config.
- Expected SvelteKit hook integration.
- TypeScript and generated type health where supported.
- Missing environment variables by name only (never print values).
- Common deployment mismatches, such as an in-memory-only service used where multiple instances are configured.

Each diagnostic should include severity, a stable code, explanation, affected path (if known), and a safe suggested fix. Automated fixes must be opt-in and previewable.

### 5.11 Output and exit codes

- Interactive terminal output should be concise and readable.
- `--json` should provide stable machine-readable output for CI and editors.
- Exit code `0`: command succeeded.
- Exit code `1`: command failed.
- Exit code `2`: invalid usage or arguments.
- Exit code `3`: project/configuration/compatibility problem.
- Exit code `4`: operation cancelled by the user.

### 5.12 CLI architecture

The eventual package should separate command parsing from project operations:

```text
packages/cli/
├── src/
│   ├── index.ts
│   ├── cli.ts
│   ├── commands/
│   ├── project/
│   ├── package-manager/
│   ├── integrations/
│   ├── generators/
│   ├── templates/
│   ├── configuration/
│   ├── diagnostics/
│   ├── migrations/
│   ├── terminal/
│   ├── safety/
│   └── types/
├── templates/
│   ├── fullstack/
│   ├── minimal/
│   ├── api/
│   ├── dashboard/
│   └── documentation/
└── tests/
    ├── unit/
    ├── commands/
    ├── generators/
    ├── package-managers/
    ├── diagnostics/
    ├── migrations/
    ├── security/
    └── e2e/
```

This architecture is now implemented in `packages/cli/` (Stage 5, built last). It was a target, not an instruction to create the CLI early.

## 6. Quality gates for every package

Every package must provide:

- Strict TypeScript compilation and declaration generation.
- Unit tests for deterministic logic.
- Integration tests for framework/provider boundaries.
- Failure-path and cleanup tests.
- Public API/type tests.
- Security tests for untrusted input and authorization-sensitive behavior.
- README with installation, minimal example, API surface, limitations, and production notes.
- Changelog and license metadata.
- CI coverage on supported Node.js versions and operating systems where relevant.

A package is not complete because its source compiles. It is ready only when its API, behavior, error paths, tests, documentation, and compatibility claims agree.

## 7. Implementation order from this point

1. Preserve and verify the existing Core and SvelteKit adapter.
2. Finish Stage 1 shared contracts and configuration package; align them with Core without duplicating APIs.
3. Finish Stage 2 adapter compatibility tests and fixture builds.
4. Implement Stage 3 in dependency order: validation, database contracts/adapters, session, auth, and cache (adjust ordering when a dependency requires it).
5. ✅ Implement Stage 4 capabilities and testing utilities — done (realtime, jobs, storage, mail, testing).
6. ✅ Build and polish Stage 5 CLI only after the official packages, configuration, integration metadata, and starter examples are stable — done last (session 6).

Do not create placeholder packages for every future feature merely to fill the workspace. Each package should begin when its contract and first useful implementation are understood.

## 8. Explicit non-goals

- Replacing SvelteKit routing, rendering, or Vite.
- Requiring every SvelteX package in every application.
- Making the CLI a runtime dependency.
- Hiding SvelteKit's native APIs behind a proprietary abstraction.
- Shipping fake integrations that compile but do not perform their advertised work.
- Claiming distributed durability for in-memory queues, caches, or session stores.
- Building the CLI before the package contracts and templates are proven.


## Stage 3 implementation baseline (updated 2026-11-07)

All Stage 3 packages have substantive implementations with passing tests. They are not empty stubs:

- `@sveltex/database`: Full lifecycle state machine (idle→connecting→ready→closing→closed→failed), operation counting with drain, transaction-scoped executor with active-flag guard, AbortSignal support, SQL/parameter validation, normalized frozen results. Real `SqliteAdapter` (`node:sqlite`) with 14 integration tests; 68 tests total after the production-hardening pass, **116/116 after completion-plan Phase 1**. **Delivered:** `PostgresAdapter`, `MysqlAdapter`, `MigrationRunner`, `PoolConfig`, corrected write `rowCount`, and an additive ORM integration layer (optional Drizzle/Kysely adapters + BYO ORM conformance). **Still missing:** built-in Prisma/MikroORM/TypeORM adapters (BYO only), cross-process migration lock, retry/failover.
- `@sveltex/validation`: Standard Schema v1 execution, issue path normalization (string/number/object key), malformed schema rejection, execution-error wrapping, 8 tests. **Vendor-neutral by design** — works with any Standard Schema-compatible library (Zod, Valibot, ArkType, etc.).
- `@sveltex/auth`: Credential orchestration with injected hasher (no weak default), dummy hash for timing attack mitigation, email normalization, password length limits, attempt limiter, user sanitization (strips passwordHash). Real `Argon2Hasher` (Argon2id via `@node-rs/argon2`) with `generateDummyHash()` and 13 integration tests. Completion-plan Phase 2 adds a concrete `FixedWindowLimiter`, a `TokenManager` (single-use/expiring/purpose-scoped tokens), `PasswordResetService`, `EmailVerificationService`, and a deny-by-default `RbacBuilder`/`createRbac`; **58 tests total (8 security)**. OAuth2/OIDC and MFA remain explicitly out of scope for this plan.
- `@sveltex/cache`: Bounded LRU with TTL, injected clock, expiry purge, capacity enforcement, key/TTL validation, `has()` distinguishes cached `undefined` from missing key. `RedisCache` via `ioredis` with `keyPrefix` namespaces, `increment` (server-side Lua, envelope-compatible), `getMany`/`setMany`, native TTL and prefix-scoped `SCAN`. **Completion-plan Phase 4 (2026-11-11) closed all former gaps:** typed `CacheError`/`CacheConfigurationError`/`CacheSerializationError`/`CacheStoreError`; a strict `sveltex-cache:v1:` wire envelope that encodes `undefined` exactly and rejects BigInt/symbol/function/circular/Date/Map/Set/non-finite values plus corrupt or legacy payloads; `CacheNamespace` with `encodeURIComponent`-escaped physical key segments and scoped `clear()`; `invalidateKeys`/`invalidatePrefix`/`invalidateMatching`; `TaggedCache` + `RedisTagVersionSource` (real `INCR`/`MGET`/`SCAN` generations, lazy stale-entry deletion); `FallbackCache` with `healthy`/`degraded`/`probing` states, `lastError`, `failureCount`, `onError`/`onStateChange` and `probe()`; and `StampedeGuard` (process-local single-flight + `computeTtlWithJitter`). Seven subpath exports (`/serialization`, `/namespace`, `/invalidation`, `/tags`, `/fallback`, `/stampede`, `/redis`). 121 tests (15 security, real Redis integration). **Still open:** a distributed lock (single-flight is process-local), additional distributed backends, and SvelteKit `handle` wiring (Phase 10); see [`Phase 4 report`](./completion/phase-4-cache.md).
- `@sveltex/session`: Revision-based compare-and-set, atomic rotate, collision retry with configurable attempts, URL-safe ID validation, deep-cloned/frozen data, expiry checking, `touch()` for sliding expiration (12 tests). `RedisSessionStore` via `ioredis` implements `createIfAbsent`/`compareAndSet`/`rotate` as server-side **Lua `EVAL` scripts**, JSON records under `<keyPrefix><id>` with physical TTL from `expiresAt`, prefix-scoped `clear()` (never `FLUSHDB`), corrupt/expired record purging, injected-clock support, and a public `./redis` type test (20 real integration tests). **Completion-plan Phase 3 (2026-11-11) closed all four former gaps:** `DatabaseSessionStore` (SQLite/PostgreSQL/MySQL, real integration tests), `SessionCookieTransport` with `__Host-` secure defaults, `CsrfProtection` (double-submit + optional HMAC binding), and rotation-on-privilege-change via `createAuthSessionPort`/`SessionCookieTransport.rotate()`. Per-user revocation is a first-class `SessionManager.revokeAllForUser` over a `RevocableSessionStore` port. 104 tests (91 runtime + 13 security). **Still open:** SvelteKit `handle` hook wiring (Phase 10), signing/encryption, stateless cookie sessions; see [`Phase 3 report`](./completion/phase-3-session.md).

Current local verification results and known gaps are recorded in the [audit documentation](./audit/).

### Stage 3 reference application (added 2026-11-07)

`examples/reference-app/` is a real workspace project (added to `pnpm-workspace.yaml` as `examples/*`) that satisfies the fourth Stage 3 exit criterion. It uses only real `@sveltex/*` packages — no fake providers, no untested support claims.

**Assembly** (`src/app.ts`: `createApp(options)` → `ReferenceApp`)

| Concern | Real implementation |
| --- | --- |
| Persistence | `Database(new SqliteAdapter({ path }))`; `users`/`posts` DDL; `grantRole` inside `Database.transaction` |
| Validation | `validate(registerSchema, …)` / `validate(postSchema, …)` — hand-written Standard Schema v1 |
| Authentication | `AuthService<AppUser, SessionToken>` + `Argon2Hasher` + real `generateDummyHash()` |
| Sessions | `SessionManager<AppSessionData>` bridged to `AuthSessionPort`; `MemorySessionStore` or `RedisSessionStore` (atomic Lua) |
| Cache | `MemoryCache` or `RedisCache`; cache-aside reads, invalidation on every write |
| Authorization | Application-layer RBAC against a fresh `users` row; admin-only `listUsers` / `grantRole` |

Omitting `redisUrl` runs the in-process pair; supplying it switches **both** session and cache to the real `ioredis` adapters with explicit `connect()` / `disconnect()`. A pure-TCP readiness probe skips the Redis suite when no server is reachable — nothing is faked.

**Security properties:** no self-granted roles (registration accepts only `email` / `password` / `displayName`; `admin` comes from trusted `adminEmails`), authorization never trusts a cached role, `createPost` takes `authorId` from the session, all SQL is parameterized, `grantRole` enforces an allow-list and invalidates the profile cache, and `rotateSession` demonstrates atomic ID rotation.

**Verification:** 18 integration tests (16 in-process + 2 live Redis) plus a public-API type test; all pass under `pnpm check`. This section records the Stage 3 baseline; repo-wide totals at the end of Stage 5 were **450/450 runtime tests** (historical baseline; the total after Phase 3 was 637/637 runtime and 105/105 security; the current measured total after Phase 8 is 871/871 runtime and 160/160 security — see the Phase 2–8 baselines below).

## Stage 4 implementation baseline (added 2026-11-07)

All five Stage 4 packages have substantive, tested implementations. None is a placeholder:

- `@sveltex/realtime`: `defineChannel<T>()`, `RealtimeHub<P>` with a required `AuthorizeHook<P>` (no implicit allow), per-action authorization, per-subscriber bounded de-duplication, deep-frozen payloads, subscriber failure isolation, metrics, and `InProcessTransport`. Completion-plan Phase 5 adds real WebSocket (`ws`) and SSE (`node:http` + `fetch`) gateways and client transports, a strict versioned wire protocol, deny-by-default gateway auth, heartbeats, capped reconnect with re-subscribe/queue drain and bounded backpressure. 70 tests (50 runtime + 20 security). **Not shipped:** a cross-instance broker or durable delivery.
- `@sveltex/jobs`: `JobQueue` contract, `InMemoryJobQueue` (atomic `claim`, delayed visibility via `availableAt`, deduplication keys, dead-letter state, idempotent `complete`/`fail`), `computeBackoffDelay`, and `Worker` (concurrency, capped exponential backoff, bounded retries, failure isolation, graceful `stop()`, external `AbortSignal`, injectable `now` via public `tick(now?)`). 51 runtime + 17 security + 17 integration tests (real Redis 7, SQLite, PostgreSQL 16). **Not shipped:** MySQL SQL dialect, distributed lock, cron/recurring schedules, workflow DAGs.
- `@sveltex/storage`: `ObjectBody`/`ObjectMetadata`/`StorageDriver`/`PresigningStorageDriver` contracts, `Storage` facade (key/content-type/custom-metadata/size/TTL validation before I/O), `LocalStorageDriver` (real filesystem I/O, SHA-256 hashed filenames, atomic temp+`rename` writes with metadata published last, Web `ReadableStream<Uint8Array>` reads, symlink rejection, etag/size integrity metadata), and Phase 7 `S3StorageDriver` (official AWS SDK v3, real Put/Get/Head/Delete/List, SigV4 presigned GET/PUT with bounded TTL, S3 user-metadata integrity, `StorageIOError` diagnostics). 44 runtime + 18 security + one type test + 9 real MinIO integration tests. **Not shipped:** multipart uploads, bucket creation, versioning, object locking, SSE configuration, replication, CDN, virus scanning.
- `@sveltex/mail`: `MailMessage` / `MailAttachment` / `MailTransport` contracts, `validateMessage` (address, reserved-header/injection and aggregate attachment-cap checks), `renderTemplate` (HTML escaping by default), `computeRetryDelay`, `Mailer` (bounded capped-backoff retries, injectable `sleep`/`now`, permanent failure → `MailSendError` with attempts and cause), `MailConfigurationError`, `TestTransport` (deterministic in-memory, never sends real mail). **Completion-plan Phase 8 (2026-11-12) closed the provider gap:** a real RFC 5322/2045 MIME serializer (`./mime`, CRLF-only, RFC 2047/2231, QP/base64, `multipart/alternative` + `multipart/mixed`, BCC envelope-only), `SmtpTransport` (`./smtp`, official nodemailer with AUTH/STARTTLS/implicit TLS, `disableFileAccess` / `disableUrlAccess`, credential-free errors, `verify()`, `MailDeliveryInfo`), `HttpTransport` (`./http`, strict `application/vnd.sveltex.mail.v1+json`, SSRF `allowedHosts` guard, `redirect: 'manual'`, timeout, bounded response), and `createPasswordResetMailSender` / `createEmailVerificationMailSender` (`./auth`) wiring real `@sveltex/auth` services. 70 tests (51 unit + 19 security), 24 real integration tests (real `smtp-server`, `node:http`, `mailparser`, real `@sveltex/auth`), public-API type tests. **Not shipped:** DKIM/SPF signing, delivery tracking beyond the SMTP response, queued/bulk send, hosted provider clients.
- `@sveltex/testing`: `TestApplication`/`createTestApplication`/`withTestApplication`/`createRequestFixture` built on the **real** `@sveltex/core` `createApplication`, `defineModule`, `token`, `Container` — no parallel DI implementation. `FakeClock`, `LifecycleRecorder`, `testToken`, three provider helpers, `defineTestModule`, plus `FakeKeyValueAdapter` and `FakeMessageTransport` in-memory fakes with `failNext()` and frozen snapshots. 32 tests (20 + 12).

All five ship strict TypeScript declarations, READMEs documenting process-local limitations, changelogs, and public-API type tests. `npm pack --dry-run` was verified for each: only `dist/`, `README.md`, `CHANGELOG.md`, and `package.json` are published. Repo-wide totals after Stage 4 were **393/393 runtime tests, 62/62 security tests, 15/15 type-test projects**; after Stage 5 they were **450/450, 71/71, 16/16** (Stage 5 baseline), verified with `pnpm check`. The totals after database hardening were 488/488, 77/77, 16/16; after the completion plan's Phase 1 they were 536/536, 86/86, 16/16; after Phase 2 (565/565, 93/93), Phase 3 (637/637, 105/105, 16/16), Phase 4 (734/734, 119/119, 16/16), and Phase 5 they were 779/779, 131/131, 16/16; after Phase 6 they are 806/806, 141/141, 16/16; after Phase 7 they are 826/826, 150/150, 16/16; after Phase 8 they are 871/871, 160/160, 16/16 (current).

## Stage 5 implementation baseline (added 2026-11-08)

The `sveltex` CLI is a real, tested development tool — not a placeholder — and was built **last**, after Stages 1–4 were stable and verified.

- **Package:** `packages/cli/`, published name `sveltex` (executable `bin.sveltex`), ESM, strict TypeScript, `README.md`, `CHANGELOG.md`, `LICENSE`. 32 source files (~2,950 lines), 41 `.tmpl` assets, 58 tests (unit, command, generator, package-manager, diagnostic, security, e2e — including a Phase 8 registry/adapter consistency test) plus a public-API type test.
- **Commands (17):** `create`, `init`, `add`, `remove`, `generate`, `dev`, `build`, `preview`, `check`, `test`, `doctor`, `info`, `routes`, `modules`, `config`, `upgrade`, `migrate`. Delegated commands invoke the project's own package-manager scripts; the CLI does not reimplement Vite/SvelteKit/test-runner behavior.
- **Templates:** six official starters (`minimal`, `fullstack`, `api`, `dashboard`, `saas`, `documentation`) with four welcome-page choices (`welcome`, `blank`, `dashboard`, `docs`). Each generates real editable SvelteKit source, a canonical `sveltex.config.ts`, and a dependency manifest. Six-template smoke generation produced 14–16 files per app and **zero unrendered placeholders**. The `saas` starter is a layout shell only: its README explicitly lists authentication, persistence, billing, subscriptions, and payments as **NOT included and NOT implied**.
- **Safety:** `ChangeSet` preview/apply/rollback for every CLI-owned file; `--dry-run` writes nothing; overwrite requires `--force`/`--yes`; `init` composes an existing `src/hooks.server.ts` handle as `userHandle` with SvelteKit `sequence()` and preserves comments; `sveltex.config.ts` is inspected **as text** and never imported/executed, with secret redaction and env **names** only (never values or invented values); all child processes run with `shell: false` and argument arrays; project names, generated paths, package specifiers (including leading-dash option injection), encoded traversal, and NUL are rejected; conflicting lockfiles stop the command; a failed install rolls back all CLI-owned changes. `init --no-install` was fixed to actually skip installation and the automatic check (previously the flag was silently ignored).
- **Integrations:** the registry lists only the 14 real shipped `@sveltex/*` packages and their compatibility metadata. Phase 8 made every advertised adapter a **real in-package subpath export** (verified by a consistency test): `@sveltex/mail/smtp`, `/http`, `/mime`, `/auth`, `/test-transport`, `@sveltex/storage/s3`, `@sveltex/realtime/websocket`, `@sveltex/jobs/redis`, and the cache/session/database adapters. These are self-hosted client adapters, not hosted/managed providers — no SMTP/S3/broker service is bundled. `upgrade` reports CLI-owned metadata only — no registry lookup, no guessed versions. `doctor` flags process-local adapters in multi-instance/production setups.
- **CLI output:** stable `CliResult`, single-object `--json` mode, and exit codes `0` (success), `1` (failure), `2` (usage), `3` (project/config/compatibility), `4` (cancelled). `runCli()` never calls `process.exit()` itself, so the API is embeddable and testable.
- **Verification:** `pnpm --filter sveltex test` → 58/58; `npm pack --dry-run` → 173 files (41 templates + 32 `dist/*.js` + 32 `dist/*.d.ts` + metadata), no source/test leakage; real `create` and `init` smoke runs verified generated files, hooks composition, and rollback. `pnpm check` → 450/450 runtime, `pnpm test:security` → 71/71, `pnpm test:types` → 16/16 projects (Stage 5 baseline; totals after Phase 3 were 637/637, 105/105, 16/16; current totals after Phase 8 are 871/871, 160/160, 16/16).

**Not claimed:** generated apps have not been installed from a public registry (the workspace packages are unpublished), so a consumer-side `install → typecheck → build` pass remains CI work. The CLI advertises only real self-hosted adapter packages (no hosted/managed provider service) and does not claim distributed durability for any process-local adapter.

---

## Database production-hardening baseline (2026-11-08)

Follow-up hardening after all five stages were complete (the "Stage 3/4 hardening" backlog item).
The CLI remains built last; no ordering was changed.

| Capability | Delivery |
| --- | --- |
| PostgreSQL adapter | `PostgresAdapter` (`pg.Pool`) — pooled connections, real `SELECT 1` probe, dedicated transaction connections, `AsyncLocalStorage` + `SAVEPOINT` nesting, `pool.end()` shutdown |
| MySQL adapter | `MysqlAdapter` (`mysql2/promise` `createPool`) — same transaction/savepoint model |
| Connection pooling | Shared `PoolConfig` (`max`, `idleTimeoutMs`, `connectionTimeoutMs`, `acquireTimeoutMs`) with strict validation |
| Migrations | `MigrationRunner` — ordered unique ids, SHA-256 checksums, prefix validation, transactional application, built-in `sqlite`/`postgres`/`mysql` dialects |
| `rowCount` | Returned rows for `SELECT`/`RETURNING`; affected rows for writes (SQLite via `total_changes()`, PostgreSQL via `rowCount`, MySQL via `affectedRows`) |

**Real integration tests.** 24 PostgreSQL/MySQL tests connect to real PostgreSQL 16 and MySQL 8.0
servers (CRUD, injection, commit/rollback, nested savepoints, concurrent isolation, migrations,
checksum tampering). CI provisions PostgreSQL 16, MySQL 8.0 and Redis 7 services and runs
`pnpm check` plus `pnpm test:security`, so these tests execute rather than being skipped.
`SVELTEX_TEST_POSTGRES_URL` / `SVELTEX_TEST_MYSQL_URL` override the local defaults;
`SVELTEX_SKIP_DB_INTEGRATION=1` is an explicit opt-out, never an automatic green.

**Not claimed in this hardening pass.** An ORM/query-builder integration layer was later added in the completion plan's Phase 1 (see the next section), with its own security review. Still not claimed after Phase 1: automatic dialect detection, SQL rewriting (placeholders remain dialect-specific), a cross-process migration lock, retry/failover, and built-in Prisma/MikroORM/TypeORM adapters. The raw-SQL `MigrationRunner` is not an ORM migration replacement.
MySQL DDL implicitly commits, so DDL-bearing migrations are not atomic there. `pg` and `mysql2`
are regular dependencies even for SQLite-only users.

**Node.js.** `@sveltex/database` declares `engines >=22.5.0` because `node:sqlite` first
appeared there; other packages still declare `>=20.11`. This resolves the earlier conflict
between the manifest and the README.

**Verification (Session 7 baseline, superseded by Phase 1 below).** `pnpm check` → 488/488 runtime (0 failures, 0 skipped),
`pnpm test:security` → 77/77, `pnpm test:types` → 16/16 projects,
`npm pack --dry-run` for `@sveltex/database` → 27 files including all six `dist/*.js`
entries and README/CHANGELOG. Security findings SEC-027 – SEC-030 added.

---

## Completion-plan Phase 1 baseline — ORM integrations (2026-11-08)

The [Existing Package Completion Plan](./completion-plan.md) now drives package-by-package
completion. **Core rule honoured:** no new packages were created; Phase 1 extended only the
existing `@sveltex/database` package. Full reports: [Phase 0 audit](./completion/phase-0-audit.md)
and [Phase 1 report](./completion/phase-1-database.md).

| Capability | Delivery |
| --- | --- |
| BYO ORM contract | `defineDatabaseAdapter`, `defineAdapterContext`, `validateAdapterDefinition`, capability declarations + validation, stable error family (`DatabaseAdapterError`, `AdapterTransactionError`, `UnsupportedCapabilityError`) |
| Foundation | `configFromEnv` / `connectionStringFromEnv` / `redactConfig` (passive, log-safe), `AdapterRegistry`, `createConnection` (state machine, idempotent/concurrent-safe connect, draining close, redacted health reports), `ConnectionManager` (multiple named connections, `connectAll`/`healthCheckAll`/`closeAll`) |
| Built-in ORM adapters | `createDrizzleAdapter` (`./adapters/drizzle`) and `createKyselyAdapter` (`./adapters/kysely`), each behind an **optional** peer dependency, native client preserved (`native()` / `tx.client`), optional `migrate()` delegation to the ORM's own migrator |
| Shared conformance | `runAdapterConformance(factory)` — the same suite validates official and BYO adapters |
| Migrations | ORM-native migrators remain authoritative; `MigrationRunner` stays a driver-neutral raw-SQL utility, not a competing ORM migration engine |

`drizzle-orm` and `kysely` are optional `peerDependencies`; the main entry imports neither.
Verified: with both ORMs removed, the main/contracts/core/testing entry points still load and
the drizzle subpath correctly reports `ERR_MODULE_NOT_FOUND`. ORM integration tests use a real
PostgreSQL 16 server (Drizzle, Kysely, and a runnable BYO custom adapter in
`packages/database/examples/custom-orm-adapter.mjs`). Prisma, MikroORM and TypeORM are BYO-only
and are **not** advertised as built-in.

**Verification.** `pnpm --filter @sveltex/database test` → **116/116**;
`test:security` → **16/16**; `pnpm check` → **536/536** runtime tests (0 failures,
0 skipped, 16 packages); `pnpm test:security` → **86/86**; `pnpm test:types` → **16/16**
projects; `pnpm install --frozen-lockfile --offline` clean; `npm pack --dry-run` includes every
new subpath `.js`/`.d.ts` with an ORM-free main entry. Security findings SEC-031 – SEC-034
record the ORM adapter security review.

**Not claimed.** Built-in Prisma/MikroORM/TypeORM adapters, ORM-side SQLite/MySQL dedicated
integration tests (user-configurable, not separately claimed), a unified ORM migration CLI,
savepoints inside built-in ORM adapters (single-level transactions), and any cross-process
migration lock or retry/failover.


---

## Completion-plan Phase 2–4 baselines — auth, sessions and cache (2026-11-11)

Full reports: [Phase 2 auth](./completion/phase-2-auth.md) and
[Phase 3 sessions](./completion/phase-3-session.md). **Core rule honoured:** no new package was
created; Phase 2 extended only `@sveltex/auth`, Phase 3 extended only `@sveltex/session`.

| Phase | Package | Delivery |
| --- | --- | --- |
| 2 | `@sveltex/auth` | Centralized `AuthError` hierarchy; concrete `FixedWindowLimiter` (consulted before user lookup, default-deny on error); `TokenManager` + `MemoryTokenStore` (256-bit single-use, expiring, **purpose-scoped**); `PasswordResetService` (silent for unknown emails, policy checked before token consumption); `EmailVerificationService`; deny-by-default `RbacBuilder`/`createRbac` with inheritance, cycle detection and 401/403 semantics; subpath exports `/errors`, `/limiter`, `/tokens`, `/rbac`, `/reset`, `/verification`. |
| 3 | `@sveltex/session` | `SessionCookieTransport` with `__Host-` secure defaults (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`), CRLF/semicolon injection rejection and `__proto__`-safe parsing; `CsrfProtection` (double-submit + optional HMAC session binding, constant-time compare over SHA-256 digests); `DatabaseSessionStore` (structural `SessionSqlExecutor` over `@sveltex/database`, dialect-aware `$1..$n`/`?` placeholders, atomic conditional `INSERT`/`UPDATE`, transactional `rotate`); `createAuthSessionPort` bridge; first-class `revokeAllForUser` via `RevocableSessionStore` (memory/Redis/SQL), `SessionRevocationUnsupportedError` for stores that cannot support it; subpath exports `/cookie`, `/csrf`, `/database`, `/auth`. |
| 4 | `@sveltex/cache` | Typed `CacheError` hierarchy; strict `sveltex-cache:v1:` envelope (`u` = cached `undefined`, `j` = strict JSON) rejecting silent type coercion and corrupt/legacy payloads; `CacheNamespace` + `createNamespace` with `encodeURIComponent`-escaped key segments and prefix-scoped `clear()`; `invalidateKeys`/`invalidatePrefix`/`invalidateMatching`; `TaggedCache` + `InMemoryTagVersionSource` + `RedisTagVersionSource` (real `INCR`/`MGET`/`SCAN`, lazy physical deletion of stale generations); `FallbackCache` (`healthy`/`degraded`/`probing`, `CacheStoreError` with `cause`, observers, `probe()`); `StampedeGuard` (process-local single-flight + TTL jitter); `RedisCache.increment()` via server-side Lua so counters stay readable by `get()`, `RedisCache.keys()` via prefix-scoped `SCAN`; subpath exports `/serialization`, `/namespace`, `/invalidation`, `/tags`, `/fallback`, `/stampede`. |

**Real integration, no fakes.** Phase 3 started real Redis 7, PostgreSQL 16 and MySQL 8.0
services and exercised all of them: SQLite (`node:sqlite`) always; PostgreSQL/MySQL full session
lifecycle with real dialect rendering; real Redis `revokeAllForUser`; a real `@sveltex/auth`
`AuthService` + `Argon2Hasher` register → login → rotate → revoke → logout flow. A public-API
type test proves `@sveltex/database`'s `Database` satisfies `SessionSqlExecutor` and the bridge
satisfies `AuthSessionPort`. PostgreSQL/MySQL suites skip cleanly only when the service is
unreachable — nothing is substituted.

**Verification (Phase 3 baseline, measured 2026-11-11, services live).** `pnpm check` → **637/637** runtime tests
(0 failures, 0 skipped, 16 test projects), `pnpm test:security` → **105/105** (15 packages),
`pnpm test:types` → **16/16** projects. `@sveltex/session` alone → **104/104** (91 runtime +
13 security): runtime 32→91 (+59), security 1→13 (+12). `npm pack --dry-run` → 27 files,
all four new subpath `.js`/`.d.ts` pairs present, no `src`/`tests` leakage. Security findings
SEC-035 – SEC-040 record the Phase 3 review.

**Not claimed.** SvelteKit `handle` hook wiring (Phase 10), automatic CSRF/session middleware,
signed or encrypted cookies / stateless sessions, guaranteed cross-process isolation beyond the
database's own transaction semantics, O(1) Redis revocation (it is a namespace `SCAN`), and
HMAC CSRF binding when no `secret` is configured (unbound mode verifies token shape only).
OAuth2/OIDC and MFA remain out of scope from Phase 2. All of these are documented in the
[Phase 3 report](./completion/phase-3-session.md), not hidden.

**Phase 4 verification (measured 2026-11-11, real Redis 7 live).** `@sveltex/cache` →
**121/121** runtime (15 security) plus a public-API type test; full monorepo `pnpm check` →
**734/734** runtime (0 failures, 0 skipped, 16 test projects), `pnpm test:security` → **119/119**
(15 packages), `pnpm test:types` → **16/16**. `npm pack --dry-run` ships the six new subpath
`.js`/`.d.ts` pairs with no `src`/`tests` leakage. Phase 3 → Phase 4: +97 runtime, +14 security.
Integration tests use a real Redis server; fallback failure tests use a genuinely unreachable
port (`127.0.0.1:6399`) — no fake provider and no skipped test. Security findings
SEC-041 – SEC-046 record the Phase 4 review.

**Phase 5 verification (measured 2026-11-11, real ephemeral TCP ports + real `fetch` streams).** `@sveltex/realtime` →
**70/70** (50 runtime + 20 security) plus a public-API subpath type test; full monorepo `pnpm check` →
**779/779** runtime (0 failures, 0 skipped, 16 test projects), `pnpm test:security` → **131/131**
(15 packages), `pnpm test:types` → **16/16**. `npm pack --dry-run --json` → **27 files**, 6 `dist/*.js` +
6 `dist/*.d.ts`, version `0.1.0`, no `src`/`tests` leakage. Phase 4 → Phase 5: +45 runtime, +12 security.
Integration tests use real `ws` sockets and real `node:http` servers on ephemeral ports, a genuinely
unreachable port for reconnect/backpressure tests, and injectable clocks for deterministic heartbeats —
no fake transport and no skipped test. Security findings SEC-047 – SEC-052 record the Phase 5 review.

**Phase 7 verification (measured 2026-11-12, live MinIO S3-compatible server + real AWS SDK v3).** `@sveltex/storage` →
**44/44** (runtime + security) plus a public-API type test; `pnpm --filter @sveltex/storage test:integration` →
**9/9** against real MinIO; full monorepo `pnpm check` → **826/826** runtime (0 failures, 0 skipped, 16 test
projects), `pnpm test:security` → **150/150** (16 packages), `pnpm test:types` → **16/16**;
`npm pack --dry-run --json` → **15 files**, version `0.1.0`, no `src`/`tests` leakage. Phase 6 → Phase 7:
+20 runtime, +9 security. Presigned URLs are exercised with credential-free `fetch` against MinIO; no fake
provider, no skipped test. Security findings SEC-063 – SEC-071 record the Phase 7 review.

**Phase 8 verification (measured 2026-11-12, real `smtp-server` + real `node:http` provider + real `@sveltex/auth` services).** `@sveltex/mail` →
**70/70** (51 unit + 19 security) plus public-API type tests; `pnpm --filter @sveltex/mail test:integration` →
**24/24** (10 SMTP + 9 HTTP + 5 auth, 0 skipped) against a real AUTH/STARTTLS/implicit-TLS SMTP server, a real
HTTP provider, MIME parsing via `mailparser`, and real `PasswordResetService`/`EmailVerificationService` token
single-use semantics; full monorepo `pnpm check` → **871/871** runtime (0 failures, 0 skipped, 16 test
projects), `pnpm test:security` → **160/160** (16 packages), `pnpm test:types` → **16/16**;
`pnpm --filter @sveltex/jobs test:integration` → **17/17** and `@sveltex/storage` → **9/9** (no regression);
`npm pack --dry-run --json` → **27 files**, version `0.1.0`, no `src`/`tests` leakage. Phase 7 → Phase 8:
+45 runtime, +10 security, +24 real integration tests. TLS certificates are generated at runtime with
`openssl`; no external mail service and no skipped test. Security findings SEC-072 – SEC-081 record the Phase 8 review.

**Not claimed (Phase 8).** `SmtpTransport` and `HttpTransport` are real client adapters, not a hosted mail
service; there is no DKIM/SPF signing, no delivery-status webhook, no queued/bulk send, and no attachment
virus scanning. Preserving BCC as envelope-only is intentional; the raw MIME document itself is not encrypted.
The package version stays `0.1.0` with the rest of the workspace — the bump is deferred to the Phase 11
release audit. See the [Phase 8 report](./completion/phase-8-mail.md).

**Not claimed (Phase 5).** Both gateways are **single-process fan-out hubs**; there is no persistence,
cross-instance fan-out, broker, or distributed lock. `allowAnonymous()` is an explicit development
opt-in — production must supply a real `authenticate` policy plus TLS termination and rate limiting.
SSE replay is bounded and channel-filtered, not durable history. The package version stays `0.1.0`
with the rest of the workspace — the bump is deferred to the Phase 11 release audit. See the
[Phase 5 report](./completion/phase-5-realtime.md).

**Not claimed (Phase 4).** `StampedeGuard` is **process-local**; TTL jitter only de-synchronizes
expiration across processes and is **not** a distributed lock. `FallbackCache` reads may be stale
while degraded (documented, not hidden). Only Redis and in-memory stores ship; no other distributed
backend is advertised. The `@sveltex/cache` package version stays `0.1.0` with the rest of the
workspace — the version bump is deferred to the Phase 11 release audit. See the
[Phase 4 report](./completion/phase-4-cache.md).
