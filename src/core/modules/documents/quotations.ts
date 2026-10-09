/**
 * Quotations and proforma invoices: register with status and conversion rate, accept / reject,
 * conversion drafts, and the links of any voucher (for the voucher view).
 *
 * A quotation / proforma is a voucher of base type 'quotation' / 'proforma' — priced like an invoice
 * by the posting engine (GST computed for printing) but with no ledger entries, no stock movement, no
 * gst_lines and its own number series (vouchers README › §2). Conversion pre-fills a Sales Order or
 * Sales invoice (`documents.draft`); saving it with `convertedFromId` links it back (hook.ts).
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { diffDays, formatDate } from '../../../shared/dates.ts';
import {
  CONVERSION_TARGETS,
  DOCUMENT_STATUSES,
  type DocumentBaseType,
  type DocumentListInput,
  type DocumentListResult,
  type DocumentRow,
  type DocumentStatus,
  type DocumentStatusInput,
  type DraftInput,
  type VoucherLinks,
} from '../../../shared/types/documents.ts';
import type { ItemLineInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule } from '../../lib/errors.ts';
import { ALLOWED_MODES } from '../vouchers/posting.ts';
import { loadVoucherRow, storedInput } from '../vouchers/service.ts';
import { notePendingLines, NOTE_BILLED_BY } from './billsPending.ts';
import { defaultTypeId, documentStatus, fieldIssue, liveTarget, nowIso, REF_SELECT, refLabel, requirePermission, toRef, txt, voucherRef, type RefRow } from './common.ts';
import { orderClosures } from './orders.ts';

const DOC_BASES: readonly DocumentBaseType[] = ['quotation', 'proforma'];
export const isDocumentBase = (b: string): b is DocumentBaseType => (DOC_BASES as readonly string[]).includes(b);

const MAX_ROWS = 5000;

interface DocDbRow {
  id: number;
  number: string | null;
  date: string;
  valid_until: string | null;
  type_name: string;
  party_ledger_id: number | null;
  party_name: string | null;
  total_amount: number;
  is_cancelled: number;
  decision: 'accepted' | 'rejected' | null;
  reason: string | null;
}

/** 'documents.quotation.list' — the register of quotations or proforma invoices with their status. */
export function listDocuments(ctx: CompanyCtx, input: DocumentListInput): DocumentListResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  if (input.from > input.to) throw fieldIssue('to', 'The period ends before it starts. Choose an end date on or after the start date.');
  const party = input.partyLedgerId !== undefined ? 'AND v.party_ledger_id = :party' : '';
  const raw = db.all<DocDbRow>(
    `SELECT v.id, v.number, v.date, v.valid_until, vt.name AS type_name, v.party_ledger_id,
            COALESCE(v.party_name, l.name) AS party_name, v.total_amount, v.is_cancelled, ds.status AS decision, ds.reason
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       LEFT JOIN document_status ds ON ds.voucher_id = v.id
      WHERE v.base_type = :base AND v.date >= :from AND v.date <= :to ${party}
      ORDER BY v.date DESC, v.id DESC`,
    { base: input.baseType, from: input.from, to: input.to, ...(input.partyLedgerId !== undefined ? { party: input.partyLedgerId } : {}) },
  );
  // Live conversion targets of every listed document (one query).
  const targets = new Map<number, RefRow>();
  if (raw.length > 0) {
    for (const t of db.all<RefRow & { source: number }>(
      `SELECT dl.source_voucher_id AS source, v.id, v.number, v.date, vt.name AS type_name, v.base_type, v.is_cancelled
         FROM document_links dl
         JOIN vouchers v ON v.id = dl.target_voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE dl.source_voucher_id IN (SELECT value FROM json_each(:ids)) AND v.is_cancelled = 0
        ORDER BY v.date, v.id`,
      { ids: JSON.stringify(raw.map((r) => r.id)) },
    )) {
      targets.set(t.source, t);
    }
  }
  const search = txt(input.search)?.toLowerCase();
  const byStatus = Object.fromEntries(DOCUMENT_STATUSES.map((s) => [s, { count: 0, value: 0 }])) as DocumentListResult['summary']['byStatus'];
  const rows: DocumentRow[] = [];
  let value = 0;
  let count = 0;
  for (const r of raw) {
    const target = targets.get(r.id);
    const status = documentStatus({ cancelled: r.is_cancelled === 1, converted: target !== undefined, decision: r.decision, validUntil: r.valid_until, today });
    if (search && !`${r.number ?? ''} ${r.party_name ?? ''}`.toLowerCase().includes(search)) continue;
    byStatus[status].count += 1;
    byStatus[status].value += r.total_amount;
    count += 1;
    value += r.total_amount;
    if (input.status !== undefined && status !== input.status) continue;
    if (rows.length >= (input.limit ?? MAX_ROWS)) continue;
    rows.push({
      id: r.id,
      number: r.number,
      date: r.date,
      validUntil: r.valid_until,
      daysToExpiry: r.valid_until ? diffDays(today, r.valid_until) : null,
      voucherTypeName: r.type_name,
      partyLedgerId: r.party_ledger_id,
      partyName: r.party_name,
      amount: r.total_amount,
      status,
      statusReason: r.reason,
      convertedTo: target ? toRef(target) : null,
    });
  }
  const eligible = count - byStatus.cancelled.count;
  const shown = input.status === undefined ? count : byStatus[input.status].count;
  return {
    baseType: input.baseType,
    rows,
    truncated: shown > rows.length,
    summary: {
      count,
      value,
      byStatus,
      conversionRatePct: eligible > 0 ? Math.round((byStatus.converted.count / eligible) * 10_000) / 100 : null,
    },
  };
}

