/**
 * 'documents.summary' — counts for the Gateway banner ("recurring vouchers due") and the dashboard card.
 */
import { addDays } from '../../../shared/dates.ts';
import type { DocumentsSummary } from '../../../shared/types/documents.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { billsPending } from './billsPending.ts';
import { can } from './common.ts';
import { dueCount } from './recurring.ts';

export function documentsSummary(ctx: CompanyCtx, asOf: string): DocumentsSummary {
  const { db } = ctx;
  const due = dueCount(ctx, asOf);
  // Open = not cancelled, no decision, no live conversion.
  const open = db.all<{ valid_until: string | null }>(
    `SELECT v.valid_until FROM vouchers v
      WHERE v.base_type IN ('quotation', 'proforma') AND v.is_cancelled = 0
        AND NOT EXISTS (SELECT 1 FROM document_status ds WHERE ds.voucher_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM document_links dl JOIN vouchers t ON t.id = dl.target_voucher_id
                         WHERE dl.source_voucher_id = v.id AND t.is_cancelled = 0)
        AND (v.valid_until IS NULL OR v.valid_until >= :asOf)`,
    { asOf },
  );
  const soon = addDays(asOf, 7);
  // Unbilled challans need stock reports access in the UI; the count itself reveals no amounts by party.
  const pending = can(ctx, 'reports.view') ? billsPending(db, { kind: 'sales', asOf }) : null;
  const old = pending ? new Set(pending.rows.filter((r) => r.noteBaseType === 'delivery_note' && r.ageDays > 7).map((r) => r.noteId)) : new Set<number>();
  return {
    asOf,
    recurringDue: due.count,
    recurringDueValue: due.value,
    quotationsOpen: open.length,
    quotationsExpiringSoon: open.filter((o) => o.valid_until !== null && o.valid_until <= soon).length,
    unbilledDeliveryNotes: old.size,
    unbilledValue: pending ? pending.rows.filter((r) => r.noteBaseType === 'delivery_note').reduce((a, r) => a + r.pendingValue, 0) : 0,
  };
}
