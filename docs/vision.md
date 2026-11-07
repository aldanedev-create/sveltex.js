# SvelteX Vision

## Purpose

SvelteKit is an excellent web application framework, but larger applications still need decisions and implementation for service organization, dependency management, application lifecycle, background processing, authentication, database access, observability, and testing conventions.

SvelteX aims to provide a cohesive, optional layer for those application-level concerns.

## Positioning

- **Svelte**: UI components and reactivity.
- **SvelteKit**: routing, server rendering, load functions, form actions, endpoints, application hooks, and deployment adapters.
- **Vite**: development server and build tooling used by the SvelteKit toolchain.
- **SvelteX**: application architecture, service composition, lifecycle, and optional backend infrastructure integrations.

SvelteX is not a replacement for any of the above.

## Goals

- Provide a clear modular structure for full-stack applications.
- Provide typed configuration with validation.
- Provide explicit dependency injection and lifecycle management.
- Integrate with SvelteKit without breaking its standard conventions.
- Make request-scoped state safe under concurrent traffic.
- Offer a useful CLI and generators once APIs are stable.
- Provide reliable tests, diagnostics, and documentation.
- Allow developers to use ordinary TypeScript and existing ecosystem packages.

## Non-goals

- Creating another router.
- Reimplementing SSR, hydration, or Svelte compilation.
- Replacing Vite or SvelteKit adapters.
- Building a proprietary ORM when established libraries already exist.
- Requiring developers to use SvelteX abstractions for every task.
- Creating a separate public SvelteX plugin ecosystem.
- Promising that every deployment platform supports persistent workers or WebSockets.

## Design values

### Explicit over magical

Dependencies, module relationships, scopes, and lifecycle hooks should be inspectable. Avoid reflection-based discovery and surprising global state.

### Composable over monolithic

The core should remain small. Optional capabilities should be separate packages or adapters and should not be initialized unless configured and used.

### Native conventions first

A SvelteX application remains a SvelteKit application. Existing `src/routes`, `+page.server.ts`, `+server.ts`, `hooks.server.ts`, `vite.config.ts`, and SvelteKit adapter configuration remain valid.

### Safe by default

Request-specific data must never leak across requests. Authentication and authorization must be enforced on the server. Production diagnostics must not expose secrets.

### Testable by design

Public contracts, failure behavior, concurrency, cleanup, and compatibility are part of the specification—not afterthoughts.
