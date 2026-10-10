/**
 * Attachments of vouchers, ledgers and stock items (dataplus; migration 222). See README.md.
 *
 *  - The renderer never sends a path: it sends the bytes of a file the user picked in the native
 *    file dialog; the file is checked (allowed kind, size, content matches the kind, no programs, no
 *    macros) and stored under its SHA-256 in the company's attachments folder.
 *  - Viewing needs the owner's view permission (vouchers.view / masters.view); adding needs
 *    attachments.add; removing needs attachments.remove and — for a voucher — a date after the
 *    locked period (evidence of locked books cannot be taken away; it can still be added).
 *  - Every add / remove is in the edit log as an 'alter' of the owner (so it shows in that voucher's
 *    or master's edit history) with the file's name, size and SHA-256.
 *  - Removing a row deletes the stored file only after the transaction committed and only when no
 *    other attachment uses the same content.
 */
import { randomUUID } from 'node:crypto';
import type { Permission } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import {
  ALLOWED_ATTACHMENTS_TEXT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTITY,
  attachmentTypeOf,
  cleanAttachmentName,
  formatFileSize,
  type AttachmentEntityType,
} from '../../../shared/attachments.ts';
import type {
  AttachmentAddInput,
  AttachmentCountsInput,
  AttachmentFile,
  AttachmentListInput,
  AttachmentRegisterInput,
  AttachmentRegisterResult,
  AttachmentRegisterRow,
  AttachmentRow,
} from '../../../shared/types/attachments.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, forbidden, notFound, rule, validation } from '../../lib/errors.ts';
import { getConfig } from '../company/service.ts';
import { attachmentsDir, contentProblem, listStored, readStored, removeStored, sha256Hex, verifyStored, writeStored } from './store.ts';

const OWNER_COLUMN: Readonly<Record<AttachmentEntityType, 'voucher_id' | 'ledger_id' | 'stock_item_id'>> = {
  voucher: 'voucher_id',
  ledger: 'ledger_id',
  stock_item: 'stock_item_id',
};

const VIEW_PERMISSION: Readonly<Record<AttachmentEntityType, Permission>> = {
  voucher: 'vouchers.view',
  ledger: 'masters.view',
  stock_item: 'masters.view',
};

const NOUN: Readonly<Record<AttachmentEntityType, string>> = { voucher: 'voucher', ledger: 'ledger', stock_item: 'stock item' };

interface AttachmentDbRow {
  id: number;
  guid: string;
  voucher_id: number | null;
  ledger_id: number | null;
  stock_item_id: number | null;
  file_name: string;
  ext: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  note: string | null;
  created_at: string;
  created_by_name: string | null;
}

interface Owner {
  type: AttachmentEntityType;
  id: number;
  guid: string;
  label: string;
  /** Vouchers only. */
  date: string | null;
}

function can(ctx: CompanyCtx, p: Permission): boolean {
  return ctx.session.isOwner || ctx.session.permissions.has(p);
}

function need(ctx: CompanyCtx, p: Permission, what: string): void {
  if (!can(ctx, p)) throw forbidden(`You do not have permission to ${what}. Ask the company owner to give your role the '${p}' right.`);
}

function loadOwner(db: Db, type: AttachmentEntityType, id: number): Owner {
  if (type === 'voucher') {
    const r = db.get<{ guid: string; date: string; number: string | null; type_name: string }>(
      'SELECT v.guid, v.date, v.number, t.name AS type_name FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE v.id = :id',
      { id },
    );
    if (!r) throw notFound('Voucher', id);
    return { type, id, guid: r.guid, label: `${r.type_name}${r.number ? ` ${r.number}` : ''} (${formatDate(r.date)})`, date: r.date };
  }
  const table = type === 'ledger' ? 'ledgers' : 'stock_items';
  const r = db.get<{ guid: string; name: string }>(`SELECT guid, name FROM ${table} WHERE id = :id`, { id });
  if (!r) throw notFound(type === 'ledger' ? 'Ledger' : 'Stock item', id);
  return { type, id, guid: r.guid, label: r.name, date: null };
}

