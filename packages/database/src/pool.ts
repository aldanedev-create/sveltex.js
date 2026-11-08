import type { PoolConfig } from './index.js';

/** Fully resolved, validated connection-pool limits shared by pooled adapters. */
export interface ResolvedPoolConfig {
  readonly max: number;
  readonly idleTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly acquireTimeoutMs: number;
}

export const DEFAULT_POOL_CONFIG: ResolvedPoolConfig = Object.freeze({
  max: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
  acquireTimeoutMs: 10_000,
});

function limit(value: number | undefined, fallback: number, upper: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > upper) {
    throw new TypeError(`${label} must be a positive integer no greater than ${String(upper)}.`);
  }
  return value;
}

/** Validate and apply defaults to a {@link PoolConfig}. */
export function resolvePoolConfig(config: PoolConfig | undefined): ResolvedPoolConfig {
  if (config !== undefined && (typeof config !== 'object' || config === null)) {
    throw new TypeError('Pool configuration must be an object.');
  }
  return Object.freeze({
    max: limit(config?.max, DEFAULT_POOL_CONFIG.max, 1_000, 'pool.max'),
    idleTimeoutMs: limit(config?.idleTimeoutMs, DEFAULT_POOL_CONFIG.idleTimeoutMs, 3_600_000, 'pool.idleTimeoutMs'),
    connectionTimeoutMs: limit(config?.connectionTimeoutMs, DEFAULT_POOL_CONFIG.connectionTimeoutMs, 3_600_000, 'pool.connectionTimeoutMs'),
    acquireTimeoutMs: limit(config?.acquireTimeoutMs, DEFAULT_POOL_CONFIG.acquireTimeoutMs, 3_600_000, 'pool.acquireTimeoutMs'),
  });
}

/**
 * Bound how long a pool operation may take. If the timeout wins, a late
 * successful result is still handed to `onLate` so a pooled connection is
 * never leaked.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  onLate?: (value: T) => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([work, timeout]);
    settled = true;
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!settled && onLate !== undefined) {
      void work.then(onLate).catch(() => undefined);
    }
  }
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
}
