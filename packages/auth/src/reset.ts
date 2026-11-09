import type { AuthUser, PasswordHasher } from './index.js';
import { AuthTokenInvalidError } from './errors.js';
import { TokenManager, type TokenPurpose } from './tokens.js';

/**
 * Purpose string for password-reset tokens. Keep distinct from verification so a
 * reset token cannot be replayed against the verification endpoint.
 *
 * @public
 */
export const PASSWORD_RESET_PURPOSE = 'password-reset' as const;

/**
 * Storage contract required by {@link PasswordResetService}. Extends the
 * credential store with the lookups and the password mutation a real reset
 * needs. `updatePassword` must be atomic and should re-hash is never done here
 * (the service owns hashing with the configured hasher).
 *
 * @public
 */
export interface PasswordResetStore<User extends AuthUser = AuthUser> {
  findByEmail(normalizedEmail: string): Promise<(User & { readonly passwordHash: string }) | undefined>;
  findById(id: string): Promise<User | undefined>;
  updatePassword(id: string, newHash: string): Promise<boolean>;
}

/** Context handed to the sender so it can build a reset link. */
export interface PasswordResetContext {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Application-provided transport that delivers the reset link to the user (email,
 * SMS, etc.). Kept as a port so `@sveltex/auth` never depends on a mail client.
 *
 * @public
 */
export interface PasswordResetSender {
  send(context: PasswordResetContext): Promise<void>;
}

/**
 * Options for {@link PasswordResetService}.
 *
 * @public
 */
export interface PasswordResetOptions {
  readonly minPasswordLength?: number;
  readonly maxPasswordLength?: number;
  readonly ttlMs?: number;
  readonly normalizeEmail?: (email: string) => string;
  readonly purpose?: TokenPurpose;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Password-reset workflow. Issues single-use, expiring, purpose-scoped tokens and
 * verifies them before re-hashing and persisting a new password.
 *
 * Security guarantees:
 * - `requestReset` is silent for unknown emails (no user enumeration).
 * - The new password is validated **before** the single-use token is consumed,
 *   so a weak password does not burn the token.
 * - Tokens are bound to the user id (`subject`) and cannot be repurposed.
 *
 * @public
 */
export class PasswordResetService<User extends AuthUser = AuthUser> {
  readonly #store: PasswordResetStore<User>;
  readonly #hasher: PasswordHasher;
  readonly #tokens: TokenManager;
  readonly #min: number;
  readonly #max: number;
  readonly #ttl: number;
  readonly #normalize: (email: string) => string;
  readonly #purpose: TokenPurpose;

  constructor(store: PasswordResetStore<User>, hasher: PasswordHasher, tokens: TokenManager, options: PasswordResetOptions = {}) {
    if (!store || typeof store.findByEmail !== 'function' || typeof store.findById !== 'function' || typeof store.updatePassword !== 'function') {
      throw new AuthTokenInvalidError('A valid PasswordResetStore is required.');
    }
    if (!hasher || typeof hasher.hash !== 'function' || typeof hasher.verify !== 'function') {
      throw new AuthTokenInvalidError('A valid PasswordHasher is required.');
    }
    this.#store = store;
    this.#hasher = hasher;
    this.#tokens = tokens;
    this.#min = options.minPasswordLength ?? 12;
    this.#max = options.maxPasswordLength ?? 1024;
    if (!Number.isSafeInteger(this.#min) || this.#min < 1 || !Number.isSafeInteger(this.#max) || this.#max < this.#min || this.#max > 4096) {
      throw new RangeError('Password length limits are invalid.');
    }
    this.#ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#normalize = options.normalizeEmail ?? ((email: string) => email.trim().toLowerCase());
    this.#purpose = options.purpose ?? PASSWORD_RESET_PURPOSE;
  }

  /**
   * Begin a reset for `email`. Resolves to `void` for every input so callers can
   * show a generic "if an account exists, a link was sent" message. The token is
   * delivered through `sender` only when the account exists.
   */
  async requestReset(email: string, sender: PasswordResetSender): Promise<void> {
    if (typeof email !== 'string') throw new TypeError('A string email is required.');
    const normalized = this.#normalize(email);
    const user = await this.#store.findByEmail(normalized);
    if (!user) return;
    const issued = await this.#tokens.issue(this.#purpose, user.id, this.#ttl);
    await sender.send({ email: normalized, token: issued.token, expiresAt: issued.expiresAt });
  }

  /**
   * Complete a reset using a token from `requestReset`. Validates the new password
   * first (so a rejected password keeps the token usable), then consumes the
   * token, re-hashes, and persists. Returns the updated user record.
   */
  async completeReset(token: string, newPassword: string): Promise<User> {
    if (typeof newPassword !== 'string' || newPassword.length < this.#min || newPassword.length > this.#max) {
      throw new TypeError(`Password must contain ${this.#min}–${this.#max} characters.`);
    }
    const userId = await this.#tokens.consume(token, this.#purpose);
    const newHash = await this.#hasher.hash(newPassword);
    if (typeof newHash !== 'string' || newHash.length < 20 || newHash.length > 4096) {
      throw new AuthTokenInvalidError('Password hasher returned an invalid encoded hash.');
    }
    const updated = await this.#store.updatePassword(userId, newHash);
    if (!updated) throw new AuthTokenInvalidError('The account no longer exists.');
    const user = await this.#store.findById(userId);
    if (!user) throw new AuthTokenInvalidError('The account no longer exists.');
    return user;
  }
}