function ownerOfRow(r: AttachmentDbRow): { type: AttachmentEntityType; id: number } {
  if (r.voucher_id !== null) return { type: 'voucher', id: r.voucher_id };
  if (r.ledger_id !== null) return { type: 'ledger', id: r.ledger_id };
  return { type: 'stock_item', id: r.stock_item_id as number };
}

function toDto(dir: string, r: AttachmentDbRow, fileOk?: boolean): AttachmentRow {
  const o = ownerOfRow(r);
  return {
    id: r.id,
    guid: r.guid,
    entityType: o.type,
    entityId: o.id,
    fileName: r.file_name,
    ext: r.ext,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    note: r.note,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    fileOk: fileOk ?? verifyStored(dir, r.sha256, r.ext, r.size_bytes, false) === 'ok',
  };
}

const auditImage = (r: Pick<AttachmentDbRow, 'file_name' | 'size_bytes' | 'sha256' | 'note'>): Record<string, unknown> => ({
  fileName: r.file_name,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  ...(r.note ? { note: r.note } : {}),
});

function loadRow(db: Db, id: number): AttachmentDbRow {
  const r = db.get<AttachmentDbRow>('SELECT * FROM attachments WHERE id = :id', { id });
  if (!r) throw notFound('Attachment', id);
  return r;
}

export function listAttachments(ctx: CompanyCtx, input: AttachmentListInput): AttachmentRow[] {
  need(ctx, VIEW_PERMISSION[input.entityType], `view this ${NOUN[input.entityType]}`);
  loadOwner(ctx.db, input.entityType, input.entityId);
  const dir = attachmentsDir(ctx.company.dir);
  return ctx.db
    .all<AttachmentDbRow>(`SELECT * FROM attachments WHERE ${OWNER_COLUMN[input.entityType]} = :id ORDER BY created_at, id`, { id: input.entityId })
    .map((r) => toDto(dir, r));
}

/** Number of attachments per owner id (for paperclip marks in lists). Ids without any are left out. */
export function countAttachments(ctx: CompanyCtx, input: AttachmentCountsInput): Record<string, number> {
  need(ctx, VIEW_PERMISSION[input.entityType], `view ${NOUN[input.entityType]}s`);
  const col = OWNER_COLUMN[input.entityType];
  const out: Record<string, number> = {};
  if (input.ids.length === 0) return out;
  for (const r of ctx.db.all<{ oid: number; n: number }>(
    `SELECT ${col} AS oid, COUNT(*) AS n FROM attachments WHERE ${col} IN (SELECT value FROM json_each(:ids)) GROUP BY ${col}`,
    { ids: JSON.stringify(input.ids.map((n) => Math.trunc(n))) },
  )) {
    out[String(r.oid)] = r.n;
  }
  return out;
}

