# @sveltex/realtime

Typed realtime channels with authorization hooks, a pluggable transport contract, an in-process
transport, and **real WebSocket / SSE gateways and client transports** built on strict wire
protocol and connection-lifecycle primitives.

## Install

```sh
pnpm add @sveltex/realtime
```

`ws` is the only runtime dependency added for the network adapters; SSE uses the platform
`fetch` / `node:http` and needs no extra package.

## Concepts

- **`ChannelDefinition<TPayload>`** — a channel name carrying a compile-time payload type. Created with `defineChannel<T>()`.
- **`RealtimeTransport`** — the contract any delivery backend implements (`publish`, `subscribe`, `close`, `isClosed`).
- **`RealtimeHub<P>`** — authorization-aware pub/sub over a transport. It de-duplicates at-least-once redeliveries, isolates failing subscribers, and supports idempotent shutdown.
- **`AuthorizeHook<P>`** — a **required** policy hook consulted for `publish`, `subscribe`, and `deliver`. There is no implicit "allow" default; production apps must pass an explicit policy.
- **Gateway `authenticate`** — a second, transport-level hook. Omitting it is **deny-by-default** (`denyAnonymous()`); pass `allowAnonymous()` only for local development or when an upstream proxy already authenticated the request.

## Minimal example (in-process)

```ts
import { defineChannel, RealtimeHub, allowAll } from '@sveltex/realtime';
import { InProcessTransport } from '@sveltex/realtime/in-process';

type ChatMessage = { readonly text: string; readonly from: string };
const chat = defineChannel<ChatMessage>('chat:general');

const transport = new InProcessTransport();
const hub = new RealtimeHub<{ id: string }>({ transport, authorize: allowAll() });

const sub = await hub.subscribe(chat, (payload) => {
  console.log(payload.from, payload.text);
}, { principal: { id: 'user-1' } });

await hub.publish(chat, { text: 'hello', from: 'user-1' }, { principal: { id: 'user-1' } });

sub.unsubscribe();
await hub.close();
```

## Real WebSocket transport

```ts
import { createWebSocketGateway, WebSocketClientTransport, allowAnonymous } from '@sveltex/realtime/websocket';
import { defineChannel, RealtimeHub, allowAll } from '@sveltex/realtime';

const gateway = await createWebSocketGateway({
  authenticate: ({ url }) => url.searchParams.get('token') === 'secret', // deny-by-default otherwise
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 15_000,
});

const transport = new WebSocketClientTransport({ url: `${gateway.url}?token=secret` });
const hub = new RealtimeHub({ transport, authorize: allowAll() });
const chat = defineChannel<{ text: string }>('chat:general');
// ... hub.subscribe / hub.publish as above; frames cross a real TCP socket.

await hub.close();
await gateway.close();
```

`attachWebSocketGateway(server, options)` mounts the same gateway on an existing `node:http`
server instead of opening its own port. Gateway observables: `connectionCount`, `metrics`
(`messagesIn`, `messagesOut`, `rejected`, `authFailures`, `heartbeatTimeouts`,
`backpressureDrops`), and `subscriptionCount(channel)`.

## Real SSE transport

```ts
import { createSseGateway, SseClientTransport, allowAnonymous } from '@sveltex/realtime/sse';

const gateway = await createSseGateway({
  authenticate: allowAnonymous(), // replace with a real policy in production
  replayBufferSize: 256,
});
const transport = new SseClientTransport({ url: gateway.url });
// GET {url}/events streams text/event-stream; POST {url}/subscribe|unsubscribe|publish
// carries control frames back to the gateway.
await transport.close();
await gateway.close();
```

SSE endpoints are `/events`, `/subscribe`, `/unsubscribe`, and `/publish` under the configured
path. The stream emits `id:`/`event: message`/`data:` frames, `: connected` and periodic
`: keepalive` comments. A reconnect carrying `Last-Event-ID` replays missed frames, but **only
for channels that client is subscribed to** — replay never leaks another channel's events.

