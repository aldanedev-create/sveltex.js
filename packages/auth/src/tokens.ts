import { randomBytes } from 'node:crypto';
import {
  AuthTokenError,
  AuthTokenExpiredError,
  AuthTokenInvalidError,
  AuthTokenUsedError,
} from './errors.js';

/**
 * A token purpose namespaces issued tokens so a reset token cannot be replayed
 * against the verification endpoint, and vice versa.
 *
 * @public
 */
export type TokenPurpose = string;

/** A persisted single-use token record. */
export interface TokenRecord {
  readonly token: string;
  readonly purpose: TokenPurpose;
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Set when the token is consumed; `null` while still usable. */
  readonly consumedAt: number | null;
}

/** Token issued to a caller (the `token` value is the secret to transmit). */
export interface IssuedToken {
  readonly token: string;
  readonly purpose: TokenPurpose;
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Persistence contract for single-use tokens. Implementations MUST make
 * `consume` and `markConsumed` atomic with respect to concurrent callers so a
 * token cannot be redeemed twice. The in-memory implementation provided here is
 * suitable for development and tests; production deployments should back this
 * with a shared store (Redis/DB) so limits survive restarts and scale across
 * instances.
 *
 * @public
 */
export interface TokenStore {
  issue(record: TokenRecord): Awaitable<void>;
  /** Atomically mark the token consumed and return its record, or `undefined`. */
  consume(token: string): Awaitable<TokenRecord | undefined>;
  peek(token: string): Awaitable<TokenRecord | undefined>;
  delete(token: string): Awaitable<void>;
}

type Awaitable<T> = T | PromiseLike<T>;

/**
 * In-memory {@link TokenStore}. Single-process only; expires entries lazily on
 * access and sweeps during reads. Use for development, tests, and single-instance
 * deployments behind a short TTL.
 *
 * @public
 */
export class MemoryTokenStore implements TokenStore {
  readonly #records = new Map<string, TokenRecord>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async issue(record: TokenRecord): Promise<void> {
    this.#records.set(record.token, record);
  }

  async consume(token: string): Promise<TokenRecord | undefined> {
    const record = this.#records.get(token);
    if (!record) return undefined;
    const consumed: TokenRecord = { ...record, consumedAt: this.#now() };
    this.#records.set(token, consumed);
    return consumed;
  }

  async peek(token: string): Promise<TokenRecord | undefined> {
    return this.#records.get(token);
  }

  async delete(token: string): Promise<void> {
    this.#records.delete(token);
  }

  /** Remove all expired entries. Safe to call periodically. */
  sweep(): void {
    const now = this.#now();
    for (const [token, record] of this.#records) {
      if (now >= record.expiresAt) this.#records.delete(token);
    }
  }
}

/**
 * Generate a URL-safe cryptographically random token. Defaults to 32 bytes
 * (256 bits) of entropy — sufficient that online guessing is infeasible even
 * with short TTLs.
 *
 * @public
 */
export function generateSecureToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16) {
    throw new RangeError('Token entropy must be at least 16 bytes.');
  }
  return randomBytes(bytes).toString('base64url');
}

/**
 * Orchestrates issue/verify/consume of single-use, purpose-scoped, expiring
 * tokens. Used by password-reset and email-verification workflows.
 *
 * @public
 */
export class TokenManager {
  readonly #store: TokenStore;
  readonly #now: () => number;

  constructor(store: TokenStore, options: { now?: () => number } = {}) {
    if (!store || typeof store.issue !== 'function' || typeof store.consume !== 'function' || typeof store.peek !== 'function') {
      throw new AuthTokenError('A valid TokenStore is required.', 'AUTH_TOKEN_STORE');
    }
    this.#store = store;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Issue a new token bound to `subject` (typically a user id) for `ttlMs`. */
  async issue(purpose: TokenPurpose, subject: string, ttlMs: number): Promise<IssuedToken> {
    if (typeof purpose !== 'string' || purpose.length === 0) throw new TypeError('A non-empty token purpose is required.');
    if (typeof subject !== 'string' || subject.length === 0) throw new TypeError('A non-empty token subject is required.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive integer.');
    const now = this.#now();
    const token = generateSecureToken();
    const record: TokenRecord = Object.freeze({
      token,
      purpose,
      subject,
      issuedAt: now,
      expiresAt: now + ttlMs,
      consumedAt: null,
    });
    await this.#store.issue(record);
    return { token, purpose, subject, issuedAt: now, expiresAt: record.expiresAt };
  }

  /**
   * Validate a token without consuming it. Returns the bound subject, or throws
   * {@link AuthTokenExpiredError} / {@link AuthTokenUsedError} /
   * {@link AuthTokenInvalidError}. Use {@link verifyOrNull} when a missing token
   * should resolve to "not authorized" rather than an error.
   */
  async verify(token: string, purpose: TokenPurpose): Promise<string> {
    return this.#evaluate(token, purpose, false);
  }

  /** Like {@link verify} but returns `undefined` instead of throwing. */
  async verifyOrNull(token: string, purpose: TokenPurpose): Promise<string | undefined> {
    try {
      return await this.#evaluate(token, purpose, false);
    } catch (error) {
      if (error instanceof AuthTokenError) return undefined;
      throw error;
    }
  }

  /** Validate and consume a token (single-use). Returns the bound subject. */
  async consume(token: string, purpose: TokenPurpose): Promise<string> {
    return this.#evaluate(token, purpose, true);
  }

  async #evaluate(token: string, purpose: TokenPurpose, consume: boolean): Promise<string> {
    if (typeof token !== 'string' || token.length === 0) throw new AuthTokenInvalidError();
    if (typeof purpose !== 'string' || purpose.length === 0) throw new AuthTokenInvalidError();
    const record = await this.#store.peek(token);
    if (!record) throw new AuthTokenInvalidError();
    if (record.purpose !== purpose) throw new AuthTokenInvalidError();
    if (record.consumedAt !== null) throw new AuthTokenUsedError();
    if (this.#now() >= record.expiresAt) throw new AuthTokenExpiredError();
    if (consume) {
      const claimed = await this.#store.consume(token);
      if (!claimed || claimed.consumedAt === null) throw new AuthTokenUsedError();
      if (claimed.purpose !== purpose) throw new AuthTokenInvalidError();
    }
    return record.subject;
  }
}
