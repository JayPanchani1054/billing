/**
 * Recurring vouchers: templates made from a saved voucher, their schedule (schedule.ts), the list of
 * due occurrences, review-then-post (each occurrence posted through vouchers.save, audited like any
 * voucher, never twice — recurring_runs UNIQUE (template, period) checked by the voucher hook in the
 * same transaction), skip / undo skip and pause.
 *
 * Nothing posts by itself: the app has no background process. The Gateway shows "N recurring
 * vouchers due" when the company opens and the dashboard has a card; the user reviews and posts.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { daysInMonth, diffDays, financialYear, formatDate, parts } from '../../../shared/dates.ts';
import { lineAmount, type Paise } from '../../../shared/money.ts';
import type {
  RecurringDueResult,
  RecurringDueRow,
  RecurringPostInput,
  RecurringPostOutcome,
  RecurringPostResult,
  RecurringRunRow,
  RecurringSaveInput,
  RecurringSchedule,
  RecurringSuggestion,
  RecurringTemplateDetail,
  RecurringTemplateRow,
} from '../../../shared/types/documents.ts';
import type { ItemLineInput, LedgerLineInput, VoucherInput, VoucherRuleErrorDetails } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, conflict, notFound, rule } from '../../lib/errors.ts';
import { randomUUID } from 'node:crypto';
import { loadVoucherType } from '../vouchers/numbering.ts';
import { loadVoucherRow, previewVoucher, saveVoucher, storedInput } from '../vouchers/service.ts';
import { fieldIssue, nowIso, refLabel, requirePermission, txt, voucherRef } from './common.ts';
import { loadSchedule, TEMPLATE_SELECT, toTemplate, type StoredTemplate, type TemplateDbRow } from './recurringStore.ts';
import { nthOccurrence, occurrenceOf, occurrences, periodLabel, type Occurrence } from './schedule.ts';

/** Catch-up occurrences listed per template (oldest first); the rest come after these are dealt with. */
export const MAX_DUE_PER_TEMPLATE = 60;
/** Occurrences enumerated per template when looking for undone ones. */
const SCAN_LIMIT = 2000;

const NOT_RECURRING: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['physical_stock']);

// ───────────────────────────── Template content ─────────────────────────────

/**
 * The voucher a template posts: the saved voucher minus what is specific to one document — number,
 * date, bill-wise references (a new reference is made each time; payments go on account), tracking /
 * order references, cheque numbers, the supplier's invoice number, a conversion / recurring link and
 * the validity / applicable-up-to dates. Returns the notes to show the user.
 */
export function templateInput(src: VoucherInput, base: VoucherBaseType): { input: VoucherInput; notes: string[] } {
  const notes: string[] = [];
  const out: VoucherInput = JSON.parse(JSON.stringify(src)) as VoucherInput;
  for (const k of ['id', 'number', 'expectedUpdatedAt', 'acknowledgeWarnings', 'effectiveDate', 'isPostDated', 'convertedFromId', 'recurring', 'validUntil', 'applicableUpto', 'originalInvoiceNo', 'originalInvoiceDate'] as const) {
    delete out[k];
  }
  if (out.partyBillAllocations) {
    delete out.partyBillAllocations;
    notes.push('Bill-wise details are not copied: each posting makes its own new reference.');
  }
  if (base === 'purchase' && (out.referenceNo || out.referenceDate)) {
    delete out.referenceNo;
    delete out.referenceDate;
    notes.push("The supplier's invoice number is not copied: use Edit & post to type it for each bill.");
  }
  if (out.ledgers) {
    let bills = false;
    let cheques = false;
    out.ledgers = out.ledgers.map((l): LedgerLineInput => {
      const c = { ...l };
      if (c.billAllocations) {
        delete c.billAllocations;
        bills = true;
      }
      if (c.instrument && (c.instrument.number || c.instrument.date)) {
        c.instrument = { type: c.instrument.type, ...(c.instrument.bankName ? { bankName: c.instrument.bankName } : {}), ...(c.instrument.favouring ? { favouring: c.instrument.favouring } : {}) };
        cheques = true;
      }
      return c;
    });
    if (bills) notes.push('Bill references on ledger lines are not copied (amounts go on account unless you allocate them).');
    if (cheques) notes.push('Cheque / instrument numbers and dates are not copied.');
  }
  if (out.items) {
    out.items = out.items.map((it): ItemLineInput => {
      const c = { ...it };
      delete c.trackingRef;
      delete c.orderRef;
      return c;
    });
  }
  return { input: out, notes };
}

