/**
 * The reconciliation engine: pure and deterministic (same input → same output, independent of input order).
 *
 * Key = counterparty GSTIN | class | normalised document no., where class is 'inc' (invoices, debit notes)
 * or 'dec' (credit notes; in the books a purchase return / sales credit note). The class keeps an invoice
 * '1' and a credit note '1' of the same supplier apart, while a supplier's debit note still pairs with the
 * purchase voucher it was booked as.
 *
 * Passes (each only sees what earlier passes left):
 *   1. manual links (decisions) — always win;
 *   2. exact key against books of the period — one-to-one; extra vouchers on the same key make the
 *      portal document a 'duplicate'; a repeated portal document is a 'duplicate' of the first;
 *   3. financial-year-free key ('INV/1/25-26' ~ 'INV1') — only when exactly one portal document and one
 *      voucher share it (fuzzy mode);
 *   4. vouchers of other periods (within 183 days of the portal date) — supplier reported late or the
 *      voucher is dated in another month; flagged 'books_other_period' (info);
 *   5. what is left: portal → missing_in_books, books of the period → missing_in_portal (and, when another
 *      imported period ±2 months has the document, `otherPeriod`).
 * Pairs are compared head by head (see compareDocs); probable matches are only suggested, never linked.
 */
import { diffDays } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { FieldDiff, MatchMethod, PortalDocType, ReconBaseStatus, ReconSource, ReconStatus, ReconTolerance } from '../../../shared/types/gstrecon.ts';
import type { BooksDoc, DocClass } from './books.ts';
import { docNoKeys, exactDocNo, levenshtein, normalizeDocNo } from './docno.ts';
import { periodLabel } from './values.ts';

export interface PortalRec {
  id: number;
  gstin: string;
  docType: PortalDocType;
  docNo: string;
  docDate: string;
  pos: string | null;
  reverseCharge: boolean;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoiceValue: number;
  rates: number[];
  itcAvailable: boolean | null;
}

export interface BooksRec extends BooksDoc {
  /** Document date inside the reconciled period. */
  inRange: boolean;
}

export interface Decision {
  docKey: string | null;
  voucherId: number | null;
  linkVoucherId: number | null;
  resolution: 'accept' | 'ignore' | null;
  remarks: string | null;
}

/** A portal document of another imported period (for 'other_period' on missing-in-portal rows). */
export interface OtherPeriodDoc {
  period: string;
  docId: number;
  gstin: string;
  docType: PortalDocType;
  docNo: string;
}

export interface PortalOutcome {
  docId: number;
  status: ReconStatus;
  baseStatus: ReconBaseStatus;
  voucherId: number | null;
  method: MatchMethod | null;
  manual: boolean;
  diffs: FieldDiff[];
  duplicateVoucherIds: number[];
  duplicateOfDocId: number | null;
  suggestionCount: number;
  notes: string[];
  remarks: string | null;
}

export interface BooksOutcome {
  voucherId: number;
  status: 'missing_in_portal' | 'accepted' | 'ignored';
  baseStatus: 'missing_in_portal';
  otherPeriod: string | null;
  otherPeriodDocId: number | null;
  duplicateVoucherIds: number[];
  suggestionCount: number;
  notes: string[];
  remarks: string | null;
}

