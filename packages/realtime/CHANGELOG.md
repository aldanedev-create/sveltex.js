# Changelog

## Unreleased — Completion-plan Phase 5 (2026-11-11)

> Package version remains `0.1.0` (unpublished). Version bumps are deferred to the Phase 11
> release audit so the CLI integration registry's single-version policy stays satisfied.

### Added

- **Strict wire protocol** (`@sveltex/realtime/protocol`): versioned `ready` frame, direction
  enforcement, byte bounds, strict envelope validation, `__proto__` stripping, rejection of
  values that `JSON.stringify` would silently coerce, and non-leaking `publicWireError()`.
- **Connection lifecycle primitives** (`@sveltex/realtime/connection`): capped exponential
  reconnect with symmetric jitter, `BoundedQueue` with three explicit overflow policies, and a
  `HeartbeatMonitor` with an injectable clock/scheduler.
- **Real WebSocket adapter** (`@sveltex/realtime/websocket`): `createWebSocketGateway()` and
  `attachWebSocketGateway()` over the real `ws` package, plus `WebSocketClientTransport`.
  Includes deny-by-default gateway authentication, versioned handshake, `sub`/`unsub`/`pub`/
  `pong` frames, bufferedAmount-based backpressure, heartbeat timeout termination, reconnect,
  re-subscribe and queue drain.
- **Real SSE adapter** (`@sveltex/realtime/sse`): `createSseGateway()` over `node:http` and
  `SseClientTransport` over real `fetch` streams. Includes `text/event-stream` with
  `Last-Event-ID` replay (channel-filtered), keepalive comments, `write()` backpressure,
  reconnect, re-subscribe and queue drain.
- Three typed errors: `RealtimeProtocolError`, `RealtimeBackpressureError`,
  `RealtimeConnectionError`, plus the exported shared channel-name grammar.
- Four new subpath exports: `./protocol`, `./connection`, `./websocket`, `./sse`.
- Runtime, security, type, and real-network integration tests on ephemeral TCP ports.

### Changed

- `ws` added as the single new runtime dependency; `@types/ws` added as a dev dependency.
- Package README rewritten to document the network adapters, wire protocol, lifecycle, and
  honest single-process limits.

### Not claimed

- No persistence, cross-instance fan-out, broker, or distributed lock.
- No TLS termination or built-in rate limiting; production must supply an `authenticate` policy.
- SSE replay is a bounded reconnection aid, not durable history.

## 0.1.0

- Initial independently installable SvelteX package.
