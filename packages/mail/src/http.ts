import {
  MailTransportError,
  MailConfigurationError,
  MailClosedError,
  MailValidationError,
  type MailMessage,
  type MailTransport,
  type TransportReceipt,
  type MailDeliveryInfo,
} from './index.js';
import { buildMimeMessage, type BuildMimeOptions } from './mime.js';

/** Strict wire envelope version for the vendor-neutral HTTP provider adapter. */
export const MAIL_HTTP_ENVELOPE_VERSION = 1;
export const MAIL_HTTP_CONTENT_TYPE = `application/vnd.sveltex.mail.v${MAIL_HTTP_ENVELOPE_VERSION}+json`;

export interface HttpTransportOptions {
  /** Absolute http(s) URL of the provider endpoint. Credentials in the URL are forbidden. */
  readonly endpoint: string;
  /** Extra request headers (e.g. Authorization). Names/values are validated; values are never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional host allow-list (SSRF guard). When set, the endpoint host must be listed exactly. */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Injectable clock for deterministic receipts. */
  readonly now?: () => number;
  /** Injectable fetch (BYO). Defaults to global fetch; integration tests use real fetch against a real server. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injectable MIME build options for deterministic messages. */
  readonly mime?: BuildMimeOptions;
}

const CRLF = /[\r\n\u0000]/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Hop-by-hop / response-controlled headers a client must never set itself. */
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'keep-alive',
]);

function validateEndpoint(endpoint: unknown, allowedHosts: readonly string[] | undefined): URL {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048 || CRLF.test(endpoint)) {
    throw new MailConfigurationError('endpoint must be a bounded absolute http(s) URL without control characters.');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new MailConfigurationError('endpoint must be a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MailConfigurationError('endpoint must use http: or https:.');
  }
  // Credentials embedded in the URL are a leak vector (and a common SSRF mistake).
  if (url.username !== '' || url.password !== '') {
    throw new MailConfigurationError('endpoint must not contain embedded credentials (userinfo).');
  }
  if (url.hash !== '') throw new MailConfigurationError('endpoint must not contain a fragment.');
  if (!url.hostname || url.hostname.length > 253) throw new MailConfigurationError('endpoint host is invalid.');
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.some((h) => typeof h !== 'string' || h.length === 0)) {
      throw new MailConfigurationError('allowedHosts must be a non-empty array of host strings.');
    }
    if (!allowedHosts.includes(url.host)) throw new MailConfigurationError('endpoint host is not in allowedHosts.');
  }
  return url;
}

function validateHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new MailConfigurationError('headers must be an object of string values.');
  }
  const entries = Object.entries(headers);
  if (entries.length > 32) throw new MailConfigurationError('headers must not exceed 32 entries.');
  for (const [key, value] of entries) {
    if (!HEADER_NAME.test(key)) throw new MailConfigurationError(`Invalid header name: ${key}.`);
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) throw new MailConfigurationError(`Header ${key} is not client-settable.`);
    if (typeof value !== 'string' || value.length > 2048 || CRLF.test(value)) {
      throw new MailConfigurationError(`Invalid or unsafe value for header ${key}.`);
    }
    out[key] = value;
  }
  return out;
}

export interface HttpMailPayload {
  readonly version: number;
  readonly envelope: { readonly from: string; readonly to: readonly string[]; readonly messageId: string };
  /** Full RFC 5322 message (CRLF). The provider may relay it verbatim or parse it. */
  readonly raw: string;
}

/** Build the exact JSON-serializable payload POSTed to the provider. Exported for adapter tests. */
export function buildHttpPayload(message: MailMessage, options: BuildMimeOptions = {}): HttpMailPayload {
  const doc = buildMimeMessage(message, options);
  return Object.freeze({
    version: MAIL_HTTP_ENVELOPE_VERSION,
    envelope: doc.envelope,
    raw: doc.raw,
  });
}

