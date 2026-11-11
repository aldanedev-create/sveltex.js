import { cloneData, deepFreeze } from '@sveltex/shared';

export interface SessionRecord<Data extends Record<string, unknown> = Record<string, unknown>> { readonly id: string; readonly data: Readonly<Data>; readonly createdAt: number; readonly expiresAt: number; readonly revision: number; }
export interface SessionStore<Data extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<SessionRecord<Data> | undefined>;
  /** Must atomically insert only when the identifier does not already exist. */
  createIfAbsent(record: SessionRecord<Data>): Promise<boolean>;
  /** Atomically replaces the record only when its current revision matches. */
  compareAndSet(id: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean>;
  delete(id: string): Promise<void>;
  /** Must atomically replace oldId with record, returning false if oldId is absent. */
  rotate(oldId: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean>;
}
export interface SessionManagerOptions { readonly ttlMs?: number; readonly now?: () => number; readonly createId?: () => string; readonly maxCreateAttempts?: number; }
export interface SessionHandle<Data extends Record<string, unknown>> extends SessionRecord<Data> {}

/**
 * Optional store capability: revoke every session belonging to a user at once
 * (logout-all-devices, password reset, account compromise). Returns the number removed.
 * Memory, Redis and the SQL database stores all implement it.
 */
export interface RevocableSessionStore<Data extends Record<string, unknown> = Record<string, unknown>> extends SessionStore<Data> {
  revokeAllForUser(userId: string): Promise<number>;
}

export class SessionRevocationUnsupportedError extends Error {
  readonly code = 'SESSION_REVOCATION_UNSUPPORTED';
  constructor(message = 'The configured session store does not support per-user revocation.') {
    super(message);
    this.name = 'SessionRevocationUnsupportedError';
  }
}

/** In-memory store for tests and single-process development. Use a transactional shared store in production. */
export class MemorySessionStore<Data extends Record<string, unknown> = Record<string, unknown>> implements SessionStore<Data> {
  readonly #records = new Map<string, SessionRecord<Data>>();
  async get(id: string): Promise<SessionRecord<Data> | undefined> { const record = this.#records.get(id); return record ? cloneRecord(record) : undefined; }
  async createIfAbsent(record: SessionRecord<Data>): Promise<boolean> { if (this.#records.has(record.id)) return false; this.#records.set(record.id, cloneRecord(record)); return true; }
  async compareAndSet(id: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean> { const current = this.#records.get(id); if (!current || current.revision !== expectedRevision || record.id !== id) return false; this.#records.set(id, cloneRecord(record)); return true; }
  async delete(id: string): Promise<void> { this.#records.delete(id); }
  async rotate(oldId: string, expectedRevision: number, record: SessionRecord<Data>): Promise<boolean> {
    const current = this.#records.get(oldId);
    if (!current || current.revision !== expectedRevision || this.#records.has(record.id)) return false;
    this.#records.set(record.id, cloneRecord(record)); this.#records.delete(oldId); return true;
  }
  async revokeAllForUser(userId: string): Promise<number> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) throw new TypeError('A valid userId is required.');
    let removed = 0;
    for (const [id, record] of this.#records) {
      if ((record.data as Record<string, unknown>)['userId'] === userId) { this.#records.delete(id); removed += 1; }
    }
    return removed;
  }
  async size(): Promise<number> { return this.#records.size; }
}

/** Storage-agnostic session lifecycle. Cookie transport, signing and CSRF remain adapter responsibilities. */
export class SessionManager<Data extends Record<string, unknown> = Record<string, unknown>> {
  readonly #store: SessionStore<Data>; readonly #ttlMs: number; readonly #now: () => number; readonly #createId: () => string; readonly #maxCreateAttempts: number;
  constructor(store: SessionStore<Data>, options: SessionManagerOptions = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.createIfAbsent !== 'function' || typeof store.compareAndSet !== 'function' || typeof store.delete !== 'function' || typeof store.rotate !== 'function') throw new TypeError('A complete atomic session store is required.');
    this.#store = store; this.#ttlMs = options.ttlMs ?? 1000 * 60 * 60 * 24 * 7; this.#now = options.now ?? Date.now; this.#createId = options.createId ?? secureId; this.#maxCreateAttempts = options.maxCreateAttempts ?? 8;
    if (typeof this.#now !== 'function' || typeof this.#createId !== 'function') throw new TypeError('Session clock and identifier generator must be functions.');
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) throw new RangeError('ttlMs must be a positive finite number.');
    if (!Number.isSafeInteger(this.#maxCreateAttempts) || this.#maxCreateAttempts < 1 || this.#maxCreateAttempts > 100) throw new RangeError('maxCreateAttempts must be an integer from 1 to 100.');
    this.#timestamp();
  }
  async create(initialData = {} as Data): Promise<SessionHandle<Data>> {
    const data = freezeData(initialData); const now = this.#timestamp();
    for (let attempt = 0; attempt < this.#maxCreateAttempts; attempt += 1) {
      const id = this.#newId(); const record = makeRecord(id, data, now, now + this.#ttlMs, 1);
      if (await this.#store.createIfAbsent(record)) return toHandle(record);
    }
    throw new Error(`Unable to create a unique session identifier after ${this.#maxCreateAttempts} attempts.`);
  }
  async get(id: string): Promise<SessionHandle<Data> | undefined> {
    validateId(id); const record = await this.#store.get(id); if (!record) return undefined;
    if (!isValidRecord(record, id)) { await this.#store.delete(id); return undefined; }
    if (record.expiresAt <= this.#timestamp()) { await this.#store.delete(id); return undefined; }
    return toHandle(record);
  }
  async update(id: string, update: (current: Readonly<Data>) => Data): Promise<SessionHandle<Data> | undefined> {
    const current = await this.get(id); if (!current) return undefined;
    const draft = cloneData(current.data) as Data;
    const nextData = freezeData(update(draft));
    const now = this.#timestamp(); const record = makeRecord(id, nextData, current.createdAt, now + this.#ttlMs, current.revision + 1);
    if (!(await this.#store.compareAndSet(id, current.revision, record))) throw new SessionConflictError('The session changed during the update; reload it and retry.');
    return toHandle(record);
  }
  async rotate(id: string): Promise<SessionHandle<Data> | undefined> {
    const current = await this.get(id); if (!current) return undefined;
    for (let attempt = 0; attempt < this.#maxCreateAttempts; attempt += 1) {
      const nextId = this.#newId(); const now = this.#timestamp();
      const record = makeRecord(nextId, current.data, current.createdAt, now + this.#ttlMs, current.revision + 1);
      if (await this.#store.rotate(id, current.revision, record)) return toHandle(record);
      const latest = await this.#store.get(id);
      if (!latest) return undefined;
      if (latest.revision !== current.revision) throw new SessionConflictError('The session changed during rotation; reload it and retry.');
    }
    throw new Error('Unable to rotate the session identifier without a collision.');
  }
  async destroy(id: string): Promise<void> { validateId(id); await this.#store.delete(id); }
  /** Revoke every session for a user. Throws when the store has no revocation capability. */
  async revokeAllForUser(userId: string): Promise<number> {
    if (!isRevocable(this.#store)) throw new SessionRevocationUnsupportedError();
    return this.#store.revokeAllForUser(userId);
  }
  async touch(id: string): Promise<SessionHandle<Data> | undefined> {
    const current = await this.get(id); if (!current) return undefined;
    const now = this.#timestamp(); const record = makeRecord(id, current.data, current.createdAt, now + this.#ttlMs, current.revision + 1);
    if (!(await this.#store.compareAndSet(id, current.revision, record))) throw new SessionConflictError('The session changed while it was being refreshed; retry the operation.');
    return toHandle(record);
  }
  #timestamp(): number { const now = this.#now(); if (!Number.isFinite(now) || now < 0) throw new RangeError('The session clock must return a finite non-negative timestamp.'); return now; }
  #newId(): string { const id = this.#createId(); validateId(id); return id; }
}
function secureId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('A cryptographically secure randomUUID implementation is required; provide createId explicitly for this runtime.');
  return globalThis.crypto.randomUUID();
}
function validateId(id: string): void { if (typeof id !== 'string' || id.length < 16 || id.length > 256 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new TypeError('Session identifiers must be 16–256 URL-safe characters.'); }
function isRevocable<Data extends Record<string, unknown>>(store: SessionStore<Data>): store is RevocableSessionStore<Data> { return typeof (store as Partial<RevocableSessionStore<Data>>).revokeAllForUser === 'function'; }
function freezeData<T extends Record<string, unknown>>(data: T): Readonly<T> { if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Session data must be a plain object.'); return deepFreeze(cloneData(data)); }
function makeRecord<T extends Record<string, unknown>>(id: string, data: Readonly<T>, createdAt: number, expiresAt: number, revision: number): SessionRecord<T> { if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) throw new RangeError('Session expiration must be finite and later than creation.'); if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('Session revision must be a positive safe integer.'); return Object.freeze({ id, data, createdAt, expiresAt, revision }); }
function cloneRecord<T extends Record<string, unknown>>(record: SessionRecord<T>): SessionRecord<T> { return makeRecord(record.id, freezeData(record.data as T), record.createdAt, record.expiresAt, record.revision); }
function isValidRecord<T extends Record<string, unknown>>(record: SessionRecord<T>, id: string): boolean { return record.id === id && Number.isFinite(record.createdAt) && Number.isFinite(record.expiresAt) && record.expiresAt > record.createdAt && Number.isSafeInteger(record.revision) && record.revision > 0 && !!record.data && typeof record.data === 'object'; }
function toHandle<T extends Record<string, unknown>>(record: SessionRecord<T>): SessionHandle<T> { return Object.freeze({ ...record }); }
export class SessionConflictError extends Error { constructor(message: string) { super(message); this.name = 'SessionConflictError'; } }
