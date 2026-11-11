import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { toError } from '@sveltex/shared';
import {
  RealtimeBackpressureError,
  RealtimeConnectionError,
  RealtimeError,
  RealtimeProtocolError,
} from './index.js';
import type {
  RealtimeEnvelope,
  RealtimeTransport,
  Subscription,
  TransportHandler,
} from './index.js';
import {
  allowAnonymous,
  decodeWireMessage,
  denyAnonymous,
  encodeWireMessage,
  isChannelName,
  MAX_WIRE_MESSAGE_BYTES,
} from './protocol.js';
import type { GatewayAuthenticator, WireMessage } from './protocol.js';
import {
  BoundedQueue,
  computeReconnectDelay,
  DEFAULT_RECONNECT,
  HeartbeatMonitor,
} from './connection.js';
import type { ConnectionState, OverflowPolicy, ReconnectOptions } from './connection.js';

export { allowAnonymous, denyAnonymous };

export interface SseAuthContext {
  readonly request: IncomingMessage;
  readonly url: URL;
}

export interface SseGatewayOptions {
  /** Required in production. Omitted = deny-by-default; pass `allowAnonymous()` to opt in. */
  readonly authenticate?: GatewayAuthenticator<SseAuthContext>;
  readonly path?: string;
  readonly maxMessageBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly replayBufferSize?: number;
  readonly maxBufferedFrames?: number;
  readonly maxTrackedClients?: number;
  readonly now?: () => number;
  readonly onError?: (error: RealtimeError) => void;
}

export interface SseGatewayMetrics {
  readonly connections: number;
  readonly messagesIn: number;
  readonly messagesOut: number;
  readonly rejected: number;
  readonly authFailures: number;
  readonly backpressureDrops: number;
  readonly replays: number;
}

export interface SseGateway {
  readonly url: string;
  readonly port: number;
  readonly connectionCount: number;
  readonly metrics: SseGatewayMetrics;
  /** Real internal subscription count for a channel (observability / deterministic tests). */
  subscriptionCount(channel: string): number;
  close(): Promise<void>;
}

interface MutableMetrics {
  connections: number;
  messagesIn: number;
  messagesOut: number;
  rejected: number;
  authFailures: number;
  backpressureDrops: number;
  replays: number;
}

interface SseConnection {
  readonly id: string;
  readonly response: ServerResponse;
  readonly channels: Set<string>;
  readonly pending: string[];
  paused: boolean;
}

interface ReplayEntry {
  readonly id: string;
  readonly channel: string;
  readonly frame: string;
}

interface NormalizedSseOptions {
  readonly authenticate: GatewayAuthenticator<SseAuthContext>;
  readonly path: string;
  readonly maxMessageBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly replayBufferSize: number;
  readonly maxBufferedFrames: number;
  readonly maxTrackedClients: number;
  readonly now: () => number;
  readonly onError: ((error: RealtimeError) => void) | undefined;
}

const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/;

function normalizeSseOptions(options: SseGatewayOptions): NormalizedSseOptions {
  const rawPath = options.path ?? '/realtime';
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new RealtimeConnectionError('Gateway path must be an absolute path without query/fragment.');
  }
  const maxMessageBytes = options.maxMessageBytes ?? MAX_WIRE_MESSAGE_BYTES;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const replayBufferSize = options.replayBufferSize ?? 256;
  const maxBufferedFrames = options.maxBufferedFrames ?? 64;
  const maxTrackedClients = options.maxTrackedClients ?? 1024;
  for (const [name, value] of [
    ['maxMessageBytes', maxMessageBytes],
    ['heartbeatIntervalMs', heartbeatIntervalMs],
    ['replayBufferSize', replayBufferSize],
    ['maxBufferedFrames', maxBufferedFrames],
    ['maxTrackedClients', maxTrackedClients],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RealtimeConnectionError(`${name} must be a positive integer.`);
    }
  }
  return {
    authenticate: options.authenticate ?? denyAnonymous<SseAuthContext>(),
    path,
    maxMessageBytes,
    heartbeatIntervalMs,
    replayBufferSize,
    maxBufferedFrames,
    maxTrackedClients,
    now: options.now ?? Date.now,
    onError: options.onError,
  };
}

