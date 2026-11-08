import { toError } from '@sveltex/shared';
import { RealtimeTransportError } from './index.js';
import type { RealtimeEnvelope, RealtimeTransport, Subscription, TransportHandler } from './index.js';

interface Registration {
  readonly id: string;
  readonly channel: string;
  readonly handler: TransportHandler;
}

export interface InProcessTransportOptions {
  /**
   * Number of EXTRA redeliveries per published envelope (default 0). Models at-least-once
   * transports that may deliver the same message more than once. Used to prove hub de-duplication.
   */
  readonly redeliveries?: number;
  /** Optional observer for tests/diagnostics; invoked once per publish attempt. */
  readonly onPublish?: (envelope: RealtimeEnvelope) => void;
}

/**
 * A real, working in-process pub/sub transport. It is process-local: it does NOT provide
 * cross-process or distributed delivery. External transports (WebSocket/SSE/broker) implement
 * the same RealtimeTransport contract.
 */
export class InProcessTransport implements RealtimeTransport {
  readonly #registrations = new Map<string, Registration>();
  readonly #redeliveries: number;
  readonly #onPublish: InProcessTransportOptions['onPublish'];
  #sequence = 0;
  #closed = false;

  constructor(options: InProcessTransportOptions = {}) {
    const redeliveries = options.redeliveries ?? 0;
    if (!Number.isSafeInteger(redeliveries) || redeliveries < 0 || redeliveries > 100) {
      throw new RealtimeTransportError('redeliveries must be an integer between 0 and 100.');
    }
    this.#redeliveries = redeliveries;
    this.#onPublish = options.onPublish;
  }

  get isClosed(): boolean { return this.#closed; }

  subscriberCount(channel: string): number {
    let count = 0;
    for (const registration of this.#registrations.values()) if (registration.channel === channel) count += 1;
    return count;
  }

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    if (this.#closed) throw new RealtimeTransportError('Cannot publish on a closed transport.');
    this.#onPublish?.(envelope);
    // Snapshot subscribers so an unsubscribe during delivery cannot mutate the iteration set.
    const targets = [...this.#registrations.values()].filter((r) => r.channel === envelope.channel);
    for (let attempt = 0; attempt <= this.#redeliveries; attempt += 1) {
      for (const registration of targets) {
        try {
          await registration.handler(envelope);
        } catch (error) {
          // One failing subscriber must never break delivery to the others. The hub records the
          // failure per subscriber; the transport only guarantees isolation here.
          void toError(error);
        }
      }
    }
  }

  subscribe(channel: string, handler: TransportHandler): Subscription {
    if (this.#closed) throw new RealtimeTransportError('Cannot subscribe on a closed transport.');
    if (typeof handler !== 'function') throw new RealtimeTransportError('A handler function is required.');
    this.#sequence += 1;
    const id = `sub-${String(this.#sequence)}`;
    const registration: Registration = { id, channel, handler };
    this.#registrations.set(id, registration);
    let closed = false;
    const subscription: Subscription = Object.freeze({
      unsubscribe: (): void => {
        if (closed) return;
        closed = true;
        this.#registrations.delete(id);
      },
      get closed(): boolean { return closed; },
    });
    return subscription;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#registrations.clear();
  }
}
