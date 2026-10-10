/**
 * Return filing status and the GSTR-1 amendments log.
 *
 * Filing status: the user marks a return as filed (form + period, filing date, ARN). A snapshot of the
 * return summary as filed is kept with it. Unmarking is allowed (e.g. marked by mistake) and audited.
 *
 * Amendments (CGST s.37(3); GSTR-1 tables 9A / 9C / 10): once a GSTR-1 period is filed, an outward
 * document of that period is no longer silently re-reported. When it is altered, the change is logged
 * (original as filed + amended) and reported in the GSTR-1 of the FIRST period after it that is not yet
 * filed (`amendPeriod`, never later than the period of the working date). A document entered later but
 * dated in a filed period is logged as 'added' (report it in the current return). Deleting or cancelling
 * a document of a filed period is refused: issue a credit note, or amend it (see hook.ts).
 */
import type {
  GstAmendmentRate,
  GstAmendmentRow,
  GstDocSnapshot,
  GstFiling,
  GstFilingForm,
  Gstr1AmendmentsSummary,
} from '../../../shared/types/gst-plus.ts';
import type { ReturnPeriodRef, TaxValue } from '../../../shared/types/gst-returns.ts';
import { addMonths } from '../../../shared/dates.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { addTV, loadDocs, rateSplit, zeroTV, type GstCompany } from './docs.ts';
import { originalLookup, placeOutward } from './gstr1.ts';
import { fyRange, monthPeriodKey, parsePeriodKey, quarterPeriodKey } from './period.ts';

// ───────────────────────────── Filing status ─────────────────────────────

interface FilingRow {
  form: string;
  return_period: string;
  filed_on: string;
  arn: string | null;
  created_at: string;
}

export function periodLabel(form: string, key: string): string {
  if (form === 'gstr4') return `FY ${key}`;
  return parsePeriodKey(key)?.label ?? key;
}

const toFiling = (r: FilingRow): GstFiling => ({
  form: r.form as GstFilingForm,
  period: r.return_period,
  periodLabel: periodLabel(r.form, r.return_period),
  filedOn: r.filed_on,
  arn: r.arn,
  createdAt: r.created_at,
});

export function listFilings(db: Db, form?: GstFilingForm): GstFiling[] {
  const rows = form
    ? db.all<FilingRow>('SELECT * FROM gst_return_filings WHERE form = :form ORDER BY return_period', { form })
    : db.all<FilingRow>('SELECT * FROM gst_return_filings ORDER BY form, return_period');
  return rows.map(toFiling);
}

export function getFiling(db: Db, form: GstFilingForm, period: string): GstFiling | null {
  const r = db.get<FilingRow>('SELECT * FROM gst_return_filings WHERE form = :form AND return_period = :p', { form, p: period });
  return r ? toFiling(r) : null;
}

function validPeriodFor(form: GstFilingForm, period: string): boolean {
  if (form === 'gstr4') return fyRange(period) !== null;
  const p = parsePeriodKey(period);
  if (!p) return false;
  if (form === 'cmp08') return p.kind === 'quarter';
  return true;
}

