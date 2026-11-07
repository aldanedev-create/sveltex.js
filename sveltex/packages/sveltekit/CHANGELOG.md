# Changelog

## 0.1.0

- Initial SvelteKit Handle adapter.
- Per-request dependency-injection scopes and `event.locals` bridge.
- Lazy, concurrent-safe application startup.
- Guaranteed request-scope disposal after resolution.
- Handler composition helpers, configuration validation, and automated tests.

## Unreleased

- Added graceful shutdown that stops accepting requests and drains in-flight request scopes before stopping Core.
- Added active-request diagnostics and shared lifecycle coordination across handlers using the same application.
- Hardened locals access against inherited properties, invalid values, and deleting properties not owned by the adapter.
- Hardened configuration validation and composed-handle next-call semantics.
- Expanded lifecycle, context, security, composition, and TypeScript API tests.
