import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';
import {
  allowAnonymous,
  attachWebSocketGateway,
  createWebSocketGateway,
  WebSocketClientTransport,
} from '../dist/websocket.js';
import { defineChannel, RealtimeHub, allowAll } from '../dist/index.js';
import { RealtimeConnectionError } from '../dist/index.js';
import {
  decodeWireMessage,
  encodeWireMessage,
  REALTIME_PROTOCOL_VERSION,
} from '../dist/protocol.js';
import { waitFor } from './helpers.mjs';

const envelope = (id, channel, payload) => Object.freeze({
  id,
  channel,
  payload,
  publishedAt: 1700000000000,
});

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const fastHeartbeat = { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 4000 };

test('websocket: two hubs exchange real TCP frames through a standalone gateway', async (t) => {
  const gateway = await createWebSocketGateway({
    authenticate: allowAnonymous(),
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());

  const a = new WebSocketClientTransport({
    url: gateway.url,
    ...fastHeartbeat,
    reconnect: { maxAttempts: 3, initialDelayMs: 20 },
  });
  const b = new WebSocketClientTransport({
    url: gateway.url,
    ...fastHeartbeat,
    reconnect: { maxAttempts: 3, initialDelayMs: 20 },
  });
  t.after(async () => { await a.close(); await b.close(); });
  await waitFor(() => a.state === 'open' && b.state === 'open');

  const hubA = new RealtimeHub({ transport: a, authorize: allowAll() });
  const hubB = new RealtimeHub({ transport: b, authorize: allowAll() });
  const chat = defineChannel('chat:general');

  const received = [];
  const sub = await hubB.subscribe(chat, (payload) => { received.push(payload); }, { principal: { id: 'u2' } });
  await waitFor(() => gateway.subscriptionCount('chat:general') === 1);

  await hubA.publish(chat, { text: 'hello', from: 'u1' }, { principal: { id: 'u1' } });
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], { text: 'hello', from: 'u1' });
  assert.equal(gateway.connectionCount, 2);
  assert.ok(gateway.metrics.messagesIn >= 1);
  assert.ok(gateway.metrics.messagesOut >= 1);

  sub.unsubscribe();
  await hubA.close();
  await hubB.close();
});

test('websocket: gateway denies unauthenticated sockets by default', async (t) => {
  // No `authenticate` supplied -> denyAnonymous(), the safe default.
  const gateway = await createWebSocketGateway();
  t.after(() => gateway.close());

  const socket = new WebSocket(gateway.url);
  const outcome = await new Promise((resolve) => {
    socket.once('close', (code) => resolve({ type: 'close', code }));
    socket.once('message', (data) => resolve({ type: 'message', data: data.toString('utf8') }));
    socket.once('error', () => resolve({ type: 'error' }));
  });
  assert.equal(outcome.type, 'close');
  assert.equal(outcome.code, 1008);
  await waitFor(() => gateway.metrics.authFailures === 1);
  assert.equal(gateway.connectionCount, 0);
  socket.terminate();
});

test('websocket: gateway authenticator gates on the request URL and sends a versioned ready frame', async (t) => {
  const gateway = await createWebSocketGateway({
    path: '/rt',
    authenticate: ({ url }) => url.searchParams.get('token') === 'secret',
  });
  t.after(() => gateway.close());

  const bad = new WebSocket(`${gateway.url}?token=wrong`);
  const badOutcome = await new Promise((resolve) => {
    bad.once('close', (code) => resolve({ type: 'close', code }));
    bad.once('message', () => resolve({ type: 'message' }));
    bad.once('error', () => resolve({ type: 'error' }));
  });
  assert.equal(badOutcome.type, 'close');
  assert.equal(badOutcome.code, 1008);
  bad.terminate();

  const good = new WebSocket(`${gateway.url}?token=secret`);
  const frames = [];
  good.on('message', (data) => frames.push(data.toString('utf8')));
  await waitFor(() => frames.length >= 1);
  const ready = decodeWireMessage(frames[0], 'server');
  assert.equal(ready.t, 'ready');
  assert.equal(ready.protocol, REALTIME_PROTOCOL_VERSION);
  assert.equal(gateway.connectionCount, 1);
  good.terminate();
  await gateway.close();
});

