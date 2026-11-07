import type { Handle } from '../types/handle.types.js';
import { composeHandlers } from './compose-handlers.js';

/** Mutable builder for a deterministic SvelteKit handle chain. */
export class HandlerPipeline {
  readonly #handlers: Handle[] = [];

  use(handler: Handle): this {
    if (typeof handler !== 'function') throw new TypeError('A SvelteKit handle must be a function.');
    this.#handlers.push(handler);
    return this;
  }

  build(): Handle {
    return composeHandlers(...this.#handlers);
  }

  get size(): number {
    return this.#handlers.length;
  }
}
