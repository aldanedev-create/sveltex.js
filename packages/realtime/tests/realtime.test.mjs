import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineChannel,
  RealtimeHub,
  allowAll,
  denyAll,
  RealtimeChannelError,
  RealtimeAuthorizationError,
  RealtimeClosedError,
  RealtimeTransportError,
  RealtimeDeliveryError,
} from '../dist/index.js';
import { InProcessTransport } from '../dist/in-process.js';

const principal = { id: 'user-1' };

function makeHub(transport, authorize = allowAll(), extra = {}) {
  return new RealtimeHub({ transport, authorize, ...extra });
}

test('defineChannel accepts safe names and freezes the definition', () => {
  const ch = defineChannel('room:42');
  assert.equal(ch.name, 'room:42');
  assert.ok(Object.isFrozen(ch));
  assert.doesNotThrow(() => defineChannel('a.b-c_d:9'));
});

test('defineChannel rejects dangerous / invalid names (injection surface)', () => {
  for (const bad of ['', '   ', 'has space', 'a/b', '../etc', 'a\nb', 'x'.repeat(129), 42, null, undefined]) {
    assert.throws(() => defineChannel(bad), { name: 'RealtimeChannelError' }, `should reject ${String(bad)}`);
  }
});

test('allowAll / denyAll are deterministic hooks', async () => {
  assert.equal(await allowAll()({}), true);
  assert.equal(await denyAll()({}), false);
});

test('a hub requires a transport and an authorize hook (no implicit allow)', () => {
  assert.throws(() => new RealtimeHub({ transport: new InProcessTransport() }), { name: 'RealtimeChannelError' });
  assert.throws(() => new RealtimeHub({ authorize: allowAll() }), { name: 'RealtimeChannelError' });
});

test('a published typed envelope is delivered to matching subscribers only', async () => {
  const transport = new InProcessTransport();
  const hub = makeHub(transport);
  const room = defineChannel('room');
  const other = defineChannel('other');
  const gotRoom = [];
  const gotOther = [];
  await hub.subscribe(room, (payload) => { gotRoom.push(payload); }, { principal });
  await hub.subscribe(other, (payload) => { gotOther.push(payload); }, { principal });

  const result = await hub.publish(room, { text: 'hello' }, { principal });
  assert.ok(result.envelope.id);
  assert.equal(result.envelope.channel, 'room');
  assert.deepEqual(result.envelope.payload, { text: 'hello' });
  assert.deepEqual(gotRoom, [{ text: 'hello' }]);
  assert.deepEqual(gotOther, []);
  assert.ok(Object.isFrozen(result));
  await hub.close();
});

test('multiple subscribers all receive the same envelope (dedup is per-subscriber, not global)', async () => {
  const transport = new InProcessTransport();
  const hub = makeHub(transport);
  const ch = defineChannel('room');
  const a = [];
  const b = [];
  await hub.subscribe(ch, (p) => { a.push(p); }, { principal });
  await hub.subscribe(ch, (p) => { b.push(p); }, { principal });
  await hub.publish(ch, 7, { principal });
  assert.deepEqual(a, [7]);
  assert.deepEqual(b, [7]);
  await hub.close();
});

test('authorize hook receives principal, channel and action for publish/subscribe/deliver', async () => {
  const transport = new InProcessTransport();
  const seen = [];
  const hub = makeHub(transport, (ctx) => { seen.push({ action: ctx.action, channel: ctx.channel, hasEnvelope: ctx.envelope !== undefined }); return true; });
  const ch = defineChannel('metrics');
  await hub.subscribe(ch, () => {}, { principal });
  await hub.publish(ch, {}, { principal });
  const actions = seen.map((s) => s.action);
  assert.ok(actions.includes('subscribe'));
  assert.ok(actions.includes('publish'));
  assert.ok(actions.includes('deliver'));
  assert.ok(seen.some((s) => s.action === 'deliver' && s.hasEnvelope));
  await hub.close();
});

test('now() and generateId() are injectable for deterministic envelopes', async () => {
  const transport = new InProcessTransport();
  let seq = 0;
  const hub = makeHub(transport, allowAll(), { now: () => 1234, generateId: () => `id-${String(++seq)}` });
  const ch = defineChannel('det');
  const result = await hub.publish(ch, 'x', { principal });
  assert.equal(result.envelope.id, 'id-1');
  assert.equal(result.envelope.publishedAt, 1234);
  await hub.close();
});

test('transport publish failure is wrapped in RealtimeTransportError with cause', async () => {
  const failing = {
    isClosed: false,
    async publish() { throw new Error('socket down'); },
    subscribe() { return { closed: false, unsubscribe() {} }; },
    async close() {},
  };
  const hub = makeHub(failing);
  await assert.rejects(() => hub.publish(defineChannel('c'), 1, { principal }), (err) => {
    assert.equal(err.name, 'RealtimeTransportError');
    assert.equal(err.cause.message, 'socket down');
    return true;
  });
});

