import { SvelteXError, toError } from '@sveltex/shared';

export interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

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
}

export interface TransportReceipt {
  readonly messageId: string;
  readonly acceptedAt: number;
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

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const CRLF = /[\r\n\u0000]/;

function assertNoInjection(value: string, label: string): void {
  if (CRLF.test(value)) throw new MailValidationError(`${label} must not contain CRLF or NUL characters.`);
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
}

/** Validate a message. Header-injection surfaces (CRLF/NUL) are rejected everywhere they could reach a header. */
export function validateMessage(message: MailMessage, options: ValidateMessageOptions = {}): void {
  if (!message || typeof message !== 'object') throw new MailValidationError('A message object is required.');
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
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
      if (typeof value !== 'string' || value.length > 998) throw new MailValidationError(`Invalid header value for ${key}.`);
      assertNoInjection(value, `headers.${key}`);
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
}

export interface SendTemplateOptions {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
  readonly bcc?: readonly MailAddress[];
  readonly replyTo?: MailAddress;
  readonly headers?: Readonly<Record<string, string>>;
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
  readonly #maxBodyBytes: number;
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
    this.#maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  }

  get isClosed(): boolean { return this.#closed || this.#transport.isClosed; }

  async send(message: MailMessage): Promise<SendReceipt> {
    this.#assertOpen();
    validateMessage(message, { maxBodyBytes: this.#maxBodyBytes });
    const frozen = freezeMessage(message);
    const errors: Error[] = [];
    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      this.#assertOpen();
      try {
        const receipt = await this.#transport.send(frozen);
        return Object.freeze({ messageId: receipt.messageId, acceptedAt: receipt.acceptedAt, attempts: attempt });
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
  }) as MailMessage;
}