/**
 * Real, vendor-neutral HTTP JSON provider adapter. POSTs a strict v1 envelope
 * containing the complete RFC 5322 message via `fetch`, validates the 2xx JSON
 * response, and never reflects credentials or response bodies into errors.
 */
export class HttpTransport implements MailTransport {
  readonly #url: URL;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #mime: BuildMimeOptions;
  #closed = false;

  constructor(options: HttpTransportOptions) {
    if (!options || typeof options !== 'object') throw new MailConfigurationError('HTTP transport options are required.');
    this.#url = validateEndpoint(options.endpoint, options.allowedHosts);
    this.#headers = validateHeaders(options.headers);
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS)) {
      throw new MailConfigurationError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
    if (options.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > MAX_RESPONSE_BYTES)) {
      throw new MailConfigurationError(`maxResponseBytes must be an integer between 1 and ${MAX_RESPONSE_BYTES}.`);
    }
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new MailConfigurationError('A fetch implementation is required.');
    this.#now = options.now ?? (() => Date.now());
    this.#mime = options.mime ?? {};
  }

  get isClosed(): boolean { return this.#closed; }

  async send(message: MailMessage): Promise<TransportReceipt> {
    if (this.#closed) throw new MailClosedError('The HTTP transport is closed.');
    let payload: HttpMailPayload;
    try {
      payload = buildHttpPayload(message, this.#mime);
    } catch (error) {
      if (error instanceof MailValidationError) throw error;
      throw new MailTransportError('The message could not be prepared for HTTP delivery.', {
        ...wrapCause(error),
        details: { operation: 'prepare', backend: 'http' },
      });
    }
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await this.#fetch(this.#url.toString(), {
        method: 'POST',
        headers: { 'content-type': MAIL_HTTP_CONTENT_TYPE, ...this.#headers },
        body,
        // Never follow redirects: a 3xx could carry the Authorization header to
        // an unrelated host. 3xx is treated as a failure, not a delivery.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new MailTransportError('HTTP mail provider request failed.', {
        ...wrapCause(error),
        details: { operation: 'request', backend: 'http' },
      });
    }
    if (!response.ok || response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new MailTransportError('HTTP mail provider rejected the message.', {
        details: { operation: 'response', backend: 'http', status: response.status },
      });
    }
    const messageId = await this.#readMessageId(response);
    const delivery: MailDeliveryInfo = Object.freeze({
      accepted: Object.freeze([...payload.envelope.to]),
      rejected: Object.freeze([] as string[]),
      response: `${response.status} ${response.statusText}`.slice(0, 512),
      backend: 'http' as const,
      envelopeFrom: payload.envelope.from,
      envelopeTo: payload.envelope.to,
    });
    return Object.freeze({ messageId, acceptedAt: this.#now(), delivery });
  }

  async #readMessageId(response: Response): Promise<string> {
    let raw: string;
    try {
      const text = await response.text();
      // Bound memory before parsing; never echo provider bodies into errors.
      if (Buffer.byteLength(text, 'utf8') > this.#maxResponseBytes) {
        throw new MailTransportError('HTTP mail provider response is too large.', {
          details: { operation: 'response', backend: 'http' },
        });
      }
      raw = text;
    } catch (error) {
      if (error instanceof MailTransportError) throw error;
      throw new MailTransportError('HTTP mail provider response could not be read.', {
        ...wrapCause(error),
        details: { operation: 'response', backend: 'http' },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MailTransportError('HTTP mail provider returned invalid JSON.', {
        details: { operation: 'response', backend: 'http' },
      });
    }
    const id = (parsed as { id?: unknown; messageId?: unknown })?.id ?? (parsed as { messageId?: unknown })?.messageId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 512 || CRLF.test(id)) {
      throw new MailTransportError('HTTP mail provider response is missing a valid message id.', {
        details: { operation: 'response', backend: 'http' },
      });
    }
    return id;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
  }
}

function wrapCause(error: unknown): { cause?: Error } {
  return error instanceof Error ? { cause: error } : {};
}
