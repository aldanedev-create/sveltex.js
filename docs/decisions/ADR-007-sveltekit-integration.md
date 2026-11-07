# ADR-007: Integrate Through Supported SvelteKit APIs

- **Status:** Accepted in principle
- **Decision:** Use supported SvelteKit hooks, request events, and `event.locals`; preserve native hook composition.

## Consequences

- The adapter remains thin.
- Existing SvelteKit route files and handlers remain unchanged.
- Hook composition and ordering receive compatibility tests.
- No private SvelteKit internals.
