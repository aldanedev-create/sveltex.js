# Core Specification

**Status:** Draft contract for the first implementation.

## Scope

The first core release contains:
- Application instance and state.
- Configuration definition, validation, and normalization.
- Module descriptor and registry.
- Dependency graph validation and ordering.
- Provider registry and DI container.
- Request scope primitive (without SvelteKit dependency).
- Lifecycle initialization and shutdown.
- Typed errors.
- Public package exports.

It does not contain routing, SSR, Vite integration, database clients, auth providers, Redis, jobs, WebSockets, CLI commands, or browser runtime code.

## Runtime requirements

- TypeScript strict mode.
- No import from SvelteKit, Svelte, Vite, Node-only APIs in portable core paths, or browser globals.
- No process-wide mutable application singleton.
- No implicit module auto-discovery.
- No reflection requirement.
- No network or filesystem side effects during core import.
- Public APIs must be exported from the package entry point.

## Application API expectations

The application API should support:
- Construction from validated configuration.
- Explicit module registration.
- Inspection of state and registered module metadata.
- Startup.
- Request-scope creation and disposal.
- Shutdown.
- Rejection of invalid state transitions.

Exact method names and signatures are to be settled with tests before being declared stable.

## Acceptance criteria

- Invalid configuration is rejected before resource initialization.
- Duplicate, missing, and cyclic module dependencies are detected.
- Dependency ordering is deterministic.
- Provider lifetimes behave as specified.
- Concurrent request scopes remain isolated.
- Startup rollback cleans up previously initialized resources.
- Shutdown runs in reverse order and attempts all cleanup.
- Core imports without SvelteKit, Vite, browser globals, or external infrastructure packages.
- Unit, integration, contract, and type tests pass.
