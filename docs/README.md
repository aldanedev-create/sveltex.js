# SvelteX

**Build beyond the framework.**

SvelteX is a proposed modular full-stack application framework built on top of SvelteKit. It aims to provide an integrated application architecture and backend capabilities while preserving SvelteKit's conventions and escape hatches.

> **Project status:** Early implementation baseline. `@sveltex/core` and `@sveltex/sveltekit` are existing packages. Initial Stage 1 `@sveltex/shared` and `@sveltex/config`, and Stage 3 `@sveltex/validation`, `@sveltex/cache`, and `@sveltex/session` foundations are now present. The workspace is not yet published or production-certified; verify the full SvelteKit fixture and deployment matrix in CI before release.

## Core principle

SvelteKit remains the web application foundation. SvelteX must not replace its router, server-side rendering, hydration, form actions, load functions, endpoints, compiler, Vite integration, or deployment adapters.

SvelteX adds higher-level application capabilities such as configuration, modules, dependency injection, lifecycle management, and—after the core—optional infrastructure integrations.

## Documentation map

- [Vision and goals](docs/vision.md)
- [Architecture overview](docs/architecture/overview.md)
- [System design](docs/architecture/system-design.md)
- [Package architecture](docs/architecture/package-architecture.md)
- [Configuration](docs/architecture/configuration.md)
- [Module system](docs/architecture/module-system.md)
- [Dependency injection](docs/architecture/dependency-injection.md)
- [Application lifecycle](docs/architecture/application-lifecycle.md)
- [Error handling](docs/architecture/error-handling.md)
- [Core specification](docs/specifications/core-specification.md)
- [Module specification](docs/specifications/module-specification.md)
- [Container specification](docs/specifications/container-specification.md)
- [Lifecycle specification](docs/specifications/lifecycle-specification.md)
- [Testing strategy](docs/testing/testing-strategy.md)
- [Test requirements](docs/testing/test-requirements.md)
- [Architecture decisions](docs/decisions/)
- [Product and package specification](specification.md)
- [Roadmap](roadmap.md)

## Current design boundaries

1. SvelteKit owns web routing and rendering.
2. SvelteX core is framework-independent TypeScript.
3. No separate SvelteX plugin ecosystem is planned.
4. Use existing SvelteKit and Vite integrations when integrations are needed.
5. Prefer explicit APIs and predictable behavior over reflection or hidden magic.
6. Every feature is specified and tested before it is considered stable.

## Development sequence

1. Preserve and harden the existing Core and SvelteKit adapter.
2. Complete Stage 1 Shared and Config foundations.
3. Complete Stage 3 essential backend packages independently.
4. Build Stage 4 advanced capabilities and testing helpers.
5. Implement the CLI, generators, templates, diagnostics, and upgrade tooling last.
6. Publish only after package-specific checks and the SvelteKit fixture pass in CI.
