import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  allowAnonymous,
  createWebSocketGateway,
} from '../../dist/websocket.js';
import { createSseGateway } from '../../dist/sse.js';
import {
  RealtimeConnectionError,
  RealtimeProtocolError,
} from '../../dist/index.js';
import {
  decodeWireMessage,
  encodeWireMessage,
  isChannelName,
  MAX_WIRE_MESSAGE_BYTES,
  publicWireError,
  REALTIME_PROTOCOL_VERSION,
} from '../../dist/protocol.js';
import { readSseFrames, waitFor } from '../helpers.mjs';

const fastHeartbeat = { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 4000 };
const envelope = (id, channel, payload) => Object.freeze({
  id, channel, payload, publishedAt: 1700000000000,
});

test('SEC-5: decoded frames strip __proto__ and never pollute Object.prototype', () => {
  const raw = JSON.stringify({
    t: 'pub',
    envelope: {
      id: 'a', channel: 'c', payload: { x: 1 }, publishedAt: 1,
      __proto__: { polluted: true },
    },
  });
  const message = decodeWireMessage(raw, 'client');
  assert.equal(message.t, 'pub');
  assert.deepEqual(Object.keys(message.envelope), ['id', 'channel', 'payload', 'publishedAt']);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(message.envelope), Object.prototype);
  assert.ok(Object.isFrozen(message.envelope));
});

test('SEC-5: forged server-only frames are rejected on the client direction', () => {
  const forgeries = [
    { t: 'ready', protocol: REALTIME_PROTOCOL_VERSION },
    { t: 'msg', envelope: envelope('m', 'c', {}) },
    { t: 'ping', at: 1 },
    { t: 'error', code: 'X', message: 'y' },
  ];
  for (const frame of forgeries) {
    assert.throws(
      () => decodeWireMessage(JSON.stringify(frame), 'client'),
      (error) => error instanceof RealtimeProtocolError && /Unexpected client tag/.test(error.message),
    );
  }
  // And client-only frames are rejected on the server direction.
  assert.throws(
    () => decodeWireMessage(JSON.stringify({ t: 'sub', channel: 'c' }), 'server'),
    (error) => error instanceof RealtimeProtocolError && /Unexpected server tag/.test(error.message),
  );
});

test('SEC-5: unsupported/legacy protocol versions and unknown tags are rejected', () => {
  for (const protocol of [0, 2, REALTIME_PROTOCOL_VERSION + 1, '1', null]) {
    assert.throws(
      () => decodeWireMessage(JSON.stringify({ t: 'ready', protocol }), 'server'),
      (error) => error instanceof RealtimeProtocolError,
    );
  }
  assert.throws(
    () => decodeWireMessage(JSON.stringify({ t: 'exec', cmd: 'rm -rf /' }), 'any'),
    (error) => error instanceof RealtimeProtocolError && /Unknown frame tag/.test(error.message),
  );
});

test('SEC-5: oversized frames are rejected before they can be parsed or encoded', () => {
  const oversized = 'x'.repeat(MAX_WIRE_MESSAGE_BYTES + 1);
  assert.throws(() => decodeWireMessage(oversized), (error) => error instanceof RealtimeProtocolError);
  assert.throws(
    () => encodeWireMessage({ t: 'pub', envelope: envelope('big', 'c', 'y'.repeat(MAX_WIRE_MESSAGE_BYTES)) }),
    (error) => error instanceof RealtimeProtocolError && /exceeds/.test(error.message),
  );
});

test('SEC-5: unsafe payloads cannot be smuggled through JSON.stringify coercion', () => {
  const unsafe = [
    new Date(0), new Map(), new Set(), /regex/,
    { toJSON: () => 'changed' },
    1n, Symbol('s'), () => 1, Number.NaN, Number.POSITIVE_INFINITY, undefined,
  ];
  for (const payload of unsafe) {
    assert.throws(
      () => encodeWireMessage({ t: 'pub', envelope: envelope('u', 'c', payload) }),
      (error) => error instanceof RealtimeProtocolError,
    );
  }
  const circular = { self: null };
  circular.self = circular;
  assert.throws(
    () => encodeWireMessage({ t: 'pub', envelope: envelope('u', 'c', circular) }),
    (error) => error instanceof RealtimeProtocolError && /Circular/.test(error.message),
  );
});

test('SEC-5: wire errors never echo internal details or stack traces', () => {
  for (const secret of ['postgres://user:pass@db', 'Error: secret token leaked', 'at /app/src/db.js:12']) {
    const frame = publicWireError(new Error(secret));
    assert.equal(frame.code, 'SX_REALTIME_TRANSPORT');
    assert.equal(frame.message, 'The realtime frame was rejected.');
    assert.ok(!JSON.stringify(frame).includes('secret'));
    assert.ok(!JSON.stringify(frame).includes('postgres'));
  }
  assert.equal(publicWireError(new RealtimeProtocolError('x')).code, 'SX_REALTIME_PROTOCOL');
});

