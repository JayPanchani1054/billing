/**
 * Attachments in backups, restores and the data check (dataplus).
 *
 * A backup snapshot is a copy of the company database; before it is packed, every attached file is
 * copied into the snapshot's `attachment_blobs` table (embedAttachmentsInSnapshot). The .bahibak
 * container therefore needs no new format: its payload checksum, database checksum and (with a
 * password) AES-256-GCM encryption cover the files exactly as they cover the books. A restore takes
 * the files out of the extracted database (unpackAttachmentBlobs) into the new company's
 * attachments folder and leaves the table empty, so the live company never carries file contents.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { formatFileSize } from '../../../shared/attachments.ts';
import { Db } from '../../db/db.ts';
import { attachmentsDir, listStored, readStored, sha256Hex, storedName, verifyStored } from './store.ts';

const hasTable = (db: Db, name: string): boolean =>
  db.value<number>(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :n`, { n: name }) !== undefined;

export interface EmbedResult {
  files: number;
  bytes: number;
  /** File names of attachments whose stored file is missing or changed (not in the backup). */
  missing: string[];
}

/**
 * Copy the company's attached files into `attachment_blobs` of the snapshot database at
 * `snapshotPath` (a private copy — the live database is not touched). Files that are missing or no
 * longer match their SHA-256 are left out and reported.
 */
export function embedAttachmentsInSnapshot(snapshotPath: string, companyDir: string): EmbedResult {
  const out: EmbedResult = { files: 0, bytes: 0, missing: [] };
  // A plain connection: the snapshot stays in rollback-journal mode (self-contained file, no -wal).
  const db = new DatabaseSync(snapshotPath);
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const table = (name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
    if (!table('attachments') || !table('attachment_blobs')) return out;
    const dir = attachmentsDir(companyDir);
    const files = db
      .prepare('SELECT sha256, ext, MIN(file_name) AS file_name FROM attachments GROUP BY sha256, ext ORDER BY sha256, ext')
      .all() as Array<{ sha256: string; ext: string; file_name: string }>;
    if (files.length === 0) return out;
    const insert = db.prepare('INSERT INTO attachment_blobs (sha256, ext, bytes) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM attachment_blobs');
      for (const f of files) {
        const bytes = readStored(dir, f.sha256, f.ext);
        if (!bytes || sha256Hex(bytes) !== f.sha256) {
          out.missing.push(f.file_name);
          continue;
        }
        insert.run(f.sha256, f.ext, bytes);
        out.files++;
        out.bytes += bytes.byteLength;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Write the files carried in `attachment_blobs` of an extracted (restored) database into `outDir`,
 * each checked against its SHA-256, and empty the table. Returns the number of files written.
 * A blob whose content does not match its name is skipped (the data check will then report the
 * attachment as missing) — it is never written under a name it does not deserve.
 */
export function unpackAttachmentBlobs(db: Db, outDir: string): { files: number; skipped: number } {
  if (!hasTable(db, 'attachment_blobs')) return { files: 0, skipped: 0 };
  fs.mkdirSync(outDir, { recursive: true });
  let files = 0;
  let skipped = 0;
  for (const key of db.all<{ sha256: string; ext: string }>('SELECT sha256, ext FROM attachment_blobs ORDER BY sha256, ext')) {
    const row = db.get<{ bytes: Uint8Array }>('SELECT bytes FROM attachment_blobs WHERE sha256 = :sha AND ext = :ext', { sha: key.sha256, ext: key.ext });
    let name: string;
    try {
      name = storedName(key.sha256, key.ext);
    } catch {
      skipped++;
      continue;
    }
    if (!row || sha256Hex(row.bytes) !== key.sha256) {
      skipped++;
      continue;
    }
    fs.writeFileSync(path.join(outDir, name), row.bytes, { mode: 0o600 });
    files++;
  }
  db.run('DELETE FROM attachment_blobs');
  return { files, skipped };
}

/** Files carried by a backup's database (for the backup check): count, size, and blobs that fail their hash. */
export function inspectAttachmentBlobs(db: Db): { files: number; bytes: number; bad: number; referenced: number } | null {
  if (!hasTable(db, 'attachment_blobs') || !hasTable(db, 'attachments')) return null;
  let files = 0;
  let bytes = 0;
  let bad = 0;
  for (const key of db.all<{ sha256: string; ext: string }>('SELECT sha256, ext FROM attachment_blobs')) {
    const row = db.get<{ bytes: Uint8Array }>('SELECT bytes FROM attachment_blobs WHERE sha256 = :sha AND ext = :ext', { sha: key.sha256, ext: key.ext });
    files++;
    bytes += row?.bytes.byteLength ?? 0;
    if (!row || sha256Hex(row.bytes) !== key.sha256) bad++;
  }
  const referenced = db.value<number>('SELECT COUNT(*) FROM (SELECT DISTINCT sha256, ext FROM attachments)') ?? 0;
  return { files, bytes, bad, referenced };
}

export function describeBlobs(i: { files: number; bytes: number; bad: number; referenced: number }): { ok: boolean; message: string } {
  if (i.referenced === 0 && i.files === 0) return { ok: true, message: 'The backup has no attached files.' };
  if (i.bad > 0) return { ok: false, message: `${i.bad} attached file(s) in the backup are damaged.` };
  if (i.files < i.referenced) {
    return { ok: false, message: `${i.files} of ${i.referenced} attached files are in the backup (${formatFileSize(i.bytes)}); the others were missing when it was made.` };
  }
  return { ok: true, message: `All ${i.files} attached file(s) are in the backup (${formatFileSize(i.bytes)}) and unchanged.` };
}

/**
 * Data check of the live company: every attachment's stored file exists and matches its SHA-256;
 * stored files no attachment uses (left by deleted vouchers) are listed too.
 */
export function checkAttachmentFiles(db: Db, companyDir: string): { problems: string[]; unused: number } {
  if (!hasTable(db, 'attachments')) return { problems: [], unused: 0 };
  const dir = attachmentsDir(companyDir);
  const problems: string[] = [];
  const rows = db.all<{ id: number; sha256: string; ext: string; size_bytes: number; file_name: string; owner: string }>(
    `SELECT a.id, a.sha256, a.ext, a.size_bytes, a.file_name,
            COALESCE((SELECT t.name || COALESCE(' ' || v.number, '') FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE v.id = a.voucher_id),
                     (SELECT 'ledger ' || name FROM ledgers WHERE id = a.ledger_id),
                     (SELECT 'stock item ' || name FROM stock_items WHERE id = a.stock_item_id), '?') AS owner
       FROM attachments a ORDER BY a.id`,
  );
  const verified = new Map<string, 'ok' | 'missing' | 'changed'>();
  for (const r of rows) {
    const k = `${r.sha256}.${r.ext}`;
    let state = verified.get(k);
    if (state === undefined) {
      state = verifyStored(dir, r.sha256, r.ext, r.size_bytes, true);
      verified.set(k, state);
    }
    if (state === 'missing') problems.push(`“${r.file_name}” attached to ${r.owner} is missing from the attachments folder.`);
    else if (state === 'changed') problems.push(`“${r.file_name}” attached to ${r.owner} was changed outside Bahi ERP (its checksum no longer matches).`);
  }
  const used = new Set(rows.map((r) => `${r.sha256}.${r.ext}`));
  const unused = listStored(dir).filter((f) => !used.has(f.name)).length;
  return { problems, unused };
}