## Wire protocol

`@sveltex/realtime/protocol` defines the shared codec used by both gateways and clients:

- A **versioned `ready` frame** (`REALTIME_PROTOCOL_VERSION = 1`); a mismatch is rejected, never guessed.
- **Direction enforcement**: gateways decode `client` frames (`sub`, `unsub`, `pub`, `pong`), clients decode `server` frames (`ready`, `msg`, `ping`, `pong`, `error`). A forged frame is rejected.
- **Byte bounds**: `MAX_WIRE_MESSAGE_BYTES` (64 KiB) is checked before parsing and after encoding.
- **Strict envelopes**: ids are length/control-character checked, channel names obey the shared grammar `^[A-Za-z0-9._:-]{1,128}$`, extra keys are dropped, and `__proto__` can never survive.
- **No silent coercion**: `Date`, `Map`, `Set`, `RegExp`, `BigInt`, `Symbol`, functions, `NaN`/`Infinity`, `undefined`, circular or symbol-keyed values throw `RealtimeProtocolError` *before* `JSON.stringify` can change their type.
- Wire errors are fixed, non-leaking strings via `publicWireError()`; internal error text and stack traces are never echoed.

## Connection lifecycle

`@sveltex/realtime/connection` provides the reusable primitives behind both clients:

- `computeReconnectDelay(attempt, options, random)` — capped exponential backoff with symmetric jitter; pure and injectable for deterministic tests.
- `BoundedQueue<T>` — bounded send queue while a connection is down, with explicit `error`, `drop-oldest`, and `drop-newest` overflow policies.
- `HeartbeatMonitor` — injectable clock/scheduler liveness monitor; observer failures are contained.

Both clients reconnect with capped backoff, **re-subscribe** all channels after reconnect,
**drain** queued publishes, and terminate a stalled connection on heartbeat timeout. WebSocket
backpressure uses `bufferedAmount`; SSE backpressure uses the response `write()` return value
and bounds buffered frames. Single-flight is **not** implemented across processes.

## Authorization

Every hub operation is authorized. `deliver` is evaluated **per subscriber**, so a privileged channel can be published once while only authorized subscribers receive it:

```ts
const hub = new RealtimeHub({
  transport,
  authorize: (ctx) =>
    ctx.action === 'deliver' && ctx.channel.startsWith('admin:')
      ? ctx.principal?.roles?.includes('admin') === true
      : true,
});
```

`denyAll()` and `allowAll()` are provided for tests and explicit opt-in. A hook that throws is captured as a `RealtimeAuthorizationError` in `drainErrors()` and never crashes delivery to other subscribers. A throwing gateway `authenticate` hook **never** implicitly grants access.

## Duplicate delivery & failure handling

External at-least-once transports may deliver the same envelope more than once. The hub keeps a **bounded, per-subscriber** id cache (`maxRememberedIds`, default 1024) so a side effect runs exactly once per subscriber. `InProcessTransport({ redeliveries: n })` simulates redelivery for deterministic tests. A throwing subscriber increments `metrics.failed`, is reported through `onError` / `drainErrors()`, and does not block other subscribers. `metrics` exposes `published / delivered / duplicates / rejected / failed`.

## Lifecycle

`subscribe()` returns a `Subscription` whose `unsubscribe()` is idempotent. `close()` is idempotent, clears subscriptions, and rejects later `publish`/`subscribe` with `RealtimeClosedError`. Transport failures are wrapped in `RealtimeTransportError` with the original error attached as `cause`. Gateway `close()` terminates sockets/streams, clears intervals, and releases the listening port.

## API surface