/** The single amount an override replaces, or null (several amounts → open it in voucher entry instead). */
export function overrideTarget(input: VoucherInput): { kind: 'ledger_pair' | 'invoice_ledger' | 'item'; amount: Paise } | null {
  const ledgers = input.ledgers ?? [];
  const items = input.items ?? [];
  if (input.mode === 'ledger') {
    const nz = ledgers.filter((l) => l.amount !== 0);
    if (nz.length !== 2 || Math.sign(nz[0].amount) === Math.sign(nz[1].amount) || nz.some((l) => (l.costAllocations?.length ?? 0) > 0)) return null;
    return { kind: 'ledger_pair', amount: Math.abs(nz[0].amount) };
  }
  if (input.mode === 'accounting_invoice') {
    if (ledgers.length !== 1 || items.length > 0 || (ledgers[0].costAllocations?.length ?? 0) > 0) return null;
    return { kind: 'invoice_ledger', amount: ledgers[0].amount };
  }
  if (input.mode === 'item_invoice' || input.mode === 'inventory') {
    if (items.length !== 1) return null;
    const it = items[0];
    return { kind: 'item', amount: it.amount ?? lineAmount(it.billedQty ?? it.qty, it.rate ?? 0, it.discountPct ?? 0) };
  }
  return null;
}

/**
 * Replace the single amount (README › Amount override):
 *  - ledger mode with exactly one Dr and one Cr line: both become ±amount;
 *  - accounting invoice with one ledger line: that line (before GST; tax is recomputed);
 *  - item invoice with one item line: the line value (qty and rate kept, value overridden).
 */
export function applyAmountOverride(input: VoucherInput, amount: Paise, path = 'amount'): VoucherInput {
  const t = overrideTarget(input);
  if (!t) {
    throw fieldIssue(
      path,
      'This voucher has more than one amount (several lines, or cost-centre splits), so a single amount cannot replace them. Use Edit & post to change the lines.',
    );
  }
  if (!(amount > 0)) throw fieldIssue(path, 'Enter an amount greater than zero.');
  const out: VoucherInput = JSON.parse(JSON.stringify(input)) as VoucherInput;
  if (t.kind === 'ledger_pair') {
    out.ledgers = (out.ledgers ?? []).map((l) => (l.amount === 0 ? l : { ...l, amount: l.amount > 0 ? amount : -amount }));
  } else if (t.kind === 'invoice_ledger') {
    out.ledgers = (out.ledgers ?? []).map((l) => ({ ...l, amount }));
  } else {
    out.items = (out.items ?? []).map((it) => ({ ...it, amount }));
  }
  return out;
}

/** Value of the template before tax (Σ debits in ledger mode; Σ lines for invoices / stock vouchers). */
export function templateValue(input: VoucherInput): Paise {
  if (input.mode === 'ledger') return (input.ledgers ?? []).reduce((a, l) => a + (l.amount > 0 ? l.amount : 0), 0);
  const items = (input.items ?? []).filter((it) => !it.isConsumption).reduce((a, it) => a + (it.amount ?? lineAmount(it.billedQty ?? it.qty, it.rate ?? 0, it.discountPct ?? 0)), 0);
  return items + (input.ledgers ?? []).reduce((a, l) => a + l.amount, 0);
}

function fillNarration(text: string | undefined, occ: Occurrence, date: string, fyStartMonth: number): string | undefined {
  if (!text) return text;
  return text
    .replace(/\{period\}/gi, periodLabel(occ))
    .replace(/\{month\}/gi, periodLabel(occ))
    .replace(/\{date\}/gi, formatDate(date))
    .replace(/\{fy\}/gi, financialYear(date, fyStartMonth).label);
}

// ───────────────────────────── Validation ─────────────────────────────

