import {
  Worker,
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  JobsError,
  JobsValidationError,
  JobsClosedError,
  JobsSerializationError,
  JobsConfigurationError,
  JobsStoreError,
} from '../../dist/index.js';
import type {
  Job,
  JobStatus,
  JobQueue,
  EnqueueOptions,
  EnqueueResult,
  FailOptions,
  BackoffPolicy,
  JobContext,
  JobHandler,
  WorkerOptions,
  WorkerTickResult,
  WorkerMetrics,
} from '../../dist/index.js';
import { InMemoryJobQueue } from '../../dist/in-memory.js';
import type { InMemoryJobQueueOptions } from '../../dist/in-memory.js';
import { RedisJobQueue } from '../../dist/redis.js';
import type { RedisJobQueueOptions } from '../../dist/redis.js';
import { SqlJobQueue } from '../../dist/sql.js';
import type {
  SqlJobQueueOptions,
  JobSqlDialect,
  JobSqlExecutor,
  JobSqlQueryExecutor,
  JobSqlResult,
  JobSqlValue,
} from '../../dist/sql.js';
import { JobRegistry } from '../../dist/registry.js';
import { JobScheduler, computeDelayMs } from '../../dist/scheduler.js';
import type { JobSchedulerOptions } from '../../dist/scheduler.js';
import {
  serializeJobPayload,
  deserializeJobPayload,
  encodeJobRecord,
  decodeJobRecord,
  decodeJob,
  JOBS_ENVELOPE_PREFIX,
  JOBS_ENVELOPE_VERSION,
  MAX_PAYLOAD_BYTES,
  MAX_RECORD_BYTES,
} from '../../dist/serialization.js';
import type { JobRecord } from '../../dist/serialization.js';
import {
  validateJobName,
  validateEnqueueOptions,
  validateClaim,
  validateFailOptions,
  validateJobId,
  validateTableName,
  validateDedupeKey,
  validateTimestamp,
  JOB_NAME_PATTERN,
  MAX_JOB_ID_LENGTH,
  MAX_DEDUPE_KEY_LENGTH,
  MAX_ERROR_LENGTH,
} from '../../dist/validation.js';
import type { ValidatedEnqueue, ValidatedFail } from '../../dist/validation.js';

const opts: InMemoryJobQueueOptions = { generateId: () => 'id' };
const queue: JobQueue = new InMemoryJobQueue(opts);
void opts;

const enqueue: EnqueueOptions<{ to: string }> = { name: 'email', payload: { to: 'a@b.com' }, maxAttempts: 3 };
const result: Promise<EnqueueResult> = queue.enqueue(enqueue, 0);
const job: Promise<Job | undefined> = queue.get('id');
const jobs: Promise<readonly Job[]> = queue.list();
const fail: Promise<void> = queue.fail('id', { error: 'x', retryAt: 10 } satisfies FailOptions);
const complete: Promise<void> = queue.complete('id');
const closed: Promise<void> = queue.close();
void [result, job, jobs, fail, complete, closed, queue.isClosed];

const status: JobStatus = 'pending';
void status;

const policy: BackoffPolicy = DEFAULT_BACKOFF;
const delay: number = computeBackoffDelay(3, policy);
void delay;

const handler: JobHandler = (j: Job, ctx: JobContext) => {
  const attempts: number = ctx.attempts;
  const signal: AbortSignal = ctx.signal;
  void [j, attempts, signal];
};
const workerOptions: WorkerOptions = { queue, handler, concurrency: 2, now: () => 0 };
const worker: Worker = new Worker(workerOptions);
const tick: Promise<WorkerTickResult> = worker.tick(0);
const metrics: WorkerMetrics = worker.metrics;
const running: boolean = worker.isRunning;
const stopped: Promise<void> = worker.stop();
worker.start();
void [tick, metrics, running, stopped];

const err: JobsError = new JobsValidationError('bad');
const code: string = err.code;
void code;
void new JobsClosedError('closed');

// @ts-expect-error the handler is required
void new Worker({ queue });

// ---------------------------------------------------------------------------
// Phase 6 — durable backends, strict serialization, registry and scheduling.
// ---------------------------------------------------------------------------
const cancel: Promise<boolean> = queue.cancel('id');
void cancel;

