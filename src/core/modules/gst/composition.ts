/**
 * Composition levy (CGST Act s.10, CGST Rules r.7, r.62): CMP-08 quarterly statement and GSTR-4 annual
 * return data, prepared from the books.
 *
 * Rate master (gst_composition_rates, effective-dated, editable): the rate of the company's category
 * effective on each document's date applies to that document; half is CGST, half SGST/UTGST.
 * The tax base is the turnover in the State per the rate row's `basis`:
 *   'turnover'          taxable + exempt / nil-rated / non-GST outward supplies (manufacturers, restaurants)
 *   'taxable_turnover'  taxable outward supplies only (traders, from 1-Jan-2018)
 * Credit notes reduce it, debit notes add to it. Composition taxpayers cannot collect tax, so the books
 * hold only the value (Bills of Supply).
 *
 * CMP-08 Table 3: (1) outward supplies incl. exempt → value and composition tax; (2) inward supplies
 * attracting reverse charge incl. import of services → value and tax at the normal rates (purchases with
 * reverse charge + reverse-charge stat journals); (3) tax payable = 1 + 2; (4) interest (entered by the
 * user). Table 4 "paid" = cash utilised by the set-off journal of the quarter (setoff.ts).
 *
 * GSTR-4 (annual, due 30 April after the year since FY 2021-22): Table 4 inward supplies (4A registered
 * non-RCM, by supplier; 4B registered RCM, by supplier; 4C unregistered, by rate; 4D import of services,
 * by rate), Table 5 (CMP-08 of each quarter), Table 6 (rate-wise outward at the composition rate and
 * inward reverse-charge supplies at the GST rate) and Table 8 (tax payable and paid). Table 7 (TDS / TCS
 * credit) is not tracked. The portal's GSTR-4 JSON schema is not reproduced: exports are our own
 * documented JSON / CSV (README §15).
 */
