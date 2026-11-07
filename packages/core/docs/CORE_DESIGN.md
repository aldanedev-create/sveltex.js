# SvelteX Core — implementation design

## Responsibilities

`@sveltex/core` is the framework-independent runtime layer. It owns an application instance, validated configuration, explicit module definitions, dependency graph resolution, provider registration, dependency injection, request-scope primitives, and application lifecycle orchestration.

It intentionally does not own HTTP, routing, SSR, hydration, rendering, Vite, compilation, database clients, authentication, job processing, caching, or deployment adapters. Those are host-framework or integration-package responsibilities.

## Runtime object graph

```text
Application
├── immutable SvelteXConfig
├── ModuleRegistry
│   └── ModuleDefinition[]
├── LifecycleManager
└── root Container
    ├── ProviderRegistry
    ├── singleton instances
    └── active request Containers
        ├── request instances
        └── transient instances created in that request
```

The application owns its container. The root container owns singleton instances and tracks active request scopes. A request container shares the provider registry and singleton cache but owns its request and transient instances. Disposing the root closes outstanding request scopes before disposing root-owned instances.

## Startup algorithm

1. Validate core configuration during application construction.
2. Accept module registration only while the application is in `created` state.
3. Lock module registration when startup begins.
4. Validate the complete module dependency graph.
5. Produce a stable dependency-first topological order.
6. Validate and register all provider definitions before invoking module hooks.
7. Seal the root container so providers cannot be added after initialization begins.
8. Run module `onStart` hooks serially in dependency order.
9. Mark the application `running` only after all hooks succeed.

A module is recorded as started immediately before its `onStart` hook executes. If that hook fails after partial setup, its own `onStop` hook is therefore called during rollback.

## Rollback and shutdown

Startup failure triggers reverse-order `onStop` hooks for every module whose startup was entered, then container disposal. Rollback continues after individual cleanup errors. The original startup error is preserved; when rollback also fails, all failures are reported through `SvelteXAggregateError`.

Normal shutdown runs module `onStop` hooks in reverse startup order and then disposes the root container. Cleanup errors do not prevent later cleanup handlers from running. The application ends in `stopped`, even if cleanup reported errors. A stopped or failed application is not restartable; create a new instance.

## Dependency injection

Tokens are explicit strings, symbols, or class constructors. No design-time type reflection is used. Providers select exactly one strategy:

- `useValue`: externally constructed value; always singleton.
- `useFactory`: synchronous or asynchronous factory with an explicit `ResolutionContext.resolve()` function.
- `useClass`: constructor plus explicit `inject` token array.

All resolution is asynchronous, giving factories one consistent contract. Singleton creation is memoized as an in-flight promise so concurrent callers share one construction. A failed construction is removed from the cache, allowing a later attempt. Dependency paths are carried through nested resolution to report cycles.

## Lifetime rules

- `singleton`: owned by the root container.
- `request`: owned by a request container; unavailable from the root.
- `transient`: constructed for each resolution and owned by the container that requested it.

A singleton cannot resolve a request-scoped dependency because singleton construction runs against the root container. This prevents request data from leaking into process-wide instances.

## Disposal

An instance may implement `dispose(): void | Promise<void>`. The container records cleanup in construction order and executes it in reverse. It awaits in-flight factories before cleanup, ensuring a factory that finishes while shutdown is in progress cannot create an untracked disposable. Concurrent calls to `dispose()` share one promise.

A factory that never settles will hold disposal open. Provider factories must therefore be bounded by their own connection and operation timeouts. Core does not forcibly cancel arbitrary user promises.

## Concurrency and isolation

There is no process-wide application singleton. Every `createApplication()` call returns an independent instance. Singleton caches are scoped to that instance. Request scopes are independent and can be used concurrently. Provider registries are sealed before application hooks run.

## Deployment assumptions

Core does not assume a persistent process, writable filesystem, background worker, timer, or WebSocket capability. The host integration must determine when an application instance is created and stopped and whether long-lived resources are supported by the deployment platform.

## Public API stability

The initial release is `0.1.0`. Public method names and contracts should be treated as pre-1.0. Breaking changes may occur before `1.0.0`; update the contract tests and migration notes whenever they do.
