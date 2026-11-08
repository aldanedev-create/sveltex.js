import { randomUUID } from 'node:crypto';
import type { CredentialUserStore } from '@sveltex/auth';
import type { Database } from '@sveltex/database';
import type { AppUser, PublicUser } from './types.js';

type UserRow = {
  id: unknown; email: unknown; display_name: unknown; roles: unknown;
  password_hash: unknown; created_at: unknown;
};

const SELECT_COLUMNS = 'id, email, display_name, roles, password_hash, created_at';

function parseRoles(raw: unknown): readonly string[] {
  if (typeof raw !== 'string') return ['user'];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(r => typeof r === 'string')) return parsed as string[];
  } catch { /* fall through */ }
  return ['user'];
}

function toAppUser(row: UserRow): AppUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    roles: parseRoles(row.roles),
    passwordHash: String(row.password_hash),
    createdAt: Number(row.created_at),
  };
}

function toPublicUser(row: UserRow): PublicUser {
  const user = toAppUser(row);
  return Object.freeze({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    createdAt: user.createdAt,
  });
}

/**
 * A real `CredentialUserStore` backed by `@sveltex/database` (SQLite).
 * Email uniqueness is enforced atomically by a UNIQUE constraint plus
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` — no check-then-insert race.
 */
export class SqliteUserStore implements CredentialUserStore<AppUser> {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async findByEmail(normalizedEmail: string): Promise<AppUser | undefined> {
    const result = await this.#db.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users WHERE email = ?`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    return row ? toAppUser(row) : undefined;
  }

  async findById(id: string): Promise<PublicUser | undefined> {
    const result = await this.#db.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users WHERE id = ?`,
      [id],
    );
    const row = result.rows[0];
    return row ? toPublicUser(row) : undefined;
  }

  async createIfAbsent(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<AppUser | undefined> {
    const meta = input.metadata ?? {};
    const displayName = typeof meta['displayName'] === 'string' && meta['displayName'].length > 0
      ? meta['displayName']
      : 'Anonymous';
    const roles = Array.isArray(meta['roles']) && meta['roles'].every(r => typeof r === 'string')
      ? (meta['roles'] as string[])
      : ['user'];
    const id = randomUUID();
    const createdAt = Date.now();

    const result = await this.#db.query<UserRow>(
      `INSERT INTO users (id, email, display_name, roles, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [id, input.email, displayName, JSON.stringify(roles), input.passwordHash, createdAt],
    );
    const row = result.rows[0];
    return row ? toAppUser(row) : undefined;
  }

  /** List all users (used by the admin-only endpoint to demonstrate authorization). */
  async list(): Promise<readonly PublicUser[]> {
    const result = await this.#db.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users ORDER BY created_at ASC`,
    );
    return Object.freeze(result.rows.map(toPublicUser));
  }

  /** Grant a role inside a transaction (privilege change → rotate the session afterwards). */
  async grantRole(id: string, role: string): Promise<readonly string[] | undefined> {
    return this.#db.transaction(async (tx) => {
      const found = await tx.query<UserRow>('SELECT roles FROM users WHERE id = ?', [id]);
      const row = found.rows[0];
      if (!row) return undefined;
      const roles = parseRoles(row.roles);
      if (roles.includes(role)) return roles;
      const next = Object.freeze([...roles, role]);
      await tx.query('UPDATE users SET roles = ? WHERE id = ?', [JSON.stringify(next), id]);
      return next;
    });
  }
}
