# Package Architecture

## Planned monorepo

```text
sveltex/
├── packages/
│   ├── core/                  # Stage 1
│   ├── sveltekit/             # Stage 2
│   └── cli/                   # Stage 3
├── integrations/
│   ├── database-drizzle/      # Stage 4
│   ├── validation/            # Stage 4
│   ├── auth/                  # Stage 4
│   ├── jobs/                  # Stage 5
│   ├── events/                # Stage 5
│   ├── cache/                 # Stage 5
│   ├── scheduler/              # Stage 5
│   ├── realtime/               # Stage 6
│   ├── mail/                   # Stage 6
│   ├── storage/                # Stage 6
│   └── observability/           # Stage 7
├── tooling/
│   ├── devtools/               # Stage 7
│   └── testing/                # Stage 4+
├── examples/
│   ├── basic/
│   └── taskflow/
├── tests/
│   ├── compatibility/
│   ├── end-to-end/
│   └── stress/
├── docs/
└── ...
```

This is the intended package map, not an instruction to create every package immediately. Packages are added only when their stage begins and their API is sufficiently specified.

## Package dependency direction

```text
CLI ────────────────> SvelteKit adapter ─────> Core
Optional integrations ──────────────────────> Core contracts
Application code ──> SvelteX packages + native SvelteKit APIs
```

Core must not import SvelteKit, Vite internals, browser APIs, database drivers, Redis clients, or provider-specific SDKs. Integration packages may depend on core contracts and their chosen external libraries.

## Package groups

### Foundation packages

- `@sveltex/core`: application instance, configuration, modules, dependency graph, DI, lifecycle, errors.
- `@sveltex/sveltekit`: supported SvelteKit hook and request-context integration.
- `sveltex`: CLI for project creation, generators, diagnostics, and commands.

### Database and application packages

- `@sveltex/database-drizzle`: optional Drizzle integration, connection lifecycle, transaction helpers, and migration conventions. It must expose Drizzle directly and must not become a proprietary ORM.
- `@sveltex/validation`: common validation contracts and adapters for Zod or Standard Schema-compatible libraries. It must not force one schema library on all applications.
- `@sveltex/auth`: authentication primitives and integration contracts. Provider/database choices remain configurable. Authorization policies must be enforced server-side.
- `@sveltex/testing`: test helpers for application instances, request scopes, services, and SvelteKit integration. It supplements—not replaces—Vitest and Playwright.

### Async and infrastructure packages

- `@sveltex/jobs`: job definitions, dispatch contracts, retry policy, and queue-driver interface. Persistent workers run separately where required.
- `@sveltex/events`: typed application event contracts and event dispatch. Cross-process delivery is delegated to a driver.
- `@sveltex/cache`: cache interface, key/TTL conventions, and optional memory/Redis drivers.
- `@sveltex/scheduler`: scheduled task definitions and coordination through an external scheduler or persistent worker. Do not rely on serverless process timers.

### Realtime and external service packages

- `@sveltex/realtime`: realtime channels and authorization contracts. WebSocket transport must be deployment-aware and may require a standalone gateway.
- `@sveltex/mail`: email message and template contracts with provider adapters.
- `@sveltex/storage`: object/file storage contracts with provider adapters. Local filesystem storage is not assumed to exist in every deployment.

### Production tooling

- `@sveltex/observability`: structured logging, metrics, tracing interfaces and integrations.
- `@sveltex/devtools`: development-only diagnostics/dashboard. Must be disabled or protected in production.

## Existing ecosystem integrations

SvelteX does not create a separate plugin SDK or plugin marketplace. Developers continue to use SvelteKit and Vite integrations through their established configuration and APIs. SvelteX packages are first-party framework capabilities, not third-party plugins.

## Package implementation rules

- Every package has its own README, public entry point, export map, tests, and version policy.
- Optional packages are not installed or initialized by core unless explicitly included and configured.
- External integrations are isolated behind small interfaces.
- Package dependency cycles are prohibited.
- Package names and final npm availability must be checked before publishing.
- Do not create empty packages just to reserve names.
