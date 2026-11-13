import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { Options as MailOptions, Attachment as NodemailerAttachment } from 'nodemailer/lib/mailer/index.js';
import {
  MailTransportError,
  MailConfigurationError,
  MailClosedError,
  MailValidationError,
  validateMessage,
  attachmentBytes,
  type MailMessage,
  type MailAddress,
  type MailTransport,
  type TransportReceipt,
  type MailDeliveryInfo,
} from './index.js';

/** SMTP AUTH credentials. Never logged, never included in error details. */
export interface SmtpCredentials {
  readonly user: string;
  readonly pass: string;
}

export interface SmtpTlsOptions {
  /** Default true. Setting false is only appropriate for a trusted test server with a self-signed cert. */
  readonly rejectUnauthorized?: boolean;
  readonly servername?: string;
}

export interface SmtpTransportOptions {
  readonly host: string;
  readonly port?: number;
  /** Implicit TLS from the first byte (port 465). */
  readonly secure?: boolean;
  /** Require a successful STARTTLS upgrade before AUTH/DATA. */
  readonly requireTLS?: boolean;
  readonly auth?: SmtpCredentials;
  readonly tls?: SmtpTlsOptions;
  readonly connectionTimeoutMs?: number;
  readonly greetingTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
  readonly pool?: boolean;
  readonly maxConnections?: number;
  readonly maxMessages?: number;
  /** Injectable clock for deterministic receipts. */
  readonly now?: () => number;
  /** Injectable Message-ID seed when the server does not supply one. */
  readonly generateId?: () => string;
}

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
const CRLF = /[\r\n\u0000]/;
const MAX_TIMEOUT_MS = 120_000;

function assertHostname(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253 || CRLF.test(value) || !HOSTNAME.test(value)) {
    throw new MailConfigurationError(`${label} must be a valid hostname without credentials, whitespace, or control characters.`);
  }
}

function assertBoundedInt(value: unknown, label: string, min: number, max: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)) {
    throw new MailConfigurationError(`${label} must be an integer between ${min} and ${max}.`);
  }
}

function validateConfig(options: SmtpTransportOptions): void {
  if (!options || typeof options !== 'object') throw new MailConfigurationError('SMTP transport options are required.');
  assertHostname(options.host, 'host');
  assertBoundedInt(options.port, 'port', 1, 65535);
  if (options.secure !== undefined && typeof options.secure !== 'boolean') throw new MailConfigurationError('secure must be a boolean.');
  if (options.requireTLS !== undefined && typeof options.requireTLS !== 'boolean') throw new MailConfigurationError('requireTLS must be a boolean.');
  if (options.pool !== undefined && typeof options.pool !== 'boolean') throw new MailConfigurationError('pool must be a boolean.');
  for (const [label, value] of [['connectionTimeoutMs', options.connectionTimeoutMs], ['greetingTimeoutMs', options.greetingTimeoutMs], ['socketTimeoutMs', options.socketTimeoutMs]] as const) {
    assertBoundedInt(value, label, 1, MAX_TIMEOUT_MS);
  }
  assertBoundedInt(options.maxConnections, 'maxConnections', 1, 100);
  assertBoundedInt(options.maxMessages, 'maxMessages', 1, 10000);
  if (options.auth !== undefined) {
    const { user, pass } = options.auth;
    if (!user || typeof user !== 'string' || user.length > 256 || CRLF.test(user) || !pass || typeof pass !== 'string' || pass.length > 1024 || CRLF.test(pass)) {
      throw new MailConfigurationError('auth.user and auth.pass must be non-empty, bounded strings without control characters.');
    }
  }
  if (options.tls !== undefined) {
    if (options.tls.rejectUnauthorized !== undefined && typeof options.tls.rejectUnauthorized !== 'boolean') {
      throw new MailConfigurationError('tls.rejectUnauthorized must be a boolean.');
    }
    if (options.tls.servername !== undefined) assertHostname(options.tls.servername, 'tls.servername');
  }
}

/** Map a validated SvelteX attachment to a nodemailer attachment (bytes are copied, never a path/URL). */
function toNodemailerAttachment(attachment: NonNullable<MailMessage['attachments']>[number]): NodemailerAttachment {
  const bytes = attachmentBytes(attachment);
  return {
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: Buffer.from(bytes),
    ...(attachment.contentId !== undefined ? { cid: attachment.contentId } : {}),
    contentDisposition: attachment.inline === true ? 'inline' : 'attachment',
  };
}

function toAddress(address: MailAddress): { name?: string; address: string } {
  return address.name === undefined ? { address: address.email } : { name: address.name, address: address.email };
}

