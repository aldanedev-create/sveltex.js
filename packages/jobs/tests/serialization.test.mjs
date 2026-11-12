import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeJobPayload,
  deserializeJobPayload,
  encodeJobRecord,
  decodeJobRecord,
  decodeJob,
  JOBS_ENVELOPE_PREFIX,
  JOBS_ENVELOPE_VERSION,
  MAX_PAYLOAD_BYTES,
} from '../dist/serialization.js';
import { JobsSerializationError } from '../dist/index.js';

const expectSerializationError = { name: 'JobsSerializationError' };

test('serialization: primitives, undefined, arrays and plain objects round-trip exactly', () => {
  assert.equal(JOBS_ENVELOPE_VERSION, 1);
  for (const value of [undefined, null, 0, -1.5, true, false, 'hello', '中文', { a: 1, b: [1, 2, { c: 'x' }] }, [1, 'two', null]]) {
    const raw = serializeJobPayload(value);
    assert.ok(raw.startsWith(JOBS_ENVELOPE_PREFIX));
    assert.deepEqual(deserializeJobPayload(raw), value);
  }
  assert.equal(serializeJobPayload(undefined), `${JOBS_ENVELOPE_PREFIX}u`);
});

test('serialization: unsafe payloads are rejected before JSON can silently coerce them', () => {
  const unsafe = [
    new Date(), new Map(), new Set(), /x/, 1n, Symbol('s'), () => 1,
    Number.NaN, Number.POSITIVE_INFINITY, new Uint8Array([1]), new ArrayBuffer(8),
    { nested: new Date() }, [1, undefined], { missing: undefined },
  ];
  for (const value of unsafe) {
    assert.throws(() => serializeJobPayload(value), expectSerializationError, String(value));
  }
  const circular = {};
  circular.self = circular;
  assert.throws(() => serializeJobPayload(circular), expectSerializationError);
  class Custom { constructor() { this.x = 1; } }
  assert.throws(() => serializeJobPayload(new Custom()), expectSerializationError);
});

test('serialization: prototype-pollution keys are rejected on encode and stripped on decode', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"ok":2}');
  assert.throws(() => serializeJobPayload(hostile), expectSerializationError);
  const raw = `${JOBS_ENVELOPE_PREFIX}j{"__proto__":{"polluted":true},"constructor":1,"ok":2}`;
  const decoded = deserializeJobPayload(raw);
  assert.deepEqual(decoded, { ok: 2 });
  assert.equal(Object.prototype.polluted, undefined);
});

test('serialization: corrupt and legacy envelopes are rejected, never coerced', () => {
  for (const raw of ['', 'null', '{}', 'sveltex-jobs:v0:j1', `${JOBS_ENVELOPE_PREFIX}z{}`, `${JOBS_ENVELOPE_PREFIX}j{bad`, `${JOBS_ENVELOPE_PREFIX}j`, 'j{}']) {
    assert.throws(() => deserializeJobPayload(raw), expectSerializationError, raw);
  }
});

test('serialization: payload is byte-bounded', () => {
  assert.throws(() => serializeJobPayload('x'.repeat(MAX_PAYLOAD_BYTES)), expectSerializationError);
  assert.doesNotThrow(() => serializeJobPayload('x'.repeat(1024)));
});

function record(overrides = {}) {
  return {
    v: 1,
    id: 'job-1',
    name: 'email.send',
    payload: serializeJobPayload({ to: 'a@b.com' }),
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    createdAt: 100,
    availableAt: 150,
    dedupeKey: undefined,
    lastError: undefined,
    ...overrides,
  };
}

test('serialization: job records round-trip with every field validated', () => {
  const decoded = decodeJobRecord(encodeJobRecord(record()));
  assert.equal(decoded.id, 'job-1');
  assert.equal(decoded.status, 'pending');
  assert.equal(decoded.availableAt, 150);
  assert.equal(decoded.dedupeKey, undefined);
  assert.equal(decoded.lastError, undefined);
  assert.equal(Object.isFrozen(decoded), true);
});

test('serialization: legacy, corrupt or invalid records are rejected', () => {
  const bad = [
    record({ v: 2 }), record({ status: 'bogus' }), record({ attempts: -1 }),
    record({ maxAttempts: 0 }), record({ createdAt: 'x' }), record({ id: 5 }),
    record({ payload: 42 }), record({ dedupeKey: 7 }), record({ lastError: {} }),
  ];
  for (const item of bad) {
    assert.throws(() => decodeJobRecord(encodeJobRecord(item)), expectSerializationError);
  }
  assert.throws(() => decodeJobRecord('not-json'), expectSerializationError);
  assert.throws(() => decodeJobRecord('[]'), expectSerializationError);
});

test('serialization: decodeJob returns a frozen public Job with a decoded payload', () => {
  const job = decodeJob(encodeJobRecord(record({ dedupeKey: 'k1', lastError: 'boom' })));
  assert.equal(Object.isFrozen(job), true);
  assert.deepEqual(job.payload, { to: 'a@b.com' });
  assert.equal(job.dedupeKey, 'k1');
  assert.equal(job.lastError, 'boom');
  assert.throws(() => decodeJob(encodeJobRecord(record({ payload: 'legacy' }))), expectSerializationError);
  assert.ok(JobsSerializationError);
});
