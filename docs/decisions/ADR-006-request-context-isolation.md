# ADR-006: Request Context Must Be Isolated

- **Status:** Accepted
- **Decision:** Request-scoped providers are owned by an individual request scope. No mutable global current-request state is allowed.

## Consequences

- Concurrent requests must not share request-scoped instances.
- SvelteKit adapter creates and disposes the scope per request.
- Singleton services must be safe for concurrent use.
