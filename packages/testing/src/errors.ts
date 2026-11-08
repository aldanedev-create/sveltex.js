import { SvelteXError } from '@sveltex/shared';

export interface TestingErrorOptions {
  readonly cause?: Error;
  readonly details?: Record<string, unknown>;
}

export class TestingError extends SvelteXError {
  constructor(message: string, options: TestingErrorOptions = {}) {
    super(message, {
      code: 'SX_TESTING',
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
    this.name = 'TestingError';
  }
}

export class TestSetupError extends TestingError {
  constructor(message: string, options: TestingErrorOptions = {}) {
    super(message, options);
    this.name = 'TestSetupError';
  }
}
