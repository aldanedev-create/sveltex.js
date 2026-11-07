# ADR-003: Explicit Dependency Injection

- **Status:** Accepted in principle; exact API pending implementation.
- **Decision:** Use explicit provider tokens and declared dependencies; do not require decorators or reflection.

## Consequences

- Dependencies are inspectable and testable.
- Provider scopes are explicit.
- TypeScript types are preserved where practical.
- No hidden filesystem scanning or runtime metadata requirement.
