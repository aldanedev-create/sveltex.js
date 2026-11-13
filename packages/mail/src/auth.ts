import {
  MailConfigurationError,
  MailValidationError,
  validateAddress,
  type MailAddress,
  type MailMessage,
  type MailTemplate,
  type RenderTemplateOptions,
  type SendTemplateOptions,
} from './index.js';

/**
 * Real integration between `@sveltex/auth` workflows and `@sveltex/mail`.
 *
 * `PasswordResetService.requestReset` / `EmailVerificationService.requestVerification`
 * accept a sender port whose `send(context)` receives `{ email, token, expiresAt }`.
 * These factories return objects that structurally implement those ports using a
 * real `Mailer`, so no dependency from auth -> mail (or mail -> auth) is required.
 * The token is always carried as a percent-encoded URL query parameter, and HTML
 * bodies escape every interpolated value by default (SEC-080, SEC-081).
 */

/** Minimal structural contract: anything exposing `sendTemplate` (the real `Mailer` satisfies it). */
export interface TemplateMailer {
  sendTemplate(template: MailTemplate, envelope: SendTemplateOptions): Promise<unknown>;
}

export interface AuthMailContext {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface AuthMailSender {
  send(context: AuthMailContext): Promise<void>;
}

export interface AuthMailSenderOptions {
  /** A real `Mailer` (or any object exposing `sendTemplate`). */
  readonly mailer: TemplateMailer;
  readonly from: MailAddress;
  /** Absolute http(s) URL of the reset/verification page; credentials/fragments are forbidden. */
  readonly endpoint: string;
  /** Query parameter carrying the token (default `token`). */
  readonly tokenParam?: string;
  /** Display name interpolated into default templates. */
  readonly appName?: string;
  /** Override templates. Use `{{ link }}`, `{{ email }}`, `{{ expiresAt }}`, `{{ appName }}`. */
  readonly template?: MailTemplate;
  /** Override render options (e.g. opt out of HTML escaping for a trusted template). */
  readonly render?: RenderTemplateOptions;
  /** Extra recipients/headers/attachments for the outbound message. */
  readonly cc?: readonly MailAddress[];
  readonly bcc?: readonly MailAddress[];
  readonly replyTo?: MailAddress;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: MailMessage['attachments'];
}

const CRLF = /[\r\n\u0000]/;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TOKEN_LENGTH = 2048;

function validateEndpoint(endpoint: unknown): URL {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048 || CRLF.test(endpoint)) {
    throw new MailConfigurationError('endpoint must be a bounded absolute http(s) URL without control characters.');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new MailConfigurationError('endpoint must be a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MailConfigurationError('endpoint must use http: or https:.');
  if (url.username !== '' || url.password !== '') throw new MailConfigurationError('endpoint must not contain embedded credentials.');
  if (url.hash !== '') throw new MailConfigurationError('endpoint must not contain a fragment.');
  return url;
}

function validateContext(context: AuthMailContext): void {
  if (!context || typeof context !== 'object') throw new MailValidationError('An auth mail context is required.');
  validateAddress({ email: context.email }, 'context.email');
  if (typeof context.token !== 'string' || context.token.length === 0 || context.token.length > MAX_TOKEN_LENGTH || CRLF.test(context.token)) {
    throw new MailValidationError('context.token must be a bounded, non-empty string without control characters.');
  }
  if (!Number.isFinite(context.expiresAt) || !Number.isSafeInteger(context.expiresAt)) {
    throw new MailValidationError('context.expiresAt must be a finite integer timestamp.');
  }
}

function buildLink(base: URL, tokenParam: string, context: AuthMailContext): string {
  const link = new URL(base.toString());
  // URLSearchParams percent-encodes the token/email, so no value can inject an
  // extra parameter or break out of the attribute when HTML-escaped later.
  link.searchParams.set(tokenParam, context.token);
  link.searchParams.set('email', context.email);
  link.searchParams.set('expires', String(context.expiresAt));
  return link.toString();
}

const RESET_TEMPLATE: MailTemplate = Object.freeze({
  subject: 'Reset your {{ appName }} password',
  text: 'We received a request to reset the password for {{ email }}.\n\nOpen this link to choose a new password: {{ link }}\n\nThis link expires at {{ expiresAt }}. If you did not request a reset, you can ignore this email.',
  html: '<p>We received a request to reset the password for <strong>{{ email }}</strong>.</p><p><a href="{{ link }}">Choose a new password</a></p><p>This link expires at {{ expiresAt }}. If you did not request a reset, you can ignore this email.</p>',
});

const VERIFICATION_TEMPLATE: MailTemplate = Object.freeze({
  subject: 'Verify your {{ appName }} email address',
  text: 'Welcome to {{ appName }}.\n\nConfirm the address {{ email }} by opening this link: {{ link }}\n\nThis link expires at {{ expiresAt }}.',
  html: '<p>Welcome to <strong>{{ appName }}</strong>.</p><p>Confirm <strong>{{ email }}</strong> by <a href="{{ link }}">verifying your email address</a>.</p><p>This link expires at {{ expiresAt }}.</p>',
});

function createSender(options: AuthMailSenderOptions, template: MailTemplate, defaultTokenParam: string): AuthMailSender {
  if (!options || typeof options !== 'object') throw new MailConfigurationError('Auth mail sender options are required.');
  const base = validateEndpoint(options.endpoint);
  validateAddress(options.from, 'from');
  if (!options.mailer || typeof options.mailer.sendTemplate !== 'function') throw new MailConfigurationError('A mailer exposing sendTemplate is required.');
  const tokenParam = options.tokenParam ?? defaultTokenParam;
  if (typeof tokenParam !== 'string' || !PARAM_NAME.test(tokenParam)) throw new MailConfigurationError('tokenParam must be a safe query-parameter name.');
  const appName = options.appName ?? 'SvelteX';
  if (typeof appName !== 'string' || appName.length === 0 || appName.length > 128 || CRLF.test(appName)) throw new MailConfigurationError('appName must be a bounded string without control characters.');
  const chosen = options.template ?? template;
  if (!chosen || typeof chosen.subject !== 'string') throw new MailConfigurationError('A template with a subject is required.');

  return Object.freeze({
    async send(context: AuthMailContext): Promise<void> {
      validateContext(context);
      const link = buildLink(base, tokenParam, context);
      const envelope: SendTemplateOptions = {
        from: options.from,
        to: [{ email: context.email }],
        ...(options.cc !== undefined ? { cc: options.cc } : {}),
        ...(options.bcc !== undefined ? { bcc: options.bcc } : {}),
        ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
        data: Object.freeze({ link, email: context.email, expiresAt: context.expiresAt, appName }),
        ...(options.render !== undefined ? { render: options.render } : {}),
      };
      await options.mailer.sendTemplate(chosen, envelope);
    },
  });
}

/** Sender implementing `@sveltex/auth`'s `PasswordResetSender` port via a real Mailer. */
export function createPasswordResetMailSender(options: AuthMailSenderOptions): AuthMailSender {
  return createSender(options, RESET_TEMPLATE, 'token');
}

/** Sender implementing `@sveltex/auth`'s `EmailVerificationSender` port via a real Mailer. */
export function createEmailVerificationMailSender(options: AuthMailSenderOptions): AuthMailSender {
  return createSender(options, VERIFICATION_TEMPLATE, 'token');
}