function checkSchedule(s: RecurringSchedule): void {
  if (s.frequency === 'every_n_days') {
    if (!s.intervalDays || s.intervalDays < 1 || s.intervalDays > 366) throw fieldIssue('intervalDays', 'Enter the number of days between postings (1 to 366).');
  } else if (s.dayOfMonth !== null && s.dayOfMonth !== undefined && (s.dayOfMonth < 0 || s.dayOfMonth > 31)) {
    throw fieldIssue('dayOfMonth', 'Day of the month must be 1 to 31, or "last day".');
  }
  if (s.endDate && s.endDate < s.startDate) throw fieldIssue('endDate', 'The end date is before the start date. Choose a later end date, or leave it blank.');
}

function fyStart(db: Db): number {
  return db.value<number>('SELECT fy_start_month FROM company WHERE id = 1') ?? 4;
}

/** Dry-run the template through the posting engine (hard errors throw with paths shown on the form). */
function checkPostable(ctx: CompanyCtx, tpl: { voucherTypeId: number; input: VoucherInput } & RecurringSchedule): void {
  const first = occurrences(tpl, { until: '9999-12-31', limit: 1 }).list[0];
  const date = first?.date ?? tpl.startDate;
  const books = ctx.db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? date;
  try {
    previewVoucher(ctx, { ...tpl.input, voucherTypeId: tpl.voucherTypeId, date: date < books ? books : date });
  } catch (e) {
    if (e instanceof AppError && e.code === 'VALIDATION') {
      throw rule(`The voucher of this template cannot be posted as it is: ${e.message} Correct the source voucher and copy it again.`);
    }
    throw e;
  }
}

// ───────────────────────────── Templates ─────────────────────────────

function runsOf(db: Db, templateId: number): Map<string, { status: 'posted' | 'skipped'; voucherId: number | null }> {
  const out = new Map<string, { status: 'posted' | 'skipped'; voucherId: number | null }>();
  for (const r of db.all<{ period_key: string; status: 'posted' | 'skipped'; voucher_id: number | null }>(
    'SELECT period_key, status, voucher_id FROM recurring_runs WHERE template_id = :id',
    { id: templateId },
  )) {
    out.set(r.period_key, { status: r.status, voucherId: r.voucher_id });
  }
  return out;
}

function nextUndone(t: StoredTemplate, done: ReadonlyMap<string, unknown>): string | null {
  for (let n = 0; n < SCAN_LIMIT; n++) {
    const o = nthOccurrence(t, n);
    if (t.endDate && o.date > t.endDate) return null;
    if (o.date < t.startDate || done.has(o.periodKey)) continue;
    return o.date;
  }
  return null;
}

function toRow(db: Db, t: StoredTemplate): RecurringTemplateRow {
  const done = runsOf(db, t.id);
  const last = db.get<{ scheduled_date: string; voucher_id: number; number: string | null }>(
    `SELECT r.scheduled_date, r.voucher_id, v.number FROM recurring_runs r JOIN vouchers v ON v.id = r.voucher_id
      WHERE r.template_id = :id AND r.status = 'posted' ORDER BY r.scheduled_date DESC LIMIT 1`,
    { id: t.id },
  );
  let posted = 0;
  let skipped = 0;
  for (const r of done.values()) if (r.status === 'posted') posted++;
  else skipped++;
  const party = t.input.partyLedgerId ? (db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: t.input.partyLedgerId }) ?? null) : null;
  return {
    id: t.id,
    name: t.name,
    voucherTypeId: t.voucherTypeId,
    voucherTypeName: t.voucherTypeName,
    baseType: t.baseType,
    partyName: party,
    amount: templateValue(t.input),
    overridable: overrideTarget(t.input) !== null,
    frequency: t.frequency,
    intervalDays: t.intervalDays ?? null,
    dayOfMonth: t.dayOfMonth ?? null,
    startDate: t.startDate,
    endDate: t.endDate ?? null,
    isActive: t.isActive,
    sourceVoucherId: t.sourceVoucherId,
    notes: t.notes,
    nextDate: nextUndone(t, done),
    lastPosted: last ? { date: last.scheduled_date, voucherId: last.voucher_id, number: last.number } : null,
    postedCount: posted,
    skippedCount: skipped,
  };
}

function loadTemplate(db: Db, id: number): StoredTemplate {
  const t = loadSchedule(db, id);
  if (!t) throw notFound('Recurring template', id);
  return t;
}

