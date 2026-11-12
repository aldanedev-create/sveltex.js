import { JobsValidationError } from './index.js';

/** Shared, backend-independent validation for every JobQueue implementation. */

export const JOB_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_JOB_ID_LENGTH = 256;
export const MAX_DEDUPE_KEY_LENGTH = 256;
export const MAX_ERROR_LENGTH = 4096;

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export interface ValidatedEnqueue {
  readonly name: string;
  readonly payload: unknown;
  readonly maxAttempts: number;
  readonly dedupeKey: string | undefined;
  readonly delayMs: number;
}

export interface ValidatedFail {
  readonly error: string;
  readonly retryAt: number | undefined;
}

export function validateJobName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !JOB_NAME_PATTERN.test(name)) {
    throw new JobsValidationError('Job name must match ^[A-Za-z0-9._:-]{1,128}$.');
  }
}

export function validateTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JobsValidationError(`${label} must be a finite timestamp.`);
  }
}

/**
 * `dedupeKey` is an opaque bounded string. Control characters are deliberately
 * allowed: keys are only ever used as map keys, Redis key segments or SQL bind
 * parameters, never as filesystem paths or shell arguments.
 */
export function validateDedupeKey(key: unknown): void {
  if (key === undefined) return;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new JobsValidationError('dedupeKey must be a non-empty string of at most 256 characters.');
  }
}

export function validateJobId(id: unknown): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_JOB_ID_LENGTH || CONTROL_CHARS.test(id)) {
    throw new JobsValidationError('Job id must be a non-empty string of at most 256 characters without control characters.');
  }
}

export function validateTableName(name: unknown): void {
  if (typeof name !== 'string' || name.length > 48 || !TABLE_RE.test(name)) {
    throw new JobsValidationError('tableName must be a plain SQL identifier (letters, digits, underscore).');
  }
}

export function validateEnqueueOptions(options: unknown, now: number): ValidatedEnqueue {
  if (!options || typeof options !== 'object') {
    throw new JobsValidationError('Enqueue options are required.');
  }
  const value = options as Record<string, unknown>;
  validateJobName(value['name']);
  const maxAttempts = value['maxAttempts'];
  if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 100)) {
    throw new JobsValidationError('maxAttempts must be an integer between 1 and 100.');
  }
  const delayMs = value['delayMs'];
  if (delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new JobsValidationError('delayMs must be a non-negative finite number.');
  }
  validateDedupeKey(value['dedupeKey']);
  validateTimestamp(now, 'now');
  return {
    name: value['name'] as string,
    payload: value['payload'],
    maxAttempts: (maxAttempts as number | undefined) ?? 3,
    dedupeKey: value['dedupeKey'] as string | undefined,
    delayMs: (delayMs as number | undefined) ?? 0,
  };
}

export function validateClaim(now: number, limit: number): void {
  validateTimestamp(now, 'now');
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new JobsValidationError('claim limit must be a non-negative integer.');
  }
}

export function validateFailOptions(options: unknown): ValidatedFail {
  if (!options || typeof options !== 'object') {
    throw new JobsValidationError('Fail options are required.');
  }
  const value = options as Record<string, unknown>;
  const error = value['error'];
  if (typeof error !== 'string' || error.length > MAX_ERROR_LENGTH) {
    throw new JobsValidationError('error must be a string of at most 4096 characters.');
  }
  const retryAt = value['retryAt'];
  if (retryAt !== undefined) validateTimestamp(retryAt, 'retryAt');
  return { error: error as string, retryAt: retryAt as number | undefined };
}