import { toCsv, type CsvValue } from '../../lib/csv.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  Cmp08Row,
  Cmp08Summary,
  CompositionCategory,
  CompositionRate,
  CompositionSettings,
  Gstr4InwardRow,
  Gstr4QuarterRow,
  Gstr4RateRow,
  Gstr4Summary,
} from '../../../shared/types/gst-plus.ts';
import { COMPOSITION_CATEGORIES } from '../../../shared/types/gst-plus.ts';
import type { ReturnPeriodRef, TaxAmounts, TaxValue } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { formatDate } from '../../../shared/dates.ts';
import { AppError, notFound, rule, validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { assertDateUnlocked, getConfig } from '../company/service.ts';
import { bookAdjustments } from './bookAdjustments.ts';
import { addTax, addTV, cleanTax, lineTV, loadDocs, rupees, zeroTax, zeroTV, type GstCompany, type GstDoc } from './docs.ts';
import { getFiling } from './filings.ts';
import { fyRange, parsePeriodKey, quarterPeriodKey } from './period.ts';

// ───────────────────────────── Settings & rate master ─────────────────────────────

interface RateRow {
  id: number;
  category: string;
  effective_from: string;
  rate: number;
  basis: 'turnover' | 'taxable_turnover';
  note: string | null;
}

const toRate = (r: RateRow): CompositionRate => ({
  id: r.id,
  category: r.category as CompositionCategory,
  effectiveFrom: r.effective_from,
  rate: r.rate,
  basis: r.basis,
  note: r.note,
});

export function compositionCategory(db: Db): CompositionCategory {
  const raw = db.value<string>(`SELECT value FROM gst_settings WHERE key = 'composition'`);
  if (raw) {
    try {
      const c = (JSON.parse(raw) as { category?: string }).category;
      if (c && (COMPOSITION_CATEGORIES as readonly string[]).includes(c)) return c as CompositionCategory;
    } catch {
      // fall through to the default
    }
  }
  return 'trader';
}

export function compositionSettings(db: Db): CompositionSettings {
  return {
    category: compositionCategory(db),
    rates: db.all<RateRow>('SELECT * FROM gst_composition_rates ORDER BY category, effective_from').map(toRate),
  };
}

/**
 * The composition category and the dated rate rows decide the tax of every quarter they cover, so a
 * change reaching into the locked period (on or before F12 lockedUpTo) would change locked CMP-08 /
 * GSTR-4 figures: refused, like the GSTR-3B and CMP-08 manual entries of a locked period.
 */
function assertRatesUnlocked(db: Db, from: string, what: string): void {
  const locked = getConfig(db).lockedUpTo;
  if (!locked || from > locked) return;
  throw new AppError(
    'LOCKED',
    `Books are locked up to ${formatDate(locked)}. ${what} would change the composition tax of the locked period. Add a rate from a date after ${formatDate(locked)}, or unlock the period first.`,
    { lockedUpTo: locked },
  );
}

export function saveCompositionCategory(ctx: CompanyCtx, category: CompositionCategory): CompositionSettings {
  const before = compositionCategory(ctx.db);
  if (before !== category) assertRatesUnlocked(ctx.db, '0000-01-01', 'Changing the composition category');
  ctx.db.run(
    `INSERT INTO gst_settings (key, value, updated_at, updated_by) VALUES ('composition', :v, :ts, :uid)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    { v: JSON.stringify({ category }), ts: ctx.clock.now().toISOString(), uid: ctx.session.userId },
  );
  ctx.audit({ action: 'alter', entityType: 'gst_settings', entityLabel: 'Composition category', before: { category: before }, after: { category } });
  return compositionSettings(ctx.db);
}

export function saveCompositionRate(
  ctx: CompanyCtx,
  input: { id?: number; category: CompositionCategory; effectiveFrom: string; rate: number; basis: 'turnover' | 'taxable_turnover'; note?: string },
): CompositionSettings {
  const before = input.id ? ctx.db.get<RateRow>('SELECT * FROM gst_composition_rates WHERE id = :id', { id: input.id }) : undefined;
  if (input.id && !before) throw notFound('Composition rate', input.id);
  const clash = ctx.db.value<number>('SELECT id FROM gst_composition_rates WHERE category = :c AND effective_from = :f AND id <> :id', {
    c: input.category,
    f: input.effectiveFrom,
    id: input.id ?? 0,
  });
  if (clash !== undefined) throw validation([{ path: 'effectiveFrom', message: 'This category already has a rate from that date. Alter that row instead.' }]);
  const changed =
    !before || before.category !== input.category || before.effective_from !== input.effectiveFrom || before.rate !== input.rate || before.basis !== input.basis;
  if (changed) {
    const from = before && before.effective_from < input.effectiveFrom ? before.effective_from : input.effectiveFrom;
    assertRatesUnlocked(ctx.db, from, before ? 'Altering this rate' : 'A rate from this date');
  }
  const params = { c: input.category, f: input.effectiveFrom, r: input.rate, b: input.basis, n: input.note?.trim() || null };
  let id = input.id ?? 0;
  if (before) ctx.db.run('UPDATE gst_composition_rates SET category = :c, effective_from = :f, rate = :r, basis = :b, note = :n WHERE id = :id', { ...params, id });
  else id = ctx.db.run('INSERT INTO gst_composition_rates (category, effective_from, rate, basis, note) VALUES (:c, :f, :r, :b, :n)', params).lastInsertRowid;
  const after = ctx.db.get<RateRow>('SELECT * FROM gst_composition_rates WHERE id = :id', { id });
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'gst_composition_rate',
    entityId: id,
    entityLabel: `Composition rate ${input.category} from ${input.effectiveFrom}`,
    before: before ? toRate(before) : undefined,
    after: after ? toRate(after) : undefined,
  });
  return compositionSettings(ctx.db);
}

export function deleteCompositionRate(ctx: CompanyCtx, id: number): CompositionSettings {
  const before = ctx.db.get<RateRow>('SELECT * FROM gst_composition_rates WHERE id = :id', { id });
  if (!before) throw notFound('Composition rate', id);
  assertRatesUnlocked(ctx.db, before.effective_from, 'Deleting this rate');
  ctx.db.run('DELETE FROM gst_composition_rates WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'gst_composition_rate', entityId: id, entityLabel: `Composition rate ${before.category} from ${before.effective_from}`, before: toRate(before) });
  return compositionSettings(ctx.db);
}

function rateFinder(db: Db, category: CompositionCategory): (date: string) => CompositionRate | null {
  const rows = db.all<RateRow>('SELECT * FROM gst_composition_rates WHERE category = :c ORDER BY effective_from DESC', { c: category }).map(toRate);
  return (date) => rows.find((r) => r.effectiveFrom <= date) ?? null;
}

// ───────────────────────────── CMP-08 ─────────────────────────────

export function requireComposition(company: GstCompany): void {
  if (company.registration !== 'composition') {
    throw rule('CMP-08 and GSTR-4 are for composition taxpayers. This company is registered as a regular taxpayer (it files GSTR-1 and GSTR-3B).');
  }
}

interface InterestEntry {
  interest: TaxAmounts;
}

export function readCmp08Interest(db: Db, periodKey: string): TaxAmounts {
  const raw = db.value<string>(`SELECT data FROM gst_adjustments WHERE form = 'cmp08' AND return_period = :p`, { p: periodKey });
  const out = zeroTax();
  if (!raw) return out;
  try {
    const v = (JSON.parse(raw) as Partial<InterestEntry>).interest;
    if (v) for (const h of TAX_HEADS) if (typeof v[h] === 'number' && Number.isSafeInteger(v[h]) && v[h] >= 0) out[h] = v[h];
  } catch {
    // ignore a malformed entry
  }
  return out;
}

export function saveCmp08Interest(ctx: CompanyCtx, period: ReturnPeriodRef & { key: string }, interest: Partial<TaxAmounts>): TaxAmounts {
  assertDateUnlocked(ctx.db, period.to);
  const before = readCmp08Interest(ctx.db, period.key);
  const next = { ...before };
  for (const h of TAX_HEADS) if (interest[h] !== undefined) next[h] = interest[h] as number;
  ctx.db.run(
    `INSERT INTO gst_adjustments (form, return_period, data, updated_at, updated_by) VALUES ('cmp08', :p, :data, :ts, :uid)
     ON CONFLICT(form, return_period) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    { p: period.key, data: JSON.stringify({ interest: next }), ts: ctx.clock.now().toISOString(), uid: ctx.session.userId },
  );
  ctx.audit({ action: 'alter', entityType: 'gst_adjustments', entityLabel: `CMP-08 interest ${period.label}`, before, after: next });
  return next;
}

interface RcmPart extends TaxValue {
  rate: number;
}

interface QuarterCalc {
  summary: Cmp08Summary;
  /** Composition tax by composition rate (GSTR-4 table 6). */
  byRate: Map<number, TaxValue>;
  /** Reverse-charge inward by GST rate (GSTR-4 table 6). */
  rcmByRate: Map<number, TaxValue>;
}

const half = (base: Paise, rate: number): Paise => Math.round((base * rate) / 200);

function isRcmDoc(d: GstDoc): boolean {
  return d.reverseCharge || d.nature === 'inward_rcm' || d.nature === 'import_services' || d.lines.some((l) => l.reverseCharge);
}

function cmp08Calc(db: Db, company: GstCompany, period: ReturnPeriodRef & { key: string }, today: string, preloaded?: readonly GstDoc[]): QuarterCalc {
  const category = compositionCategory(db);
  const rateOn = rateFinder(db, category);
  const docs = (preloaded ?? loadDocs(db, company, { from: period.from, to: period.to, today })).filter((d) => d.inBooks);
  const notes: string[] = [];
  let taxable = 0;
  let exempt = 0;
  const byRate = new Map<number, TaxValue>();
  const baseByRate = new Map<string, { rate: number; base: number; value: number }>();
  let outwardDocs = 0;
  let missingRate = false;
  let lastRate: CompositionRate | null = null;
  for (const d of docs) {
    if (d.direction !== 'outward') continue;
    outwardDocs += 1;
    const r = rateOn(d.date);
    if (!r) {
      missingRate = true;
      continue;
    }
    lastRate = r;
    let docTaxable = 0;
    let docExempt = 0;
    for (const l of d.lines) {
      if (l.taxability === 'taxable') docTaxable += d.sign * l.taxable;
      else docExempt += d.sign * l.taxable;
    }
    taxable += docTaxable;
    exempt += docExempt;
    const base = r.basis === 'turnover' ? docTaxable + docExempt : docTaxable;
    const key = `${r.rate}|${r.basis}`;
    const b = baseByRate.get(key) ?? { rate: r.rate, base: 0, value: 0 };
    b.base += base;
    b.value += docTaxable + docExempt;
    baseByRate.set(key, b);
  }
  if (missingRate) notes.push(`No composition rate is set for "${category}" on some document dates: those documents carry no tax here. Add the rate under GST › Composition rates.`);
  const outward: TaxValue = zeroTV();
  let taxBase = 0;
  for (const b of baseByRate.values()) {
    const c = half(b.base, b.rate);
    const t: TaxValue = { taxable: b.value, igst: 0, cgst: c, sgst: c, cess: 0 };
    taxBase += b.base;
    addTV(outward, t);
    const prev = byRate.get(b.rate) ?? zeroTV();
    addTV(prev, t);
    byRate.set(b.rate, prev);
  }
  outward.taxable = taxable + exempt;
  // Inward supplies attracting reverse charge (incl. import of services) + reverse-charge journals.
  const rcm = zeroTV();
  const rcmByRate = new Map<number, TaxValue>();
  let rcmDocs = 0;
  for (const d of docs) {
    if (d.direction !== 'inward' || !isRcmDoc(d)) continue;
    rcmDocs += 1;
    for (const l of d.lines) {
      if (l.taxability !== 'taxable') continue;
      if (!(l.reverseCharge || d.reverseCharge || d.nature === 'inward_rcm' || d.nature === 'import_services')) continue;
      addTV(rcm, lineTV(l), d.sign);
      const p = rcmByRate.get(l.rate) ?? zeroTV();
      addTV(p, lineTV(l), d.sign);
      rcmByRate.set(l.rate, p);
    }
  }
  const book = bookAdjustments(db, period.from, period.to, today);
  addTV(rcm, book.rcmLiability);
  if (book.rcmLiability.taxable !== 0 || book.rcmLiability.cgst !== 0 || book.rcmLiability.igst !== 0) notes.push('Reverse-charge journals (GST details › reverse charge liability) are included in row 2.');
  const payable = zeroTV();
  addTV(payable, outward);
  addTV(payable, rcm);
  const interest = readCmp08Interest(db, period.key);
  const paidRows = db.all<{ head: string; minor: string | null; amount: number }>(
    `SELECT head, minor, SUM(amount) AS amount FROM gst_stat_lines s
      WHERE s.nature = 'cash_utilised' AND s.return_period = :p AND ${BOOKS_FILTER('s')} GROUP BY head, minor`,
    { p: period.key, today },
  );
  const paid = { ...zeroTax(), interest: 0 };
  for (const r of paidRows) {
    if (r.minor === 'interest') paid.interest += r.amount;
    else if (r.minor === 'tax') paid[r.head as keyof TaxAmounts] += r.amount;
  }
  const rateUsed = lastRate ?? rateOn(period.to);
  const table3: Cmp08Row[] = [
    cleanTax({ key: 'outward', row: '1', label: 'Outward supplies (including exempt supplies)', ...outward }),
    cleanTax({ key: 'rcm', row: '2', label: 'Inward supplies attracting reverse charge including import of services', ...rcm }),
    cleanTax({ key: 'payable', row: '3', label: 'Tax payable (1 + 2)', ...payable }),
    cleanTax({ key: 'interest', row: '4', label: 'Interest payable, if any', taxable: 0, ...interest }),
  ];
  if (exempt !== 0 && rateUsed?.basis === 'taxable_turnover') {
    notes.push('Exempt / nil-rated supplies are part of the value in row 1 but carry no composition tax for your category (tax on taxable turnover only).');
  }
  notes.push('Inter-state outward supplies of goods are not allowed under composition (s.10(2)(d)); check GST exceptions if any appear.');
  const summary: Cmp08Summary = {
    period,
    gstin: company.gstin,
    companyName: company.name,
    category,
    rate: rateUsed?.rate ?? 0,
    basis: rateUsed?.basis ?? 'turnover',
    turnover: { taxable, exempt, total: taxable + exempt, taxBase },
    table3,
    paid,
    outwardDocs,
    rcmDocs,
    notes,
    filing: getFiling(db, 'cmp08', period.key),
  };
  return { summary, byRate, rcmByRate };
}

export function requireQuarter(key: string | undefined): ReturnPeriodRef & { key: string; fp: string } {
  const p = key ? parsePeriodKey(key) : null;
  if (!p || p.kind !== 'quarter') throw validation([{ path: 'period', message: "CMP-08 is a quarterly statement: choose a quarter such as '2026-27-Q1'." }]);
  return p;
}

export function computeCmp08(db: Db, company: GstCompany, periodKey: string, today: string): Cmp08Summary {
  requireComposition(company);
  return cmp08Calc(db, company, requireQuarter(periodKey), today).summary;
}

// ───────────────────────────── GSTR-4 ─────────────────────────────

export function computeGstr4(db: Db, company: GstCompany, fy: string, today: string): Gstr4Summary {
  requireComposition(company);
  const range = fyRange(fy);
  if (!range) throw validation([{ path: 'fy', message: 'Financial year must look like 2026-27' }]);
  const all = loadDocs(db, company, { from: range.from, to: range.to, today }).filter((d) => d.inBooks);
  const notes: string[] = [];
  // Table 4: inward supplies.
  const supplier = new Map<string, Gstr4InwardRow>();
  const byRate = new Map<string, Gstr4InwardRow>();
  const totals: Gstr4Summary['table4Totals'] = { '4A': zeroTV(), '4B': zeroTV(), '4C': zeroTV(), '4D': zeroTV() };
  let imports = 0;
  for (const d of all) {
    if (d.direction !== 'inward') continue;
    if (d.nature === 'import_goods' || (d.nature === 'inward_sez' && d.lines.every((l) => l.supplyType === 'goods'))) {
      imports += 1;
      continue;
    }
    let key: '4A' | '4B' | '4C' | '4D';
    if (d.nature === 'import_services') key = '4D';
    else if (!d.party.gstin || d.nature === 'inward_unregistered' || d.party.registration === 'unregistered') key = '4C';
    else key = isRcmDoc(d) ? '4B' : '4A';
    for (const l of d.lines) addTV(totals[key], lineTV(l), d.sign);
    if (key === '4A' || key === '4B') {
      const k = `${key}|${d.party.gstin}`;
      const r = supplier.get(k) ?? { key, label: key === '4A' ? 'From registered supplier' : 'From registered supplier (reverse charge)', gstin: d.party.gstin, partyName: d.party.name ?? d.party.ledgerName, rate: null, documents: 0, ...zeroTV() };
      r.documents += 1;
      for (const l of d.lines) addTV(r, lineTV(l), d.sign);
      supplier.set(k, r);
    } else {
      const docRates = new Set<number>();
      for (const l of d.lines) {
        const k = `${key}|${l.rate}`;
        const r = byRate.get(k) ?? { key, label: key === '4C' ? 'From unregistered supplier' : 'Import of services', gstin: null, partyName: null, rate: l.rate, documents: 0, ...zeroTV() };
        if (!docRates.has(l.rate)) r.documents += 1;
        docRates.add(l.rate);
        addTV(r, lineTV(l), d.sign);
        byRate.set(k, r);
      }
    }
  }
  if (imports > 0) notes.push(`${imports} import(s) of goods are not part of GSTR-4 table 4 (IGST is paid at customs on the bill of entry).`);
  const table4 = [...supplier.values(), ...byRate.values()].sort(
    (a, b) => a.key.localeCompare(b.key) || (a.gstin ?? '').localeCompare(b.gstin ?? '') || (a.rate ?? 0) - (b.rate ?? 0),
  );
  // Table 5: CMP-08 per quarter; table 6 by rate.
  const table5: Gstr4QuarterRow[] = [];
  const outRate = new Map<number, TaxValue>();
  const rcmRate = new Map<number, TaxValue>();
  const payable = zeroTax();
  const interest = zeroTax();
  let paid = 0;
  for (let q = 1; q <= 4; q++) {
    const key = `${fy}-Q${q}`;
    const p = parsePeriodKey(key) as ReturnPeriodRef & { key: string; fp: string };
    const calc = cmp08Calc(db, company, p, today, all.filter((d) => d.date >= p.from && d.date <= p.to));
    const s = calc.summary;
    const [out, rcm, pay, int] = s.table3;
    table5.push({
      quarter: key,
      label: p.label,
      outwardValue: out.taxable,
      outwardTax: { igst: out.igst, cgst: out.cgst, sgst: out.sgst, cess: out.cess },
      rcmValue: rcm.taxable,
      rcmTax: { igst: rcm.igst, cgst: rcm.cgst, sgst: rcm.sgst, cess: rcm.cess },
      interest: { igst: int.igst, cgst: int.cgst, sgst: int.sgst, cess: int.cess },
      paid: s.paid.igst + s.paid.cgst + s.paid.sgst + s.paid.cess + s.paid.interest,
      filed: s.filing !== null,
      taxable: pay.taxable,
      igst: pay.igst,
      cgst: pay.cgst,
      sgst: pay.sgst,
      cess: pay.cess,
    });
    addTax(payable, pay);
    addTax(interest, int);
    paid += s.paid.igst + s.paid.cgst + s.paid.sgst + s.paid.cess + s.paid.interest;
    for (const [r, t] of calc.byRate) addTV(outRate.get(r) ?? (outRate.set(r, zeroTV()).get(r) as TaxValue), t);
    for (const [r, t] of calc.rcmByRate) addTV(rcmRate.get(r) ?? (rcmRate.set(r, zeroTV()).get(r) as TaxValue), t);
    if (!s.filing && p.to < today) notes.push(`CMP-08 for ${p.label} is not marked filed.`);
  }
  const table6: Gstr4RateRow[] = [
    ...[...outRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, t]) => ({ kind: 'outward' as const, rate, ...t })),
    ...[...rcmRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, t]) => ({ kind: 'rcm' as const, rate, ...t })),
  ];
  notes.push('Table 7 (TDS / TCS credit received) is not kept in the books: enter it on the portal from GSTR-7 / GSTR-8.');
  notes.push('Due date: 30 April following the financial year (FY 2021-22 onwards). Late fee and interest are computed by the portal.');
  return {
    fy,
    gstin: company.gstin,
    companyName: company.name,
    caption: 'Prepared from books — verify before filing',
    table4,
    table4Totals: totals,
    table5,
    table6,
    table8: { payable, paid, interest },
    notes,
  };
}