test('transport close failure is wrapped but the hub still becomes closed', async () => {
  const failing = {
    isClosed: false,
    async publish() {},
    subscribe() { return { closed: false, unsubscribe() {} }; },
    async close() { throw new Error('close failed'); },
  };
  const hub = makeHub(failing);
  await assert.rejects(() => hub.close(), { name: 'RealtimeTransportError' });
  assert.equal(hub.isClosed, true);
});

test('unsubscribe is idempotent and stops delivery', async () => {
  const transport = new InProcessTransport();
  const hub = makeHub(transport);
  const ch = defineChannel('room');
  const got = [];
  const sub = await hub.subscribe(ch, (p) => { got.push(p); }, { principal });
  assert.equal(transport.subscriberCount('room'), 1);
  await hub.publish(ch, 'first', { principal });
  sub.unsubscribe();
  sub.unsubscribe();
  assert.equal(sub.closed, true);
  assert.equal(transport.subscriberCount('room'), 0);
  await hub.publish(ch, 'second', { principal });
  assert.deepEqual(got, ['first']);
  await hub.close();
});

test('close() is idempotent, clears subscriptions and rejects later publish/subscribe', async () => {
  const transport = new InProcessTransport();
  const hub = makeHub(transport);
  const ch = defineChannel('room');
  await hub.subscribe(ch, () => {}, { principal });
  assert.equal(hub.subscriptionCount, 1);
  await hub.close();
  await hub.close();
  assert.equal(hub.isClosed, true);
  assert.equal(hub.subscriptionCount, 0);
  assert.equal(transport.isClosed, true);
  await assert.rejects(() => hub.publish(ch, 1, { principal }), { name: 'RealtimeClosedError' });
  await assert.rejects(() => hub.subscribe(ch, () => {}, { principal }), { name: 'RealtimeClosedError' });
});

test('metrics expose published/delivered/duplicates/rejected/failed counters', async () => {
  const transport = new InProcessTransport({ redeliveries: 2 });
  const hub = makeHub(transport);
  const ch = defineChannel('m');
  const got = [];
  await hub.subscribe(ch, (p) => { got.push(p); }, { principal });
  await hub.publish(ch, 'v', { principal });
  const m = hub.metrics;
  assert.equal(m.published, 1);
  assert.equal(m.delivered, 1);
  assert.equal(m.duplicates, 2);
  assert.deepEqual(got, ['v']);
  assert.ok(Object.isFrozen(m));
  await hub.close();
});

test('a failing subscriber is isolated; others still receive and the error is reported', async () => {
  const errors = [];
  const transport = new InProcessTransport();
  const hub = makeHub(transport, allowAll(), { onError: (e) => errors.push(e) });
  const ch = defineChannel('iso');
  const received = [];
  await hub.subscribe(ch, () => { throw new Error('handler boom'); }, { principal });
  await hub.subscribe(ch, (p) => { received.push(p); }, { principal });
  await hub.publish(ch, 'ok', { principal });
  assert.deepEqual(received, ['ok']);
  assert.equal(hub.metrics.delivered, 1);
  assert.equal(hub.metrics.failed, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'RealtimeDeliveryError');
  const drained = hub.drainErrors();
  assert.equal(drained.length, 1);
  assert.equal(hub.drainErrors().length, 0);
  await hub.close();
});

test('an authorize hook that throws is reported, not leaked into delivery', async () => {
  const transport = new InProcessTransport();
  const hub = makeHub(transport, (ctx) => {
    if (ctx.action === 'deliver') throw new Error('policy db down');
    return true;
  });
  const ch = defineChannel('p');
  const got = [];
  await hub.subscribe(ch, (p) => { got.push(p); }, { principal });
  await hub.publish(ch, 'x', { principal });
  assert.deepEqual(got, []);
  assert.equal(hub.drainErrors()[0].name, 'RealtimeAuthorizationError');
  await hub.close();
});

test('RealtimeHub exposes the error class family with stable codes', () => {
  assert.equal(new RealtimeChannelError('x').code, 'SX_REALTIME_CHANNEL');
  assert.equal(new RealtimeAuthorizationError('x').code, 'SX_REALTIME_AUTHORIZATION');
  assert.equal(new RealtimeClosedError('x').code, 'SX_REALTIME_CLOSED');
  assert.equal(new RealtimeTransportError('x').code, 'SX_REALTIME_TRANSPORT');
  assert.equal(new RealtimeDeliveryError('x').code, 'SX_REALTIME_DELIVERY');
});

test('denyAll blocks subscribe and publish', async () => {
  const transport = new InProcessTransport();
  const hub = makeHub(transport, denyAll());
  const ch = defineChannel('locked');
  await assert.rejects(() => hub.subscribe(ch, () => {}, { principal }), { name: 'RealtimeAuthorizationError' });
  await assert.rejects(() => hub.publish(ch, 1, { principal }), { name: 'RealtimeAuthorizationError' });
  await hub.close();
});
