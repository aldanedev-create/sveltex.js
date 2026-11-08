# @sveltex/cache

Driver-neutral cache contract with a bounded in-memory implementation and a Redis-backed distributed adapter.

## Install

```sh
pnpm add @sveltex/cache
# Redis adapter requires ioredis as a peer dependency
pnpm add ioredis
```

## Use the memory cache

```ts
import { MemoryCache } from '@sveltex/cache';

const cache = new MemoryCache({ maxEntries: 500, defaultTtlMs: 30_000 });
await cache.set('catalog:featured', ['one', 'two']);
const featured = await cache.get<string[]>('catalog:featured');
```

The memory driver supports TTL expiration and LRU eviction. It is process-local and is not shared across server instances. Use the Redis adapter for shared/distributed caching.

## Use the Redis adapter

```ts
import { RedisCache } from '@sveltex/cache/redis';

const cache = new RedisCache({ url: 'redis://localhost:6379', keyPrefix: 'myapp:' });
await cache.connect();
await cache.set('user:1', { name: 'Alice' }, { ttlMs: 60_000 });
const user = await cache.get<{ name: string }>('user:1');
await cache.disconnect();
```

The Redis adapter implements the same `CacheStore` contract. Values are JSON-serialized; TTL is delegated to Redis `SETEX`/`EXPIRE`. Connection options accept either a `url` or `host`/`port`. A `keyPrefix` provides namespace isolation (used by `clear()` to avoid a global `FLUSHDB`). It also exposes `increment`, `getMany`, and `setMany` for atomic multi-key operations.

## Status

- `MemoryCache` — process-local, production-ready development/test implementation.
- `RedisCache` — distributed adapter backed by `ioredis`, verified against a live Redis 7 instance (17 integration tests).
- Tags and advanced invalidation are deferred.