// ───────────────────────────── Exports (our own documented format) ─────────────────────────────

const r2 = (p: Paise): number => rupees(p);

/** CMP-08 as JSON (Bahi format "bahi-cmp08/1", README §15) or CSV. */
export function cmp08Export(s: Cmp08Summary, format: 'json' | 'csv'): { fileName: string; content: string } {
  const base = `CMP08_${s.gstin ?? 'NOGSTIN'}_${s.period.fp ?? s.period.key}`;
  if (format === 'json') {
    const json = {
      format: 'bahi-cmp08/1',
      gstin: s.gstin,
      ret_period: s.period.fp,
      quarter: s.period.key,
      category: s.category,
      rate: s.rate,
      table3: s.table3.map((r) => ({ row: r.row, description: r.label, value: r2(r.taxable), igst: r2(r.igst), cgst: r2(r.cgst), sgst: r2(r.sgst), cess: r2(r.cess) })),
      paid: { igst: r2(s.paid.igst), cgst: r2(s.paid.cgst), sgst: r2(s.paid.sgst), cess: r2(s.paid.cess), interest: r2(s.paid.interest) },
    };
    return { fileName: `${base}.json`, content: JSON.stringify(json) };
  }
  const rows: CsvValue[][] = [['Row', 'Description', 'Value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess']];
  for (const r of s.table3) rows.push([r.row, r.label, r2(r.taxable), r2(r.igst), r2(r.cgst), r2(r.sgst), r2(r.cess)]);
  return { fileName: `${base}.csv`, content: toCsv(rows) };
}

