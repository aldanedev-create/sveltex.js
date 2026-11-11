# @sveltex/session

Storage-agnostic session lifecycle, secure cookie transport, CSRF protection, persistent SQL
stores, and an authentication bridge.

## Install

```sh
pnpm add @sveltex/session
# The Redis adapter uses ioredis (already a dependency of this package).
# The SQL store is structurally compatible with @sveltex/database's Database facade
# (no runtime dependency is added by this package).
```

## Create and rotate a session

```ts
import { MemorySessionStore, SessionManager } from '@sveltex/session';

const sessions = new SessionManager(new MemorySessionStore(), {
  ttlMs: 1000 * 60 * 60 * 24,
});

const session = await sessions.create({ userId: 'user-123' });
// After login or a privilege change, rotate the identifier (session-fixation defence).
const authenticated = await sessions.rotate(session.id);
```

The manager supports create, read, update, touch, rotate, destroy, and expiry. Session IDs must be
at least 16 URL-safe characters. Session payloads are data-only, cloned, and deeply frozen.
Updates and rotations use revisions: production stores must implement `createIfAbsent`,
`compareAndSet`, and `rotate` atomically in the backing database/transaction. A non-atomic
implementation can resurrect sessions or lose concurrent updates and is not supported. The memory
store is for tests and single-process development only.

## Stores

| Store | Subpath | Notes |
| --- | --- | --- |
| `MemorySessionStore` | `@sveltex/session` | tests / single process; implements `revokeAllForUser` |
| `RedisSessionStore` | `@sveltex/session/redis` | shared across instances; atomic Lua scripts; `revokeAllForUser` via namespace `SCAN` |
| `DatabaseSessionStore` | `@sveltex/session/database` | persistent SQL store; SQLite / PostgreSQL / MySQL |

### Redis-backed shared store

```ts
import { RedisSessionStore } from '@sveltex/session/redis';

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

`createIfAbsent`, `compareAndSet`, and `rotate` are server-side **Lua scripts** (`EVAL`), making
each check-and-write atomic across processes. Records are JSON under `<keyPrefix><id>` with a
physical TTL derived from `expiresAt`; `clear()` scans only the configured prefix (never
`FLUSHDB`); corrupt or logically expired records are purged on read.

> **Clock consistency:** when injecting a custom `now` into `SessionManager`, pass the **same**
> function to `RedisSessionStore` (`{ now }`) so logical expiry and the physical TTL stay aligned.

### Database-backed persistent store

```ts
import { Database } from '@sveltex/database';
import { SqliteAdapter } from '@sveltex/database/sqlite';
import { DatabaseSessionStore } from '@sveltex/session/database';

const db = new Database(new SqliteAdapter({ path: 'sessions.db' }));
await db.connect();

const store = new DatabaseSessionStore(db, { dialect: 'sqlite', tableName: 'sveltex_sessions' });
const sessions = new SessionManager(store, { ttlMs: 1000 * 60 * 60 * 24 });
const session = await sessions.create({ userId: 'user-123' });
```

`DatabaseSessionStore` accepts any executor with `query()` and `transaction()` —
`@sveltex/database`'s `Database` facade satisfies it directly. Choose the dialect:

| `dialect` | Placeholders | Tested against |
| --- | --- | --- |
| `'sqlite'` (default) | `?` | real `node:sqlite` |
| `'postgres'` | `$1..$n` | real PostgreSQL 16 |
| `'mysql'` | `?` + `FROM DUAL` | real MySQL 8.0 |

`ensureSchema()` creates the table lazily; `schemaStatements()` returns the DDL for migrations.
`createIfAbsent` is a single conditional `INSERT`, `compareAndSet` a single conditional `UPDATE`,
and `rotate` a transaction with a conditional `DELETE` — no lost updates under concurrency.
`user_id` is denormalized from `data.userId` for O(1) `revokeAllForUser()`; `purgeExpired()`
cleans up expired rows. The store does not own the connection — call `db.close()` on shutdown;
operations after close fail loudly rather than fabricating a session.

## Secure cookie transport

```ts
import { SessionCookieTransport } from '@sveltex/session/cookie';

// SvelteKit: pass `event.cookies` — it satisfies the CookieJar interface.
const transport = new SessionCookieTransport({ cookies: event.cookies, manager: sessions });

const session = await transport.create({ userId: 'user-123' }); // writes Set-Cookie
const current = await transport.read();                          // resolves via the manager
const rotated = await transport.rotate();                        // rewrites the cookie
await transport.destroy();                                      // clears both
```

Defaults are hardened: `__Host-sveltex_session`, **Secure**, **HttpOnly**, **SameSite=Lax**,
`Path=/`, no `Domain`, and a `Max-Age` derived from the session's remaining TTL.
`resolveSessionCookieOptions()` rejects insecure combinations (`SameSite=None` without `Secure`,
`__Host-` with a `Domain` or non-root path, CRLF/semicolon injection). Stale or malformed cookies
are cleared rather than trusted. `serializeSetCookie()` and `parseCookieHeader()` are also exported
for raw HTTP runtimes.

> For local plain-HTTP development, use a **non-prefixed** name and `secure: false` — the
> `__Host-` prefix is intentionally impossible to downgrade.

## CSRF protection

```ts
import { CsrfProtection } from '@sveltex/session/csrf';

const csrf = new CsrfProtection({ secret: process.env.CSRF_SECRET });
const issued = csrf.issue(session.id);  // { value, cookie }
// Send `issued.cookie` as Set-Cookie; the client echoes `issued.value` in x-csrf-token.

csrf.assertValidRequest({
  method: request.method,
  headers: request.headers,          // Headers or a plain record
  sessionId: session.id,
});
```

Safe methods (GET/HEAD/OPTIONS/TRACE) bypass. Every other method must present a token (header
`x-csrf-token` or form field `_csrf`) that matches the double-submit cookie in **constant time**.
The CSRF cookie is intentionally **not** HttpOnly (JS must read it) but is `__Host-`-prefixed and
`SameSite=Strict`. With a `secret`, tokens are HMAC-bound to the session id so a token issued for
one session cannot protect another. Without a secret only token shape is validated — configure a
secret in production.

## Revocation and authentication integration

```ts
import { createAuthSessionPort, revokeAllForUser } from '@sveltex/session/auth';
import { AuthService } from '@sveltex/auth';

const auth = new AuthService(users, hasher, createAuthSessionPort(sessions), {
  dummyPasswordHash,
});
// logout-all-devices / password reset:
await sessions.revokeAllForUser('user-123');
```

`createAuthSessionPort()` bridges `SessionManager` to `@sveltex/auth`'s `AuthSessionPort`: login
creates a session carrying `userId`, `rotateSession()` prevents fixation, `logout()` destroys it.
`revokeAllForUser()` is available on all three stores and on the manager; stores without the
capability throw `SessionRevocationUnsupportedError` rather than silently succeeding.

## Status / not claimed

- **SvelteKit `handle` hook** is not shipped: `event.cookies` works directly, but wiring the
  transport and `assertValidRequest` into a hook is an application/framework integration.
- **Cookie signing / encryption / stateless sessions** are not offered; ids are opaque random
  UUIDs resolved in the store.
- **Unbound CSRF** (no `secret`) relies on the `__Host-` prefix + `SameSite=Strict`; HMAC binding
  is recommended for hostile-origin environments.
- **Redis `revokeAllForUser`** is a namespace `SCAN` (O(N)); maintain a per-user set at write time
  for very large deployments.
- Automatic CSRF middleware, database-backed cookie sessions without an explicit store, and
  cross-process savepoint guarantees remain out of scope.
