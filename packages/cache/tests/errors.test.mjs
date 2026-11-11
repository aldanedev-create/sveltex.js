import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheError,
  CacheConfigurationError,
  CacheSerializationError,
  CacheStoreError,
  validateCacheKey,
  validateCacheTtl,
  validateCacheTag,
  validateCacheNamespace,
} from '../dist/index.js';

test('errors: hierarchy, names, codes and cause', () => {
  const cause = new Error('socket closed');
  const base = new CacheError('oops', 'CUSTOM', cause);
  assert.ok(base instanceof Error);
  assert.equal(base.name, 'CacheError');
  assert.equal(base.code, 'CUSTOM');
  assert.equal(base.cause, cause);

  assert.ok(new CacheConfigurationError('bad') instanceof CacheError);
  assert.equal(new CacheConfigurationError('bad').code, 'CACHE_CONFIGURATION');
  assert.equal(new CacheSerializationError('bad').code, 'CACHE_SERIALIZATION');

  const storeError = new CacheStoreError('get', cause);
  assert.equal(storeError.code, 'CACHE_STORE');
  assert.equal(storeError.operation, 'get');
  assert.equal(storeError.cause, cause);
  assert.match(storeError.message, /get/);
  assert.equal(new CacheStoreError('set', undefined, 'custom').message, 'custom');
});

test('validation: cache keys are bounded non-empty strings', () => {
  assert.throws(() => validateCacheKey(''), TypeError);
  assert.throws(() => validateCacheKey('k'.repeat(1025)), TypeError);
  assert.throws(() => validateCacheKey(42), TypeError);
  assert.doesNotThrow(() => validateCacheKey('k'.repeat(1024)));
});

test('validation: TTL must be finite and non-negative', () => {
  assert.throws(() => validateCacheTtl(-1), RangeError);
  assert.throws(() => validateCacheTtl(Infinity), RangeError);
  assert.throws(() => validateCacheTtl(NaN), RangeError);
  assert.throws(() => validateCacheTtl(0, false), RangeError);
  assert.doesNotThrow(() => validateCacheTtl(0, true));
  assert.doesNotThrow(() => validateCacheTtl(1000));
});

test('validation: tags reject injection and prototype-polluting names', () => {
  for (const tag of ['', 'has space', 'a/b', '__proto__', 'constructor', 'prototype', 'x'.repeat(257)]) {
    assert.throws(() => validateCacheTag(tag), TypeError, `expected rejection for ${JSON.stringify(tag)}`);
  }
  for (const tag of ['user:1', 'posts', 'a.b-c_d', 'x'.repeat(256)]) {
    assert.doesNotThrow(() => validateCacheTag(tag));
  }
});

test('validation: namespace names are bounded non-empty strings', () => {
  assert.throws(() => validateCacheNamespace(''), TypeError);
  assert.throws(() => validateCacheNamespace('n'.repeat(257)), TypeError);
  assert.doesNotThrow(() => validateCacheNamespace('a:b/c'));
});
