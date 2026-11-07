# @sveltex/auth

Credential-authentication orchestration with explicit user-store, password-hasher, and session ports. Registration only accepts email, password, and inert metadata; the user repository owns role and privilege defaults and must enforce email uniqueness atomically. This package deliberately ships **no password-hashing algorithm**: inject a maintained Argon2id, scrypt, or bcrypt implementation with safe parameters and constant-time verification.

```ts
const auth = new AuthService(userStore, passwordHasher, sessionPort, { limiter, dummyPasswordHash });
const result = await auth.login(email, password);
if (!result) throw error(401, 'Invalid email or password');
```

Use the same generic failure response for unknown users and incorrect passwords. Add rate limiting, email verification, password reset, MFA, CSRF protection, secure HttpOnly/SameSite cookies, HTTPS, audit logging, and account lockout policies appropriate to your threat model. `dummyPasswordHash` is required and must be a precomputed valid hash produced by the same hasher and cost parameters. It is verified for unknown accounts to reduce obvious timing-based enumeration. Never use a placeholder or log passwords or hashes.
