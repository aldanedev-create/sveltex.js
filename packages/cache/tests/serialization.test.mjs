import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheSerializationError,
  CACHE_ENVELOPE_PREFIX,
  deserializeCacheValue,
  isCacheEnvelope,
  serializeCacheValue,
} from '../dist/index.js';

test('serialization: undefined has its own envelope and round-trips', () => {
  const encoded = serializeCacheValue(undefined);
  assert.equal(encoded, `${CACHE_ENVELOPE_PREFIX}u`);
  assert.equal(deserializeCacheValue(encoded), undefined);
  assert.equal(isCacheEnvelope(encoded), true);
  assert.equal(isCacheEnvelope('plain-string'), false);
});

test('serialization: primitives and plain containers round-trip exactly', () => {
  const values = [null, true, false, 0, 42, -3.5, '', 'hello', [1, 'two', null], { a: 1, b: { c: [true, false] } }];
  for (const value of values) {
    assert.deepEqual(deserializeCacheValue(serializeCacheValue(value)), value);
  }
});

test('serialization: every encoded value carries the versioned prefix', () => {
  assert.ok(serializeCacheValue({ x: 1 }).startsWith(CACHE_ENVELOPE_PREFIX));
  assert.ok(serializeCacheValue('x').startsWith(`${CACHE_ENVELOPE_PREFIX}j`));
});

test('serialization: rejects top-level BigInt instead of throwing an opaque TypeError', () => {
  assert.throws(() => serializeCacheValue(1n), (error) => error instanceof CacheSerializationError && /BigInt/.test(error.message));
});

test('serialization: rejects nested BigInt', () => {
  assert.throws(() => serializeCacheValue({ n: 1n }), CacheSerializationError);
});

test('serialization: rejects functions and symbols', () => {
  assert.throws(() => serializeCacheValue(() => 1), CacheSerializationError);
  assert.throws(() => serializeCacheValue(Symbol('x')), CacheSerializationError);
  assert.throws(() => serializeCacheValue({ fn: () => 1 }), CacheSerializationError);
});

test('serialization: rejects non-finite numbers (no silent null coercion)', () => {
  assert.throws(() => serializeCacheValue(NaN), CacheSerializationError);
  assert.throws(() => serializeCacheValue(Infinity), CacheSerializationError);
  assert.throws(() => serializeCacheValue({ n: NaN }), CacheSerializationError);
  assert.throws(() => serializeCacheValue([Infinity]), CacheSerializationError);
});

test('serialization: rejects circular references with a typed error', () => {
  const cycle = { self: null };
  cycle.self = cycle;
  assert.throws(() => serializeCacheValue(cycle), (error) => error instanceof CacheSerializationError && error.cause instanceof TypeError);
});

test('serialization: rejects nested undefined (would be dropped or become null)', () => {
  assert.throws(() => serializeCacheValue({ a: undefined }), CacheSerializationError);
  assert.throws(() => serializeCacheValue([1, undefined]), CacheSerializationError);
});

test('serialization: rejects Date/Map/Set/RegExp/typed arrays (silent type loss)', () => {
  assert.throws(() => serializeCacheValue(new Date('2020-01-01')), CacheSerializationError);
  assert.throws(() => serializeCacheValue({ when: new Date() }), CacheSerializationError);
  assert.throws(() => serializeCacheValue(new Map([['a', 1]])), CacheSerializationError);
  assert.throws(() => serializeCacheValue(new Set([1])), CacheSerializationError);
  assert.throws(() => serializeCacheValue(/abc/), CacheSerializationError);
  assert.throws(() => serializeCacheValue(new Uint8Array([1, 2])), CacheSerializationError);
});

test('serialization: rejects class instances (non-plain prototype)', () => {
  class Custom { constructor() { this.x = 1; } }
  assert.throws(() => serializeCacheValue(new Custom()), CacheSerializationError);
});

test('serialization: accepts null-prototype plain objects', () => {
  const value = Object.create(null);
  value.a = 1;
  assert.deepEqual(deserializeCacheValue(serializeCacheValue(value)), { a: 1 });
});

test('serialization: corrupt/legacy payloads raise instead of becoming a cache miss', () => {
  assert.throws(() => deserializeCacheValue('plain-json {"a":1}'), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(`${CACHE_ENVELOPE_PREFIX}x`), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(`${CACHE_ENVELOPE_PREFIX}j{broken`), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(`${CACHE_ENVELOPE_PREFIX}utrailing`), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(42), CacheSerializationError);
});

test('serialization: __proto__ is dropped during parse (prototype-pollution defense)', () => {
  const payload = `${CACHE_ENVELOPE_PREFIX}j${JSON.stringify({ safe: 1, __proto__: { polluted: true } })}`;
  const decoded = deserializeCacheValue(payload);
  assert.equal(decoded.safe, 1);
  assert.equal(Object.hasOwn(decoded, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('serialization: malformed envelope carries a useful code', () => {
  try {
    deserializeCacheValue('garbage');
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(error instanceof CacheSerializationError);
    assert.equal(error.code, 'CACHE_SERIALIZATION');
    assert.equal(error.name, 'CacheSerializationError');
  }
});
