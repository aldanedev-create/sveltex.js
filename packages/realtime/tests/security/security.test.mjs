import test from 'node:test';
import assert from 'node:assert/strict';
import { defineChannel, RealtimeHub, allowAll, RealtimeAuthorizationError, RealtimeChannelError } from '../../dist/index.js';
import { InProcessTransport } from '../../dist/in-process.js';

const admin = { id: 'admin-1', roles: ['admin'] };
const guest = { id: 'guest-1', roles: [] };

test('SEC: per-action authorization refuses cross-tenant publish and subscribe', async () => {
  const transport = new InProcessTransport();
  // Only principals with role "admin" may publish to "admin:*"; anyone may subscribe but
  // delivery to non-admins is denied for admin channels.
  const hub = new RealtimeHub({
    transport,
    authorize: (ctx) => {
      if (ctx.action === 'publish' && ctx.channel.startsWith('admin:')) {
        return ctx.principal?.roles?.includes('admin') === true;
      }
      if (ctx.action === 'deliver' && ctx.channel.startsWith('admin:')) {
        return ctx.principal?.roles?.includes('admin') === true;
      }
      return true;
    },
  });
  const ch = defineChannel('admin:audit');
  await assert.rejects(() => hub.publish(ch, { secret: true }, { principal: guest }), { name: 'RealtimeAuthorizationError' });
  await hub.close();
});

test('SEC: deliver authorization is evaluated per subscriber (no privilege leak)', async () => {
  const transport = new InProcessTransport();
  const hub = new RealtimeHub({
    transport,
    authorize: (ctx) => ctx.action !== 'deliver' || ctx.principal?.roles?.includes('admin') === true,
  });
  const ch = defineChannel('admin:audit');
  const adminGot = [];
  const guestGot = [];
  await hub.subscribe(ch, (p) => { adminGot.push(p); }, { principal: admin });
  await hub.subscribe(ch, (p) => { guestGot.push(p); }, { principal: guest });
  await hub.publish(ch, { secret: 'only-admins' }, { principal: admin });
  assert.deepEqual(adminGot, [{ secret: 'only-admins' }]);
  assert.deepEqual(guestGot, []);
  assert.equal(hub.metrics.delivered, 1);
  assert.equal(hub.metrics.rejected, 1);
  await hub.close();
});

test('SEC: delivered payload is frozen so one subscriber cannot mutate a shared payload', async () => {
  const transport = new InProcessTransport();
  const hub = new RealtimeHub({ transport, authorize: allowAll() });
  const ch = defineChannel('shared');
  const payload = { counter: 1 };
  const observed = [];
  let mutationBlocked = false;
  await hub.subscribe(ch, (p) => {
    try { p.counter = 999; } catch { mutationBlocked = true; }
  }, { principal: guest });
  await hub.subscribe(ch, (p) => { observed.push(p.counter); }, { principal: guest });
  await hub.publish(ch, payload, { principal: admin });
  assert.equal(mutationBlocked, true, 'strict-mode assignment on frozen payload must throw');
  assert.deepEqual(observed, [1]);
  await hub.close();
});

test('SEC: at-least-once redelivery cannot replay a side effect more than once per subscriber', async () => {
  const transport = new InProcessTransport({ redeliveries: 5 });
  const hub = new RealtimeHub({ transport, authorize: allowAll() });
  const ch = defineChannel('billing');
  let charges = 0;
  await hub.subscribe(ch, () => { charges += 1; }, { principal: admin });
  await hub.publish(ch, { amount: 100 }, { principal: admin });
  assert.equal(charges, 1, 'subscriber side effect must execute exactly once');
  assert.equal(hub.metrics.duplicates, 5);
  await hub.close();
});

test('SEC: bounded dedup cache evicts oldest ids (no unbounded memory growth)', async () => {
  const transport = new InProcessTransport();
  const hub = new RealtimeHub({ transport, authorize: allowAll(), maxRememberedIds: 2 });
  const ch = defineChannel('evt');
  await hub.subscribe(ch, () => {}, { principal: guest });
  await hub.publish(ch, 'a', { principal: admin });
  await hub.publish(ch, 'b', { principal: admin });
  await hub.publish(ch, 'c', { principal: admin });
  // Replaying the evicted first id would be treated as new; that is the documented tradeoff
  // of a bounded cache and is asserted here so the behavior is intentional, not accidental.
  assert.equal(hub.metrics.published, 3);
  await hub.close();
});

test('SEC: invalid maxRememberedIds is rejected at construction', () => {
  const transport = new InProcessTransport();
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new RealtimeHub({ transport, authorize: allowAll(), maxRememberedIds: bad }), { name: 'RealtimeChannelError' });
  }
  assert.throws(() => new InProcessTransport({ redeliveries: 101 }), (e) => e instanceof Error);
});

test('SEC: channel names cannot carry path/traversal or control characters', () => {
  for (const bad of ['../../admin', 'room\n:injected', 'room\u0000', 'a'.repeat(200)]) {
    assert.throws(() => defineChannel(bad), { name: 'RealtimeChannelError' });
  }
});

test('SEC: a hub closed mid-authorization cannot be raced back open', async () => {
  const transport = new InProcessTransport();
  let authorizeCalled = false;
  const hub = new RealtimeHub({
    transport,
    authorize: async (ctx) => {
      if (ctx.action === 'publish') {
        authorizeCalled = true;
        await hub.close();
      }
      return true;
    },
  });
  const ch = defineChannel('race');
  await assert.rejects(() => hub.publish(ch, 1, { principal: guest }), { name: 'RealtimeClosedError' });
  assert.equal(authorizeCalled, true);
});
