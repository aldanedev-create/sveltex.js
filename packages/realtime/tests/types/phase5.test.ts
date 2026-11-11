import {
  encodeWireMessage,
  decodeWireMessage,
  validateEnvelope,
  isChannelName,
  allowAnonymous,
  denyAnonymous,
  publicWireError,
  REALTIME_PROTOCOL_VERSION,
  MAX_WIRE_MESSAGE_BYTES,
  MAX_ENVELOPE_ID_LENGTH,
} from '@sveltex/realtime/protocol';
import type {
  ClientMessage,
  ServerMessage,
  WireMessage,
  WireDirection,
  GatewayAuthenticator,
} from '@sveltex/realtime/protocol';
import {
  computeReconnectDelay,
  BoundedQueue,
  HeartbeatMonitor,
  DEFAULT_RECONNECT,
} from '@sveltex/realtime/connection';
import type {
  ConnectionState,
  ReconnectOptions,
  OverflowPolicy,
  HeartbeatOptions,
} from '@sveltex/realtime/connection';
import {
  createWebSocketGateway,
  attachWebSocketGateway,
  WebSocketClientTransport,
} from '@sveltex/realtime/websocket';
import type {
  WsGateway,
  WsGatewayOptions,
  WsGatewayMetrics,
  WsAuthContext,
  WsClientTransportOptions,
} from '@sveltex/realtime/websocket';
import {
  createSseGateway,
  SseClientTransport,
} from '@sveltex/realtime/sse';
import type {
  SseGateway,
  SseGatewayOptions,
  SseGatewayMetrics,
  SseAuthContext,
  SseClientTransportOptions,
} from '@sveltex/realtime/sse';
import {
  RealtimeProtocolError,
  RealtimeBackpressureError,
  RealtimeConnectionError,
  REALTIME_CHANNEL_NAME,
} from '@sveltex/realtime';
import type {
  RealtimeTransport,
  RealtimeEnvelope,
  Subscription,
  TransportHandler,
} from '@sveltex/realtime';

// --- protocol -------------------------------------------------------------
const sub: ClientMessage = { t: 'sub', channel: 'chat:general' };
const ready: ServerMessage = { t: 'ready', protocol: REALTIME_PROTOCOL_VERSION };
const anyFrame: WireMessage = sub;
const direction: WireDirection = 'client';
const auth: GatewayAuthenticator<WsAuthContext> = allowAnonymous<WsAuthContext>();
const denied: GatewayAuthenticator<SseAuthContext> = denyAnonymous<SseAuthContext>();
void [ready, anyFrame, direction, auth, denied];

const raw: string = encodeWireMessage(sub);
const decoded: WireMessage = decodeWireMessage(raw, direction);
const rebuilt: RealtimeEnvelope = validateEnvelope({
  id: 'e1', channel: 'chat:general', payload: { text: 'hi' }, publishedAt: 1,
});
const channelOk: boolean = isChannelName('a.b-c_d:1');
const wireErr: ServerMessage = publicWireError(new Error('x'));
const version: number = REALTIME_PROTOCOL_VERSION;
const maxBytes: number = MAX_WIRE_MESSAGE_BYTES;
const maxId: number = MAX_ENVELOPE_ID_LENGTH;
void [decoded, rebuilt, channelOk, wireErr, version, maxBytes, maxId];

// @ts-expect-error an unknown frame tag is not a WireMessage
const bogus: WireMessage = { t: 'exec' };
void bogus;

// --- connection -----------------------------------------------------------
const delay: number = computeReconnectDelay(0, {}, () => 0.5);
const reconnect: ReconnectOptions = { initialDelayMs: 10, maxDelayMs: 100, multiplier: 2, jitterRatio: 0.1, maxAttempts: 5 };
const policy: OverflowPolicy = 'drop-oldest';
const queue: BoundedQueue<string> = new BoundedQueue<string>(4, policy);
const outcome: 'ok' | 'dropped-oldest' | 'dropped-newest' = queue.push('a');
const drained: string[] = queue.drain();
const heartbeatOptions: HeartbeatOptions = { intervalMs: 100, timeoutMs: 300, onPing: () => {} };
const heartbeat = new HeartbeatMonitor(heartbeatOptions);
const state: ConnectionState = 'reconnecting';
const defaults: Readonly<Required<ReconnectOptions>> = DEFAULT_RECONNECT;
void [delay, reconnect, outcome, drained, heartbeat, state, defaults];

// --- websocket ------------------------------------------------------------
const wsOptions: WsGatewayOptions = {
  authenticate: auth,
  path: '/realtime',
  maxMessageBytes: 1024,
  heartbeatIntervalMs: 100,
  heartbeatTimeoutMs: 300,
  maxBufferedBytes: 4096,
};
const wsGateway: Promise<WsGateway> = createWebSocketGateway(wsOptions);
const wsClientOptions: WsClientTransportOptions = { url: 'ws://127.0.0.1:1234/realtime', reconnect };
const wsTransport: RealtimeTransport = new WebSocketClientTransport(wsClientOptions);
const wsMetrics: WsGatewayMetrics = {
  connections: 0, messagesIn: 0, messagesOut: 0, rejected: 0,
  authFailures: 0, heartbeatTimeouts: 0, backpressureDrops: 0,
};
void [wsGateway, wsTransport, wsMetrics, attachWebSocketGateway];

// --- sse ------------------------------------------------------------------
const sseOptions: SseGatewayOptions = {
  authenticate: denied,
  replayBufferSize: 16,
  maxBufferedFrames: 8,
  maxTrackedClients: 32,
};
const sseGateway: Promise<SseGateway> = createSseGateway(sseOptions);
const sseClientOptions: SseClientTransportOptions = { url: 'http://127.0.0.1:1234/realtime', fetchImpl: fetch };
const sseTransport: RealtimeTransport = new SseClientTransport(sseClientOptions);
const sseMetrics: SseGatewayMetrics = {
  connections: 0, messagesIn: 0, messagesOut: 0, rejected: 0,
  authFailures: 0, backpressureDrops: 0, replays: 0,
};
void [sseGateway, sseTransport, sseMetrics];

// --- errors and shared grammar --------------------------------------------
const protocolError: Error = new RealtimeProtocolError('bad frame');
const backpressureError: Error = new RealtimeBackpressureError('full');
const connectionError: Error = new RealtimeConnectionError('down');
const grammar: RegExp = REALTIME_CHANNEL_NAME;
void [protocolError, backpressureError, connectionError, grammar];

// --- transport contract ---------------------------------------------------
const handler: TransportHandler = (env: RealtimeEnvelope) => { void env; };
const subscription: Subscription = wsTransport.subscribe('chat:general', handler);
const published: Promise<void> = sseTransport.publish(rebuilt);
void [subscription, published];