/** Convert a validated MailMessage to nodemailer MailOptions. Exported for adapter-level tests. */
export function toNodemailerMessage(message: MailMessage): MailOptions {
  validateMessage(message);
  return {
    from: toAddress(message.from),
    to: message.to.map(toAddress),
    ...(message.cc !== undefined ? { cc: message.cc.map(toAddress) } : {}),
    ...(message.bcc !== undefined ? { bcc: message.bcc.map(toAddress) } : {}),
    ...(message.replyTo !== undefined ? { replyTo: toAddress(message.replyTo) } : {}),
    subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}),
    ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments.map(toNodemailerAttachment) } : {}),
    // Defense in depth: nodemailer must never resolve file:// or http(s):// from
    // any message field. All content is supplied in memory by the caller.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function asAddressList(value: readonly (string | { address?: string })[]): string[] {
  return value.map((entry) => (typeof entry === 'string' ? entry : (entry.address ?? String(entry))));
}

/**
 * Real SMTP transport backed by the official nodemailer client. Speaks the full
 * SMTP protocol (EHLO/AUTH/STARTTLS/MAIL FROM/RCPT TO/DATA) over a TCP socket.
 * Credentials are never placed in error messages or `details`.
 */
export class SmtpTransport implements MailTransport {
  readonly #transporter: Transporter<SMTPTransport.SentMessageInfo>;
  readonly #now: () => number;
  readonly #generateId: () => string;
  #closed = false;

  constructor(options: SmtpTransportOptions) {
    validateConfig(options);
    const secure = options.secure ?? false;
    const transporterOptions: SMTPTransport.Options = {
      host: options.host,
      port: options.port ?? (secure ? 465 : 587),
      secure,
      ...(options.requireTLS !== undefined ? { requireTLS: options.requireTLS } : {}),
      ...(options.auth !== undefined ? { auth: { user: options.auth.user, pass: options.auth.pass } } : {}),
      tls: {
        rejectUnauthorized: options.tls?.rejectUnauthorized ?? true,
        ...(options.tls?.servername !== undefined ? { servername: options.tls.servername } : {}),
      },
      ...(options.connectionTimeoutMs !== undefined ? { connectionTimeout: options.connectionTimeoutMs } : {}),
      ...(options.greetingTimeoutMs !== undefined ? { greetingTimeout: options.greetingTimeoutMs } : {}),
      ...(options.socketTimeoutMs !== undefined ? { socketTimeout: options.socketTimeoutMs } : {}),
      ...(options.pool !== undefined ? { pool: options.pool } : {}),
      ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
      ...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {}),
    };
    this.#transporter = createTransport(transporterOptions);
    this.#now = options.now ?? (() => Date.now());
    this.#generateId = options.generateId ?? (() => `sveltex-${Date.now().toString(36)}`);
  }

  get isClosed(): boolean { return this.#closed; }

  /** Verify the SMTP connection/AUTH without sending mail (real network round-trip). */
  async verify(): Promise<void> {
    if (this.#closed) throw new MailClosedError('The SMTP transport is closed.');
    try {
      await this.#transporter.verify();
    } catch (error) {
      throw new MailTransportError('SMTP connection verification failed.', {
        ...wrapCause(error),
        details: { operation: 'verify', backend: 'smtp' },
      });
    }
  }

  async send(message: MailMessage): Promise<TransportReceipt> {
    if (this.#closed) throw new MailClosedError('The SMTP transport is closed.');
    let mailOptions: MailOptions;
    try {
      mailOptions = toNodemailerMessage(message);
    } catch (error) {
      if (error instanceof MailValidationError) throw error;
      throw new MailTransportError('The message could not be prepared for SMTP delivery.', {
        ...wrapCause(error),
        details: { operation: 'prepare', backend: 'smtp' },
      });
    }
    let info: SMTPTransport.SentMessageInfo;
    try {
      info = await this.#transporter.sendMail(mailOptions);
    } catch (error) {
      throw new MailTransportError('SMTP delivery failed.', {
        ...wrapCause(error),
        details: { operation: 'send', backend: 'smtp' },
      });
    }
    const envelopeFrom = typeof info.envelope?.from === 'string' ? info.envelope.from : undefined;
    const envelopeTo = Array.isArray(info.envelope?.to) ? asAddressList(info.envelope.to) : undefined;
    const delivery: MailDeliveryInfo = Object.freeze({
      accepted: Object.freeze(asAddressList(info.accepted ?? [])),
      rejected: Object.freeze(asAddressList(info.rejected ?? [])),
      response: typeof info.response === 'string' ? info.response.slice(0, 512) : '',
      backend: 'smtp' as const,
      ...(envelopeFrom !== undefined ? { envelopeFrom } : {}),
      ...(envelopeTo !== undefined ? { envelopeTo } : {}),
    });
    const messageId = typeof info.messageId === 'string' && info.messageId.length > 0 && info.messageId.length <= 512 && !CRLF.test(info.messageId)
      ? info.messageId
      : `<${this.#generateId()}@${'localhost'}>`;
    return Object.freeze({ messageId, acceptedAt: this.#now(), delivery });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#transporter.close();
  }
}

function wrapCause(error: unknown): { cause?: Error } {
  // nodemailer errors can contain server responses; keep the cause but never
  // decorate it with credentials. Callers get the underlying Error only.
  return error instanceof Error ? { cause: error } : {};
}
