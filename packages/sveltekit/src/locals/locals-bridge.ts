import type { SvelteKitRequestEvent } from '../types/handle.types.js';
import type { SvelteXRequestContext } from '../types/context.types.js';
import { setRequestContext } from '../context/context-store.js';
import { assertLocalsKey, assertLocalsTarget } from './locals-validation.js';

export function attachContextToLocals(event: SvelteKitRequestEvent, context: SvelteXRequestContext, key = 'sveltex'): void {
  assertLocalsTarget(event.locals);
  assertLocalsKey(key);
  setRequestContext(event, context, key);
}
