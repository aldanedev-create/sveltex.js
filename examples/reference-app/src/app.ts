import { randomUUID } from 'node:crypto';
import { AuthService } from '@sveltex/auth';
import type { AuthSessionPort } from '@sveltex/auth';
import { Argon2Hasher, generateDummyHash } from '@sveltex/auth/argon2';
import { Database } from '@sveltex/database';
import { SqliteAdapter } from '@sveltex/database/sqlite';
import { MemoryCache } from '@sveltex/cache';
import type { CacheStore } from '@sveltex/cache';
import { RedisCache } from '@sveltex/cache/redis';
import { SessionManager, MemorySessionStore } from '@sveltex/session';
import type { SessionHandle, SessionStore } from '@sveltex/session';
import { RedisSessionStore } from '@sveltex/session/redis';
import { validate } from '@sveltex/validation';
import { registerSchema, postSchema } from './schemas.js';
import { SqliteUserStore } from './user-store.js';
import { AuthenticationError, AuthorizationError } from './types.js';
import type { AppSessionData, AppUser, Post, PublicUser } from './types.js';

/**
 * A login token handed back to callers. It is deliberately opaque: the only
 * thing a client may do with it is pass `id` back to authenticated methods.
 */
export interface SessionToken {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: number;
}

export interface AppOptions {
  /** SQLite path. Defaults to `:memory:` (single-process, ephemeral). */
  readonly databasePath?: string;
  /**
   * When set, the app uses the real Redis adapters for BOTH sessions and the
   * cache (`RedisSessionStore` + `RedisCache`). Omit it for the in-process
   * `MemorySessionStore` + `MemoryCache` pair. No fake provider is substituted.
   */
  readonly redisUrl?: string;
  /** Redis key namespace. Strongly recommended on shared instances. */
  readonly redisKeyPrefix?: string;
  /**
   * Trusted bootstrap emails that receive the `admin` role at registration.
   * Roles are never accepted from user input; this is the only grant path.
   */
  readonly adminEmails?: readonly string[];
  readonly sessionTtlMs?: number;
  readonly cacheTtlMs?: number;
  /** Shared clock for the cache, session manager and Redis TTL derivation. */
  readonly now?: () => number;
}

interface StoreBundle {
  readonly sessionStore: SessionStore<AppSessionData>;
  readonly cache: CacheStore;
  readonly disposeStores: () => Promise<void>;
}

interface AppContext {
  readonly db: Database;
  readonly users: SqliteUserStore;
  readonly sessions: SessionManager<AppSessionData>;
  readonly auth: AuthService<AppUser, SessionToken>;
  readonly cache: CacheStore;
  readonly adminEmails: ReadonlySet<string>;
  readonly cacheTtlMs: number;
  readonly now: () => number;
  readonly disposeStores: () => Promise<void>;
}

const DDL_USERS = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  roles TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

