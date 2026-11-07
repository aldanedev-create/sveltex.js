# @sveltex/core

The framework-independent application engine for **SvelteX**. Core owns application configuration, explicit modules, dependency ordering, asynchronous dependency injection, request scopes, and application lifecycle management.

> SvelteX is designed to sit on top of SvelteKit. This package does not implement routing, SSR, hydration, rendering, Vite, compilation, or deployment adapters.

## Status

This is the initial Core implementation (`0.1.0`). It is a working foundation with strict TypeScript types and automated tests. It is not yet a declaration of a stable 1.x public API. Run the complete checks before adopting it in an application.

## Requirements

- Node.js 20.11 or newer for the supported server runtime.
- TypeScript 5.5 or newer when developing from source.
- No runtime dependencies.

## Install and build

```bash
pnpm add @sveltexjs/core
```

For local development:

```bash
pnpm install
pnpm build
pnpm test
pnpm run test:types
pnpm run check
pnpm run test:coverage
```

## Quick start

```ts
import {
  createApplication,
  defineModule,
  token,
} from '@sveltexjs/core';

interface Logger {
  info(message: string): void;
}

const LOGGER = token<Logger>('app.logger');

const loggingModule = defineModule({
  name: 'logging',
  providers: [
    {
      provide: LOGGER,
      useValue: {
        info(message) {
          console.info(message);
        },
      },
    },
  ],
  exports: [LOGGER],
  onStart() {
    // Initialize module-owned resources here, if any.
  },
  onStop() {
    // Release module-owned resources here, if any.
  },
});

const app = createApplication({
  config: {
    name: 'taskflow',
    environment: 'production',
    debug: false,
  },
  modules: [loggingModule],
});

await app.start();
const logger = await app.resolve(LOGGER);
logger.info('SvelteX Core is running');

await app.stop();
```

In a SvelteKit server, the future `@sveltexjs/sveltekit` package will own the bridge from SvelteKit's `handle` hook and request event into Core. Do not create a second router or SSR layer in Core.

## Modules

Modules are explicit, immutable descriptors. There is no filesystem scanning, dynamic plugin loader, or automatic discovery.

```ts
import { defineModule, token } from '@sveltexjs/core';

interface Database {
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

const DATABASE = token<Database>('infra.database');
const USERS = token<{ count(): Promise<number> }>('users.service');

const databaseModule = defineModule({
  name: 'database',
  providers: [
    {
      provide: DATABASE,
      useFactory: async () => {
        const database = await connectToDatabase();
        return {
          query: (sql) => database.query(sql),
          close: () => database.close(),
          dispose: () => database.close(),
        };
      },
    },
  ],
  exports: [DATABASE],
});

const usersModule = defineModule({
  name: 'users',
  dependencies: ['database'],
  providers: [
    {
      provide: USERS,
      useFactory: ({ resolve }) => ({
        async count() {
          const db = await resolve(DATABASE);
          await db.query('select count(*) from users');
          return 0;
        },
      }),
    },
  ],
  exports: [USERS],
});
```

The example's `connectToDatabase()` is application code, not a Core API. A real database adapter belongs in a separate SvelteX integration package.

### Module rules

- Names must be non-empty and unique.
- Every dependency must name a registered module.
- Self-dependencies and dependency cycles are rejected.
- Providers are registered once across the application; duplicate tokens are rejected.
- Modules initialize dependency-first. Shutdown and rollback run in reverse order.
- `exports` records the module's intended public tokens. It is metadata for architecture/tooling; it is **not** an authorization or isolation boundary in this initial release.

## Dependency injection

Core deliberately avoids runtime reflection. Every constructor/factory dependency is declared explicitly.

```ts
const CLOCK = token<{ now(): Date }>('system.clock');
const GREETER = token<{ greet(name: string): Promise<string> }>('app.greeter');

const providers = [
  { provide: CLOCK, useValue: { now: () => new Date() } },
  {
    provide: GREETER,
    useFactory: ({ resolve }) => ({
      async greet(name: string): Promise<string> {
        return `Hello ${name} at ${(await resolve(CLOCK)).now().toISOString()}`;
      },
    }),
  },
];
```

Factories resolve their dependencies explicitly through `context.resolve()`. Class providers use the `inject` array to supply constructor arguments. This keeps dependency relationships visible without runtime reflection.

### Provider forms

```ts
{ provide: TOKEN, useValue: value }
{ provide: TOKEN, useFactory: async ({ resolve }) => value }
{ provide: TOKEN, useClass: ServiceClass, inject: [DEPENDENCY] }
```

Each provider must specify exactly one construction strategy.