/** 'documents.recurring.list' */
export function listTemplates(ctx: CompanyCtx): RecurringTemplateRow[] {
  return ctx.db.all<TemplateDbRow>(`${TEMPLATE_SELECT} ORDER BY t.name COLLATE NOCASE`).map((r) => toRow(ctx.db, toTemplate(r)));
}

/** 'documents.recurring.get' */
export function getTemplate(ctx: CompanyCtx, id: number): RecurringTemplateDetail {
  const t = loadTemplate(ctx.db, id);
  const runs: RecurringRunRow[] = ctx.db
    .all<{ period_key: string; scheduled_date: string; status: 'posted' | 'skipped'; voucher_id: number | null; created_at: string }>(
      'SELECT period_key, scheduled_date, status, voucher_id, created_at FROM recurring_runs WHERE template_id = :id ORDER BY scheduled_date DESC LIMIT 100',
      { id },
    )
    .map((r) => ({ periodKey: r.period_key, scheduledDate: r.scheduled_date, status: r.status, voucher: r.voucher_id !== null ? voucherRef(ctx.db, r.voucher_id) : null, createdAt: r.created_at }));
  return { ...toRow(ctx.db, t), input: t.input, runs };
}

/** 'documents.recurring.fromVoucher' — a suggested template (saves nothing). */
export function suggestFromVoucher(ctx: CompanyCtx, voucherId: number): RecurringSuggestion {
  const { db } = ctx;
  const row = loadVoucherRow(db, voucherId);
  if (!row) throw notFound('Voucher', voucherId);
  const base = row.base_type as VoucherBaseType;
  if (row.is_cancelled === 1) throw rule('A cancelled voucher cannot be made recurring. Use a regular voucher of the same kind.');
  if (NOT_RECURRING.has(base)) throw rule('A physical stock count cannot recur: counts are taken on a date.');
  const vt = loadVoucherType(db, row.voucher_type_id);
  const { input, notes } = templateInput(storedInput(db, row), base);
  const ref = voucherRef(db, row.id);
  const party = row.party_name ?? (input.ledgers?.[0] ? db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: input.ledgers[0].ledgerId }) : null);
  const { y, m, d: day } = parts(row.date);
  const target = overrideTarget(input);
  // Start with next month's occurrence (this one is already entered).
  const sched: RecurringSchedule = { frequency: 'monthly', dayOfMonth: day, startDate: row.date };
  const next = nthOccurrence(sched, 1).date;
  return {
    name: `${vt.name}${party ? ` – ${party}` : ''}`.slice(0, 100),
    sourceVoucherId: row.id,
    voucherTypeId: vt.id,
    voucherTypeName: vt.name,
    amount: templateValue(input),
    overridable: target !== null,
    frequency: 'monthly',
    // A voucher on the last day of its month (30-Jun, 28-Feb) recurs on every month's last day.
    dayOfMonth: day >= 28 && day === daysInMonth(y, m) ? 0 : day,
    startDate: next,
    endDate: null,
    intervalDays: null,
    notes: [...(ref ? [`Copied from ${refLabel(ref)} dated ${formatDate(ref.date)}.`] : []), ...notes],
  };
}

