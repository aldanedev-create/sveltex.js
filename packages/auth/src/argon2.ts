import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { PasswordHasher } from './index.js';

/**
 * Argon2id algorithm constant (value: 2).
 * Matches `Algorithm.Argon2id` from `@node-rs/argon2`.
 * Using a numeric literal avoids `const enum` incompatibility with
 * `verbatimModuleSyntax`.
 */
const ARGON2ID = 2;

/**
 * Argon2id password hasher options.
 *
 * @public
 */
export interface Argon2HasherOptions {
  /**
   * Memory cost in KiB. Default: 19456 (19 MiB).
   * OWASP recommends minimum 19 MiB for Argon2id.
   */
  readonly memoryCost?: number;
  /**
   * Time cost (iterations). Default: 2.
   * OWASP recommends minimum 2 for Argon2id.
   */
  readonly timeCost?: number;
  /**
   * Parallelism (lanes). Default: 1.
   * OWASP recommends minimum 1 for Argon2id.
   */
  readonly parallelism?: number;
}

/**
 * Argon2id password hasher implementing the {@link PasswordHasher} contract.
 *
 * Uses `@node-rs/argon2` which provides native Argon2id via the Rust
 * `argon2` crate. Argon2id is the OWASP-recommended algorithm for password
 * hashing because it combines the anti-GPU resistance of Argon2i with the
 * side-channel resistance of Argon2d.
 *
 * The encoded hash format is PHC-compatible (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`),
 * which includes all parameters needed for verification.
 *
 * @example
 * ```ts
 * import { AuthService } from '@sveltex/auth';
 * import { Argon2Hasher, generateDummyHash } from '@sveltex/auth/argon2';
 *
 * const hasher = new Argon2Hasher();
 * const dummyHash = await generateDummyHash();
 *
 * const auth = new AuthService(userStore, hasher, sessionPort, {
 *   dummyPasswordHash: dummyHash,
 * });
 * ```
 *
 * @public
 */
export class Argon2Hasher implements PasswordHasher {
  readonly #memoryCost: number;
  readonly #timeCost: number;
  readonly #parallelism: number;

  constructor(options: Argon2HasherOptions = {}) {
    this.#memoryCost = options.memoryCost ?? 19456;
    this.#timeCost = options.timeCost ?? 2;
    this.#parallelism = options.parallelism ?? 1;
    if (!Number.isSafeInteger(this.#memoryCost) || this.#memoryCost < 1) {
      throw new RangeError('memoryCost must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#timeCost) || this.#timeCost < 1) {
      throw new RangeError('timeCost must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#parallelism) || this.#parallelism < 1) {
      throw new RangeError('parallelism must be a positive integer.');
    }
  }

  async hash(password: string): Promise<string> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new TypeError('Password must be a non-empty string.');
    }
    if (password.length > 1024) {
      throw new TypeError('Password must not exceed 1024 characters.');
    }
    return argon2Hash(password, {
      algorithm: ARGON2ID,
      memoryCost: this.#memoryCost,
      timeCost: this.#timeCost,
      parallelism: this.#parallelism,
    });
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    if (typeof password !== 'string' || password.length === 0) {
      return false;
    }
    if (typeof encodedHash !== 'string' || !encodedHash.startsWith('$argon2')) {
      return false;
    }
    try {
      return await argon2Verify(encodedHash, password);
    } catch {
      return false;
    }
  }
}

/**
 * Generate a dummy password hash for timing attack mitigation.
 *
 * This generates a real Argon2id hash that can be used as the
 * `dummyPasswordHash` option for `AuthServiceOptions`. It ensures that
 * even when no user is found during login, the same amount of time is
 * spent on password verification, reducing timing-based user enumeration.
 *
 * @example
 * ```ts
 * import { Argon2Hasher, generateDummyHash } from '@sveltex/auth/argon2';
 *
 * const dummyHash = await generateDummyHash();
 * const auth = new AuthService(store, new Argon2Hasher(), sessions, {
 *   dummyPasswordHash: dummyHash,
 * });
 * ```
 *
 * @public
 */
export async function generateDummyHash(): Promise<string> {
  const hasher = new Argon2Hasher();
  return hasher.hash('dummy-password-for-timing-mitigation-' + Date.now());
}
