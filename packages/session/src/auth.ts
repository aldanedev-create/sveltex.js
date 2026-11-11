import { SessionRevocationUnsupportedError } from './index.js';
import type { RevocableSessionStore, SessionHandle, SessionManager, SessionStore } from './index.js';

/**
 * Structurally identical to `@sveltex/auth`'s `AuthSessionPort<Session>`. Declared locally
 * so `@sveltex/session` does not take a compile-time dependency on the auth package;
 * `tests/types/phase3.test.ts` proves assignability against the real interface.
 */
export interface AuthSessionPortLike<Session> {
  create(data: { readonly userId: string }): Promise<Session>;
  destroy(id: string): Promise<void>;
  rotate?(id: string): Promise<Session | undefined>;
}

export { SessionRevocationUnsupportedError } from './index.js';

/**
 * Bridge a {@link SessionManager} to `@sveltex/auth`'s session port.
 *
 * - `create({userId})` stores `userId` in the session data so stores with a `user_id`
 *   index can revoke all of a user's sessions.
 * - `rotate(id)` is provided so `AuthService.rotateSession()` can prevent session
 *   fixation after a privilege change.
 * - `destroy(id)` maps to logout.
 */
export function createAuthSessionPort<Data extends Record<string, unknown> = Record<string, unknown>>(
  manager: SessionManager<Data>,
): AuthSessionPortLike<SessionHandle<Data>> {
  if (!manager || typeof manager.create !== 'function' || typeof manager.destroy !== 'function' || typeof manager.rotate !== 'function') {
    throw new TypeError('A SessionManager is required.');
  }
  return Object.freeze({
    async create(data: { readonly userId: string }): Promise<SessionHandle<Data>> {
      if (!data || typeof data.userId !== 'string' || data.userId.length === 0 || data.userId.length > 255) {
        throw new TypeError('A valid userId is required to create an authenticated session.');
      }
      return manager.create({ userId: data.userId } as unknown as Data);
    },
    async destroy(id: string): Promise<void> {
      await manager.destroy(id);
    },
    async rotate(id: string): Promise<SessionHandle<Data> | undefined> {
      return manager.rotate(id);
    },
  });
}

/** Whether a store implements per-user revocation. */
export function supportsRevocation(store: SessionStore): store is RevocableSessionStore {
  return !!store && typeof (store as Partial<RevocableSessionStore>).revokeAllForUser === 'function';
}

/**
 * Revoke all sessions belonging to a user. Throws (rather than silently succeeding) when
 * the store has no revocation capability — no fake support is advertised.
 */
export async function revokeAllForUser(store: SessionStore, userId: string): Promise<number> {
  if (!supportsRevocation(store)) throw new SessionRevocationUnsupportedError();
  return store.revokeAllForUser(userId);
}
