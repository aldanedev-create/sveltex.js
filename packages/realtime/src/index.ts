import { randomUUID } from 'node:crypto';
import { deepFreeze, SvelteXError, toError } from '@sveltex/shared';
import type { Awaitable } from '@sveltex/shared';

/** A typed channel definition. `TPayload` is the compile-time payload type carried by the channel. */
export interface ChannelDefinition<TPayload> {
  readonly name: string;
  /** Phantom marker — never set at runtime; exists only to keep distinct payload types distinct. */
  readonly __payload?: TPayload;
}

export interface RealtimeEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly channel: string;
  readonly payload: TPayload;
  readonly publishedAt: number;
}

export type RealtimeAction = 'publish' | 'subscribe' | 'deliver';

export interface AuthorizationContext<P> {
  readonly principal: P | undefined;
  readonly channel: string;
  readonly action: RealtimeAction;
  readonly envelope?: RealtimeEnvelope;
}

export type AuthorizeHook<P> = (context: AuthorizationContext<P>) => Awaitable<boolean>;

export interface RealtimePrincipal {
  readonly id: string;
}

export type TransportHandler = (envelope: RealtimeEnvelope) => Awaitable<void>;

/** Contract that any external transport (WebSocket, SSE, Redis pub/sub, broker) must implement. */
export interface RealtimeTransport {
  publish(envelope: RealtimeEnvelope): Promise<void>;
  subscribe(channel: string, handler: TransportHandler): Subscription;
  close(): Promise<void>;
  readonly isClosed: boolean;
}

export interface Subscription {
  readonly closed: boolean;
  unsubscribe(): void;
}

export type ChannelHandler<TPayload> = (payload: TPayload, envelope: RealtimeEnvelope<TPayload>) => Awaitable<void>;

export interface PublishOptions<P> {
  readonly principal: P | undefined;
}
export interface SubscribeOptions<P> {
  readonly principal: P | undefined;
}

export interface PublishResult {
  readonly envelope: RealtimeEnvelope;
}

export interface RealtimeMetrics {
  readonly published: number;
  readonly delivered: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly failed: number;
}

export interface RealtimeErrorOptions {
  readonly cause?: Error;
  readonly details?: Record<string, unknown>;
}

/** Base error for the realtime package. */
export class RealtimeError extends SvelteXError {
  constructor(code: string, message: string, options: RealtimeErrorOptions = {}) {
    super(message, {
      code,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
    this.name = 'RealtimeError';
  }
}

export class RealtimeChannelError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_CHANNEL', message, options);
    this.name = 'RealtimeChannelError';
  }
}
export class RealtimeAuthorizationError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_AUTHORIZATION', message, options);
    this.name = 'RealtimeAuthorizationError';
  }
}
export class RealtimeClosedError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_CLOSED', message, options);
    this.name = 'RealtimeClosedError';
  }
}
export class RealtimeTransportError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_TRANSPORT', message, options);
    this.name = 'RealtimeTransportError';
  }
}
export class RealtimeDeliveryError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_DELIVERY', message, options);
    this.name = 'RealtimeDeliveryError';
  }
}

/** A malformed, oversized or unsafe network frame was received or encoded. */
export class RealtimeProtocolError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_PROTOCOL', message, options);
    this.name = 'RealtimeProtocolError';
  }
}

/** A bounded send queue overflowed under backpressure. */
export class RealtimeBackpressureError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_BACKPRESSURE', message, options);
    this.name = 'RealtimeBackpressureError';
  }
}

/** Connect, heartbeat or reconnect failure. */
export class RealtimeConnectionError extends RealtimeError {
  constructor(message: string, options: RealtimeErrorOptions = {}) {
    super('SX_REALTIME_CONNECTION', message, options);
    this.name = 'RealtimeConnectionError';
  }
}

/**
 * The one channel-name grammar shared by the hub and every network adapter. Exported so
 * WebSocket/SSE gateways validate exactly the same names as `defineChannel`.
 */
export const REALTIME_CHANNEL_NAME = /^[A-Za-z0-9._:-]{1,128}$/;

const CHANNEL_NAME = REALTIME_CHANNEL_NAME;

/** Define a channel with a statically typed payload. Rejects names that could be used for injection. */
export function defineChannel<TPayload>(name: string): ChannelDefinition<TPayload> {
  if (typeof name !== 'string' || !CHANNEL_NAME.test(name)) {
    throw new RealtimeChannelError(`Invalid channel name: ${String(name)}`);
  }
  return Object.freeze({ name });
}

export function allowAll<P>(): AuthorizeHook<P> {
  return () => true;
}
export function denyAll<P>(): AuthorizeHook<P> {
  return () => false;
}

export interface RealtimeHubOptions<P> {
  readonly transport: RealtimeTransport;
  /** Required on purpose: there is no implicit "allow" default. Production apps must decide policy. */
  readonly authorize: AuthorizeHook<P>;
  readonly now?: () => number;
  readonly generateId?: () => string;
  readonly maxRememberedIds?: number;
  readonly onError?: (error: RealtimeError, context: { readonly channel: string; readonly subscriberId: string }) => void;
}

interface MutableMetrics {
  published: number;
  delivered: number;
  duplicates: number;
  rejected: number;
  failed: number;
}

