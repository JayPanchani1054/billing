/**
 * Attachments UI model (pure — tested in model.test.ts): where an attachment's owner opens, the
 * labels the screens show, the client-side checks before a file is sent, and the register export.
 */
import { ATTACHMENT_FILE_FILTERS, MAX_ATTACHMENT_BYTES, attachmentTypeOf, formatFileSize, ALLOWED_ATTACHMENTS_TEXT, type AttachmentEntityType } from '../../../../shared/attachments.ts';
import type { AttachmentRegisterRow, AttachmentRow } from '../../../../shared/types/attachments.ts';

export const MANAGE_SCREEN = 'attachments.manage';
export const REGISTER_SCREEN = 'attachments.register';
/** One key for "Attachments" on the voucher view and the ledger / item forms (F for files). */
export const ATTACHMENTS_KEY = 'Alt+F';

/** Queries refreshed after an attachment changes. */
export const ATTACHMENTS_INVALIDATES = ['attachments'];

export const ENTITY_NOUN: Readonly<Record<AttachmentEntityType, string>> = { voucher: 'Voucher', ledger: 'Ledger', stock_item: 'Stock item' };

export interface ManageParams {
  entityType: AttachmentEntityType;
  entityId: number;
  /** Shown in the subtitle ('Sales INV/0042', 'Acme Traders'). */
  label?: string;
}

/** Screen that opens an attachment's owner. */
export function ownerTarget(r: Pick<AttachmentRow, 'entityType' | 'entityId'>): { screen: string; params: Record<string, unknown> } {
  if (r.entityType === 'voucher') return { screen: 'vouchers.view', params: { id: r.entityId } };
  if (r.entityType === 'ledger') return { screen: 'accounts.ledger.form', params: { id: r.entityId } };
  return { screen: 'inventory.item.form', params: { id: r.entityId } };
}

/** '3 files · 2.4 MB' */
export function summaryText(rows: readonly Pick<AttachmentRow, 'sizeBytes'>[]): string {
  if (rows.length === 0) return 'No files attached';
  const bytes = rows.reduce((s, r) => s + r.sizeBytes, 0);
  return `${rows.length} file${rows.length === 1 ? '' : 's'} · ${formatFileSize(bytes)}`;
}

/** Rail label with the count: 'Attachments (2)'. */
export function railLabel(count: number | undefined): string {
  return count ? `Attachments (${count})` : 'Attachments';
}

/** Problem with a picked file before it is sent (the core checks again, including the contents). */
export function pickedFileProblem(name: string, size: number): string | null {
  if (!attachmentTypeOf(name)) return `“${name}” cannot be attached. Attach ${ALLOWED_ATTACHMENTS_TEXT}.`;
  if (size > MAX_ATTACHMENT_BYTES) return `“${name}” is ${formatFileSize(size)}; at most ${formatFileSize(MAX_ATTACHMENT_BYTES)} can be attached.`;
  if (size === 0) return `“${name}” is empty.`;
  return null;
}

export const PICK_FILTERS = ATTACHMENT_FILE_FILTERS.map((f) => ({ name: f.name, extensions: [...f.extensions] }));

/** Export of the register (sizes in KB as numbers; dates ISO). */
export function registerExport(rows: readonly AttachmentRegisterRow[]): { columns: Array<{ header: string; kind: 'text' | 'date' | 'number' }>; rows: Array<Array<string | number | null>> } {
  return {
    columns: [
      { header: 'Attached on', kind: 'date' },
      { header: 'Attached to', kind: 'text' },
      { header: 'Of', kind: 'text' },
      { header: 'File', kind: 'text' },
      { header: 'Size (KB)', kind: 'number' },
      { header: 'By', kind: 'text' },
      { header: 'Note', kind: 'text' },
      { header: 'SHA-256', kind: 'text' },
    ],
    rows: rows.map((r) => [localDay(r.createdAt), ENTITY_NOUN[r.entityType], r.ownerLabel, r.fileName, Math.round((r.sizeBytes / 1024) * 10) / 10, r.createdByName ?? '', r.note ?? '', r.sha256]),
  };
}

/** Local calendar day of an ISO timestamp ('2026-10-05T20:00:00Z' → '2026-10-06' in India). */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
