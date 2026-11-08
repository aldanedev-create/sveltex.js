# @sveltex/testing

Test application builders, DI and request fixtures, deterministic clock/lifecycle helpers, and in-memory fake adapters for SvelteX.

## Install

```sh
pnpm add -D @sveltex/testing
```

## What this package is (and is not)

`@sveltex/testing` is a **thin builder over the real `@sveltex/core`** `Application` / `Container` / `defineModule` / `token` APIs. It does **not** implement a parallel DI container or a fake application: all resolution, scoping, lifecycle ordering, cleanup, and config validation are delegated to core. It adds only deterministic observation and guaranteed teardown:

- a `FakeClock` and `LifecycleRecorder`,
- namespaced tokens and provider helpers,
- `TestApplication` / `withTestApplication` with automatic cleanup,
- request fixtures that are always disposed,
- in-memory fakes for external-service boundaries.

## Minimal example

```ts
import { createTestApplication, defineTestModule, testToken, createValueProvider } from '@sveltex/testing';

const GREETING = testToken<string>('greeting');
const mod = defineTestModule({
  name: 'greeting',
  providers: [createValueProvider(GREETING, 'hello')],
  exports: [GREETING],
});

const app = createTestApplication({ modules: [mod] });
await app.start();
console.log(await app.resolve(GREETING)); // 'hello'
await app.stop();
```

## Guaranteed cleanup

Prefer `withTestApplication`: it starts a real core application and **always** stops it, even if the body throws.

```ts
import { withTestApplication } from '@sveltex/testing';

const result = await withTestApplication(async (app) => {
  // app.state === 'running'
  return 42;
});
```

`TestApplication.stop()` also disposes any request scope the caller forgot to dispose, so a test cannot leak a live container. Lifecycle hooks (`onStart` / `onStop`) and disposables run through core in start order and reverse stop order. Config errors (`SX_CONFIG_INVALID`), scope violations (`SX_PROVIDER_SCOPE_VIOLATION`), and lifecycle hook failures are surfaced, never swallowed.

## Request scopes

```ts
const fixture = app.fixture();          // or createRequestFixture(app.app)
const value = await fixture.resolve(TOKEN);
await fixture.dispose();               // idempotent
```

Request-scoped providers can only be resolved through a request scope; resolving them from the root raises the real core `SX_PROVIDER_SCOPE_VIOLATION`.

## Deterministic helpers

| Helper | Purpose |
| --- | --- |
| `FakeClock` | injectable clock; `now()`, `advance()`, `set()`, `reset()`. Rejects non-finite input. |
| `LifecycleRecorder` | records `(phase, label, at)` events with a deterministic timestamp; implements `CallRecorder` for fakes. |
| `testToken<T>(d)` | `Symbol.for('@sveltex/test.<d>')`, namespaced so test tokens never collide with production tokens. |
| `defineTestModule` | wraps core `defineModule`, optionally tracing `onStart` / `onStop`. |
| `createValueProvider`, `createFactoryProvider`, `createClassProvider` | typed helpers producing real core `Provider` objects. |

## Fakes (external-service boundaries)

`FakeKeyValueAdapter` and `FakeMessageTransport` are **deterministic in-memory stand-ins** for cache / session / KV stores and for realtime / mail / queue broker boundaries. They record every call, support `failNext()` for failure-path tests, expose frozen defensive snapshots, and reject use after `close()`. They never touch the network, disk, or any real provider — they are explicitly **not** Redis, SMTP, S3, or a message broker, and no such provider is advertised.

## API surface

| Export | Kind |
| --- | --- |
| `TestApplication`, `createTestApplication`, `withTestApplication`, `createRequestFixture` | app builders / fixtures |
| `defineTestModule`, `testToken`, `createValueProvider`, `createFactoryProvider`, `createClassProvider` | module / DI helpers |
| `FakeClock`, `LifecycleRecorder` | deterministic helpers |
| `FakeKeyValueAdapter`, `FakeMessageTransport` | in-memory fakes |
| `TestingError`, `TestSetupError` | errors |
| `TestApplicationOptions`, `RequestFixture`, `LifecycleEvent`, `FakeCall`, `FakeSentMessage`, `CallRecorder`, `TestingErrorOptions` | types |

## Limitations and production notes

- **Development/test dependency only.** Install with `-D`. This is not a production runtime component and does not replace `@sveltex/core`'s application.
- Fakes model in-process behavior. They do **not** provide distributed durability, real persistence, SMTP/HTTP delivery, or object storage. Tests that need a real provider must use that provider's own adapter (for example `@sveltex/cache/redis` or `@sveltex/session/redis`) with a live service.
- No live external service is required to run this package's own tests.

## Status

Verified with runtime, security, and public-API type tests against the real `@sveltex/core` implementation.