export function markFiled(
  ctx: CompanyCtx,
  input: { form: GstFilingForm; period: string; filedOn: string; arn?: string },
  snapshot: unknown,
): GstFiling {
  if (!validPeriodFor(input.form, input.period)) {
    throw validation([{ path: 'period', message: input.form === 'gstr4' ? "GSTR-4 is filed for a financial year such as '2026-27'" : input.form === 'cmp08' ? 'CMP-08 is filed for a quarter' : 'Choose a month or a quarter' }]);
  }
  const range = input.form === 'gstr4' ? fyRange(input.period) : parsePeriodKey(input.period);
  if (range && input.filedOn < range.to.slice(0, 10) && input.form !== 'gstr4') {
    // A return can be filed only after its period ends (GSTR-1 IFF aside); a typo, most likely.
    throw validation([{ path: 'filedOn', message: `The filing date is before the end of the return period (${range.to}). Check the date.` }]);
  }
  if (input.filedOn > ctx.clock.today()) throw validation([{ path: 'filedOn', message: 'The filing date cannot be in the future.' }]);
  const arn = input.arn?.trim() || null;
  if (arn !== null && !/^[A-Z0-9]{10,20}$/i.test(arn)) throw validation([{ path: 'arn', message: 'The ARN has letters and digits only (15 characters, e.g. AA270926123456X).' }]);
  const before = getFiling(ctx.db, input.form, input.period);
  const ts = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO gst_return_filings (form, return_period, filed_on, arn, snapshot, created_at, created_by)
     VALUES (:form, :p, :filedOn, :arn, :snap, :ts, :uid)
     ON CONFLICT(form, return_period) DO UPDATE SET filed_on = excluded.filed_on, arn = excluded.arn,
       snapshot = excluded.snapshot, created_at = excluded.created_at, created_by = excluded.created_by`,
    { form: input.form, p: input.period, filedOn: input.filedOn, arn, snap: JSON.stringify(snapshot ?? null), ts, uid: ctx.session.userId },
  );
  const after = getFiling(ctx.db, input.form, input.period) as GstFiling;
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'gst_filing',
    entityLabel: `${input.form.toUpperCase()} ${after.periodLabel} marked filed`,
    before: before ?? undefined,
    after,
  });
  return after;
}

export function unmarkFiled(ctx: CompanyCtx, form: GstFilingForm, period: string): void {
  const before = getFiling(ctx.db, form, period);
  if (!before) throw notFound('Filed return', `${form} ${period}`);
  if (form === 'gstr1') {
    const used = ctx.db.value<number>('SELECT COUNT(*) FROM gst_amendments WHERE original_period = :p', { p: period }) ?? 0;
    if (used > 0) {
      throw rule(
        `${used} amendment(s) were recorded because GSTR-1 for ${before.periodLabel} is filed. Unmarking it would leave them pointing at a return that is not filed. ` +
          'Keep it marked, or review the amendments first.',
      );
    }
  }
  if (form === 'gstr3b') {
    const used = ctx.db.value<number>('SELECT COUNT(*) FROM gst_3b_changes WHERE original_period = :p', { p: period }) ?? 0;
    if (used > 0) {
      throw rule(
        `${used} change(s) were recorded because GSTR-3B for ${before.periodLabel} is filed (GST › Changes after GSTR-3B filing). Unmarking it would leave them pointing at a return that is not filed. ` +
          'Keep it marked, or review those changes first.',
      );
    }
  }
  ctx.db.run('DELETE FROM gst_return_filings WHERE form = :form AND return_period = :p', { form, p: period });
  ctx.audit({ action: 'delete', entityType: 'gst_filing', entityLabel: `${form.toUpperCase()} ${before.periodLabel} filing mark removed`, before });
}

// ───────────────────────────── GSTR-1 period of a date ─────────────────────────────

/** GSTR-1 return period key of a date for this company (quarter for quarterly filers). */
export function gstr1PeriodOf(company: GstCompany, iso: string): string {
  return company.config.gst.filingFrequency === 'quarterly' ? quarterPeriodKey(iso) : monthPeriodKey(iso);
}

/** The filed GSTR-1 period that contains `iso` (month or quarter key), or null. */
export function filedGstr1Period(db: Db, iso: string): GstFiling | null {
  const r = db.get<FilingRow>(
    `SELECT * FROM gst_return_filings WHERE form = 'gstr1' AND return_period IN (:m, :q) ORDER BY length(return_period) LIMIT 1`,
    { m: monthPeriodKey(iso), q: quarterPeriodKey(iso) },
  );
  return r ? toFiling(r) : null;
}

/**
 * Period whose GSTR-1 reports a change to a document of a filed period: the first period after the
 * document's period that is not filed, but not later than the period of the working date.
 */
export function amendmentPeriod(db: Db, company: GstCompany, docDate: string, today: string): string {
  const quarterly = company.config.gst.filingFrequency === 'quarterly';
  const step = quarterly ? 3 : 1;
  const keyOf = (d: string): string => (quarterly ? quarterPeriodKey(d) : monthPeriodKey(d));
  // Normally that is at most the working date's period; when even that one is already marked filed
  // (e.g. filed on the last day of the period), the next period after it — never a filed one.
  let d = addMonths(`${(quarterly ? (parsePeriodKey(keyOf(docDate))?.from ?? docDate) : docDate).slice(0, 7)}-01`, step);
  for (let i = 0; i < 240; i++) {
    const key = keyOf(d);
    const ref = parsePeriodKey(key);
    if (!ref) break;
    if (filedGstr1Period(db, ref.from) === null) return key;
    d = addMonths(d, step);
  }
  return keyOf(today);
}

// ───────────────────────────── Snapshots ─────────────────────────────

/** GSTR-1 view of one outward document as it is now in the books (null when it is not reported). */
export function docSnapshot(db: Db, company: GstCompany, voucherId: number, today: string): GstDocSnapshot | null {
  const docs = loadDocs(db, company, { from: '0000-01-01', to: '9999-12-31', today, ids: [voucherId], anyDate: true });
  const d = docs.find((x) => x.id === voucherId);
  if (!d || !d.inBooks || d.direction !== 'outward') return null;
  const p = placeOutward(d, originalLookup(db)(d));
  if (!p.section) return null;
  const items: GstAmendmentRate[] = rateSplit(p.taxable).map((r) => ({ rate: r.rate, taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess }));
  return {
    voucherId: d.id,
    baseType: d.baseType,
    number: d.number,
    date: d.date,
    section: p.section,
    gstin: d.party.gstin,
    partyName: d.party.name ?? d.party.ledgerName,
    pos: d.pos,
    value: d.totalAmount,
    reverseCharge: d.reverseCharge,
    invoiceType: p.invoiceType ?? p.exportType ?? p.cdnurType,
    noteType: d.noteType,
    interState: d.interState,
    items,
  };
}

const NOTE_SECTIONS = new Set(['cdnr', 'cdnur']);

function tableOf(s: GstDocSnapshot | null, kind: 'amended' | 'added'): GstAmendmentRow['table'] {
  if (kind === 'added') return 'late';
  if (!s || !s.section) return '9A';
  if (NOTE_SECTIONS.has(s.section)) return '9C';
  if (s.section === 'b2cs') return '10';
  return '9A';
}

function totalOf(s: GstDocSnapshot | null, sign: number): TaxValue {
  const t = zeroTV();
  if (!s) return t;
  // Notes carry positive values (as on the document); a credit note reduces tax.
  const dir = s.noteType === 'C' ? -1 : 1;
  for (const r of s.items) addTV(t, r, sign * dir);
  return t;
}

// ───────────────────────────── Log ─────────────────────────────

interface AmendRow {
  id: number;
  voucher_id: number | null;
  kind: 'amended' | 'added';
  original_period: string;
  amend_period: string;
  orig_number: string | null;
  orig_date: string;
  original: string | null;
  amended: string | null;
  updated_at: string;
}

const parseSnap = (raw: string | null): GstDocSnapshot | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GstDocSnapshot | null;
  } catch {
    return null;
  }
};

/**
 * Record an amendment (called by the voucher hook inside the save transaction). The first change of a
 * document for an amendment period keeps the original as filed; later changes in the same period only
 * replace the amended snapshot.
 */
export function recordAmendment(
  db: Db,
  args: {
    voucherId: number;
    guid: string | null;
    kind: 'amended' | 'added';
    originalPeriod: string;
    amendPeriod: string;
    original: GstDocSnapshot | null;
    amended: GstDocSnapshot | null;
    ts: string;
  },
): void {
  const existing = db.get<{ id: number }>('SELECT id FROM gst_amendments WHERE voucher_id = :v AND amend_period = :p', { v: args.voucherId, p: args.amendPeriod });
  if (existing) {
    db.run('UPDATE gst_amendments SET amended = :amended, updated_at = :ts WHERE id = :id', { amended: JSON.stringify(args.amended), ts: args.ts, id: existing.id });
    return;
  }
  // Earlier amendments of the same document: the portal keys amendments on the ORIGINAL number / date.
  const first = db.get<{ orig_number: string | null; orig_date: string; kind: string }>(
    'SELECT orig_number, orig_date, kind FROM gst_amendments WHERE voucher_id = :v ORDER BY id LIMIT 1',
    { v: args.voucherId },
  );
  const kind = first?.kind === 'added' && args.kind === 'amended' ? 'amended' : args.kind;
  db.run(
    `INSERT INTO gst_amendments (voucher_id, voucher_guid, kind, original_period, amend_period, orig_number, orig_date, original, amended, created_at, updated_at)
     VALUES (:v, :guid, :kind, :op, :ap, :no, :date, :original, :amended, :ts, :ts)`,
    {
      v: args.voucherId,
      guid: args.guid,
      kind,
      op: args.originalPeriod,
      ap: args.amendPeriod,
      no: first?.orig_number ?? args.original?.number ?? args.amended?.number ?? null,
      date: first?.orig_date ?? args.original?.date ?? args.amended?.date ?? '',
      original: JSON.stringify(args.original),
      amended: JSON.stringify(args.amended),
      ts: args.ts,
    },
  );
}

function toRow(r: AmendRow): GstAmendmentRow {
  const original = parseSnap(r.original);
  const amended = parseSnap(r.amended);
  const delta = totalOf(amended, 1);
  addTV(delta, totalOf(original, 1), -1);
  return {
    id: r.id,
    voucherId: r.voucher_id,
    kind: r.kind,
    table: tableOf(original ?? amended, r.kind),
    originalPeriod: r.original_period,
    amendPeriod: r.amend_period,
    origNumber: r.orig_number,
    origDate: r.orig_date,
    original,
    amended,
    delta,
    updatedAt: r.updated_at,
  };
}

export function listAmendments(db: Db, opts: { amendPeriod?: string; voucherId?: number } = {}): GstAmendmentRow[] {
  let rows: AmendRow[];
  if (opts.amendPeriod !== undefined) rows = db.all<AmendRow>('SELECT * FROM gst_amendments WHERE amend_period = :p ORDER BY orig_date, id', { p: opts.amendPeriod });
  else if (opts.voucherId !== undefined) rows = db.all<AmendRow>('SELECT * FROM gst_amendments WHERE voucher_id = :v ORDER BY id', { v: opts.voucherId });
  else rows = db.all<AmendRow>('SELECT * FROM gst_amendments ORDER BY amend_period, orig_date, id');
  return rows.map(toRow);
}

/** Amendments reported in a GSTR-1 period (a month key, or the months of a quarter for quarterly filers). */
export function gstr1Amendments(db: Db, period: ReturnPeriodRef): Gstr1AmendmentsSummary {
  // Amendments are logged under the return period (month, or quarter for quarterly filers) that reports them.
  const rows = period.key ? listAmendments(db, { amendPeriod: period.key }) : [];
  const out: Gstr1AmendmentsSummary = { invoices: [], notes: [], b2cs: [], late: [], net: zeroTV() };
  for (const r of rows) {
    if (r.table === '9A') out.invoices.push(r);
    else if (r.table === '9C') out.notes.push(r);
    else if (r.table === '10') out.b2cs.push(r);
    else out.late.push(r);
    addTV(out.net, r.delta);
  }
  return out;
}

// ───────────────────────────── Effect on the returns of each period ─────────────────────────────

const ZERO_RATED = new Set(['exp_wp', 'exp_wop', 'sez_wp', 'sez_wop']);

export interface AmendmentCorrections {
  /** 3.1(a): outward taxable supplies other than zero-rated. */
  det: TaxValue;
  /** 3.1(b): zero-rated supplies. */
  zero: TaxValue;
}

/**
 * What the amendments log changes in the GSTR-3B / GSTR-1 totals of a date range, so a filed period keeps
 * the figures it was filed with and the change is reported in the amendment period:
 *   the period of the document's CURRENT date   − current values (the books already hold them there)
 *   the original (filed) period                 + values as filed
 *   each amendment period                       + (amended − original)
 * For a document 'added' after filing there is no original: its period loses it, the amendment period
 * gains it. Summed over all periods the corrections are zero.
 */
export function amendmentCorrections(db: Db, from: string, to: string): AmendmentCorrections {
  const out: AmendmentCorrections = { det: zeroTV(), zero: zeroTV() };
  const rows = db.all<AmendRow>('SELECT * FROM gst_amendments ORDER BY voucher_id, id');
  if (rows.length === 0) return out;
  const inRange = (d: string | undefined | null): boolean => !!d && d >= from && d <= to;
  const add = (s: GstDocSnapshot | null, sign: number): void => {
    if (!s || !s.section || s.section === 'b2b_rcm') return;
    addTV(ZERO_RATED.has(s.section) ? out.zero : out.det, totalOf(s, sign));
  };
  const groups = new Map<string, AmendRow[]>();
  for (const r of rows) {
    const key = r.voucher_id === null ? `x${r.id}` : String(r.voucher_id);
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const first = g[0];
    const latest = g[g.length - 1];
    const current = latest.voucher_id === null ? null : parseSnap(latest.amended);
    if (current && inRange(current.date)) add(current, -1);
    const filed = first.kind === 'amended' ? parseSnap(first.original) : null;
    if (filed && inRange(filed.date)) add(filed, +1);
    for (const r of g) {
      const ref = parsePeriodKey(r.amend_period);
      if (!ref || !inRange(ref.to)) continue;
      add(parseSnap(r.amended), +1);
      add(parseSnap(r.original), -1);
    }
  }
  return out;
}

/** Fingerprint of the amendments log (for the GSTR-3B credit chain memo). */
export function amendmentsFingerprint(db: Db): string {
  const r = db.get<{ n: number; m: string | null; s: number | null }>('SELECT COUNT(*) AS n, MAX(updated_at) AS m, SUM(id) AS s FROM gst_amendments');
  return r ? `${r.n}:${r.m ?? ''}:${r.s ?? 0}` : '';
}
