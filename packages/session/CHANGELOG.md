# Changelog

## 0.1.0

- Initial independently installable SvelteX package.

## 0.2.0 — Completion-plan Phase 3 (2026-11-11)

No new package was created; `@sveltex/session` was extended in place. Every capability below
ships with a real implementation and a real test.

### Added

- **Secure cookie transport** (`@sveltex/session/cookie`): `SessionCookieTransport` /
  `CookieJar` (SvelteKit-shaped), `resolveSessionCookieOptions` with frozen `__Host-` defaults
  (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`), `serializeSetCookie`,
  `parseCookieHeader`, `SessionCookieError`, `DEFAULT_SESSION_COOKIE_OPTIONS`. CRLF/semicolon
  injection is rejected; `__proto__` pollution is blocked; stale/malformed cookies are cleared;
  `Max-Age` derives from remaining TTL.
- **CSRF protection** (`@sveltex/session/csrf`): `CsrfProtection` (double-submit cookie +
  header/form token, constant-time compare over SHA-256 digests, optional HMAC session binding),
  `serializeCsrfCookie`, `constantTimeEqual`, `CsrfError` with stable codes
  (`CSRF_TOKEN_MISSING`, `CSRF_COOKIE_MISSING`, `CSRF_TOKEN_MISMATCH`, `CSRF_TOKEN_INVALID`,
  `CSRF_CONFIG`, `CSRF_REQUEST_INVALID`). Safe methods (`GET/HEAD/OPTIONS/TRACE`) bypass.
- **Persistent SQL store** (`@sveltex/session/database`): `DatabaseSessionStore` over a
  structural `SessionSqlExecutor` (`@sveltex/database`'s `Database` satisfies it), dialects
  `sqlite`/`postgres`/`mysql` (`?` / `$1..$n`, MySQL `FROM DUAL`), `ensureSchema()` /
  `schemaStatements()`, atomic conditional `INSERT`, revision CAS `UPDATE`, transactional
  `rotate`, `revokeAllForUser`, `purgeExpired`. Table identifiers are validated; all values bound.
- **Auth bridge and revocation** (`@sveltex/session/auth`): `createAuthSessionPort`,
  `supportsRevocation`, `revokeAllForUser`, `AuthSessionPortLike`. Rotation-on-privilege-change
  prevents session fixation.
- **Core**: `RevocableSessionStore`, `SessionRevocationUnsupportedError`,
  `MemorySessionStore.revokeAllForUser`, `SessionManager.revokeAllForUser`. Unsupported stores
  throw rather than silently succeeding.
- **Redis**: `RedisSessionStore.revokeAllForUser` (namespace-scoped `SCAN`, documented O(N)).
- **Subpath exports**: `/cookie`, `/csrf`, `/database`, `/auth` (alongside `/redis`).

### Tests

- New: `cookie.test.mjs` (18), `csrf.test.mjs` (16), `database.test.mjs` (17),
  `auth.test.mjs` (8), `security/phase3-security.test.mjs` (12), `types/phase3.test.ts`.
- Real integration: SQLite (`node:sqlite`) full lifecycle + 8-way concurrent create (1 winner),
  PostgreSQL 16, MySQL 8.0, Redis 7, and a real `@sveltex/auth` `AuthService` + `Argon2Hasher`
  register → login → rotate → revoke → logout flow.
- `@sveltex/session`: **104/104** (91 runtime + 13 security). Full monorepo: **637/637** runtime,
  **105/105** security, **16/16** type-test projects — 0 failures, 0 skipped, live services.
- `npm pack --dry-run` → 27 files, all four new subpath `.js`/`.d.ts` pairs present, no
  `src`/`tests` leakage.

### Not claimed

- No SvelteKit `handle` hook or automatic CSRF/session middleware (Phase 10).
- No cookie signing/encryption or stateless sessions.
- Redis revocation is O(N); HMAC CSRF binding requires a configured `secret` (unbound mode
  verifies token shape only).
- Cross-process isolation of `rotate` depends on the database's own transaction isolation level.

See [`docs/completion/phase-3-session.md`](../../docs/completion/phase-3-session.md) and
`README.md` for the full API surface and limitations.
