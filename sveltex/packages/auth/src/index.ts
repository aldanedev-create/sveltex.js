import { cloneData, deepFreeze } from '@sveltexjs/shared';
export interface AuthUser { readonly id: string; readonly email: string; readonly roles?: readonly string[]; readonly [key: string]: unknown; }
export interface CredentialUserStore<User extends AuthUser = AuthUser> {
  findByEmail(normalizedEmail: string): Promise<(User & { readonly passwordHash: string }) | undefined>;
  /** Must enforce email uniqueness atomically at the storage layer. */
  createIfAbsent(user: { readonly email: string; readonly passwordHash: string; readonly metadata?: Readonly<Record<string, unknown>> }): Promise<User | undefined>;
}
export interface PasswordHasher { hash(password: string): Promise<string>; verify(password: string, encodedHash: string): Promise<boolean>; }
export interface AuthSessionPort<Session = unknown> {
  create(data: { readonly userId: string }): Promise<Session>;
  destroy(id: string): Promise<void>;
  rotate?(id: string): Promise<Session | undefined>;
}
export interface AuthAttemptLimiter { consume(key: string): Promise<boolean>; }
export interface AuthServiceOptions { readonly minPasswordLength?: number; readonly maxPasswordLength?: number; readonly normalizeEmail?: (email: string) => string; readonly limiter?: AuthAttemptLimiter; readonly dummyPasswordHash: string; }
export interface AuthResult<User, Session> { readonly user: User; readonly session: Session; }

/** Credential authentication orchestration. Supply an audited Argon2id/scrypt/bcrypt hasher; no weak default is provided. */
export class AuthService<User extends AuthUser = AuthUser, Session = unknown> {
  readonly #users: CredentialUserStore<User>; readonly #hasher: PasswordHasher; readonly #sessions: AuthSessionPort<Session>;
  readonly #minPasswordLength: number; readonly #maxPasswordLength: number; readonly #normalizeEmail: (email: string) => string; readonly #limiter: AuthAttemptLimiter | undefined; readonly #dummyPasswordHash: string;
  constructor(users: CredentialUserStore<User>, hasher: PasswordHasher, sessions: AuthSessionPort<Session>, options: AuthServiceOptions) {
    if (!users || typeof users.findByEmail !== 'function' || typeof users.createIfAbsent !== 'function') throw new AuthConfigurationError('A valid credential user store is required.');
    if (!hasher || typeof hasher.hash !== 'function' || typeof hasher.verify !== 'function') throw new AuthConfigurationError('A password hasher with hash and verify methods is required.');
    if (!sessions || typeof sessions.create !== 'function' || typeof sessions.destroy !== 'function') throw new AuthConfigurationError('A session adapter with create and destroy methods is required.');
    this.#users = users; this.#hasher = hasher; this.#sessions = sessions;
    this.#minPasswordLength = options.minPasswordLength ?? 12; this.#maxPasswordLength = options.maxPasswordLength ?? 1024;
    if (!Number.isSafeInteger(this.#minPasswordLength) || this.#minPasswordLength < 1 || !Number.isSafeInteger(this.#maxPasswordLength) || this.#maxPasswordLength < this.#minPasswordLength || this.#maxPasswordLength > 4096) throw new RangeError('Password length limits are invalid.');
    this.#normalizeEmail = options.normalizeEmail ?? (email => email.trim().toLowerCase()); this.#limiter = options.limiter; this.#dummyPasswordHash = options.dummyPasswordHash;
    if (typeof this.#normalizeEmail !== 'function' || this.#limiter !== undefined && typeof this.#limiter.consume !== 'function') throw new AuthConfigurationError('Email normalization and attempt-limiter options must be callable.');
    if (typeof this.#dummyPasswordHash !== 'string' || this.#dummyPasswordHash.length < 20 || this.#dummyPasswordHash.length > 4096) throw new AuthConfigurationError('A valid dummy password hash is required.');
  }
  async register(input: { readonly email: string; readonly password: string; readonly metadata?: Readonly<Record<string, unknown>> }): Promise<User> {
    const email = this.#email(input.email); this.#assertPassword(input.password, true);
    const passwordHash = await this.#hasher.hash(input.password);
    if (typeof passwordHash !== 'string' || passwordHash.length < 20 || passwordHash.length > 4096) throw new AuthConfigurationError('Password hasher returned an invalid encoded hash.');
    const metadata = input.metadata === undefined ? undefined : deepFreeze(cloneData(input.metadata));
    const newUser = metadata === undefined ? { email, passwordHash } : { email, passwordHash, metadata };
    const user = await this.#users.createIfAbsent(newUser);
    if (!user) throw new AuthConflictError('An account with these credentials already exists.');
    return sanitizeUser(user);
  }
  async login(emailInput: string, password: string): Promise<AuthResult<User, Session> | undefined> {
    const email = this.#email(emailInput); this.#assertPassword(password, false);
    if (this.#limiter && !(await this.#limiter.consume(email))) return undefined;
    const user = await this.#users.findByEmail(email);
    // Verify a fixed dummy hash when the user is absent to reduce obvious timing-based enumeration.
    if (!user) { await this.#hasher.verify(password, this.#dummyPasswordHash); return undefined; }
    if (typeof user.passwordHash !== 'string' || user.passwordHash.length < 20 || user.passwordHash.length > 4096) { await this.#hasher.verify(password, this.#dummyPasswordHash); return undefined; }
    const valid = await this.#hasher.verify(password, user.passwordHash);
    if (!valid) return undefined;
    const session = await this.#sessions.create({ userId: user.id });
    return Object.freeze({ user: sanitizeUser(user), session });
  }
  async logout(sessionId: string): Promise<void> { if (typeof sessionId !== 'string' || sessionId.length < 16 || sessionId.length > 256) throw new TypeError('A valid session identifier is required.'); await this.#sessions.destroy(sessionId); }
  async rotateSession(sessionId: string): Promise<Session | undefined> {
    if (!this.#sessions.rotate) throw new AuthConfigurationError('The configured session adapter does not support atomic session rotation.');
    return this.#sessions.rotate(sessionId);
  }
  #email(email: string): string {
    if (typeof email !== 'string' || email.length > 320) throw new TypeError('Email must be a string no longer than 320 characters.');
    const normalized = this.#normalizeEmail(email);
    if (typeof normalized !== 'string' || normalized.length < 3 || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new TypeError('A valid email address is required.');
    return normalized;
  }
  #assertPassword(password: string, registration: boolean): void {
    if (typeof password !== 'string' || password.length > this.#maxPasswordLength || (registration && password.length < this.#minPasswordLength)) throw new TypeError(registration ? `Password must contain ${this.#minPasswordLength}–${this.#maxPasswordLength} characters.` : `Password must not exceed ${this.#maxPasswordLength} characters.`);
  }
}

export class AuthError extends Error { readonly code: string; constructor(message: string, code: string) { super(message); this.name = 'AuthError'; this.code = code; } }
export class AuthConflictError extends AuthError { constructor(message: string) { super(message, 'AUTH_CONFLICT'); this.name = 'AuthConflictError'; } }
export class AuthConfigurationError extends AuthError { constructor(message: string) { super(message, 'AUTH_CONFIGURATION'); this.name = 'AuthConfigurationError'; } }
function sanitizeUser<User extends AuthUser>(user: User & { readonly passwordHash?: string }): User { const { passwordHash: _hash, ...safe } = user; return deepFreeze({ ...safe }) as User; }
