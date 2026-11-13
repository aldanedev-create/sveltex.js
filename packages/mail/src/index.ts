import { SvelteXError, toError } from '@sveltex/shared';

export interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

/**
 * A file attached to a message. `content` is either raw bytes, a UTF-8 string,
 * or a base64 string when `encoding: 'base64'` is set. Filenames are validated
 * against header injection, path traversal and control characters before any
 * provider ever sees them (see SEC-072, SEC-073).
 */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string | Uint8Array;
  readonly encoding?: 'base64';
  readonly contentId?: string;
  readonly inline?: boolean;
}

export const MAX_ATTACHMENTS = 20;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;
export const MAX_ATTACHMENT_CONTENT_TYPE_LENGTH = 255;
export const MAX_ATTACHMENT_CONTENT_ID_LENGTH = 128;

export interface MailMessage {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
  readonly bcc?: readonly MailAddress[];
  readonly replyTo?: MailAddress;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly MailAttachment[];
}

/** Provider-reported delivery metadata. Never contains credentials. */
export interface MailDeliveryInfo {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly response: string;
  readonly backend: 'smtp' | 'http' | 'test';
  readonly envelopeFrom?: string;
  readonly envelopeTo?: readonly string[];
}

export interface TransportReceipt {
  readonly messageId: string;
  readonly acceptedAt: number;
  readonly delivery?: MailDeliveryInfo;
}

/** Contract for a mail delivery backend (SMTP, HTTP API, ...). */
export interface MailTransport {
  send(message: MailMessage): Promise<TransportReceipt>;
  close(): Promise<void>;
  readonly isClosed: boolean;
}

export interface SendReceipt extends TransportReceipt {
  readonly attempts: number;
}

export interface MailErrorOptions {
  readonly cause?: Error;
  readonly details?: Record<string, unknown>;
}
export class MailError extends SvelteXError {
  constructor(code: string, message: string, options: MailErrorOptions = {}) {
    super(message, {
      code,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
    this.name = 'MailError';
  }
}
export class MailValidationError extends MailError {
  constructor(message: string, options: MailErrorOptions = {}) {
    super('SX_MAIL_VALIDATION', message, options);
    this.name = 'MailValidationError';
  }
}
export class MailTemplateError extends MailError {
  constructor(message: string, options: MailErrorOptions = {}) {
    super('SX_MAIL_TEMPLATE', message, options);
    this.name = 'MailTemplateError';
  }
}
export class MailTransportError extends MailError {
  constructor(message: string, options: MailErrorOptions = {}) {
    super('SX_MAIL_TRANSPORT', message, options);
    this.name = 'MailTransportError';
  }
}
export class MailSendError extends MailError {
  readonly attempts: number;
  constructor(message: string, attempts: number, options: MailErrorOptions = {}) {
    super('SX_MAIL_SEND', message, options);
    this.name = 'MailSendError';
    this.attempts = attempts;
  }
}
export class MailClosedError extends MailError {
  constructor(message: string, options: MailErrorOptions = {}) {
    super('SX_MAIL_CLOSED', message, options);
    this.name = 'MailClosedError';
  }
}
/** Invalid provider/adapter configuration (host, TLS, endpoint, credentials shape). */
export class MailConfigurationError extends MailError {
  constructor(message: string, options: MailErrorOptions = {}) {
    super('SX_MAIL_CONFIG', message, options);
    this.name = 'MailConfigurationError';
  }
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const CRLF = /[\r\n\u0000]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+/=-]+)*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEADER_INJECTION = /[\r\n\u0000]/;
/** Custom headers may never shadow structural or recipient headers (BCC leaks, MIME smuggling). */
const RESERVED_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'reply-to', 'date', 'message-id',
  'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition',
  'content-id', 'return-path', 'sender',
]);

function assertNoInjection(value: string, label: string): void {
  if (CRLF.test(value)) throw new MailValidationError(`${label} must not contain CRLF or NUL characters.`);
}

/** Decode an attachment's `content` into raw bytes, validating base64 strictly. */
export function attachmentBytes(attachment: MailAttachment): Uint8Array {
  if (attachment.encoding === 'base64') {
    if (typeof attachment.content !== 'string' || attachment.content.length % 4 !== 0 || !BASE64.test(attachment.content)) {
      throw new MailValidationError('A base64 attachment must contain valid, padded base64 text.');
    }
    return new Uint8Array(Buffer.from(attachment.content, 'base64'));
  }
  if (typeof attachment.content === 'string') return new Uint8Array(Buffer.from(attachment.content, 'utf8'));
  return new Uint8Array(attachment.content);
}

