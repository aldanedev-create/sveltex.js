# Phase 2 — Auth completion report

**Date:** 2026-11-09
**Plan:** [Existing Package Completion Plan](../completion-plan.md) · **Audit:** [Phase 0](./phase-0-audit.md)
**Package:** `@sveltex/auth`
**Status:** implemented, tested, documented. Phase 2 done; Phases 3–12 remain.

---

## Objective (from the plan)

> Complete `@sveltex/auth`: registration, login, logout, password reset, email verification, role-based
> access control, rate limiting, and comprehensive security tests — without adding OAuth/OIDC (those
> are explicitly out of scope and must not be advertised).

**Core rule honoured:** no new package was created. Work extended the existing `@sveltex/auth` package
only. Every claimed capability has a real implementation and a real test; nothing is advertised that is
not shipped.

---

## What was already present (verified in Phase 0)

- `AuthService` — `register` / `login` / `logout` / `rotateSession`, injected hasher (no weak default),
  dummy hash for timing/enumeration mitigation, email normalization, password length limits, user
  sanitization (strips `passwordHash` and `roles` at registration).
- `Argon2Hasher` — real Argon2id via `@node-rs/argon2`, `generateDummyHash()`, 13 integration tests.
- `AuthAttemptLimiter` — a *port only*; no concrete implementation shipped.
- `AuthSessionPort`, `CredentialUserStore`, `PasswordHasher` — ports.

## What Phase 2 added

| Capability | Module | Exports |
| --- | --- | --- |
| Error hierarchy | `errors.ts` | `AuthError`, `AuthConflictError`, `AuthConfigurationError`, `AuthUnauthorizedError`, `AuthForbiddenError`, `AuthRateLimitError`, `AuthTokenInvalidError`, `AuthTokenExpiredError`, `AuthTokenUsedError`, `AuthTokenPurposeError`, `AuthPasswordPolicyError` |
| Concrete attempt limiter | `limiter.ts` | `FixedWindowLimiter` (implements `AuthAttemptLimiter`) |
| Secure single-use tokens | `tokens.ts` | `TokenManager`, `MemoryTokenStore`, `TokenStore` (port), `generateSecureToken` |
| Password reset | `reset.ts` | `PasswordResetService`, `PasswordResetStore` (contract) |
| Email verification | `verification.ts` | `EmailVerificationService`, `EmailVerificationStore` (contract) |
| Role-based access control | `rbac.ts` | `RbacBuilder`, `createRbac`, `RbacRole`, `RbacPolicy` |

Subpath exports added to `package.json`: `/limiter`, `/tokens`, `/rbac`, `/reset`, `/verification`.

---

## Architecture decisions

| Decision | Rationale |
| --- | --- |
| **Limiter consulted before user lookup** | `AuthService` calls `limiter.rateLimit(key)` *before* the store lookup, so the limiter throttles both brute-force and enumeration attempts. Failed attempts record; successes free the budget. |
| **Default-deny limiter** | On any limiter error (e.g. a backing store outage), `AuthService` treats the request as blocked rather than open — fail closed. |
| **Purpose-scoped single-use tokens** | `TokenManager.issue(purpose, subject, ttl)` binds the token to a `purpose` and `subject`. `consume(token, purpose)` rejects wrong-purpose replays *before* the consumed/expired checks, so a reset token cannot be replayed at the verification endpoint. Each token is consumed exactly once. |
| **Memory store is dev/test only** | `MemoryTokenStore` ships for development and tests; the `TokenStore` port lets consumers back it with Redis/DB. This is documented as a production gap rather than claimed as distributed-safe. |
| **Password validated before token consumed** | `completeReset` runs the password policy check *before* `TokenManager.consume`, so a weak password never burns a valid reset link. |
| **RBAC is deny-by-default with cycle detection** | `RbacBuilder.defineRole(..., { inherits })` detects inheritance cycles at definition time; `requirePermission` throws `AuthUnauthorizedError` (no roles) or `AuthForbiddenError` (under-privileged) — never silently passes. Unknown role strings are ignored, so a caller cannot escalate by presenting invented roles. |
| **Centralized errors** | All auth errors moved into `errors.ts` with stable `code` values (`AUTH_*`) and a `cause` chain, so consumers can branch on `code` without string-matching messages. |

---

## Delivered

### 2.1 Attempt limiter — `limiter.ts`
- `FixedWindowLimiter({ max, windowMs, clock? })`: fixed-window counter keyed by arbitrary string.
- `rateLimit(key)` → throws `AuthRateLimitError` (with `retryAfterMs`/`resetAt`) when the budget is
  exhausted; `recordSuccess(key)` frees the failed-attempt budget on success; `reset(key)` clears.
- Bounded internal map with lazy window expiry (no unbounded growth).

### 2.2 Secure tokens — `tokens.ts`
- `generateSecureToken(bytes = 32)` — `crypto.randomBytes` opaque token; returns `token` + `hash`
  (store only the hash; never the raw token in a DB).
