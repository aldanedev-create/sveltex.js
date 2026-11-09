import test from 'node:test';
import assert from 'node:assert/strict';
import { RbacBuilder, createRbac } from '../dist/rbac.js';
import { AuthForbiddenError, AuthUnauthorizedError } from '../dist/errors.js';

test('denies by default: unknown role or unknown permission is denied', () => {
  const rbac = new RbacBuilder();
  rbac.defineRole('user', { permissions: ['profile:read'] });
  assert.equal(rbac.can('user', 'profile:read'), true);
  assert.equal(rbac.can('user', 'admin:delete'), false);
  assert.equal(rbac.can('ghost', 'profile:read'), false); // undefined role
});

test('role inheritance unions permissions', () => {
  const rbac = new RbacBuilder();
  rbac.defineRole('user', { permissions: ['profile:read', 'profile:write'] });
  rbac.defineRole('admin', { permissions: ['users:read'], inherits: ['user'] });
  assert.equal(rbac.can('admin', 'users:read'), true);
  assert.equal(rbac.can('admin', 'profile:write'), true); // inherited
  assert.equal(rbac.can('user', 'users:read'), false);
});

test('cycle detection throws', () => {
  const rbac = new RbacBuilder();
  rbac.defineRole('a', { inherits: ['b'] });
  rbac.defineRole('b', { inherits: ['a'] });
  assert.throws(() => rbac.effectivePermissions('a'), /cycle/);
});

test('authorize checks any of the supplied roles', () => {
  const rbac = createRbac({
    user: { permissions: ['profile:read'] },
    admin: { permissions: ['users:read'] },
  });
  assert.equal(rbac.authorize(['user'], 'profile:read'), true);
  assert.equal(rbac.authorize(['user', 'admin'], 'users:read'), true);
  assert.equal(rbac.authorize(['user'], 'users:read'), false);
});

test('requirePermission: Forbidden when under-privileged, Unauthorized when no roles', () => {
  const rbac = createRbac({
    user: { permissions: ['profile:read'] },
    admin: { permissions: ['users:read'] },
  });
  assert.doesNotThrow(() => rbac.requirePermission(['admin'], 'users:read'));
  assert.throws(() => rbac.requirePermission(['user'], 'users:read'), AuthForbiddenError);
  assert.throws(() => rbac.requirePermission([], 'users:read'), AuthUnauthorizedError);
  assert.throws(() => rbac.requirePermission(undefined, 'users:read'), AuthUnauthorizedError);
});