export interface Totals {
  count: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface ReconInput {
  source: ReconSource;
  portal: readonly PortalRec[];
  /** Vouchers of the period (inRange) plus vouchers of the surrounding window and manually linked ones. */
  books: readonly BooksRec[];
  decisions: readonly Decision[];
  tolerance: ReconTolerance;
  otherPeriods?: readonly OtherPeriodDoc[];
}

export interface ReconOutcome {
  portal: PortalOutcome[];
  booksOnly: BooksOutcome[];
  /** Books of the period, signed (credit notes / purchase returns negative): all tax and eligible ITC. */
  books: Totals;
  booksEligible: Totals;
  counts: Record<ReconStatus, number>;
}

/** Days within which a voucher of another period may pair with a portal document. */
export const OTHER_PERIOD_WINDOW_DAYS = 183;

export const classOf = (t: PortalDocType): DocClass => (t === 'credit_note' ? 'dec' : 'inc');

/** Stable identity of a portal document (decisions survive re-imports by it). */
export function portalDocKey(gstin: string, docType: PortalDocType, docNo: string): string {
  return `${gstin}|${classOf(docType)}|${normalizeDocNo(docNo)}`;
}

const taxOf = (x: { igst: number; cgst: number; sgst: number; cess: number }): number => x.igst + x.cgst + x.sgst + x.cess;

/** Sum of absolute head differences (closeness of a pair). */
function distance(p: PortalRec, b: BooksRec): number {
  return Math.abs(p.taxable - b.taxable) + Math.abs(p.igst - b.igst) + Math.abs(p.cgst - b.cgst) + Math.abs(p.sgst - b.sgst) + Math.abs(p.cess - b.cess);
}

const days = (p: PortalRec, b: BooksRec): number => Math.abs(diffDays(b.docDate, p.docDate));

const HEADS: ReadonlyArray<readonly ['taxable' | 'igst' | 'cgst' | 'sgst' | 'cess', string]> = [
  ['taxable', 'Taxable value'],
  ['igst', 'IGST'],
  ['cgst', 'CGST'],
  ['sgst', 'SGST/UTGST'],
  ['cess', 'Cess'],
];

const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');
const ratesText = (r: readonly number[]): string => r.map((x) => `${x}%`).join(', ');

/**
 * Field-level comparison of a pair. Amount heads: |portal − books| ≤ tolerance is 'info' (shown, still
 * matched), beyond it 'mismatch'. Date: |days| > dateDays is a mismatch. POS, rates, reverse charge,
 * ITC not available (2B) and GSTIN (manual links) are mismatches; document type (2A/2B), number spelling,
 * invoice value and the books period are informational.
 */
export function compareDocs(p: PortalRec, b: BooksRec, tol: ReconTolerance, source: ReconSource): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const [h, label] of HEADS) {
    const d = p[h] - b[h];
    if (d !== 0) diffs.push({ field: h, label, portal: p[h], books: b[h], difference: d, severity: Math.abs(d) > tol.amountPaise ? 'mismatch' : 'info' });
  }
  const dd = diffDays(b.docDate, p.docDate);
  if (dd !== 0) {
    diffs.push({ field: 'date', label: 'Document date', portal: p.docDate, books: b.docDate, difference: dd, severity: Math.abs(dd) > tol.dateDays ? 'mismatch' : 'info' });
  }
  if (p.pos && b.pos && p.pos !== b.pos) diffs.push({ field: 'pos', label: 'Place of supply', portal: p.pos, books: b.pos, difference: null, severity: 'mismatch' });
  if (p.rates.length > 0 && b.rates.length > 0 && ratesText(p.rates) !== ratesText(b.rates)) {
    diffs.push({ field: 'rate', label: 'Tax rate', portal: ratesText(p.rates), books: ratesText(b.rates), difference: null, severity: 'mismatch' });
  }
  if (p.reverseCharge !== b.reverseCharge) {
    diffs.push({ field: 'reverse_charge', label: 'Reverse charge', portal: yesNo(p.reverseCharge), books: yesNo(b.reverseCharge), difference: null, severity: 'mismatch' });
  }
  if (p.itcAvailable === false && taxOf(b.eligible) !== 0) {
    diffs.push({ field: 'itc', label: 'ITC availability', portal: 'Not available', books: 'Claimed', difference: taxOf(b.eligible), severity: 'mismatch' });
  }
  if (p.gstin !== b.gstin) diffs.push({ field: 'gstin', label: 'GSTIN', portal: p.gstin, books: b.gstin, difference: null, severity: 'mismatch' });
  if (p.docType !== b.docType) {
    diffs.push({ field: 'doc_type', label: 'Document type', portal: p.docType, books: b.docType, difference: null, severity: source === 'gstr1' ? 'mismatch' : 'info' });
  }
  if (exactDocNo(p.docNo) !== exactDocNo(b.docNo)) diffs.push({ field: 'doc_no', label: 'Document number', portal: p.docNo, books: b.docNo, difference: null, severity: 'info' });
  if (p.invoiceValue !== 0 && b.invoiceValue !== 0 && Math.abs(p.invoiceValue - b.invoiceValue) > tol.amountPaise) {
    diffs.push({ field: 'invoice_value', label: 'Invoice value', portal: p.invoiceValue, books: b.invoiceValue, difference: p.invoiceValue - b.invoiceValue, severity: 'info' });
  }
  if (!b.inRange) diffs.push({ field: 'books_period', label: 'Booked in period', portal: null, books: periodLabel(b.period), difference: null, severity: 'info' });
  return diffs;
}