function formatSseEvent(id: string, event: string, data: string): string {
  return `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
}

function parseSseFrame(frame: string): { readonly id?: string; readonly event?: string; readonly data?: string; readonly comment: boolean } {
  const lines = frame.split('\n');
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  let comment = true;
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    comment = false;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return { ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), ...(dataLines.length > 0 ? { data: dataLines.join('\n') } : {}), comment };
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) throw new RealtimeProtocolError('Request body exceeds the byte limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Create a standalone SSE gateway on a real ephemeral TCP port. */
export async function createSseGateway(
  options: SseGatewayOptions & { readonly port?: number; readonly host?: string } = {},
): Promise<SseGateway> {
  const config = normalizeSseOptions(options);
  const host = options.host ?? '127.0.0.1';
  const connections = new Map<string, SseConnection>();
  const channelsByClient = new Map<string, Set<string>>();
  const trackedClients: string[] = [];
  const replay: ReplayEntry[] = [];
  const metrics: MutableMetrics = {
    connections: 0, messagesIn: 0, messagesOut: 0, rejected: 0,
    authFailures: 0, backpressureDrops: 0, replays: 0,
  };
  let closed = false;

  const report = (error: unknown): void => {
    const wrapped = error instanceof RealtimeError
      ? error
      : new RealtimeConnectionError('SSE gateway error.', { cause: toError(error) });
    if (config.onError) {
      try { config.onError(wrapped); } catch { /* observer must not break delivery */ }
    }
  };

  const channelsFor = (clientId: string): Set<string> => {
    let channels = channelsByClient.get(clientId);
    if (!channels) {
      channels = new Set<string>();
      channelsByClient.set(clientId, channels);
      trackedClients.push(clientId);
      while (trackedClients.length > config.maxTrackedClients) {
        const oldest = trackedClients.shift();
        if (oldest !== undefined) channelsByClient.delete(oldest);
      }
    }
    return channels;
  };

  const flush = (connection: SseConnection): void => {
    connection.paused = false;
    while (connection.pending.length > 0 && !connection.paused) {
      const frame = connection.pending.shift();
      if (frame === undefined) break;
      const ok = connection.response.write(frame);
      if (!ok) {
        connection.paused = true;
        connection.response.once('drain', () => flush(connection));
      }
    }
  };

  const writeFrame = (connection: SseConnection, frame: string): void => {
    if (connection.paused || connection.pending.length > 0) {
      if (connection.pending.length >= config.maxBufferedFrames) {
        metrics.backpressureDrops += 1;
        connection.response.destroy();
        connections.delete(connection.id);
        return;
      }
      connection.pending.push(frame);
      return;
    }
    const ok = connection.response.write(frame);
    metrics.messagesOut += 1;
    if (!ok) {
      connection.paused = true;
      connection.response.once('drain', () => flush(connection));
    }
  };

  const broadcast = (envelope: RealtimeEnvelope): void => {
    let frame: string;
    try {
      frame = formatSseEvent(envelope.id, 'message', encodeWireMessage({ t: 'msg', envelope }));
    } catch (error) {
      report(error);
      return;
    }
    replay.push({ id: envelope.id, channel: envelope.channel, frame });
    while (replay.length > config.replayBufferSize) replay.shift();
    for (const connection of [...connections.values()]) {
      if (!connection.channels.has(envelope.channel)) continue;
      writeFrame(connection, frame);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      response.writeHead(400).end();
      return;
    }
    const suffix = url.pathname.startsWith(config.path + '/') ? url.pathname.slice(config.path.length) : '';
    if (!['/events', '/subscribe', '/unsubscribe', '/publish'].includes(suffix)) {
      response.writeHead(404).end();
      return;
    }
    let allowed = false;
    try {
      allowed = await config.authenticate({ request, url });
    } catch (error) {
      report(error);
    }
    if (!allowed) {
      metrics.authFailures += 1;
      response.writeHead(401).end();
      return;
    }
    const clientId = url.searchParams.get('clientId') ?? '';
    if (!CLIENT_ID.test(clientId)) {
      metrics.rejected += 1;
      response.writeHead(400).end();
      return;
    }

    if (suffix === '/events') {
      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }
      const previous = connections.get(clientId);
      if (previous) {
        previous.response.end();
        connections.delete(clientId);
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders?.();
      const connection: SseConnection = {
        id: clientId,
        response,
        channels: channelsFor(clientId),
        pending: [],
        paused: false,
      };
      connections.set(clientId, connection);
      metrics.connections += 1;
      response.write(': connected\n\n');
      const lastEventId = request.headers['last-event-id'];
      if (typeof lastEventId === 'string') {
        const start = replay.findIndex((entry) => entry.id === lastEventId);
        if (start >= 0) {
          for (const entry of replay.slice(start + 1)) {
            if (!connection.channels.has(entry.channel)) continue;
            writeFrame(connection, entry.frame);
            metrics.replays += 1;
          }
        }
      }
      request.on('close', () => {
        if (connections.get(clientId) === connection) connections.delete(clientId);
      });
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    if (suffix === '/subscribe' || suffix === '/unsubscribe') {
      const channel = url.searchParams.get('channel') ?? '';
      if (!isChannelName(channel)) {
        metrics.rejected += 1;
        response.writeHead(400).end();
        return;
      }
      const channels = channelsFor(clientId);
      if (suffix === '/subscribe') channels.add(channel);
      else channels.delete(channel);
      response.writeHead(204).end();
      return;
    }

    // /publish
    let body: string;
    try {
      body = await readBody(request, config.maxMessageBytes);
    } catch (error) {
      metrics.rejected += 1;
      report(error);
      response.writeHead(413).end();
      return;
    }
    metrics.messagesIn += 1;
    let message: WireMessage;
    try {
      message = decodeWireMessage(body, 'client');
    } catch (error) {
      metrics.rejected += 1;
      report(error);
      response.writeHead(400).end();
      return;
    }
    if (message.t !== 'pub') {
      metrics.rejected += 1;
      response.writeHead(400).end();
      return;
    }
    broadcast(message.envelope);
    response.writeHead(204).end();
  };

  const httpServer = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      report(error);
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new RealtimeConnectionError('Could not determine the SSE gateway port.');
  }
  const url = `http://${host}:${String(address.port)}${config.path}`;

  const heartbeat = setInterval(() => {
    for (const connection of [...connections.values()]) {
      writeFrame(connection, `: keepalive ${String(config.now())}\n\n`);
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    url,
    port: address.port,
    get connectionCount(): number { return connections.size; },
    subscriptionCount(channel: string): number {
      let count = 0;
      for (const channels of channelsByClient.values()) if (channels.has(channel)) count += 1;
      return count;
    },
    get metrics(): SseGatewayMetrics { return Object.freeze({ ...metrics }); },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const connection of [...connections.values()]) {
        try { connection.response.end(); } catch { /* already gone */ }
      }
      connections.clear();
      channelsByClient.clear();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(toError(error)) : resolve()));
      });
    },
  };
}

