import { toError } from '@sveltex/shared';
import { JobsSerializationError } from './index.js';
import type { Job, JobStatus } from './index.js';

/**
 * Strict wire format for persisted jobs.
 *
 * `u` encodes a cached `undefined` payload exactly; `j` prefixes a JSON payload
 * that has been verified to survive `JSON.stringify` without silent coercion.
 * Corrupt or legacy payloads raise {@link JobsSerializationError} instead of
 * being silently treated as `null` or an empty object.
 */
export const JOBS_ENVELOPE_VERSION = 1;
export const JOBS_ENVELOPE_PREFIX = `sveltex-jobs:v${JOBS_ENVELOPE_VERSION}:`;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_RECORD_BYTES = 128 * 1024;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STATUSES: readonly string[] = ['pending', 'active', 'completed', 'dead', 'cancelled'];

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function reject(message: string, cause?: unknown): never {
  throw new JobsSerializationError(message, cause === undefined ? {} : { cause: toError(cause) });
}

function assertSerializable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) reject(`Non-finite number at ${path}.`);
    return;
  }
  if (kind === 'bigint' || kind === 'symbol' || kind === 'function' || kind === 'undefined') {
    reject(`Value at ${path} would be silently coerced or dropped by JSON.`);
  }
  if (kind !== 'object' || value === null) reject(`Value at ${path} is not serializable.`);
  const object = value as object;
  if (object instanceof Date || object instanceof Map || object instanceof Set || object instanceof RegExp || object instanceof ArrayBuffer || ArrayBuffer.isView(object)) {
    reject(`Value at ${path} (${object.constructor.name}) would lose its type through JSON.`);
  }
  const isArray = Array.isArray(object);
  const proto = Object.getPrototypeOf(object) as unknown;
  const allowed = isArray ? Array.prototype : Object.prototype;
  if (proto !== allowed && proto !== null) reject(`Only plain objects and arrays can be encoded (${path}).`);
  if (seen.has(object)) reject(`Circular reference at ${path}.`);
  seen.add(object);
  for (const key of Object.keys(object)) {
    if (DANGEROUS_KEYS.has(key)) reject(`Unsafe key ${key} at ${path}.`);
    assertSerializable((object as Record<string, unknown>)[key], `${path}.${key}`, seen);
  }
  seen.delete(object);
}

/** Encode a job payload into the strict versioned envelope. */
export function serializeJobPayload(value: unknown): string {
  if (value === undefined) return `${JOBS_ENVELOPE_PREFIX}u`;
  assertSerializable(value, '$', new WeakSet<object>());
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    reject('Job payload cannot be serialized.', cause);
  }
  if (typeof json !== 'string') reject('Job payload cannot be serialized to JSON.');
  const raw = `${JOBS_ENVELOPE_PREFIX}j${json}`;
  if (bytes(raw) > MAX_PAYLOAD_BYTES) reject('Job payload exceeds the 64 KiB wire limit.');
  return raw;
}

/**
 * Parse a strict payload envelope. Shared by {@link deserializeJobPayload} and
 * {@link decodeJobRecord} so a persisted row cannot smuggle a plaintext, legacy
 * or tampered payload past record-level validation.
 */
function parseStrictPayload(raw: string): unknown {
  if (typeof raw !== 'string') reject('Job payload must be a string.');
  if (bytes(raw) > MAX_PAYLOAD_BYTES) reject('Job payload exceeds the 64 KiB wire limit.');
  if (!raw.startsWith(JOBS_ENVELOPE_PREFIX)) {
    reject('Unknown or legacy job payload envelope.');
  }
  const body = raw.slice(JOBS_ENVELOPE_PREFIX.length);
  if (body === 'u') return undefined;
  if (!body.startsWith('j')) reject('Unknown job payload tag.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(1), (key, value: unknown) => (DANGEROUS_KEYS.has(key) ? undefined : value)) as unknown;
  } catch (cause) {
    reject('Corrupt job payload JSON.', cause);
  }
  assertSerializable(parsed, '$', new WeakSet<object>());
  return parsed;
}

