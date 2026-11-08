export {
  DatabaseAdapterError,
  DEFAULT_ADAPTER_CAPABILITIES,
  validateAdapterDefinition,
  defineDatabaseAdapter,
  defineAdapterContext,
  type DatabaseAdapterConfig,
  type DatabaseAdapterContext,
  type DatabaseAdapterCapabilities,
  type DatabaseAdapterDefinition,
  type DatabaseAdapter,
  type MigrationAction,
  type MigrationRequest,
  type MigrationStatus,
} from './adapter.js';
export type { ConnectionState, HealthCheckReport, ConnectionInfo } from './connection.js';
export {
  AdapterTransactionError,
  UnsupportedCapabilityError,
  type TransactionOptions,
} from './transaction.js';
