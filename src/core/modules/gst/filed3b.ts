/**
 * Changes after GSTR-3B is filed (final wave; table gst_3b_changes, migration 240).
 *
 * A return period whose GSTR-3B is marked filed is protected like a filed GSTR-1 period (filings.ts):
 *   - altering a voucher of that period whose GSTR-3B effect is not nil (purchases and their credit,
 *     ITC reversal / reclaim and reverse-charge journals, bills of entry, advances, outward documents
 *     whose GSTR-1 is not filed) needs confirmation (gst hook: 'gst_amendment' confirm warning);
 *   - a voucher entered later but dated in a filed period, and a deleted / cancelled one, are logged too;
 *   - the change is reported in the GSTR-3B of the FIRST period after the document's period that is not
 *     filed (never later than the working date's period), and the filed period keeps the figures it was
 *     filed with (`gstr3bChangeCorrections`, used by computeGstr3b) — summed over all periods the
 *     corrections are zero.
 * Outward documents of a filed GSTR-1 period are left to the GSTR-1 amendments (they already move the
 * 3.1 figures, amendmentCorrections), so they are never counted twice.
 *
 * A voucher's GSTR-3B effect (`voucherEffect`) is computed with the same functions GSTR-3B uses: its
 * gst_lines through accumulate() and its derived rows (advances, stat lines, bill of entry) through
 * bookAdjustments(…, voucherId).
 */
import type { Gstr3bChangeRow, Gstr3bEffect, GstFiling } from '../../../shared/types/gst-plus.ts';
import type { TaxAmounts, TaxValue } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { addMonths } from '../../../shared/dates.ts';
import type { Db } from '../../db/db.ts';
import { bookAdjustments } from './bookAdjustments.ts';
import { addTax, addTV, loadDocs, zeroTax, zeroTV, type GstCompany } from './docs.ts';
import { periodLabel } from './filings.ts';
import { accumulate } from './gstr3b.ts';
import { monthPeriodKey, parsePeriodKey, quarterPeriodKey } from './period.ts';

const ITC_TYPES = ['IMPG', 'IMPS', 'ISRC', 'OTH'] as const;
type ItcType = (typeof ITC_TYPES)[number];

export function emptyEffect(voucherId: number, label: string, date: string): Gstr3bEffect {
  return {
    voucherId,
    label,
    date,
    det: zeroTV(),
    zero: zeroTV(),
    rcm: zeroTV(),
    itc: { IMPG: zeroTax(), IMPS: zeroTax(), ISRC: zeroTax(), OTH: zeroTax() },
    rul: zeroTax(),
    oth: zeroTax(),
    reclaimed: zeroTax(),
  };
}

const zeroT = (t: TaxAmounts): boolean => TAX_HEADS.every((h) => t[h] === 0);
const zeroV = (t: TaxValue): boolean => t.taxable === 0 && zeroT(t);

export function isNilEffect(e: Gstr3bEffect): boolean {
  return zeroV(e.det) && zeroV(e.zero) && zeroV(e.rcm) && ITC_TYPES.every((t) => zeroT(e.itc[t])) && zeroT(e.rul) && zeroT(e.oth) && zeroT(e.reclaimed);
}

/** The voucher's GSTR-3B effect as it is now in the books (null when it is not in the books or nil). */
export function voucherEffect(db: Db, company: GstCompany, voucherId: number, today: string): Gstr3bEffect | null {
  const v = db.get<{ date: string; number: string | null; type_name: string; in_books: number }>(
    `SELECT v.date, v.number, vt.name AS type_name, (v.affects_books = 1 AND (v.is_post_dated = 0 OR v.date <= :today)) AS in_books
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id`,
    { id: voucherId, today },
  );
  if (!v || v.in_books !== 1) return null;
  const e = emptyEffect(voucherId, `${v.type_name} ${v.number ?? '(no number)'}`, v.date);
  const docs = loadDocs(db, company, { from: v.date, to: v.date, today, ids: [voucherId], anyDate: true }).filter((d) => d.inBooks);
  const a = accumulate(docs);
  const b = bookAdjustments(db, '0000-01-01', '9999-12-31', today, voucherId);
  addTV(e.det, a.supplies.osup_det);
  addTV(e.det, b.advances);
  addTV(e.zero, a.supplies.osup_zero);
  addTV(e.rcm, a.supplies.isup_rev);
  addTV(e.rcm, b.rcmLiability);
  addTax(e.itc.IMPG, a.itc.IMPG);
  addTax(e.itc.IMPG, b.billOfEntry);
  addTax(e.itc.IMPS, a.itc.IMPS);
  addTax(e.itc.ISRC, a.itc.ISRC);
  addTax(e.itc.ISRC, b.rcmCredit);
  addTax(e.itc.OTH, a.itc.OTH);
  addTax(e.itc.OTH, b.reclaimed);
  addTax(e.rul, a.blocked);
  addTax(e.rul, b.billOfEntryBlocked);
  addTax(e.rul, b.reversalRules);
  addTax(e.oth, b.reversalOthers);
  addTax(e.reclaimed, b.reclaimed);
  return isNilEffect(e) ? null : e;
}