/** Validate one attachment. Throws MailValidationError on any unsafe shape. */
export function validateAttachment(attachment: MailAttachment, label: string): void {
  if (!attachment || typeof attachment !== 'object') throw new MailValidationError(`${label} must be an attachment object.`);
  if (typeof attachment.filename !== 'string' || attachment.filename.length === 0 || attachment.filename.length > MAX_ATTACHMENT_FILENAME_LENGTH) {
    throw new MailValidationError(`${label}.filename is invalid.`);
  }
  // Header injection + path traversal + control characters. ':' is rejected so a
  // filename can never carry a scheme or a Windows drive, and separators so a
  // provider that writes to disk can never escape its attachment directory.
  if (CONTROL.test(attachment.filename) || /[\\/:]/.test(attachment.filename) || attachment.filename === '.' || attachment.filename === '..' || attachment.filename.startsWith('.')) {
    throw new MailValidationError(`${label}.filename must not contain control characters, path separators, colons, or leading/traversal dots.`);
  }
  if (typeof attachment.contentType !== 'string' || attachment.contentType.length === 0 || attachment.contentType.length > MAX_ATTACHMENT_CONTENT_TYPE_LENGTH || HEADER_INJECTION.test(attachment.contentType) || !MIME_TYPE.test(attachment.contentType)) {
    throw new MailValidationError(`${label}.contentType is not a valid MIME type.`);
  }
  if (attachment.encoding !== undefined && attachment.encoding !== 'base64') {
    throw new MailValidationError(`${label}.encoding must be 'base64' when provided.`);
  }
  if (typeof attachment.content !== 'string' && !(attachment.content instanceof Uint8Array)) {
    throw new MailValidationError(`${label}.content must be a string or Uint8Array.`);
  }
  if (attachment.contentId !== undefined) {
    if (typeof attachment.contentId !== 'string' || attachment.contentId.length === 0 || attachment.contentId.length > MAX_ATTACHMENT_CONTENT_ID_LENGTH || CONTROL.test(attachment.contentId) || /[<>\s]/.test(attachment.contentId)) {
      throw new MailValidationError(`${label}.contentId is invalid.`);
    }
  }
  if (attachment.inline !== undefined && typeof attachment.inline !== 'boolean') {
    throw new MailValidationError(`${label}.inline must be a boolean.`);
  }
}

export function validateAddress(address: MailAddress, label: string): void {
  if (!address || typeof address !== 'object') throw new MailValidationError(`${label} must be an address object.`);
  if (typeof address.email !== 'string' || address.email.length > 254 || !EMAIL.test(address.email)) {
    throw new MailValidationError(`${label} has an invalid email address.`);
  }
  assertNoInjection(address.email, `${label}.email`);
  if (address.name !== undefined) {
    if (typeof address.name !== 'string' || address.name.length > 128) throw new MailValidationError(`${label}.name is invalid.`);
    assertNoInjection(address.name, `${label}.name`);
  }
}

export interface ValidateMessageOptions {
  readonly maxBodyBytes?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxTotalAttachmentBytes?: number;
  readonly maxAttachments?: number;
}

