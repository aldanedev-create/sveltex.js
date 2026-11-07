export type MaybePromise<T> = T | Promise<T>;
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