export function addAttachment(ctx: CompanyCtx, input: AttachmentAddInput): AttachmentRow {
  need(ctx, 'attachments.add', 'attach files');
  need(ctx, VIEW_PERMISSION[input.entityType], `view this ${NOUN[input.entityType]}`);
  const { db } = ctx;
  const owner = loadOwner(db, input.entityType, input.entityId);
  const fileName = cleanAttachmentName(input.fileName);
  const type = attachmentTypeOf(fileName);
  if (!fileName || !type) {
    throw validation([{ path: 'fileName', message: `Files of this kind cannot be attached. Attach ${ALLOWED_ATTACHMENTS_TEXT}.` }]);
  }
  const bytes = input.bytes;
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw validation([{ path: 'bytes', message: `The file is ${formatFileSize(bytes.byteLength)}; at most ${formatFileSize(MAX_ATTACHMENT_BYTES)} can be attached. Scan at a lower resolution or split the file.` }]);
  }
  const problem = contentProblem(type, bytes);
  if (problem) throw validation([{ path: 'bytes', message: problem }]);
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;

  const col = OWNER_COLUMN[input.entityType];
  const count = db.value<number>(`SELECT COUNT(*) FROM attachments WHERE ${col} = :id`, { id: owner.id }) ?? 0;
  if (count >= MAX_ATTACHMENTS_PER_ENTITY) throw rule(`This ${NOUN[owner.type]} already has ${count} attachments, the most allowed. Remove one first.`);
  const sha256 = sha256Hex(bytes);
  const same = db.get<{ file_name: string }>(`SELECT file_name FROM attachments WHERE ${col} = :id AND sha256 = :sha LIMIT 1`, { id: owner.id, sha: sha256 });
  if (same) throw new AppError('CONFLICT', `This file is already attached to this ${NOUN[owner.type]} (as “${same.file_name}”).`);

  const dir = attachmentsDir(ctx.company.dir);
  try {
    writeStored(dir, sha256, type.ext, bytes);
  } catch (err) {
    ctx.app.log('error', 'Could not store an attachment', { company: ctx.company.id, error: err });
    throw rule('The file could not be saved in the company folder (disk full or no permission). Free some space or check the folder, then try again.');
  }
  const now = ctx.clock.now().toISOString();
  // Own transaction (the route is not transactional): when the row cannot be written the stored
  // file is taken away again (unless another attachment already uses the same content).
  let row: AttachmentDbRow;
  try {
    row = db.transaction(() => {
      const id = db.run(
        `INSERT INTO attachments (guid, voucher_id, ledger_id, stock_item_id, file_name, ext, mime, size_bytes, sha256, note, created_at, created_by, created_by_name)
         VALUES (:guid, :v, :l, :s, :name, :ext, :mime, :size, :sha, :note, :ts, :uid, :uname)`,
        {
          guid: randomUUID(),
          v: owner.type === 'voucher' ? owner.id : null,
          l: owner.type === 'ledger' ? owner.id : null,
          s: owner.type === 'stock_item' ? owner.id : null,
          name: fileName,
          ext: type.ext,
          mime: type.mime,
          size: bytes.byteLength,
          sha: sha256,
          note,
          ts: now,
          uid: ctx.session.userId,
          uname: ctx.session.displayName || ctx.session.username || null,
        },
      ).lastInsertRowid;
      const r = loadRow(db, id);
      ctx.audit({
        action: 'alter',
        entityType: owner.type,
        entityId: owner.id,
        entityGuid: owner.guid,
        entityLabel: `${owner.label} — file attached: ${fileName}`,
        after: { attachmentAdded: auditImage(r) },
      });
      return r;
    });
  } catch (err) {
    removeUnusedFiles(ctx, [{ sha256, ext: type.ext }]);
    throw err;
  }
  return toDto(dir, row, true);
}