// ───────────────────────────── Periods ─────────────────────────────

interface FilingRow {
  form: string;
  return_period: string;
  filed_on: string;
  arn: string | null;
  created_at: string;
}

/** True when any GSTR-3B is marked filed (cheap gate for the voucher hook). */
export function anyGstr3bFiled(db: Db): boolean {
  return db.value(`SELECT 1 FROM gst_return_filings WHERE form = 'gstr3b' LIMIT 1`) !== undefined;
}

/** The filed GSTR-3B period (month, or quarter for QRMP filers) that contains `iso`, or null. */
export function filedGstr3bPeriod(db: Db, iso: string): GstFiling | null {
  const r = db.get<FilingRow>(
    `SELECT * FROM gst_return_filings WHERE form = 'gstr3b' AND return_period IN (:m, :q) ORDER BY length(return_period) LIMIT 1`,
    { m: monthPeriodKey(iso), q: quarterPeriodKey(iso) },
  );
  return r
    ? { form: 'gstr3b', period: r.return_period, periodLabel: periodLabel('gstr3b', r.return_period), filedOn: r.filed_on, arn: r.arn, createdAt: r.created_at }
    : null;
}

/**
 * Period whose GSTR-3B reports a change to a voucher of a filed period: the first period after the
 * voucher's period that is not filed (normally at most the working date's period).
 */
export function gstr3bReportPeriod(db: Db, company: GstCompany, docDate: string, today: string): string {
  const quarterly = company.config.gst.filingFrequency === 'quarterly';
  const step = quarterly ? 3 : 1;
  const keyOf = (d: string): string => (quarterly ? quarterPeriodKey(d) : monthPeriodKey(d));
  let d = addMonths(`${(quarterly ? (parsePeriodKey(keyOf(docDate))?.from ?? docDate) : docDate).slice(0, 7)}-01`, step);
  for (let i = 0; i < 240; i++) {
    const key = keyOf(d);
    const ref = parsePeriodKey(key);
    if (!ref) break;
    if (filedGstr3bPeriod(db, ref.from) === null) return key;
    d = addMonths(d, step);
  }
  return keyOf(today);
}

// ───────────────────────────── Log ─────────────────────────────

interface ChangeRow {
  id: number;
  voucher_id: number | null;
  voucher_guid: string;
  kind: 'altered' | 'added' | 'removed';
  original_period: string;
  report_period: string;
  label: string;
  doc_date: string;
  original: string | null;
  amended: string | null;
  updated_at: string;
}

const parseEffect = (raw: string | null): Gstr3bEffect | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Gstr3bEffect | null;
  } catch {
    return null;
  }
};

/** Log rows of a voucher (by guid), oldest first. */
export function voucherHasGstr3bChanges(db: Db, voucherId: number): { originalPeriod: string } | null {
  const r = db.get<{ p: string }>('SELECT original_period AS p FROM gst_3b_changes WHERE voucher_id = :v ORDER BY id LIMIT 1', { v: voucherId });
  return r ? { originalPeriod: r.p } : null;
}

/**
 * Record a change (inside the voucher's save / delete transaction). The first change of a voucher for a
 * report period keeps the effect before it; later changes in the same period only replace `amended`.
 */