const DDL_POSTS = `CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

const POSTS_KEY = 'posts:list';
const ASSIGNABLE_ROLES: readonly string[] = Object.freeze(['admin', 'editor']);
const SESSION_ID = /^[A-Za-z0-9_-]{16,256}$/;

type PostRow = {
  id: unknown; author_id: unknown; title: unknown; body: unknown; created_at: unknown;
};

function publicFromUser(user: {
  readonly id: string; readonly email: string; readonly displayName: string;
  readonly roles: readonly string[]; readonly createdAt: number;
}): PublicUser {
  return Object.freeze({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: Object.freeze([...user.roles]),
    createdAt: user.createdAt,
  });
}

function toPost(row: PostRow): Post {
  return Object.freeze({
    id: String(row.id),
    authorId: String(row.author_id),
    title: String(row.title),
    body: String(row.body),
    createdAt: Number(row.created_at),
  });
}

function toToken(handle: SessionHandle<AppSessionData>): SessionToken {
  return Object.freeze({
    id: handle.id,
    userId: handle.data.userId,
    expiresAt: handle.expiresAt,
  });
}

function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) {
    throw new AuthenticationError('A valid session identifier is required.');
  }
}

/** Bridges `AuthSessionPort` onto the real `SessionManager` lifecycle. */
function makeSessionPort(sessions: SessionManager<AppSessionData>): AuthSessionPort<SessionToken> {
  return Object.freeze({
    async create(data: { readonly userId: string }): Promise<SessionToken> {
      return toToken(await sessions.create({ userId: data.userId }));
    },
    async destroy(id: string): Promise<void> {
      await sessions.destroy(id);
    },
    async rotate(id: string): Promise<SessionToken | undefined> {
      const next = await sessions.rotate(id);
      return next ? toToken(next) : undefined;
    },
  });
}

async function createStores(
  options: AppOptions,
  now: () => number,
  cacheTtlMs: number,
): Promise<StoreBundle> {
  const redisUrl = options.redisUrl;
  if (redisUrl === undefined) {
    return {
      sessionStore: new MemorySessionStore<AppSessionData>(),
      cache: new MemoryCache({ defaultTtlMs: cacheTtlMs, now }),
      disposeStores: async () => undefined,
    };
  }

  const prefix = options.redisKeyPrefix ?? 'sveltex-ref:';
  const sessionRedis = new RedisSessionStore<AppSessionData>({
    url: redisUrl,
    keyPrefix: `${prefix}sess:`,
    now,
  });
  const cacheRedis = new RedisCache({
    url: redisUrl,
    keyPrefix: `${prefix}cache:`,
    defaultTtlMs: cacheTtlMs,
  });

  await sessionRedis.connect();
  try {
    await cacheRedis.connect();
  } catch (cause) {
    await sessionRedis.disconnect();
    throw cause;
  }

  return {
    sessionStore: sessionRedis,
    cache: cacheRedis,
    disposeStores: async () => {
      await sessionRedis.disconnect();
      await cacheRedis.disconnect();
    },
  };
}

/**
 * Stage 3 reference application.
 *
 * Wires real `@sveltex/*` packages end-to-end:
 * - persistence: `@sveltex/database` (`SqliteAdapter` via `node:sqlite`)
 * - validation:  `@sveltex/validation` (hand-written Standard Schema v1)
 * - authn:       `@sveltex/auth` (`Argon2Hasher`) + atomic session rotation
 * - sessions:    `@sveltex/session` (memory or Redis/Lua store)
 * - caching:     `@sveltex/cache` (memory or Redis) with cache-aside + invalidation
 * - authz:       role checks against the FRESH database record, never a cached
 *                or client-supplied value
 *
 * @public
 */
export class ReferenceApp {
  readonly #ctx: AppContext;
  #closed = false;

  /** @internal Prefer the `createApp` factory so resources are wired correctly. */
  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** @internal Read-only handles for integration tests and diagnostics. */
  get database(): Database { return this.#ctx.db; }
  /** @internal */
  get sessionManager(): SessionManager<AppSessionData> { return this.#ctx.sessions; }
  /** @internal */
  get cache(): CacheStore { return this.#ctx.cache; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#ctx.db.close();
    await this.#ctx.disposeStores();
  }

  /** Validate input, hash with Argon2id, persist atomically. Roles come only from trusted bootstrap config. */
  async register(payload: unknown): Promise<PublicUser> {
    const input = await validate(registerSchema, payload);
    const metadata: Record<string, unknown> = { displayName: input.displayName };
    if (this.#ctx.adminEmails.has(input.email)) metadata['roles'] = ['user', 'admin'];
    const user = await this.#ctx.auth.register({
      email: input.email,
      password: input.password,
      metadata,
    });
    return publicFromUser(user);
  }

  async login(email: string, password: string): Promise<SessionToken> {
    const result = await this.#ctx.auth.login(email, password);
    if (!result) throw new AuthenticationError('Invalid email or password.');
    return result.session;
  }

  async logout(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.#ctx.auth.logout(sessionId);
  }

  /** Demonstrate atomic session-ID rotation (fixation defence). */
  async rotateSession(sessionId: string): Promise<SessionToken | undefined> {
    assertSessionId(sessionId);
    return this.#ctx.auth.rotateSession(sessionId);
  }

  async currentUser(sessionId: string): Promise<PublicUser> {
    return this.#principal(sessionId);
  }

  /** Cache-aside public profile read. Never used for authorization decisions. */
  async getPublicProfile(id: string): Promise<PublicUser | undefined> {
    const key = `user:${id}`;
    const cached = await this.#ctx.cache.get<PublicUser>(key);
    if (cached !== undefined) return cached;
    const user = await this.#ctx.users.findById(id);
    if (user) await this.#ctx.cache.set(key, user, { ttlMs: this.#ctx.cacheTtlMs });
    return user;
  }

  /** Authenticated + validated write; authorId is taken from the session, never the payload. */
  async createPost(sessionId: string, payload: unknown): Promise<Post> {
    const user = await this.#principal(sessionId);
    const input = await validate(postSchema, payload);
    const post: Post = Object.freeze({
      id: randomUUID(),
      authorId: user.id,
      title: input.title,
      body: input.body,
      createdAt: this.#ctx.now(),
    });
    await this.#ctx.db.query(
      'INSERT INTO posts (id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
      [post.id, post.authorId, post.title, post.body, post.createdAt],
    );
    await this.#ctx.cache.delete(POSTS_KEY);
    return post;
  }

