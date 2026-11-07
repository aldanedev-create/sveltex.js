# Application and request lifecycle

## Startup

`createSvelteXHandler(app)` starts Core lazily on the first request. All concurrent first requests share the same startup promise. If the application is already started manually, the adapter reuses it. With `autoStart: false`, call `initializeApplication(app)` before accepting requests.

## Request lifecycle

For each request, the adapter:

1. Acquires an application request lease.
2. Creates a fresh Core request scope.
3. Attaches the context to `event.locals[localsKey]`.
4. Invokes the next SvelteKit handle / route resolver.
5. Disposes the request scope.
6. Removes only the locals property installed by this adapter.
7. Invokes `onRequestDisposed`, if configured, and releases the request lease.

The context is request-local; it is not stored in process-global mutable state. Its `params` value is a frozen snapshot. A disposed context rejects further dependency resolution.

## Graceful shutdown

Call `shutdownApplication(app)` from a shutdown hook supplied by your hosting platform. The adapter stops accepting new requests, waits for requests already inside its handler to finish and dispose their scopes, then calls `app.stop()`.

```ts
import { shutdownApplication } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';

// Invoke from your platform's supported graceful-shutdown callback.
await shutdownApplication(app);
```

The adapter deliberately does not register `process` listeners or assume a persistent Node process. SvelteKit deployments vary: serverless and edge hosts may not provide a reliable application shutdown callback. In those environments, let the platform manage process lifetime and do not attempt to stop a shared application after each request.

`getActiveRequestCount(app)` is available for diagnostics. A shutdown waits for active SvelteX requests; ensure downstream handlers and routes eventually settle.
