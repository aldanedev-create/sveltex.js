import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
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
  publicWireError,
  REALTIME_PROTOCOL_VERSION,
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

export interface WsAuthContext {
  readonly request: IncomingMessage;
  readonly url: URL;
}

export interface WsGatewayOptions {
  /** Required in production. Omitted = deny-by-default; pass `allowAnonymous()` to opt in. */
  readonly authenticate?: GatewayAuthenticator<WsAuthContext>;
  readonly path?: string;
  readonly maxMessageBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /** A slow socket whose bufferedAmount exceeds this is terminated (real backpressure). */
  readonly maxBufferedBytes?: number;
  readonly now?: () => number;
  readonly onError?: (error: RealtimeError) => void;
}

export interface WsGatewayMetrics {
  readonly connections: number;
  readonly messagesIn: number;
  readonly messagesOut: number;
  readonly rejected: number;
  readonly authFailures: number;
  readonly heartbeatTimeouts: number;
  readonly backpressureDrops: number;
}

export interface WsGateway {
  readonly url: string;
  readonly port: number;
  readonly connectionCount: number;
  readonly metrics: WsGatewayMetrics;
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
  heartbeatTimeouts: number;
  backpressureDrops: number;
}

interface NormalizedWsOptions {
  readonly authenticate: GatewayAuthenticator<WsAuthContext>;
  readonly path: string;
  readonly maxMessageBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxBufferedBytes: number;
  readonly now: () => number;
  readonly onError: ((error: RealtimeError) => void) | undefined;
}

interface GatewayConnection {
  readonly channels: Set<string>;
  lastPong: number;
  authenticated: boolean;
}

function normalizeWsOptions(options: WsGatewayOptions): NormalizedWsOptions {
  const path = options.path ?? '/realtime';
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new RealtimeConnectionError('Gateway path must be an absolute path without query/fragment.');
  }
  const maxMessageBytes = options.maxMessageBytes ?? MAX_WIRE_MESSAGE_BYTES;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 1024 * 1024) {
    throw new RealtimeConnectionError('maxMessageBytes must be a positive integer <= 1 MiB.');
  }
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RealtimeConnectionError('heartbeatIntervalMs must be >= 1.');
  }
  if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs < heartbeatIntervalMs) {
    throw new RealtimeConnectionError('heartbeatTimeoutMs must be >= heartbeatIntervalMs.');
  }
  const maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new RealtimeConnectionError('maxBufferedBytes must be a positive integer.');
  }
  return {
    authenticate: options.authenticate ?? denyAnonymous<WsAuthContext>(),
    path,
    maxMessageBytes,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    maxBufferedBytes,
    now: options.now ?? Date.now,
    onError: options.onError,
  };
}

function rawDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) {
    const buffers = data.filter((part): part is Buffer => Buffer.isBuffer(part));
    return Buffer.concat(buffers).toString('utf8');
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  throw new RealtimeProtocolError('Unsupported binary frame.');
}

