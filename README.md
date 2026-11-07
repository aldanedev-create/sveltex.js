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
│   └── session/   # Versioned session lifecycle and store contract (Stage 3)
├── docs/           # Product specification, architecture, decisions, roadmap
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

- [`@sveltex/core`](packages/core/README.md) — existing foundation
- [`@sveltex/shared`](packages/shared/README.md) — Stage 1
- [`@sveltex/config`](packages/config/README.md) — Stage 1
- [`@sveltex/sveltekit`](packages/sveltekit/README.md) — existing integration
- [`@sveltex/database`](packages/database/README.md) — driver-neutral database lifecycle and transactions
- [`@sveltex/validation`](packages/validation/README.md) — Standard Schema validation
- [`@sveltex/auth`](packages/auth/README.md) — credential authentication orchestration
- [`@sveltex/cache`](packages/cache/README.md) — bounded memory cache and cache contract
- [`@sveltex/session`](packages/session/README.md) — versioned session lifecycle and storage contract

See [`docs/specification.md`](docs/specification.md) for the full package plan, package boundaries, acceptance criteria, and the Stage 5 CLI specification. See [`docs/roadmap.md`](docs/roadmap.md) for current delivery status and [`docs/testing/verification-report.md`](docs/testing/verification-report.md) for exact local test results and verification limitations.

## Important boundaries

- Do not put request-specific mutable state in singleton providers.
- Resolve request-scoped providers only from `locals.sveltex` (or the request context accessor).
- SvelteX does not replace SvelteKit's `sequence`; compose SvelteKit handles with its supported `sequence` utility or use the adapter's `composeHandlers` for structurally compatible handles.
- The adapter does not install process signal handlers or stop the application automatically. Deployment adapters own process shutdown; call `shutdownApplication(app)` from the host's supported shutdown integration if one exists.

## Status

The workspace includes the Core engine, the SvelteKit adapter, a real SvelteKit fixture application, and unit, integration-contract, concurrency, security, lifecycle, stress, compatibility, and public-type tests. Package APIs may change before 1.0. The in-memory cache and session store are development/test implementations, not distributed production stores. Database and authentication integrations require an explicitly selected driver and password hasher. Run `pnpm check` in CI before publishing.
