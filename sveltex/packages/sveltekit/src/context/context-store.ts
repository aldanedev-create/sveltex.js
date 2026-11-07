import type { SvelteXRequestContext } from '../types/context.types.js';
import type { SvelteKitRequestEvent } from '../types/handle.types.js';

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TypeError('SvelteX locals key must be a non-empty string.');
  }
}

export function getRequestContext<T extends SvelteXRequestContext = SvelteXRequestContext>(locals: object, key = 'sveltex'): T {
  assertKey(key);
  if (locals === null || typeof locals !== 'object') throw new TypeError('SvelteKit event.locals must be an object.');
  if (!Object.prototype.hasOwnProperty.call(locals, key)) {
    throw new Error(`SvelteX request context is unavailable on event.locals.${key}. Ensure the SvelteX handle runs before accessing it.`);
  }
  const context = (locals as Record<string, unknown>)[key];
  if (!context || typeof context !== 'object'
    || typeof (context as { resolve?: unknown }).resolve !== 'function'
    || typeof (context as { dispose?: unknown }).dispose !== 'function') {
    throw new Error(`event.locals.${key} exists but is not a valid SvelteX request context.`);
  }
  return context as T;
}

export function setRequestContext(event: SvelteKitRequestEvent, context: SvelteXRequestContext, key = 'sveltex'): void {
  assertKey(key);
  const locals = event.locals as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(locals, key)) {
    throw new Error(`Cannot install SvelteX context: event.locals.${key} is already defined. Choose another localsKey or remove the conflicting assignment.`);
  }
  Object.defineProperty(locals, key, { configurable: true, enumerable: false, writable: false, value: context });
}

export function clearRequestContext(event: SvelteKitRequestEvent, key = 'sveltex', expected?: SvelteXRequestContext): void {
  const locals = event.locals as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(locals, key);
  if (descriptor?.configurable && (expected === undefined || descriptor.value === expected)) delete locals[key];
}
