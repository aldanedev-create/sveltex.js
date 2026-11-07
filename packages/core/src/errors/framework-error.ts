export type SvelteXErrorCode =
  | 'SX_CONFIG_INVALID' | 'SX_APP_INVALID_STATE' | 'SX_MODULE_INVALID'
  | 'SX_MODULE_DUPLICATE' | 'SX_MODULE_MISSING_DEPENDENCY' | 'SX_MODULE_CYCLE'
  | 'SX_PROVIDER_INVALID' | 'SX_PROVIDER_DUPLICATE' | 'SX_PROVIDER_NOT_FOUND'
  | 'SX_PROVIDER_SCOPE_VIOLATION' | 'SX_DI_CYCLE' | 'SX_APP_START_FAILED'
  | 'SX_APP_STOP_FAILED' | 'SX_DISPOSAL_FAILED';

export interface SvelteXErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class SvelteXError extends Error {
  readonly code: SvelteXErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: SvelteXErrorCode, message: string, options: SvelteXErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SvelteXError';
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
