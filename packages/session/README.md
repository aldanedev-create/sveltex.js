# @sveltex/session

Storage-agnostic session lifecycle and storage contracts.

## Install

```sh
pnpm add @sveltex/session
# The Redis adapter requires ioredis (installed as a dependency of this package)
```

## Create and rotate a session

```ts
import { MemorySessionStore, SessionManager } from '@sveltex/session';

const sessions = new SessionManager(new MemorySessionStore(), {
  ttlMs: 1000 * 60 * 60 * 24,
});

const session = await sessions.create({ userId: 'user-123' });
// After login or a privilege change, rotate the identifier.
const authenticated = await sessions.rotate(session.id);
```

The manager supports create, read, update, touch, rotate, destroy, and expiry. Session IDs must be at least 16 URL-safe characters. Session payloads are data-only, cloned, and deeply frozen. Updates and rotations use revisions: production stores must implement `createIfAbsent`, `compareAndSet`, and `rotate` atomically in the backing database/transaction. A non-atomic implementation can resurrect sessions or lose concurrent updates and is not supported. The memory store is for tests and single-process development only. Use a shared persistent store for multi-instance production deployments.

## Redis-backed shared store

```ts
import { RedisSessionStore } from '@sveltex/session/redis';
import { SessionManager } from '@sveltex/session';

const store = new RedisSessionStore({
  url: 'redis://localhost:6379',
  keyPrefix: 'myapp:sess:', // strongly recommended on shared instances
});
await store.connect();

const sessions = new SessionManager(store, { ttlMs: 1000 * 60 * 60 * 24 });
const session = await sessions.create({ userId: 'user-123' });

// ... on shutdown
await store.disconnect();
```

`RedisSessionStore` keeps session state in Redis so it is shared across all application
instances. Its `createIfAbsent`, `compareAndSet`, and `rotate` operations are implemented as
server-side **Lua scripts** (`EVAL`), making each check-and-write atomic across processes —
concurrent updates cannot be lost and rotation cannot collide or resurrect an old identifier.
Records are stored as JSON under `<keyPrefix><id>` with a physical TTL derived from the
record's `expiresAt`; `clear()` scans and deletes only the configured prefix (never `FLUSHDB`);
corrupt or logically expired records are purged on read; values are returned deeply cloned and
frozen.

> **Clock consistency:** when you inject a custom `now` clock into `SessionManager`, pass the
> **same** function to `RedisSessionStore` (`{ now }`) so logical expiry and Redis' physical
> TTL stay aligned. With real clocks (the default) no configuration is needed.

The adapter requires an explicit `connect()` / `disconnect()` lifecycle, matching the other
real adapters in this monorepo. It is verified against a live Redis instance by integration
tests in `tests/redis-session-integration.test.mjs`.

Cookie serialization, signing, secure cookie flags, CSRF, and SvelteKit request integration
remain outside this package; they belong in a later integration/transport layer.

## Status

0.1.0 foundation + real Redis shared store. Cookie transport, signing, secure cookie flags,
CSRF protection, a database-backed store, and revocation policy must be supplied by the
integration and deployment.
