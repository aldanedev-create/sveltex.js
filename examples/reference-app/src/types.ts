import type { AuthUser } from '@sveltex/auth';

/** Session payload stored by the SessionManager. */
export type AppSessionData = { readonly userId: string };

/** Public user shape (never contains a password hash). */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly createdAt: number;
}

/** Shape required by AuthService's CredentialUserStore contract. */
export interface AppUser extends AuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly createdAt: number;
  readonly passwordHash: string;
}

export interface Post {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
}

/** Error raised when an operation is not permitted for the current principal. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** Error raised when a session is missing, expired, or invalid. */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
