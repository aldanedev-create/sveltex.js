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