export interface SseClientTransportOptions {
  readonly url: string;
  readonly reconnect?: ReconnectOptions;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxQueuedMessages?: number;
  readonly overflow?: OverflowPolicy;
  readonly maxMessageBytes?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onError?: (error: RealtimeError) => void;
  readonly fetchImpl?: typeof fetch;
}

/**
 * A real SSE client implementing RealtimeTransport: GET for the event stream, POST for
 * subscribe/publish. Reconnection replays subscriptions and replays missed events via
 * Last-Event-ID. No fake transport and no in-process shortcut.
 */
export class SseClientTransport implements RealtimeTransport {
  readonly #baseUrl: string;
  readonly #clientId = randomUUID();
  readonly #reconnect: ReconnectOptions;
  readonly #queue: BoundedQueue<string>;
  readonly #handlers = new Map<string, Set<TransportHandler>>();
  readonly #heartbeat: HeartbeatMonitor;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #maxMessageBytes: number;
  readonly #onStateChange: ((state: ConnectionState) => void) | undefined;
  readonly #onError: ((error: RealtimeError) => void) | undefined;
  #abort: AbortController | undefined;
  #lastEventId: string | undefined;
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SseClientTransportOptions) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0) {
      throw new RealtimeConnectionError('An SSE gateway URL is required.');
    }
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new RealtimeConnectionError('Invalid SSE gateway URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RealtimeConnectionError('SSE gateway URL must use http: or https:.');
    }
    this.#baseUrl = options.url.replace(/\/+$/, '');
    this.#reconnect = options.reconnect ?? {};
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_WIRE_MESSAGE_BYTES;
    this.#onStateChange = options.onStateChange;
    this.#onError = options.onError;
    this.#queue = new BoundedQueue<string>(options.maxQueuedMessages ?? 256, options.overflow ?? 'error');
    this.#heartbeat = new HeartbeatMonitor({
      intervalMs: options.heartbeatIntervalMs ?? 5_000,
      timeoutMs: options.heartbeatTimeoutMs ?? 15_000,
      now: this.#now,
      onTimeout: () => {
        this.#report(new RealtimeConnectionError('SSE heartbeat timed out; reconnecting.'));
        this.#heartbeat.stop();
        this.#abort?.abort();
      },
    });
    void this.#connect();
  }

  get isClosed(): boolean { return this.#closed; }
  get state(): ConnectionState { return this.#state; }
  get queued(): number { return this.#queue.size; }
  get reconnectAttempts(): number { return this.#attempt; }
  get lastEventId(): string | undefined { return this.#lastEventId; }

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    this.#assertOpen();
    const raw = encodeWireMessage({ t: 'pub', envelope });
    if (Buffer.byteLength(raw, 'utf8') > this.#maxMessageBytes) {
      throw new RealtimeProtocolError('Outgoing frame exceeds the configured byte limit.');
    }
    if (this.#state !== 'open') {
      this.#enqueue(raw);
      return;
    }
    const ok = await this.#post(`/publish?clientId=${encodeURIComponent(this.#clientId)}`, raw);
    if (!ok) this.#enqueue(raw);
  }

  subscribe(channel: string, handler: TransportHandler): Subscription {
    this.#assertOpen();
    if (!isChannelName(channel)) throw new RealtimeProtocolError('Invalid channel name.');
    if (typeof handler !== 'function') throw new RealtimeProtocolError('A handler function is required.');
    let handlers = this.#handlers.get(channel);
    if (!handlers) {
      handlers = new Set<TransportHandler>();
      this.#handlers.set(channel, handlers);
    }
    const set = handlers;
    set.add(handler);
    if (this.#state === 'open') {
      void this.#post(`/subscribe?clientId=${encodeURIComponent(this.#clientId)}&channel=${encodeURIComponent(channel)}`);
    }
    let unsubscribed = false;
    const subscription: Subscription = Object.freeze({
      unsubscribe: (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        set.delete(handler);
        if (set.size === 0) {
          this.#handlers.delete(channel);
          void this.#post(`/unsubscribe?clientId=${encodeURIComponent(this.#clientId)}&channel=${encodeURIComponent(channel)}`);
        }
      },
      get closed(): boolean { return unsubscribed; },
    });
    return subscription;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#setState('closed');
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#heartbeat.stop();
    this.#abort?.abort();
    this.#handlers.clear();
    this.#queue.clear();
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    if (this.#onStateChange) {
      try { this.#onStateChange(state); } catch { /* observer must not break the transport */ }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new RealtimeConnectionError('The realtime transport is closed.');
  }

  #enqueue(raw: string): void {
    const outcome = this.#queue.push(raw);
    if (outcome !== 'ok') this.#report(new RealtimeBackpressureError(`Queued frame dropped: ${outcome}.`));
  }

  #report(error: unknown): void {
    const wrapped = error instanceof RealtimeError
      ? error
      : new RealtimeConnectionError('Realtime transport error.', { cause: toError(error) });
    if (this.#onError) {
      try { this.#onError(wrapped); } catch { /* observer must not break the transport */ }
    }
  }

  async #post(path: string, body?: string): Promise<boolean> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
      });
      if (!response.ok) {
        this.#report(new RealtimeConnectionError(`SSE gateway POST failed (${String(response.status)}).`));
        return false;
      }
      return true;
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const controller = new AbortController();
    this.#abort = controller;
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.#lastEventId !== undefined) headers['Last-Event-ID'] = this.#lastEventId;
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/events?clientId=${encodeURIComponent(this.#clientId)}`,
        { headers, signal: controller.signal },
      );
    } catch (error) {
      this.#report(error);
      this.#scheduleReconnect();
      return;
    }
    if (!response.ok || response.body === null) {
      this.#report(new RealtimeConnectionError(`SSE stream rejected (${String(response.status)}).`));
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed) {
      controller.abort();
      return;
    }
    this.#setState('open');
    this.#attempt = 0;
    for (const channel of this.#handlers.keys()) {
      await this.#post(`/subscribe?clientId=${encodeURIComponent(this.#clientId)}&channel=${encodeURIComponent(channel)}`);
    }
    for (const raw of this.#queue.drain()) {
      await this.#post(`/publish?clientId=${encodeURIComponent(this.#clientId)}`, raw);
    }
    this.#heartbeat.noteActivity();
    this.#heartbeat.start();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        this.#heartbeat.noteActivity();
        buffer += decoder.decode(result.value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          this.#handleFrame(frame);
          index = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!this.#closed) this.#report(error);
    } finally {
      this.#heartbeat.stop();
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    if (!this.#closed) this.#scheduleReconnect();
  }

  #handleFrame(frame: string): void {
    const parsed = parseSseFrame(frame);
    if (parsed.comment) return;
    if (parsed.id !== undefined) this.#lastEventId = parsed.id;
    if (parsed.event !== 'message' || parsed.data === undefined) return;
    let message: WireMessage;
    try {
      message = decodeWireMessage(parsed.data, 'server');
    } catch (error) {
      this.#report(error);
      return;
    }
    if (message.t === 'msg') void this.#deliver(message.envelope);
  }

  async #deliver(envelope: RealtimeEnvelope): Promise<void> {
    const handlers = this.#handlers.get(envelope.channel);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        await handler(envelope);
      } catch (error) {
        this.#report(new RealtimeConnectionError('Subscriber handler failed.', { cause: toError(error) }));
      }
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    const maxAttempts = this.#reconnect.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts;
    if (this.#attempt >= maxAttempts) {
      this.#setState('closed');
      this.#report(new RealtimeConnectionError('Reconnect attempts exhausted.'));
      return;
    }
    const delay = computeReconnectDelay(this.#attempt, this.#reconnect, this.#random);
    this.#attempt += 1;
    this.#setState('reconnecting');
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }
}
