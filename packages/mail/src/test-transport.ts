import { randomUUID } from 'node:crypto';
import { MailTransportError, MailValidationError } from './index.js';
import type { MailMessage, MailTransport, TransportReceipt } from './index.js';

export interface SentMail {
  readonly message: MailMessage;
  readonly messageId: string;
  readonly acceptedAt: number;
  readonly attempt: number;
}

export interface TestTransportOptions {
  readonly now?: () => number;
  readonly generateId?: () => string;
  /** Fail the first N send attempts before succeeding. Models a transient provider outage. */
  readonly failFirst?: number;
  /** Fail every send attempt. Models a permanent provider failure. */
  readonly failAlways?: boolean;
  /** Reject a specific subject (used to prove validation happens before transport). */
  readonly rejectSubject?: string;
}

/**
 * A deterministic, in-memory mail transport for tests. It records every accepted message and
 * can inject transient or permanent failures. It NEVER sends real email and does NOT claim to
 * be an SMTP/HTTP provider adapter — that is a separate transport implementing MailTransport.
 */
export class TestTransport implements MailTransport {
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #failFirst: number;
  readonly #failAlways: boolean;
  readonly #rejectSubject: string | undefined;
  readonly #sent: SentMail[] = [];
  #attempts = 0;
  #closed = false;

  constructor(options: TestTransportOptions = {}) {
    const failFirst = options.failFirst ?? 0;
    if (!Number.isSafeInteger(failFirst) || failFirst < 0) throw new MailValidationError('failFirst must be a non-negative integer.');
    if (options.failAlways !== undefined && typeof options.failAlways !== 'boolean') throw new MailValidationError('failAlways must be a boolean.');
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#failFirst = failFirst;
    this.#failAlways = options.failAlways ?? false;
    this.#rejectSubject = options.rejectSubject;
  }

  get isClosed(): boolean { return this.#closed; }
  get attempts(): number { return this.#attempts; }
  get sent(): readonly SentMail[] { return Object.freeze([...this.#sent]); }

  async send(message: MailMessage): Promise<TransportReceipt> {
    if (this.#closed) throw new MailTransportError('Cannot send on a closed transport.');
    this.#attempts += 1;
    if (this.#failAlways || this.#attempts <= this.#failFirst) {
      throw new MailTransportError(`Simulated provider failure on attempt ${String(this.#attempts)}.`);
    }
    if (this.#rejectSubject !== undefined && message.subject === this.#rejectSubject) {
      throw new MailTransportError('Provider rejected the subject.');
    }
    const messageId = this.#generateId();
    const acceptedAt = this.#now();
    this.#sent.push(Object.freeze({ message, messageId, acceptedAt, attempt: this.#attempts }));
    return Object.freeze({ messageId, acceptedAt });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
  }
}