/** Per-subscriber bounded id cache. At-least-once de-duplication is per consumer, never global. */
function createDeduper(maxRememberedIds: number): (id: string) => boolean {
  const seen = new Set<string>();
  const order: string[] = [];
  return (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    order.push(id);
    while (order.length > maxRememberedIds) {
      const oldest = order.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  };
}

/**
 * Authorization-aware pub/sub hub. Delivers typed envelopes through a pluggable transport,
 * de-duplicates at-least-once redeliveries, isolates failing subscribers and supports idempotent shutdown.
 */
export class RealtimeHub<P = RealtimePrincipal> {
  readonly #transport: RealtimeTransport;
  readonly #authorize: AuthorizeHook<P>;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #maxRememberedIds: number;
  readonly #onError: RealtimeHubOptions<P>['onError'];
  readonly #subscriptions = new Set<Subscription>();
  readonly #errors: RealtimeError[] = [];
  readonly #metrics: MutableMetrics = { published: 0, delivered: 0, duplicates: 0, rejected: 0, failed: 0 };
  #closed = false;

  constructor(options: RealtimeHubOptions<P>) {
    if (!options || !options.transport || typeof options.authorize !== 'function') {
      throw new RealtimeChannelError('A transport and an authorize hook are required.');
    }
    const max = options.maxRememberedIds ?? 1024;
    if (!Number.isSafeInteger(max) || max < 1) throw new RealtimeChannelError('maxRememberedIds must be a positive safe integer.');
    this.#transport = options.transport;
    this.#authorize = options.authorize;
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#maxRememberedIds = max;
    this.#onError = options.onError;
  }

  get isClosed(): boolean { return this.#closed; }
  get metrics(): RealtimeMetrics { return Object.freeze({ ...this.#metrics }); }
  get subscriptionCount(): number { return this.#subscriptions.size; }

  /** Returns a snapshot of delivery/authorization errors and clears the buffer. */
  drainErrors(): readonly RealtimeError[] {
    return Object.freeze(this.#errors.splice(0, this.#errors.length));
  }

  async publish<TPayload>(
    channel: ChannelDefinition<TPayload>,
    payload: TPayload,
    options: PublishOptions<P>,
  ): Promise<PublishResult> {
    this.#assertOpen();
    await this.#check({ principal: options.principal, channel: channel.name, action: 'publish' }, 'Publishing is not authorized.');
    this.#assertOpen();
    const envelope: RealtimeEnvelope<TPayload> = Object.freeze({
      id: this.#generateId(),
      channel: channel.name,
      payload,
      publishedAt: this.#now(),
    });
    try {
      await this.#transport.publish(envelope as RealtimeEnvelope);
    } catch (error) {
      throw new RealtimeTransportError('Transport failed to publish the envelope.', { cause: toError(error) });
    }
    this.#metrics.published += 1;
    return Object.freeze({ envelope: envelope as RealtimeEnvelope });
  }

  async subscribe<TPayload>(
    channel: ChannelDefinition<TPayload>,
    handler: ChannelHandler<TPayload>,
    options: SubscribeOptions<P>,
  ): Promise<Subscription> {
    this.#assertOpen();
    await this.#check({ principal: options.principal, channel: channel.name, action: 'subscribe' }, 'Subscribing is not authorized.');
    this.#assertOpen();
    const id = this.#generateId();
    const wrapped = this.#wrap(channel, handler, options.principal, id);
    let inner: Subscription;
    try {
      inner = this.#transport.subscribe(channel.name, wrapped);
    } catch (error) {
      throw new RealtimeTransportError('Transport failed to register the subscription.', { cause: toError(error) });
    }
    let unsubscribed = false;
    const managed: Subscription = Object.freeze({
      unsubscribe: (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        inner.unsubscribe();
        this.#subscriptions.delete(managed);
      },
      get closed(): boolean { return unsubscribed || inner.closed; },
    });
    this.#subscriptions.add(managed);
    return managed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of [...this.#subscriptions]) subscription.unsubscribe();
    this.#subscriptions.clear();
    try {
      await this.#transport.close();
    } catch (error) {
      throw new RealtimeTransportError('Transport failed to close.', { cause: toError(error) });
    }
  }

  #wrap<TPayload>(
    channel: ChannelDefinition<TPayload>,
    handler: ChannelHandler<TPayload>,
    principal: P | undefined,
    subscriberId: string,
  ): TransportHandler {
    const isDuplicate = createDeduper(this.#maxRememberedIds);
    return async (envelope: RealtimeEnvelope): Promise<void> => {
      if (this.#closed || envelope.channel !== channel.name) return;
      if (isDuplicate(envelope.id)) {
        this.#metrics.duplicates += 1;
        return;
      }
      let allowed: boolean;
      try {
        allowed = await this.#authorize({ principal, channel: channel.name, action: 'deliver', envelope });
      } catch (error) {
        this.#reportError(new RealtimeAuthorizationError('Authorization hook failed during delivery.', { cause: toError(error) }), envelope.channel, subscriberId);
        return;
      }
      if (!allowed) {
        this.#metrics.rejected += 1;
        return;
      }
      try {
        // In-process transports are zero-copy; freeze the envelope so a subscriber cannot mutate
        // the shared payload seen by other subscribers on this process.
        const frozen = deepFreeze({ ...envelope }) as unknown as RealtimeEnvelope<TPayload>;
        await handler(envelope.payload as TPayload, frozen);
        this.#metrics.delivered += 1;
      } catch (error) {
        this.#metrics.failed += 1;
        this.#reportError(new RealtimeDeliveryError('Subscriber handler failed.', { cause: toError(error) }), envelope.channel, subscriberId);
      }
    };
  }

  async #check(context: AuthorizationContext<P>, message: string): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.#authorize(context);
    } catch (error) {
      throw new RealtimeAuthorizationError(message, { cause: toError(error) });
    }
    if (!allowed) throw new RealtimeAuthorizationError(message);
  }

  #reportError(error: RealtimeError, channel: string, subscriberId: string): void {
    this.#errors.push(error);
    if (this.#onError) {
      try { this.#onError(error, { channel, subscriberId }); } catch { /* user callback must not break delivery */ }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new RealtimeClosedError('The realtime hub is closed.');
  }
}
