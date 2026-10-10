/**
 * Sharing documents (print group) — pure helpers, no Electron imports (unit-tested in share.test.ts):
 *   - the company's exports folder for shared files, chosen by main from the open company (never a
 *     renderer-supplied path) and a collision-free file name inside it;
 *   - a draft e-mail as an RFC 5322 / MIME message (.eml) with the PDF attached. `X-Unsent: 1` makes
 *     Outlook (and Windows Mail / Thunderbird, which open .eml as a message) show it as an editable
 *     draft; there is deliberately no From: (the mail program fills in the user's account);
 *   - the WhatsApp click-to-chat link https://wa.me/<country code + number>?text=… for an Indian mobile.
 * Every value that ends up in a header is checked for CR/LF (header injection) and encoded per RFC 2047.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, sanitizeFileName } from './files.ts';

/** Company folder ids (core/app/companies.ts COMPANY_ID_RE): never a path component that can escape. */
const COMPANY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** <dataDir>/companies/<id>/exports/shared — or null when the id or data folder is unusable. */
export function sharedExportsDir(dataDir: string, companyId: string): string | null {
  if (!dataDir || !path.isAbsolute(dataDir) || !COMPANY_ID_RE.test(companyId)) return null;
  const companies = path.join(dataDir, 'companies');
  const dir = path.join(companies, companyId, 'exports', 'shared');
  return isPathInside(companies, dir) ? dir : null;
}

/** The exports folder is not a plain folder inside the company folder (see ensureSharedExportsDir). */
export class SharedFolderError extends Error {}

/**
 * Create (when missing) and return <dataDir>/companies/<id>/exports/shared, walking the two folders
 * below the company folder without following links: an `exports` or `shared` that is a symbolic link
 * or junction (planted in a shared data folder) could point the PDF and the e-mail draft at another
 * folder or a network share (an SMB path leaks the user's NTLM hash and ships the document off the
 * machine), so it is refused. Returns null when the id or data folder is unusable.
 */
export async function ensureSharedExportsDir(dataDir: string, companyId: string): Promise<string | null> {
  const dir = sharedExportsDir(dataDir, companyId);
  if (!dir) return null;
  let current = path.join(dataDir, 'companies', companyId);
  for (const part of ['exports', 'shared']) {
    current = path.join(current, part);
    let st: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
    try {
      st = await fsp.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (st === null) {
      await fsp.mkdir(current);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new SharedFolderError(`${current} is a link or a file, not a folder of the company. Remove it; Pevqori will create the folder again.`);
    }
  }
  return dir;
}

/** A name in `dir` that does not exist yet: 'Invoice 12.pdf', 'Invoice 12 (2).pdf', … */
export async function freeFileName(dir: string, wanted: string, ext: string): Promise<string> {
  let base = sanitizeFileName(wanted, 'document');
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length).trim() || 'document';
  base = base.slice(0, 150);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    try {
      await fsp.access(path.join(dir, name));
    } catch {
      return name;
    }
  }
  return `${base} ${randomBytes(4).toString('hex')}${ext}`;
}

// ───────────────────────────── validation ─────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f]/; // eslint-disable-line no-control-regex

/** One address (local@domain), no display name, no CR/LF; 254 characters at most (RFC 5321). */
export function validEmailAddress(raw: string): boolean {
  if (raw.length === 0 || raw.length > 254 || CONTROL.test(raw)) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(raw);
}

/** Several addresses separated by ',' or ';' → cleaned list, or null when any is invalid. At most 20. */
export function parseRecipients(raw: string | undefined): string[] | null {
  const list = (raw ?? '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 20) return null;
  return list.every(validEmailAddress) ? list : null;
}

/**
 * Indian mobile number → '91XXXXXXXXXX' (wa.me format: country code + number, digits only), else null.
 * Accepts '+91 98765 43210', '098765-43210', '919876543210', '9876543210'. Mobile numbers start 6–9.
 */
export function indianMobileForWhatsapp(raw: string | undefined): string | null {
  if (!raw) return null;
  if (CONTROL.test(raw) || raw.length > 32) return null;
  if (!/^[+0-9 ()./-]+$/.test(raw)) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null;
}

/** https://wa.me/<number>?text=<message> (number optional: WhatsApp then asks whom to send it to). */
export function whatsappUrl(mobile: string | null, text: string): string {
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${mobile ?? ''}${q}`;
}

// ───────────────────────────── .eml ─────────────────────────────

/** RFC 2047 encoded-word for a header value (only when it is not plain printable ASCII). */
export function encodeHeader(value: string): string {
  if (CONTROL.test(value)) throw new Error('Header values cannot contain line breaks.');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Encoded words are at most 75 characters: split the UTF-8 text on character boundaries.
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

/** Base64 in 76-character lines (RFC 2045). */
export function base64Lines(data: Uint8Array | string): string {
  const b64 = Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
  return b64.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
}

/** filename parameter: plain quoted ASCII, or RFC 2231 (filename*=UTF-8''…) for other characters. */
function filenameParam(name: string, key: 'name' | 'filename'): string {
  const safe = name.replace(/["\\]/g, '_');
  if (/^[\x20-\x7e]*$/.test(safe)) return `${key}="${safe}"`;
  return `${key}*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export interface DraftEmail {
  to: readonly string[];
  subject: string;
  body: string;
  attachment: { fileName: string; contentType: 'application/pdf'; bytes: Uint8Array };
  date: Date;
  /** Boundary override for tests. */
  boundary?: string;
}

/** RFC 5322 date: 'Fri, 09 Oct 2026 10:15:00 +0530' (local offset). */
export function rfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${days[d.getDay()]}, ${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/** The complete .eml file (CRLF line ends, 7-bit clean: text and attachment are base64). */
export function buildDraftEml(m: DraftEmail): string {
  for (const t of m.to) if (!validEmailAddress(t)) throw new Error('Invalid e-mail address.');
  const boundary = m.boundary ?? `----=_Pevqori_${randomBytes(12).toString('hex')}`;
  const body = m.body.replace(/\r?\n/g, '\r\n');
  const headers = [
    'X-Unsent: 1',
    // One address per folded line keeps every header line far below RFC 5322's 998 characters.
    ...(m.to.length > 0 ? [`To: ${m.to.join(',\r\n ')}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'X-Mailer: Pevqori',
  ];
  return [
    ...headers,
    '',
    'This is a multi-part message in MIME format.',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(body),
    `--${boundary}`,
    `Content-Type: ${m.attachment.contentType}; ${filenameParam(m.attachment.fileName, 'name')}`,
    `Content-Disposition: attachment; ${filenameParam(m.attachment.fileName, 'filename')}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.attachment.bytes),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * mailto: fallback (no attachment possible): recipients, subject and body percent-encoded, the body
 * shortened (with '…') until the link fits `max` characters (the external-link policy's limit).
 */
export function mailtoUrl(to: readonly string[], subject: string, body: string, max = 2000): string {
  const head = `mailto:${to.map((t) => encodeURIComponent(t).replace(/%40/g, '@')).join(',')}?subject=${encodeURIComponent(subject.slice(0, 200))}`;
  let text = body;
  for (;;) {
    const url = text ? `${head}&body=${encodeURIComponent(text)}` : head;
    if (url.length <= max || !text) return url.length <= max ? url : head.slice(0, max);
    const keep = Math.floor(text.length * 0.8);
    text = keep > 0 ? `${text.slice(0, keep).trimEnd()}…` : '';
  }
}

/** Longest wa.me link the external-link policy accepts. */
export const MAX_SHARE_URL = 2048;
