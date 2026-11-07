# Architecture Overview

## High-level layers

```text
┌───────────────────────────────────────────────────────────┐
│                    Application code                        │
│       Svelte components · routes · services · modules      │
├───────────────────────────────────────────────────────────┤
│                 Optional SvelteX capabilities              │
│  database · auth · jobs · cache · events · observability   │
├───────────────────────────────────────────────────────────┤
│                  SvelteX SvelteKit adapter                 │
│       hooks · request context · event.locals bridge        │
├───────────────────────────────────────────────────────────┤
│                    SvelteX core                            │
│    config · modules · dependency graph · DI · lifecycle    │
├───────────────────────────────────────────────────────────┤
│                    SvelteKit                               │
│ routes · SSR · load · actions · endpoints · adapters       │
├───────────────────────────────────────────────────────────┤
│                    Svelte + Vite                           │
└───────────────────────────────────────────────────────────┘
```

This diagram describes conceptual ownership, not a requirement that every runtime call passes through every layer.

## Package dependency direction

```text
CLI ────────────────┐
                    v
SvelteKit adapter -> Core
Optional packages -> Core public contracts
Application code -> SvelteX packages and native SvelteKit APIs
```

Core must not import SvelteKit, Vite internals, Svelte components, browser APIs, database drivers, Redis clients, or provider-specific SDKs.

## Runtime boundaries

The core is responsible for:
- Creating an application instance.
- Validating and storing normalized configuration.
- Registering modules and their dependencies.
- Building and validating a dependency graph.
- Registering and resolving providers.
- Managing lifecycle transitions and cleanup.
- Exposing typed framework errors.

The SvelteKit adapter is responsible for:
- Translating supported SvelteKit hook events into SvelteX request contexts.
- Attaching request-scoped facilities to `event.locals`.
- Composing with existing SvelteKit hooks using supported APIs.
- Ensuring request cleanup happens reliably.

Optional packages are responsible for their own external resources and capability requirements.

## Important runtime caveat

SvelteKit can run on Node servers, serverless platforms, and edge-like environments. Those environments do not share the same process lifetime or capabilities. SvelteX must not assume that a process remains alive after a request, that a filesystem exists, or that persistent WebSockets are supported.

Capabilities must be explicit, documented, and checked at startup or integration time where possible.