/** 'documents.quotation.setStatus' — record the customer's decision (open again, accepted, rejected). */
export function setDocumentStatus(ctx: CompanyCtx, input: DocumentStatusInput): { id: number; status: DocumentStatus } {
  requirePermission(ctx, 'vouchers.alter', 'change the status of quotations');
  const { db } = ctx;
  const row = loadVoucherRow(db, input.id);
  if (!row) throw notFound('Voucher', input.id);
  if (!isDocumentBase(row.base_type)) throw rule('Only quotations and proforma invoices have an accepted / rejected status.');
  const ref = voucherRef(db, row.id);
  const label = ref ? refLabel(ref) : 'This document';
  if (row.is_cancelled === 1) throw rule(`${label} is cancelled; its status cannot change.`);
  const live = liveTarget(db, row.id);
  if (live && input.status === 'rejected') throw rule(`${label} was converted into ${refLabel(live)}. Cancel or delete that voucher before marking it rejected.`);
  const reason = txt(input.reason) ?? null;
  if (input.status === 'rejected' && !reason) throw fieldIssue('reason', 'Give the reason the customer rejected the offer (price, delivery time, lost to a competitor …).');
  const before = db.get<{ status: string; reason: string | null }>('SELECT status, reason FROM document_status WHERE voucher_id = :id', { id: row.id });
  if (input.status === 'open') {
    db.run('DELETE FROM document_status WHERE voucher_id = :id', { id: row.id });
  } else {
    db.run(
      `INSERT INTO document_status (voucher_id, status, reason, changed_at, changed_by) VALUES (:id, :s, :r, :now, :by)
       ON CONFLICT (voucher_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
      { id: row.id, s: input.status, r: reason, now: nowIso(ctx), by: ctx.session.userId },
    );
  }
  ctx.audit({
    action: 'alter',
    entityType: 'voucher',
    entityId: row.id,
    entityGuid: row.guid,
    entityLabel: `${label} dated ${formatDate(row.date)}`,
    before: { status: before?.status ?? 'open', reason: before?.reason ?? null },
    after: { status: input.status, reason },
  });
  const validUntil = db.value<string | null>('SELECT valid_until FROM vouchers WHERE id = :id', { id: row.id }) ?? null;
  const status = documentStatus({ cancelled: false, converted: live !== null, decision: input.status === 'open' ? null : input.status, validUntil, today: ctx.clock.today() });
  return { id: row.id, status };
}

/** 'documents.links' — everything the documents module knows about one voucher (voucher view). */
export function voucherLinks(ctx: CompanyCtx, id: number): VoucherLinks {
  const { db } = ctx;
  const row = loadVoucherRow(db, id);
  if (!row) throw notFound('Voucher', id);
  const base = row.base_type as VoucherBaseType;
  const extra = db.get<{ valid_until: string | null; applicable_upto: string | null }>('SELECT valid_until, applicable_upto FROM vouchers WHERE id = :id', { id });
  const convertedTo = db
    .all<RefRow>(`${REF_SELECT} JOIN document_links dl ON dl.target_voucher_id = v.id WHERE dl.source_voucher_id = :id ORDER BY v.date, v.id`, { id })
    .map(toRef);
  const fromId = db.value<number>('SELECT source_voucher_id FROM document_links WHERE target_voucher_id = :id', { id });
  let document: VoucherLinks['document'] = null;
  if (isDocumentBase(base)) {
    const d = db.get<{ status: 'accepted' | 'rejected'; reason: string | null }>('SELECT status, reason FROM document_status WHERE voucher_id = :id', { id });
    document = {
      status: documentStatus({
        cancelled: row.is_cancelled === 1,
        converted: convertedTo.some((t) => !t.isCancelled),
        decision: d?.status ?? null,
        validUntil: extra?.valid_until ?? null,
        today: ctx.clock.today(),
      }),
      validUntil: extra?.valid_until ?? null,
      reason: d?.reason ?? null,
      targets: [...CONVERSION_TARGETS[base]],
    };
  }
  const run = db.get<{ template_id: number; name: string; period_key: string }>(
    `SELECT r.template_id, t.name, r.period_key FROM recurring_runs r JOIN recurring_templates t ON t.id = r.template_id WHERE r.voucher_id = :id`,
    { id },
  );
  return {
    voucherId: id,
    baseType: base,
    document,
    convertedFrom: fromId !== undefined ? voucherRef(db, fromId) : null,
    convertedTo,
    applicableUpto: base === 'reversing_journal' ? (extra?.applicable_upto ?? null) : null,
    recurring: run ? { templateId: run.template_id, templateName: run.name, periodKey: run.period_key } : null,
    templates: db
      .all<{ id: number; name: string; is_active: number }>('SELECT id, name, is_active FROM recurring_templates WHERE source_voucher_id = :id ORDER BY name', { id })
      .map((t) => ({ id: t.id, name: t.name, isActive: t.is_active === 1 })),
    closures: base === 'sales_order' || base === 'purchase_order' ? orderClosures(db, id) : [],
  };
}

// ───────────────────────────── Drafts (conversion / billing) ─────────────────────────────

/** Strip what belongs to the source document only. */
function baseDraft(src: VoucherInput, voucherTypeId: number, date: string): VoucherInput {
  const out: VoucherInput = { ...src, voucherTypeId, date };
  for (const k of ['id', 'number', 'expectedUpdatedAt', 'acknowledgeWarnings', 'effectiveDate', 'isPostDated', 'isOptional', 'partyBillAllocations', 'validUntil', 'applicableUpto', 'convertedFromId', 'recurring', 'referenceNo', 'referenceDate', 'originalInvoiceNo', 'originalInvoiceDate', 'noteReason'] as const) {
    delete out[k];
  }
  if (out.items) {
    out.items = out.items.map((it): ItemLineInput => {
      const c = { ...it };
      delete c.trackingRef;
      delete c.orderRef;
      return c;
    });
  }
  if (out.ledgers) out.ledgers = out.ledgers.map((l) => ({ ...l, billAllocations: undefined }));
  return JSON.parse(JSON.stringify(out)) as VoucherInput;
}

function targetType(db: Db, target: VoucherBaseType, voucherTypeId: number | undefined): { id: number; name: string } {
  if (voucherTypeId !== undefined) {
    const t = db.get<{ id: number; name: string; base_type: string; is_active: number }>('SELECT id, name, base_type, is_active FROM voucher_types WHERE id = :id', { id: voucherTypeId });
    if (!t) throw fieldIssue('voucherTypeId', 'This voucher type no longer exists. Pick another one.');
    if (t.base_type !== target) throw fieldIssue('voucherTypeId', `${t.name} is not a ${target.replace(/_/g, ' ')} voucher type.`);
    if (t.is_active !== 1) throw fieldIssue('voucherTypeId', `The voucher type ${t.name} is inactive. Activate it or pick another one.`);
    return { id: t.id, name: t.name };
  }
  const id = defaultTypeId(db, target);
  if (id === null) throw rule(`There is no active ${target.replace(/_/g, ' ')} voucher type. Activate one under Masters › Voucher Types.`);
  return { id, name: db.value<string>('SELECT name FROM voucher_types WHERE id = :id', { id }) ?? '' };
}

/**
 * 'documents.draft' — a new voucher pre-filled from a source:
 *  - quotation → sales order / sales invoice, proforma → sales invoice (`convertedFromId` set, so saving
 *    links it back and the source shows "converted"; refused when already converted, cancelled or rejected);
 *  - delivery note / receipt note / rejection → the invoice / note that bills it, with the note's
 *    unbilled quantities and `trackingRef` = the note number (the note already moved the stock).
 */
export function draftVoucher(ctx: CompanyCtx, input: DraftInput): VoucherInput {
  const { db } = ctx;
  const row = loadVoucherRow(db, input.sourceId);
  if (!row) throw notFound('Voucher', input.sourceId);
  const base = row.base_type as VoucherBaseType;
  const date = input.date ?? ctx.clock.today();
  const ref = voucherRef(db, row.id);
  const label = ref ? refLabel(ref) : 'The document';
  if (row.is_cancelled === 1) throw rule(`${label} is cancelled; nothing can be made from it.`);
  const src = storedInput(db, row);

  if (isDocumentBase(base)) {
    const targets = CONVERSION_TARGETS[base];
    if (!targets.includes(input.targetBaseType)) {
      throw fieldIssue('targetBaseType', `A ${base === 'quotation' ? 'quotation' : 'proforma invoice'} converts into ${targets.join(' or ').replace(/_/g, ' ')} only.`);
    }
    const live = liveTarget(db, row.id);
    if (live) throw rule(`${label} has already been converted into ${refLabel(live)} dated ${formatDate(live.date)}. Open that voucher instead.`);
    if (db.value<string>('SELECT status FROM document_status WHERE voucher_id = :id', { id: row.id }) === 'rejected') {
      throw rule(`${label} is marked rejected. Mark it open or accepted first, then convert it.`);
    }
    if (!ALLOWED_MODES[input.targetBaseType].includes(src.mode)) {
      throw rule(`${label} was entered as an accounting invoice (ledger lines); a ${input.targetBaseType.replace(/_/g, ' ')} needs stock items. Convert it to a Sales invoice instead.`);
    }
    const t = targetType(db, input.targetBaseType, input.voucherTypeId);
    const out = baseDraft(src, t.id, date < row.date ? row.date : date);
    out.convertedFromId = row.id;
    const refText = `${ref?.voucherTypeName ?? 'Quotation'} ${row.number ?? ''} dt ${formatDate(row.date)}`.replace(/\s+/g, ' ').trim();
    if (!txt(out.orderDetails?.otherRefs)) out.orderDetails = { ...(out.orderDetails ?? {}), otherRefs: refText.slice(0, 200) };
    if (!txt(out.narration)) out.narration = `Against ${refText}`;
    return out;
  }

  const billedBy = NOTE_BILLED_BY[base];
  if (billedBy) {
    if (input.targetBaseType !== billedBy) throw fieldIssue('targetBaseType', `This note is billed by a ${billedBy.replace(/_/g, ' ')} voucher.`);
    if (!row.number) throw rule(`${label} has no number, so an invoice cannot be tracked against it. Give the note a number first.`);
    const pending = notePendingLines(db, row.id);
    if (pending.length === 0) throw rule(`${label} has been billed in full; nothing is pending.`);
    const t = targetType(db, billedBy, input.voucherTypeId);
    const out = baseDraft(src, t.id, date < row.date ? row.date : date);
    out.mode = 'item_invoice';
    out.items = pending.map((p): ItemLineInput => {
      const it: ItemLineInput = { itemId: p.itemId, qty: p.pendingQty, rate: p.rate, trackingRef: row.number as string };
      if (p.discountPct) it.discountPct = p.discountPct;
      if (p.godownId !== null) it.godownId = p.godownId;
      if (p.batchName) it.batchName = p.batchName;
      if (p.ledgerId !== null) it.ledgerId = p.ledgerId;
      return it;
    });
    // Additional ledgers of the note (freight …) are billed with the invoice only if the user adds them.
    delete out.ledgers;
    return out;
  }
  throw rule(`${label} cannot be converted. Quotations, proforma invoices and delivery / receipt notes can.`);
}