export function recordGstr3bChange(
  db: Db,
  args: {
    voucherId: number | null;
    guid: string;
    kind: 'altered' | 'added' | 'removed';
    originalPeriod: string;
    reportPeriod: string;
    label: string;
    docDate: string;
    original: Gstr3bEffect | null;
    amended: Gstr3bEffect | null;
    ts: string;
  },
): void {
  const existing = db.get<{ id: number; kind: string }>('SELECT id, kind FROM gst_3b_changes WHERE voucher_guid = :g AND report_period = :p', { g: args.guid, p: args.reportPeriod });
  if (existing) {
    db.run('UPDATE gst_3b_changes SET amended = :amended, kind = :kind, label = :label, updated_at = :ts WHERE id = :id', {
      amended: JSON.stringify(args.amended),
      kind: args.kind === 'removed' ? 'removed' : existing.kind,
      label: args.label,
      ts: args.ts,
      id: existing.id,
    });
    return;
  }
  db.run(
    `INSERT INTO gst_3b_changes (voucher_id, voucher_guid, kind, original_period, report_period, label, doc_date, original, amended, created_at, updated_at)
     VALUES (:v, :g, :kind, :op, :rp, :label, :date, :original, :amended, :ts, :ts)`,
    {
      v: args.voucherId,
      g: args.guid,
      kind: args.kind,
      op: args.originalPeriod,
      rp: args.reportPeriod,
      label: args.label,
      date: args.docDate,
      original: JSON.stringify(args.original),
      amended: JSON.stringify(args.amended),
      ts: args.ts,
    },
  );
}

/** Tax payable (3.1 + reverse charge) and net ITC (4(C)) of an effect, per head. */
function liabilityOf(e: Gstr3bEffect | null): TaxAmounts {
  const t = zeroTax();
  if (!e) return t;
  addTax(t, e.det);
  addTax(t, e.zero);
  addTax(t, e.rcm);
  return t;
}
function netItcOf(e: Gstr3bEffect | null): TaxAmounts {
  const t = zeroTax();
  if (!e) return t;
  for (const ty of ITC_TYPES) addTax(t, e.itc[ty]);
  addTax(t, e.rul, -1);
  addTax(t, e.oth, -1);
  return t;
}

function toRow(r: ChangeRow): Gstr3bChangeRow {
  const original = parseEffect(r.original);
  const amended = parseEffect(r.amended);
  const liabilityDelta = liabilityOf(amended);
  addTax(liabilityDelta, liabilityOf(original), -1);
  const itcDelta = netItcOf(amended);
  addTax(itcDelta, netItcOf(original), -1);
  return {
    id: r.id,
    voucherId: r.voucher_id,
    kind: r.kind,
    label: r.label,
    docDate: r.doc_date,
    originalPeriod: r.original_period,
    reportPeriod: r.report_period,
    original,
    amended,
    liabilityDelta,
    itcDelta,
    updatedAt: r.updated_at,
  };
}

export function listGstr3bChanges(db: Db, opts: { reportPeriod?: string; voucherId?: number } = {}): Gstr3bChangeRow[] {
  let rows: ChangeRow[];
  if (opts.reportPeriod !== undefined) rows = db.all<ChangeRow>('SELECT * FROM gst_3b_changes WHERE report_period = :p ORDER BY doc_date, id', { p: opts.reportPeriod });
  else if (opts.voucherId !== undefined) rows = db.all<ChangeRow>('SELECT * FROM gst_3b_changes WHERE voucher_id = :v ORDER BY id', { v: opts.voucherId });
  else rows = db.all<ChangeRow>('SELECT * FROM gst_3b_changes ORDER BY report_period, doc_date, id');
  return rows.map(toRow);
}

/** Fingerprint of the log (for the GSTR-3B credit chain memo). */
export function gstr3bChangesFingerprint(db: Db): string {
  const r = db.get<{ n: number; m: string | null; s: number | null }>('SELECT COUNT(*) AS n, MAX(updated_at) AS m, SUM(id) AS s FROM gst_3b_changes');
  return r ? `${r.n}:${r.m ?? ''}:${r.s ?? 0}` : '';
}

// ───────────────────────────── Effect on the returns of each period ─────────────────────────────

export interface Gstr3bChangeCorrections {
  det: TaxValue;
  zero: TaxValue;
  rcm: TaxValue;
  itc: Record<ItcType, TaxAmounts>;
  rul: TaxAmounts;
  oth: TaxAmounts;
  reclaimed: TaxAmounts;
  /** Rows reported in the range (for the notes / screen). */
  reported: number;
}

