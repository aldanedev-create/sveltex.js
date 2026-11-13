import {
  Mailer,
  renderTemplate,
  escapeHtml,
  validateMessage,
  validateAddress,
  computeRetryDelay,
  DEFAULT_RETRY,
  MailError,
  MailValidationError,
  MailTemplateError,
  MailTransportError,
  MailSendError,
  MailClosedError,
} from '../../dist/index.js';
import type {
  MailAddress,
  MailMessage,
  MailTransport,
  TransportReceipt,
  SendReceipt,
  MailTemplate,
  RenderedMail,
  RenderTemplateOptions,
  RetryPolicy,
  MailerOptions,
  SendTemplateOptions,
  ValidateMessageOptions,
} from '../../dist/index.js';
import { TestTransport } from '../../dist/test-transport.js';
import type { TestTransportOptions, SentMail } from '../../dist/test-transport.js';

const addr: MailAddress = { email: 'a@b.com', name: 'A' };
const message: MailMessage = { from: addr, to: [addr], subject: 'Hi', text: 'body' };
void validateAddress(addr, 'from');
const validateOpts: ValidateMessageOptions = { maxBodyBytes: 100 };
void validateMessage(message, validateOpts);

const tpl: MailTemplate = { subject: 'Hi {{ name }}', html: '<b>{{ name }}</b>' };
const renderOpts: RenderTemplateOptions = { escapeHtml: true, allowMissing: false };
const rendered: RenderedMail = renderTemplate(tpl, { name: 'A' }, renderOpts);
const html: string = escapeHtml('<x>');
void [rendered, html, tpl, renderOpts];

const retry: RetryPolicy = DEFAULT_RETRY;
const delay: number = computeRetryDelay(2, retry);
void delay;

const transportOpts: TestTransportOptions = { failFirst: 1, now: () => 0 };
const transport: MailTransport = new TestTransport(transportOpts);
const receipt: Promise<TransportReceipt> = transport.send(message);
void receipt;
const sent: readonly SentMail[] = new TestTransport().sent;
void sent;

const mailerOpts: MailerOptions = { transport, retry, sleep: async () => {}, now: () => 0 };
const mailer: Mailer = new Mailer(mailerOpts);
const sendResult: Promise<SendReceipt> = mailer.send(message);
const envelope: SendTemplateOptions = { from: addr, to: [addr], data: { name: 'A' } };
const templated: Promise<SendReceipt> = mailer.sendTemplate(tpl, envelope);
const closed: Promise<void> = mailer.close();
void [sendResult, templated, closed, mailerOpts];

const err: MailError = new MailValidationError('bad');
const code: string = err.code;
const attempts: number = new MailSendError('x', 3).attempts;
void [code, attempts, MailTemplateError, MailTransportError, MailClosedError];

// @ts-expect-error "to" is required
void validateMessage({ from: addr, subject: 'x', text: 'y' });

// ---- Phase 8 public API ------------------------------------------------------
import {
  attachmentBytes,
  validateAttachment,
  MailConfigurationError,
  MAX_ATTACHMENTS,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_LENGTH,
  MAX_ATTACHMENT_CONTENT_TYPE_LENGTH,
  MAX_ATTACHMENT_CONTENT_ID_LENGTH,
} from '../../dist/index.js';
import type {
  MailAttachment,
  MailDeliveryInfo,
} from '../../dist/index.js';

const attachment: MailAttachment = {
  filename: 'report.txt',
  contentType: 'text/plain',
  content: new Uint8Array([1, 2, 3]),
  encoding: 'base64',
  contentId: 'cid-1',
  inline: true,
};
const bytes: Uint8Array = attachmentBytes(attachment);
void validateAttachment(attachment, 'attachments[0]');
const limits: readonly number[] = [
  MAX_ATTACHMENTS, DEFAULT_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_LENGTH, MAX_ATTACHMENT_CONTENT_TYPE_LENGTH, MAX_ATTACHMENT_CONTENT_ID_LENGTH,
];
void [bytes, limits];
const configErr: MailConfigurationError = new MailConfigurationError('bad config');
void configErr.code;

const delivery: MailDeliveryInfo = {
  accepted: ['a@b.com'],
  rejected: [],
  response: '250 OK',
  backend: 'smtp',
  envelopeFrom: 'noreply@example.com',
  envelopeTo: ['a@b.com'],
};
const receiptWithDelivery: TransportReceipt = { messageId: '<x@y>', acceptedAt: 0, delivery };
void receiptWithDelivery;

