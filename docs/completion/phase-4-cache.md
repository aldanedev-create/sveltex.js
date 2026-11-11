# Phase 4 — Cache completion report

**Status:** implemented, tested against real Redis 7, documented. Phase 4 done; Phases 5–12 remain (historical status at the time of writing — Phase 5 has since been delivered; see the [Phase 5 report](./phase-5-realtime.md)).
**Date:** 2026-11-11
**Core rule honoured:** *Finish what SvelteX already promises before making SvelteX promise more.*
No new package was created — only `@sveltex/cache` was extended.
**Measured full-monorepo gate:** `pnpm check` → **734/734** runtime (0 failures, 0 skipped,
16 test projects), `pnpm test:security` → **119/119** (15 packages), `pnpm test:types` →
**16/16**. Live PostgreSQL 16 / MySQL 8.0 / Redis 7 services throughout.

> This report is the authoritative record of the measured numbers. Historical baselines
> (488/488, 536/536, 565/565, 637/637) are retained in
> [`phase-0-audit.md`](./phase-0-audit.md) for traceability and are **not** current totals.

## Objective

Per [`docs/completion-plan.md`](../completion-plan.md) Phase 4, close every gap the Phase 0 audit
recorded for `@sveltex/cache`: namespaces, invalidation, tag-based invalidation, serialization
safety, error handling, connection lifecycle, graceful fallback and stampede protection —
with **real implementations, real tests, no fake providers and no skipped tests**.

### Phase 0 gap → delivery

| Phase 0 gap | Delivered |
| --- | --- |
| Namespaces, tag-based invalidation, graceful fallback | `CacheNamespace` + `createNamespace`, `TaggedCache` + `RedisTagVersionSource`, `FallbackCache` |
| Tags / advanced invalidation / stampede protection | `invalidateKeys` / `invalidatePrefix` / `invalidateMatching`, generation-based tag invalidation, `StampedeGuard` + TTL jitter |
| Serialization safety | Strict versioned `sveltex-cache:v1:` envelope with typed `CacheSerializationError` |
| Error handling / connection lifecycle | Typed `CacheError` hierarchy, `CacheStoreError(operation, cause)`, always-closing `disconnect()` |

## What Phase 4 added

| Capability | Module | Implementation |
| --- | --- | --- |
| Typed errors | `src/errors.ts` | `CacheError` (with `code` + `cause`), `CacheConfigurationError`, `CacheSerializationError`, `CacheStoreError` (with `operation`) |
| Shared validation | `src/validation.ts` | `validateCacheKey` (≤1024 chars), `validateCacheTtl`, `validateCacheTag` (`^[A-Za-z0-9._:-]+$`, ≤256, forbids `__proto__`/`constructor`/`prototype`), `validateCacheNamespace` — used by **every** store and decorator |
| Strict wire format | `src/serialization.ts` | `CACHE_ENVELOPE_PREFIX = 'sveltex-cache:v1:'`; `u` tag = cached `undefined`, `j` tag = strict JSON; root `assertSerializable` before `JSON.stringify`; corrupt/legacy payloads raise instead of silently missing; `__proto__` dropped on parse |
| Namespaces | `src/namespace.ts` | `CacheNamespace implements KeyedCacheStore`, `createNamespace`, `namespaceKeyPrefix`, `encodeNamespaceKey` / `decodeNamespaceKey` using `encodeURIComponent(namespace)` under `__sveltex_cache_ns__:`; scoped `clear()` |
| Invalidation | `src/invalidation.ts` | `invalidateKeys`, `invalidatePrefix`, `invalidateMatching` (predicate over decoded logical keys) |
| Tag invalidation | `src/tags.ts` | `CacheTagVersionSource` port, `InMemoryTagVersionSource`, `TaggedCache` storing `{ gens, hasData, data }` envelopes; stale entries lazily physically deleted on read; `invalidateTag` / `invalidateTags` |
| Graceful fallback | `src/fallback.ts` | `FallbackCache` with `healthy` → `degraded` → `probing` states, `failureThreshold`, `recoveryProbeMs`, injected `now`, `lastError`, `failureCount`, `onError`, `onStateChange`, `probe()`, write-through and half-open recovery; observer exceptions contained |
| Stampede protection | `src/stampede.ts` | `StampedeGuard.getOrLoad` (process-local single-flight, loader errors never cached, cached `undefined` supported), `computeTtlWithJitter`, early `jitterRatio` validation |
| Core store | `src/index.ts` (rewritten) | Centralized validation, `MemoryCache.keys()` / `increment()`, re-exports of all Phase 4 modules |
| Redis adapter | `src/redis.ts` (rewritten) | Envelope-based `get`/`set`/`getMany`/`setMany`; server-side **Lua** `increment()` compatible with `get()`; prefix-scoped `SCAN` `keys()` and `clear()`; `createTagVersionSource()` / `RedisTagVersionSource` (real `INCR`/`MGET`/`SCAN`); `setMany({ ttlMs: 0 })` deletes; `disconnect()` always closes the client |