test('SEC-5: channel grammar rejects traversal, control characters and oversized names', () => {
  for (const bad of ['', '../admin', 'a/b', 'a b', 'a\n', 'a\u0000', 'x'.repeat(129), null, 42, {}]) {
    assert.equal(isChannelName(bad), false);
  }
  assert.equal(isChannelName('a.b-c_d:1'), true);
});

test('SEC-5: WebSocket gateway is deny-by-default (no implicit anonymous access)', async (t) => {
  const gateway = await createWebSocketGateway();
  t.after(() => gateway.close());
  const socket = new WebSocket(gateway.url);
  const outcome = await new Promise((resolve) => {
    socket.once('close', (code) => resolve({ type: 'close', code }));
    socket.once('message', () => resolve({ type: 'message' }));
    socket.once('error', () => resolve({ type: 'error' }));
  });
  assert.equal(outcome.type, 'close');
  assert.equal(outcome.code, 1008);
  await waitFor(() => gateway.metrics.authFailures === 1);
  socket.terminate();
});

test('SEC-5: SSE gateway is deny-by-default and rejects client-id injection', async (t) => {
  const gateway = await createSseGateway({ authenticate: allowAnonymous(), ...fastHeartbeat });
  t.after(() => gateway.close());
  for (const bad of ['../evil', 'a/b', 'x'.repeat(65), '', 'a b']) {
    const response = await fetch(`${gateway.url}/events?clientId=${encodeURIComponent(bad)}`, {
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(response.status, 400, `clientId ${bad} must be rejected`);
    await response.body?.cancel();
  }
  const denied = await createSseGateway();
  t.after(() => denied.close());
  const unauthorized = await fetch(`${denied.url}/subscribe?clientId=c1&channel=chat:a`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
});

test('SEC-5: a throwing authenticator never implicitly grants access', async (t) => {
  const boom = () => { throw new Error('secret database connection string'); };
  const ws = await createWebSocketGateway({ authenticate: boom, ...fastHeartbeat });
  t.after(() => ws.close());
  const socket = new WebSocket(ws.url);
  const outcome = await new Promise((resolve) => {
    socket.once('close', (code) => resolve({ type: 'close', code }));
    socket.once('message', () => resolve({ type: 'message' }));
    socket.once('error', () => resolve({ type: 'error' }));
  });
  assert.equal(outcome.type, 'close');
  assert.equal(outcome.code, 1008);
  socket.terminate();

  const sse = await createSseGateway({ authenticate: boom });
  t.after(() => sse.close());
  const response = await fetch(`${sse.url}/events?clientId=c1`);
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('secret'));
});

test('SEC-5: Last-Event-ID replay never leaks frames from unsubscribed channels', async (t) => {
  const gateway = await createSseGateway({
    authenticate: allowAnonymous(),
    replayBufferSize: 16,
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());
  const base = gateway.url;
  const cid = 'sec-replay-client';
  assert.equal((await fetch(`${base}/subscribe?clientId=${cid}&channel=chat:a`, { method: 'POST' })).status, 204);

  const publish = (id, channel) => fetch(`${base}/publish?clientId=${cid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: encodeWireMessage({ t: 'pub', envelope: envelope(id, channel, { id }) }),
  });

  const first = new AbortController();
  const stream = await fetch(`${base}/events?clientId=${cid}`, {
    signal: first.signal,
    headers: { Accept: 'text/event-stream' },
  });
  await publish('a1', 'chat:a');
  await publish('b1', 'chat:b'); // not subscribed -> must never be delivered
  await publish('a2', 'chat:a');
  const frames = await readSseFrames(stream, 2);
  assert.equal(frames.length, 2);
  assert.match(frames[0], /a1/);
  assert.match(frames[1], /a2/);
  assert.ok(!frames.some((frame) => frame.includes('b1')));
  first.abort();

  const second = new AbortController();
  const replayStream = await fetch(`${base}/events?clientId=${cid}`, {
    signal: second.signal,
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': 'a1' },
  });
  const replayed = await readSseFrames(replayStream, 1);
  assert.equal(replayed.length, 1);
  assert.match(replayed[0], /a2/);
  assert.ok(!replayed[0].includes('b1'));
  second.abort();
});

test('SEC-5: hostile gateway configuration is rejected at construction', async () => {
  await assert.rejects(
    () => createWebSocketGateway({ path: '/rt?admin=1', authenticate: allowAnonymous() }),
    (error) => error instanceof RealtimeConnectionError,
  );
  await assert.rejects(
    () => createWebSocketGateway({ maxMessageBytes: 0, authenticate: allowAnonymous() }),
    (error) => error instanceof RealtimeConnectionError,
  );
  await assert.rejects(
    () => createWebSocketGateway({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 }),
    (error) => error instanceof RealtimeConnectionError,
  );
  await assert.rejects(
    () => createSseGateway({ replayBufferSize: 0, authenticate: allowAnonymous() }),
    (error) => error instanceof RealtimeConnectionError,
  );
  await assert.rejects(
    () => createSseGateway({ path: '/rt#frag', authenticate: allowAnonymous() }),
    (error) => error instanceof RealtimeConnectionError,
  );
});
