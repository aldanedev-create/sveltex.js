# Testing Strategy

Testing is part of the architecture. Every feature must include tests for normal behavior, invalid input, failure, concurrency where relevant, and cleanup.

## Test layers

### Unit

Test pure functions and individual classes: config validation, graph algorithms, token handling, provider registration, state transitions.

### Integration

Test multiple core components together: module graph plus provider registration, application startup and rollback, request scope disposal.

### Contract

Verify public exports and documented behavior. Tests should be written against public APIs rather than private implementation details.

### Compatibility

For the SvelteKit adapter, test against supported SvelteKit versions and standard application patterns. Do not mock away the public hook contracts.

### End-to-end

Run actual example SvelteKit applications and verify page loads, server endpoints, form actions, SSR, errors, and production builds.

### Stress and concurrency

Exercise concurrent request scopes, provider resolution, startup/shutdown races, and resource cleanup.

### Security

Test request isolation, safe error output, production diagnostics, authorization integration boundaries, and secret redaction.

## Quality gates

Initial targets:
- Core line coverage target: at least 90%.
- Core branch coverage target: at least 85%.
- Strict TypeScript checks pass.
- Lint and formatting checks pass.
- No unhandled promise rejections in tests.
- No dependency cycles between packages.
- Critical failure and concurrency tests pass.

Coverage percentages are indicators, not proof of correctness. Critical paths require explicit tests.

## CI order

1. Install dependencies with lockfile enforcement.
2. Validate workspace structure.
3. Type-check all packages.
4. Lint and format check.
5. Run unit tests.
6. Run integration and contract tests.
7. Build packages.
8. Build example applications.
9. Run compatibility and end-to-end tests.
10. Run platform matrix tests where appropriate.
