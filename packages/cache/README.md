# @sveltex/cache

Driver-neutral cache contracts with a bounded in-memory store, a real Redis adapter, and
composable decorators for **namespaces, tag-based invalidation, graceful fallback,
serialization safety and stampede protection**.

## Install

```sh
pnpm add @sveltex/cache
# ioredis is a regular dependency of this package; no separate install is needed.
```

## Stores

```ts
import { MemoryCache } from '@sveltex/cache';
import { RedisCache } from '@sveltex/cache/redis';

const memory = new MemoryCache({ maxEntries: 500, defaultTtlMs: 30_000 });
await memory.set('catalog:featured', ['one', 'two']);
await memory.get<string[]>('catalog:featured');

const redis = new RedisCache({ url: 'redis://localhost:6379', keyPrefix: 'myapp:' });
await redis.connect();
await redis.set('user:1', { name: 'Alice' }, { ttlMs: 60_000 });
await redis.disconnect();
```

Both implement `CacheStore` (`get`/`set`/`delete`/`clear`/`has`) and `KeyedCacheStore`
(`keys()`). `MemoryCache` is a bounded LRU with an injectable clock, keeps values by
reference (so cached `undefined` is distinguishable via `has()`), and is **process-local**.
`RedisCache` is a true distributed store using native `SETEX` TTL, prefix-scoped `clear()`
(never `FLUSHDB` when a prefix is set), `increment` via a server-side Lua script, and
`getMany`/`setMany` batching.

### Serialization safety

All string-backed values use a versioned envelope (`sveltex-cache:v1:`) produced by
`serializeCacheValue` / `deserializeCacheValue` (`./serialization`). A cached `undefined`
round-trips exactly, and a corrupt or legacy payload raises `CacheSerializationError`
instead of being silently treated as a miss. Values that cannot round-trip through JSON
without data loss are **rejected**, not coerced: `bigint`, functions, symbols, `NaN`/
`Infinity`, circular references, nested `undefined`, `Date`, `Map`/`Set`, typed arrays and
class instances. `__proto__` keys are dropped on parse.

> Keys written by builds before this envelope change do not carry the prefix and will be
> reported as corrupt. Flush those keys (or use a new `keyPrefix`) when upgrading.

## Namespaces and invalidation

```ts
import { createNamespace, invalidatePrefix } from '@sveltex/cache';

const users = createNamespace(redis, 'users');   // requires a KeyedCacheStore
const posts = createNamespace(redis, 'posts');
await users.set('1', { name: 'Alice' });       // isolated physical key
await users.clear();                           // only deletes this namespace
await invalidatePrefix(redis, 'catalog:');     // pattern-based invalidation
```

Namespace/key segments are `encodeURIComponent`-escaped so neither user input can inject a
separator and cross a tenant boundary. `invalidateKeys`, `invalidatePrefix` and
`invalidateMatching` report how many keys were actually removed.

## Tag-based invalidation

```ts
import { TaggedCache } from '@sveltex/cache';
import { RedisCache, RedisTagVersionSource } from '@sveltex/cache/redis';

const cache = new RedisCache({ keyPrefix: 'app:' });
await cache.connect();
const tagged = new TaggedCache(cache, { versions: cache.createTagVersionSource() });

await tagged.set('post:1', post, { tags: ['posts', 'author:7'], ttlMs: 60_000 });
await tagged.invalidateTag('author:7');   // O(1) generation bump, shared across processes
await tagged.get('post:1');               // undefined (stale entry lazily deleted)
```

`TaggedCache` stores each entry with the generation of every tag it depends on. Bumping a
generation (`InMemoryTagVersionSource` by default, `RedisTagVersionSource` for distributed
`INCR`/`MGET`) invalidates all dependent entries in O(1) — no keyspace scan. `invalidateTags`
bumps several tags at once. Tag names are restricted to a safe character set and reject
`__proto__`, `constructor` and `prototype`.

**Semantics, stated plainly:** invalidation is a *logical* generation bump plus *lazy*
physical deletion on the next read, ultimately bounded by each entry's TTL. It is not an
immediate physical purge. The default version source is process-local; bind
`RedisTagVersionSource` (or implement `CacheTagVersionSource`) for cross-process invalidation.

## Graceful fallback

```ts
import { FallbackCache, MemoryCache } from '@sveltex/cache';

const resilient = new FallbackCache({
  primary: redis,
  fallback: new MemoryCache(),
  failureThreshold: 3,
  recoveryProbeMs: 2000,
  onError: (error) => logger.warn(error.operation, error.cause),
  onStateChange: (state) => metrics.set('cache.state', state),
});
```

A three-state circuit breaker (`healthy` → `degraded` → `probing`) skips the primary while
it is failing and serves the write-through local store. Every primary failure is wrapped
in `CacheStoreError` (with the original error as `cause`), retained in `lastError`, and
delivered to `onError` — errors are **never silently swallowed**. `state`, `failureCount`
and `probe()` make degradation observable. Reads served from the fallback while degraded
may be stale; this is explicit rather than hidden.

## Stampede protection

```ts
import { StampedeGuard, computeTtlWithJitter } from '@sveltex/cache';

const guard = new StampedeGuard(cache);
await guard.getOrLoad('post:1', () => db.findPost(1), {
  ttlMs: 60_000,
  jitterRatio: 0.2,   // spread expirations across processes
});
```

Concurrent loads of the same cold key share one loader promise (single-flight); loader
failures are never cached. `computeTtlWithJitter` applies symmetric TTL jitter.
**Single-flight is process-local** — cross-process stampedes are mitigated, not
eliminated, by TTL jitter.

## Errors

`CacheError` (base, with `code`) → `CacheConfigurationError`, `CacheSerializationError`,
`CacheStoreError` (adds `operation`). All preserve the standard `cause`.

## Subpath exports

| Subpath | Contents |
|---|---|
| `@sveltex/cache` | contracts, `MemoryCache`, errors, validation, and re-exports of all decorators |
| `@sveltex/cache/redis` | `RedisCache`, `RedisTagVersionSource`, `RedisTagVersionSourceOptions` |
| `@sveltex/cache/serialization` | envelope constants and encode/decode functions |
| `@sveltex/cache/namespace` | `KeyedCacheStore`, `CacheNamespace`, `createNamespace`, key codecs |
| `@sveltex/cache/invalidation` | `invalidateKeys` / `invalidatePrefix` / `invalidateMatching` |
| `@sveltex/cache/tags` | `TaggedCache`, `TaggedCacheSetOptions`, version sources |
| `@sveltex/cache/fallback` | `FallbackCache`, `FallbackState`, options |
| `@sveltex/cache/stampede` | `StampedeGuard`, `computeTtlWithJitter`, options |

## Status and limits

- ✅ `MemoryCache`, `RedisCache`, TTL/expiration, atomic `increment`/batch operations,
  connection lifecycle.
- ✅ Namespaces, key/prefix/predicate invalidation, tag invalidation, serialization safety,
  typed errors, graceful fallback with circuit breaker, single-flight + TTL jitter.
- ✅ Verified against a live Redis 7 instance (real integration tests, 0 skipped).
- **Not claimed:** an immediate physical purge on tag invalidation; a distributed lock for
  single-flight; automatic recovery detection without a probe; storage of `Date`/`Map`/
  `Set`/`BigInt`/class instances; any backend other than memory and Redis.
