import { toError } from '@sveltex/shared';
import type { Awaitable } from '@sveltex/shared';
import { REALTIME_CHANNEL_NAME, RealtimeProtocolError } from './index.js';
import type { RealtimeEnvelope } from './index.js';

/** Version of the gateway wire protocol. A mismatch is rejected, never guessed. */
export const REALTIME_PROTOCOL_VERSION = 1;
/** Hard ceiling on a single encoded frame. Oversized frames are rejected before JSON parsing. */
export const MAX_WIRE_MESSAGE_BYTES = 64 * 1024;
export const MAX_ENVELOPE_ID_LENGTH = 128;

export type ClientMessage =
  | { readonly t: 'sub'; readonly channel: string }
  | { readonly t: 'unsub'; readonly channel: string }
  | { readonly t: 'pub'; readonly envelope: RealtimeEnvelope }
  | { readonly t: 'pong'; readonly at: number };

export type ServerMessage =
  | { readonly t: 'ready'; readonly protocol: number }
  | { readonly t: 'msg'; readonly envelope: RealtimeEnvelope }
  | { readonly t: 'ping'; readonly at: number }
  | { readonly t: 'pong'; readonly at: number }
  | { readonly t: 'error'; readonly code: string; readonly message: string };

export type WireMessage = ClientMessage | ServerMessage;
/** Which side is allowed to emit a frame. Gateways parse `client`, clients parse `server`. */
export type WireDirection = 'client' | 'server' | 'any';

/** Authentication hook shared by the WebSocket and SSE gateways. */
export type GatewayAuthenticator<C> = (context: C) => Awaitable<boolean>;
/** Explicit opt-in for an unauthenticated gateway. Hubs still require their own authorize hook. */
export function allowAnonymous<C>(): GatewayAuthenticator<C> {
  return () => true;
}
/** Deny-by-default authenticator. */
export function denyAnonymous<C>(): GatewayAuthenticator<C> {
  return () => false;
}

const CLIENT_TAGS = new Set(['sub', 'unsub', 'pub', 'pong']);
const SERVER_TAGS = new Set(['ready', 'msg', 'ping', 'pong', 'error']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isChannelName(value: unknown): value is string {
  return typeof value === 'string' && REALTIME_CHANNEL_NAME.test(value);
}

/**
 * Walk the *original* value before JSON.stringify. This is required because stringify invokes
 * `toJSON()` before its replacer, so a Date/Map would otherwise silently change type.
 */
function assertSerializable(value: unknown, path: string, stack: WeakSet<object>): void {
  const kind = typeof value;
  if (value === undefined) throw new RealtimeProtocolError(`undefined cannot be encoded (${path}).`);
  if (kind === 'bigint') throw new RealtimeProtocolError(`BigInt cannot be encoded (${path}).`);
  if (kind === 'symbol') throw new RealtimeProtocolError(`Symbol cannot be encoded (${path}).`);
  if (kind === 'function') throw new RealtimeProtocolError(`Function cannot be encoded (${path}).`);
  if (kind === 'number' && !Number.isFinite(value as number)) {
    throw new RealtimeProtocolError(`Non-finite number cannot be encoded (${path}).`);
  }
  if (value === null || kind === 'string' || kind === 'boolean' || kind === 'number') return;
  if (kind !== 'object') throw new RealtimeProtocolError(`Unsupported value at ${path}.`);

  const object = value as object;
  if (stack.has(object)) throw new RealtimeProtocolError(`Circular reference at ${path}.`);
  const isArray = Array.isArray(object);
  const prototype = Object.getPrototypeOf(object);
  const allowedPrototype = isArray ? Array.prototype : Object.prototype;
  if (prototype !== allowedPrototype && prototype !== null) {
    throw new RealtimeProtocolError(`Only plain objects and arrays can be encoded (${path}).`);
  }
  if ('toJSON' in object) throw new RealtimeProtocolError(`toJSON-bearing values cannot be encoded (${path}).`);
  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw new RealtimeProtocolError(`Symbol-keyed properties cannot be encoded (${path}).`);
  }

  stack.add(object);
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index += 1) {
      assertSerializable(object[index], `${path}[${String(index)}]`, stack);
    }
  } else {
    const record = object as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new RealtimeProtocolError(`Unsafe key ${key} at ${path}.`);
      }
      assertSerializable(record[key], `${path}.${key}`, stack);
    }
  }
  stack.delete(object);
}

