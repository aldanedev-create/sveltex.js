# @sveltex/session

Storage-agnostic session lifecycle and storage contracts.

## Install

```sh
pnpm add @sveltex/session
```

## Create and rotate a session

```ts
import { MemorySessionStore, SessionManager } from '@sveltex/session';

const sessions = new SessionManager(new MemorySessionStore(), {
  ttlMs: 1000 * 60 * 60 * 24,
});

const session = await sessions.create({ userId: 'user-123' });
// After login or a privilege change, rotate the identifier.
const authenticated = await sessions.rotate(session.id);
```

The manager supports create, read, update, touch, rotate, destroy, and expiry. Session IDs must be at least 16 URL-safe characters. Session payloads are data-only, cloned, and deeply frozen. Updates and rotations use revisions: production stores must implement `createIfAbsent`, `compareAndSet`, and `rotate` atomically in the backing database/transaction. A non-atomic implementation can resurrect sessions or lose concurrent updates and is not supported. The memory store is for tests and single-process development only. Use a shared persistent store for multi-instance production deployments.

Cookie serialization, signing, secure cookie flags, and SvelteKit request integration are deliberately outside this package's initial foundation; those belong in a later integration layer.

## Status

Initial 0.1.0 foundation. Cookie serialization, signing, secure cookie flags, CSRF protection, persistent storage, and revocation policy must be supplied by the integration and deployment.
