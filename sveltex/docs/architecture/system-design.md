# System Design

## Main runtime entities

### Application

An application instance owns normalized configuration, a module registry, a provider container, lifecycle state, and diagnostics. It should not be a hidden process-wide singleton.

### Module

A module is a named unit of application composition. It declares dependencies, providers, and optionally lifecycle-aware resources. It is not a public plugin.

### Provider

A provider describes how a service is created and which lifetime it uses. Provider construction should be explicit and deterministic.

### Request context

A request context contains data scoped to one incoming request. It must be isolated from every other request and disposed after the request completes.

### Lifecycle manager

The lifecycle manager starts resources in dependency order and stops them in reverse order. It tracks partial startup so failures can be cleaned up.

## Startup sequence

1. Read configuration.
2. Validate and normalize configuration.
3. Register built-in and application modules.
4. Validate module names and dependencies.
5. Build a deterministic dependency graph.
6. Register provider definitions.
7. Validate provider dependency references where statically possible.
8. Initialize application-scoped resources in dependency order.
9. Mark the application ready.

Startup should fail with actionable diagnostics if a required dependency is missing or a module graph is invalid.

## Request sequence

1. SvelteKit receives a request.
2. The SvelteX adapter creates a new request scope.
3. Request-scoped providers are resolved within that scope.
4. The adapter exposes the request context through `event.locals`.
5. The native SvelteKit handler chain continues.
6. The request scope is disposed in a `finally`-equivalent cleanup path.

The adapter must not replace SvelteKit's event or response contracts.

## Shutdown sequence

1. Stop accepting new work when the host environment permits it.
2. Run shutdown hooks in reverse dependency order.
3. Dispose provider instances and external resources.
4. Aggregate cleanup failures without skipping later cleanup.
5. Mark the application stopped.

## Failure behavior

- Configuration errors prevent startup.
- Invalid module graphs prevent startup.
- A failed initializer triggers cleanup of resources already initialized.
- Request cleanup runs even when route code throws.
- Shutdown attempts all registered cleanup operations.
- Errors preserve their original cause where available.

## Concurrency

A singleton may hold application-wide immutable configuration or concurrency-safe services. It must not store current user, current request, cookies, authorization state, or mutable request data.

Request-scoped providers must be isolated per request. Tests must run overlapping requests and verify there is no cross-request data leakage.
