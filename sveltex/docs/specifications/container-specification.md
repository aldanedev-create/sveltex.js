# Container Specification

## Token model

Tokens should support class constructors and explicit symbols or string identifiers with collision-safe semantics. TypeScript ergonomics must not depend on runtime type reflection.

## Registration

A provider definition declares a token and exactly one construction strategy:
- class constructor plus explicit injection tokens;
- factory plus explicit injection tokens;
- prebuilt value.

Provider lifetime is `singleton`, `request`, or `transient`.

## Resolution

- Resolution is asynchronous if async factories are supported; the API must be consistent.
- Cycles are detected and reported as a resolution path.
- Concurrent singleton resolution shares one in-flight creation.
- Failed singleton creation must not leave a permanently poisoned partial instance unless explicitly documented.
- Request providers cannot be resolved from the root container without an active request scope.
- Scope disposal is idempotent.

## Disposal

Support a documented disposal protocol, such as an explicit `dispose()` method or registered cleanup callback. Avoid relying only on garbage collection or finalizers.

## Security and isolation

The container is not an authorization system. Authorization remains an application responsibility and must be checked at server-side boundaries.