test('websocket: reconnect replays subscriptions and drains queued publishes', async (t) => {
  const port = await freePort();
  const url = `ws://127.0.0.1:${String(port)}/realtime`;
  const client = new WebSocketClientTransport({
    url,
    ...fastHeartbeat,
    reconnect: { initialDelayMs: 30, maxDelayMs: 60, jitterRatio: 0, maxAttempts: 30 },
    random: () => 0.5,
    connectTimeoutMs: 1000,
  });
  t.after(() => client.close());

  const selfReceived = [];
  client.subscribe('chat:reconnect', (env) => { selfReceived.push(env.payload); });
  await client.publish(envelope('queued-1', 'chat:reconnect', { n: 1 }));
  assert.ok(client.queued >= 1, 'publish is queued while the connection is down');
  await waitFor(() => client.reconnectAttempts >= 1);

  const gateway = await createWebSocketGateway({
    port,
    authenticate: allowAnonymous(),
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());

  const receiver = new WebSocketClientTransport({
    url: gateway.url,
    ...fastHeartbeat,
    reconnect: { maxAttempts: 3, initialDelayMs: 20 },
  });
  t.after(() => receiver.close());
  const seen = [];
  receiver.subscribe('chat:reconnect', (env) => seen.push(env.payload));
  await waitFor(() => client.state === 'open' && receiver.state === 'open');
  await waitFor(() => gateway.subscriptionCount('chat:reconnect') === 2);
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen[0], { n: 1 });
  assert.deepEqual(selfReceived[0], { n: 1 });
  assert.equal(client.queued, 0, 'the queue drained after reconnect');
});

test('websocket: backpressure queue stays bounded and drop-newest never throws', async (t) => {
  const client = new WebSocketClientTransport({
    url: 'ws://127.0.0.1:9/realtime',
    maxQueuedMessages: 2,
    overflow: 'drop-newest',
    ...fastHeartbeat,
    reconnect: { maxAttempts: 1, initialDelayMs: 10, jitterRatio: 0 },
    connectTimeoutMs: 300,
    random: () => 0.5,
  });
  t.after(() => client.close());
  for (let i = 0; i < 6; i += 1) {
    await client.publish(envelope(`bp-${String(i)}`, 'backpressure', i));
  }
  assert.ok(client.queued <= 2);
  assert.notEqual(client.state, 'open');
});

test('websocket: gateway terminates sockets that miss heartbeats', async (t) => {
  let clock = 0;
  const gateway = await createWebSocketGateway({
    authenticate: allowAnonymous(),
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 40,
    now: () => clock,
  });
  t.after(() => gateway.close());

  const socket = new WebSocket(gateway.url);
  await new Promise((resolve) => socket.once('open', resolve));
  await waitFor(() => gateway.connectionCount === 1);
  // A raw socket never answers the gateway's ping frames.
  clock = 100;
  await waitFor(() => gateway.metrics.heartbeatTimeouts >= 1, { timeoutMs: 2000 });
  assert.equal(gateway.connectionCount, 0);
  socket.terminate();
});

test('websocket: malformed client frames are rejected with a redacted error frame', async (t) => {
  const gateway = await createWebSocketGateway({ authenticate: allowAnonymous(), ...fastHeartbeat });
  t.after(() => gateway.close());
  const socket = new WebSocket(gateway.url);
  const frames = [];
  socket.on('message', (data) => frames.push(data.toString('utf8')));
  await waitFor(() => frames.length >= 1, { timeoutMs: 2000 });

  socket.send('{not json');
  await waitFor(() => frames.length >= 2, { timeoutMs: 2000 });
  const errorFrame = decodeWireMessage(frames[1], 'server');
  assert.equal(errorFrame.t, 'error');
  assert.equal(errorFrame.code, 'SX_REALTIME_PROTOCOL');
  assert.equal(errorFrame.message, 'The realtime frame was rejected.');
  assert.ok(!JSON.stringify(errorFrame).includes('not json'));
  assert.ok(gateway.metrics.rejected >= 1);

  socket.send(encodeWireMessage({ t: 'msg', envelope: envelope('forged', 'chat:general', {}) }));
  await waitFor(() => frames.length >= 3, { timeoutMs: 2000 });
  assert.equal(decodeWireMessage(frames[2], 'server').t, 'error');
  socket.terminate();
});

test('websocket: transport close is idempotent and later operations are rejected', async (t) => {
  const gateway = await createWebSocketGateway({ authenticate: allowAnonymous(), ...fastHeartbeat });
  t.after(() => gateway.close());
  const client = new WebSocketClientTransport({ url: gateway.url, ...fastHeartbeat });
  await waitFor(() => client.state === 'open');
  await client.close();
  await client.close();
  assert.equal(client.isClosed, true);
  assert.equal(client.state, 'closed');
  await assert.rejects(
    () => client.publish(envelope('late', 'a', 1)),
    (error) => error instanceof RealtimeConnectionError,
  );
  assert.throws(
    () => client.subscribe('a', () => {}),
    (error) => error instanceof RealtimeConnectionError,
  );
  await waitFor(() => gateway.connectionCount === 0);
});

test('websocket: attachWebSocketGateway reuses an existing HTTP server and path', async (t) => {
  const httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = address !== null && typeof address === 'object' ? address.port : -1;
  const gateway = attachWebSocketGateway(httpServer, { authenticate: allowAnonymous(), path: '/ws' });
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });
  assert.equal(gateway.port, port);
  assert.match(gateway.url, /\/ws$/);

  const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
  assert.equal(await response.text(), 'ok');

  const client = new WebSocketClientTransport({ url: gateway.url, ...fastHeartbeat });
  t.after(() => client.close());
  await waitFor(() => client.state === 'open');
  assert.equal(gateway.connectionCount, 1);
});
