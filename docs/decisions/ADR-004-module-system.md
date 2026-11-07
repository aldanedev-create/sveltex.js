# ADR-004: Internal Application Modules, Not a Plugin Ecosystem

- **Status:** Accepted
- **Decision:** SvelteX has an internal module registry for composing an application. It will not define a separate public SvelteX plugin format or plugin marketplace.

## Context

SvelteKit and Vite already have established integration mechanisms. A second plugin ecosystem would add complexity and fragment the ecosystem.

## Consequences

- Application modules organize the user's own services and dependencies.
- Existing SvelteKit/Vite plugins remain the integration path.
- No `@sveltex/plugins` package or Plugin SDK is planned.