function wireGateway(
  wss: WebSocketServer,
  options: NormalizedWsOptions,
  info: { readonly url: string; readonly port: number; readonly ownServer?: HttpServer },
): WsGateway {
  const connections = new Map<WebSocket, GatewayConnection>();
  const metrics: MutableMetrics = {
    connections: 0, messagesIn: 0, messagesOut: 0, rejected: 0,
    authFailures: 0, heartbeatTimeouts: 0, backpressureDrops: 0,
  };
  let closed = false;

  const report = (error: unknown): void => {
    const wrapped = error instanceof RealtimeError
      ? error
      : new RealtimeConnectionError('Gateway error.', { cause: toError(error) });
    if (options.onError) {
      try { options.onError(wrapped); } catch { /* observer must not break delivery */ }
    }
  };

  const safeSend = (socket: WebSocket, raw: string): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > options.maxBufferedBytes) {
      metrics.backpressureDrops += 1;
      socket.terminate();
      return;
    }
    try { socket.send(raw); } catch (error) { report(error); }
  };

  const broadcast = (envelope: RealtimeEnvelope): void => {
    let raw: string;
    try {
      raw = encodeWireMessage({ t: 'msg', envelope });
    } catch (error) {
      report(error);
      return;
    }
    for (const [socket, connection] of connections) {
      if (!connection.channels.has(envelope.channel)) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > options.maxBufferedBytes) {
        metrics.backpressureDrops += 1;
        socket.terminate();
        continue;
      }
      try {
        socket.send(raw);
        metrics.messagesOut += 1;
      } catch (error) {
        report(error);
      }
    }
  };

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const connection: GatewayConnection = {
      channels: new Set<string>(),
      lastPong: options.now(),
      authenticated: false,
    };
    let disposed = false;

    void (async () => {
      let allowed = false;
      try {
        allowed = await options.authenticate({
          request,
          url: new URL(request.url ?? '/', 'http://localhost'),
        });
      } catch (error) {
        report(error);
      }
      if (disposed || closed || socket.readyState !== WebSocket.OPEN) return;
      if (!allowed) {
        metrics.authFailures += 1;
        socket.close(1008, 'Unauthorized');
        return;
      }
      connection.authenticated = true;
      connections.set(socket, connection);
      metrics.connections += 1;
      safeSend(socket, encodeWireMessage({ t: 'ready', protocol: REALTIME_PROTOCOL_VERSION }));
    })();

    socket.on('message', (data: unknown) => {
      if (!connection.authenticated || closed) {
        metrics.rejected += 1;
        return;
      }
      metrics.messagesIn += 1;
      let raw: string;
      try {
        raw = rawDataToString(data);
      } catch (error) {
        metrics.rejected += 1;
        report(error);
        return;
      }
      if (Buffer.byteLength(raw, 'utf8') > options.maxMessageBytes) {
        metrics.rejected += 1;
        safeSend(socket, encodeWireMessage(publicWireError(new RealtimeProtocolError('oversized'))));
        return;
      }
      let message: WireMessage;
      try {
        message = decodeWireMessage(raw, 'client');
      } catch (error) {
        metrics.rejected += 1;
        safeSend(socket, encodeWireMessage(publicWireError(error)));
        return;
      }
      switch (message.t) {
        case 'sub':
          connection.channels.add(message.channel);
          break;
        case 'unsub':
          connection.channels.delete(message.channel);
          break;
        case 'pub':
          broadcast(message.envelope);
          break;
        case 'pong':
          connection.lastPong = options.now();
          break;
        default:
          metrics.rejected += 1;
          break;
      }
    });

    socket.on('error', (error: unknown) => report(error));
    socket.on('close', () => {
      disposed = true;
      connections.delete(socket);
    });
  });

  const heartbeat = setInterval(() => {
    const current = options.now();
    for (const [socket, connection] of connections) {
      if (current - connection.lastPong >= options.heartbeatTimeoutMs) {
        metrics.heartbeatTimeouts += 1;
        socket.terminate();
        connections.delete(socket);
        continue;
      }
      safeSend(socket, encodeWireMessage({ t: 'ping', at: current }));
    }
  }, options.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    url: info.url,
    port: info.port,
    get connectionCount(): number { return connections.size; },
    subscriptionCount(channel: string): number {
      let count = 0;
      for (const connection of connections.values()) if (connection.channels.has(channel)) count += 1;
      return count;
    },
    get metrics(): WsGatewayMetrics { return Object.freeze({ ...metrics }); },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const socket of [...connections.keys()]) {
        try { socket.terminate(); } catch { /* already gone */ }
      }
      connections.clear();
      await new Promise<void>((resolve) => {
        try { wss.close(() => resolve()); } catch { resolve(); }
      });
      if (info.ownServer) {
        await new Promise<void>((resolve, reject) => {
          info.ownServer?.close((error) => (error ? reject(toError(error)) : resolve()));
        });
      }
    },
  };
}