/** Validate a message. Header-injection surfaces (CRLF/NUL) are rejected everywhere they could reach a header. */
export function validateMessage(message: MailMessage, options: ValidateMessageOptions = {}): void {
  if (!message || typeof message !== 'object') throw new MailValidationError('A message object is required.');
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxTotalAttachmentBytes = options.maxTotalAttachmentBytes ?? DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES;
  const maxAttachments = options.maxAttachments ?? MAX_ATTACHMENTS;
  validateAddress(message.from, 'from');
  if (!Array.isArray(message.to) || message.to.length === 0 || message.to.length > 100) {
    throw new MailValidationError('"to" must contain between 1 and 100 recipients.');
  }
  for (const [i, addr] of message.to.entries()) validateAddress(addr, `to[${i}]`);
  if (message.cc !== undefined) {
    if (!Array.isArray(message.cc) || message.cc.length > 100) throw new MailValidationError('"cc" must be an array of at most 100 addresses.');
    for (const [i, addr] of message.cc.entries()) validateAddress(addr, `cc[${i}]`);
  }
  if (message.bcc !== undefined) {
    if (!Array.isArray(message.bcc) || message.bcc.length > 100) throw new MailValidationError('"bcc" must be an array of at most 100 addresses.');
    for (const [i, addr] of message.bcc.entries()) validateAddress(addr, `bcc[${i}]`);
  }
  if (message.replyTo !== undefined) validateAddress(message.replyTo, 'replyTo');
  if (typeof message.subject !== 'string' || message.subject.length === 0 || message.subject.length > 998) {
    throw new MailValidationError('"subject" must be a non-empty string of at most 998 characters.');
  }
  assertNoInjection(message.subject, 'subject');
  if (message.text === undefined && message.html === undefined) {
    throw new MailValidationError('A message must contain at least one of "text" or "html".');
  }
  for (const [field, value] of [['text', message.text], ['html', message.html]] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new MailValidationError(`"${field}" must be a string.`);
    if (Buffer.byteLength(value, 'utf8') > maxBodyBytes) throw new MailValidationError(`"${field}" exceeds the maximum body size.`);
  }
  if (message.headers !== undefined) {
    if (typeof message.headers !== 'object' || message.headers === null || Array.isArray(message.headers)) {
      throw new MailValidationError('"headers" must be an object of string values.');
    }
    const entries = Object.entries(message.headers);
    if (entries.length > 64) throw new MailValidationError('"headers" must not exceed 64 entries.');
    for (const [key, value] of entries) {
      if (!HEADER_NAME.test(key)) throw new MailValidationError(`Invalid header name: ${key}`);
      if (RESERVED_HEADERS.has(key.toLowerCase())) throw new MailValidationError(`Custom header ${key} would override a structural header.`);
      if (typeof value !== 'string' || value.length > 998) throw new MailValidationError(`Invalid header value for ${key}.`);
      assertNoInjection(value, `headers.${key}`);
    }
  }
  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments) || message.attachments.length > maxAttachments || message.attachments.length > MAX_ATTACHMENTS) {
      throw new MailValidationError(`"attachments" must be an array of at most ${Math.min(maxAttachments, MAX_ATTACHMENTS)} items.`);
    }
    let total = 0;
    for (const [i, attachment] of message.attachments.entries()) {
      validateAttachment(attachment, `attachments[${i}]`);
      const size = attachmentBytes(attachment).byteLength;
      if (size > maxAttachmentBytes) throw new MailValidationError(`attachments[${i}] exceeds the maximum attachment size.`);
      total += size;
      if (total > maxTotalAttachmentBytes) throw new MailValidationError('The total attachment size exceeds the configured limit.');
    }
  }
}

/** Escape a string for safe interpolation into an HTML template. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface MailTemplate {
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

export interface RenderedMail {
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

export interface RenderTemplateOptions {
  /** Escape interpolated values in the HTML body (default true). */
  readonly escapeHtml?: boolean;
  /** Allow missing data keys, rendering them as an empty string (default false: strict). */
  readonly allowMissing?: boolean;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Render a {{ path.to.value }} template. HTML bodies escape values by default to prevent injection. */
export function renderTemplate(
  template: MailTemplate,
  data: Readonly<Record<string, unknown>>,
  options: RenderTemplateOptions = {},
): RenderedMail {
  if (!template || typeof template.subject !== 'string') throw new MailTemplateError('A template with a subject string is required.');
  if (!data || typeof data !== 'object') throw new MailTemplateError('Template data must be an object.');
  const escape = options.escapeHtml ?? true;
  const allowMissing = options.allowMissing ?? false;

  const resolve = (path: string): string => {
    let current: unknown = data;
    for (const part of path.split('.')) {
      if (current === null || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) {
        if (allowMissing) return '';
        throw new MailTemplateError(`Missing template variable: ${path}`);
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined || current === null) {
      if (allowMissing) return '';
      throw new MailTemplateError(`Missing template variable: ${path}`);
    }
    return typeof current === 'string' ? current : String(current);
  };

  const render = (input: string, isHtml: boolean): string =>
    input.replace(PLACEHOLDER, (_match, path: string) => {
      const value = resolve(path);
      return isHtml && escape ? escapeHtml(value) : value;
    });

  return Object.freeze({
    subject: render(template.subject, false),
    ...(template.text !== undefined ? { text: render(template.text, false) } : {}),
    ...(template.html !== undefined ? { html: render(template.html, true) } : {}),
  });
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000, factor: 2 });

export function computeRetryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * Math.pow(policy.factor, exponent)));
}

export interface MailerOptions {
  readonly transport: MailTransport;
  readonly retry?: RetryPolicy;
  readonly now?: () => number;
  /** Injectable sleeper so retry tests are deterministic and do not wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (error: Error, attempt: number) => void;
  readonly maxBodyBytes?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxTotalAttachmentBytes?: number;
  readonly maxAttachments?: number;
}

export interface SendTemplateOptions {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
  readonly bcc?: readonly MailAddress[];
  readonly replyTo?: MailAddress;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly MailAttachment[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly render?: RenderTemplateOptions;
}

/**
 * Validates and sends mail with capped exponential-backoff retries. Transport failures never
 * produce a false success; the final error carries the original cause and the attempt count.
 */
export class Mailer {
  readonly #transport: MailTransport;
  readonly #retry: RetryPolicy;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onError: MailerOptions['onError'];
  readonly #validateOptions: ValidateMessageOptions;
  #closed = false;

