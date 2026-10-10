/**
 * (dataplus) Opening an attached file: the renderer hands main the bytes it read through the core
 * ('attachments.read'), never a path. Main checks the kind again against the attachment allowlist,
 * writes the copy into a fresh folder under the system temp folder (so a program that edits it never
 * touches the stored original) and the caller opens it with the program Windows uses for that kind.
 * Copies older than a day are swept on the next call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { attachmentTypeOf, cleanAttachmentName, MAX_ATTACHMENT_BYTES } from '../shared/attachments.ts';
import { AppError } from '../core/lib/errors.ts';

export const OPEN_COPY_FOLDER = 'bahi-attachments';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Validate an attachment-open request (throws accountant-readable AppErrors). */
export function checkOpenCopy(payload: unknown): { fileName: string; bytes: Uint8Array } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError('VALIDATION', 'Invalid request.');
  const o = payload as Record<string, unknown>;
  if (typeof o.fileName !== 'string' || o.fileName.length === 0 || o.fileName.length > 1000) throw new AppError('VALIDATION', 'Invalid file name.');
  if (!(o.bytes instanceof Uint8Array)) throw new AppError('VALIDATION', 'Invalid file contents.');
  if (o.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AppError('BUSINESS_RULE', 'This file is too large to open.');
  const fileName = cleanAttachmentName(o.fileName);
  if (!fileName || !attachmentTypeOf(fileName)) throw new AppError('FORBIDDEN', 'Files of this kind are not opened from Bahi ERP.');
  return { fileName, bytes: o.bytes };
}

/** Write the copy into <tempRoot>/bahi-attachments/<random>/<name>; returns its path. */
export function writeOpenCopy(tempRoot: string, fileName: string, bytes: Uint8Array, now: number = Date.now()): string {
  const base = path.join(tempRoot, OPEN_COPY_FOLDER);
  fs.mkdirSync(base, { recursive: true });
  // Sweep copies opened more than a day ago (a program may still hold a recent one open).
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name);
    try {
      if (now - fs.statSync(p).mtimeMs > DAY_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* in use or already gone */
    }
  }
  const folder = path.join(base, randomBytes(8).toString('hex'));
  fs.mkdirSync(folder);
  const file = path.join(folder, fileName);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}
