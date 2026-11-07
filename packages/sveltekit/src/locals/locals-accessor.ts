import { getRequestContext } from '../context/context-store.js';
import type { SvelteXRequestContext } from '../types/context.types.js';

/** Retrieve the active SvelteX scope from a SvelteKit locals object. */
export function getSvelteXContext<T extends SvelteXRequestContext = SvelteXRequestContext>(locals: object, key = 'sveltex'): T {
  return getRequestContext<T>(locals, key);
}
