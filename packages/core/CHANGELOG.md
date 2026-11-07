# Changelog

## 0.1.0

- Initial framework-independent Core implementation.
- Explicit module descriptors and deterministic dependency ordering.
- Async dependency injection with singleton, request, and transient scopes.
- Concurrent singleton construction, cycle detection, retry after failed construction, and disposal tracking.
- Application startup, rollback, shutdown, and request-scope management.
- Strict TypeScript declarations and automated unit/type tests.

## Core test hardening (pre-1.0)

- Expanded automated coverage from 20 to 72 tests across configuration, modules, DI, application lifecycle, security regressions, stress scenarios, and runtime compatibility.
- Added bounded stress coverage for 1,000 concurrent singleton resolutions, 250 concurrent request scopes, 500 modules, and repeated application lifecycles.
- Added a Node.js 20.11/22/24 × Ubuntu/Windows/macOS CI matrix and package-content dry-run.
- Added coverage reporting and a dedicated testing strategy document.
- Froze the provider factory resolution context at runtime to match its readonly public contract.