const withAttachments: MailMessage = { ...message, attachments: [attachment] };
void withAttachments;
const validateOpts8: ValidateMessageOptions = {
  maxBodyBytes: 100, maxAttachmentBytes: 100, maxTotalAttachmentBytes: 200, maxAttachments: 2,
};
void validateOpts8;
const mailerOpts8: MailerOptions = {
  transport, maxAttachmentBytes: 100, maxTotalAttachmentBytes: 200, maxAttachments: 2,
};
void mailerOpts8;
const templateOpts8: SendTemplateOptions = { ...envelope, attachments: [attachment] };
void templateOpts8;

// @ts-expect-error attachment content must be a string or Uint8Array
const badAttachment: MailAttachment = { filename: 'a', contentType: 'text/plain', content: 42 };
void badAttachment;
// @ts-expect-error backend is a closed union
const badDelivery: MailDeliveryInfo = { accepted: [], rejected: [], response: '', backend: 'carrier-pigeon' };
void badDelivery;
// @ts-expect-error transport is required
void new Mailer({ retry });

// ---- ./mime ------------------------------------------------------------------
import { buildMimeMessage } from '../../dist/mime.js';
import type { MimeEnvelope, MimeDocument, BuildMimeOptions } from '../../dist/mime.js';

const mimeOptions: BuildMimeOptions = { now: () => 0, generateId: () => 'id', generateBoundary: () => 'b' };
const doc: MimeDocument = buildMimeMessage(message, mimeOptions);
const env: MimeEnvelope = doc.envelope;
const raw: string = doc.raw;
void [env, raw];
// @ts-expect-error a MailMessage is required
void buildMimeMessage(undefined);

// ---- ./smtp ------------------------------------------------------------------
import { SmtpTransport, toNodemailerMessage } from '../../dist/smtp.js';
import type { SmtpCredentials, SmtpTlsOptions, SmtpTransportOptions } from '../../dist/smtp.js';

const creds: SmtpCredentials = { user: 'u', pass: 'p' };
const tls: SmtpTlsOptions = { rejectUnauthorized: true, servername: 'smtp.example.com' };
const smtpOptions: SmtpTransportOptions = {
  host: 'smtp.example.com', port: 587, secure: false, requireTLS: true,
  auth: creds, tls, connectionTimeoutMs: 1000, pool: true,
};
const smtp: SmtpTransport = new SmtpTransport(smtpOptions);
const smtpAsTransport: MailTransport = smtp;
const verify: Promise<void> = smtp.verify();
void [smtpAsTransport, verify, toNodemailerMessage(message)];
// @ts-expect-error secure must be a boolean
const badSmtp: SmtpTransportOptions = { host: 'h', secure: 'yes' };
void badSmtp;

// ---- ./http ------------------------------------------------------------------
import {
  HttpTransport, buildHttpPayload,
  MAIL_HTTP_ENVELOPE_VERSION, MAIL_HTTP_CONTENT_TYPE,
} from '../../dist/http.js';
import type { HttpTransportOptions, HttpMailPayload } from '../../dist/http.js';

const httpOptions: HttpTransportOptions = {
  endpoint: 'https://example.com/send', headers: { Authorization: 'Bearer x' },
  allowedHosts: ['example.com'], timeoutMs: 5000, maxResponseBytes: 4096,
};
const http: HttpTransport = new HttpTransport(httpOptions);
const httpAsTransport: MailTransport = http;
const payload: HttpMailPayload = buildHttpPayload(message);
const version: number = MAIL_HTTP_ENVELOPE_VERSION;
const contentType: string = MAIL_HTTP_CONTENT_TYPE;
void [httpAsTransport, payload, version, contentType];
// @ts-expect-error endpoint is required
const badHttp: HttpTransportOptions = { timeoutMs: 1000 };
void badHttp;

// ---- ./auth ------------------------------------------------------------------
import {
  createPasswordResetMailSender,
  createEmailVerificationMailSender,
} from '../../dist/auth.js';
import type {
  TemplateMailer, AuthMailContext, AuthMailSender, AuthMailSenderOptions,
} from '../../dist/auth.js';

const templateMailer: TemplateMailer = mailer;
const senderOptions: AuthMailSenderOptions = {
  mailer: templateMailer, from: addr, endpoint: 'https://app.example.com/reset',
  tokenParam: 'token', appName: 'SvelteX', attachments: [attachment],
};
const resetSender: AuthMailSender = createPasswordResetMailSender(senderOptions);
const verifySender: AuthMailSender = createEmailVerificationMailSender(senderOptions);
const ctx: AuthMailContext = { email: 'a@b.com', token: 't', expiresAt: 0 };
const senderResult: Promise<void> = resetSender.send(ctx);
void [verifySender, senderResult];
// @ts-expect-error mailer is required
const badSender: AuthMailSenderOptions = { from: addr, endpoint: 'https://app.example.com/reset' };
void badSender;
