import type { SessionHandle, SessionManager } from './index.js';

/** The only three values browsers accept for the `SameSite` attribute. */
export type SameSiteValue = 'strict' | 'lax' | 'none';

/**
 * Fully resolved, validated cookie attributes for the session identifier.
 * Immutable once produced by {@link resolveSessionCookieOptions}.
 */
export interface SessionCookieOptions {
  readonly name: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: SameSiteValue;
  readonly path: string;
  readonly domain?: string;
  readonly maxAge?: number;
  readonly partitioned?: boolean;
}

/** Overrides accepted by {@link resolveSessionCookieOptions}. */
export type SessionCookieConfig = Partial<SessionCookieOptions>;

export class SessionCookieError extends Error {
  readonly code: string;
  constructor(message: string, code = 'SESSION_COOKIE_INVALID') {
    super(message);
    this.name = 'SessionCookieError';
    this.code = code;
  }
}

/**
 * `__Host-` is the strongest cookie prefix: browsers only accept it when the cookie is
 * `Secure`, has `Path=/`, and carries **no** `Domain`. Pairing it with HttpOnly and
 * SameSite=Lax gives a safe default for a session identifier.
 */
export const DEFAULT_SESSION_COOKIE_NAME = '__Host-sveltex_session';

export const DEFAULT_SESSION_COOKIE_OPTIONS: SessionCookieOptions = Object.freeze({
  name: DEFAULT_SESSION_COOKIE_NAME,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
});

// RFC 6265 cookie-name token characters. Deliberately excludes ';', '=', whitespace,
// CR/LF and every control character — these are the classic Set-Cookie injection vectors.
const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,256}$/;

function assertCookieName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256 || !COOKIE_NAME_RE.test(name)) {
    throw new SessionCookieError('Cookie name must be a valid RFC 6265 token of 1–256 characters.');
  }
}

function assertCookieValue(value: string): void {
  // Reject control characters, whitespace, quotes, semicolons, commas and backslashes.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\x00-\x20\x7f;,"\\]/.test(value)) {
    throw new SessionCookieError('Cookie value contains characters that are unsafe in a Set-Cookie header.');
  }
}

function capSameSite(value: SameSiteValue): 'Strict' | 'Lax' | 'None' {
  if (value === 'strict') return 'Strict';
  if (value === 'lax') return 'Lax';
  return 'None';
}

/**
 * Merge overrides onto the secure defaults and reject every known-insecure combination.
 * This is deliberately strict: a session id cookie must not be downgraded by accident.
 */
export function resolveSessionCookieOptions(config: SessionCookieConfig = {}): SessionCookieOptions {
  const name = config.name ?? DEFAULT_SESSION_COOKIE_OPTIONS.name;
  const secure = config.secure ?? DEFAULT_SESSION_COOKIE_OPTIONS.secure;
  const httpOnly = config.httpOnly ?? DEFAULT_SESSION_COOKIE_OPTIONS.httpOnly;
  const sameSite = config.sameSite ?? DEFAULT_SESSION_COOKIE_OPTIONS.sameSite;
  const path = config.path ?? DEFAULT_SESSION_COOKIE_OPTIONS.path;
  const domain = config.domain;
  const maxAge = config.maxAge;
  const partitioned = config.partitioned;

  assertCookieName(name);
  if (typeof secure !== 'boolean' || typeof httpOnly !== 'boolean') throw new SessionCookieError('secure and httpOnly must be booleans.');
  if (sameSite !== 'strict' && sameSite !== 'lax' && sameSite !== 'none') throw new SessionCookieError('sameSite must be strict, lax or none.');
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n;]/.test(path)) throw new SessionCookieError('path must start with "/" and must not contain CR/LF or ";".');
  if (sameSite === 'none' && !secure) throw new SessionCookieError('SameSite=None requires Secure.');
  if (!secure && (name.startsWith('__Host-') || name.startsWith('__Secure-'))) {
    throw new SessionCookieError('Prefixed cookies require Secure; choose a different name when disabling Secure for local development.');
  }
  if (name.startsWith('__Host-') && (path !== '/' || domain !== undefined)) {
    throw new SessionCookieError('__Host- cookies require Path=/ and no Domain attribute.');
  }
  if (domain !== undefined && (typeof domain !== 'string' || domain.length > 253 || !DOMAIN_RE.test(domain) || domain.includes('..'))) {
    throw new SessionCookieError('domain is not a valid host name.');
  }
  if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 31_536_000)) {
    throw new SessionCookieError('maxAge must be a non-negative integer number of seconds (<= 1 year).');
  }
  if (partitioned !== undefined && typeof partitioned !== 'boolean') throw new SessionCookieError('partitioned must be a boolean.');
  if (partitioned === true && !secure) throw new SessionCookieError('Partitioned cookies require Secure.');

  return Object.freeze({
    name, secure, httpOnly, sameSite, path,
    ...(domain !== undefined ? { domain } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
    ...(partitioned !== undefined ? { partitioned } : {}),
  });
}

/** Serialize a Set-Cookie header value. Pure and safe for any resolved options. */
export function serializeSetCookie(name: string, value: string, options: SessionCookieOptions): string {
  assertCookieName(name);
  assertCookieValue(value);
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path}`);
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${capSameSite(options.sameSite)}`);
  if (options.partitioned === true) parts.push('Partitioned');
  return parts.join('; ');
}

