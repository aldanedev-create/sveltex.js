# SvelteX Security Findings

**Audit date:** 2026-11-11  
**Auditor:** Security engineer

---

## Security finding summary

| ID | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| SEC-001 | **Critical (fixed)** | Supply chain | Package name inconsistency (`@sveltexjs/*` vs `@sveltex/*`) caused workspace resolution failure. While not a direct security vulnerability, a broken workspace could mask missing dependencies or force workarounds that bypass dependency verification. | **Fixed** |
| SEC-002 | Info | Prototype pollution | `cloneData` and `validateConfig` properly reject `__proto__`, `prototype`, `constructor` keys. Symbol keys rejected. Accessors and non-enumerable properties rejected. | **Secure** |
| SEC-003 | Info | Timing attacks | Auth service verifies a precomputed dummy hash when the user is absent, reducing timing-based user enumeration. Dummy hash length is validated (20–4096 chars). | **Secure** |
| SEC-004 | Info | Credential exposure | Auth `sanitizeUser` strips `passwordHash` before returning user objects. Results are deep-frozen. | **Secure** |
| SEC-005 | Info | SQL injection | Database package never constructs SQL from user input. Parameterized queries only. SQL length validated (max 1,000,000 chars). Parameter types validated. | **Secure** |
| SEC-006 | Info | Session fixation | Session rotation is implemented with atomic compare-and-set. Rotation is still **explicit**, not automatic middleware, but Phase 3 adds two concrete rotation points: `SessionCookieTransport.rotate()` and `createAuthSessionPort().rotate()` rewrite the cookie and invalidate the old id on privilege change. | **Secure (with caveat)** |
| SEC-007 | Low | Rate limiting | Auth attempt limiter is optional (`options.limiter`). Production deployments must supply one; no default rate limiting is provided. | **Documented** |
| SEC-008 | Low | CSRF | ~~Excluded from the session package.~~ **Resolved in completion-plan Phase 3**: `CsrfProtection` (double-submit + constant-time compare + optional HMAC session binding) and `__Host-` secure cookie transport are shipped. See SEC-035 – SEC-040. Automatic framework middleware is still not shipped. | **Fixed (Phase 3)** |
| SEC-009 | Low | Secret handling | No secrets are hardcoded. Config metadata rejects functions/symbols/bigints. No environment variable reading in packages (by design). | **Secure** |
| SEC-010 | Info | Immutable results | All package return values are frozen. Config is deep-frozen. Session records are frozen. Cache entries are immutable. | **Secure** |
| SEC-011 | Info | AbortSignal | Database operations support AbortSignal for cancellation. Prevents resource exhaustion from long-running queries. | **Secure** |
| SEC-012 | Low | Input validation | All packages validate input types and lengths (keys, SQL, emails, passwords, TTLs, session IDs). Bounds checking is comprehensive. | **Secure** |
| SEC-013 | Info | Password hashing | `Argon2Hasher` uses Argon2id via `@node-rs/argon2` with sensible memory/time/parallelism defaults. Salts are unique per hash. Output is an opaque encoded string. Dummy hash shares the same algorithm/parameters as real hashes, preserving timing-mitigation parity. | **Secure** |
| SEC-014 | Info | Cache key validation | `RedisCache` validates keys (non-empty, ≤1024 chars) and TTLs (non-negative finite) before issuing any command; Phase 4 centralizes these checks in `validateCacheKey` / `validateCacheTtl` / `validateCacheTag` / `validateCacheNamespace` across every store. Values use the strict versioned `sveltex-cache:v1:` envelope (SEC-041) rather than bare JSON; no user input is interpolated into Redis commands, preventing injection. `clear()` and `keys()` are prefix-scoped `SCAN` (never `FLUSHDB`). | **Secure** |
| SEC-015 | Info | Distributed session atomicity | `RedisSessionStore` implements `createIfAbsent`, `compareAndSet`, and `rotate` as server-side **Lua scripts** (`EVAL`), so the read-validate-write sequence is atomic across processes. This closes the TOCTOU window that a naive GET-then-SET store would expose (session resurrection / lost concurrent updates / rotation collisions). All values are JSON-serialized with no command interpolation; `clear()` is `SCAN`+`DEL` scoped to `keyPrefix` (never `FLUSHDB`); corrupt or logically expired records are purged on read; returned data is deeply cloned and frozen. | **Secure** |
| SEC-016 | Info | Reference-app authorization boundary | `examples/reference-app` rejects client-supplied `roles` on registration (self-privilege-escalation); `admin` is granted only via trusted `adminEmails` bootstrap config. Every privileged call resolves the principal from a live session **plus a fresh `users` row** — never a cached or client-supplied role. `createPost` derives `authorId` from the session (payload `authorId` ignored); all SQL is parameterized; `grantRole` uses an allow-list and invalidates the cached profile; `rotateSession` is atomic; session IDs are validated before use. Covered by 18 integration tests. | **Secure** |
| SEC-017 | Info | Realtime authorization boundary | `RealtimeHub` requires an explicit `authorize` hook (no implicit allow) and evaluates `deliver` **per subscriber**; delivered payloads are deep-frozen; channel names reject traversal/control characters; at-least-once redelivery is de-duplicated by a bounded **per-subscriber** id cache (an initial global-set design was corrected). 8 pre-existing security tests; Phase 5 adds 12 (SEC-047 – SEC-052). | **Secure** |
| SEC-018 | Info | Job queue atomicity and shutdown | `InMemoryJobQueue.claim()` is atomic so at-least-once redelivery cannot double-execute a side effect; `Worker.stop()` drains in-flight handlers while rejecting new work synchronously; retries/backoff are capped and permanent failures dead-letter instead of looping. Phase 6 extends this to `RedisJobQueue` (four Lua scripts for atomic cross-process enqueue/claim/finalize/cancel) and `SqlJobQueue` (transaction-based `FOR UPDATE SKIP LOCKED` claim, partial unique dedupe index, concurrent-safe schema creation). Strict `sveltex-jobs:v1:` serialization rejects corrupt/legacy/tampered records. 7 pre-existing + 10 Phase 6 security tests (SEC-053 – SEC-062). | **Secure** |
| SEC-019 | Info | Storage path traversal and atomicity | User keys reject absolute paths, backslashes, `.`/`..` segments, and control characters, then map to **SHA-256 hex filenames** (user paths never reach the filesystem). Writes are atomic (temp + `rename`, metadata sidecar last); a symlinked `objects/` directory is rejected; reads verify etag/size. 9 security tests. | **Secure** |
| SEC-020 | Info | Mail header injection and XSS | CRLF/NUL injection is rejected in subjects, names, and headers; `renderTemplate` HTML-escapes interpolated values by default; bounded retries are deterministic and a permanent failure throws `MailSendError` with `attempts` + `cause` — never a false success. `TestTransport` never contacts an external service. 9 security tests. | **Secure** |
| SEC-021 | Info | Testing helpers do not bypass real core | `@sveltex/testing` delegates to the real `@sveltex/core` DI/lifecycle, so config validation, request-scope enforcement, and lifecycle hook failures are surfaced rather than bypassed. `withTestApplication` guarantees cleanup even on a thrown body; forgotten request scopes are disposed; fakes expose frozen defensive snapshots and reject use after `close()`. 12 security tests. | **Secure** |
| SEC-022 | Info | CLI never executes project configuration | `sveltex config`/`doctor` inspect `sveltex.config.ts` **as source text** (default-export detection, referenced env names, unsafe-exec markers) and never import or evaluate it. Shape validation is delegated to `@sveltex/config`. Secret values are redacted by key pattern and never printed; only missing env var **names** are reported — the CLI never invents or reads a value. 9 CLI security tests. | **Secure** |
| SEC-023 | Info | No shell interpretation / option injection | Every child process uses `spawn(..., { shell: false })` with argument arrays only. Project names, script names, and package specifiers are validated against shell metacharacters; a leading-dash specifier such as `--ignore-scripts` is rejected (found by a security test and fixed). Generated paths reject absolute paths, `.`/`..`, encoded traversal (`%2e`/`%2f`/`%5c`), and NUL. | **Secure** |
| SEC-024 | Info | CLI file mutations are previewable and reversible | Existing files are never overwritten without `--force`/`--yes`; `--dry-run` writes nothing; all CLI-owned edits go through `ChangeSet` with rollback (including partial-failure rollback of already-applied files). `init` composes an existing `src/hooks.server.ts` handle as `userHandle` with SvelteKit `sequence()` instead of replacing it, preserving user comments. A failed install rolls back every generated/edited file. | **Secure** |
| SEC-025 | Info | No fake integrations or invented compatibility | The CLI integration registry lists only the 14 real shipped `@sveltex/*` packages; no SMTP, S3, hosted-Redis, or other external provider adapter is advertised (the real WebSocket/SSE gateways shipped in `@sveltex/realtime` Phase 5 are in-package network transports, not advertised hosted providers). `upgrade` reports CLI-owned metadata only (no registry lookup, no guessed versions). `doctor` reports missing env **names** only and flags process-local adapters in multi-instance/production setups. The `saas` starter explicitly disclaims auth, persistence, billing, and payments. | **Secure** |
| SEC-026 | Low (fixed) | `init --no-install` was silently ignored | The flag is globally accepted (used by `create`) but `init` still invoked the package manager, so an explicit "do not install" request executed an install and failed offline, rolling back CLI-owned changes. Fixed: `init` now honors `--no-install`, skips installation and the automatic project check, reports `installed: false`, and lists manual install/check steps. A regression test asserts no runner calls occur. | **Fixed** |
| SEC-027 | Info | Pooled adapters never rewrite SQL | `PostgresAdapter` and `MysqlAdapter` bind values through their drivers' parameterized APIs (`$n` / `?`); no interpolation or SQL parsing. Injection-shaped values are tested against real servers and return zero rows. `Database` still validates SQL and parameter types before dispatch. | **Secure** |
| SEC-028 | Info | Migration ledger identifiers and checksums | Ledger table names are restricted to simple SQL identifiers; injection-shaped names throw. Every migration is SHA-256 checksummed over its full SQL body, and already-applied migrations must be an unchanged prefix, so tampering or reordering is rejected. Unknown dialects throw instead of being guessed. | **Secure** |
| SEC-029 | Info | Transaction connection isolation | Each top-level transaction acquires a dedicated pooled connection; concurrent transactions are isolated (verified against real PostgreSQL/MySQL). Nested transactions use `AsyncLocalStorage` + `SAVEPOINT` on the same connection; leaked executors are rejected after settle, and failures roll back and release the connection. | **Secure** |
| SEC-030 | Low (fixed) | SQLite write `rowCount` was misleading | Plain `INSERT`/`UPDATE`/`DELETE` reported `rowCount: 0` (only `RETURNING` produced a count), so callers could mistake a successful write for a no-op. Fixed with `total_changes()` measured around each statement; covered by regression tests. | **Fixed** |
| SEC-031 | Info | ORM adapter capability integrity | `defineDatabaseAdapter` rejects forged capabilities declared without an implementation, unknown capability keys, and non-boolean values at definition time; injection-shaped / overlong / uppercase / empty adapter names are rejected; the registry refuses malformed adapters and duplicate names. Undeclared capabilities cannot be invoked (`UnsupportedCapabilityError`). | **Secure** |
| SEC-032 | Info | ORM adapter error and health redaction | `connect`/`healthCheck`/conformance failures are wrapped as `DatabaseAdapterError` with a fixed message — connection strings, passwords and tokens from driver errors never reach callers, health reports, or `runAdapterConformance` output (which substitutes `[redacted]`). | **Secure** |
| SEC-033 | Info | Passive environment configuration | `configFromEnv` collects values verbatim but never evaluates or executes them; the resulting config is frozen. `redactConfig` masks password/token fields while leaving non-secret fields readable. No env value is logged by default. | **Secure** |
| SEC-034 | Info | Optional-peer isolation (no silent fake) | The main entry and `contracts`/`core`/`testing` subpaths import no ORM; built-in Drizzle/Kysely adapters require their declared optional peer and fail loudly (`ERR_MODULE_NOT_FOUND`) when it is absent. Verified by an isolation test with both ORMs removed. No fallback or fake adapter is substituted. | **Secure** |
| SEC-035 | Info | `__Host-` secure cookie defaults and Set-Cookie injection | `resolveSessionCookieOptions` returns frozen defaults (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`) and rejects any downgrade under the `__Host-` prefix, `SameSite=None`/`Partitioned` without `Secure`, invalid `maxAge`, and CRLF/semicolon/control-character injection in names, values and paths. `serializeSetCookie` is a pure, injection-safe serializer. 18 cookie tests + security cases. | **Secure** |
| SEC-036 | Info | CSRF double-submit with constant-time compare and optional HMAC binding | Safe methods (`GET/HEAD/OPTIONS/TRACE`) bypass; every other method requires a header or form token matching the double-submit cookie. Comparison is performed on fixed-length SHA-256 digests with `timingSafeEqual` (no early-exit leak). When a `secret` is configured, tokens are HMAC-bound to a session id so a token minted for one session cannot protect another. The CSRF cookie is `__Host-`-prefixed and `SameSite=Strict` but deliberately not HttpOnly (JS must read it). Stable `CsrfError` codes; 16 tests + 12 security cases. | **Secure (with documented unbound-mode caveat)** |
| SEC-037 | Info | Cookie-header parsing and stale-cookie handling | `parseCookieHeader` returns a null-prototype record, first-duplicate-wins, percent-decodes values, and blocks `__proto__`/`prototype`/`constructor` pollution. `SessionCookieTransport.read()` validates the id shape, resolves it through `SessionManager` (enforcing expiry), and **clears** the cookie when the id is malformed or the session is missing — an attacker-controlled cookie cannot fabricate a session or cause a 500. `Max-Age` derives from the remaining TTL via the same injected clock. | **Secure** |
| SEC-038 | Info | SQL session-store injection defence and single-statement atomicity | `DatabaseSessionStore` validates table names as simple SQL identifiers (rejects injection shapes), renders `?` for SQLite/MySQL and `$1..$n` for PostgreSQL, and binds every value through the executor — no user input reaches SQL text. `createIfAbsent` uses `INSERT … SELECT … WHERE NOT EXISTS`, `compareAndSet` uses `UPDATE … WHERE revision = ?`, and `rotate` runs in one transaction with a conditional `DELETE … WHERE revision = ?`. Corrupt/expired payloads are purged on read, not trusted. Verified against real SQLite, PostgreSQL 16 and MySQL 8.0; 8 concurrent racers yield exactly one winner. | **Secure** |
| SEC-039 | Info | Session-fixation rotation via the auth bridge | `createAuthSessionPort(manager)` bridges `SessionManager` to `@sveltex/auth`'s `AuthSessionPort`; `create` stores `userId`, `destroy` logs out, and `rotate` rewrites the cookie with a new id while invalidating the old one. Verified end-to-end with a **real `AuthService` + `Argon2Hasher`** (register → login → rotate → revoke → logout). A public-API type test proves the bridge satisfies `AuthSessionPort<SessionHandle<Data>>`. | **Secure** |
| SEC-040 | Info | Honest per-user revocation | `revokeAllForUser` is a first-class `SessionManager` method over a `RevocableSessionStore` port (memory/Redis/SQL). Stores that cannot support it throw `SessionRevocationUnsupportedError` instead of silently succeeding. The Redis implementation is a namespace-scoped `SCAN` with `keyPrefix` isolation and is documented as **O(N)** — no false O(1) claim. Denormalized `user_id` allows O(1) SQL revocation. | **Secure (with documented O(N) caveat)** |
| SEC-041 | Info | Strict cache wire envelope | `serializeCacheValue` emits a versioned `sveltex-cache:v1:` prefix with a `u` tag for cached `undefined` and a `j` tag for strict JSON. Root validation runs **before** `JSON.stringify`, so `Date.toJSON()`, `Map`/`Set`/class instances and typed arrays cannot silently become a different type; BigInt, symbol, function, circular, non-finite and accessor values throw `CacheSerializationError`. `deserializeCacheValue` rejects corrupt, legacy or forged payloads rather than turning them into silent cache misses, and drops `__proto__` on parse. | **Secure** |
| SEC-042 | Info | Cache key / TTL / tag / namespace validation | `validateCacheKey` (≤1024 chars), `validateCacheTtl`, `validateCacheTag` (`^[A-Za-z0-9._:-]+$`, ≤256 chars, `__proto__`/`constructor`/`prototype` rejected) and `validateCacheNamespace` are shared by every store and decorator. No user input is interpolated into Redis commands; `clear()` and `keys()` remain prefix-scoped (`SCAN`, never `FLUSHDB`). | **Secure** |
| SEC-043 | Info | Namespace boundary escaping | `CacheNamespace` prefixes physical keys with `encodeURIComponent(namespace)` under `__sveltex_cache_ns__:`, so a namespace containing `:` or other delimiter-shaped characters cannot collide with or read another namespace's keys. `clear()` deletes only keys decodable within the namespace; prefix/predicate invalidation operates on decoded logical keys. | **Secure** |
| SEC-044 | Info | Tag invalidation integrity | `TaggedCache` stores a serialized generation envelope and compares every tag generation on read; stale entries are lazily deleted rather than served. A tightened `isTaggedEnvelope` guard requires boolean `hasData`, a non-array object `gens` and a present `data` field, so forged payloads are rejected. `RedisTagVersionSource` bumps generations with real `INCR` and reads them with `MGET`/`SCAN`; forbidden tags are rejected before any command is issued. | **Secure** |
| SEC-045 | Info | Backend error observability (no silent failure) | Primary-store failures in `FallbackCache` are wrapped in `CacheStoreError` with `operation` and `cause`; `lastError`, `failureCount`, `state`, `onError`, `onStateChange` and `probe()` expose degradation, and observer exceptions are contained. The fallback is never advertised as fresh — stale reads while degraded are explicitly documented in the README. | **Secure (with documented stale-read caveat)** |
| SEC-046 | Info | Stampede / loader-failure semantics | `StampedeGuard` coalesces concurrent loads per key (process-local single-flight) and applies TTL jitter; `jitterRatio` is validated before any cache lookup or loader starts. Loader failures are never cached and never poison the in-flight map. TTL jitter is explicitly **not** a distributed lock and is documented as such. | **Secure (with documented process-local caveat)** |
| SEC-047 | Info | Strict realtime wire protocol | `encodeWireMessage` / `decodeWireMessage` enforce a versioned `ready` frame, per-direction tag allow-lists, a 64 KiB byte ceiling checked before JSON parsing and after encoding, and strict `validateEnvelope` rebuilds that drop extra keys and strip `__proto__`. Unknown tags, forged server-only frames, legacy versions and control characters raise `RealtimeProtocolError` rather than becoming silent drops. | **Secure** |
| SEC-048 | Info | Deny-by-default gateway authentication | Both `createWebSocketGateway` and `createSseGateway` default to `denyAnonymous()`; anonymous access requires an explicit `allowAnonymous()` opt-in. A throwing authenticator is contained and never implicitly grants access. Unauthenticated WS sockets close with 1008; unauthenticated SSE requests receive 401. | **Secure** |
| SEC-049 | Info | No silent payload coercion at the network boundary | `assertSerializable` walks the original value before `JSON.stringify`, rejecting `Date`, `Map`, `Set`, `RegExp`, `BigInt`, `Symbol`, functions, `NaN`/`Infinity`, `undefined`, `toJSON`-bearing objects, circular and symbol-keyed values. Arrays are allowed via `Array.prototype`; unsafe keys (`__proto__`, `constructor`, `prototype`) are rejected. | **Secure** |
| SEC-050 | Info | Bounded frames and non-leaking errors | Gateway `maxMessageBytes`, client `maxMessageBytes`, request-body limits and SSE `clientId`/channel grammars bound untrusted input. `publicWireError()` returns a fixed message and code; internal error text, connection strings and stack traces are never echoed to clients. | **Secure** |
| SEC-051 | Info | Backpressure and liveness containment | WebSocket uses `bufferedAmount` and terminates slow sockets; SSE uses the `write()` return value with a bounded pending-frame queue. `BoundedQueue` has explicit overflow policies, `HeartbeatMonitor` terminates stalled connections with an injectable clock, and reconnect delays are capped with jitter. Observer failures are contained. | **Secure** |
| SEC-052 | Info | SSE replay isolation | `Last-Event-ID` replay only emits frames for channels the reconnecting client is currently subscribed to, so another channel's events never leak. Replay buffer size, tracked clients and buffered frames are all bounded; invalid `clientId` values and non-`pub` frames are rejected with 4xx. | **Secure** |

---

## Detailed analysis

### Prototype pollution protection

**Status: Secure**

`@sveltex/shared` `cloneData` function:
- Rejects `__proto__`, `prototype`, `constructor` as property names (`DATA_UNSAFE_KEY`).
- Rejects symbol keys (`DATA_SYMBOL_KEY`).
- Rejects accessors and non-enumerable properties (`DATA_ACCESSOR`).
- Uses `Reflect.ownKeys` and validates each key type.
- Uses `Object.defineProperty` with explicit descriptor for each property.

`@sveltex/core` `validateConfig` function:
- Checks `Object.getPrototypeOf(input) === Object.prototype || null`.
- Deep clones metadata with the same protections.
- Rejects functions, symbols, bigints in metadata values.

### Timing attack mitigation

**Status: Secure**

`@sveltex/auth` login flow:
1. Normalizes and validates email format before any lookup.
2. If user is absent, verifies password against a precomputed dummy hash.
3. If `passwordHash` is invalid, also verifies against dummy hash.
4. Returns generic `undefined` for all failure cases (no user enumeration via return value).
5. Optional rate limiter consumes attempt before lookup.

**Caveat:** The timing mitigation depends on the injected hasher having consistent verification time. The dummy hash must use the same algorithm/parameters as real hashes. This is documented in the Auth README.

### Credential handling

**Status: Secure**

- Password never appears in return values.
- `sanitizeUser` destructures user to exclude `passwordHash`.
- Password length validated on both registration (min/max) and login (max only, to avoid leaking via length error).
- Hasher output validated (length 20–4096, must be string).

### Session security

**Status: Secure with caveats**

- Session IDs: 16–256 URL-safe characters (`[A-Za-z0-9_-]+`).
- Default ID generation: `crypto.randomUUID()`.
- Revision-based optimistic locking prevents concurrent update conflicts.
- Atomic rotation: old ID invalidated only if revision matches and new ID doesn't collide.
- Data is deep-cloned on read to prevent external mutation.
- Expired sessions are deleted on access.

**Caveats (updated after completion-plan Phase 3):**
- Rotation remains **explicit** — Phase 3 ships concrete rotation helpers (`SessionCookieTransport.rotate`, `createAuthSessionPort().rotate`) but no automatic framework middleware (Phase 10).
- ~~Cookie transport, signing, and CSRF are adapter responsibilities.~~ **Resolved:** `__Host-` secure cookie transport and double-submit CSRF (optional HMAC binding) now ship in `@sveltex/session` (SEC-035 – SEC-037). Cookie **signing/encryption** and stateless sessions are still not offered — ids remain opaque random values looked up in the store.
- `MemorySessionStore` is single-process only; `RedisSessionStore` revocation is an O(N) namespace `SCAN` (SEC-040).
- Cache values written before the Phase 4 envelope change are rejected as legacy payloads, not silently decoded; a `FallbackCache` in the `degraded` state may serve stale reads, and `StampedeGuard` does not coordinate across processes (SEC-041, SEC-045, SEC-046).

### Input validation coverage

| Package | Input | Validation |
| --- | --- | --- |
| core | Config name | Non-empty string, trimmed |
| core | Config environment | Optional, non-empty string |
| core | Config debug | Optional, boolean |
| core | Config metadata | Plain object, JSON-compatible values only |
| shared | cloneData input | Plain object/array, no cycles, no accessors, no symbol keys |
| database | SQL | Non-empty string, max 1,000,000 chars |
| database | Parameters | Array of null/string/number/boolean/bigint/Date/Uint8Array |
| auth | Email | String, max 320 chars, regex validation |
| auth | Password | String, min 12 (registration), max 1024 |
| auth | Session ID | String, 16–256 chars |
| cache | Key | Non-empty string, max 1024 chars |
| cache | TTL | Non-negative finite number |
| session | ID | String, 16–256 chars, URL-safe |
| session | TTL | Positive finite number |

### Reference application security review (SEC-016)

**Status: Secure**

`examples/reference-app/` composes all Stage 3 packages. The integration boundary — where a real application could reintroduce vulnerabilities that the libraries alone prevent — was reviewed explicitly:

- **No self-granted roles.** `registerSchema` accepts only `email`, `password`, `displayName`. An early draft accepted `roles`; it was removed because a client could self-grant `admin`. The only grant path is the trusted `adminEmails` bootstrap config, passed as inert metadata to `AuthService.register`, and `SqliteUserStore` owns role defaults (`['user']`).
- **Fresh-record authorization.** `#principal()` validates the session ID, reads the live session via `SessionManager`, then resolves the user from the `users` table on **every** privileged call. `getPublicProfile` caching is presentation-only and is never consulted for an authorization decision; `grantRole` invalidates that cache so a stale role cannot linger.
- **Session-derived identity.** `createPost` sets `authorId` from the resolved principal. A payload-supplied `authorId` is ignored (a test asserts this). `grantRole` runs inside `Database.transaction` and enforces an `ASSIGNABLE_ROLES` allow-list.
- **Injection / fixation.** All SQL is parameterized; session IDs must match 16–256 URL-safe characters; `rotateSession` uses the atomic Lua-backed path so the old ID is invalidated immediately.
- **Credential handling.** Argon2id with a real `generateDummyHash()` for absent-user login; `sanitizeUser` strips `passwordHash` from all returned users.

---

### Stage 4 security review (SEC-017 – SEC-021)

**Status: Secure (with documented limitations)**

- **Realtime (SEC-017).** `RealtimeHub` has **no implicit allow default** — `authorize` is required and consulted for `publish`, `subscribe`, and `deliver`. `deliver` is evaluated **per subscriber**, so a privileged channel cannot leak to an unauthorized listener. Delivered payloads are deep-frozen so one subscriber cannot mutate a shared value. At-least-once redelivery is de-duplicated by a **bounded per-subscriber** id cache (an initial global-set design was corrected because it would have suppressed the second subscriber). Channel names reject traversal/control characters. Covered by 8 security tests.
- **Jobs (SEC-018).** `InMemoryJobQueue.claim()` is atomic and increments attempts under a single synchronous pass, so at-least-once redelivery cannot double-execute a side effect. `Worker.stop()` drains already-chained in-flight handlers while rejecting new work synchronously. Backoff is capped, retries are bounded, and permanent failures move to dead-letter rather than looping. Covered by 7 security tests.
- **Storage (SEC-019).** User keys are validated against absolute paths, backslashes, `.`/`..` segments, and control characters, then mapped to **SHA-256 hex filenames** — user-controlled paths are never used on disk. Writes are atomic (temp file + `rename`, metadata sidecar published last); a symlinked `objects/` directory is rejected; reads verify etag/size integrity. Covered by 9 security tests.
- **Mail (SEC-020).** CRLF/NUL header injection is rejected in subjects, display names, and headers. `renderTemplate` HTML-escapes interpolated values by default (XSS prevention). Retries are bounded and deterministic; a permanent failure throws `MailSendError` with attempt count and `cause` — **never a false success**. `TestTransport` is explicitly in-memory and never contacts SMTP/HTTP. Covered by 9 security tests.
- **Testing (SEC-021).** Helpers delegate to the **real** `@sveltex/core` rather than reimplementing DI, so config validation (`SX_CONFIG_INVALID`), request-scope enforcement (`SX_PROVIDER_SCOPE_VIOLATION`), and lifecycle hook failures are surfaced, not bypassed. `withTestApplication` guarantees `stop()` even when the body throws; forgotten request scopes are disposed; fakes expose frozen defensive snapshots and reject use after `close()`. Covered by 12 security tests.

---

### Stage 5 CLI security review (SEC-022 – SEC-026)

**Status: Secure (with documented limitations)**

- **Static config inspection (SEC-022).** `inspectConfigText()` reads `sveltex.config.ts` as text; diagnostic commands never `import()` it. A test config whose top level throws is never executed. Secret redaction deep-clones (never mutates input) and covers token/secret/password/private-key/credential/API-key/access-key/client-secret/connection-string patterns. Env reporting exposes names only, with the literal "value not read" marker.
- **Command execution boundary (SEC-023).** `defaultRunner` uses `spawn` with `shell: false`; no user string is ever concatenated into a shell command. `assertPackages()` rejects leading dashes and metacharacters after a security test demonstrated that `--ignore-scripts` would otherwise be forwarded as an option. `safeRelativePath()` rejects traversal including encoded variants and NUL.
- **File safety (SEC-024).** `ChangeSet` snapshots prior content and restores it on rollback; tests cover rollback after a later write fails. `init` preserves user hooks: `export const handle: Handle = auditHandle;` becomes `const userHandle: Handle = auditHandle;` composed via `sequence(createSvelteXHandler(app), userHandle)`. Overwrite protection, dry-run, and install-failure rollback are all covered by tests.
- **No fake capabilities (SEC-025).** The integration registry is derived from the real workspace packages and their versions; no unshipped provider is listed. `upgrade` performs no network lookup. The `saas` README lists auth/persistence/billing/payments as NOT included and NOT implied. `doctor` warns about process-local adapters under multi-instance/production conditions instead of claiming distributed durability.
- **Fixed flag handling (SEC-026).** Found during a real `init --no-install` smoke run, not by a test author: the CLI accepted the flag but still ran `pnpm add`, failing offline. Fixed and covered by a regression test.

---

### Database production-hardening security review (SEC-027 – SEC-030)

**Status: Secure (with documented limitations)**

- **Parameterization (SEC-027).** The pooled adapters pass bound values to `pg` / `mysql2` and never
  parse, interpolate, or rewrite SQL. Placeholders stay dialect-specific (`$n` vs `?`) and are
  documented, not hidden. Injection payloads are exercised against real servers.
- **Migration integrity (SEC-028).** Ledger names are validated as simple SQL identifiers; a
  SHA-256 checksum covers each migration's id and full SQL body. Re-running verifies that applied
  migrations are an unchanged prefix, so editing or reordering a shipped migration is refused.
- **Connection isolation (SEC-029).** Top-level transactions use dedicated pooled connections and
  `BEGIN`/`COMMIT`/`ROLLBACK`; nesting reuses the connection via `AsyncLocalStorage` and `SAVEPOINT`.
  Concurrent failing transactions do not leak changes, and executors are invalidated on settle.
- **Honest row counts (SEC-030).** Plain writes now report affected rows rather than `0`, so callers
  cannot silently misread a successful write as a no-op.
- **Limitations (at the Session 7 hardening pass).** No ORM integration layer at that point (added in completion-plan Phase 1, see SEC-031 – SEC-034 above), no automatic dialect detection, no cross-process migration lock, no retry/failover. MySQL DDL implicitly commits, so DDL-bearing migrations are not atomic there.
  `pg` and `mysql2` are regular dependencies even for SQLite-only users. TLS is configured
  explicitly by the caller; the adapters invent no transport defaults.

---

### Completion-plan Phase 1 — ORM adapter security review (SEC-031 – SEC-034)

**Status: Secure (with documented limitations)**

Phase 1 added an additive ORM integration layer to `@sveltex/database`. Its dedicated security
suite is `packages/database/tests/security/adapter-security.test.mjs` (8 of the 16 database
security cases). The layer never constructs SQL from user input (ORM clients are supplied by the
caller and preserved untouched), so SQL injection remains the ORM's own responsibility.

- **Capability integrity (SEC-031).** A definition cannot claim a capability it does not
  implement; unknown keys and non-boolean values are refused; adapter names are validated against
  injection shapes and length/case rules; duplicate registrations throw. `createConnection`
  refuses to invoke an undeclared transaction capability.
- **Error/health redaction (SEC-032).** Driver-provided error text (which may contain a full
  connection URI, password or token) is never propagated. Wrapped errors use fixed messages,
  health reports use a fixed failure string, and the shared conformance suite redacts setup
  failures before returning its report.
- **Passive config (SEC-033).** `configFromEnv` reads named variables into a frozen object; it
  evaluates nothing. `redactConfig` masks secret-shaped keys for any logging the application
  chooses to do.
- **Optional-peer isolation (SEC-034).** There is no silent degraded mode: if an ORM peer is
  missing, importing its subpath fails with `ERR_MODULE_NOT_FOUND` rather than substituting a
  fake adapter. The main entry stays ORM-free.

- **Limitations.** Built-in ORM adapters declare single-level transactions (no savepoints);
  ORM-side SQLite/MySQL integration is user-configurable but not separately tested; third-party
  ORM clients are trusted code supplied by the caller. These are documented, not hidden.

---

### Completion-plan Phase 3 — session security review (SEC-035 – SEC-040)

**Status: Secure (with documented limitations)**

The dedicated suite is `packages/session/tests/security/phase3-security.test.mjs` (12 of the 13
session security cases). It covers Set-Cookie injection, `__Host-` default hardening, `__proto__`
cookie pollution, forged/mismatched CSRF tokens, session fixation, stale cookies, concurrent
update conflicts, failing stores and shutdown. All 12 pass with 0 skipped.

- **Cookie boundary (SEC-035, SEC-037).** Defaults fail closed: a browser rejects a `__Host-`
  cookie that is not `Secure`, not root-path, or domain-scoped, and `resolveSessionCookieOptions`
  refuses to emit one. CRLF and semicolon injection in any cookie component throws. Parsing uses
  a null-prototype record, so a malicious `__proto__` key cannot reach `Object.prototype`.
  Stale/malformed cookies are cleared rather than trusted.
- **CSRF boundary (SEC-036).** Unsafe methods require a matching double-submit token compared
  in constant time over SHA-256 digests. With `secret` configured, tokens are HMAC-bound to a
  session id. **Documented limitation:** without a `secret`, only token *shape* is verified and
  protection relies on the `__Host-` prefix + `SameSite=Strict`; hostile-origin deployments must
  configure `secret`. This is stated in the README and the [Phase 3 report](../completion/phase-3-session.md),
  not hidden.
- **SQL boundary (SEC-038).** Table identifiers are validated; all values are bound; dialect
  placeholders are rendered deterministically (`?` / `$1..$n`). Conditional single statements
  and a transactional `rotate` close the TOCTOU window that a read-then-write store would open.
  Corrupt or expired rows are purged on read.
- **Auth bridge and revocation (SEC-039, SEC-040).** Rotation-on-privilege-change is exercised
  with a real `AuthService` + `Argon2Hasher`. `revokeAllForUser` never reports a silent success:
  unsupported stores throw. Redis revocation is explicitly O(N).
- **Not claimed.** No SvelteKit `handle` hook, no automatic CSRF/session middleware, no cookie
  signing/encryption or stateless sessions, no guarantee of cross-process isolation beyond the
  database's own transaction isolation level. These remain application/framework integration
  work (Phase 10) and are recorded in the Phase 3 report as open items.

### Completion-plan Phase 4 — cache security review (SEC-041 – SEC-046)

**Status: Secure (with documented limitations)**

The dedicated suite is `packages/cache/tests/security/phase4-security.test.mjs` (14 cases; with
the pre-existing cache security case the package ships 15 security tests). It covers `__proto__`
envelope pollution, corrupt and forged wire payloads, forged tagged envelopes, tag pollution
rejection, namespace boundary encoding, circular references, NaN/Infinity, bounded keys/tags,
backend error observability, loader-error non-caching and strict root-value rejection. All pass
with **0 skipped**. Real Redis 7 integration (`tests/redis-phase4-integration.test.mjs`)
additionally verifies envelope-compatible Lua `increment`, prefix-scoped `keys()`, distributed
tag generations via `INCR`/`MGET`, and fallback against a genuinely unreachable port
(`127.0.0.1:6399`) — no fake provider and no substituted backend.

- **Serialization boundary (SEC-041, SEC-042).** The old adapter JSON-serialized arbitrary
  values, which silently coerced `undefined`, `Date`, `BigInt` and class instances. Phase 4
  introduces a versioned envelope with an explicit root check (necessary because
  `JSON.stringify` invokes `toJSON()` before its replacer) and a strict `assertSerializable`
  walk. Corrupt or legacy payloads now raise `CacheSerializationError`; a tainted Redis value
  can no longer degrade silently into a cache miss or a wrongly-typed hit.
- **Invalidation boundary (SEC-043, SEC-044).** Namespace keys are escaped before they reach
  the physical store, so a crafted namespace cannot read or clear another tenant's entries.
  Tag invalidation is generation-based, not deletion-scan-based: a bumped generation makes
  every dependent entry stale on the next read. The envelope shape guard was tightened after
  review so a forged object cannot be mistaken for a valid tagged entry.
- **Degradation boundary (SEC-045, SEC-046).** Falling back to a secondary store is observable
  (`state`, `lastError`, `failureCount`, callbacks, `probe()`), and half-open recovery is
  explicit. Failed loads are never cached, so a transient loader error cannot be pinned into
  the cache. The circuit breaker degrades **availability**, not integrity: stale fallback reads
  are documented rather than hidden.
- **Not claimed.** `StampedeGuard` is **process-local**; TTL jitter only de-synchronizes
  expiration across processes and does not implement a distributed lock or lease. No
  non-Redis distributed backend ships, and no SvelteKit `handle` wiring exists (Phase 10).
  These are recorded in the [Phase 4 report](../completion/phase-4-cache.md), not hidden.

### Completion-plan Phase 5 — realtime security review (SEC-047 – SEC-052)

**Status: Secure (with documented limitations)**

The dedicated suite is `packages/realtime/tests/security/phase5-security.test.mjs` (12 cases; with
the pre-existing suite the package ships 20 security tests). It covers `__proto__` pollution,
forged server-only frames, unsupported/legacy protocol versions, unknown tags, oversized frames,
unsafe payload coercion, non-leaking wire errors, channel grammar, deny-by-default gateways for
both transports, client-id injection, throwing authenticators, channel-filtered `Last-Event-ID`
replay and hostile gateway configuration. All pass with **0 skipped**. The integration suites
(`tests/websocket.test.mjs`, `tests/sse.test.mjs`) exercise real `ws` sockets and real
`node:http` servers on ephemeral TCP ports, two-hub pub/sub, handshake, heartbeat timeout,
reconnect/resubscribe/queue drain and bounded backpressure — no fake transport, no substituted
backend.

- **Protocol boundary (SEC-047, SEC-049, SEC-050).** The wire codec validates direction, version,
  byte bounds and envelope shape before any application handler runs. Because `JSON.stringify`
  invokes `toJSON()` before its replacer, the strict `assertSerializable` walk is performed on the
  original value; a `Date`/`Map`/`toJSON`-bearing payload can no longer silently change type on
  the wire. `__proto__` is removed by both the JSON reviver and the envelope rebuild.
- **Authentication boundary (SEC-048).** Gateway authentication is deny-by-default and independent
  of the hub's required `authorize` hook. An authenticator exception is reported to the observer
  but leaves `allowed === false`, so a misconfigured policy fails closed rather than open.
- **Resource boundary (SEC-051).** Frame sizes, send queues, pending SSE frames, tracked clients,
  replay buffers and heartbeat timeouts are all bounded; slow consumers are terminated rather than
  allowed to grow memory without limit. Reconnect delays are capped and deterministic in tests.
- **Replay boundary (SEC-052).** Replay is filtered by the client's current channel set, so a
  reconnect cannot be used to read events from a channel the client never subscribed to.
- **Not claimed.** Both gateways are single-process fan-out hubs with no persistence, cross-instance
  fan-out, broker, TLS termination, rate limiting or distributed lock. `allowAnonymous()` is a
  development opt-in. These are recorded in the [Phase 5 report](../completion/phase-5-realtime.md),
  not hidden.

### Completion-plan Phase 6 — jobs security review (SEC-053 – SEC-062)

**Status: Secure (with documented limitations)**

The dedicated suite is `packages/jobs/tests/security/phase6-security.test.mjs` (10 cases; with the
pre-existing suite the package ships 17 security tests). The integration suites
(`tests/integration/redis.test.mjs`, `tests/integration/sql.test.mjs`) exercise a real Redis 7
server (four Lua scripts), real SQLite (`node:sqlite`) and a real PostgreSQL 16 server
(`pg.Pool`, `FOR UPDATE SKIP LOCKED`) — two independent clients are verified never to
double-claim the same job, and a file-backed SQLite queue survives a full reopen. No fake
provider, no substituted backend, **0 skipped**.

- **Prototype-pollution boundary (SEC-053).** `serializeJobPayload` strips `__proto__`,
  `constructor` and `prototype` keys on encode and the JSON reviver removes them on decode;
  `Object.prototype` is never mutated, and polluted keys are rejected rather than silently
  dropped into a persisted record.
- **Persisted-record boundary (SEC-054).** `decodeJobRecord` validates the versioned
  `sveltex-jobs:v1:` envelope, record version, status enum, id/name grammar, `attempts`, and
  timestamps **and** re-parses the nested payload as a strict envelope. Corrupt JSON, legacy
  `v: 2`, tampered `status`/`attempts`, non-string ids and plaintext payloads are rejected with
  `JobsSerializationError` — never coerced into a runnable job.
- **Identifier / injection boundary (SEC-055, SEC-056).** `tableName`, job ids and dedupe keys
  are validated against strict grammars and length bounds before they reach a SQL statement or a
  Redis key; all values are bound as parameters (`?` / `$n`), so user payload text never appears
  in statement text. The SQL suite asserts parameterization directly.
- **Configuration boundary (SEC-057).** Redis `keyPrefix`, SQL dialect and the BYO executor are
  validated before any client or connection is created, so a hostile config fails closed with
  `JobsConfigurationError` rather than reaching a live backend.
- **Lifecycle boundary (SEC-058, SEC-059).** A closed queue rejects every operation
  (`JobsClosedError`), and `complete` / `fail` / `cancel` are idempotent: a dead-lettered or
  finalized job cannot be resurrected by a late or duplicated worker.
- **Dispatch boundary (SEC-060).** `JobRegistry.createHandler()` throws a typed
  `SX_JOBS_UNREGISTERED` error for unknown names, so the `Worker` retry/dead-letter path applies
  instead of silently dropping the job or invoking a default handler.
- **Resource / diagnostics boundary (SEC-061, SEC-062).** Oversized payloads (64 KiB) and
  invalid fail options are rejected before any I/O; `JobsStoreError` preserves the `operation`
  and driver `cause` for safe operator diagnostics while the public error remains non-leaking.
- **Not claimed.** MySQL is not implemented for `SqlJobQueue` (only `sqlite` / `postgres`); no
  Redis Cluster cross-slot routing, priority queues, cron/periodic schedule persistence, worker
  leader election, TLS/auth/rate limiting, or dead-letter replay tooling. These are recorded in
  the [Phase 6 report](../completion/phase-6-jobs.md), not hidden.

## Recommendations

1. **Add default rate limiting guidance** to Auth README with example limiter implementations (token bucket, sliding window).
2. ~~**Document session rotation best practices**~~ — **delivered in Phase 3**: `SessionCookieTransport.rotate()` and `createAuthSessionPort().rotate()` implement rotation-on-privilege-change and are covered by a real AuthService integration test plus a session-fixation security case. Automatic middleware remains Phase 10.
3. ~~**Add CSRF guidance**~~ — **delivered in Phase 3**: `CsrfProtection` ships with a documented unbound-mode caveat, HMAC session binding option, and 12 security cases. The README documents when to configure `secret`; automatic framework middleware remains Phase 10.
4. **Add security test for config metadata** — verify that `__proto__` injection attempts in nested metadata are rejected (current tests cover top-level; nested should be verified).
5. **Add timing test for auth login** — measure that user-absent and user-present-but-wrong-password paths take similar time.
6. **Evaluate a distributed cache lock/lease** — Phase 4 single-flight is process-local; a Redis `SET NX` lease should be designed and tested before multi-process stampede protection is advertised (Phase 10/11).
7. **Evaluate a cross-instance realtime broker** — Phase 5 WebSocket/SSE gateways are single-process fan-out hubs. A real broker (Redis pub/sub, NATS) must be designed and tested before multi-instance realtime delivery is advertised (Phase 10/11); TLS termination and gateway rate limiting remain deployment responsibilities.
