# Changelog

## Unreleased — Completion-plan Phase 4 (2026-11-11)

> Package version remains `0.1.0` (unpublished). The monorepo keeps a single version
> across all `@sveltex/*` packages; a version bump is deferred to the release audit
> (Phase 11).

Added (all real implementations, no new package, no fake provider):

- **Typed error hierarchy** (`errors.ts`): `CacheError`, `CacheConfigurationError`,
  `CacheSerializationError`, `CacheStoreError` — all preserve the standard `cause`.
- **Serialization safety** (`serialization.ts`): versioned `sveltex-cache:v1:` envelope,
  exact `undefined` round-trip, strict rejection of values that would silently lose data
  (`bigint`, functions/symbols, `NaN`/`Infinity`, circular references, nested `undefined`,
  `Date`/`Map`/`Set`/typed arrays/class instances), corrupt/legacy payload detection, and
  `__proto__` stripping on parse.
- **`RedisCache`** now uses that envelope everywhere (`set`/`get`/`getMany`/`setMany`).
  `increment` is a server-side Lua script so counters stay atomic and compatible with
  `get`. `keys()` enables scoped invalidation; `disconnect()` always closes the underlying
  client (also after a failed probe).   `setMany({ ttlMs: 0 })` now deletes instead of
  persisting. **Wire-format change:** keys written before this change (the previous build)
  are reported as corrupt.
- **Namespaces** (`namespace.ts`): `KeyedCacheStore`, `CacheNamespace`, `createNamespace`,
  escaped key segments, namespace-scoped `clear()` that never flushes unrelated keys.
- **Invalidation** (`invalidation.ts`): `invalidateKeys`, `invalidatePrefix`,
  `invalidateMatching`.
- **Tag-based invalidation** (`tags.ts`): `TaggedCache`, `TaggedCacheSetOptions`,
  `CacheTagVersionSource`, `InMemoryTagVersionSource` — O(1) generation bumps with lazy
  physical deletion on read. `./redis` adds `RedisTagVersionSource` (real `INCR`/`MGET`)
  and `RedisCache.createTagVersionSource()` for cross-process invalidation.
- **Graceful fallback** (`fallback.ts`): `FallbackCache` with a healthy/degraded/probing
  circuit breaker, write-through mirroring, `failureThreshold`/`recoveryProbeMs`,
  `onError`/`onStateChange` observability, `lastError`, and `probe()`.
- **Stampede protection** (`stampede.ts`): `StampedeGuard` single-flight `getOrLoad` and
  `computeTtlWithJitter`.
- **Exports**: new subpaths `./serialization`, `./namespace`, `./invalidation`, `./tags`,
  `./fallback`, `./stampede`; `test` script now includes security tests.

Not claimed: immediate physical purge on tag invalidation; distributed single-flight lock;
automatic recovery detection without a probe; non-JSON value types; backends other than
memory and Redis.

## 0.1.0

- Initial independently installable SvelteX package.
