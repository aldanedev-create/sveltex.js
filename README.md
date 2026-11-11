# SvelteX

**A SvelteKit-native application framework with a modular backend engine.**

SvelteKit owns routing, rendering, server loads, actions, endpoints, and the HTTP lifecycle. SvelteX adds an application container, modules, dependency injection, lifecycle hooks, and isolated request scopes.

## Monorepo

```text
sveltex/
├── packages/
│   ├── core/       # Existing framework-independent application engine
│   ├── shared/     # Shared types, errors, and utilities (Stage 1)
│   ├── config/     # Configuration helpers (Stage 1)
│   ├── sveltekit/  # Existing SvelteKit Handle adapter (Stage 2)
│   ├── database/  # Driver-neutral database lifecycle and transactions (Stage 3)
│   ├── validation/# Standard Schema validation (Stage 3)
│   ├── auth/      # Credential auth orchestration ports (Stage 3)
│   ├── cache/     # Cache contracts and bounded memory cache (Stage 3)
│   ├── session/   # Versioned session lifecycle and store contract (Stage 3)
│   ├── realtime/  # Typed channels + in-process transport (Stage 4)
│   ├── jobs/      # Queue, retries, worker lifecycle (Stage 4)
│   ├── storage/   # Storage contract + local filesystem driver (Stage 4)
│   ├── mail/      # Message/template contract + test transport (Stage 4)
│   ├── testing/   # Builders over real core DI (Stage 4)
│   └── cli/       # `sveltex` CLI — 17 commands, six templates (Stage 5, built last)
├── examples/       # Stage 3 reference application
├── docs/           # Product specification, architecture, decisions, roadmap, audit
├── pnpm-workspace.yaml
└── turbo.json
```

## Requirements

- Node.js 20.11 or newer
- pnpm 10+
- SvelteKit 2+ in applications using the adapter

## Install and verify

```bash
corepack enable
pnpm install
pnpm check
```

## Quick start

```ts
// src/lib/server/sveltex.ts
import { createApplication, token } from '@sveltex/core';

export const Greeting = token<string>('greeting');
export const app = createApplication({
  config: { name: 'my-sveltekit-app' },
  modules: [{
    name: 'greetings',
    providers: [{ provide: Greeting, useValue: 'Hello from SvelteX' }]
  }]
});
```



```ts
// src/hooks.server.ts
import { createSvelteXHandler } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';

export const handle = createSvelteXHandler(app);
```

```ts
// src/routes/+page.server.ts
import { Greeting } from '$lib/server/sveltex';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
  greeting: await locals.sveltex.resolve(Greeting)
});
```

The adapter starts the application on the first request, coalesces concurrent startup attempts, creates a fresh DI request scope for every request, exposes it as `event.locals.sveltex`, and disposes it in a `finally` block. The application root and singleton services remain shared by the application instance. `shutdownApplication(app)` stops new requests, drains in-flight SvelteX requests, and then stops Core.

## Development

