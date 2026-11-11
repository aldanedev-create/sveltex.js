# Phase 5 — Realtime completion report

**Status:** implemented, tested against real WebSocket (`ws`) sockets and real `node:http` /
`fetch` SSE streams on ephemeral TCP ports, documented. Phase 5 done; Phases 6–12 remain.

**Measured full-monorepo gate:** `pnpm check` → **779/779** runtime (0 failures, 0 skipped,
16 test projects), `pnpm test:security` → **131/131** (15 packages), `pnpm test:types` →
**16/16**, all exit 0 with live PostgreSQL 16 / MySQL 8.0 / Redis 7 services.

## Objective

Per [`docs/completion-plan.md`](../completion-plan.md) Phase 5, close every gap the Phase 0 audit
recorded for `@sveltex/realtime` **without creating a new package**. The Phase 0 table read:

> Typed channels, authorization, retries, shutdown ✅ (`InProcessTransport`);
> **WebSocket transport, SSE transport, heartbeats, reconnection, backpressure** ✗
> (`InProcessTransport` is process-local only).

Core rule honored: **finish what SvelteX already promises before making SvelteX promise more.**
No placeholder package, no fake transport, no skipped test.

## Gap → delivery

| Gap / requirement | Delivered | Reality |
| --- | :---: | --- |
| WebSocket transport | ✅ | `createWebSocketGateway()` and `attachWebSocketGateway()` over the real `ws` package, plus `WebSocketClientTransport` implementing `RealtimeTransport`. Ephemeral TCP ports, real frames. |
| SSE transport | ✅ | `createSseGateway()` over `node:http`, `SseClientTransport` over real `fetch` streams. `/events`, `/subscribe`, `/unsubscribe`, `/publish`, `text/event-stream`, keepalive comments. |
| Heartbeats | ✅ | `HeartbeatMonitor` with injectable clock/scheduler; gateways send `ping`/keepalive and terminate sockets/streams that miss the timeout; clients answer `pong`. |
| Reconnection | ✅ | `computeReconnectDelay` capped exponential backoff with symmetric jitter; both clients re-subscribe all channels and drain queued publishes after reconnect. |
| Backpressure | ✅ | `BoundedQueue` with `error` / `drop-oldest` / `drop-newest`; WS `bufferedAmount` termination, SSE `write()` return value + bounded pending frames. |
| Message validation | ✅ | Strict versioned wire protocol (direction, byte bounds, envelope shape, no silent JSON coercion, `__proto__` stripping). |
| Authentication integration | ✅ | Deny-by-default gateway `authenticate` (`denyAnonymous()` / `allowAnonymous()`), independent of the hub's required `authorize` hook. |
| Channel management | ✅ | Shared `REALTIME_CHANNEL_NAME` grammar used by hub, protocol and both gateways; `subscriptionCount(channel)` observability. |
| Error handling / graceful shutdown | ✅ | `RealtimeProtocolError`, `RealtimeBackpressureError`, `RealtimeConnectionError`; non-leaking `publicWireError()`; idempotent client/gateway `close()` releasing ports, timers and sockets. |
| In-memory dev/test transport | ✅ | `InProcessTransport` retained unchanged (17 pre-existing tests). |
| Real integration, no fakes | ✅ | 70 tests: 50 runtime + 20 security, real `ws` / `node:http` / `fetch`, a genuinely unreachable port for reconnect/backpressure, injectable clocks for deterministic heartbeats. |

## What Phase 5 added

| Area | File | Content |
| --- | --- | --- |
| Errors + grammar | `src/index.ts` (extended) | `RealtimeProtocolError`, `RealtimeBackpressureError`, `RealtimeConnectionError`, exported `REALTIME_CHANNEL_NAME`. |
| Wire protocol | `src/protocol.ts` (new) | `REALTIME_PROTOCOL_VERSION = 1`, `MAX_WIRE_MESSAGE_BYTES = 64 KiB`, `ClientMessage` / `ServerMessage`, `encodeWireMessage` / `decodeWireMessage`, `validateEnvelope`, `isChannelName`, `GatewayAuthenticator`, `allowAnonymous` / `denyAnonymous`, `publicWireError`. |
| Connection lifecycle | `src/connection.ts` (new) | `computeReconnectDelay`, `DEFAULT_RECONNECT`, `BoundedQueue`, `HeartbeatMonitor`, `ConnectionState`, `OverflowPolicy`. |
| WebSocket | `src/websocket.ts` (new) | Real `ws` gateway + client, handshake, metrics, `subscriptionCount`, heartbeat timeout, backpressure, reconnect/resubscribe/queue drain. |
| SSE | `src/sse.ts` (new) | Real HTTP endpoints, `text/event-stream`, `Last-Event-ID` replay, keepalive, `write()` backpressure, reconnect/resubscribe/queue drain. |
| Exports | `package.json` | Four new subpath exports: `./protocol`, `./connection`, `./websocket`, `./sse`. `ws@^8.22.2` is the only new runtime dependency. |
| Docs | `README.md`, `CHANGELOG.md` | Rewritten with network adapters, wire protocol, lifecycle, API surface and honest single-process limits. |

