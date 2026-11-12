import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Worker,
  JobsError,
  JobsValidationError,
  JobsConfigurationError,
  JobsStoreError,
  JobsSerializationError,
  JobsClosedError,
} from '../../dist/index.js';
import { InMemoryJobQueue } from '../../dist/in-memory.js';
import { serializeJobPayload, deserializeJobPayload, encodeJobRecord, decodeJobRecord, JOBS_ENVELOPE_PREFIX } from '../../dist/serialization.js';
import { validateTableName, validateJobId, validateDedupeKey } from '../../dist/validation.js';
import { JobRegistry } from '../../dist/registry.js';
import { RedisJobQueue } from '../../dist/redis.js';
import { SqlJobQueue } from '../../dist/sql.js';

function recordingExecutor() {
  const calls = [];
  const executor = {
    query: async (sql, parameters = []) => { calls.push({ sql, parameters }); return { rows: [], rowCount: 1 }; },
    transaction: async (callback) => callback(executor),
  };
  return { executor, calls };
}

test('SEC-6-1: payload envelope rejects prototype-pollution keys and never mutates Object.prototype', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
  assert.throws(() => serializeJobPayload(hostile), { name: 'JobsSerializationError' });
  const decoded = deserializeJobPayload(`${JOBS_ENVELOPE_PREFIX}j{"__proto__":{"polluted":true},"ok":1}`);
  assert.deepEqual(decoded, { ok: 1 });
  assert.equal(Object.prototype.polluted, undefined);
});

test('SEC-6-2: corrupt, legacy and tampered persisted records are rejected, never coerced', () => {
  const base = {
    v: 1, id: 'j1', name: 'x', payload: serializeJobPayload(1), status: 'pending',
    attempts: 0, maxAttempts: 3, createdAt: 0, availableAt: 0,
    dedupeKey: undefined, lastError: undefined,
  };
  for (const bad of [
    { ...base, v: 2 }, { ...base, status: 'bogus' }, { ...base, id: 9 },
    { ...base, payload: 'plaintext' }, { ...base, attempts: -1 },
  ]) {
    assert.throws(() => decodeJobRecord(encodeJobRecord(bad)), { name: 'JobsSerializationError' });
  }
  assert.throws(() => decodeJobRecord('{"v":1}'), { name: 'JobsSerializationError' });
  assert.ok(JobsSerializationError);
});

test('SEC-6-3: tableName / jobId / dedupeKey validation blocks injection surfaces', () => {
  for (const bad of ['jobs; DROP TABLE users', 'jobs--', '1jobs', '', 'a'.repeat(49), 'jobs x']) {
    assert.throws(() => validateTableName(bad), { name: 'JobsValidationError' });
  }
  for (const bad of ['', 'x\n', 'x\0y', 'a'.repeat(257), 7]) {
    assert.throws(() => validateJobId(bad), { name: 'JobsValidationError' });
  }
  for (const bad of ['', 'a'.repeat(257), 7]) {
    assert.throws(() => validateDedupeKey(bad), { name: 'JobsValidationError' });
  }
  assert.doesNotThrow(() => validateDedupeKey('../../etc/passwd'), 'opaque bounded keys stay inert');
});

test('SEC-6-4: SQL is fully parameterized — user payload never appears in statement text', async () => {
  const { executor, calls } = recordingExecutor();
  const queue = new SqlJobQueue(executor, { dialect: 'postgres', tableName: 'p6_sec', now: () => 0 });
  const attack = "'; DROP TABLE users; --";
  await queue.enqueue({ name: 'email.send', payload: { note: attack }, dedupeKey: attack }, 0);
  assert.ok(calls.length >= 3);
  const statements = calls.map((c) => c.sql).join('\n');
  assert.equal(statements.includes('DROP TABLE users'), false, 'payload must never be interpolated into SQL');
  assert.ok(calls.some((c) => c.parameters.some((p) => typeof p === 'string' && p.includes('DROP TABLE users'))));
  assert.ok(calls.some((c) => c.sql.includes('$1')), 'postgres dialect renders $n placeholders');
  await queue.close();
});

