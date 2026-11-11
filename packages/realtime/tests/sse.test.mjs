import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import {
  allowAnonymous,
  createSseGateway,
  SseClientTransport,
} from '../dist/sse.js';
import { defineChannel, RealtimeHub, allowAll } from '../dist/index.js';
import {
  RealtimeConnectionError,
  RealtimeProtocolError,
} from '../dist/index.js';
import { encodeWireMessage } from '../dist/protocol.js';
import { readSseFrames, waitFor } from './helpers.mjs';

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

function frameId(frame) {
  const line = frame.split('\n').find((candidate) => candidate.startsWith('id:'));
  return line === undefined ? undefined : line.slice(3).trim();
}

test('sse: two hubs exchange real HTTP/SSE frames through a standalone gateway', async (t) => {
  const gateway = await createSseGateway({
    authenticate: allowAnonymous(),
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());

  const a = new SseClientTransport({ url: gateway.url, ...fastHeartbeat });
  const b = new SseClientTransport({ url: gateway.url, ...fastHeartbeat });
  t.after(async () => { await a.close(); await b.close(); });
  await waitFor(() => a.state === 'open' && b.state === 'open');

  const hubA = new RealtimeHub({ transport: a, authorize: allowAll() });
  const hubB = new RealtimeHub({ transport: b, authorize: allowAll() });
  const channel = defineChannel('chat:sse');

  const received = [];
  const sub = await hubB.subscribe(channel, (payload) => { received.push(payload); }, { principal: { id: 'u2' } });
  await waitFor(() => gateway.subscriptionCount('chat:sse') === 1);

  await hubA.publish(channel, { text: 'hello', from: 'u1' }, { principal: { id: 'u1' } });
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], { text: 'hello', from: 'u1' });
  assert.equal(typeof b.lastEventId, 'string');
  assert.equal(gateway.connectionCount, 2);
  assert.ok(gateway.metrics.messagesIn >= 1);
  assert.ok(gateway.metrics.messagesOut >= 1);

  sub.unsubscribe();
  await waitFor(() => gateway.subscriptionCount('chat:sse') === 0);
  await hubA.close();
  await hubB.close();
});

test('sse: gateway denies unauthenticated requests by default', async (t) => {
  const gateway = await createSseGateway();
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.url}/events?clientId=c1`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(response.status, 401);
  await response.body?.cancel();
  await waitFor(() => gateway.metrics.authFailures === 1);
  assert.equal(gateway.connectionCount, 0);
});

test('sse: gateway rejects invalid client ids, channels and frames with 4xx', async (t) => {
  const gateway = await createSseGateway({ authenticate: allowAnonymous(), ...fastHeartbeat });
  t.after(() => gateway.close());
  const base = gateway.url;

  const badClient = await fetch(`${base}/events?clientId=../evil`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(badClient.status, 400);
  await badClient.body?.cancel();

  const badChannel = await fetch(`${base}/subscribe?clientId=c1&channel=../admin`, { method: 'POST' });
  assert.equal(badChannel.status, 400);

  const badFrame = await fetch(`${base}/publish?clientId=c1`, { method: 'POST', body: '{not json' });
  assert.equal(badFrame.status, 400);

  const wrongTag = await fetch(`${base}/publish?clientId=c1`, {
    method: 'POST',
    body: encodeWireMessage({ t: 'sub', channel: 'chat:sse' }),
  });
  assert.equal(wrongTag.status, 400);

  assert.ok(gateway.metrics.rejected >= 3);
});

test('sse: gateway enforces the publish byte limit with 413', async (t) => {
  const gateway = await createSseGateway({
    authenticate: allowAnonymous(),
    maxMessageBytes: 256,
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.url}/publish?clientId=c1`, {
    method: 'POST',
    body: 'x'.repeat(300),
  });
  assert.equal(response.status, 413);
  assert.ok(gateway.metrics.rejected >= 1);
});