### Wire protocol

```
frame  := JSON string, <= 64 KiB (checked before parse and after encode)
client -> server : sub | unsub | pub | pong
server -> client : ready | msg | ping | pong | error
ready  := { t: 'ready', protocol: 1 }   (mismatch rejected, never guessed)
```

- Direction is enforced at decode time: a gateway parses `client`, a client parses `server`. A
  forged `msg` from a client or a forged `sub` from a server raises `RealtimeProtocolError`.
- `validateEnvelope` rebuilds a frozen envelope with exactly `id`, `channel`, `payload`,
  `publishedAt`; extra keys are dropped and `__proto__` never survives. Ids are length- and
  control-character-checked; channel names obey `^[A-Za-z0-9._:-]{1,128}$`.
- `assertSerializable` walks the **original** value before `JSON.stringify`. This is required
  because stringify invokes `toJSON()` before its replacer, so a `Date`/`Map`/`toJSON`-bearing
  value would otherwise silently change type. `BigInt`, `Symbol`, functions, `NaN`/`Infinity`,
  `undefined`, circular and symbol-keyed values throw. Arrays are allowed via `Array.prototype`.
- `publicWireError()` returns a fixed code + message; internal error text, connection strings and
  stack traces are never echoed.

### Deny-by-default authentication

Both gateways default to `denyAnonymous()`. `allowAnonymous()` is an explicit opt-in for local
development or when an upstream proxy has already authenticated the request. An authenticator that
throws is reported to the `onError` observer but leaves `allowed === false` — misconfiguration
fails closed, not open. Unauthenticated WS sockets close with code `1008`; unauthenticated SSE
requests receive `401`. Gateway auth is a second, transport-level boundary in addition to the
hub's required `authorize` hook (publish / subscribe / deliver, evaluated per subscriber).

### Connection lifecycle

- `computeReconnectDelay(attempt, options, random)` — pure, injectable, capped
  (`initialDelayMs` → `maxDelayMs` via `multiplier`) with symmetric `jitterRatio` jitter.
- `BoundedQueue<T>` — FIFO with explicit overflow policies and a `dropped` counter.
- `HeartbeatMonitor` — `start()` / `stop()` / `noteActivity()` / `tick()` with injectable `now`
  and `schedule`; observer exceptions are contained.
- Both clients: on open they re-send every subscription, drain the queued publishes, and start
  the heartbeat monitor; on timeout they terminate the stalled connection and reconnect.

### WebSocket specifics

- `createWebSocketGateway()` opens its own `node:http` server on an ephemeral port;
  `attachWebSocketGateway(server, options)` mounts on an existing server (upgrade path only).
- `maxPayload` and `maxMessageBytes` bound inbound frames; oversized or malformed frames receive
  a redacted `error` frame. `bufferedAmount > maxBufferedBytes` terminates a slow socket.
- Metrics: `connections`, `messagesIn`, `messagesOut`, `rejected`, `authFailures`,
  `heartbeatTimeouts`, `backpressureDrops`; plus `connectionCount` / `subscriptionCount()`.

### SSE specifics

- `GET /events?clientId=…` → `text/event-stream`, `: connected` then `id:` / `event: message` /
  `data:` frames and periodic `: keepalive` comments.
- `POST /subscribe|/unsubscribe?clientId=…&channel=…`, `POST /publish?clientId=…` (wire frame
  body). Invalid `clientId`, channel, body size or tag → `400` / `413`.
- `Last-Event-ID` replays missed frames **only for channels the client is subscribed to** —
  replay never leaks another channel's events. `replayBufferSize`, `maxBufferedFrames` and
  `maxTrackedClients` are all bounded.
- SSE uses a POST back-channel because `EventSource` is receive-only; the client transport uses
  real `fetch` streams rather than a browser `EventSource`.

## Public API and version policy

`@sveltex/realtime` stays at **`0.1.0`** with the rest of the workspace. The CLI integration
registry enforces a single workspace version (`SVELTEX_PACKAGE_VERSION = '0.1.0'`), so the
version bump is deferred to the Phase 11 release audit and recorded as `Unreleased` in the
package `CHANGELOG.md`. No new package was created.

## Verification (measured 2026-11-11)

| Gate | Result |
| --- | --- |
| `@sveltex/realtime` `npm test` | **70/70** (50 runtime + 20 security), 0 failures, 0 skipped |
| Full monorepo `pnpm check` | **779/779** runtime, 0 failures, 0 skipped, 16 test projects, exit 0 |
| Full monorepo `pnpm test:security` | **131/131**, 15 packages, 0 failures, 0 skipped, exit 0 |
| Full monorepo `pnpm test:types` | **16/16**, exit 0 |
| `npm pack --dry-run --json` | **27 files**, 6 `dist/*.js` + 6 `dist/*.d.ts`, version `0.1.0`, no `src`/`tests` leakage |
| Phase 4 → Phase 5 delta | **+45 runtime** (734 → 779), **+12 security** (119 → 131); realtime 25 → 70 / 8 → 20 |