test('SEC-6-5: Redis keyPrefix and SQL dialect/executor config are validated before any client exists', () => {
  assert.throws(() => new RedisJobQueue({ keyPrefix: 'bad\nprefix' }), { name: 'JobsConfigurationError' });
  assert.throws(() => new RedisJobQueue({ keyPrefix: 'a'.repeat(129) }), { name: 'JobsConfigurationError' });
  assert.throws(() => new SqlJobQueue(null, {}), { name: 'JobsConfigurationError' });
  assert.throws(() => new SqlJobQueue(recordingExecutor().executor, { dialect: 'oracle' }), { name: 'JobsConfigurationError' });
  assert.throws(() => new SqlJobQueue(recordingExecutor().executor, { tableName: 'x;--' }), { name: 'JobsValidationError' });
});

test('SEC-6-6: a closed queue rejects every operation; cancel is part of the JobQueue contract', async () => {
  const queue = new InMemoryJobQueue();
  const result = await queue.enqueue({ name: 'x', payload: 1 }, 0);
  assert.equal(typeof queue.cancel, 'function');
  await queue.close();
  await assert.rejects(() => queue.enqueue({ name: 'y', payload: 2 }, 1), { name: 'JobsClosedError' });
  await assert.rejects(() => queue.claim(1, 1), { name: 'JobsClosedError' });
  // In-memory snapshots stay readable after close; durable backends reject reads after close.
  assert.equal((await queue.get(result.job.id)).status, 'pending');
  await queue.close();
  assert.ok(JobsClosedError);
});

test('SEC-6-7: complete / fail / cancel are idempotent and dead jobs cannot be resurrected', async () => {
  const queue = new InMemoryJobQueue();
  const { job } = await queue.enqueue({ name: 'x', payload: 1, maxAttempts: 1 }, 0);
  const [claimed] = await queue.claim(0, 1);
  await queue.fail(claimed.id, { error: 'boom' });
  await queue.fail(claimed.id, { error: 'retry?', retryAt: 5 });
  await queue.complete(claimed.id);
  assert.equal((await queue.get(job.id)).status, 'dead');
  assert.equal(await queue.cancel(job.id), false);
  assert.equal((await queue.claim(100, 10)).length, 0);
  await queue.close();
});

test('SEC-6-8: unregistered job names dead-letter through the worker instead of being dropped', async () => {
  const queue = new InMemoryJobQueue();
  const registry = new JobRegistry();
  const errors = [];
  const worker = new Worker({
    queue,
    now: () => 0,
    handler: registry.createHandler(),
    onError: (error) => errors.push(error.code),
    backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 1 },
  });
  await queue.enqueue({ name: 'unknown.job', payload: 1, maxAttempts: 1 }, 0);
  const tick = await worker.tick(0);
  assert.equal(tick.dead, 1);
  assert.deepEqual(errors, ['SX_JOBS_UNREGISTERED']);
  await worker.stop();
  await queue.close();
});

test('SEC-6-9: oversized payloads and invalid fail options are rejected before any I/O', async () => {
  const queue = new InMemoryJobQueue();
  assert.throws(() => serializeJobPayload('x'.repeat(70 * 1024)), { name: 'JobsSerializationError' });
  await assert.rejects(
    () => queue.fail('id', { error: 7 }),
    { name: 'JobsValidationError' },
  );
  await assert.rejects(
    () => queue.enqueue({ name: 'x', payload: 1 }, Number.NaN),
    { name: 'JobsValidationError' },
  );
  await queue.close();
});

test('SEC-6-10: JobsStoreError preserves operation and cause for safe diagnostics', () => {
  const cause = new Error('driver exploded');
  const error = new JobsStoreError('SQL claim failed.', 'claim', { cause });
  assert.equal(error.operation, 'claim');
  assert.equal(error.cause, cause);
  assert.ok(error instanceof JobsError);
  assert.ok(JobsValidationError);
  assert.ok(JobsConfigurationError);
});
