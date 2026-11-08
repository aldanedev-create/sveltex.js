# @sveltex/realtime

Typed realtime channels with authorization hooks, a pluggable transport contract, and a real in-process transport.

## Install

```sh
pnpm add @sveltex/realtime
```

## Concepts

- **`ChannelDefinition<TPayload>`** — a channel name carrying a compile-time payload type. Created with `defineChannel<T>()`.
- **`RealtimeTransport`** — the contract any delivery backend implements (`publish`, `subscribe`, `close`, `isClosed`).
- **`RealtimeHub<P>`** — authorization-aware pub/sub over a transport. It de-duplicates at-least-once redeliveries, isolates failing subscribers, and supports idempotent shutdown.
- **`AuthorizeHook<P>`** — a **required** policy hook consulted for `publish`, `subscribe`, and `deliver`. There is no implicit "allow" default; production apps must pass an explicit policy.

## Minimal example

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

## Authorization

Every operation is authorized. `deliver` is evaluated **per subscriber**, so a privileged channel can be published once while only authorized subscribers receive it:

```ts
const hub = new RealtimeHub({
  transport,
  authorize: (ctx) =>
    ctx.action === 'deliver' && ctx.channel.startsWith('admin:')
      ? ctx.principal?.roles?.includes('admin') === true
      : true,
});
```

`denyAll()` and `allowAll()` are provided for tests and explicit opt-in. A hook that throws is captured as a `RealtimeAuthorizationError` in `drainErrors()` and never crashes delivery to other subscribers.

## Duplicate delivery & failure handling

External at-least-once transports may deliver the same envelope more than once. The hub keeps a **bounded, per-subscriber** id cache (`maxRememberedIds`, default 1024) so a side effect runs exactly once per subscriber. `InProcessTransport({ redeliveries: n })` simulates redelivery for deterministic tests. A throwing subscriber increments `metrics.failed`, is reported through `onError` / `drainErrors()`, and does not block other subscribers. `metrics` exposes `published / delivered / duplicates / rejected / failed`.

## Lifecycle

`subscribe()` returns a `Subscription` whose `unsubscribe()` is idempotent. `close()` is idempotent, clears subscriptions, and rejects later `publish`/`subscribe` with `RealtimeClosedError`. Transport failures are wrapped in `RealtimeTransportError` with the original error attached as `cause`.

## API surface

| Export | Kind |
| --- | --- |
| `defineChannel<T>(name)` | function |
| `allowAll<P>()`, `denyAll<P>()` | functions |
| `RealtimeHub<P>` | class |
| `RealtimeTransport`, `Subscription`, `ChannelHandler<T>`, `AuthorizeHook<P>`, `AuthorizationContext<P>`, `ChannelDefinition<T>`, `RealtimeEnvelope<T>`, `PublishOptions<P>`, `SubscribeOptions<P>`, `PublishResult`, `RealtimeMetrics`, `RealtimePrincipal`, `RealtimeHubOptions<P>` | types |
| `RealtimeError`, `RealtimeChannelError`, `RealtimeAuthorizationError`, `RealtimeClosedError`, `RealtimeTransportError`, `RealtimeDeliveryError` | errors |
| `InProcessTransport`, `InProcessTransportOptions` (`@sveltex/realtime/in-process`) | transport |

## Limitations and production notes

- **`InProcessTransport` is process-local.** It does not provide cross-process, cross-instance, or durable delivery. Do not claim distributed realtime behavior on top of it. For multi-instance deployments, implement `RealtimeTransport` on top of a broker (Redis pub/sub, NATS, WebSocket gateway) — the hub, authorization, and de-duplication layers are transport-agnostic.
- WebSocket and SSE adapters are **not** shipped in this package; the transport contract is the integration point. No untested provider is advertised.
- The de-duplication cache is **bounded**: after `maxRememberedIds` distinct messages, the oldest ids are evicted. A very late redelivery of an evicted id would be treated as new. Size the cache to your redelivery window.
- Delivered payloads are frozen (zero-copy in-process semantics) so one subscriber cannot mutate a payload shared with others.
- `RealtimeHub` does not serialize payloads. When bridging to a real network transport, validate/serialize at that adapter boundary.

## Status

Verified with runtime, security, and public-API type tests. No live external service is required.
