import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedQueue,
  computeReconnectDelay,
  DEFAULT_RECONNECT,
  HeartbeatMonitor,
} from '../dist/connection.js';
import {
  RealtimeBackpressureError,
  RealtimeConnectionError,
} from '../dist/index.js';

test('connection: reconnect delay is capped exponential backoff with deterministic jitter', () => {
  const half = () => 0.5;
  assert.equal(computeReconnectDelay(0, {}, half), 200);
  assert.equal(computeReconnectDelay(1, {}, half), 400);
  assert.equal(computeReconnectDelay(2, {}, half), 800);
  assert.equal(computeReconnectDelay(5, {}, half), 6400);
  // 200 * 2^6 = 12800 -> capped at 10000, and stays capped for later attempts.
  assert.equal(computeReconnectDelay(6, {}, half), DEFAULT_RECONNECT.maxDelayMs);
  assert.equal(computeReconnectDelay(40, {}, half), DEFAULT_RECONNECT.maxDelayMs);

  // Full negative/positive jitter is symmetric and never negative.
  assert.equal(computeReconnectDelay(0, {}, () => 0), 160);
  assert.equal(computeReconnectDelay(0, {}, () => 1), 240);
  assert.equal(computeReconnectDelay(0, { jitterRatio: 0 }, () => 0), 200);
  assert.equal(computeReconnectDelay(0, { jitterRatio: 1 }, () => 0), 0);
  assert.ok(computeReconnectDelay(0, {}, () => 0) >= 0);

  // Custom options are honored.
  assert.equal(computeReconnectDelay(3, { initialDelayMs: 10, multiplier: 3, jitterRatio: 0 }, half), 270);
});

test('connection: reconnect options are validated instead of producing NaN timers', () => {
  const bad = [
    [-1, {}, 0.5],
    [1.5, {}, 0.5],
    [0, { initialDelayMs: -1 }, 0.5],
    [0, { initialDelayMs: 100, maxDelayMs: 50 }, 0.5],
    [0, { multiplier: 0.9 }, 0.5],
    [0, { jitterRatio: 1.1 }, 0.5],
    [0, { jitterRatio: -0.1 }, 0.5],
  ];
  for (const [attempt, options, random] of bad) {
    assert.throws(
      () => computeReconnectDelay(attempt, options, random),
      (error) => error instanceof RealtimeConnectionError,
    );
  }
});

test('connection: bounded queue enforces all three overflow policies', () => {
  const strict = new BoundedQueue(2, 'error');
  assert.equal(strict.push('a'), 'ok');
  assert.equal(strict.push('b'), 'ok');
  assert.equal(strict.size, 2);
  assert.throws(() => strict.push('c'), (error) => error instanceof RealtimeBackpressureError);
  assert.deepEqual(strict.drain(), ['a', 'b']);
  assert.equal(strict.size, 0);
  assert.equal(strict.dropped, 0);

  const dropOldest = new BoundedQueue(2, 'drop-oldest');
  dropOldest.push('a');
  dropOldest.push('b');
  assert.equal(dropOldest.push('c'), 'dropped-oldest');
  assert.deepEqual(dropOldest.drain(), ['b', 'c']);
  assert.equal(dropOldest.dropped, 1);

  const dropNewest = new BoundedQueue(2, 'drop-newest');
  dropNewest.push('a');
  dropNewest.push('b');
  assert.equal(dropNewest.push('c'), 'dropped-newest');
  assert.deepEqual(dropNewest.drain(), ['a', 'b']);
  assert.equal(dropNewest.dropped, 1);

  const cleared = new BoundedQueue(4);
  cleared.push('x');
  cleared.clear();
  assert.equal(cleared.size, 0);
  assert.deepEqual(cleared.drain(), []);

  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new BoundedQueue(size), (error) => error instanceof RealtimeConnectionError);
  }
});

test('connection: heartbeat monitor tracks liveness with an injected clock and scheduler', () => {
  let clock = 1000;
  let scheduled = 0;
  let intervalSeen = -1;
  let cancelled = 0;
  let tickCallback;
  const schedule = (callback, ms) => {
    scheduled += 1;
    intervalSeen = ms;
    tickCallback = callback;
    return () => { cancelled += 1; };
  };
  let pings = 0;
  let timeouts = 0;
  const monitor = new HeartbeatMonitor({
    intervalMs: 100,
    timeoutMs: 300,
    now: () => clock,
    schedule,
    onPing: () => { pings += 1; },
    onTimeout: () => { timeouts += 1; },
  });

  assert.equal(monitor.running, false);
  assert.equal(monitor.timeouts, 0);
  monitor.start();
  assert.equal(monitor.running, true);
  assert.equal(scheduled, 1);
  assert.equal(intervalSeen, 100);
  // start() is idempotent.
  monitor.start();
  assert.equal(scheduled, 1);

  tickCallback();
  assert.equal(pings, 1);
  assert.equal(timeouts, 0);

  clock = 1300;
  tickCallback();
  assert.equal(monitor.timeouts, 1);
  assert.equal(timeouts, 1);
  assert.equal(pings, 1);

  // Activity resets the liveness window.
  monitor.noteActivity();
  tickCallback();
  assert.equal(monitor.timeouts, 1);
  assert.equal(pings, 2);

  // A timed-out observer is contained; liveness tracking continues.
  clock = 1600;
  tickCallback();
  assert.equal(monitor.timeouts, 2);

  monitor.stop();
  assert.equal(monitor.running, false);
  assert.equal(cancelled, 1);
  clock = 9999;
  tickCallback();
  assert.equal(monitor.timeouts, 2);
});

test('connection: heartbeat observer failures never break the monitor', () => {
  let clock = 0;
  let tickCallback;
  const monitor = new HeartbeatMonitor({
    intervalMs: 10,
    timeoutMs: 20,
    now: () => clock,
    schedule: (callback) => { tickCallback = callback; return () => {}; },
    onPing: () => { throw new Error('ping observer exploded'); },
    onTimeout: () => { throw new Error('timeout observer exploded'); },
  });
  monitor.start();
  assert.doesNotThrow(() => tickCallback());
  clock = 100;
  assert.doesNotThrow(() => tickCallback());
  assert.equal(monitor.timeouts, 1);
});

test('connection: heartbeat options are validated', () => {
  assert.throws(
    () => new HeartbeatMonitor({ intervalMs: 0 }),
    (error) => error instanceof RealtimeConnectionError,
  );
  assert.throws(
    () => new HeartbeatMonitor({ intervalMs: 100, timeoutMs: 50 }),
    (error) => error instanceof RealtimeConnectionError,
  );
});
