# ADR-009: Testing Is a Release Requirement

- **Status:** Accepted
- **Decision:** Unit, integration, contract, compatibility, end-to-end, and concurrency tests are required according to feature risk.

## Consequences

- Tests are written alongside features.
- CI blocks releases on critical test failures.
- Coverage targets guide work but do not replace critical scenario tests.