```bash
corepack enable
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for workspace checks and package boundaries.

## Packages and delivery stages

The monorepo follows five stages: Foundation, SvelteKit integration, Essential backend packages, Advanced capabilities, and Developer experience. The CLI is deliberately the final implementation stage, although developers will be able to install and use it first. Existing Core and SvelteKit packages are preserved rather than recreated.

**All five stages are now implemented and verified.** The `sveltex` CLI was built last, after the package contracts were stable; it is a development tool and generated applications never depend on it at runtime.

- [`@sveltex/core`](packages/core/README.md) — existing foundation
- [`@sveltex/shared`](packages/shared/README.md) — Stage 1
- [`@sveltex/config`](packages/config/README.md) — Stage 1
- [`@sveltex/sveltekit`](packages/sveltekit/README.md) — existing integration
- [`@sveltex/database`](packages/database/README.md) — driver-neutral database lifecycle and transactions
- [`@sveltex/validation`](packages/validation/README.md) — Standard Schema validation
- [`@sveltex/auth`](packages/auth/README.md) — credential authentication orchestration
- [`@sveltex/cache`](packages/cache/README.md) — bounded memory cache and cache contract
- [`@sveltex/session`](packages/session/README.md) — versioned session lifecycle and storage contract
- [`@sveltex/realtime`](packages/realtime/README.md) — Stage 4 — typed channels, required authorization, in-process transport
- [`@sveltex/jobs`](packages/jobs/README.md) — Stage 4 — queue, retries/backoff, worker lifecycle
- [`@sveltex/storage`](packages/storage/README.md) — Stage 4 — storage contract + local filesystem driver
- [`@sveltex/mail`](packages/mail/README.md) — Stage 4 — message/template contract + test transport
- [`@sveltex/testing`](packages/testing/README.md) — Stage 4 — builders over real core DI
- [`sveltex`](packages/cli/README.md) — Stage 5 CLI — built last; 17 commands and six official templates

See [`docs/specification.md`](docs/specification.md) for the full package plan, package boundaries, acceptance criteria, and the Stage 5 CLI specification. See [`docs/roadmap.md`](docs/roadmap.md) for current delivery status and [`docs/testing/verification-report.md`](docs/testing/verification-report.md) for exact local test results and verification limitations.

## Important boundaries

- Do not put request-specific mutable state in singleton providers.
- Resolve request-scoped providers only from `locals.sveltex` (or the request context accessor).
- SvelteX does not replace SvelteKit's `sequence`; compose SvelteKit handles with its supported `sequence` utility or use the adapter's `composeHandlers` for structurally compatible handles.
- The adapter does not install process signal handlers or stop the application automatically. Deployment adapters own process shutdown; call `shutdownApplication(app)` from the host's supported shutdown integration if one exists.

## Status

All five stages are implemented and verified, and completion-plan Phases 0–4 (audit, database ORM integrations, auth, sessions, cache) are delivered: 734 runtime tests, 119 security tests, and 16 type-test projects pass under `pnpm check` / `pnpm test:security` (0 failures, 0 skipped) with live PostgreSQL 16, MySQL 8.0 and Redis 7 services. The `@sveltex/database` package now ships real PostgreSQL (`pg.Pool`) and MySQL (`mysql2` pool) adapters, driver-neutral migrations, connection pooling, and optional ORM integrations (Drizzle/Kysely behind optional peers, plus BYO ORM adapters), all covered by integration tests against real servers. The workspace includes 15 packages, a real SvelteKit fixture application, and a Stage 3 reference application. Package APIs may change before 1.0. The in-memory cache/session stores and all Stage 4 process-local adapters are explicitly **not** distributed production stores; each README documents the limitation and `sveltex doctor` flags multi-instance mismatches. Database and authentication integrations require an explicitly selected driver and password hasher. The CLI ships no external provider adapters and makes no registry lookups. Phase 4 completed `@sveltex/cache` with a strict versioned serialization envelope, escaped namespaces, key/prefix/predicate/tag invalidation (tag generations via real Redis `INCR`), an observable graceful-fallback circuit breaker, and process-local single-flight with TTL jitter.

Not yet claimed: workspace packages are unpublished, so a consumer-side `install → typecheck → build` of a CLI-generated app against registry-published packages, plus Node/OS CI matrices and clean-install verification, remain CI/release work. CI now provisions PostgreSQL 16, MySQL 8.0 and Redis 7 services and runs both `pnpm check` and `pnpm test:security`; an ORM integration layer (Drizzle/Kysely + BYO) is shipped with real PostgreSQL tests, while built-in Prisma/MikroORM/TypeORM adapters, cross-process migration locking and connection retry/failover remain out of scope. The [Existing Package Completion Plan](docs/completion-plan.md) drives package-by-package completion (Phases 0–4 delivered: audit, database ORM integrations, auth, sessions, and cache — see the [Phase 4 report](docs/completion/phase-4-cache.md); Phases 5–12 remain). Run `pnpm check` in CI before publishing.
