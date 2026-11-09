import type { AuthUser } from './index.js';
import { AuthTokenInvalidError } from './errors.js';
import { TokenManager, type TokenPurpose } from './tokens.js';

/**
 * Purpose string for email-verification tokens.
 *
 * @public
 */
export const EMAIL_VERIFICATION_PURPOSE = 'email-verification' as const;

/**
 * Storage contract required by {@link EmailVerificationService}. `markVerified`
 * flips the verified flag for `id` and returns whether the account still exists.
 *
 * @public
 */
export interface EmailVerificationStore<User extends AuthUser = AuthUser> {
  findById(id: string): Promise<User | undefined>;
  markVerified(id: string): Promise<boolean>;
}

/** Context handed to the sender so it can build a verification link. */
export interface EmailVerificationContext {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Application-provided transport that delivers the verification link to the user.
 *
 * @public
 */
export interface EmailVerificationSender {
  send(context: EmailVerificationContext): Promise<void>;
}

/**
 * Options for {@link EmailVerificationService}.
 *
 * @public
 */
export interface EmailVerificationOptions {
  readonly ttlMs?: number;
  readonly purpose?: TokenPurpose;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Email-verification workflow. Issues single-use, expiring, purpose-scoped tokens
 * and marks the account verified when the token is redeemed.
 *
 * @public
 */
export class EmailVerificationService<User extends AuthUser = AuthUser> {
  readonly #store: EmailVerificationStore<User>;
  readonly #tokens: TokenManager;
  readonly #ttl: number;
  readonly #purpose: TokenPurpose;

  constructor(store: EmailVerificationStore<User>, tokens: TokenManager, options: EmailVerificationOptions = {}) {
    if (!store || typeof store.findById !== 'function' || typeof store.markVerified !== 'function') {
      throw new AuthTokenInvalidError('A valid EmailVerificationStore is required.');
    }
    this.#store = store;
    this.#tokens = tokens;
    this.#ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#purpose = options.purpose ?? EMAIL_VERIFICATION_PURPOSE;
  }

  /** Send a verification link for `user` via `sender`. */
  async requestVerification(user: User, sender: EmailVerificationSender): Promise<void> {
    if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') {
      throw new TypeError('A user with an id and email is required.');
    }
    const issued = await this.#tokens.issue(this.#purpose, user.id, this.#ttl);
    await sender.send({ email: user.email, token: issued.token, expiresAt: issued.expiresAt });
  }

  /**
   * Verify a token and mark the account verified. Returns the verified user id.
   * The token is single-use; replaying it after redemption fails.
   */
  async verify(token: string): Promise<string> {
    const userId = await this.#tokens.consume(token, this.#purpose);
    const ok = await this.#store.markVerified(userId);
    if (!ok) throw new AuthTokenInvalidError('The account no longer exists.');
    return userId;
  }
}
