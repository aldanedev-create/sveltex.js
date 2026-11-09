import { AuthForbiddenError, AuthUnauthorizedError } from './errors.js';

/**
 * A role identifier. Roles are application-defined strings (e.g. `"admin"`).
 *
 * @public
 */
export type Role = string;

/**
 * A permission identifier. Permissions are fine-grained strings (e.g.
 * `"users:read"`, `"billing:write"`).
 *
 * @public
 */
export type Permission = string;

/**
 * Definition of a role: the permissions it grants directly, plus any roles it
 * inherits (their permissions are unioned in, with cycle detection).
 *
 * @public
 */
export interface RoleDefinition {
  readonly permissions?: readonly Permission[];
  readonly inherits?: readonly Role[];
}

/**
 * A small, dependency-free role-based access control builder.
 *
 * Design rules:
 * - **Deny by default.** A role that is never defined, or a permission that is
 *   never granted, resolves to "denied".
 * - Role inheritance is supported and cycle-safe.
 * - `requirePermission` throws {@link AuthForbiddenError} (HTTP 403) when the
 *   principal lacks the permission, or {@link AuthUnauthorizedError} (HTTP 401)
 *   when no roles are supplied at all.
 *
 * @example
 * ```ts
 * const rbac = createRbac({
 *   user:  { permissions: ['profile:read', 'profile:write'] },
 *   admin: { permissions: ['users:read'], inherits: ['user'] },
 * });
 * rbac.requirePermission(['user'], 'profile:write'); // ok
 * rbac.requirePermission(['user'], 'users:read');    // throws AuthForbiddenError
 * ```
 *
 * @public
 */
export class RbacBuilder {
  readonly #roles = new Map<Role, { readonly permissions: Set<Permission>; readonly inherits: readonly Role[] }>();
  readonly #cache = new Map<Role, ReadonlySet<Permission>>();

  defineRole(role: Role, definition: RoleDefinition = {}): this {
    if (typeof role !== 'string' || role.length === 0) throw new TypeError('Role must be a non-empty string.');
    const permissions = new Set(definition.permissions ?? []);
    this.#roles.set(role, { permissions, inherits: definition.inherits ?? [] });
    this.#cache.clear();
    return this;
  }

  /** Resolve the full permission set for a role, including inherited permissions. */
  effectivePermissions(role: Role): ReadonlySet<Permission> {
    const cached = this.#cache.get(role);
    if (cached) return cached;
    if (!this.#roles.has(role)) return new Set();
    const resolved = new Set<Permission>();
    const visiting = new Set<Role>();
    const visit = (current: Role): void => {
      if (visiting.has(current)) throw new Error(`RBAC role inheritance cycle detected at "${current}".`);
      visiting.add(current);
      const def = this.#roles.get(current);
      if (def) {
        for (const permission of def.permissions) resolved.add(permission);
        for (const parent of def.inherits) visit(parent);
      }
      visiting.delete(current);
    };
    visit(role);
    const frozen = new Set(resolved);
    this.#cache.set(role, frozen);
    return frozen;
  }

  /** Whether a single role grants `permission`. */
  can(role: Role, permission: Permission): boolean {
    return this.effectivePermissions(role).has(permission);
  }

  /** Whether any of the supplied roles grants `permission`. */
  authorize(roles: readonly Role[], permission: Permission): boolean {
    return roles.some((role) => this.can(role, permission));
  }

  /**
   * Throw unless the principal holds at least one role granting `permission`.
   * An empty/absent role list throws {@link AuthUnauthorizedError}; an
   * authenticated but under-privileged principal throws {@link AuthForbiddenError}.
   */
  requirePermission(roles: readonly Role[] | undefined, permission: Permission): void {
    const safeRoles = roles ?? [];
    if (safeRoles.length === 0) throw new AuthUnauthorizedError();
    if (!this.authorize(safeRoles, permission)) throw new AuthForbiddenError(permission, safeRoles);
  }
}

/**
 * Convenience factory: build an {@link RbacBuilder} from a role→definition map.
 *
 * @public
 */
export function createRbac(definitions: Record<Role, RoleDefinition> = {}): RbacBuilder {
  const builder = new RbacBuilder();
  for (const [role, definition] of Object.entries(definitions)) builder.defineRole(role, definition);
  return builder;
}