export interface SuggestionScore {
  score: number;
  reasons: string[];
}

/**
 * Probable match: same GSTIN and class (checked by the caller), (taxable + tax) equal within tolerance,
 * and document numbers within 2 edits OR the same date. Score 1–100.
 */
export function suggestionScore(p: PortalRec, b: BooksRec, tol: ReconTolerance): SuggestionScore | null {
  const dAmt = Math.abs(p.taxable + taxOf(p) - (b.taxable + taxOf(b)));
  if (dAmt > tol.amountPaise) return null;
  const lev = levenshtein(normalizeDocNo(p.docNo), normalizeDocNo(b.docNo), 3);
  const dd = days(p, b);
  if (lev > 2 && dd !== 0) return null;
  const amountPenalty = tol.amountPaise > 0 ? Math.round((10 * dAmt) / tol.amountPaise) : 0;
  const score = Math.max(1, Math.min(100, 100 - Math.min(lev, 3) * 15 - Math.min(dd, 30) - amountPenalty));
  const reasons = [
    dAmt === 0 ? 'Same amount' : `Amount differs by ₹ ${formatMoney(dAmt)}`,
    lev === 0 ? 'Same document number' : lev <= 2 ? `Document number differs by ${lev} character${lev === 1 ? '' : 's'}` : 'Different document number',
    dd === 0 ? 'Same date' : `Date differs by ${dd} day${dd === 1 ? '' : 's'}`,
  ];
  return { score, reasons };
}