  constructor(options: MailerOptions) {
    if (!options || !options.transport) throw new MailValidationError('A mail transport is required.');
    const retry = options.retry ?? DEFAULT_RETRY;
    if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 10) {
      throw new MailValidationError('retry.maxAttempts must be an integer between 1 and 10.');
    }
    if (retry.baseDelayMs < 0 || retry.maxDelayMs < retry.baseDelayMs || retry.factor < 1) {
      throw new MailValidationError('Invalid retry backoff configuration.');
    }
    this.#transport = options.transport;
    this.#retry = retry;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.#onError = options.onError;
    this.#validateOptions = Object.freeze({
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
      ...(options.maxAttachmentBytes !== undefined ? { maxAttachmentBytes: options.maxAttachmentBytes } : {}),
      ...(options.maxTotalAttachmentBytes !== undefined ? { maxTotalAttachmentBytes: options.maxTotalAttachmentBytes } : {}),
      ...(options.maxAttachments !== undefined ? { maxAttachments: options.maxAttachments } : {}),
    });
  }

  get isClosed(): boolean { return this.#closed || this.#transport.isClosed; }

  async send(message: MailMessage): Promise<SendReceipt> {
    this.#assertOpen();
    validateMessage(message, this.#validateOptions);
    const frozen = freezeMessage(message);
    const errors: Error[] = [];
    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      this.#assertOpen();
      try {
        const receipt = await this.#transport.send(frozen);
        return Object.freeze({
          messageId: receipt.messageId,
          acceptedAt: receipt.acceptedAt,
          attempts: attempt,
          ...(receipt.delivery !== undefined ? { delivery: receipt.delivery } : {}),
        });
      } catch (error) {
        const err = toError(error);
        errors.push(err);
        this.#onError?.(err, attempt);
        if (attempt < this.#retry.maxAttempts) {
          await this.#sleep(computeRetryDelay(attempt, this.#retry));
        }
      }
    }
    const lastError = errors.at(-1);
    throw new MailSendError('Mail delivery failed after all retry attempts.', this.#retry.maxAttempts, {
      ...(lastError !== undefined ? { cause: lastError } : {}),
      details: { attempts: this.#retry.maxAttempts, failedAt: this.#now() },
    });
  }

  async sendTemplate(template: MailTemplate, envelope: SendTemplateOptions): Promise<SendReceipt> {
    const rendered = renderTemplate(template, envelope.data, envelope.render);
    const message: MailMessage = {
      from: envelope.from,
      to: envelope.to,
      ...(envelope.cc !== undefined ? { cc: envelope.cc } : {}),
      ...(envelope.bcc !== undefined ? { bcc: envelope.bcc } : {}),
      ...(envelope.replyTo !== undefined ? { replyTo: envelope.replyTo } : {}),
      ...(envelope.headers !== undefined ? { headers: envelope.headers } : {}),
      ...(envelope.attachments !== undefined ? { attachments: envelope.attachments } : {}),
      subject: rendered.subject,
      ...(rendered.text !== undefined ? { text: rendered.text } : {}),
      ...(rendered.html !== undefined ? { html: rendered.html } : {}),
    };
    return this.send(message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close();
  }

  #assertOpen(): void {
    if (this.#closed || this.#transport.isClosed) throw new MailClosedError('The mailer is closed.');
  }
}

function freezeMessage(message: MailMessage): MailMessage {
  const freezeList = (list: readonly MailAddress[]): readonly MailAddress[] =>
    Object.freeze(list.map((a) => Object.freeze({ ...a }))) as readonly MailAddress[];
  const cc = message.cc === undefined ? undefined : freezeList(message.cc);
  const bcc = message.bcc === undefined ? undefined : freezeList(message.bcc);
  const attachments = message.attachments === undefined
    ? undefined
    : Object.freeze(message.attachments.map((a) => Object.freeze({
        ...a,
        content: typeof a.content === 'string' ? a.content : new Uint8Array(a.content),
      })));
  return Object.freeze({
    from: Object.freeze({ ...message.from }),
    to: freezeList(message.to),
    ...(cc !== undefined ? { cc } : {}),
    ...(bcc !== undefined ? { bcc } : {}),
    ...(message.replyTo !== undefined ? { replyTo: Object.freeze({ ...message.replyTo }) } : {}),
    subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}),
    ...(message.headers !== undefined ? { headers: Object.freeze({ ...message.headers }) } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }) as MailMessage;
}