const redisOptions: RedisJobQueueOptions = {
  url: 'redis://127.0.0.1:6379',
  keyPrefix: 'p6:',
  connectTimeoutMs: 10_000,
  maxRetriesPerRequest: 3,
  now: () => 0,
  generateId: () => 'id',
};
const redis = new RedisJobQueue(redisOptions);
const redisQueue: JobQueue = redis;
const redisConnect: Promise<void> = redis.connect();
const redisPrefix: string = redis.keyPrefix;
void [redisOptions, redisQueue, redisConnect, redisPrefix];

declare const sqlExecutor: JobSqlExecutor;
declare const queryExecutor: JobSqlQueryExecutor;
const sqlOptions: SqlJobQueueOptions = { tableName: 'sveltex_jobs', dialect: 'postgres', now: () => 0 };
const sql = new SqlJobQueue(sqlExecutor, sqlOptions);
const sqlQueue: JobQueue = sql;
const ddl: readonly string[] = sql.schemaStatements();
const ensure: Promise<void> = sql.ensureSchema();
const dialect: JobSqlDialect = sql.dialect;
const sqlTable: string = sql.tableName;
const sqlValue: JobSqlValue = 'x';
const sqlResult: JobSqlResult<{ id: string }> = Object.freeze({
  rows: Object.freeze([{ id: 'x' }]),
  rowCount: 1,
});
void [queryExecutor, sqlOptions, sqlQueue, ddl, ensure, dialect, sqlTable, sqlValue, sqlResult];

const registry = new JobRegistry();
registry.register('email.send', async (job, ctx) => { void [job, ctx]; });
const registered: boolean = registry.has('email.send');
const names: readonly string[] = registry.names();
const routed: JobHandler = registry.createHandler();
void [registry, registered, names, routed];

const schedOptions: JobSchedulerOptions = { now: () => 0 };
const scheduler = new JobScheduler(sqlQueue, schedOptions);
const scheduleDelay: number = computeDelayMs(1000, 0);
const scheduledAt: Promise<EnqueueResult> = scheduler.scheduleAt({ name: 'x', payload: 1 }, 1000, 0);
const scheduledIn: Promise<EnqueueResult> = scheduler.scheduleIn({ name: 'x', payload: 1 }, 50, 0);
const scheduledNow: Promise<EnqueueResult> = scheduler.enqueue({ name: 'x', payload: 1 }, 0);
void [schedOptions, scheduler, scheduleDelay, scheduledAt, scheduledIn, scheduledNow];

const wire: string = serializeJobPayload({ a: 1 });
const roundTrip: unknown = deserializeJobPayload(wire);
const jobRecord: JobRecord = Object.freeze({
  v: 1,
  id: 'id',
  name: 'x',
  payload: wire,
  status: 'pending',
  attempts: 0,
  maxAttempts: 3,
  createdAt: 0,
  availableAt: 0,
  dedupeKey: undefined,
  lastError: undefined,
});
const encoded: string = encodeJobRecord(jobRecord);
const decodedRecord: JobRecord = decodeJobRecord(encoded);
const decodedJob: Job = decodeJob(encoded);
void [
  wire, roundTrip, jobRecord, encoded, decodedRecord, decodedJob,
  JOBS_ENVELOPE_PREFIX, JOBS_ENVELOPE_VERSION, MAX_PAYLOAD_BYTES, MAX_RECORD_BYTES,
];

validateJobName('email.send');
validateClaim(0, 1);
validateJobId('id');
validateTableName('sveltex_jobs');
validateDedupeKey('k');
validateTimestamp(0, 'now');
const validatedEnqueue: ValidatedEnqueue = validateEnqueueOptions({ name: 'x', payload: 1 }, 0);
const validatedFail: ValidatedFail = validateFailOptions({ error: 'boom' });
void [validatedEnqueue, validatedFail, JOB_NAME_PATTERN, MAX_JOB_ID_LENGTH, MAX_DEDUPE_KEY_LENGTH, MAX_ERROR_LENGTH];

const serializationError: JobsError = new JobsSerializationError('bad');
const configurationError: JobsError = new JobsConfigurationError('bad');
const storeError: JobsStoreError = new JobsStoreError('bad', 'claim', { cause: new Error('driver') });
const operation: string = storeError.operation;
void [serializationError, configurationError, storeError, operation];

// @ts-expect-error the SQL dialect must be sqlite or postgres
void new SqlJobQueue(sqlExecutor, { dialect: 'oracle' });

// @ts-expect-error JobRecord.v is pinned to version 1
const legacyRecord: JobRecord = { ...jobRecord, v: 2 };
void legacyRecord;
