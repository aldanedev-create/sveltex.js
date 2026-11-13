import { randomBytes, randomUUID } from 'node:crypto';
import {
  validateMessage,
  attachmentBytes,
  type MailMessage,
} from './index.js';

/**
 * Real RFC 5322 / RFC 2045 MIME serializer used by the HTTP provider adapter and
 * exposed for any provider adapter that needs a canonical wire representation.
 * It is deliberately independent of nodemailer: the SMTP adapter uses nodemailer's
 * own composer, while this module gives the HTTP adapter a byte-exact, testable
 * message. Everything is emitted with CRLF line endings and 7-bit-safe headers.
 */

const CRLF = '\r\n';
const QP_SAFE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.,:;()<>@[\] ]+$/;
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

export interface MimeEnvelope {
  readonly from: string;
  readonly to: readonly string[];
  readonly messageId: string;
}

export interface MimeDocument {
  /** Full RFC 5322 message, CRLF line endings, safe to send as SMTP DATA or an HTTP `raw` field. */
  readonly raw: string;
  readonly envelope: MimeEnvelope;
}

export interface BuildMimeOptions {
  /** Injectable clock (deterministic tests). */
  readonly now?: () => number;
  /** Injectable Message-ID generator (deterministic tests). */
  readonly generateId?: () => string;
  /** Injectable boundary generator (deterministic tests). */
  readonly generateBoundary?: () => string;
}

