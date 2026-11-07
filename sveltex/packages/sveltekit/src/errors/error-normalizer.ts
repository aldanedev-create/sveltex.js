import { SvelteXKitError } from './sveltekit-error.js';
export function normalizeAdapterError(error: unknown): Error { return error instanceof Error ? error : new SvelteXKitError('SX_KIT_UNKNOWN', 'SvelteX encountered a non-Error value.', { cause: error }); }