test('sse: Last-Event-ID replays only missed frames for subscribed channels', async (t) => {
  const gateway = await createSseGateway({
    authenticate: allowAnonymous(),
    replayBufferSize: 16,
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());
  const base = gateway.url;
  const cid = 'replay-client';

  const subscribe = await fetch(`${base}/subscribe?clientId=${cid}&channel=chat:replay`, { method: 'POST' });
  assert.equal(subscribe.status, 204);

  const publish = (id) => fetch(`${base}/publish?clientId=${cid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: encodeWireMessage({ t: 'pub', envelope: envelope(id, 'chat:replay', { n: id }) }),
  });

  const first = new AbortController();
  const stream = await fetch(`${base}/events?clientId=${cid}`, {
    signal: first.signal,
    headers: { Accept: 'text/event-stream' },
  });
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal((await publish('ev-1')).status, 204);
  assert.equal((await publish('ev-2')).status, 204);
  const frames = await readSseFrames(stream, 2);
  assert.equal(frames.length, 2);
  const firstId = frameId(frames[0]);
  assert.equal(firstId, 'ev-1');
  assert.equal(frameId(frames[1]), 'ev-2');
  first.abort();

  // Reconnect from ev-1: only ev-2 should be replayed, on the still-registered channel.
  const second = new AbortController();
  const replayStream = await fetch(`${base}/events?clientId=${cid}`, {
    signal: second.signal,
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': firstId },
  });
  const replayed = await readSseFrames(replayStream, 1);
  assert.equal(replayed.length, 1);
  assert.match(replayed[0], /ev-2/);
  assert.ok(!replayed[0].includes('ev-1'));
  assert.ok(gateway.metrics.replays >= 1);
  second.abort();
});

test('sse: keepalive comments keep the event stream alive', async (t) => {
  const gateway = await createSseGateway({
    authenticate: allowAnonymous(),
    heartbeatIntervalMs: 25,
  });
  t.after(() => gateway.close());
  const controller = new AbortController();
  const stream = await fetch(`${gateway.url}/events?clientId=keepalive-client`, {
    signal: controller.signal,
    headers: { Accept: 'text/event-stream' },
  });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!buffer.includes(': keepalive')) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
    }
  } finally {
    controller.abort();
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  assert.match(buffer, /: keepalive/);
});

test('sse: reconnect replays subscriptions and drains queued publishes', async (t) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}/realtime`;
  const client = new SseClientTransport({
    url,
    ...fastHeartbeat,
    reconnect: { initialDelayMs: 30, maxDelayMs: 60, jitterRatio: 0, maxAttempts: 30 },
    random: () => 0.5,
  });
  t.after(() => client.close());

  const selfReceived = [];
  client.subscribe('chat:sse-reconnect', (env) => { selfReceived.push(env.payload); });
  await client.publish(envelope('queued-1', 'chat:sse-reconnect', { n: 1 }));
  assert.ok(client.queued >= 1, 'publish is queued while the stream is down');
  await waitFor(() => client.reconnectAttempts >= 1);

  const gateway = await createSseGateway({
    port,
    authenticate: allowAnonymous(),
    ...fastHeartbeat,
  });
  t.after(() => gateway.close());

  const receiver = new SseClientTransport({ url: gateway.url, ...fastHeartbeat });
  t.after(() => receiver.close());
  const seen = [];
  receiver.subscribe('chat:sse-reconnect', (env) => seen.push(env.payload));
  await waitFor(() => client.state === 'open' && receiver.state === 'open');
  await waitFor(() => gateway.subscriptionCount('chat:sse-reconnect') === 2);
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen[0], { n: 1 });
  assert.deepEqual(selfReceived[0], { n: 1 });
  assert.equal(client.queued, 0, 'the queue drained after reconnect');
});

test('sse: backpressure queue stays bounded with drop-oldest', async (t) => {
  const client = new SseClientTransport({
    url: 'http://127.0.0.1:9/realtime',
    maxQueuedMessages: 2,
    overflow: 'drop-oldest',
    ...fastHeartbeat,
    reconnect: { maxAttempts: 1, initialDelayMs: 10, jitterRatio: 0 },
    random: () => 0.5,
  });
  t.after(() => client.close());
  for (let i = 0; i < 6; i += 1) {
    await client.publish(envelope(`bp-${String(i)}`, 'backpressure', i));
  }
  assert.ok(client.queued <= 2);
  assert.notEqual(client.state, 'open');
});

test('sse: transport rejects oversized outgoing frames before posting', async (t) => {
  const gateway = await createSseGateway({ authenticate: allowAnonymous(), ...fastHeartbeat });
  t.after(() => gateway.close());
  const client = new SseClientTransport({ url: gateway.url, maxMessageBytes: 128, ...fastHeartbeat });
  t.after(() => client.close());
  await assert.rejects(
    () => client.publish(envelope('big', 'a', 'y'.repeat(300))),
    (error) => error instanceof RealtimeProtocolError,
  );
});

test('sse: transport close is idempotent and later operations are rejected', async (t) => {
  const gateway = await createSseGateway({ authenticate: allowAnonymous(), ...fastHeartbeat });
  t.after(() => gateway.close());
  const client = new SseClientTransport({ url: gateway.url, ...fastHeartbeat });
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
