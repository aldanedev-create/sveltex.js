/**
 * Authorization and token error types for `@sveltex/auth`.
 *
 * These are defined in a standalone module so that subpath entry points
 * (`@sveltex/auth/rbac`, `@sveltex/auth/reset`, `@sveltex/auth/verification`,
 * `@sveltex/auth/tokens`) can use them without creating an import cycle with
 * the package's main entry point.
 *
 * @public
 */

/** Base class for all auth errors that are not configuration problems. */
export class AuthError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Raised when a requested resource or action conflicts with existing state. */
export class AuthConflictError extends AuthError {
  constructor(message: string) {
    super(message, 'AUTH_CONFLICT');
    this.name = 'AuthConflictError';
  }
}

/** Raised when the auth service is constructed with invalid options or adapters. */
export class AuthConfigurationError extends AuthError {
  constructor(message: string) {
    super(message, 'AUTH_CONFIGURATION');
    this.name = 'AuthConfigurationError';
  }
}

/**
 * Raised when an authenticated caller attempts an action they are not permitted
 * to perform. Maps to HTTP 403 in application code.
 */
export class AuthForbiddenError extends AuthError {
  readonly roles: readonly string[];
  readonly permission: string;
  constructor(permission: string, roles: readonly string[] = []) {
    super(`Permission denied: "${permission}" is not granted to the supplied roles.`, 'AUTH_FORBIDDEN');
    this.name = 'AuthForbiddenError';
    this.permission = permission;
    this.roles = Object.freeze([...roles]);
  }
}

/**
 * Raised when an action requires an authenticated principal but none was
 * supplied. Maps to HTTP 401 in application code.
 */
export class AuthUnauthorizedError extends AuthError {
  constructor(message = 'Authentication is required to perform this action.') {
    super(message, 'AUTH_UNAUTHORIZED');
    this.name = 'AuthUnauthorizedError';
  }
}

/** Base class for single-use token failures (reset / verification links). */
export class AuthTokenError extends AuthError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'AuthTokenError';
  }
}

/** Raised when a token has passed its expiry window. */
export class AuthTokenExpiredError extends AuthTokenError {
  constructor(message = 'The token has expired. Request a new one.') {
    super(message, 'AUTH_TOKEN_EXPIRED');
    this.name = 'AuthTokenExpiredError';
  }
}

/** Raised when a token is malformed, has the wrong purpose, or does not exist. */
export class AuthTokenInvalidError extends AuthTokenError {
  constructor(message = 'The token is invalid.') {
    super(message, 'AUTH_TOKEN_INVALID');
    this.name = 'AuthTokenInvalidError';
  }
}

/** Raised when a single-use token is presented more than once. */
export class AuthTokenUsedError extends AuthTokenError {
  constructor(message = 'The token has already been used. Request a new one.') {
    super(message, 'AUTH_TOKEN_USED');
    this.name = 'AuthTokenUsedError';
  }
}
