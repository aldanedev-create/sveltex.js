# Application Lifecycle

## States

The initial state model is:

```text
created -> configuring -> initializing -> ready -> stopping -> stopped
                         \-> failed
```

Illegal transitions must fail clearly. The implementation should define whether a failed application can be retried; the initial recommendation is to require a new application instance.

## Startup

- Validate configuration and module graph before opening resources.
- Initialize dependencies before dependents.
- Record each successfully initialized resource.
- If initialization fails, clean up successfully initialized resources in reverse order.
- Preserve the original startup error and report cleanup errors separately.

## Shutdown

- Run shutdown hooks in reverse initialization order.
- Attempt all cleanup operations even if one fails.
- Support an idempotent shutdown call.
- Define timeout behavior without silently abandoning cleanup.
- Do not assume every host environment provides reliable process shutdown events.

## Hooks

Lifecycle hooks should have narrow contracts and documented ordering. Avoid an unbounded collection of implicit hook names. Hooks should receive a typed application context, not unrestricted mutable global state.

## Serverless environments

Application lifetime can be reused across requests but is not guaranteed to persist. SvelteX must not rely on in-process background work continuing after a response. Persistent workers should run as a separate process or managed service.