| Export | Kind |
| --- | --- |
| `defineChannel<T>(name)` | function |
| `allowAll<P>()`, `denyAll<P>()`, `REALTIME_CHANNEL_NAME` | functions / constant |
| `RealtimeHub<P>` | class |
| `RealtimeTransport`, `Subscription`, `ChannelHandler<T>`, `AuthorizeHook<P>`, `AuthorizationContext<P>`, `ChannelDefinition<T>`, `RealtimeEnvelope<T>`, `PublishOptions<P>`, `SubscribeOptions<P>`, `PublishResult`, `RealtimeMetrics`, `RealtimePrincipal`, `RealtimeHubOptions<P>` | types |
| `RealtimeError`, `RealtimeChannelError`, `RealtimeAuthorizationError`, `RealtimeClosedError`, `RealtimeTransportError`, `RealtimeDeliveryError`, `RealtimeProtocolError`, `RealtimeBackpressureError`, `RealtimeConnectionError` | errors |
| `InProcessTransport`, `InProcessTransportOptions` (`@sveltex/realtime/in-process`) | transport |
| `encodeWireMessage`, `decodeWireMessage`, `validateEnvelope`, `isChannelName`, `allowAnonymous`, `denyAnonymous`, `publicWireError`, `REALTIME_PROTOCOL_VERSION`, `MAX_WIRE_MESSAGE_BYTES`, `MAX_ENVELOPE_ID_LENGTH` (`@sveltex/realtime/protocol`) | codec |
| `ClientMessage`, `ServerMessage`, `WireMessage`, `WireDirection`, `GatewayAuthenticator` (`@sveltex/realtime/protocol`) | types |
| `computeReconnectDelay`, `BoundedQueue`, `HeartbeatMonitor`, `DEFAULT_RECONNECT` (`@sveltex/realtime/connection`) | lifecycle |
| `ConnectionState`, `ReconnectOptions`, `OverflowPolicy`, `HeartbeatOptions` (`@sveltex/realtime/connection`) | types |
| `createWebSocketGateway`, `attachWebSocketGateway`, `WebSocketClientTransport` (`@sveltex/realtime/websocket`) | WebSocket |
| `WsGateway`, `WsGatewayOptions`, `WsGatewayMetrics`, `WsAuthContext`, `WsClientTransportOptions` (`@sveltex/realtime/websocket`) | types |
| `createSseGateway`, `SseClientTransport` (`@sveltex/realtime/sse`) | SSE |
| `SseGateway`, `SseGatewayOptions`, `SseGatewayMetrics`, `SseAuthContext`, `SseClientTransportOptions` (`@sveltex/realtime/sse`) | types |

## Limitations and production notes

- **`InProcessTransport` is process-local.** It does not provide cross-process, cross-instance, or durable delivery. Do not claim distributed realtime behavior on top of it.
- **The WebSocket and SSE gateways are single-process fan-out hubs.** They do **not** provide persistence, cross-instance fan-out, a broker, or a distributed lock. For multi-instance deployments, put a real broker (Redis pub/sub, NATS) behind a custom `RealtimeTransport`; the hub, authorization, and de-duplication layers are transport-agnostic.
- **Authentication is a hook, not an implementation.** `allowAnonymous()` is an explicit opt-in for development. Production must supply a real `authenticate` policy and place TLS termination / rate limiting in front of the gateway.
- **SSE uses a POST back-channel** for subscribe/publish because `EventSource` is receive-only; the client transport uses `fetch` streams rather than a browser `EventSource`.
- **Replay is bounded** by `replayBufferSize` and filtered by the client's current subscriptions. It is a best-effort reconnection aid, not durable message history.
- The de-duplication cache is **bounded**: after `maxRememberedIds` distinct messages, the oldest ids are evicted. A very late redelivery of an evicted id would be treated as new. Size the cache to your redelivery window.
- Delivered payloads are frozen (zero-copy in-process semantics) so one subscriber cannot mutate a payload shared with others.
- `RealtimeHub` does not serialize payloads; the network adapters apply the strict wire codec at their boundary.

## Status

Phase 5 completion-plan delivery. Verified with runtime, security, and public-API type tests,
including **real ephemeral TCP ports** for both gateways and real `fetch` streams for SSE. No
fake provider and no skipped test. See `docs/completion/phase-5-realtime.md` in the monorepo.
