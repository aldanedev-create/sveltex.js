import type { SessionManager } from '@sveltex/session';
import {
  createApp,
  ReferenceApp,
  registerSchema,
  SqliteUserStore,
  AuthenticationError,
  AuthorizationError,
} from '../../dist/index.js';
import type {
  AppOptions,
  SessionToken,
  PublicUser,
  Post,
  AppSessionData,
  AppUser,
  RegisterInput,
  PostInput,
} from '../../dist/index.js';

const options: AppOptions = {
  databasePath: ':memory:',
  adminEmails: ['boss@example.com'],
  sessionTtlMs: 60_000,
  cacheTtlMs: 30_000,
  now: () => 1_000,
};

const input: RegisterInput = {
  email: 'a@b.com',
  password: 'p'.repeat(12),
  displayName: 'A',
};
const postInput: PostInput = { title: 'T', body: 'B' };

// Confirms `AppSessionData` satisfies the `Record<string, unknown>` constraint.
function takesManager(manager: SessionManager<AppSessionData>): void {
  void manager;
}

async function scenario(): Promise<void> {
  const created: Promise<ReferenceApp> = createApp(options);
  const app: ReferenceApp = await created;
  takesManager(app.sessionManager);

  const user: PublicUser = await app.register(input);
  const token: SessionToken = await app.login('a@b.com', 'p'.repeat(12));
  const me: PublicUser = await app.currentUser(token.id);
  const post: Post = await app.createPost(token.id, postInput);
  const posts: readonly Post[] = await app.listPosts();
  const users: readonly PublicUser[] = await app.listUsers(token.id);
  const roles: readonly string[] = await app.grantRole(token.id, user.id, 'editor');
  const profile: PublicUser | undefined = await app.getPublicProfile(user.id);
  const rotated: SessionToken | undefined = await app.rotateSession(token.id);
  await app.logout(token.id);
  await app.close();
  void [me, post, posts, users, roles, profile, rotated];
}

const authn: AuthenticationError = new AuthenticationError('no');
const authz: AuthorizationError = new AuthorizationError('no');
const asError: Error = authn;
const appUser: AppUser = {
  id: 'x',
  email: 'a@b.com',
  displayName: 'A',
  roles: ['user'],
  createdAt: 1,
  passwordHash: '$argon2id$v=19$stub',
};

void [scenario, asError, authz, appUser, registerSchema, SqliteUserStore, ReferenceApp];
