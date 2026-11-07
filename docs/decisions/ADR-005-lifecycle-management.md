# ADR-005: Explicit Application Lifecycle

- **Status:** Accepted in principle
- **Decision:** The core owns an explicit application state machine and dependency-aware initialization and shutdown.

## Consequences

- Startup ordering is deterministic.
- Partial startup is rolled back.
- Shutdown runs in reverse order and attempts all cleanup.
- Host environments with limited lifecycle guarantees must be documented.
