# ADR-002: Core Is Framework-Independent

- **Status:** Accepted
- **Decision:** `@sveltex/core` must not depend on SvelteKit, Svelte, or Vite.

## Context

A framework-independent core is easier to unit test, reuse, reason about, and maintain.

## Consequences

- SvelteKit-specific request and hook types live in the adapter package.
- Core uses its own small contracts.
- No browser or host-framework globals in core.
- Package dependency direction is enforced in CI.
