# SvelteX Core Testing Strategy

The Core test suite is intentionally kept close to the implementation. Tests use Node's built-in `node:test` and `node:assert/strict`; no runtime or test-framework dependency is required.

## Commands

```bash
npm run check             # typecheck, full test suite with coverage, public type tests
npm test                  # build and run every test
npm run test:unit         # unit and application integration tests
npm run test:security     # configuration and registry security regression tests
npm run test:stress       # bounded concurrency and scale tests
npm run test:compatibility # native ESM, headless runtime and instance-isolation tests
npm run test:coverage     # full suite plus line/branch/function coverage report
npm run test:types        # compile-time public API tests
```

## Coverage map

| Area | Contracts exercised |
|---|---|
| Configuration | Required and optional values, invalid shapes, cloning, deep freezing, repeated references, unsupported values, `defineConfig` validators |
| Modules | Descriptor validation, immutability, duplicate names/providers, missing dependencies, self/long cycles, stable topological order, exports, deep graphs |
| Dependency injection | All provider strategies, singleton concurrency, request isolation/cache, transient behavior, cycles, missing tokens, retry, class injection, registry sealing |
| Resource management | Reverse-order cleanup, exactly-once disposal, in-flight factory completion, nested request cleanup, aggregate failures, idempotent disposal |
| Application lifecycle | Concurrent start/stop, invalid state transitions, startup rollback, partial-start cleanup, reverse shutdown, immutable hook context, repeated app instances |
| Security regression | Prototype-pollution payload handling, caller-object immutability, non-plain metadata rejection, registry collection encapsulation, token namespacing |
| Stress | 1,000 simultaneous singleton resolutions, 250 concurrent request scopes, 500 modules, 100-provider dependency chain, 100 app start/stop cycles |
| Runtime compatibility | Native ESM import, no browser-global dependency, no process-wide application state |

## Current local baseline

On the development runtime used to prepare this release, the suite reports:

- 72 automated tests passing.
- 98.82% line coverage.
- 96.06% branch coverage.
- 96.65% function coverage.

Coverage is a measured baseline, not a guarantee that every production scenario is covered. Keep regression tests for every discovered defect and maintain high coverage as the public API grows.

## CI matrix

`.github/workflows/ci.yml` runs the full check and package dry-run across Node.js 20.11, 22, and 24 on Ubuntu, Windows, and macOS. The matrix verifies supported-runtime compatibility when GitHub Actions runs; local tests do not claim that all matrix combinations have already executed.

## Limits of this test suite

These are deterministic automated tests, not a formal security audit, external penetration test, long-duration soak test, or deployment-provider certification. Before a stable 1.0 release, add integration tests against the actual SvelteKit bridge, serverless runtimes, worker hosts, and any external drivers introduced by later packages. Avoid interpreting the bounded stress tests as a throughput benchmark.
