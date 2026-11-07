# Dependency Injection

## Goals

SvelteX DI should be explicit, typed, lightweight, and testable. It should not depend on decorators, runtime reflection, or hidden filesystem scanning.

## Provider lifetimes

### Singleton

One instance per application container. Suitable for immutable configuration and concurrency-safe shared services.

### Request

One instance per request scope. Suitable for request context, current-user accessors, and request-bound services.

### Transient

A new instance for each resolution. Suitable for lightweight stateless services where repeated construction is intended.

## Proposed provider concept

```ts
const providers = [
  {
    token: TaskRepository,
    useClass: TaskRepository,
    lifetime: 'singleton'
  },
  {
    token: TaskService,
    useFactory: (repository) => new TaskService(repository),
    inject: [TaskRepository],
    lifetime: 'transient'
  }
];
```

This is a conceptual shape; exact typing and ergonomics are implementation decisions.

## Required behavior

- Tokens must be explicit and stable.
- Missing providers produce actionable errors.
- Circular provider dependencies are detected.
- Singleton construction is concurrency-safe: concurrent resolutions must not create duplicate instances.
- Request scopes are independent.
- Disposing a request scope disposes its owned resources.
- Transient disposal ownership must be documented and deterministic.
- Provider construction failures preserve their cause.
- Async factories are supported only with clearly defined resolution semantics.

## Safety rules

Never place request-specific mutable state in singleton services. Do not make a global "current request" variable. A request scope must be passed or accessed through the request's own context.

## Testing

Test each lifetime, nested dependencies, async factories, missing tokens, cycles, concurrent singleton resolution, request isolation, and cleanup after failures.
