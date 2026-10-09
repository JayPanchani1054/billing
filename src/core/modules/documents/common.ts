/**
 * Shared helpers of the documents module: permission checks, voucher references, document status.
 * Imports nothing from the vouchers service (the voucher hook uses this file too).
 */
import type { Permission, VoucherBaseType } from '../../../shared/constants.ts';
import type { DocumentStatus, VoucherRef } from '../../../shared/types/documents.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { forbidden, validation, type AppError } from '../../lib/errors.ts';

export const can = (ctx: CompanyCtx, p: Permission): boolean => ctx.session.isOwner || ctx.session.permissions.has(p);

export function requirePermission(ctx: CompanyCtx, p: Permission, what: string): void {
  if (!can(ctx, p)) throw forbidden(`You do not have permission to ${what}.`);
}

/** VALIDATION with one field issue (the screen highlights `path`). */
export function fieldIssue(path: string, message: string): AppError {
  return validation([{ path, message }]);
}

export function txt(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t === '' ? undefined : t;
}

export interface RefRow {
  id: number;
  number: string | null;
  date: string;
  type_name: string;
  base_type: string;
  is_cancelled: number;
}

export const REF_SELECT = `SELECT v.id, v.number, v.date, vt.name AS type_name, v.base_type, v.is_cancelled
  FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id`;

export function toRef(r: RefRow): VoucherRef {
  return { id: r.id, number: r.number, date: r.date, voucherTypeName: r.type_name, baseType: r.base_type as VoucherBaseType, isCancelled: r.is_cancelled === 1 };
}

export function voucherRef(db: Db, id: number): VoucherRef | null {
  const r = db.get<RefRow>(`${REF_SELECT} WHERE v.id = :id`, { id });
  return r ? toRef(r) : null;
}

export const refLabel = (r: { voucherTypeName: string; number: string | null }): string => `${r.voucherTypeName} ${r.number ?? '(no number)'}`;

/**
 * Status of a quotation / proforma from its stored facts. Precedence: cancelled → converted (a live
 * target exists) → the user's decision (accepted / rejected) → expired (open past valid-until) → open.
 */
export function documentStatus(f: { cancelled: boolean; converted: boolean; decision: 'accepted' | 'rejected' | null; validUntil: string | null; today: string }): DocumentStatus {
  if (f.cancelled) return 'cancelled';
  if (f.converted) return 'converted';
  if (f.decision) return f.decision;
  if (f.validUntil && f.validUntil < f.today) return 'expired';
  return 'open';
}

/** Live conversion target of a source (latest not-cancelled), or null. */
export function liveTarget(db: Db, sourceId: number): VoucherRef | null {
  const r = db.get<RefRow>(
    `${REF_SELECT} JOIN document_links dl ON dl.target_voucher_id = v.id
      WHERE dl.source_voucher_id = :id AND v.is_cancelled = 0 ORDER BY v.date DESC, v.id DESC LIMIT 1`,
    { id: sourceId },
  );
  return r ? toRef(r) : null;
}

/** The predefined (else first active) voucher type of a base type. */
export function defaultTypeId(db: Db, base: VoucherBaseType): number | null {
  return (
    db.value<number>(
      `SELECT id FROM voucher_types WHERE base_type = :base AND is_active = 1 ORDER BY is_predefined DESC, id LIMIT 1`,
      { base },
    ) ?? null
  );
}

export const nowIso = (ctx: CompanyCtx): string => ctx.clock.now().toISOString();
export const userName = (ctx: CompanyCtx): string | null => ctx.session.displayName || ctx.session.username || null;