/** Attach a WebSocket gateway to an existing HTTP server (upgrade path only). */
export function attachWebSocketGateway(server: HttpServer, options: WsGatewayOptions = {}): WsGateway {
  const normalized = normalizeWsOptions(options);
  const wss = new WebSocketServer({
    server,
    path: normalized.path,
    maxPayload: normalized.maxMessageBytes,
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : -1;
  return wireGateway(wss, normalized, {
    url: `ws://127.0.0.1:${String(port)}${normalized.path}`,
    port,
  });
}

/** Create a standalone gateway on a real ephemeral TCP port. */
export async function createWebSocketGateway(
  options: WsGatewayOptions & { readonly port?: number; readonly host?: string } = {},
): Promise<WsGateway> {
  const normalized = normalizeWsOptions(options);
  const host = options.host ?? '127.0.0.1';
  const httpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({
    server: httpServer,
    path: normalized.path,
    maxPayload: normalized.maxMessageBytes,
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new RealtimeConnectionError('Could not determine the gateway port.');
  }
  const url = `ws://${host}:${String(address.port)}${normalized.path}`;
  return wireGateway(wss, normalized, {
    url,
    port: address.port,
    ownServer: httpServer,
  });
}

export interface WsClientTransportOptions {
  readonly url: string;
  readonly reconnect?: ReconnectOptions;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxQueuedMessages?: number;
  readonly overflow?: OverflowPolicy;
  readonly maxMessageBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onError?: (error: RealtimeError) => void;
}

/**
 * A real WebSocket client implementing RealtimeTransport. Two hubs using two of these
 * transports against one gateway exchange real TCP frames — no in-process shortcut.
 */
export class WebSocketClientTransport implements RealtimeTransport {
  readonly #url: string;
  readonly #reconnect: ReconnectOptions;
  readonly #queue: BoundedQueue<string>;
  readonly #handlers = new Map<string, Set<TransportHandler>>();
  readonly #heartbeat: HeartbeatMonitor;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #connectTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxBufferedBytes = 256 * 1024;
  readonly #onStateChange: ((state: ConnectionState) => void) | undefined;
  readonly #onError: ((error: RealtimeError) => void) | undefined;
  #socket: WebSocket | undefined;
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WsClientTransportOptions) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0) {
      throw new RealtimeConnectionError('A WebSocket URL is required.');
    }
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new RealtimeConnectionError('Invalid WebSocket URL.');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new RealtimeConnectionError('URL must use ws: or wss:.');
    }
    this.#url = options.url;
    this.#reconnect = options.reconnect ?? {};
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_WIRE_MESSAGE_BYTES;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onStateChange = options.onStateChange;
    this.#onError = options.onError;
    this.#queue = new BoundedQueue<string>(
      options.maxQueuedMessages ?? 256,
      options.overflow ?? 'error',
    );
    this.#heartbeat = new HeartbeatMonitor({
      intervalMs: options.heartbeatIntervalMs ?? 5_000,
      timeoutMs: options.heartbeatTimeoutMs ?? 15_000,
      now: this.#now,
      onTimeout: () => {
        this.#report(new RealtimeConnectionError('Realtime heartbeat timed out; reconnecting.'));
        this.#heartbeat.stop();
        const socket = this.#socket;
        if (socket) {
          try { socket.terminate(); } catch { /* already gone */ }
        }
      },
    });
    void this.#connect();
  }

  get isClosed(): boolean { return this.#closed; }
  get state(): ConnectionState { return this.#state; }
  get queued(): number { return this.#queue.size; }
  get reconnectAttempts(): number { return this.#attempt; }

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    this.#assertOpen();
    this.#sendRaw(encodeWireMessage({ t: 'pub', envelope }));
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
    if (this.#state === 'open') this.#sendRaw(encodeWireMessage({ t: 'sub', channel }));
    let unsubscribed = false;
    const subscription: Subscription = Object.freeze({
      unsubscribe: (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        set.delete(handler);
        if (set.size === 0) {
          this.#handlers.delete(channel);
          this.#sendRaw(encodeWireMessage({ t: 'unsub', channel }));
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
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      try { socket.close(1000, 'client closed'); } catch { /* already gone */ }
      try { socket.terminate(); } catch { /* already gone */ }
    }
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

  #report(error: unknown): void {
    const wrapped = error instanceof RealtimeError
      ? error
      : new RealtimeConnectionError('Realtime transport error.', { cause: toError(error) });
    if (this.#onError) {
      try { this.#onError(wrapped); } catch { /* observer must not break the transport */ }
    }
  }

  #sendRaw(raw: string): void {
    if (Buffer.byteLength(raw, 'utf8') > this.#maxMessageBytes) {
      throw new RealtimeProtocolError('Outgoing frame exceeds the configured byte limit.');
    }
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > this.#maxBufferedBytes) {
      const outcome = this.#queue.push(raw);
      if (outcome !== 'ok') this.#report(new RealtimeBackpressureError(`Queued frame dropped: ${outcome}.`));
      return;
    }
    try {
      socket.send(raw);
    } catch (error) {
      this.#report(error);
      this.#queue.push(raw);
    }
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    const onEarlyError = (error: unknown): void => {
      rejectConnect(new RealtimeConnectionError('WebSocket connect failed.', { cause: toError(error) }));
    };
    let rejectConnect: (error: Error) => void = () => { /* replaced below */ };
    try {
      await new Promise<void>((resolve, reject) => {
        rejectConnect = reject;
        const timer = setTimeout(() => {
          socket.off('error', onEarlyError);
          try { socket.terminate(); } catch { /* already gone */ }
          reject(new RealtimeConnectionError('WebSocket connect timed out.'));
        }, this.#connectTimeoutMs);
        timer.unref?.();
        socket.once('open', () => {
          clearTimeout(timer);
          socket.off('error', onEarlyError);
          resolve();
        });
        socket.once('error', onEarlyError);
      });
    } catch (error) {
      this.#report(error);
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed) {
      try { socket.terminate(); } catch { /* already gone */ }
      return;
    }
    this.#setState('open');
    this.#attempt = 0;
    for (const channel of this.#handlers.keys()) {
      this.#sendRaw(encodeWireMessage({ t: 'sub', channel }));
    }
    for (const raw of this.#queue.drain()) this.#sendRaw(raw);
    this.#heartbeat.noteActivity();
    this.#heartbeat.start();

    socket.on('message', (data: unknown) => {
      this.#heartbeat.noteActivity();
      let message: WireMessage;
      try {
        message = decodeWireMessage(rawDataToString(data), 'server');
      } catch (error) {
        this.#report(error);
        return;
      }
      switch (message.t) {
        case 'ping':
          this.#sendRaw(encodeWireMessage({ t: 'pong', at: message.at }));
          break;
        case 'msg':
          void this.#deliver(message.envelope);
          break;
        case 'error':
          this.#report(new RealtimeConnectionError(`Gateway rejected a frame (${message.code}).`));
          break;
        default:
          break;
      }
    });
    socket.on('error', (error: unknown) => {
      this.#report(new RealtimeConnectionError('WebSocket socket error.', { cause: toError(error) }));
    });
    socket.on('close', () => {
      this.#heartbeat.stop();
      if (this.#socket === socket) this.#socket = undefined;
      this.#scheduleReconnect();
    });
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
