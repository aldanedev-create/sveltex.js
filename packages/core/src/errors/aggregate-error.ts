import { asError } from './framework-error.js';

export class SvelteXAggregateError extends AggregateError {
  readonly causes: readonly Error[];
  constructor(message: string, errors: readonly unknown[]) {
    const normalized = errors.map(asError);
    super(normalized, message);
    this.name = 'SvelteXAggregateError';
    this.causes = Object.freeze(normalized);
  }
}
