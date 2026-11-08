import type { DatabaseAdapterCapabilities } from './adapter.js';

/** Lifecycle states of a managed adapter connection. @public */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed' | 'failed';

/** Result of a health check. Driver error text is never included verbatim. @public */
export interface HealthCheckReport {
  readonly healthy: boolean;
  readonly latencyMs: number;
  readonly checkedAt: number;
  readonly checkedBy: string;
  readonly error?: string;
}

/** Static description of a registered/managed connection. @public */
export interface ConnectionInfo {
  readonly name: string;
  readonly adapter: string;
  readonly state: ConnectionState;
  readonly capabilities: DatabaseAdapterCapabilities;
}
