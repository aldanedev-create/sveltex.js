# @sveltex/auth

Credential-authentication orchestration with explicit user-store, password-hasher, and session ports. Registration only accepts email, password, and inert metadata; the user repository owns role and privilege defaults and must enforce email uniqueness atomically. This package deliberately ships **no password-hashing algorithm**: inject a maintained Argon2id, scrypt, or bcrypt implementation with safe parameters and constant-time verification.

```ts
const auth = new AuthService(userStore, passwordHasher, sessionPort, { limiter, dummyPasswordHash });
const result = await auth.login(email, password);
if (!result) throw error(401, 'Invalid email or password');
```

Use the same generic failure response for unknown users and incorrect passwords. Add rate limiting, email verification, password reset, MFA, CSRF protection, secure HttpOnly/SameSite cookies, HTTPS, audit logging, and account lockout policies appropriate to your threat model. `dummyPasswordHash` is required and must be a precomputed valid hash produced by the same hasher and cost parameters. It is verified for unknown accounts to reduce obvious timing-based enumeration. Never use a placeholder or log passwords or hashes.

## What ships in this package

| Capability | Export | Notes |
|---|---|---|
| Credential orchestration | `AuthService` | register / login / logout / rotateSession |
| Argon2id hasher | `Argon2Hasher`, `generateDummyHash` | via `@node-rs/argon2` |
| Attempt limiter (concrete) | `FixedWindowLimiter` | satisfies the `AuthAttemptLimiter` port |
| Secure single-use tokens | `TokenManager`, `MemoryTokenStore`, `generateSecureToken` | purpose-scoped, expiring, replay-safe |
| Password reset | `PasswordResetService` | silent for unknown emails |
| Email verification | `EmailVerificationService` | single-use verification links |
| Role-based access control | `RbacBuilder`, `createRbac` | deny-by-default, inheritance, 401/403 |

OAuth2 / OIDC and MFA are **explicitly out of scope** for this package and are not advertised.

## Rate limiting

`AuthAttemptLimiter` is a port; `FixedWindowLimiter` is a concrete, in-memory implementation you can plug straight into `AuthService`. The limiter is consulted *before* the user lookup, so it also throttles enumeration attempts.

```ts
import { AuthService, FixedWindowLimiter } from '@sveltex/auth';

const limiter = new FixedWindowLimiter({ max: 5, windowMs: 15 * 60_000 });
const auth = new AuthService(store, hasher, sessions, { limiter, dummyPasswordHash });
```

## Secure tokens (reset / verification)

`TokenManager` issues opaque, cryptographically random tokens that are bound to a `subject` (usually a user id), scoped to a `purpose`, and expire after a TTL. Each token is **single-use** (replay is rejected) and **purpose-scoped** (a reset token cannot be replayed against the verification endpoint). `MemoryTokenStore` is provided for development and tests; back it with Redis/DB in production.

```ts
import { TokenManager, MemoryTokenStore } from '@sveltex/auth';

const tokens = new TokenManager(new MemoryTokenStore());
const { token } = await tokens.issue('password-reset', user.id, 30 * 60_000);
// later, in the reset handler:
const userId = await tokens.consume(token, 'password-reset'); // throws if expired/used/wrong-purpose
```

## Password reset

`PasswordResetService` wires `TokenManager` to your credential store. `requestReset` is **silent for unknown emails** (no enumeration), and `completeReset` validates the new password *before* consuming the token so a weak password never burns the link.

```ts
import { PasswordResetService } from '@sveltex/auth';

const reset = new PasswordResetService(userStore, hasher, tokens);
await reset.requestReset(email, async ({ email, token, expiresAt }) => mailer.send(email, resetLink(token)));
// ...
const user = await reset.completeReset(token, newPassword);
```

Your store must implement `PasswordResetStore` (extends `CredentialUserStore` with `findById` and `updatePassword`).

## Email verification

```ts
import { EmailVerificationService } from '@sveltex/auth';

const verification = new EmailVerificationService(userStore, tokens);
await verification.requestVerification(user, async ({ email, token, expiresAt }) => mailer.send(email, verifyLink(token)));
// ...
const userId = await verification.verify(token); // marks the account verified, single-use
```

Your store must implement `EmailVerificationStore` (`findById` + `markVerified`).

## Role-based access control

`RbacBuilder` is deny-by-default. Define roles, optionally inherit others, and check permissions. `requirePermission` throws `AuthUnauthorizedError` (no roles) or `AuthForbiddenError` (authenticated but under-privileged).

```ts
import { createRbac } from '@sveltex/auth';

const rbac = createRbac({
  user:  { permissions: ['profile:read', 'profile:write'] },
  admin: { permissions: ['users:read'], inherits: ['user'] },
});

rbac.requirePermission(user.roles, 'users:read'); // throws AuthForbiddenError if lacking
```

## Security guarantees

- Unknown-user and wrong-password logins return the same shape and verify the same dummy hash (timing/enumeration mitigation).
- Passwords are never returned on the user object; untrusted fields (roles, `passwordHash`) cannot be self-assigned at registration.
- Tokens are 256-bit random, single-use, expiring, and purpose-scoped.
- RBAC denies by default and cannot be escalated by presenting unknown role strings.
