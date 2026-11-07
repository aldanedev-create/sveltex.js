# @sveltex/cache

Driver-neutral cache contract and a bounded in-memory implementation.

## Install

```sh
pnpm add @sveltexjs/cache
```

## Use the memory cache

```ts
import { MemoryCache } from '@sveltexjs/cache';

const cache = new MemoryCache({ maxEntries: 500, defaultTtlMs: 30_000 });
await cache.set('catalog:featured', ['one', 'two']);
const featured = await cache.get<string[]>('catalog:featured');
```

The memory driver supports TTL expiration and LRU eviction. It is process-local and is not shared across server instances. Use a shared production driver when cache consistency across instances is required.

## Status

Initial 0.1.0 foundation. Redis and other distributed drivers, tags, and advanced invalidation are planned separately.
