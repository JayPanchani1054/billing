/**
 * File attachments of vouchers, ledgers and stock items (dataplus). Routes (src/core/modules/attachments):
 *
 *   'attachments.list'    AttachmentListInput   → AttachmentRow[]          view permission of the owner
 *   'attachments.add'     AttachmentAddInput    → AttachmentRow            attachments.add (+ view of the owner)
 *   'attachments.read'    { id }                → AttachmentFile           view permission of the owner
 *   'attachments.remove'  { id }                → { id, removed: true }    attachments.remove (period lock for vouchers)
 *   'attachments.counts'  AttachmentCountsInput → Record<string, number>   view permission of the owners
 *
 * The renderer never sends a path: it reads the file through the native file dialog and sends the
 * bytes; the core stores them in the company's attachments folder under their SHA-256.
 */
import type { AttachmentEntityType } from '../attachments.ts';

export type { AttachmentEntityType } from '../attachments.ts';

export interface AttachmentRow {
  id: number;
  guid: string;
  entityType: AttachmentEntityType;
  entityId: number;
  fileName: string;
  ext: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
  /** The stored file exists and matches its SHA-256 (checked when listed: size only; read: full hash). */
  fileOk: boolean;
}

export interface AttachmentListInput {
  entityType: AttachmentEntityType;
  entityId: number;
}

export interface AttachmentAddInput {
  entityType: AttachmentEntityType;
  entityId: number;
  /** The name of the file as picked (folders are dropped). */
  fileName: string;
  bytes: Uint8Array;
  note?: string | null;
}

export interface AttachmentFile {
  id: number;
  fileName: string;
  mime: string;
  bytes: Uint8Array;
}

export interface AttachmentCountsInput {
  entityType: AttachmentEntityType;
  ids: number[];
}

/** 'attachments.register' — every attachment of the company (newest first), with its owner. */
export interface AttachmentRegisterInput {
  entityType?: AttachmentEntityType;
  /** Matches the file name, the note or the owner (voucher number, ledger / item name). */
  search?: string;
  /** Attached on or after / before (local dates of created_at). */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AttachmentRegisterRow extends AttachmentRow {
  /** 'Sales INV/26-27/0042 (05-Oct-2026)', 'Acme Traders', 'Mixer Grinder'. */
  ownerLabel: string;
  /** Voucher owners: the voucher date. */
  ownerDate: string | null;
}

export interface AttachmentRegisterResult {
  rows: AttachmentRegisterRow[];
  total: number;
  totalBytes: number;
}