/** 'documents.recurring.save' — create (from a saved voucher) or alter. */
export function saveTemplate(ctx: CompanyCtx, input: RecurringSaveInput): RecurringTemplateDetail {
  requirePermission(ctx, 'vouchers.create', 'set up recurring vouchers');
  const { db } = ctx;
  const name = txt(input.name);
  if (!name) throw fieldIssue('name', 'Give the template a name (e.g. "Office rent – Sharma Estates").');
  checkSchedule(input);
  const existing = input.id !== undefined ? loadTemplate(db, input.id) : null;
  if (!existing && input.sourceVoucherId === undefined) throw fieldIssue('sourceVoucherId', 'Pick the saved voucher the template copies.');
  const clash = db.value<number>('SELECT id FROM recurring_templates WHERE name = :name AND id <> :id', { name, id: input.id ?? 0 });
  if (clash !== undefined) throw fieldIssue('name', `A recurring template named "${name}" already exists. Choose another name.`);

  let voucherTypeId = existing?.voucherTypeId ?? 0;
  let body: VoucherInput | null = existing?.input ?? null;
  let sourceId = existing?.sourceVoucherId ?? null;
  if (input.sourceVoucherId !== undefined) {
    const row = loadVoucherRow(db, input.sourceVoucherId);
    if (!row) throw fieldIssue('sourceVoucherId', 'This voucher no longer exists. Pick another one.');
    if (row.is_cancelled === 1) throw fieldIssue('sourceVoucherId', 'A cancelled voucher cannot be made recurring.');
    if (NOT_RECURRING.has(row.base_type as VoucherBaseType)) throw fieldIssue('sourceVoucherId', 'A physical stock count cannot recur.');
    voucherTypeId = row.voucher_type_id;
    body = templateInput(storedInput(db, row), row.base_type as VoucherBaseType).input;
    sourceId = row.id;
  }
  if (!body) throw fieldIssue('sourceVoucherId', 'Pick the saved voucher the template copies.');
  const vt = loadVoucherType(db, voucherTypeId);
  if (vt.numberingMethod === 'manual') {
    throw rule(`${vt.name} vouchers are numbered manually, so they cannot be posted automatically. Set the voucher type to automatic numbering, or use another type.`);
  }
  if (input.amount !== undefined) body = applyAmountOverride(body, input.amount);
  body = { ...body, voucherTypeId };
  const tpl = { voucherTypeId, input: body, frequency: input.frequency, intervalDays: input.intervalDays ?? null, dayOfMonth: input.dayOfMonth ?? null, startDate: input.startDate, endDate: input.endDate ?? null };
  checkPostable(ctx, tpl);

  const now = nowIso(ctx);
  const params = {
    name,
    vt: voucherTypeId,
    input: JSON.stringify(body),
    frequency: input.frequency,
    interval: input.frequency === 'every_n_days' ? (input.intervalDays ?? null) : null,
    dom: input.frequency === 'every_n_days' ? null : (input.dayOfMonth ?? null),
    start: input.startDate,
    end: input.endDate ?? null,
    active: input.isActive === false ? 0 : 1,
    source: sourceId,
    notes: txt(input.notes) ?? null,
    now,
  };
  let id: number;
  if (existing) {
    id = existing.id;
    db.run(
      `UPDATE recurring_templates SET name = :name, voucher_type_id = :vt, input = :input, frequency = :frequency, interval_days = :interval,
              day_of_month = :dom, start_date = :start, end_date = :end, is_active = :active, source_voucher_id = :source, notes = :notes, updated_at = :now
        WHERE id = :id`,
      { ...params, id },
    );
  } else {
    id = db.run(
      `INSERT INTO recurring_templates (guid, name, voucher_type_id, input, frequency, interval_days, day_of_month, start_date, end_date, is_active,
                                        source_voucher_id, notes, created_at, updated_at)
       VALUES (:guid, :name, :vt, :input, :frequency, :interval, :dom, :start, :end, :active, :source, :notes, :now, :now)`,
      { ...params, guid: randomUUID() },
    ).lastInsertRowid;
  }
  const after = loadTemplate(db, id);
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'recurring_template',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: `Recurring voucher "${name}" (${vt.name})`,
    before: existing ? auditView(existing) : undefined,
    after: auditView(after),
  });
  return getTemplate(ctx, id);
}

function auditView(t: StoredTemplate): unknown {
  return {
    name: t.name,
    voucherTypeId: t.voucherTypeId,
    frequency: t.frequency,
    intervalDays: t.intervalDays ?? null,
    dayOfMonth: t.dayOfMonth ?? null,
    startDate: t.startDate,
    endDate: t.endDate ?? null,
    active: t.isActive,
    value: templateValue(t.input),
    partyLedgerId: t.input.partyLedgerId ?? null,
  };
}

/** 'documents.recurring.setActive' — pause / resume. */
export function setTemplateActive(ctx: CompanyCtx, id: number, active: boolean): RecurringTemplateRow {
  requirePermission(ctx, 'vouchers.create', 'pause or resume recurring vouchers');
  const t = loadTemplate(ctx.db, id);
  ctx.db.run('UPDATE recurring_templates SET is_active = :a, updated_at = :now WHERE id = :id', { a: active ? 1 : 0, now: nowIso(ctx), id });
  ctx.audit({ action: 'alter', entityType: 'recurring_template', entityId: id, entityGuid: t.guid, entityLabel: `Recurring voucher "${t.name}"`, before: { active: t.isActive }, after: { active } });
  return toRow(ctx.db, loadTemplate(ctx.db, id));
}