/**
 * Parse a `Cookie` request header into a null-prototype record (so `__proto__` cannot
 * pollute the result). First occurrence of a duplicate name wins.
 */
export function parseCookieHeader(header: string | null | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (typeof header !== 'string' || header.length === 0) return Object.freeze(out);
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 1) continue;
    const name = segment.slice(0, eq).trim();
    if (!COOKIE_NAME_RE.test(name)) continue;
    const raw = segment.slice(eq + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep the raw value */ }
    if (!(name in out)) out[name] = value;
  }
  return Object.freeze(out);
}

export interface CookieSetOptions {
  readonly path?: string;
  readonly domain?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: SameSiteValue | 'Strict' | 'Lax' | 'None';
  readonly partitioned?: boolean;
}
export interface CookieDeleteOptions {
  readonly path?: string;
  readonly domain?: string;
}

/**
 * Framework-agnostic cookie jar. SvelteKit's `event.cookies` (get/set/delete) satisfies
 * this interface, as does a small adapter over raw request/response headers.
 */
export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, options: CookieSetOptions): void;
  delete(name: string, options: CookieDeleteOptions): void;
}

export interface SessionCookieTransportOptions<Data extends Record<string, unknown>> {
  readonly cookies: CookieJar;
  readonly manager: SessionManager<Data>;
  readonly cookie?: SessionCookieConfig;
  readonly now?: () => number;
}

/**
 * Binds a {@link SessionManager} to a {@link CookieJar}. Reads resolve through the manager
 * (so expiry and tampering are enforced), rotations rewrite the cookie with the new id,
 * and stale/invalid cookies are cleared rather than causing a 500.
 */
export class SessionCookieTransport<Data extends Record<string, unknown> = Record<string, unknown>> {
  readonly #cookies: CookieJar;
  readonly #manager: SessionManager<Data>;
  readonly #options: SessionCookieOptions;
  readonly #now: () => number;

  constructor(options: SessionCookieTransportOptions<Data>) {
    const jar = options?.cookies;
    if (!jar || typeof jar.get !== 'function' || typeof jar.set !== 'function' || typeof jar.delete !== 'function') {
      throw new SessionCookieError('A complete CookieJar (get/set/delete) is required.');
    }
    const manager = options.manager;
    if (!manager || typeof manager.get !== 'function' || typeof manager.create !== 'function' || typeof manager.destroy !== 'function' || typeof manager.rotate !== 'function') {
      throw new SessionCookieError('A SessionManager is required.');
    }
    const now = options.now ?? Date.now;
    if (typeof now !== 'function') throw new SessionCookieError('now must be a function.');
    this.#cookies = jar;
    this.#manager = manager;
    this.#options = resolveSessionCookieOptions(options.cookie ?? {});
    this.#now = now;
  }

  get cookieOptions(): SessionCookieOptions { return this.#options; }
  get cookieName(): string { return this.#options.name; }

  /** The Set-Cookie value that {@link create} / {@link rotate} would emit for a handle. */
  serialize(handle: SessionHandle<Data>): string {
    return serializeSetCookie(this.#options.name, handle.id, this.#writeOptions(handle));
  }

  async read(): Promise<SessionHandle<Data> | undefined> {
    const id = this.#cookies.get(this.#options.name);
    if (!id || !SESSION_ID_RE.test(id)) { if (id) this.clear(); return undefined; }
    const handle = await this.#manager.get(id);
    if (!handle) { this.clear(); return undefined; }
    return handle;
  }

  async create(initialData = {} as Data): Promise<SessionHandle<Data>> {
    const handle = await this.#manager.create(initialData);
    this.write(handle);
    return handle;
  }

  write(handle: SessionHandle<Data>): void {
    if (handle.expiresAt <= this.#now()) { this.clear(); return; }
    this.#cookies.set(this.#options.name, handle.id, this.#writeOptions(handle));
  }

  clear(): void {
    this.#cookies.delete(this.#options.name, {
      path: this.#options.path,
      ...(this.#options.domain !== undefined ? { domain: this.#options.domain } : {}),
    });
  }

  /** Rotate on privilege change (session-fixation defence) and rewrite the cookie. */
  async rotate(): Promise<SessionHandle<Data> | undefined> {
    const id = this.#cookies.get(this.#options.name);
    if (!id || !SESSION_ID_RE.test(id)) { if (id) this.clear(); return undefined; }
    const next = await this.#manager.rotate(id);
    if (!next) { this.clear(); return undefined; }
    this.write(next);
    return next;
  }

  async destroy(): Promise<void> {
    const id = this.#cookies.get(this.#options.name);
    if (id && SESSION_ID_RE.test(id)) await this.#manager.destroy(id);
    this.clear();
  }

  #writeOptions(handle: SessionHandle<Data>): SessionCookieOptions {
    const remainingMs = handle.expiresAt - this.#now();
    const maxAge = Math.max(0, Math.floor(remainingMs / 1000));
    return Object.freeze({
      name: this.#options.name,
      secure: this.#options.secure,
      httpOnly: this.#options.httpOnly,
      sameSite: this.#options.sameSite,
      path: this.#options.path,
      maxAge,
      ...(this.#options.domain !== undefined ? { domain: this.#options.domain } : {}),
      ...(this.#options.partitioned !== undefined ? { partitioned: this.#options.partitioned } : {}),
    });
  }
}