function addEffect(c: Gstr3bChangeCorrections, e: Gstr3bEffect, sign: number): void {
  addTV(c.det, e.det, sign);
  addTV(c.zero, e.zero, sign);
  addTV(c.rcm, e.rcm, sign);
  for (const ty of ITC_TYPES) addTax(c.itc[ty], e.itc[ty], sign);
  addTax(c.rul, e.rul, sign);
  addTax(c.oth, e.oth, sign);
  addTax(c.reclaimed, e.reclaimed, sign);
}

/**
 * The change (amended − original) as reported in a later GSTR-3B: tax and taxable values as they are
 * (a reduction nets against the period's other supplies); more credit in 4(A), less credit as a reversal
 * in 4(B)(2) (GSTR-3B takes no negative 4(A)); a reversal undone as a reclaim (4(A)(5) + 4(D)(1)),
 * a reclaim undone as a reversal.
 */
function addDelta(c: Gstr3bChangeCorrections, amended: Gstr3bEffect | null, original: Gstr3bEffect | null): void {
  const z = emptyEffect(0, '', '');
  const a = amended ?? z;
  const o = original ?? z;
  addTV(c.det, a.det);
  addTV(c.det, o.det, -1);
  addTV(c.zero, a.zero);
  addTV(c.zero, o.zero, -1);
  addTV(c.rcm, a.rcm);
  addTV(c.rcm, o.rcm, -1);
  for (const h of TAX_HEADS) {
    for (const ty of ITC_TYPES) {
      // Reclaimed credit is part of 4(A)(5); it is handled with `reclaimed` below.
      const d = a.itc[ty][h] - o.itc[ty][h] - (ty === 'OTH' ? a.reclaimed[h] - o.reclaimed[h] : 0);
      if (d >= 0) c.itc[ty][h] += d;
      else c.oth[h] += -d;
    }
    const rul = a.rul[h] - o.rul[h];
    const oth = a.oth[h] - o.oth[h];
    const rec = a.reclaimed[h] - o.reclaimed[h];
    for (const [d, isRul] of [[rul, true], [oth, false]] as const) {
      if (d >= 0) (isRul ? c.rul : c.oth)[h] += d;
      else {
        c.reclaimed[h] += -d;
        c.itc.OTH[h] += -d;
      }
    }
    if (rec >= 0) {
      c.reclaimed[h] += rec;
      c.itc.OTH[h] += rec;
    } else c.oth[h] += -rec;
  }
}

/**
 * What the log changes in the GSTR-3B of a date range so that a filed period keeps the figures it was
 * filed with and the change is reported in the report period:
 *   the period of the voucher's CURRENT date   − current effect (the books already hold it there)
 *   the original (filed) period                + effect as filed
 *   each report period                         + (amended − original), see addDelta
 */
export function gstr3bChangeCorrections(db: Db, from: string, to: string): Gstr3bChangeCorrections {
  const c: Gstr3bChangeCorrections = {
    det: zeroTV(),
    zero: zeroTV(),
    rcm: zeroTV(),
    itc: { IMPG: zeroTax(), IMPS: zeroTax(), ISRC: zeroTax(), OTH: zeroTax() },
    rul: zeroTax(),
    oth: zeroTax(),
    reclaimed: zeroTax(),
    reported: 0,
  };
  const rows = db.all<ChangeRow>('SELECT * FROM gst_3b_changes ORDER BY voucher_guid, id');
  if (rows.length === 0) return c;
  const inRange = (d: string | undefined | null): boolean => !!d && d >= from && d <= to;
  const groups = new Map<string, ChangeRow[]>();
  for (const r of rows) {
    const g = groups.get(r.voucher_guid) ?? [];
    g.push(r);
    groups.set(r.voucher_guid, g);
  }
  for (const g of groups.values()) {
    const first = g[0];
    const latest = g[g.length - 1];
    const current = latest.voucher_id === null ? null : parseEffect(latest.amended);
    if (current && inRange(current.date)) addEffect(c, current, -1);
    const filed = parseEffect(first.original);
    if (filed && inRange(filed.date)) addEffect(c, filed, +1);
    for (const r of g) {
      const ref = parsePeriodKey(r.report_period);
      if (!ref || !inRange(ref.to)) continue;
      addDelta(c, parseEffect(r.amended), parseEffect(r.original));
      c.reported++;
    }
  }
  return c;
}