const emptyTotals = (): Totals => ({ count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

function addTotals(t: Totals, x: { taxable: number; igst: number; cgst: number; sgst: number; cess: number }, sign: number): void {
  t.count++;
  t.taxable += sign * x.taxable;
  t.igst += sign * x.igst;
  t.cgst += sign * x.cgst;
  t.sgst += sign * x.sgst;
  t.cess += sign * x.cess;
}

const cmpPortal = (a: PortalRec, b: PortalRec): number =>
  a.gstin.localeCompare(b.gstin) || a.docDate.localeCompare(b.docDate) || a.docNo.localeCompare(b.docNo) || a.id - b.id;
const cmpBooks = (a: BooksRec, b: BooksRec): number => a.docDate.localeCompare(b.docDate) || a.voucherId - b.voucherId;

function groupBy<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Run the reconciliation. */
export function reconcile(input: ReconInput): ReconOutcome {
  const tol = input.tolerance;
  const fuzzy = tol.fuzzyDocNo;
  const portal = [...input.portal].sort(cmpPortal);
  const books = [...input.books].sort(cmpBooks);
  const booksById = new Map(books.map((b) => [b.voucherId, b]));
  const pKeys = new Map(portal.map((p) => [p.id, docNoKeys(p.docNo, fuzzy)]));
  const bKeys = new Map(books.map((b) => [b.voucherId, docNoKeys(b.docNo, fuzzy)]));
  const pKey = (p: PortalRec, level: 'exact' | 'fy'): string => `${p.gstin}|${classOf(p.docType)}|${(pKeys.get(p.id) as { exact: string; fy: string })[level]}`;
  const bKey = (b: BooksRec, level: 'exact' | 'fy'): string => `${b.gstin}|${b.cls}|${(bKeys.get(b.voucherId) as { exact: string; fy: string })[level]}`;

  const decisionByDoc = new Map<string, Decision>();
  const decisionByVoucher = new Map<number, Decision>();
  for (const d of input.decisions) {
    if (d.docKey !== null) decisionByDoc.set(d.docKey, d);
    else if (d.voucherId !== null) decisionByVoucher.set(d.voucherId, d);
  }
  const stableKey = (p: PortalRec): string => portalDocKey(p.gstin, p.docType, p.docNo);

  const consumed = new Set<number>();
  const pair = new Map<number, { voucherId: number; method: MatchMethod }>();
  const dupVouchers = new Map<number, number[]>();
  const dupOf = new Map<number, number>();
  const notes = new Map<number, string[]>();
  const note = (id: number, text: string): void => {
    const list = notes.get(id) ?? [];
    if (!list.includes(text)) list.push(text);
    notes.set(id, list);
  };

  // 1. Manual links.
  for (const p of portal) {
    const d = decisionByDoc.get(stableKey(p));
    if (!d || d.linkVoucherId === null) continue;
    const b = booksById.get(d.linkVoucherId);
    if (!b) {
      note(p.id, 'The voucher linked earlier is no longer in the books (deleted, cancelled or made optional); the link was not applied.');
      continue;
    }
    if (consumed.has(b.voucherId)) {
      note(p.id, 'The voucher linked to this document is already linked to another document with the same number.');
      continue;
    }
    consumed.add(b.voucherId);
    pair.set(p.id, { voucherId: b.voucherId, method: 'manual' });
  }

  const unpairedPortal = (): PortalRec[] => portal.filter((p) => !pair.has(p.id) && !dupOf.has(p.id));
  const freeBooks = (inRange: boolean): BooksRec[] => books.filter((b) => b.inRange === inRange && !consumed.has(b.voucherId));

  // 2. Exact key, books of the period.
  {
    const pg = groupBy(unpairedPortal(), (p) => pKey(p, 'exact'));
    const bg = groupBy(freeBooks(true), (b) => bKey(b, 'exact'));
    for (const key of [...pg.keys()].sort()) {
      const P = pg.get(key) as PortalRec[];
      const B = bg.get(key);
      if (!B || B.length === 0) continue;
      const cands: Array<{ p: PortalRec; b: BooksRec; dist: number; dd: number }> = [];
      for (const p of P) for (const b of B) cands.push({ p, b, dist: distance(p, b), dd: days(p, b) });
      cands.sort((x, y) => x.dist - y.dist || x.dd - y.dd || x.p.id - y.p.id || x.b.voucherId - y.b.voucherId);
      const assignedP = new Set<number>();
      for (const c of cands) {
        if (assignedP.has(c.p.id) || consumed.has(c.b.voucherId)) continue;
        assignedP.add(c.p.id);
        consumed.add(c.b.voucherId);
        pair.set(c.p.id, { voucherId: c.b.voucherId, method: 'exact' });
      }
      const assigned = P.filter((p) => assignedP.has(p.id));
      // Extra vouchers on the same key → duplicate entry in the books.
      for (const b of B) {
        if (consumed.has(b.voucherId)) continue;
        const target = [...assigned].sort((x, y) => distance(x, b) - distance(y, b) || x.id - y.id)[0];
        consumed.add(b.voucherId);
        const list = dupVouchers.get(target.id) ?? [];
        list.push(b.voucherId);
        dupVouchers.set(target.id, list);
      }
      // Extra portal documents on the same key → repeated on the portal.
      for (const p of P) {
        if (assignedP.has(p.id)) continue;
        const first = assigned[0];
        dupOf.set(p.id, first.id);
      }
    }
  }

  // 3. Financial-year-free key, only when unique on both sides.
  if (fuzzy) {
    const pg = groupBy(unpairedPortal(), (p) => pKey(p, 'fy'));
    const bg = groupBy(freeBooks(true), (b) => bKey(b, 'fy'));
    for (const key of [...pg.keys()].sort()) {
      const P = pg.get(key) as PortalRec[];
      const B = bg.get(key);
      if (P.length !== 1 || !B || B.length !== 1) continue;
      consumed.add(B[0].voucherId);
      pair.set(P[0].id, { voucherId: B[0].voucherId, method: 'fy_stripped' });
    }
  }

  // 4. Vouchers of other periods (late filing / booked in another month).
  {
    const pool = freeBooks(false);
    const exactIdx = groupBy(pool, (b) => bKey(b, 'exact'));
    const fyIdx = fuzzy ? groupBy(pool, (b) => bKey(b, 'fy')) : new Map<string, BooksRec[]>();
    const fyPortal = fuzzy ? groupBy(unpairedPortal(), (p) => pKey(p, 'fy')) : new Map<string, PortalRec[]>();
    for (const p of unpairedPortal()) {
      const near = (list: BooksRec[] | undefined): BooksRec[] =>
        (list ?? []).filter((b) => !consumed.has(b.voucherId) && days(p, b) <= OTHER_PERIOD_WINDOW_DAYS);
      let cands = near(exactIdx.get(pKey(p, 'exact')));
      if (cands.length === 0 && fuzzy && (fyPortal.get(pKey(p, 'fy'))?.length ?? 0) === 1) {
        const fyCands = near(fyIdx.get(pKey(p, 'fy')));
        if (fyCands.length === 1) cands = fyCands;
      }
      if (cands.length === 0) continue;
      const best = [...cands].sort((x, y) => distance(p, x) - distance(p, y) || days(p, x) - days(p, y) || x.voucherId - y.voucherId)[0];
      consumed.add(best.voucherId);
      pair.set(p.id, { voucherId: best.voucherId, method: 'other_period' });
    }
  }

  // Portal documents repeated without any voucher: note it.
  {
    const byKey = groupBy(portal, (p) => pKey(p, 'exact'));
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      for (const p of list) if (!pair.has(p.id) && !dupOf.has(p.id)) note(p.id, `This document appears ${list.length} times in the portal file.`);
    }
  }

  // 5. Outcomes.
  const counts = Object.fromEntries(
    (['pending', 'matched', 'partial', 'missing_in_books', 'missing_in_portal', 'duplicate', 'accepted', 'ignored'] as ReconStatus[]).map((s) => [s, 0]),
  ) as Record<ReconStatus, number>;
  const out: PortalOutcome[] = [];
  const pairedPortalIds = new Set(pair.keys());
  for (const p of [...portal].sort((a, b) => a.id - b.id)) {
    const d = decisionByDoc.get(stableKey(p)) ?? null;
    const pr = pair.get(p.id);
    let baseStatus: ReconBaseStatus;
    let diffs: FieldDiff[] = [];
    let voucherId: number | null = null;
    let method: MatchMethod | null = null;
    let suggestionCount = 0;
    if (pr) {
      const b = booksById.get(pr.voucherId) as BooksRec;
      voucherId = b.voucherId;
      method = pr.method;
      diffs = compareDocs(p, b, tol, input.source);
      baseStatus = dupVouchers.has(p.id) ? 'duplicate' : diffs.some((x) => x.severity === 'mismatch') ? 'partial' : 'matched';
      if (b.dateBasis === 'voucher_date' && input.source !== 'gstr1') note(p.id, 'The supplier invoice date is not entered on the voucher; the voucher date was used.');
      if (b.docNoBasis === 'voucher_number' && input.source !== 'gstr1') note(p.id, 'The supplier invoice number is not entered on the voucher; the voucher number was used.');
      if (b.gstinFromLedger) note(p.id, 'The voucher has no GSTIN; the party ledger’s GSTIN was used.');
      if (dupVouchers.has(p.id)) note(p.id, `${(dupVouchers.get(p.id) as number[]).length + 1} vouchers carry this supplier and document number; only one should remain.`);
    } else if (dupOf.has(p.id)) {
      baseStatus = 'duplicate';
      note(p.id, 'The same document appears more than once in the portal file.');
    } else {
      baseStatus = 'missing_in_books';
      for (const b of books) {
        if (consumed.has(b.voucherId) || b.gstin !== p.gstin || b.cls !== classOf(p.docType)) continue;
        if (suggestionScore(p, b, tol)) suggestionCount++;
      }
    }
    let status: ReconStatus = baseStatus;
    if (d?.resolution === 'ignore') status = 'ignored';
    else if (d?.resolution === 'accept' && baseStatus !== 'matched') status = 'accepted';
    counts[status]++;
    out.push({
      docId: p.id,
      status,
      baseStatus,
      voucherId,
      method,
      manual: method === 'manual',
      diffs,
      duplicateVoucherIds: dupVouchers.get(p.id) ?? [],
      duplicateOfDocId: dupOf.get(p.id) ?? null,
      suggestionCount,
      notes: notes.get(p.id) ?? [],
      remarks: d?.remarks ?? null,
    });
  }

  // Books of the period not paired → missing in portal.
  const otherIdx = groupBy(input.otherPeriods ?? [], (o) => `${o.gstin}|${classOf(o.docType)}|${docNoKeys(o.docNo, fuzzy).exact}`);
  const otherFyIdx = fuzzy ? groupBy(input.otherPeriods ?? [], (o) => `${o.gstin}|${classOf(o.docType)}|${docNoKeys(o.docNo, fuzzy).fy}`) : new Map<string, OtherPeriodDoc[]>();
  const unpairedPortalList = portal.filter((p) => !pairedPortalIds.has(p.id) && !dupOf.has(p.id));
  const missingBooks = books.filter((b) => b.inRange && !consumed.has(b.voucherId));
  const missingByKey = groupBy(missingBooks, (b) => bKey(b, 'exact'));
  const booksOnly: BooksOutcome[] = [];
  for (const b of [...missingBooks].sort((x, y) => x.voucherId - y.voucherId)) {
    const d = decisionByVoucher.get(b.voucherId) ?? null;
    const other = otherIdx.get(bKey(b, 'exact')) ?? otherFyIdx.get(bKey(b, 'fy')) ?? [];
    const firstOther = [...other].sort((x, y) => x.period.localeCompare(y.period) || x.docId - y.docId)[0];
    let suggestionCount = 0;
    for (const p of unpairedPortalList) {
      if (p.gstin !== b.gstin || classOf(p.docType) !== b.cls) continue;
      if (suggestionScore(p, b, tol)) suggestionCount++;
    }
    const n: string[] = [];
    const same = (missingByKey.get(bKey(b, 'exact')) ?? []).filter((x) => x.voucherId !== b.voucherId).map((x) => x.voucherId);
    if (same.length > 0) n.push(`${same.length + 1} vouchers carry this supplier and document number.`);
    if (b.dateBasis === 'voucher_date' && input.source !== 'gstr1') n.push('The supplier invoice date is not entered on the voucher; the voucher date was used.');
    if (b.docNoBasis === 'voucher_number' && input.source !== 'gstr1') n.push('The supplier invoice number is not entered on the voucher; the voucher number was used.');
    if (firstOther) n.push(`Reported on the portal in ${periodLabel(firstOther.period)}.`);
    const status: BooksOutcome['status'] = d?.resolution === 'ignore' ? 'ignored' : d?.resolution === 'accept' ? 'accepted' : 'missing_in_portal';
    counts[status]++;
    booksOnly.push({
      voucherId: b.voucherId,
      status,
      baseStatus: 'missing_in_portal',
      otherPeriod: firstOther?.period ?? null,
      otherPeriodDocId: firstOther?.docId ?? null,
      duplicateVoucherIds: same,
      suggestionCount,
      notes: n,
      remarks: d?.remarks ?? null,
    });
  }

  const booksTotals = emptyTotals();
  const booksEligible = emptyTotals();
  for (const b of books) {
    if (!b.inRange) continue;
    const sign = b.cls === 'dec' ? -1 : 1;
    addTotals(booksTotals, b, sign);
    addTotals(booksEligible, { taxable: b.taxable, ...b.eligible }, sign);
  }
  return { portal: out, booksOnly, books: booksTotals, booksEligible, counts };
}