export function readAttachment(ctx: CompanyCtx, id: number): AttachmentFile {
  const r = loadRow(ctx.db, id);
  const o = ownerOfRow(r);
  need(ctx, VIEW_PERMISSION[o.type], `view this ${NOUN[o.type]}`);
  const bytes = readStored(attachmentsDir(ctx.company.dir), r.sha256, r.ext);
  if (!bytes) throw rule(`The file “${r.file_name}” is missing from the company's attachments folder. Restore it from a backup (Data › Check data lists every missing file).`);
  if (sha256Hex(bytes) !== r.sha256) {
    throw rule(`The stored copy of “${r.file_name}” has been changed outside Bahi ERP, so it is not opened. Restore it from a backup.`);
  }
  return { id: r.id, fileName: r.file_name, mime: r.mime, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

/**
 * Remove an attachment (own transaction; the route is not transactional) and delete its stored file
 * once nothing else uses it.
 */
export function removeAttachment(ctx: CompanyCtx, id: number): { id: number; removed: true } {
  need(ctx, 'attachments.remove', 'remove attachments');
  const { db } = ctx;
  const row = db.transaction(() => {
    const r = loadRow(db, id);
    const o = ownerOfRow(r);
    need(ctx, VIEW_PERMISSION[o.type], `view this ${NOUN[o.type]}`);
    const owner = loadOwner(db, o.type, o.id);
    const locked = getConfig(db).lockedUpTo;
    if (owner.date !== null && locked && owner.date <= locked) {
      throw new AppError('LOCKED', `Books are locked up to ${formatDate(locked)}. Files attached to vouchers of the locked period cannot be removed (they are evidence for those books).`, {
        lockedUpTo: locked,
      });
    }
    db.run('DELETE FROM attachments WHERE id = :id', { id });
    ctx.audit({
      action: 'alter',
      entityType: owner.type,
      entityId: owner.id,
      entityGuid: owner.guid,
      entityLabel: `${owner.label} — attachment removed: ${r.file_name}`,
      before: { attachmentRemoved: auditImage(r) },
    });
    return r;
  });
  removeUnusedFiles(ctx, [{ sha256: row.sha256, ext: row.ext }]);
  return { id, removed: true };
}

/**
 * Delete stored files no attachment row refers to any more — the given ones, or (no argument) every
 * stored file of the folder (left by an attach that could not be completed). Run outside a transaction, after the
 * rows are gone; never fails the caller.
 */
export function removeUnusedFiles(ctx: Pick<CompanyCtx, 'db' | 'company' | 'app'>, which?: ReadonlyArray<{ sha256: string; ext: string }>): number {
  if (ctx.db.inTransaction) return 0;
  const dir = attachmentsDir(ctx.company.dir);
  let removed = 0;
  for (const f of which ?? listStored(dir)) {
    const used = ctx.db.value<number>('SELECT 1 FROM attachments WHERE sha256 = :sha AND ext = :ext LIMIT 1', { sha: f.sha256, ext: f.ext });
    if (used !== undefined) continue;
    try {
      removeStored(dir, f.sha256, f.ext);
      removed++;
    } catch (err) {
      ctx.app.log('warn', 'Could not delete an unused attachment file', { error: err });
    }
  }
  return removed;
}

/**
 * Attachment register: every attachment of the company the user may see (voucher attachments need
 * vouchers.view, master attachments masters.view), newest first, with the owner's label.
 */
export function attachmentRegister(ctx: CompanyCtx, input: AttachmentRegisterInput): AttachmentRegisterResult {
  const seeVouchers = can(ctx, 'vouchers.view');
  const seeMasters = can(ctx, 'masters.view');
  if (!seeVouchers && !seeMasters) throw forbidden('You do not have permission to view vouchers or masters.');
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (!seeVouchers) where.push('a.voucher_id IS NULL');
  if (!seeMasters) where.push('a.voucher_id IS NOT NULL');
  if (input.entityType === 'voucher') where.push('a.voucher_id IS NOT NULL');
  if (input.entityType === 'ledger') where.push('a.ledger_id IS NOT NULL');
  if (input.entityType === 'stock_item') where.push('a.stock_item_id IS NOT NULL');
  if (input.from) {
    where.push('a.created_at >= :from');
    params.from = new Date(`${input.from}T00:00:00`).toISOString();
  }
  if (input.to) {
    where.push('a.created_at < :to');
    const next = new Date(`${input.to}T00:00:00`);
    next.setDate(next.getDate() + 1);
    params.to = next.toISOString();
  }
  const owner = `COALESCE(
      (SELECT t.name || COALESCE(' ' || v.number, '') FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE v.id = a.voucher_id),
      (SELECT name FROM ledgers WHERE id = a.ledger_id),
      (SELECT name FROM stock_items WHERE id = a.stock_item_id), '')`;
  const term = input.search?.trim();
  if (term) {
    where.push(`(a.file_name LIKE :q ESCAPE '\\' OR a.note LIKE :q ESCAPE '\\' OR ${owner} LIKE :q ESCAPE '\\')`);
    params.q = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const agg = ctx.db.get<{ n: number; bytes: number | null }>(`SELECT COUNT(*) AS n, SUM(a.size_bytes) AS bytes FROM attachments a ${whereSql}`, params);
  const limit = Math.min(Math.max(1, input.limit ?? 500), 5000);
  const offset = Math.max(0, input.offset ?? 0);
  const dir = attachmentsDir(ctx.company.dir);
  const rows = ctx.db
    .all<AttachmentDbRow & { owner: string; owner_date: string | null }>(
      `SELECT a.*, ${owner} AS owner, (SELECT date FROM vouchers WHERE id = a.voucher_id) AS owner_date
         FROM attachments a ${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset },
    )
    .map(
      (r): AttachmentRegisterRow => ({
        ...toDto(dir, r),
        ownerLabel: r.owner_date ? `${r.owner} (${formatDate(r.owner_date)})` : r.owner,
        ownerDate: r.owner_date,
      }),
    );
  return { rows, total: agg?.n ?? 0, totalBytes: agg?.bytes ?? 0 };
}
