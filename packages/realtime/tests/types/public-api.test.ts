import {
  defineChannel,
  RealtimeHub,
  allowAll,
  denyAll,
  RealtimeError,
  RealtimeAuthorizationError,
} from '../../dist/index.js';
import type {
  ChannelDefinition,
  RealtimeEnvelope,
  RealtimeTransport,
  RealtimePrincipal,
  AuthorizeHook,
  AuthorizationContext,
  Subscription,
  PublishResult,
  RealtimeMetrics,
  ChannelHandler,
} from '../../dist/index.js';
import { InProcessTransport } from '../../dist/in-process.js';
import type { InProcessTransportOptions } from '../../dist/in-process.js';

type ChatMessage = { readonly text: string; readonly from: string };

const chat = defineChannel<ChatMessage>('chat:general');
const asDefinition: ChannelDefinition<ChatMessage> = chat;
void asDefinition;

const transport: RealtimeTransport = new InProcessTransport();
const options: InProcessTransportOptions = { redeliveries: 1 };
const transport2: RealtimeTransport = new InProcessTransport(options);
void transport2;

const authorize: AuthorizeHook<RealtimePrincipal> = (ctx: AuthorizationContext<RealtimePrincipal>) => ctx.action !== 'deliver';
void authorize;
const allow: AuthorizeHook<RealtimePrincipal> = allowAll<RealtimePrincipal>();
const deny: AuthorizeHook<RealtimePrincipal> = denyAll<RealtimePrincipal>();
void [allow, deny];

const hub: RealtimeHub<RealtimePrincipal> = new RealtimeHub({ transport, authorize });
const handler: ChannelHandler<ChatMessage> = (payload, envelope) => {
  const text: string = payload.text;
  const id: string = envelope.id;
  void [text, id];
};
const sub: Promise<Subscription> = hub.subscribe(chat, handler, { principal: { id: 'u1' } });
const pub: Promise<PublishResult> = hub.publish(chat, { text: 'hi', from: 'u1' }, { principal: { id: 'u1' } });
const metrics: RealtimeMetrics = hub.metrics;
const envelope: Promise<RealtimeEnvelope> = pub.then((r) => r.envelope);
const closed: Promise<void> = hub.close();
void [sub, metrics, envelope, closed];

const err: RealtimeError = new RealtimeAuthorizationError('no');
const code: string = err.code;
void code;

// @ts-expect-error payload must match the channel's typed message
void hub.publish(chat, { wrong: true }, { principal: { id: 'u1' } });

// @ts-expect-error options (with principal) are required
void hub.publish(chat, { text: 'x', from: 'u1' });