/** 'documents.recurring.delete' — the template and its run history go; posted vouchers stay. */
export function deleteTemplate(ctx: CompanyCtx, id: number): { id: number } {
  requirePermission(ctx, 'vouchers.delete', 'delete recurring templates');
  const t = loadTemplate(ctx.db, id);
  ctx.db.run('DELETE FROM recurring_templates WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'recurring_template', entityId: id, entityGuid: t.guid, entityLabel: `Recurring voucher "${t.name}"`, before: auditView(t) });
  return { id };
}

// ───────────────────────────── Due / post / skip ─────────────────────────────

/** Undone occurrences of one template on or before `asOf` (oldest first). */
function dueOf(t: StoredTemplate, done: ReadonlyMap<string, unknown>, asOf: string): { list: Occurrence[]; truncated: boolean } {
  const { list, truncated } = occurrences(t, { until: asOf, limit: SCAN_LIMIT });
  const open = list.filter((o) => !done.has(o.periodKey));
  return { list: open.slice(0, MAX_DUE_PER_TEMPLATE), truncated: truncated || open.length > MAX_DUE_PER_TEMPLATE };
}

/** 'documents.recurring.due' — every active template's occurrences not yet posted or skipped, up to `asOf`. */
export function dueOccurrences(ctx: CompanyCtx, asOf: string): RecurringDueResult {
  const { db } = ctx;
  const rows: RecurringDueRow[] = [];
  let truncated = false;
  for (const r of db.all<TemplateDbRow>(`${TEMPLATE_SELECT} WHERE t.is_active = 1 AND t.start_date <= :asOf ORDER BY t.name COLLATE NOCASE`, { asOf })) {
    const t = toTemplate(r);
    const due = dueOf(t, runsOf(db, t.id), asOf);
    truncated ||= due.truncated;
    const party = t.input.partyLedgerId ? (db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: t.input.partyLedgerId }) ?? null) : null;
    const amount = templateValue(t.input);
    const overridable = overrideTarget(t.input) !== null;
    for (const o of due.list) {
      rows.push({
        key: `${t.id}|${o.periodKey}`,
        templateId: t.id,
        templateName: t.name,
        voucherTypeId: t.voucherTypeId,
        voucherTypeName: t.voucherTypeName,
        baseType: t.baseType,
        partyName: party,
        periodKey: o.periodKey,
        date: o.date,
        overdueDays: Math.max(0, diffDays(o.date, asOf)),
        amount,
        overridable,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.templateName.localeCompare(b.templateName)));
  return { asOf, rows, truncated };
}

/** The voucher for one occurrence (also 'documents.draft' for Edit & post). */
export function occurrenceInput(ctx: CompanyCtx, templateId: number, periodKey: string, opts: { date?: string; amount?: Paise } = {}): VoucherInput {
  const t = loadTemplate(ctx.db, templateId);
  const occ = occurrenceOf(t, periodKey);
  if (!occ) throw fieldIssue('periodKey', `${periodKey} is not an occurrence of "${t.name}".`);
  const date = opts.date ?? occ.date;
  let input: VoucherInput = { ...t.input, voucherTypeId: t.voucherTypeId, date, recurring: { templateId, periodKey } };
  if (opts.amount !== undefined) input = applyAmountOverride(input, opts.amount);
  const fy = fyStart(ctx.db);
  input.narration = fillNarration(input.narration, occ, date, fy);
  if (input.ledgers) input.ledgers = input.ledgers.map((l) => (l.narration ? { ...l, narration: fillNarration(l.narration, occ, date, fy) } : l));
  return input;
}

/**
 * 'documents.recurring.post' — post the chosen occurrences, each in its own savepoint: one failing
 * (a confirmation needed, a locked period, a deleted ledger) does not stop the others. Each posted
 * voucher is a normal vouchers.save (permissions, period lock, warnings, audit) carrying its
 * recurring link, so the same occurrence can never be posted twice.
 */
export function postOccurrences(ctx: CompanyCtx, input: RecurringPostInput): RecurringPostResult {
  requirePermission(ctx, 'vouchers.create', 'post vouchers');
  const { db } = ctx;
  const results: RecurringPostOutcome[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const key = `${item.templateId}|${item.periodKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const out = db.transaction(() => {
        const t = loadTemplate(db, item.templateId);
        if (!t.isActive) throw rule(`Recurring voucher "${t.name}" is paused. Resume it first.`);
        const voucher = occurrenceInput(ctx, item.templateId, item.periodKey, { date: item.date, amount: item.amount });
        if (input.acknowledgeWarnings) voucher.acknowledgeWarnings = true;
        return saveVoucher(ctx, voucher);
      });
      const v = voucherRef(db, out.id);
      results.push({ templateId: item.templateId, periodKey: item.periodKey, ok: true, voucherId: out.id, number: out.number, date: v?.date ?? item.date ?? '' });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      const details = e.details as VoucherRuleErrorDetails | Array<{ path: string; message: string }> | undefined;
      const needs = !Array.isArray(details) && details?.needsConfirmation === true;
      const message = Array.isArray(details) && details.length > 0 ? details.map((d) => d.message).join(' ') : e.message;
      results.push({ templateId: item.templateId, periodKey: item.periodKey, ok: false, code: e.code, message, needsConfirmation: needs });
    }
  }
  return { posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/** 'documents.recurring.skip' — this occurrence will not be posted (audited). */
export function skipOccurrence(ctx: CompanyCtx, templateId: number, periodKey: string, reason?: string): { templateId: number; periodKey: string } {
  requirePermission(ctx, 'vouchers.create', 'skip recurring vouchers');
  const { db } = ctx;
  const t = loadTemplate(db, templateId);
  const occ = occurrenceOf(t, periodKey);
  if (!occ) throw fieldIssue('periodKey', `${periodKey} is not an occurrence of "${t.name}".`);
  const done = db.get<{ status: string; voucher_id: number | null }>('SELECT status, voucher_id FROM recurring_runs WHERE template_id = :t AND period_key = :k', { t: templateId, k: periodKey });
  if (done) throw conflict(done.status === 'posted' ? `${periodLabel(occ)} of "${t.name}" is already posted.` : `${periodLabel(occ)} of "${t.name}" is already skipped.`);
  db.run(
    `INSERT INTO recurring_runs (template_id, period_key, scheduled_date, status, voucher_id, created_at, created_by)
     VALUES (:t, :k, :d, 'skipped', NULL, :now, :by)`,
    { t: templateId, k: periodKey, d: occ.date, now: nowIso(ctx), by: ctx.session.userId },
  );
  ctx.audit({
    action: 'alter',
    entityType: 'recurring_template',
    entityId: t.id,
    entityGuid: t.guid,
    entityLabel: `Recurring voucher "${t.name}"`,
    after: { skipped: periodKey, date: occ.date, reason: txt(reason) ?? null },
  });
  return { templateId, periodKey };
}

/** 'documents.recurring.unskip' — make a skipped occurrence due again. */
export function unskipOccurrence(ctx: CompanyCtx, templateId: number, periodKey: string): { templateId: number; periodKey: string } {
  requirePermission(ctx, 'vouchers.create', 'change recurring vouchers');
  const { db } = ctx;
  const t = loadTemplate(db, templateId);
  const n = db.run(`DELETE FROM recurring_runs WHERE template_id = :t AND period_key = :k AND status = 'skipped'`, { t: templateId, k: periodKey }).changes;
  if (n === 0) throw rule(`${periodKey} of "${t.name}" is not skipped.`);
  ctx.audit({ action: 'alter', entityType: 'recurring_template', entityId: t.id, entityGuid: t.guid, entityLabel: `Recurring voucher "${t.name}"`, before: { skipped: periodKey }, after: { skipped: null } });
  return { templateId, periodKey };
}

/** Number and value of due occurrences (Gateway banner / dashboard card). */
export function dueCount(ctx: CompanyCtx, asOf: string): { count: number; value: Paise } {
  const due = dueOccurrences(ctx, asOf);
  return { count: due.rows.length, value: due.rows.reduce((a, r) => a + (r.amount ?? 0), 0) };
}
