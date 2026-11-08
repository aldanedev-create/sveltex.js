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
- `@sveltex/cache`: Bounded LRU in-memory cache complete (7 tests); production `RedisCache` adapter via `ioredis` complete (17 tests). 24 tests passing. Tags/advanced invalidation deferred.
- `@sveltex/session`: Session lifecycle + in-memory store complete; production `RedisSessionStore` (ioredis + atomic Lua scripts) complete with 20 real integration tests. 32 tests passing. Cookie transport/CSRF deferred.
- `@sveltex/database`: Driver contract, lifecycle, transactions complete; `SqliteAdapter` (node:sqlite) complete with 14 real integration tests. 30 tests passing. PostgreSQL/MySQL adapters deferred.
- `@sveltex/auth`: Registration/login/rotation complete; `Argon2Hasher` (Argon2id via `@node-rs/argon2`) complete with 13 real integration tests. 29 tests passing. Password reset, email verification, OAuth deferred.
- `examples/reference-app`: **Stage 3 exit criterion met.** A real workspace application wiring all five packages end-to-end (SQLite + Argon2id + Redis/memory cache + Redis/memory sessions + Standard Schema validation + fresh-record RBAC). 18 integration tests pass, including 2 against a live Redis instance. See [Stage 3 reference application](#stage-3-reference-application).

**Exit criteria**

- Each package has independent install/build/typecheck/test coverage. ✅
- Database transactions, validation failures, authentication boundaries, cache expiry/invalidation, and session expiry/rotation are tested. ✅
- No package silently imports an optional provider as a mandatory runtime dependency. ✅
- A reference application demonstrates persistence, validation, authentication, authorization, and sessions. ✅ `examples/reference-app/` — 18 integration tests (16 in-process + 2 real Redis).

**Stage 3 exit status (verified 2026-11-07):** all four criteria are satisfied. The remaining Stage 3 items below (PostgreSQL/MySQL, migrations, pooling, ORM paths, cookie transport, CSRF) are hardening work, not exit blockers. Stages 4 and 5 therefore remain correctly ordered — the CLI stays last.

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
| `@sveltex/realtime` | Typed channels/events, authorization hooks, transport contracts, and optional WebSocket/SSE adapters. |
| `@sveltex/jobs` | Job definitions, queue contracts, retries, backoff, deduplication, concurrency, and worker lifecycle. |
| `@sveltex/storage` | File/object storage contracts, safe upload metadata, streaming, and provider adapters. |
| `@sveltex/mail` | Email message contracts, template integration, provider adapters, retries, and test transport. |
| `@sveltex/testing` | Test application builders, module/DI helpers, request fixtures, fake adapters, and deterministic lifecycle tests. |

**Exit criteria**

- External transports/providers are behind adapters. ✅
- Retries, shutdown, duplicate delivery, failure handling, and authorization are tested. ✅
- Testing helpers can exercise the real packages without requiring live external services. ✅
- Deployment limitations are documented (for example, in-process workers are not a durable distributed queue). ✅

**Stage 4 exit status (verified 2026-11-07):** all five packages are implemented, independently installable, and covered by runtime, security, and public-API type tests (131 runtime + 45 security tests across Stage 4). Each ships a real process-local implementation behind an explicit adapter contract; no WebSocket/SSE, S3, SMTP/HTTP, or broker provider is shipped or advertised.

| Package | Delivered | Explicitly not claimed |
| --- | --- | --- |
| `@sveltex/realtime` | `defineChannel`, `RealtimeHub` with a **required** `authorize` hook (publish/subscribe/deliver), per-subscriber bounded de-duplication, frozen delivered payloads, `InProcessTransport` with deterministic redelivery simulation | No distributed delivery; no WebSocket/SSE adapter |
| `@sveltex/jobs` | `JobQueue` contract + `InMemoryJobQueue` (atomic claim, delayed visibility, dedupe keys, dead-letter), `Worker` with concurrency, capped exponential backoff, retries, graceful shutdown, injectable clock | No durable/distributed queue; no broker adapter |
| `@sveltex/storage` | `StorageDriver` contract + `LocalStorageDriver` (real filesystem I/O, SHA-256 hashed filenames, key-traversal rejection, atomic temp+rename writes, metadata sidecars, Web-stream reads, symlink rejection, integrity checks) | No S3/object-store adapter; not a distributed store |
| `@sveltex/mail` | `MailTransport` contract + `Mailer` with capped exponential-backoff retries, `renderTemplate` with HTML escaping by default, CRLF/NUL header-injection rejection, `TestTransport` (deterministic, never sends real mail) | No SMTP/HTTP provider adapter |
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

**Stage 5 status (verified 2026-11-08): implemented, built last.** The `sveltex` CLI (`packages/cli/`, published as `sveltex`) now ships 17 commands, six official templates, four welcome-page choices, static/redacted diagnostics, integration add/remove, generators, upgrade/migration tooling, preview/dry-run/rollback safety, and stable `--json` output with exit codes `0`–`4`. It was implemented only after Stages 1–4 were complete and verified. 57 CLI tests (unit, command, generator, package-manager, diagnostic, security, e2e, and public-API type) pass; `npm pack --dry-run` publishes `dist/`, `templates/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json` only. Generated apps never depend on the CLI at runtime.

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
├── session/       # ✅ Stage 3 — In-memory + Redis (atomic) adapter complete
├── realtime/      # ✅ Stage 4 — typed channels + auth + in-process transport
├── jobs/          # ✅ Stage 4 — queue + retries/backoff + worker lifecycle
├── storage/       # ✅ Stage 4 — storage contract + local filesystem driver
├── mail/          # ✅ Stage 4 — message/template contract + retries + test transport
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
| database | ✅ | ✅ | 30/30 | ✅ | Partial — SQLite done, PostgreSQL/MySQL pending |
| validation | ✅ | ✅ | 8/8 | ✅ | Ready — Standard Schema vendor-neutral |
| auth | ✅ | ✅ | 29/29 | ✅ | Partial — Argon2id done, reset/OAuth pending |
| cache | ✅ | ✅ | 24/24 | ✅ | Partial — Redis done, tags/invalidation deferred |
| session | ✅ | ✅ | 32/32 | ✅ | Partial — Redis shared store done, transport deferred |
| examples/reference-app | ✅ | ✅ | 18/18 | — | **Stage 3 exit criterion met** |
| realtime | ✅ | ✅ | 25/25 | ✅ 8/8 | **Stage 4 — ready (process-local)** |
| jobs | ✅ | ✅ | 24/24 | ✅ 7/7 | **Stage 4 — ready (process-local)** |
| storage | ✅ | ✅ | 24/24 | ✅ 9/9 | **Stage 4 — ready (local disk)** |
| mail | ✅ | ✅ | 26/26 | ✅ 9/9 | **Stage 4 — ready (test transport)** |
| testing | ✅ | ✅ | 32/32 | ✅ 12/12 | **Stage 4 — ready (real core DI)** |
| cli (`sveltex`) | ✅ | ✅ | 57/57 | ✅ 9/9 | **Stage 5 — ready (built last)** |

**Total: 450/450 runtime tests passing** (Stage 1–3: 262; Stage 4: 131; Stage 5 CLI: 57), **71/71 security tests** (17 + 45 + 9), **16/16 type-test projects**. Verified with `pnpm check` (0 failures).

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

- `@sveltex/database`: Full lifecycle state machine (idle→connecting→ready→closing→closed→failed), operation counting with drain, transaction-scoped executor with active-flag guard, AbortSignal support, SQL/parameter validation, normalized frozen results. Real `SqliteAdapter` (`node:sqlite`) with 14 integration tests; 30 tests total. **Missing:** PostgreSQL/MySQL adapters, migration management, connection pooling, Drizzle/Prisma integration paths.
- `@sveltex/validation`: Standard Schema v1 execution, issue path normalization (string/number/object key), malformed schema rejection, execution-error wrapping, 8 tests. **Vendor-neutral by design** — works with any Standard Schema-compatible library (Zod, Valibot, ArkType, etc.).
- `@sveltex/auth`: Credential orchestration with injected hasher (no weak default), dummy hash for timing attack mitigation, email normalization, password length limits, attempt limiter, user sanitization (strips passwordHash). Real `Argon2Hasher` (Argon2id via `@node-rs/argon2`) with `generateDummyHash()` and 13 integration tests; 29 tests total. **Missing:** password reset, email verification, OAuth/OIDC, package-level authorization policies. Application-layer RBAC is demonstrated in the reference app.
- `@sveltex/cache`: Bounded LRU with TTL, injected clock, expiry purge, capacity enforcement, key/TTL validation, `has()` distinguishes cached `undefined` from missing key (7 tests). `RedisCache` adapter via `ioredis` with `keyPrefix` namespaces, `increment`, `getMany`/`setMany` atomic ops, native TTL (17 tests). **Missing:** tags, advanced invalidation, stampede protection.
- `@sveltex/session`: Revision-based compare-and-set, atomic rotate, collision retry with configurable attempts, URL-safe ID validation, deep-cloned/frozen data, expiry checking, `touch()` for sliding expiration (12 tests). `RedisSessionStore` via `ioredis` implements `createIfAbsent`/`compareAndSet`/`rotate` as server-side **Lua `EVAL` scripts** (true cross-process atomicity, no GET-then-SET TOCTOU window), JSON records under `<keyPrefix><id>` with physical TTL from `expiresAt`, prefix-scoped `clear()` (never `FLUSHDB`), corrupt/expired record purging, injected-clock support, and a public `./redis` type test (20 real integration tests). **Missing:** database-backed store, cookie transport, CSRF protection, automatic session fixation rotation.

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

**Verification:** 18 integration tests (16 in-process + 2 live Redis) plus a public-API type test; all pass under `pnpm check`. This section records the Stage 3 baseline; repo-wide totals after Stage 5 are **450/450 runtime tests** (see the Stage 4 and Stage 5 implementation baselines below).

## Stage 4 implementation baseline (added 2026-11-07)

All five Stage 4 packages have substantive, tested implementations. None is a placeholder:

- `@sveltex/realtime`: `defineChannel<T>()`, `RealtimeHub<P>` with a required `AuthorizeHook<P>` (no implicit allow), per-action authorization (`publish` / `subscribe` / `deliver`), per-subscriber bounded de-duplication of at-least-once redeliveries, deep-frozen delivered payloads, subscriber failure isolation, metrics (`published/delivered/duplicates/rejected/failed`), and `InProcessTransport` (process-local pub/sub with deterministic `redeliveries` simulation). 25 tests (17 unit + 8 security). **Not shipped:** WebSocket/SSE or broker adapters.
- `@sveltex/jobs`: `JobQueue` contract, `InMemoryJobQueue` (atomic `claim`, delayed visibility via `availableAt`, deduplication keys, dead-letter state, idempotent `complete`/`fail`), `computeBackoffDelay`, and `Worker` (concurrency, capped exponential backoff, bounded retries, failure isolation, graceful `stop()`, external `AbortSignal`, injectable `now` via public `tick(now?)`). 24 tests (17 + 7). **Not shipped:** durable/distributed broker adapters.
- `@sveltex/storage`: `ObjectBody`/`ObjectMetadata`/`StorageDriver` contracts, `Storage` facade (key/content-type/custom-metadata/size validation before I/O), `LocalStorageDriver` (real filesystem I/O, SHA-256 hashed filenames, atomic temp+`rename` writes with metadata published last, Web `ReadableStream<Uint8Array>` reads, symlink rejection, etag/size integrity metadata). 24 tests (15 + 9). **Not shipped:** S3/object-store adapters.
- `@sveltex/mail`: `MailMessage`/`MailTransport` contracts, `validateMessage` (address + header-injection checks), `renderTemplate` (HTML escaping by default), `computeRetryDelay`, `Mailer` (bounded capped-backoff retries, injectable `sleep`/`now`, permanent failure → `MailSendError` with attempts and cause), and `TestTransport` (deterministic in-memory, never sends real mail). 26 tests (17 + 9). **Not shipped:** SMTP/HTTP provider adapters.
- `@sveltex/testing`: `TestApplication`/`createTestApplication`/`withTestApplication`/`createRequestFixture` built on the **real** `@sveltex/core` `createApplication`, `defineModule`, `token`, `Container` — no parallel DI implementation. `FakeClock`, `LifecycleRecorder`, `testToken`, three provider helpers, `defineTestModule`, plus `FakeKeyValueAdapter` and `FakeMessageTransport` in-memory fakes with `failNext()` and frozen snapshots. 32 tests (20 + 12).

All five ship strict TypeScript declarations, READMEs documenting process-local limitations, changelogs, and public-API type tests. `npm pack --dry-run` was verified for each: only `dist/`, `README.md`, `CHANGELOG.md`, and `package.json` are published. Repo-wide totals after Stage 4 were **393/393 runtime tests, 62/62 security tests, 15/15 type-test projects**; after Stage 5 they are **450/450, 71/71, 16/16**, verified with `pnpm check`.

## Stage 5 implementation baseline (added 2026-11-08)

The `sveltex` CLI is a real, tested development tool — not a placeholder — and was built **last**, after Stages 1–4 were stable and verified.

- **Package:** `packages/cli/`, published name `sveltex` (executable `bin.sveltex`), ESM, strict TypeScript, `README.md`, `CHANGELOG.md`, `LICENSE`. 32 source files (~2,950 lines), 41 `.tmpl` assets, 57 tests (11 unit, 12 command, 7 generator, 6 package-manager, 6 diagnostic, 9 security, 5 e2e) plus a public-API type test.
- **Commands (17):** `create`, `init`, `add`, `remove`, `generate`, `dev`, `build`, `preview`, `check`, `test`, `doctor`, `info`, `routes`, `modules`, `config`, `upgrade`, `migrate`. Delegated commands invoke the project's own package-manager scripts; the CLI does not reimplement Vite/SvelteKit/test-runner behavior.
- **Templates:** six official starters (`minimal`, `fullstack`, `api`, `dashboard`, `saas`, `documentation`) with four welcome-page choices (`welcome`, `blank`, `dashboard`, `docs`). Each generates real editable SvelteKit source, a canonical `sveltex.config.ts`, and a dependency manifest. Six-template smoke generation produced 14–16 files per app and **zero unrendered placeholders**. The `saas` starter is a layout shell only: its README explicitly lists authentication, persistence, billing, subscriptions, and payments as **NOT included and NOT implied**.
- **Safety:** `ChangeSet` preview/apply/rollback for every CLI-owned file; `--dry-run` writes nothing; overwrite requires `--force`/`--yes`; `init` composes an existing `src/hooks.server.ts` handle as `userHandle` with SvelteKit `sequence()` and preserves comments; `sveltex.config.ts` is inspected **as text** and never imported/executed, with secret redaction and env **names** only (never values or invented values); all child processes run with `shell: false` and argument arrays; project names, generated paths, package specifiers (including leading-dash option injection), encoded traversal, and NUL are rejected; conflicting lockfiles stop the command; a failed install rolls back all CLI-owned changes. `init --no-install` was fixed to actually skip installation and the automatic check (previously the flag was silently ignored).
- **Integrations:** the registry lists only the 14 real shipped `@sveltex/*` packages and their compatibility metadata. No SMTP, S3, WebSocket, hosted-Redis, or other provider adapter is advertised. `upgrade` reports CLI-owned metadata only — no registry lookup, no guessed versions. `doctor` flags process-local adapters in multi-instance/production setups.
- **CLI output:** stable `CliResult`, single-object `--json` mode, and exit codes `0` (success), `1` (failure), `2` (usage), `3` (project/config/compatibility), `4` (cancelled). `runCli()` never calls `process.exit()` itself, so the API is embeddable and testable.
- **Verification:** `pnpm --filter sveltex test` → 57/57; `npm pack --dry-run` → 173 files (41 templates + 32 `dist/*.js` + 32 `dist/*.d.ts` + metadata), no source/test leakage; real `create` and `init` smoke runs verified generated files, hooks composition, and rollback. `pnpm check` → 450/450 runtime, `pnpm test:security` → 71/71, `pnpm test:types` → 16/16 projects.

**Not claimed:** generated apps have not been installed from a public registry (the workspace packages are unpublished), so a consumer-side `install → typecheck → build` pass remains CI work. The CLI ships no external provider adapters and does not claim distributed durability for any process-local adapter.