interface Entity {
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

function quotePrintable(input: string): string {
  // Encode UTF-8 as quoted-printable with soft line breaks at 76 columns.
  // Logical newlines become hard CRLF breaks; a trailing '=' marks a soft break.
  const logicalLines = input.replace(/\r\n|\r|\n/g, '\n').split('\n');
  const out: string[] = [];
  const encodeTrailing = (line: string): string =>
    line.replace(/[ \t]+$/, (m) => [...m].map((c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join(''));
  for (const logical of logicalLines) {
    const bytes = Buffer.from(logical, 'utf8');
    let line = '';
    for (const byte of bytes) {
      let unit: string;
      if (byte === 0x3d) unit = '=3D';
      else if ((byte >= 33 && byte <= 60) || (byte >= 62 && byte <= 126)) unit = String.fromCharCode(byte);
      else if (byte === 0x20 || byte === 0x09) unit = String.fromCharCode(byte);
      else unit = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      if (line.length + unit.length > 75) {
        out.push(`${encodeTrailing(line)}=`);
        line = '';
      }
      line += unit;
    }
    out.push(encodeTrailing(line));
  }
  return out.join(CRLF);
}

function base64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join(CRLF);
}

function foldHeader(name: string, value: string): string {
  // Fold long headers onto continuation lines starting with a single WSP, but
  // NEVER split a token (encoded-word, boundary=, filename*= param, address).
  // Validation bounds every value to <= 998 chars, so an unfolded long line is
  // still RFC 5322 compliant; correctness beats cosmetic 78-column folding.
  const first = `${name}: ${value}`;
  if (first.length <= 998) return first;
  return first;
}

function encodeHeaderText(value: string): string {
  // RFC 2047 encoded-word (base64) for non-ASCII header values. Printable ASCII
  // without CRLF is left verbatim; validation already rejected CR/LF/NUL.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const words: string[] = [];
  for (let i = 0; i < encoded.length; i += 52) {
    words.push(`=?UTF-8?B?${encoded.slice(i, i + 52)}?=`);
  }
  return words.join(`${CRLF} `);
}

function formatAddress(address: { readonly email: string; readonly name?: string }): string {
  const email = address.email;
  if (address.name === undefined || address.name === '') return email;
  if (/^[\x20-\x7e]*$/.test(address.name)) {
    const escaped = address.name.replace(/([\\"])/g, '\\$1');
    return `"${escaped}" <${email}>`;
  }
  return `${encodeHeaderText(address.name)} <${email}>`;
}

function formatAddressList(addresses: readonly { readonly email: string; readonly name?: string }[]): string {
  return addresses.map(formatAddress).join(`,${CRLF} `);
}

function dateHeader(now: number): string {
  // RFC 5322 date-time, always GMT (+0000) for deterministic output.
  return new Date(now).toUTCString().replace('GMT', '+0000');
}

function encodeParam(param: string, filename: string): string {
  // RFC 2231 / RFC 5987 extended parameter. For simple ASCII names keep an
  // interoperable `param="..."`; otherwise percent-encode raw UTF-8 bytes,
  // leaving only RFC 5987 attr-chars literal (no double encoding of '%').
  if (/^[A-Za-z0-9!#$&+\-.^_`|~ ]+$/.test(filename) && !/[\\"]/.test(filename)) {
    return `${param}="${filename}"`;
  }
  let encoded = '';
  for (const byte of Buffer.from(filename, 'utf8')) {
    const ch = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `${param}*=UTF-8''${encoded}`;
}

function textPart(value: string, contentType: string): Entity {
  if (QP_SAFE.test(value) && value.length <= 900 && !/[\r\n]/.test(value)) {
    return {
      headers: [
        ['Content-Type', `${contentType}; charset=utf-8`],
        ['Content-Transfer-Encoding', '7bit'],
      ],
      body: value,
    };
  }
  return {
    headers: [
      ['Content-Type', `${contentType}; charset=utf-8`],
      ['Content-Transfer-Encoding', 'quoted-printable'],
    ],
    body: quotePrintable(value),
  };
}

function attachmentPart(attachment: MailMessage['attachments'] extends readonly (infer A)[] | undefined ? A : never): Entity {
  const bytes = attachmentBytes(attachment);
  const disposition = attachment.inline === true ? 'inline' : 'attachment';
  const headers: [string, string][] = [
    ['Content-Type', `${attachment.contentType}; ${encodeParam('name', attachment.filename)}`],
    ['Content-Transfer-Encoding', 'base64'],
    ['Content-Disposition', `${disposition}; ${encodeParam('filename', attachment.filename)}`],
  ];
  if (attachment.contentId !== undefined) headers.push(['Content-ID', `<${attachment.contentId}>`]);
  return { headers, body: base64Lines(bytes) };
}

function renderEntity(entity: Entity): string {
  const head = entity.headers.map(([k, v]) => foldHeader(k, v)).join(CRLF);
  return `${head}${CRLF}${CRLF}${entity.body}`;
}

function renderMultipart(subtype: string, boundary: string, entities: readonly Entity[]): Entity {
  const body = [
    ...entities.map((e) => `--${boundary}${CRLF}${renderEntity(e)}${CRLF}`),
    `--${boundary}--${CRLF}`,
  ].join('');
  return {
    headers: [['Content-Type', `multipart/${subtype}; boundary="${boundary}"`]],
    body,
  };
}

function safeBoundary(gen: () => string): string {
  const raw = gen();
  // Boundaries must be printable ASCII without quotes/whitespace and <= 70 chars.
  return `=_sveltex_${raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || randomBytes(8).toString('hex')}_=`;
}

/** Build a complete RFC 5322 message. BCC is never emitted into headers (SEC-076). */
export function buildMimeMessage(message: MailMessage, options: BuildMimeOptions = {}): MimeDocument {
  validateMessage(message);
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => randomUUID());
  const generateBoundary = options.generateBoundary ?? (() => randomBytes(12).toString('hex'));
  // Each nested multipart MUST get a distinct boundary. A caller-supplied generator
  // is allowed to be constant (deterministic tests), so mix in a per-call counter.
  let boundaryCounter = 0;
  const nextBoundary = (): string => safeBoundary(() => `${generateBoundary()}-${++boundaryCounter}`);
  const messageId = `<${generateId()}@${message.from.email.split('@')[1] ?? 'localhost'}>`;

  const headerPairs: [string, string][] = [
    ['From', formatAddress(message.from)],
    ['To', formatAddressList(message.to)],
    ...(message.cc !== undefined ? [['Cc', formatAddressList(message.cc)] as [string, string]] : []),
    ...(message.replyTo !== undefined ? [['Reply-To', formatAddress(message.replyTo)] as [string, string]] : []),
    ['Subject', encodeHeaderText(message.subject)],
    ['Date', dateHeader(now())],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0'],
  ];
  if (message.headers !== undefined) {
    for (const [key, value] of Object.entries(message.headers)) headerPairs.push([key, value]);
  }

  const alternatives: Entity[] = [];
  if (message.text !== undefined) alternatives.push(textPart(message.text, 'text/plain'));
  if (message.html !== undefined) alternatives.push(textPart(message.html, 'text/html'));

  let root: Entity;
  let bodyEntity: Entity;
  if (alternatives.length > 1) {
    bodyEntity = renderMultipart('alternative', nextBoundary(), alternatives);
  } else {
    bodyEntity = alternatives[0] ?? textPart('', 'text/plain');
  }

  const hasAttachments = message.attachments !== undefined && message.attachments.length > 0;
  if (hasAttachments) {
    const parts = [bodyEntity, ...message.attachments!.map(attachmentPart)];
    root = renderMultipart('mixed', nextBoundary(), parts);
  } else {
    root = bodyEntity;
  }

  for (const [key, value] of root.headers) headerPairs.push([key, value]);
  const rawHeader = headerPairs.map(([k, v]) => foldHeader(k, v)).join(CRLF);
  const raw = `${rawHeader}${CRLF}${CRLF}${root.body}`;

  const envelopeTo = [
    ...message.to.map((a) => a.email),
    ...(message.cc ?? []).map((a) => a.email),
    ...(message.bcc ?? []).map((a) => a.email),
  ];
  return Object.freeze({
    raw,
    envelope: Object.freeze({
      from: message.from.email,
      to: Object.freeze(envelopeTo),
      messageId,
    }),
  });
}