### Wire format

```
sveltex-cache:v1:<tag><body>
  u : empty body            -> undefined (encoded exactly, never a miss)
  j : JSON.stringify(value) -> strict JSON produced by assertSerializable
```

Root validation must run **before** `JSON.stringify`, because `toJSON()` (e.g. `Date.toJSON()`)
is invoked before the replacer. This was found by a failing test and fixed with
`assertSerializable(value, '')`. BigInt, symbol, function, circular references, non-finite
numbers, `Date`/`Map`/`Set`/`RegExp`/typed arrays and class instances are rejected with
`CacheSerializationError` rather than silently coerced. Values written by builds before the
envelope change are treated as **legacy/corrupt** and raise — documented in the package README,
not silently decoded.

### Fallback state machine

| State | Meaning |
| --- | --- |
| `healthy` | Primary serves every operation; failures wrapped in `CacheStoreError` with `cause` |
| `degraded` | Threshold reached; reads fall back to the secondary store (may be **stale**), writes go write-through, recovery probes are gated by `recoveryProbeMs` |
| `probing` | Half-open: a single probe decides recovery; `probe()` can also be called explicitly |

Degradation is observable (`state`, `lastError`, `failureCount`, `onError`, `onStateChange`).
Stale fallback reads are explicitly **documented**, never advertised as fresh.

### Stampede semantics (honest limits)

`StampedeGuard` coalesces concurrent loads **within one process**. `computeTtlWithJitter`
de-synchronizes expiration across processes but is **not a distributed lock**. No lease,
`SET NX` coordination or cross-process lock is claimed. Loader failures are never cached and
never poison the in-flight map.

## Public API and version policy

Six new subpath exports were added on top of `/redis`:

```
@sveltex/cache/serialization   @sveltex/cache/namespace
@sveltex/cache/invalidation    @sveltex/cache/tags
@sveltex/cache/fallback        @sveltex/cache/stampede
```

The main entry re-exports the driver-neutral modules but **not** `ioredis`, so consumers that
never use Redis do not pull it in. A public-API type test
(`tests/types/phase4.test.ts`) imports every new subpath from `dist/`.

The package version was briefly set to `0.2.0` and **reverted to `0.1.0`**: the CLI integration
registry enforces a single `SVELTEX_PACKAGE_VERSION = '0.1.0'` across all workspace packages.
The bump is deferred to the **Phase 11 release audit** and recorded as `Unreleased` in
`packages/cache/CHANGELOG.md`. No token, credential or unpublished claim was introduced.

## Verification (measured 2026-11-11, services live)

| Gate | Result |
| --- | --- |
| `@sveltex/cache` `npm test` | **121/121** (includes 15 security cases) + subpath type test |
| `@sveltex/cache` `npm run test:security` | **15/15** |
| Full monorepo `pnpm check` | **734/734** runtime, 0 failures, 0 skipped, 16 test projects, exit 0 |
| Full monorepo `pnpm test:security` | **119/119**, 15 packages, 0 failures, 0 skipped, exit 0 |
| Full monorepo `pnpm test:types` | **16/16** projects, exit 0 (also part of `pnpm check`) |
| `npm pack --dry-run --json` (`packages/cache`) | **43 files**, 10 `dist/*.js` + 10 `dist/*.d.ts`, version `0.1.0`, **no `src`/`tests` leakage** |
| Phase 3 → Phase 4 delta | **+97 runtime** (24 → 121), **+14 security** (1 → 15); monorepo 637 → 734 runtime, 105 → 119 security |

