/**
 * The documents module's voucher hook (vouchers/hooks.ts extension point): checks and stores the
 * voucher fields this module owns — `validUntil` (quotation / proforma), `applicableUpto` (reversing
 * journal), `convertedFromId` (conversion link) and `recurring` (recurring occurrence) — inside the
 * voucher's own save transaction. Registered when the module is imported (routes.ts).
 *
 * Conversion and recurring links are made on CREATE only; an alter never adds, moves or removes them
 * (a link disappears only with the voucher at either end, via ON DELETE CASCADE). An alteration is
 * still re-checked against its links: the converted voucher may not move before its quotation, nor the
 * quotation after the voucher it was converted into.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { CONVERSION_TARGETS, type DocumentBaseType } from '../../../shared/types/documents.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { registerVoucherHook, type VoucherHook, type VoucherHookSaveArgs, type VoucherHookValidateArgs } from '../vouchers/hooks.ts';
import { fieldIssue, liveTarget, nowIso, refLabel, voucherRef } from './common.ts';
import { occurrenceOf } from './schedule.ts';
import { loadSchedule } from './recurringStore.ts';

const DOC_BASES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['quotation', 'proforma']);

const BASE_LABEL: Partial<Record<VoucherBaseType, string>> = {
  quotation: 'Quotation',
  proforma: 'Proforma Invoice',
  sales_order: 'Sales Order',
  sales: 'Sales invoice',
};

function validate(ctx: CompanyCtx, a: VoucherHookValidateArgs): void {
  const { input, baseType } = a;
  const db = ctx.db;
  if (input.validUntil !== undefined) {
    if (!DOC_BASES.has(baseType)) throw fieldIssue('validUntil', '"Valid until" applies to quotations and proforma invoices only. Remove it.');
    if (input.validUntil < input.date) {
      throw fieldIssue('validUntil', `The offer cannot expire (${formatDate(input.validUntil)}) before the document date (${formatDate(input.date)}). Choose a later date.`);
    }
  }
  if (input.applicableUpto !== undefined) {
    if (baseType !== 'reversing_journal') throw fieldIssue('applicableUpto', '"Applicable up to" applies to Reversing Journals only. Remove it.');
    if (input.applicableUpto < input.date) {
      throw fieldIssue('applicableUpto', `"Applicable up to" (${formatDate(input.applicableUpto)}) is before the journal date (${formatDate(input.date)}). Choose a date on or after it.`);
    }
  }
  if (a.existing) {
    // Links are made on create only, but an alteration must keep their order of dates: a converted
    // voucher is never dated before the quotation / proforma it converts (nor that document after it).
    const id = a.existing.id;
    const src = db.get<{ id: number; date: string }>(
      `SELECT v.id, v.date FROM document_links k JOIN vouchers v ON v.id = k.source_voucher_id WHERE k.target_voucher_id = :id ORDER BY v.date DESC LIMIT 1`,
      { id },
    );
    if (src && input.date < src.date) {
      const ref = voucherRef(db, src.id);
      throw fieldIssue('date', `This voucher converts ${ref ? refLabel(ref) : 'a quotation'} dated ${formatDate(src.date)}; it cannot be dated before it.`);
    }
    const target = db.get<{ id: number; date: string }>(
      `SELECT v.id, v.date FROM document_links k JOIN vouchers v ON v.id = k.target_voucher_id
        WHERE k.source_voucher_id = :id AND v.is_cancelled = 0 ORDER BY v.date LIMIT 1`,
      { id },
    );
    if (target && input.date > target.date) {
      const ref = voucherRef(db, target.id);
      throw fieldIssue('date', `This document was converted into ${ref ? refLabel(ref) : 'another voucher'} dated ${formatDate(target.date)}; it cannot be dated after it.`);
    }
    return;
  }

  if (input.convertedFromId !== undefined) {
    const src = db.get<{ id: number; base_type: string; date: string; is_cancelled: number }>(
      'SELECT id, base_type, date, is_cancelled FROM vouchers WHERE id = :id',
      { id: input.convertedFromId },
    );
    if (!src) throw fieldIssue('convertedFromId', 'The quotation / proforma this voucher converts no longer exists (it may have been deleted). Remove the link or start again from the document.');
    const srcBase = src.base_type as VoucherBaseType;
    const ref = voucherRef(db, src.id);
    const name = ref ? refLabel(ref) : 'The source document';
    if (!DOC_BASES.has(srcBase)) throw fieldIssue('convertedFromId', `${name} is not a quotation or proforma invoice, so it cannot be converted.`);
    const targets = CONVERSION_TARGETS[srcBase as DocumentBaseType];
    if (!targets.includes(baseType)) {
      throw fieldIssue(
        'convertedFromId',
        `A ${BASE_LABEL[srcBase]} can be converted into ${targets.map((t) => BASE_LABEL[t] ?? t).join(' or ')} only, not a ${BASE_LABEL[baseType] ?? baseType.replace(/_/g, ' ')}.`,
      );
    }
    if (src.is_cancelled === 1) throw fieldIssue('convertedFromId', `${name} is cancelled and cannot be converted.`);
    const decision = db.value<string>('SELECT status FROM document_status WHERE voucher_id = :id', { id: src.id });
    if (decision === 'rejected') throw fieldIssue('convertedFromId', `${name} is marked rejected. Mark it open or accepted first (Quotations › Alt+S), then convert it.`);
    const live = liveTarget(db, src.id);
    if (live) {
      throw fieldIssue('convertedFromId', `${name} has already been converted into ${refLabel(live)} dated ${formatDate(live.date)}. Cancel or delete that voucher to convert it again.`);
    }
    if (input.date < src.date) {
      throw fieldIssue('date', `This voucher converts ${name} dated ${formatDate(src.date)}; it cannot be dated before it.`);
    }
  }

  if (input.recurring !== undefined) {
    const r = input.recurring;
    const tpl = loadSchedule(db, r.templateId);
    if (!tpl) throw fieldIssue('recurring', 'The recurring template of this voucher no longer exists. Post it as an ordinary voucher (remove the recurring link).');
    if (tpl.voucherTypeId !== input.voucherTypeId) throw fieldIssue('recurring', `Recurring template "${tpl.name}" posts ${tpl.voucherTypeName} vouchers; this is a different voucher type.`);
    if (!occurrenceOf(tpl, r.periodKey)) throw fieldIssue('recurring', `${r.periodKey} is not an occurrence of recurring template "${tpl.name}".`);
    const done = db.get<{ status: string; voucher_id: number | null }>(
      'SELECT status, voucher_id FROM recurring_runs WHERE template_id = :t AND period_key = :k',
      { t: r.templateId, k: r.periodKey },
    );
    if (done) {
      const v = done.voucher_id !== null ? voucherRef(db, done.voucher_id) : null;
      throw fieldIssue(
        'recurring',
        done.status === 'skipped'
          ? `Occurrence ${r.periodKey} of "${tpl.name}" was skipped. Undo the skip in Recurring Vouchers first.`
          : `Occurrence ${r.periodKey} of "${tpl.name}" is already posted${v ? ` as ${refLabel(v)} dated ${formatDate(v.date)}` : ''}; it is never posted twice.`,
      );
    }
  }
}

function afterSave(ctx: CompanyCtx, a: VoucherHookSaveArgs): void {
  const db = ctx.db;
  const { input, baseType, id } = a;
  if (DOC_BASES.has(baseType) || baseType === 'reversing_journal' || input.validUntil !== undefined || input.applicableUpto !== undefined) {
    db.run('UPDATE vouchers SET valid_until = :vu, applicable_upto = :au WHERE id = :id', {
      vu: DOC_BASES.has(baseType) ? (input.validUntil ?? null) : null,
      au: baseType === 'reversing_journal' ? (input.applicableUpto ?? null) : null,
      id,
    });
  }
  if (!a.isNew) return;
  const now = nowIso(ctx);
  if (input.convertedFromId !== undefined) {
    db.run('INSERT INTO document_links (source_voucher_id, target_voucher_id, created_at) VALUES (:s, :t, :now)', { s: input.convertedFromId, t: id, now });
    const src = voucherRef(db, input.convertedFromId);
    const target = voucherRef(db, id);
    if (src && target) {
      const guid = db.value<string>('SELECT guid FROM vouchers WHERE id = :id', { id: src.id }) ?? undefined;
      ctx.audit({
        action: 'alter',
        entityType: 'voucher',
        entityId: src.id,
        entityGuid: guid,
        entityLabel: `${refLabel(src)} dated ${formatDate(src.date)}`,
        before: { status: 'open' },
        after: { status: 'converted', convertedTo: { id: target.id, type: target.voucherTypeName, number: target.number, date: target.date } },
      });
    }
  }
  if (input.recurring !== undefined) {
    const occ = loadSchedule(db, input.recurring.templateId);
    const scheduled = occ ? (occurrenceOf(occ, input.recurring.periodKey)?.date ?? input.date) : input.date;
    db.run(
      `INSERT INTO recurring_runs (template_id, period_key, scheduled_date, status, voucher_id, created_at, created_by)
       VALUES (:t, :k, :d, 'posted', :v, :now, :by)`,
      { t: input.recurring.templateId, k: input.recurring.periodKey, d: scheduled, v: id, now, by: ctx.session.userId },
    );
  }
}

export const documentsVoucherHook: VoucherHook = { name: 'documents', validate, afterSave };

registerVoucherHook(documentsVoucherHook);
