/**
 * The attachments folder of a company: `<company folder>/attachments/<sha256>.<ext>`.
 *
 * Content-addressed: the file name is the SHA-256 of the bytes, so a file is written once however
 * often it is attached, cannot be swapped without the data check noticing, and never carries a name
 * the user typed (no path tricks). Writes go to a temporary file in the same folder and are renamed
 * into place. Nothing here touches the database.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentType } from '../../../shared/attachments.ts';

export const ATTACHMENTS_FOLDER = 'attachments';
const STORED_NAME = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/;

export function attachmentsDir(companyDir: string): string {
  return path.join(companyDir, ATTACHMENTS_FOLDER);
}

export function storedName(sha256: string, ext: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('Invalid attachment name');
  return `${sha256}.${ext}`;
}

/** '<sha>.<ext>' → parts, or null for any other file name (temporary files, foreign files). */
export function parseStoredName(name: string): { sha256: string; ext: string } | null {
  const m = STORED_NAME.exec(name);
  return m ? { sha256: m[1], ext: m[2] } : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Write the bytes under their hash (no-op when an intact copy is already there). */
export function writeStored(dir: string, sha256: string, ext: string, bytes: Uint8Array): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, storedName(sha256, ext));
  if (verifyStored(dir, sha256, ext, bytes.byteLength, true) === 'ok') return;
  const tmp = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The stored bytes, or null when the file is missing. */
export function readStored(dir: string, sha256: string, ext: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(dir, storedName(sha256, ext)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Is the stored file there and unchanged? `full` re-hashes it; otherwise only the size is compared. */
export function verifyStored(dir: string, sha256: string, ext: string, size: number, full: boolean): 'ok' | 'missing' | 'changed' {
  const file = path.join(dir, storedName(sha256, ext));
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return 'missing';
  if (st.size !== size) return 'changed';
  if (!full) return 'ok';
  return sha256Hex(fs.readFileSync(file)) === sha256 ? 'ok' : 'changed';
}

/** Stored files of the folder (only names in the '<sha>.<ext>' form). */
export function listStored(dir: string): Array<{ sha256: string; ext: string; name: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ sha256: string; ext: string; name: string }> = [];
  for (const name of names) {
    const p = parseStoredName(name);
    if (p) out.push({ ...p, name });
  }
  return out;
}

/** Delete one stored file (missing is fine). */
export function removeStored(dir: string, sha256: string, ext: string): void {
  fs.rmSync(path.join(dir, storedName(sha256, ext)), { force: true });
}

// ───────────────────────────── Content checks ─────────────────────────────

const starts = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const utf16 = (s: string): number[] => [...s].flatMap((c) => [c.charCodeAt(0), 0]);

function contains(b: Uint8Array, needle: readonly number[]): boolean {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).indexOf(Buffer.from(needle)) >= 0;
}

/**
 * Markers of XML that a browser or Office would run or render as a document rather than show as data.
 * DTD declarations are refused outright: an internal subset can declare entities, or default an
 * `xmlns` attribute (<!ATTLIST … xmlns CDATA #FIXED "…xhtml">) so the file becomes a web page without
 * the namespace ever being written on an element.
 */
const ACTIVE_XML = /<\?xml-stylesheet|<\?mso-application|<script[\s>/]|<!ENTITY|<!ATTLIST|xmlns(?::[\w.-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/1999\/xhtml["']|xmlns(?::[\w.-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/2000\/svg["']|urn:schemas-microsoft-com:office/i;

/** ZIP part-name markers of Office / OpenDocument content that runs code (see contentProblem). */
const ZIP_ACTIVE_PARTS: readonly (readonly number[])[] = ['vbaProject.bin', 'macrosheets/', 'activeX/', 'Basic/', 'Scripts/'].map(ascii);

/** XML character references (&#NN; / &#xHH;) decoded; an invalid one is kept as written. */
function decodeCharRefs(text: string): string {
  if (!text.includes('&#')) return text;
  const ch = (code: number, raw: string): string => (Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw);
  return text.replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (raw, hex: string | undefined, dec: string | undefined) =>
    hex !== undefined ? ch(parseInt(hex, 16), raw) : ch(parseInt(dec ?? '', 10), raw),
  );
}

/**
 * Does the content match its declared kind? Returns a reason when it does not (shown to the user),
 * else null. Programs are refused whatever their name ('MZ' / ELF / Mach-O / '#!'); Office files with
 * macros (vbaProject.bin, Excel 4.0 macro sheets or ActiveX controls in OOXML, Basic / script macros in
 * OpenDocument, _VBA_PROJECT in the old binary formats) are refused.
 */
export function contentProblem(type: AttachmentType, b: Uint8Array): string | null {
  if (b.length === 0) return 'The file is empty.';
  if (starts(b, ascii('MZ')) || starts(b, [0x7f, 0x45, 0x4c, 0x46]) || starts(b, [0xcf, 0xfa, 0xed, 0xfe]) || starts(b, ascii('#!'))) {
    return 'This file is a program, not a document. Programs cannot be attached.';
  }
  const bad = `The file's contents are not a ${type.label} (the name says .${type.ext}). Save it again in that format and attach it.`;
  switch (type.signature) {
    case 'pdf': {
      const head = b.subarray(0, Math.min(b.length, 1024));
      return contains(head, ascii('%PDF-')) ? null : bad;
    }
    case 'png':
      return starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : bad;
    case 'jpeg':
      return starts(b, [0xff, 0xd8, 0xff]) ? null : bad;
    case 'gif':
      return starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a')) ? null : bad;
    case 'webp':
      return starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8) ? null : bad;
    case 'tiff':
      return starts(b, [0x49, 0x49, 0x2a, 0x00]) || starts(b, [0x4d, 0x4d, 0x00, 0x2a]) ? null : bad;
    case 'bmp':
      return starts(b, ascii('BM')) ? null : bad;
    case 'zip_office':
      if (!starts(b, [0x50, 0x4b, 0x03, 0x04])) return bad;
      // Part names are stored uncompressed in the ZIP headers. VBA (vbaProject.bin), Excel 4.0 macro
      // sheets (xl/macrosheets/), ActiveX controls (*/activeX/) and OpenDocument Basic / script
      // macros (Basic/…, Scripts/…) all run code when the document is opened.
      return ZIP_ACTIVE_PARTS.some((p) => contains(b, p)) ? 'This document contains macros or ActiveX controls. Save it without them (e.g. as .xlsx / .docx, or as PDF) and attach that.' : null;
    case 'ole_office':
      if (!starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return bad;
      return contains(b, utf16('_VBA_PROJECT')) ? 'This document contains macros. Save it without macros (e.g. as .xlsx / .docx, or as PDF) and attach that.' : null;
    case 'text': {
      if (b.includes(0)) return bad;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(b);
      } catch {
        return `The file is not UTF-8 text. Save it as UTF-8 (or as PDF) and attach it.`;
      }
      // An XML file opens in a browser or Office on most computers: one that is really a web page
      // (XHTML, scripts, a style sheet that turns it into one) or an Office document that may carry
      // macros could run code when opened from the books.
      // Checked on the text as written AND with character references decoded: in an attribute value
      // '&#104;ttp://www.w3.org/1999/xhtml' IS the XHTML namespace to an XML parser.
      if (type.ext === 'xml' && (ACTIVE_XML.test(text) || ACTIVE_XML.test(decodeCharRefs(text)))) {
        return 'This XML file contains web-page or Office content (scripts, style sheets or an Office document) that could run when opened. Attach it as PDF, or save the plain data again.';
      }
      return null;
    }
  }
}