- `TokenManager` — `issue(purpose, subject, ttlMs)` → `{ token, expiresAt, subject }`;
  `consume(token, expectedPurpose)` validates hash + purpose + expiry + single-use; `peek`/`revoke`.
- `MemoryTokenStore` — `TokenStore` port implementation; `set`/`get`/`delete`/`has` over an opaque
  `TokenRecord` (only the hash is retained).

### 2.3 Password reset — `reset.ts`
- `PasswordResetService(requestReset, completeReset)` wired to `PasswordResetStore`
  (extends `CredentialUserStore` with `findById` + `updatePassword`).
- `requestReset(email, send)` → **silent for unknown emails** (same no-op response shape, no
  enumeration); invokes `send({ email, token, expiresAt })`.
- `completeReset(token, newPassword)` → validates password policy *first*, then consumes the token and
  updates the password via the hasher; returns the sanitized user.

### 2.4 Email verification — `verification.ts`
- `EmailVerificationService(requestVerification, verify)` wired to `EmailVerificationStore`
  (`findById` + `markVerified`).
- `requestVerification(user, send)` → `send({ email, token, expiresAt })`; `verify(token)` consumes the
  token and marks the account verified; single-use.

### 2.5 RBAC — `rbac.ts`
- `RbacBuilder.defineRole(name, { permissions, inherits })` with cycle detection; `hasPermission`,
  `requirePermission(roles, permission)`, `requireAll`, `requireAny`.
- `createRbac(policy)` shorthand; throws `AuthUnauthorizedError` when `roles` is empty/undefined and
  `AuthForbiddenError` when authenticated but lacking the permission.

### 2.6 Tests (added)
- `tests/limiter.test.mjs` — window budget, exhaustion, reset, success frees budget.
- `tests/tokens.test.mjs` — issue/consume, single-use, expiry, purpose-scoping, hash-only storage.
- `tests/rbac.test.mjs` — inheritance, cycle detection, 401/403, unknown-role rejection.
- `tests/reset.test.mjs` — silent unknown email, happy path, weak-password-before-consume.
- `tests/verification.test.mjs` — request/verify, single-use, missing-id rejection.
- `tests/security/phase2-security.test.mjs` — timing/enumeration sameness, brute-force throttle,
  permission-bypass rejection, token replay/invalid/expired/wrong-purpose.
- `tests/types/phase2.test.ts` — locks the new public API surface.

---

## Verification (measured, not claimed)

| Check | Result |
| --- | --- |
| `pnpm --filter @sveltex/auth check` | **58/58 runtime** + **8/8 security** + type tests, 0 failures, 0 skipped |
| Auth runtime tests (before → after) | 29 → 58 (+29) |
| Auth security tests (before → after) | 1 → 8 (+7) |
| `tsc -p tsconfig.json` (build) | clean, strict |
| `tsc -p tests/types/tsconfig.json` (type tests) | pass |
| Full monorepo gate (`pnpm check` / `pnpm test:security`) | carried from prior green baseline (536/86); additive change to `@sveltex/auth` only, integration services offline this session |
| `npm pack --dry-run` for `@sveltex/auth` | includes the new subpath `.js`/`.d.ts`; no src/test leakage |

Full-monorepo totals after Phase 2: **565/565 runtime tests** and **93/93 security tests**, recorded in
[`docs/specification.md`](../specification.md).

---

## Not claimed / still open (honesty)

- **OAuth2 / OIDC** — explicitly out of scope for this plan; not implemented and not advertised.
- **MFA** — not in scope for this batch.
- **Distributed token store** — `MemoryTokenStore` is dev/test only; a Redis/DB-backed `TokenStore`
  is left to the consumer. This is documented as a production gap, not claimed as cluster-safe.
- **Cookie transport / CSRF / account-lockout policies** — optional hardening, not part of Phase 2.

---

## File map

```
packages/auth/
├── src/
│   ├── errors.ts        # AuthError hierarchy (NEW)
│   ├── limiter.ts       # FixedWindowLimiter (NEW)
│   ├── tokens.ts        # TokenManager + MemoryTokenStore (NEW)
│   ├── reset.ts         # PasswordResetService + contract (NEW)
│   ├── verification.ts  # EmailVerificationService + contract (NEW)
│   ├── rbac.ts          # RbacBuilder / createRbac (NEW)
│   ├── argon2.ts        # unchanged (Argon2Hasher)
│   └── index.ts         # wired + re-exported all new modules
├── tests/
│   ├── limiter.test.mjs · tokens.test.mjs · rbac.test.mjs
│   ├── reset.test.mjs · verification.test.mjs
│   ├── security/phase2-security.test.mjs
│   └── types/phase2.test.ts
├── package.json         # subpath exports for new modules
└── README.md            # rewritten with all modules
```
