/**
 * (dataplus) Opening an attached file: the renderer hands main the bytes it read through the core
 * ('attachments.read'), never a path. The renderer is untrusted (SECURITY.md T3), so main checks the
 * name AND the content again against the attachment allowlist (the core's own content check: no
 * programs, no macros, no XML that is really a web page / Office document), writes the copy into a
 * fresh folder under the system temp folder (so a program that edits it never touches the stored
 * original) and the caller opens it with the program Windows uses for that kind. Copies older than a
 * day are swept on the next call.
 *
 * The temp folder may be shared with other accounts (e.g. /tmp on Linux): the copies' parent folder
 * must be a real folder of ours — never a symbolic link or junction another account planted (the sweep
 * would otherwise delete files wherever it points, and copies would land there) — and is created
 * private (0700).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { attachmentTypeOf, cleanAttachmentName, MAX_ATTACHMENT_BYTES } from '../shared/attachments.ts';
import { AppError } from '../core/lib/errors.ts';
import { contentProblem } from '../core/modules/attachments/store.ts';

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
  const type = fileName ? attachmentTypeOf(fileName) : null;
  if (!fileName || !type) throw new AppError('FORBIDDEN', 'Files of this kind are not opened from Bahi ERP.');
  // Same content rules as when the file was attached: a renamed program or a script-carrying XML is
  // never handed to another program, whatever the window sent.
  const problem = contentProblem(type, o.bytes);
  if (problem) throw new AppError('FORBIDDEN', `This file is not opened from Bahi ERP: ${problem}`);
  return { fileName, bytes: o.bytes };
}

/** <tempRoot>/bahi-attachments, created private; refused when it is a link or not a private folder of ours. */
function openCopyBase(tempRoot: string): string {
  const base = path.join(tempRoot, OPEN_COPY_FOLDER);
  try {
    fs.mkdirSync(base, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(base);
  const getuid = (process as { getuid?: () => number }).getuid;
  const foreign = typeof getuid === 'function' && (st.uid !== getuid() || (st.mode & 0o022) !== 0);
  if (st.isSymbolicLink() || !st.isDirectory() || foreign) {
    throw new AppError(
      'FORBIDDEN',
      `The temporary folder for opening attachments (${base}) is not a private folder of this Windows account. Delete it and try again, or use “Save a copy”.`,
    );
  }
  return base;
}

/** Write the copy into <tempRoot>/bahi-attachments/<random>/<name>; returns its path. */
export function writeOpenCopy(tempRoot: string, fileName: string, bytes: Uint8Array, now: number = Date.now()): string {
  const base = openCopyBase(tempRoot);
  // Sweep copies opened more than a day ago (a program may still hold a recent one open). Only our
  // own random-named folders; a link is removed as a link, never followed.
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name);
    try {
      const st = fs.lstatSync(p);
      if (now - st.mtimeMs <= DAY_MS) continue;
      if (st.isSymbolicLink() || !st.isDirectory()) fs.unlinkSync(p);
      else fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* in use or already gone */
    }
  }
  const folder = path.join(base, randomBytes(8).toString('hex'));
  fs.mkdirSync(folder, { mode: 0o700 });
  const file = path.join(folder, fileName);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}
