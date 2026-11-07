import { AuthService, type AuthUser, type CredentialUserStore, type PasswordHasher } from '../../dist/index.js';
interface User extends AuthUser { readonly displayName: string; }
declare const users: CredentialUserStore<User>; declare const hasher: PasswordHasher;
declare const sessions: { create(data: { readonly userId: string }): Promise<{ readonly id: string }>; destroy(id: string): Promise<void>; rotate(id: string): Promise<{ readonly id: string } | undefined> };
const auth = new AuthService<User, { readonly id: string }>(users, hasher, sessions, { dummyPasswordHash: 'argon2id$precomputed-hash' });
const login: ReturnType<typeof auth.login> = auth.login('person@example.com', 'password');
void login;