/** GSTR-4 as JSON (Bahi format "bahi-gstr4/1") or CSV (one section per block). */
export function gstr4Export(s: Gstr4Summary, format: 'json' | 'csv'): { fileName: string; content: string } {
  const base = `GSTR4_${s.gstin ?? 'NOGSTIN'}_${s.fy}`;
  const tv = (t: TaxValue): Record<string, number> => ({ value: r2(t.taxable), igst: r2(t.igst), cgst: r2(t.cgst), sgst: r2(t.sgst), cess: r2(t.cess) });
  if (format === 'json') {
    const json = {
      format: 'bahi-gstr4/1',
      gstin: s.gstin,
      fy: s.fy,
      table4: s.table4.map((r) => ({ table: r.key, ctin: r.gstin, supplier: r.partyName, rate: r.rate, documents: r.documents, ...tv(r) })),
      table5: s.table5.map((q) => ({ quarter: q.quarter, outward_value: r2(q.outwardValue), rcm_value: r2(q.rcmValue), ...tv(q), interest: r2(q.interest.igst + q.interest.cgst + q.interest.sgst + q.interest.cess), paid: r2(q.paid) })),
      table6: s.table6.map((r) => ({ kind: r.kind, rate: r.rate, ...tv(r) })),
      table8: { igst: r2(s.table8.payable.igst), cgst: r2(s.table8.payable.cgst), sgst: r2(s.table8.payable.sgst), cess: r2(s.table8.payable.cess), paid: r2(s.table8.paid) },
    };
    return { fileName: `${base}.json`, content: JSON.stringify(json) };
  }
  const lines: CsvValue[][] = [['Table', 'Supplier GSTIN / quarter / kind', 'Name', 'Rate', 'Value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess']];
  for (const r of s.table4) lines.push([r.key, r.gstin ?? '', r.partyName ?? '', r.rate ?? '', r2(r.taxable), r2(r.igst), r2(r.cgst), r2(r.sgst), r2(r.cess)]);
  for (const q of s.table5) lines.push(['5', q.quarter, q.label, '', r2(q.taxable), r2(q.igst), r2(q.cgst), r2(q.sgst), r2(q.cess)]);
  for (const r of s.table6) lines.push(['6', r.kind, '', r.rate, r2(r.taxable), r2(r.igst), r2(r.cgst), r2(r.sgst), r2(r.cess)]);
  return { fileName: `${base}.csv`, content: toCsv(lines) };
}

export { quarterPeriodKey };
