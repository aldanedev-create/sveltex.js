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

- `@sveltex/validation`: initial Standard Schema-compatible foundation added.
- `@sveltex/cache`: initial bounded in-memory implementation and cache contract added.
- `@sveltex/session`: initial session lifecycle and in-memory store added.
- `@sveltex/database` and `@sveltex/auth`: planned; design their contracts before selecting concrete providers.

**Exit criteria**

- Each package has independent install/build/typecheck/test coverage.
- Database transactions, validation failures, authentication boundaries, cache expiry/invalidation, and session expiry/rotation are tested.
- No package silently imports an optional provider as a mandatory runtime dependency.
- A reference application demonstrates persistence, validation, authentication, authorization, and sessions.

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

- External transports/providers are behind adapters.
- Retries, shutdown, duplicate delivery, failure handling, and authorization are tested.
- Testing helpers can exercise the real packages without requiring live external services.
- Deployment limitations are documented (for example, in-process workers are not a durable distributed queue).

### Stage 5 — Developer experience

**Build last**

- `sveltex` CLI package.
- Project generators.
- Starter templates.
- Interactive setup.
- Diagnostics.
- Upgrade and migration tooling.

The CLI is intentionally last because it must consume stable package APIs and package metadata rather than inventing framework behavior. Its product role is still central: the CLI should be the easiest way for a developer to start a SvelteX project and discover compatible integrations.

**Exit criteria**

- Every official starter is generated from tested templates.
- Generated projects install, type-check, run, test, and build on supported operating systems and package managers.
- Add/remove/generate operations are safe, previewable, and non-destructive.
- Diagnostics explain problems and offer safe fixes without hiding the underlying SvelteKit commands.
- Upgrade tooling detects incompatible versions and applies explicit, reviewable migrations.

## 3. Monorepo package inventory

```text
packages/
├── core/          # Existing — Stage 1
├── shared/        # Stage 1
├── config/        # Stage 1
├── sveltekit/     # Existing — Stage 2
├── database/      # Planned — Stage 3
├── validation/    # Stage 3
├── auth/          # Planned — Stage 3
├── cache/         # Stage 3
├── session/       # Stage 3
├── realtime/      # Planned — Stage 4
├── jobs/          # Planned — Stage 4
├── storage/       # Planned — Stage 4
├── mail/          # Planned — Stage 4
├── testing/       # Planned — Stage 4
└── cli/           # Stage 5 only; do not implement early
```

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

- `fullstack` — recommended starter with SvelteKit, SvelteX core/adapter, and a welcome page.
- `minimal` — minimal SvelteKit + SvelteX wiring, intentionally small.
- `api` — server/API-oriented starter with no unnecessary dashboard UI.
- `dashboard` — application shell and example protected sections; no fake backend behavior.
- `documentation` — content/documentation-oriented SvelteKit starter.

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

This is a target architecture, not an instruction to create the CLI package now.

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
5. Implement Stage 4 capabilities and testing utilities.
6. Build and polish Stage 5 CLI only after the official packages, configuration, integration metadata, and starter examples are stable.

Do not create placeholder packages for every future feature merely to fill the workspace. Each package should begin when its contract and first useful implementation are understood.

## 8. Explicit non-goals

- Replacing SvelteKit routing, rendering, or Vite.
- Requiring every SvelteX package in every application.
- Making the CLI a runtime dependency.
- Hiding SvelteKit's native APIs behind a proprietary abstraction.
- Shipping fake integrations that compile but do not perform their advertised work.
- Claiming distributed durability for in-memory queues, caches, or session stores.
- Building the CLI before the package contracts and templates are proven.


## Stage 3 implementation baseline (2026-11-06)

The initial Stage 3 package implementations are present:

- `@sveltex/database`: driver lifecycle, parameterized query boundary, transaction-scoped executor, shutdown state machine, abort support, and normalized driver errors. A real SQL driver/pool is a separate integration and must be tested against its database engine.
- `@sveltex/validation`: Standard Schema v1 execution, parsed output, normalized/frozen issue paths, malformed schema rejection, and execution-error wrapping.
- `@sveltex/auth`: registration/login orchestration, normalized email lookup, injected password hashing, required precomputed dummy hash, optional attempt limiter, generic invalid-credential result, and session port. MFA, reset, email verification, OAuth, authorization policy, and cookie security are separate concerns.
- `@sveltex/cache`: bounded LRU in-memory cache with TTL validation, injected clock, and expiry cleanup. A shared/distributed driver is required for multi-instance production.
- `@sveltex/session`: data-only deep-cloned session payloads, URL-safe identifiers, atomic create/rotate, revision-based compare-and-set updates, expiry, and collision handling. Production stores must implement those atomic operations transactionally.

Every package is expected to pass strict type checking, public API type tests, unit tests, security tests, package export checks, and integration tests for each real provider adapter before a stable release. Current local results and known gaps are recorded in [the verification report](./testing/verification-report.md).