**Real integration, no fakes.** `tests/redis-phase4-integration.test.mjs` runs against a live
Redis 7 server and covers `keys()`, namespace-scoped `clear()`, distributed tag invalidation via
`INCR`/`MGET`, a standalone `RedisTagVersionSource`, corrupt payload rejection, unsafe values,
cached `undefined`, envelope-compatible `increment()`, `setMany({ ttlMs: 0 })`, and graceful
fallback against a **genuinely unreachable** port (`127.0.0.1:6399`). No provider was faked and
no test was skipped.

## Test inventory

| File | Coverage |
| --- | --- |
| `tests/serialization.test.mjs` | `undefined`, primitives, BigInt/function/symbol/non-finite/circular/`Date`/`Map`/`Set`/class rejection, corrupt + forged payloads, `__proto__`, typed errors |
| `tests/errors.test.mjs` | Error hierarchy and all validators |
| `tests/namespace.test.mjs` | Isolation, escaped key segments, scoped `clear()`, nesting, invalidation helpers |
| `tests/tags.test.mjs` | Generation-based invalidation, multi-tag, lazy cleanup |
| `tests/fallback.test.mjs` | Circuit-breaker transitions, error wrapping, write-through, half-open probe, observer containment |
| `tests/stampede.test.mjs` | Single-flight, coalescing, loader errors, TTL jitter, cached `undefined` |
| `tests/security/phase4-security.test.mjs` | 14 SEC cases (prototype pollution, corrupt/forged envelopes, tag pollution, namespace boundaries, circular refs, NaN/Infinity, bounded keys/tags, backend observability, loader-error non-caching, forged tagged envelopes) |
| `tests/types/phase4.test.ts` | Public API + all subpath declarations |
| `tests/redis-phase4-integration.test.mjs` | Real Redis 7 + unreachable-port fallback |

Security findings **SEC-041 – SEC-046** are recorded in
[`docs/audit/security-findings.md`](../audit/security-findings.md).

## XERJ

Per the standing repository-research discipline, the local XERJ node
(`http://127.0.0.1:9200`) was verified live and queried for the Phase 4 task list, the Phase 0
gap table and all stale "tags deferred" wording before implementation. A stale-index warning
triggered an incremental reindex (2133 records live, 33 duplicate aliases, 0 junk records;
graph 706 edges). After the documentation sync, the incremental run reported
`stale-resume-plan` — 18 newly created Phase 4 files lay outside its frozen resume plan — so the
index was rebuilt **in full**:

```
XERJ_DISABLE_FEEDBACK=true xerj autoindex /workspace/sveltex --fresh --workers 4 --url http://127.0.0.1:9200
427 files, 2292 records live, 32 duplicate aliases, 0 junk records, 0 junk/skipped files
ax-docs 2277 docs, ax-packages-cli 15 docs; graph 1395 edges; exit 0
```

A follow-up `xerj search` confirms the Phase 4 report and the `sveltex-cache:v1:` wire format
are searchable, and the old "tags deferred" wording is gone. Local index data
(`.xerj-data/`) remains gitignored.

## Documentation synced

`README.md`; `docs/roadmap.md`; `docs/specification.md` (cache row, package table, 734/119
totals, Stage-3 detail, Phase 2–4 baseline + Phase 4 verification section);
`docs/packages/README.md`; `docs/manifest.json` (39 documents, Phase 4 report registered);
`docs/completion-plan.md` (all 20 Phase 4 checkboxes ticked);
`docs/completion/phase-0-audit.md` (Phase 4 table + completion criteria);
`docs/audit/README.md`, `package-status.md`, `testing-status.md`, `repository-audit.md`,
`security-findings.md` (SEC-041 – SEC-046), `progress.md` (Session 11);
`packages/cache/README.md` and `packages/cache/CHANGELOG.md`; this report.

## Not claimed / still open

- **Distributed lock.** `StampedeGuard` is process-local; TTL jitter is not a lock or lease.
- **Other distributed backends.** Only in-memory and Redis stores ship.
- **Stale fallback reads.** A degraded `FallbackCache` may serve stale data — documented, not hidden.
- **Legacy values.** Pre-envelope payloads are rejected, not migrated in place.
- **SvelteKit `handle` wiring** (Phase 10), **package version bump** (Phase 11),
  cross-package scenario coverage (Phase 10) and consumer-side clean install (CI/release).

## Next

Phase 5 — `@sveltex/realtime` completion (WebSocket / SSE transports), per the plan — delivered; see the [Phase 5 report](./phase-5-realtime.md).
Phases 5–12 remain.