/** Decode a payload produced by {@link serializeJobPayload}. Never returns a coerced value. */
export function deserializeJobPayload(raw: string): unknown {
  return parseStrictPayload(raw);
}

export interface JobRecord {
  readonly v: 1;
  readonly id: string;
  readonly name: string;
  /** Strict payload envelope, not raw JSON. */
  readonly payload: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly availableAt: number;
  readonly dedupeKey: string | undefined;
  readonly lastError: string | undefined;
}

/** Encode a complete persisted job row. All fields are scalars; payload is an envelope. */
export function encodeJobRecord(record: JobRecord): string {
  const raw = JSON.stringify({
    v: record.v,
    id: record.id,
    name: record.name,
    payload: record.payload,
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
    availableAt: record.availableAt,
    ...(record.dedupeKey !== undefined ? { dedupeKey: record.dedupeKey } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
  });
  if (bytes(raw) > MAX_RECORD_BYTES) reject('Persisted job record exceeds the 128 KiB wire limit.');
  return raw;
}

/** Decode and fully validate a persisted job row. Rejects legacy/corrupt records. */
export function decodeJobRecord(raw: string): JobRecord {
  if (typeof raw !== 'string' || !raw.startsWith('{')) reject('Job record must be a JSON object.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value: unknown) => (DANGEROUS_KEYS.has(key) ? undefined : value)) as unknown;
  } catch (cause) {
    reject('Corrupt job record JSON.', cause);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject('Job record must be a plain object.');
  const value = parsed as Record<string, unknown>;
  if (value['v'] !== JOBS_ENVELOPE_VERSION) reject('Unknown or legacy job record version.');
  const scalar = (key: string, kind: 'string' | 'number'): unknown => {
    const item = value[key];
    if (typeof item !== kind || (kind === 'number' && !Number.isFinite(item))) reject(`Invalid job record field ${key}.`);
    return item;
  };
  const id = scalar('id', 'string') as string;
  const name = scalar('name', 'string') as string;
  const payload = scalar('payload', 'string') as string;
  // A persisted row must carry a strict versioned envelope, never raw/legacy JSON.
  parseStrictPayload(payload);
  if (id.length === 0 || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) {
    reject('Invalid job id in persisted record.');
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(name)) {
    reject('Invalid job name in persisted record.');
  }
  const status = scalar('status', 'string') as string;
  if (!STATUSES.includes(status)) reject('Invalid job status in persisted record.');
  const attempts = scalar('attempts', 'number') as number;
  const maxAttempts = scalar('maxAttempts', 'number') as number;
  const createdAt = scalar('createdAt', 'number') as number;
  const availableAt = scalar('availableAt', 'number') as number;
  if (!Number.isSafeInteger(attempts) || attempts < 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    reject('Invalid attempt counters in persisted record.');
  }
  const dedupeKey = value['dedupeKey'];
  const lastError = value['lastError'];
  if (dedupeKey !== undefined && typeof dedupeKey !== 'string') reject('Invalid dedupeKey in persisted record.');
  if (lastError !== undefined && typeof lastError !== 'string') reject('Invalid lastError in persisted record.');
  return Object.freeze({
    v: 1 as const,
    id, name, payload,
    status: status as JobStatus,
    attempts, maxAttempts, createdAt, availableAt,
    dedupeKey: dedupeKey as string | undefined,
    lastError: lastError as string | undefined,
  });
}

/** Decode a persisted row into the public, frozen {@link Job} shape. */
export function decodeJob(raw: string): Job {
  const record = decodeJobRecord(raw);
  return Object.freeze({
    id: record.id,
    name: record.name,
    payload: deserializeJobPayload(record.payload),
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
    availableAt: record.availableAt,
    ...(record.dedupeKey !== undefined ? { dedupeKey: record.dedupeKey } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
  }) as Job;
}
