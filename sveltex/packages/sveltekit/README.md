# @sveltex/sveltekit

SvelteKit integration for SvelteX. SvelteKit remains responsible for its normal application structure and request lifecycle; this package supplies a SvelteX request scope through `event.locals`.

## Install

```bash
pnpm add @sveltex/core @sveltex/sveltekit
```

SvelteKit 2+ is a peer integration. It is not imported at runtime by this adapter.

## Configure

```ts
// src/lib/server/sveltex.ts
import { createApplication, token } from '@sveltex/core';
export const CurrentUser = token<{ id: string } | null>('current-user');
export const app = createApplication({
  config: { name: 'my-app' },
  modules: [{
    name: 'users',
    providers: [{ provide: CurrentUser, scope: 'request', useValue: null }]
  }]
});
```

```ts
// src/hooks.server.ts
import { createSvelteXHandler } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';
export const handle = createSvelteXHandler(app);
```

If you already have a SvelteKit handle, use SvelteKit's `sequence` so your existing behavior remains intact:

```ts
import { sequence } from '@sveltejs/kit/hooks';
import { createSvelteXHandler } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';
import { existingHandle } from '$lib/server/handle';
export const handle = sequence(createSvelteXHandler(app), existingHandle);
```

SvelteKit's `sequence` is the recommended composition API inside a real SvelteKit app. `composeHandlers` is also exported for generic compatible handle functions and isolated tests.

## Use services

```ts
// src/routes/+page.server.ts
import { CurrentUser } from '$lib/server/sveltex';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) => {
  const user = await locals.sveltex.resolve(CurrentUser);
  return { user };
};
```

`locals.sveltex` is request-scoped. The adapter attaches it as a non-enumerable, non-writable property and removes it after `resolve` completes. A pre-existing property with the configured key causes a clear error rather than being overwritten.

## Options

```ts
createSvelteXHandler(app, {
  localsKey: 'services',
  autoStart: true,
  onRequestDisposed(context) {
    // Optional metrics/diagnostics. Do not retain request context here.
  }
});
```

| Option | Default | Meaning |
|---|---|---|
| `localsKey` | `sveltex` | Property used on `event.locals` |
| `autoStart` | `true` | Start the application on first request |
| `onRequestDisposed` | — | Callback after request-scope disposal |

With `autoStart: false`, start the application before requests are handled. `initializeApplication(app)` is exported for this purpose.

## Request context API

- `locals.sveltex.resolve(token)` resolves a dependency in the current request scope.
- `locals.sveltex.request` is the incoming `Request`.
- `locals.sveltex.url` is the parsed request URL.
- `locals.sveltex.params` is a frozen snapshot of route params.
- `locals.sveltex.dispose()` disposes the request scope (idempotently).

You can also use `getSvelteXContext(locals, key?)` in shared server utilities.

## Lifecycle and deployment

Application startup is lazy and concurrent first requests share one startup promise. Each request receives a new request container. Request disposal runs in `finally`, including when route resolution throws. `shutdownApplication(app)` stops new requests, waits for in-flight SvelteX requests to finish cleanup, and then stops Core. `getActiveRequestCount(app)` is available for diagnostics. The adapter intentionally does not install Node process listeners: serverless and edge-style deployments do not share a universal shutdown contract. Use the hosting platform's shutdown lifecycle to call `shutdownApplication(app)` where supported.

## Graceful shutdown

```ts
import { shutdownApplication } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';

// Call from a host-provided graceful-shutdown callback.
await shutdownApplication(app);
```

Do not stop the application after an individual request. On serverless or edge platforms without a reliable shutdown callback, allow the platform to manage process lifetime.

## Errors

The adapter does not catch or transform errors thrown by SvelteKit routes. This preserves SvelteKit redirects and HTTP errors. `normalizeAdapterError` is only for errors created by adapter-owned utilities; it should not be used to wrap route errors.

## Testing

```bash
pnpm --filter @sveltex/sveltekit test
pnpm --filter @sveltex/sveltekit test:security
pnpm --filter @sveltex/sveltekit test:stress
```

The suite exercises the Handle contract with structural event fixtures. Run an additional end-to-end test against each SvelteKit version and deployment adapter supported by your application.
