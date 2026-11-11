import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookieHeader } from './cookie.js';
import type { SameSiteValue } from './cookie.js';

export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_FIELD_NAME = '_csrf';
export const CSRF_COOKIE_NAME = '__Host-sveltex_csrf';
export const SAFE_HTTP_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export class CsrfError extends Error {
  readonly code: string;
  constructor(message: string, code = 'CSRF_INVALID') {
    super(message);
    this.name = 'CsrfError';
    this.code = code;
  }
}

/**
 * Constant-time comparison for arbitrary-length strings. Hashing to a fixed 32-byte
 * digest avoids both the length leak of `timingSafeEqual` and its length precondition.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export interface CsrfCookieSerializationOptions {
  readonly name?: string;
  readonly secure?: boolean;
  readonly sameSite?: SameSiteValue;
  readonly path?: string;
  readonly maxAge?: number;
}

/**
 * Serialize the double-submit cookie. This cookie is intentionally **not** HttpOnly —
 * the browser must read it and echo the value in a header. Use the optional HMAC
 * `secret` to bind each token to a session id so a token injected by an attacker on a
 * subdomain cannot be replayed against another session.
 */
export function serializeCsrfCookie(token: string, options: CsrfCookieSerializationOptions = {}): string {
  const name = options.name ?? CSRF_COOKIE_NAME;
  if (typeof name !== 'string' || name.length === 0 || /[\x00-\x20\x7f;,"\\=]/.test(name)) {
    throw new CsrfError('Invalid CSRF cookie name.', 'CSRF_CONFIG');
  }
  if (typeof token !== 'string' || token.length === 0 || /[\x00-\x20\x7f;,"\\]/.test(token)) {
    throw new CsrfError('Invalid CSRF token value.', 'CSRF_CONFIG');
  }
  const secure = options.secure ?? true;
  const sameSite = options.sameSite ?? 'strict';
  const path = options.path ?? '/';
  const maxAge = options.maxAge ?? 3600;
  if (!secure && name.startsWith('__Host-')) throw new CsrfError('Prefixed CSRF cookies require Secure.', 'CSRF_CONFIG');
  const parts = [`${name}=${token}`, `Path=${path}`, `SameSite=${sameSite === 'strict' ? 'Strict' : sameSite === 'lax' ? 'Lax' : 'None'}`, `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export interface CsrfProtectionOptions {
  /** When set, tokens are HMAC-bound to `sessionId` (synchronizer/double-submit hybrid). */
  readonly secret?: string | Uint8Array;
  readonly tokenBytes?: number;
  readonly headerName?: string;
  readonly fieldName?: string;
  readonly cookieName?: string;
  readonly safeMethods?: readonly string[];
  readonly secure?: boolean;
  readonly sameSite?: SameSiteValue;
  readonly path?: string;
  readonly maxAge?: number;
}

export interface CsrfToken {
  /** The value to echo back in the request header or form field. */
  readonly value: string;
  /** A ready-to-use Set-Cookie header value for the double-submit cookie. */
  readonly cookie: string;
}

export interface CsrfAssertionInput {
  readonly method: string;
  readonly headerToken?: string | undefined;
  readonly fieldToken?: string | undefined;
  readonly cookieToken?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface CsrfRequestLike {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>> | { get(name: string): string | null | undefined };
  readonly cookieHeader?: string;
  readonly formToken?: string;
  readonly sessionId?: string;
}

function readHeader(headers: CsrfRequestLike['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null | undefined }).get(name) ?? undefined;
  }
  const record = headers as Readonly<Record<string, string | string[] | undefined>>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    const value = record[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

/** Double-submit CSRF protection with optional HMAC binding to a session id. */
export class CsrfProtection {
  readonly #secret: Uint8Array | undefined;
  readonly #tokenBytes: number;
  readonly #headerName: string;
  readonly #fieldName: string;
  readonly #cookieName: string;
  readonly #safeMethods: ReadonlySet<string>;
  readonly #secure: boolean;
  readonly #sameSite: SameSiteValue;
  readonly #path: string;
  readonly #maxAge: number;

  constructor(options: CsrfProtectionOptions = {}) {
    let secret: Uint8Array | undefined;
    if (options.secret !== undefined) {
      if (typeof options.secret === 'string') {
        if (options.secret.length < 16) throw new CsrfError('A CSRF secret must be at least 16 characters.', 'CSRF_CONFIG');
        secret = new TextEncoder().encode(options.secret);
      } else if (options.secret instanceof Uint8Array) {
        if (options.secret.byteLength < 16) throw new CsrfError('A CSRF secret must be at least 16 bytes.', 'CSRF_CONFIG');
        secret = Uint8Array.from(options.secret);
      } else {
        throw new CsrfError('secret must be a string or Uint8Array.', 'CSRF_CONFIG');
      }
    }
    const tokenBytes = options.tokenBytes ?? 32;
    if (!Number.isSafeInteger(tokenBytes) || tokenBytes < 16 || tokenBytes > 64) throw new CsrfError('tokenBytes must be an integer from 16 to 64.', 'CSRF_CONFIG');
    const headerName = options.headerName ?? CSRF_HEADER_NAME;
    const fieldName = options.fieldName ?? CSRF_FIELD_NAME;
    const cookieName = options.cookieName ?? CSRF_COOKIE_NAME;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) throw new CsrfError('Invalid headerName.', 'CSRF_CONFIG');
    if (typeof fieldName !== 'string' || fieldName.length === 0 || fieldName.length > 128) throw new CsrfError('Invalid fieldName.', 'CSRF_CONFIG');
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)) throw new CsrfError('Invalid cookieName.', 'CSRF_CONFIG');
    const sameSite = options.sameSite ?? 'strict';
    if (sameSite !== 'strict' && sameSite !== 'lax' && sameSite !== 'none') throw new CsrfError('Invalid sameSite.', 'CSRF_CONFIG');
    const secure = options.secure ?? true;
    if (sameSite === 'none' && !secure) throw new CsrfError('SameSite=None requires Secure.', 'CSRF_CONFIG');
    const path = options.path ?? '/';
    if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n;]/.test(path)) throw new CsrfError('Invalid path.', 'CSRF_CONFIG');
    const maxAge = options.maxAge ?? 3600;
    if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 31_536_000) throw new CsrfError('Invalid maxAge.', 'CSRF_CONFIG');
    const methods = options.safeMethods ?? SAFE_HTTP_METHODS;
    if (!Array.isArray(methods)) throw new CsrfError('safeMethods must be an array.', 'CSRF_CONFIG');

    this.#secret = secret;
    this.#tokenBytes = tokenBytes;
    this.#headerName = headerName;
    this.#fieldName = fieldName;
    this.#cookieName = cookieName;
    this.#safeMethods = new Set(methods.map(m => (typeof m === 'string' ? m.toUpperCase() : '')));
    this.#secure = secure;
    this.#sameSite = sameSite;
    this.#path = path;
    this.#maxAge = maxAge;
  }

  get cookieName(): string { return this.#cookieName; }
  get headerName(): string { return this.#headerName; }
  get fieldName(): string { return this.#fieldName; }

  isSafeMethod(method: string): boolean {
    if (typeof method !== 'string') return false;
    return this.#safeMethods.has(method.toUpperCase());
  }

  /** Issue a fresh token (and the matching Set-Cookie header). */
  issue(sessionId?: string): CsrfToken {
    const nonce = randomBytes(this.#tokenBytes).toString('base64url');
    const value = this.#secret ? `${nonce}.${this.#mac(nonce, sessionId)}` : nonce;
    const cookie = serializeCsrfCookie(value, {
      name: this.#cookieName, secure: this.#secure, sameSite: this.#sameSite, path: this.#path, maxAge: this.#maxAge,
    });
    return Object.freeze({ value, cookie });
  }

  /** Verify a token's shape and, when a secret is configured, its HMAC binding. */
  verify(token: string, sessionId?: string): boolean {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
    if (!this.#secret) return /^[A-Za-z0-9_-]{16,256}$/.test(token);
    const dot = token.lastIndexOf('.');
    if (dot < 16) return false;
    const nonce = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(mac)) return false;
    return constantTimeEqual(mac, this.#mac(nonce, sessionId));
  }

  /**
   * Assert a request is legitimate. Safe methods pass; every other method must present
   * a token (header or form) that matches the double-submit cookie in constant time and,
   * when bound, whose signature is valid for the given session id.
   */
  assertValid(input: CsrfAssertionInput): void {
    if (this.isSafeMethod(input.method)) return;
    const submitted = input.headerToken ?? input.fieldToken;
    if (!submitted) throw new CsrfError('A CSRF token is required for this request.', 'CSRF_TOKEN_MISSING');
    if (!input.cookieToken) throw new CsrfError('The CSRF cookie is missing.', 'CSRF_COOKIE_MISSING');
    if (!constantTimeEqual(submitted, input.cookieToken)) throw new CsrfError('The submitted token does not match the cookie.', 'CSRF_TOKEN_MISMATCH');
    if (!this.verify(input.cookieToken, input.sessionId)) throw new CsrfError('The CSRF token signature is invalid.', 'CSRF_TOKEN_INVALID');
  }

  /** Convenience wrapper that extracts tokens from a request-like object. */
  assertValidRequest(request: CsrfRequestLike): void {
    if (!request || typeof request.method !== 'string') throw new CsrfError('A request with a method is required.', 'CSRF_REQUEST_INVALID');
    const headerToken = readHeader(request.headers, this.#headerName);
    const cookieHeader = request.cookieHeader ?? readHeader(request.headers, 'cookie');
    const cookies = parseCookieHeader(cookieHeader);
    this.assertValid({
      method: request.method,
      headerToken,
      fieldToken: request.formToken,
      cookieToken: cookies[this.#cookieName],
      sessionId: request.sessionId,
    });
  }

  #mac(nonce: string, sessionId?: string): string {
    const payload = `${sessionId ?? ''}:${nonce}`;
    return createHmac('sha256', this.#secret as Uint8Array).update(payload, 'utf8').digest('base64url');
  }
}
