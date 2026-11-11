import type { AuthSessionPort } from '@sveltex/auth';
import { Database } from '@sveltex/database';
import {
  MemorySessionStore,
  SessionManager,
  SessionRevocationUnsupportedError,
  type RevocableSessionStore,
  type SessionHandle,
  type SessionStore,
  type SessionRecord,
} from '../../dist/index.js';
import {
  resolveSessionCookieOptions,
  serializeSetCookie,
  parseCookieHeader,
  SessionCookieTransport,
  type CookieJar,
  type CookieSetOptions,
  type CookieDeleteOptions,
  type SessionCookieOptions,
  type SameSiteValue,
} from '../../dist/cookie.js';
import {
  CsrfProtection,
  constantTimeEqual,
  serializeCsrfCookie,
  type CsrfToken,
  type CsrfRequestLike,
} from '../../dist/csrf.js';
import {
  DatabaseSessionStore,
  type SessionSqlExecutor,
  type SessionSqlValue,
  type SessionDatabaseDialect,
  type DatabaseSessionStoreOptions,
} from '../../dist/database.js';
import {
  createAuthSessionPort,
  supportsRevocation,
  revokeAllForUser,
} from '../../dist/auth.js';

type Data = { userId: string; role?: string };

// --- Cookie API -------------------------------------------------------------
const options: SessionCookieOptions = resolveSessionCookieOptions({ sameSite: 'lax' });
const sameSite: SameSiteValue = options.sameSite;
const header: string = serializeSetCookie(options.name, 'session_cookie_000001', options);
const cookies: Readonly<Record<string, string>> = parseCookieHeader('a=1');
const jar: CookieJar = {
  get: (_name: string): string | undefined => undefined,
  set: (_name: string, _value: string, _options: CookieSetOptions): void => undefined,
  delete: (_name: string, _options: CookieDeleteOptions): void => undefined,
};
const manager = new SessionManager<Data>(new MemorySessionStore<Data>());
const transport: SessionCookieTransport<Data> = new SessionCookieTransport<Data>({ cookies: jar, manager });
const readResult: Promise<SessionHandle<Data> | undefined> = transport.read();
const serialized: string = transport.serialize({
  id: 'session_cookie_000001', data: { userId: 'u1' }, createdAt: 1, expiresAt: 2, revision: 1,
});

// --- CSRF API ---------------------------------------------------------------
const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
const issued: CsrfToken = csrf.issue('session-aaa');
const csrfHeader: string = serializeCsrfCookie(issued.value);
const equal: boolean = constantTimeEqual('a', 'a');
const request: CsrfRequestLike = { method: 'POST', headers: { cookie: csrfHeader } };
csrf.assertValidRequest(request);

// --- Database store API -----------------------------------------------------
declare const db: Database;
// Proves the real @sveltex/database facade satisfies our structural port.
const executor: SessionSqlExecutor = db;
const sqlValue: SessionSqlValue = 'value';
const dialect: SessionDatabaseDialect = 'postgres';
const storeOptions: DatabaseSessionStoreOptions = { dialect, tableName: 'sessions' };
const sqlStore: DatabaseSessionStore<Data> = new DatabaseSessionStore<Data>(executor, storeOptions);
const storeAsSessionStore: SessionStore<Data> = sqlStore;
const revocable: RevocableSessionStore<Data> = sqlStore;
const ddl: readonly string[] = sqlStore.schemaStatements();
const revoked: Promise<number> = sqlStore.revokeAllForUser('u1');
const record: SessionRecord<Data> = {
  id: 'session_cookie_000001', data: { userId: 'u1' }, createdAt: 1, expiresAt: 2, revision: 1,
};
const inserted: Promise<boolean> = sqlStore.createIfAbsent(record);

// --- Auth bridge API --------------------------------------------------------
const port = createAuthSessionPort<Data>(manager);
// Proves the bridge is assignable to the real @sveltex/auth session port.
const authPort: AuthSessionPort<SessionHandle<Data>> = port;
const created: Promise<SessionHandle<Data>> = authPort.create({ userId: 'u1' });
const supports: boolean = supportsRevocation(sqlStore);
const revocation: Promise<number> = revokeAllForUser(sqlStore, 'u1');
const unsupported: SessionRevocationUnsupportedError = new SessionRevocationUnsupportedError();

void sameSite;
void header;
void cookies;
void readResult;
void serialized;
void equal;
void csrfHeader;
void request;
void sqlValue;
void storeAsSessionStore;
void revocable;
void ddl;
void revoked;
void inserted;
void created;
void supports;
void revocation;
void unsupported;
void authPort;
