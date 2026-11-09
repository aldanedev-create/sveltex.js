import {
  FixedWindowLimiter,
  TokenManager,
  MemoryTokenStore,
  generateSecureToken,
  RbacBuilder,
  createRbac,
  PasswordResetService,
  EmailVerificationService,
  AuthForbiddenError,
  AuthUnauthorizedError,
  AuthTokenExpiredError,
  AuthTokenUsedError,
  AuthTokenInvalidError,
} from '../../dist/index.js';
import type {
  AuthUser,
  PasswordHasher,
  AuthAttemptLimiter,
  TokenStore,
} from '../../dist/index.js';

interface AppUser extends AuthUser {
  readonly displayName: string;
}

interface ResetStore {
  findByEmail(email: string): Promise<(AppUser & { passwordHash: string }) | undefined>;
  findById(id: string): Promise<AppUser | undefined>;
  updatePassword(id: string, hash: string): Promise<boolean>;
}

interface VerifyStore {
  findById(id: string): Promise<AppUser | undefined>;
  markVerified(id: string): Promise<boolean>;
}

declare const hasher: PasswordHasher;
declare const resetStore: ResetStore;
declare const verifyStore: VerifyStore;

// RBAC: deny-by-default, inheritance, and typed requirePermission.
const rbac = createRbac({
  user: { permissions: ['profile:read'] },
  admin: { inherits: ['user'], permissions: ['users:read'] },
});
const canRead: boolean = rbac.can('admin', 'users:read');
rbac.requirePermission(['admin'], 'users:read');
void canRead;
void new RbacBuilder();

// Limiter satisfies the AuthAttemptLimiter port.
const limiter: AuthAttemptLimiter = new FixedWindowLimiter({ max: 5, windowMs: 1000 });
const allowed: Promise<boolean> = limiter.consume('key');
void allowed;

// Tokens: store port, manager, secure generation.
const tokenStore: TokenStore = new MemoryTokenStore();
const tokens = new TokenManager(tokenStore);
const issueResult: ReturnType<typeof tokens.issue> = tokens.issue('purpose', 'user-1', 1000);
const subject: Promise<string> = tokens.consume('token', 'purpose');
void issueResult;
void subject;
void generateSecureToken();

// Password reset workflow, generic over the user type.
const reset = new PasswordResetService<AppUser>(resetStore, hasher, tokens);
const completed: Promise<AppUser> = reset.completeReset('token', 'new-password-123');
void completed;

// Email verification workflow, generic over the user type.
const verification = new EmailVerificationService<AppUser>(verifyStore, tokens);
const verifiedId: Promise<string> = verification.verify('token');
void verifiedId;

// Error hierarchy is exported and constructible.
void new AuthForbiddenError('p', ['user']);
void new AuthUnauthorizedError();
void new AuthTokenExpiredError();
void new AuthTokenUsedError();
void new AuthTokenInvalidError();
