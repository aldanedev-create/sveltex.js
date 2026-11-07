# ADR-010: Public API Stability

- **Status:** Proposed
- **Decision:** Only package entry-point exports are public. Internal paths are private implementation details.

## Consequences

- Package export maps define supported imports.
- Breaking changes require migration notes.
- Public APIs are covered by contract tests.
- Experimental APIs must be explicitly labeled.
