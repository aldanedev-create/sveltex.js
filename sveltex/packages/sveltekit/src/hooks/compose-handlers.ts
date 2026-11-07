import type { Handle } from '../types/handle.types.js';

/**
 * Compose handles in declaration order (first handle is outermost).
 * This mirrors SvelteKit's sequence contract: each handle may call its next
 * resolver at most once, may short-circuit, and may pass resolve options.
 */
export function composeHandlers(...handlers: readonly Handle[]): Handle {
  for (const handler of handlers) {
    if (typeof handler !== 'function') throw new TypeError('Every composed SvelteKit handle must be a function.');
  }

  return async ({ event, resolve }) => {
    const dispatch = async (index: number, currentEvent: any, options?: any): Promise<Response> => {
      const handler = handlers[index];
      if (!handler) return resolve(currentEvent, options);

      let nextCalled = false;
      return handler({
        event: currentEvent,
        resolve: async (nextEvent = currentEvent, nextOptions) => {
          if (nextCalled) throw new Error('A composed SvelteKit handle called resolve() more than once.');
          nextCalled = true;
          return dispatch(index + 1, nextEvent, nextOptions);
        }
      });
    };

    return dispatch(0, event);
  };
}
