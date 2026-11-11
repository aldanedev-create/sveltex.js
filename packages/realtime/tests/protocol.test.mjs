import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowAnonymous,
  decodeWireMessage,
  denyAnonymous,
  encodeWireMessage,
  isChannelName,
  MAX_WIRE_MESSAGE_BYTES,
  publicWireError,
  REALTIME_PROTOCOL_VERSION,
  validateEnvelope,
} from '../dist/protocol.js';
import { RealtimeProtocolError } from '../dist/index.js';

const envelope = Object.freeze({
  id: 'env-1',
  channel: 'chat:general',
  payload: { text: 'hello' },
  publishedAt: 1700000000000,
});

test('protocol: every frame tag round-trips through the wire codec', () => {
  const frames = [
    { t: 'sub', channel: 'chat:general' },
    { t: 'unsub', channel: 'chat:general' },
    { t: 'pub', envelope },
    { t: 'msg', envelope },
    { t: 'pong', at: 42 },
    { t: 'ping', at: 42 },
    { t: 'ready', protocol: REALTIME_PROTOCOL_VERSION },
    { t: 'error', code: 'X', message: 'no' },
  ];
  for (const frame of frames) {
    const raw = encodeWireMessage(frame);
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(raw), JSON.parse(JSON.stringify(frame)));
    const decoded = decodeWireMessage(raw, 'any');
    assert.equal(decoded.t, frame.t);
    assert.ok(Object.isFrozen(decoded));
  }
});

test('protocol: frame direction is enforced (client cannot send server-only tags)', () => {
  assert.throws(() => decodeWireMessage(encodeWireMessage({ t: 'msg', envelope }), 'client'),
    (error) => error instanceof RealtimeProtocolError && /Unexpected client tag/.test(error.message));
  assert.throws(() => decodeWireMessage(encodeWireMessage({ t: 'sub', channel: 'a' }), 'server'),
    (error) => error instanceof RealtimeProtocolError && /Unexpected server tag/.test(error.message));
});

test('protocol: malformed, oversized, unknown and legacy frames raise instead of silent drops', () => {
  assert.throws(() => decodeWireMessage('{not json'), RealtimeProtocolError);
  assert.throws(() => decodeWireMessage('[]'), RealtimeProtocolError);
  assert.throws(() => decodeWireMessage('{"t":"bogus"}'), RealtimeProtocolError);
  assert.throws(() => decodeWireMessage('{}'), RealtimeProtocolError);
  assert.throws(() => decodeWireMessage('x'.repeat(MAX_WIRE_MESSAGE_BYTES + 1)), RealtimeProtocolError);
  assert.throws(() => decodeWireMessage(encodeWireMessage({ t: 'ready', protocol: 999 })), RealtimeProtocolError);
  assert.throws(() => decodeWireMessage('{"t":"ping","at":"now"}'), RealtimeProtocolError);
});

test('protocol: envelope validation is strict and drops extra keys', () => {
  const parsed = JSON.parse('{"id":"a","channel":"c","payload":{"x":1},"publishedAt":1,"__proto__":{"polluted":true}}');
  const clean = validateEnvelope(parsed);
  assert.deepEqual(Object.keys(clean), ['id', 'channel', 'payload', 'publishedAt']);
  assert.ok(Object.isFrozen(clean));
  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => validateEnvelope({ ...envelope, id: '' }), RealtimeProtocolError);
  assert.throws(() => validateEnvelope({ ...envelope, id: 'x'.repeat(129) }), RealtimeProtocolError);
  assert.throws(() => validateEnvelope({ ...envelope, id: 'a\ncontrol' }), RealtimeProtocolError);
  assert.throws(() => validateEnvelope({ ...envelope, channel: '../admin' }), RealtimeProtocolError);
  assert.throws(() => validateEnvelope({ ...envelope, publishedAt: Number.NaN }), RealtimeProtocolError);
  const { payload: _ignored, ...withoutPayload } = envelope;
  assert.throws(() => validateEnvelope(withoutPayload), RealtimeProtocolError);
});

test('protocol: unsafe payloads are rejected before JSON.stringify can coerce them', () => {
  const unsafe = [
    1n,
    Symbol('x'),
    () => 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    new Date(0),
    new Map(),
    new Set(),
    /regex/,
    { toJSON: () => 'changed' },
    { nested: { deep: 1n } },
  ];
  for (const payload of unsafe) {
    assert.throws(
      () => encodeWireMessage({ t: 'pub', envelope: { ...envelope, payload } }),
      (error) => error instanceof RealtimeProtocolError,
      `unsafe payload should be rejected: ${String(payload)}`,
    );
  }
  const circular = { self: null };
  circular.self = circular;
  assert.throws(() => encodeWireMessage({ t: 'pub', envelope: { ...envelope, payload: circular } }),
    (error) => error instanceof RealtimeProtocolError && /Circular/.test(error.message));
  const symbolKeyed = { [Symbol('k')]: 1 };
  assert.throws(() => encodeWireMessage({ t: 'pub', envelope: { ...envelope, payload: symbolKeyed } }),
    (error) => error instanceof RealtimeProtocolError && /Symbol-keyed/.test(error.message));
  assert.throws(() => encodeWireMessage({ t: 'sub', channel: 'a'.repeat(129) }), RealtimeProtocolError);
});

test('protocol: encoded frames are byte-bounded and primitives/arrays survive', () => {
  const raw = encodeWireMessage({ t: 'pub', envelope: { ...envelope, payload: { list: [1, 'two', null, true] } } });
  assert.ok(Buffer.byteLength(raw, 'utf8') <= MAX_WIRE_MESSAGE_BYTES);
  assert.throws(
    () => encodeWireMessage({ t: 'pub', envelope: { ...envelope, payload: 'x'.repeat(MAX_WIRE_MESSAGE_BYTES) } }),
    (error) => error instanceof RealtimeProtocolError && /exceeds/.test(error.message),
  );
});

test('protocol: channel grammar and gateway auth helpers', () => {
  assert.equal(isChannelName('chat:general'), true);
  assert.equal(isChannelName('a.b-c_d:1'), true);
  for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(129), null, 42]) assert.equal(isChannelName(bad), false);
  assert.equal(allowAnonymous()({}), true);
  assert.equal(denyAnonymous()({}), false);
});

test('protocol: wire errors never echo internal details', () => {
  const error = publicWireError(new Error('secret connection string leaked'));
  assert.equal(error.t, 'error');
  assert.equal(error.message, 'The realtime frame was rejected.');
  assert.ok(!JSON.stringify(error).includes('secret'));
});