  /** Cached read; invalidated on every write. */
  async listPosts(): Promise<readonly Post[]> {
    const cached = await this.#ctx.cache.get<readonly Post[]>(POSTS_KEY);
    if (cached !== undefined) return Object.freeze([...cached]);
    const result = await this.#ctx.db.query<PostRow>(
      'SELECT id, author_id, title, body, created_at FROM posts ORDER BY created_at ASC',
    );
    const posts = Object.freeze(result.rows.map(toPost));
    await this.#ctx.cache.set(POSTS_KEY, posts, { ttlMs: this.#ctx.cacheTtlMs });
    return posts;
  }

  /** Admin-only endpoint: demonstrates role-based authorization. */
  async listUsers(sessionId: string): Promise<readonly PublicUser[]> {
    await this.#requireRole(sessionId, 'admin');
    return this.#ctx.users.list();
  }

  /** Admin-only privilege change in a transaction, followed by cache invalidation. */
  async grantRole(sessionId: string, targetUserId: string, role: string): Promise<readonly string[]> {
    await this.#requireRole(sessionId, 'admin');
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new AuthorizationError(`The role '${role}' is not assignable.`);
    }
    const roles = await this.#ctx.users.grantRole(targetUserId, role);
    if (!roles) throw new AuthorizationError('The target account does not exist.');
    await this.#ctx.cache.delete(`user:${targetUserId}`);
    return roles;
  }

  /** Resolve the principal from a live session + the FRESH user record. */
  async #principal(sessionId: string): Promise<PublicUser> {
    assertSessionId(sessionId);
    const handle = await this.#ctx.sessions.get(sessionId);
    if (!handle) throw new AuthenticationError('Session is missing or expired.');
    const user = await this.#ctx.users.findById(handle.data.userId);
    if (!user) throw new AuthenticationError('The session references an unknown account.');
    return user;
  }

  async #requireRole(sessionId: string, role: string): Promise<PublicUser> {
    const user = await this.#principal(sessionId);
    if (!user.roles.includes(role)) {
      throw new AuthorizationError(`The '${role}' role is required.`);
    }
    return user;
  }
}

/** Build and fully connect a reference application. Always `close()` it afterwards. */
export async function createApp(options: AppOptions = {}): Promise<ReferenceApp> {
  const now = options.now ?? Date.now;
  const databasePath = options.databasePath ?? ':memory:';
  const sessionTtlMs = options.sessionTtlMs ?? 1000 * 60 * 60 * 24;
  const cacheTtlMs = options.cacheTtlMs ?? 1000 * 60;
  const adminEmails: ReadonlySet<string> = new Set(
    (options.adminEmails ?? []).map(email => email.trim().toLowerCase()),
  );

  const stores = await createStores(options, now, cacheTtlMs);
  const db = new Database(new SqliteAdapter({ path: databasePath }));

  try {
    await db.connect();
    await db.query(DDL_USERS);
    await db.query(DDL_POSTS);

    const users = new SqliteUserStore(db);
    const sessions = new SessionManager<AppSessionData>(stores.sessionStore, {
      ttlMs: sessionTtlMs,
      now,
    });
    const auth = new AuthService<AppUser, SessionToken>(
      users,
      new Argon2Hasher(),
      makeSessionPort(sessions),
      { dummyPasswordHash: await generateDummyHash() },
    );

    return new ReferenceApp({
      db,
      users,
      sessions,
      auth,
      cache: stores.cache,
      adminEmails,
      cacheTtlMs,
      now,
      disposeStores: stores.disposeStores,
    });
  } catch (cause) {
    await stores.disposeStores();
    await db.close().catch(() => undefined);
    throw cause;
  }
}