Integration tests bind real ephemeral TCP ports and exchange real `ws` frames and real HTTP/SSE
chunks between two independent `RealtimeHub` instances. Reconnect and backpressure tests use a
genuinely unreachable port (`127.0.0.1:9`) and injectable clocks; heartbeat timeout is verified
with an injected `now()` and a raw socket that never answers `ping`. No fake transport, no
substituted backend, no skipped test.

## Test inventory

| File | Cases | Coverage |
| --- | ---: | --- |
| `tests/realtime.test.mjs` | 17 | Pre-existing hub/authorization/dedup/in-process transport |
| `tests/protocol.test.mjs` | 8 | Frame round-trip, direction, malformed/oversized/legacy, envelope strictness, unsafe payloads, channel grammar, redacted errors |
| `tests/connection.test.mjs` | 6 | Reconnect backoff/jitter/validation, queue overflow policies, heartbeat liveness with injected clock |
| `tests/websocket.test.mjs` | 9 | Two-hub real TCP pub/sub, deny-by-default auth, URL-token auth + `ready`, reconnect/resubscribe/queue drain, backpressure, heartbeat timeout, malformed frames, idempotent close, `attachWebSocketGateway` |
| `tests/sse.test.mjs` | 10 | Two-hub real HTTP/SSE pub/sub, deny-by-default, invalid clientId/channel/frame, 413 byte limit, `Last-Event-ID` replay, keepalive, reconnect/resubscribe/queue drain, backpressure, oversized outgoing frame, idempotent close |
| `tests/security/security.test.mjs` | 8 | Pre-existing realtime security cases |
| `tests/security/phase5-security.test.mjs` | 12 | Prototype pollution, forged frames, legacy/unknown versions, oversized frames, unsafe payloads, non-leaking errors, channel grammar, deny-by-default WS/SSE, throwing authenticator, replay isolation, hostile config |
| `tests/types/public-api.test.ts`, `tests/types/phase5.test.ts` | type tests | Pre-existing contracts + all four new subpath exports, typed errors, gateway/client option types, `@ts-expect-error` negative cases |
| `tests/helpers.mjs` | helper | `waitFor`, `readSseFrames` (not a `*.test.mjs`, so not executed as a suite) |

Security findings **SEC-047 – SEC-052** record the Phase 5 review in
[`docs/audit/security-findings.md`](../audit/security-findings.md).

## XERJ repository research

The local XERJ node (`http://127.0.0.1:9200`) was verified live and queried **before**
implementation, per the standing instruction to use XERJ for repository research. `xerj search`
returned the Phase 5 task list and the Phase 0 gap table quoted above, and flagged a stale index
(`pnpm-lock.yaml` newer than the index). A final `--fresh` rebuild was run after the documentation
sync so the Phase 5 report, the new subpath exports and the `ws` dependency are indexed. The
measured final rebuild: **440 files / 2444 records live / 31 duplicate aliases / 0 junk records /
0 junk/skipped files**, `ax-docs` 2429 docs, `ax-packages-cli` 15 docs, graph 1565 edges,
`xerj-done ok=true exit=0 reason=completed`; the same figures are recorded in
[`docs/audit/README.md`](../audit/README.md) and the Session 12 entry of
[`docs/audit/progress.md`](../audit/progress.md). No XERJ index artifacts are committed
(`.gitignore` excludes `.xerj-data/` and `.xerj-memory-*`).

## Docs synced

`README.md`; `docs/roadmap.md`; `docs/specification.md` (realtime responsibility/delivered rows,
inventory, Stage 4 tables and baselines, 779/131 totals, CLI integration wording, Phase 5
verification + not-claimed section); `docs/packages/README.md`; `docs/manifest.json`
(40 documents, Phase 5 report registered); `docs/completion-plan.md` (all 21 Phase 5 checkboxes
and a delivery note); `docs/completion/phase-0-audit.md` (Phase 5 completion table + criteria);
`docs/audit/README.md`, `package-status.md`, `testing-status.md`, `repository-audit.md`,
`security-findings.md`, `progress.md` (Session 12); `packages/realtime/README.md` +
`CHANGELOG.md`; and this report. Historical Phase 4 / Stage 4 baselines are explicitly labelled
as historical rather than rewritten into current status.

## Not claimed

- **Single-process fan-out only.** Neither gateway provides persistence, cross-instance fan-out,
  a broker, or a distributed lock. Multi-instance realtime still requires a real broker behind a
  custom `RealtimeTransport`.
- **No TLS termination, rate limiting, or built-in identity provider.** `authenticate` is a hook;
  production must supply a real policy and place a reverse proxy in front of the gateway.
- **SSE replay is bounded and channel-filtered**, not durable message history.
- **No distributed single-flight / lease** analogous to the cache package's documented gap.
- **No package version bump** (Phase 11) and no SvelteKit `handle` wiring (Phase 10).

## Next phase

Phase 6 — `@sveltex/jobs` completion (Redis / DB-backed queue), per the plan. Phases 6–12 remain.
