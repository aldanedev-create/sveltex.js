import { DatabaseAdapterError } from './adapter.js';

/** Options for a single transaction/savepoint scope. @public */
export interface TransactionOptions {
  readonly signal?: AbortSignal;
  /**
   * Request a named savepoint scope when the adapter supports nested
   * transactions. Ignored when the adapter has no savepoint capability.
   */
  readonly savepoint?: string;
}

/** Raised when a transaction fails at the adapter/driver boundary. @public */
export class AdapterTransactionError extends DatabaseAdapterError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DATABASE_ADAPTER_TRANSACTION', cause);
    this.name = 'AdapterTransactionError';
  }
}

/** Raised when an adapter is asked for a capability it did not declare. @public */
export class UnsupportedCapabilityError extends DatabaseAdapterError {
  readonly capability: string;
  constructor(capability: string) {
    super(`This adapter does not declare the "${capability}" capability.`, 'DATABASE_ADAPTER_UNSUPPORTED');
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
  }
}