### Scopes

| Scope | Behavior |
|---|---|
| `singleton` (default) | One instance per application root. Concurrent resolutions share the same in-flight factory promise. |
| `request` | One instance per request scope. Root resolution is rejected. Different requests never share the instance. |
| `transient` | A new instance for each resolution. |

A singleton must not depend on a request-scoped provider. Request-scoped values must never be stored in singleton mutable state.

### Disposal

Instances may expose `dispose(): void | Promise<void>`. Core calls it in reverse construction order. If an object exposes `dispose`, that method is the supported disposal contract for this release.

- A failed singleton factory is not cached permanently; a later resolution may retry.
- In-flight provider factories are awaited during disposal so a late-created disposable is not leaked.
- Root disposal also closes request scopes that are still active.
- All cleanup handlers are attempted. Cleanup errors are reported together in `SvelteXAggregateError`.

## Application lifecycle

```ts
const app = createApplication({ config: { name: 'api' }, modules: [] });

await app.start(); // idempotent for concurrent callers
const request = app.createRequestScope();
try {
  const service = await request.resolve(SOME_REQUEST_SERVICE);
  // Handle one request.
} finally {
  await request.dispose();
}
await app.stop(); // idempotent; closes any remaining request scopes
```

Application states:

`created -> starting -> running -> stopping -> stopped`

A startup failure moves the app to `failed`. The lifecycle manager attempts to stop the module whose startup failed (to clean partial setup), stops previously started modules in reverse order, and disposes the container. An app instance cannot be restarted after it has stopped or failed; create a new instance instead.

`start()` and `stop()` should be called by the host application's server lifecycle. Do not assume that a serverless deployment will preserve a process between invocations. Do not start persistent workers, schedulers, or WebSocket servers from a generic module hook unless the deployment target explicitly supports them.

## Configuration

```ts
import { defineConfig } from '@sveltexjs/core';

export default defineConfig({
  name: 'taskflow',
  environment: 'development',
  debug: true,
  metadata: { region: 'local' },
});
```

`defineConfig()` clones and freezes plain objects and arrays. `createApplication()` validates the core configuration. Core does not read `.env`, process environment variables, files, or remote configuration; that belongs to the host or a future configuration adapter.

Required: `name` (non-empty string). Optional: `environment`, `debug`, and plain-object `metadata`.

## Error handling

All framework-defined errors extend `SvelteXError` and expose a stable `code` plus immutable `details`. Preserve the original error as `cause` when wrapping failures. Lifecycle cleanup failures use `SvelteXAggregateError`, which extends the platform `AggregateError` and exposes normalized errors in `causes`.

Common codes include:

- `SX_CONFIG_INVALID`
- `SX_APP_INVALID_STATE`
- `SX_MODULE_INVALID`, `SX_MODULE_DUPLICATE`, `SX_MODULE_MISSING_DEPENDENCY`, `SX_MODULE_CYCLE`
- `SX_PROVIDER_INVALID`, `SX_PROVIDER_DUPLICATE`, `SX_PROVIDER_NOT_FOUND`, `SX_PROVIDER_SCOPE_VIOLATION`
- `SX_DI_CYCLE`

## Public API

- `createApplication`, `Application`
- `defineConfig`, `validateConfig`, `SvelteXConfig`
- `defineModule`, `ModuleRegistry`, `orderModules`, `ModuleDefinition`
- `token`, `InjectionToken`, `Provider`, `ProviderRegistry`, `Container`
- `SvelteXError`, `SvelteXAggregateError`
- `ApplicationState`, `CreateApplicationOptions`

## Boundaries and non-goals

Core intentionally does not implement:

- SvelteKit routing, hooks, `event.locals`, SSR, hydration, or page rendering.
- Svelte compiler integration, Vite, bundling, or deployment adapters.
- A database, ORM, authentication provider, cache server, queue, scheduler, mail transport, file storage, or WebSocket server.
- A plugin marketplace or third-party plugin loader.
- Authorization policy enforcement. DI visibility is not a security boundary.
- Automatic environment loading, filesystem scanning, or network calls.

Those capabilities belong in the SvelteKit bridge or separate SvelteX integration packages.

## Development quality gates

Before merging changes:

```bash
pnpm run check
```

The expanded suite contains 72 automated tests across unit, security, stress, and runtime-compatibility categories. The current local baseline is 98.82% line coverage, 96.24% branch coverage, and 96.65% function coverage. See [docs/TESTING.md](docs/TESTING.md) for the coverage map, commands, CI matrix, and limitations. CI is configured for Node.js 20.11, 22, and 24 on Linux, Windows, and macOS.