/** Encode a frame into a byte-bounded, strictly validated JSON string. */
export function encodeWireMessage(message: WireMessage): string {
  assertSerializable(message, '$', new WeakSet<object>());
  // Protocol-level fields are checked at the outbound boundary too, so an invalid channel or
  // envelope never leaves a client and gets rejected locally instead of by a remote gateway.
  if (message.t === 'sub' || message.t === 'unsub') {
    if (!isChannelName(message.channel)) {
      throw new RealtimeProtocolError('Invalid channel in outbound frame.');
    }
  } else if (message.t === 'pub' || message.t === 'msg') {
    validateEnvelope(message.envelope);
  }
  let raw: string;
  try {
    raw = JSON.stringify(message);
  } catch (error) {
    throw new RealtimeProtocolError('Failed to encode the realtime frame.', { cause: toError(error) });
  }
  if (typeof raw !== 'string') throw new RealtimeProtocolError('Frame encoded to an empty value.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_WIRE_MESSAGE_BYTES) {
    throw new RealtimeProtocolError(`Frame exceeds ${String(MAX_WIRE_MESSAGE_BYTES)} bytes.`);
  }
  return raw;
}

/** Validate and rebuild a clean envelope. Extra keys are dropped; `__proto__` never survives. */
export function validateEnvelope(value: unknown): RealtimeEnvelope {
  if (!isRecord(value)) throw new RealtimeProtocolError('Envelope must be an object.');
  const id = value['id'];
  const channel = value['channel'];
  const publishedAt = value['publishedAt'];
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ENVELOPE_ID_LENGTH || CONTROL_CHARACTERS.test(id)) {
    throw new RealtimeProtocolError('Invalid envelope id.');
  }
  if (!isChannelName(channel)) throw new RealtimeProtocolError('Invalid envelope channel.');
  if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt)) {
    throw new RealtimeProtocolError('Invalid envelope publishedAt.');
  }
  if (!('payload' in value)) throw new RealtimeProtocolError('Envelope is missing its payload.');
  return Object.freeze({ id, channel, payload: value['payload'], publishedAt });
}

function finiteTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RealtimeProtocolError('Invalid heartbeat timestamp.');
  }
  return value;
}

/**
 * Decode an inbound frame. Malformed, oversized, unknown-tag, wrong-direction, prototype-
 * polluting and legacy frames all raise RealtimeProtocolError rather than becoming silent drops.
 */
export function decodeWireMessage(raw: string, direction: WireDirection = 'any'): WireMessage {
  if (typeof raw !== 'string') throw new RealtimeProtocolError('Frame must be a string.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_WIRE_MESSAGE_BYTES) {
    throw new RealtimeProtocolError(`Frame exceeds ${String(MAX_WIRE_MESSAGE_BYTES)} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key: string, value: unknown) => (key === '__proto__' ? undefined : value));
  } catch (error) {
    throw new RealtimeProtocolError('Malformed JSON frame.', { cause: toError(error) });
  }
  if (!isRecord(parsed)) throw new RealtimeProtocolError('Frame must be an object.');
  const tag = parsed['t'];
  if (typeof tag !== 'string') throw new RealtimeProtocolError('Frame is missing its tag.');
  if (direction === 'client' && !CLIENT_TAGS.has(tag)) throw new RealtimeProtocolError(`Unexpected client tag: ${tag}`);
  if (direction === 'server' && !SERVER_TAGS.has(tag)) throw new RealtimeProtocolError(`Unexpected server tag: ${tag}`);

  switch (tag) {
    case 'sub':
    case 'unsub': {
      const channel = parsed['channel'];
      if (!isChannelName(channel)) throw new RealtimeProtocolError('Invalid channel in subscription frame.');
      return Object.freeze({ t: tag, channel }) as unknown as WireMessage;
    }
    case 'pub':
    case 'msg': {
      const envelope = validateEnvelope(parsed['envelope']);
      return Object.freeze({ t: tag, envelope }) as unknown as WireMessage;
    }
    case 'ping':
    case 'pong': {
      return Object.freeze({ t: tag, at: finiteTimestamp(parsed['at']) }) as unknown as WireMessage;
    }
    case 'ready': {
      if (parsed['protocol'] !== REALTIME_PROTOCOL_VERSION) {
        throw new RealtimeProtocolError('Unsupported realtime protocol version.');
      }
      return Object.freeze({ t: 'ready', protocol: REALTIME_PROTOCOL_VERSION }) as unknown as WireMessage;
    }
    case 'error': {
      const code = parsed['code'];
      const message = parsed['message'];
      if (typeof code !== 'string' || typeof message !== 'string') {
        throw new RealtimeProtocolError('Invalid error frame.');
      }
      return Object.freeze({ t: 'error', code, message }) as unknown as WireMessage;
    }
    default:
      throw new RealtimeProtocolError(`Unknown frame tag: ${tag}`);
  }
}

/** Fixed, non-leaking error text sent back over the wire. */
export function publicWireError(error: unknown): ServerMessage {
  const code = error instanceof RealtimeProtocolError ? 'SX_REALTIME_PROTOCOL' : 'SX_REALTIME_TRANSPORT';
  return Object.freeze({ t: 'error' as const, code, message: 'The realtime frame was rejected.' });
}
