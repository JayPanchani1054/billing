/**
 * Read-only reconciliation queries over the stored results of the last run:
 * summary, results (filter / search / paging), supplier-wise summary and probable-match suggestions.
 */
import { addDays } from '../../../shared/dates.ts';
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type {
  ReconDifference,
  ReconResultsInput,
  ReconResultsPage,
  ReconRow,
  ReconSource,
  ReconStatus,
  ReconStatusTotals,
  ReconSuggestion,
  ReconSuggestionsInput,
  ReconSummary,
  SupplierReconRow,
  TaxHeads,
  TaxTotals,
} from '../../../shared/types/gstrecon.ts';
import { RECON_SOURCE_LABELS, RECON_STATUS_LABELS, RECON_STATUSES } from '../../../shared/types/gstrecon.ts';
import type { Db } from '../../db/db.ts';
import { notFound, validation } from '../../lib/errors.ts';
import { lastVoucherChange, loadBooksDocs } from './books.ts';
import { classOf, OTHER_PERIOD_WINDOW_DAYS, suggestionScore, type BooksRec, type Totals } from './matcher.ts';
import {
  booksOnlyRows,
  getDocRow,
  isOpenStatus,
  latestBatch,
  latestRun,
  loadRows,
  periodOfLastRun,
  requirePeriod,
  rowSign,
  sideOf,
  toPortalRec,
  DOC_COLUMNS,
  type PortalDocRow,
  type StoredBooksDetails,
  type StoredPortalDetails,
} from './store.ts';
import { periodLabel, type ResolvedPeriod } from './values.ts';

const HEAD_KEYS = ['igst', 'cgst', 'sgst', 'cess'] as const;

const zeroHeads = (): TaxHeads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const zeroTotals = (): TaxTotals => ({ count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 });
const headsTotal = (h: TaxHeads): number => h.igst + h.cgst + h.sgst + h.cess;

function addTo(t: TaxTotals, v: { taxable: number; igst: number; cgst: number; sgst: number; cess: number }, sign: number): void {
  t.count++;
  t.taxable += sign * v.taxable;
  t.igst += sign * v.igst;
  t.cgst += sign * v.cgst;
  t.sgst += sign * v.sgst;
  t.cess += sign * v.cess;
  t.tax = t.igst + t.cgst + t.sgst + t.cess;
}

function fromTotals(t: Totals): TaxTotals {
  return { count: t.count, taxable: t.taxable, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess, tax: t.igst + t.cgst + t.sgst + t.cess };
}

/** Period for read routes: a GSTR-1 quarter as given, otherwise the range of the last run (or the month). */
export function readPeriod(db: Db, source: ReconSource, period: string): ResolvedPeriod {
  const rp = requirePeriod(period, source);
  return rp.quarter ? rp : periodOfLastRun(db, source, rp.key);
}

/** Rows of a period as stored by the last run (portal rows are 'pending' before the first run). */
export function periodRows(db: Db, source: ReconSource, period: string): ReconRow[] {
  return loadRows(db, source, period, latestBatch(db, source, period)?.id ?? null);
}

export function buildSummary(db: Db, source: ReconSource, rp: ResolvedPeriod): ReconSummary {
  const batch = latestBatch(db, source, rp.key);
  const run = latestRun(db, source, rp.key);
  const rows = loadRows(db, source, rp.key, batch?.id ?? null);

  const byStatus = new Map<ReconStatus, ReconStatusTotals>();
  for (const s of RECON_STATUSES) byStatus.set(s, { status: s, label: RECON_STATUS_LABELS[s], ...zeroTotals() });
  const portal = zeroTotals();
  const portalItc = zeroTotals();
  const atRisk = { missingInPortal: zeroHeads(), excessInBooks: zeroHeads(), itcNotAvailable: zeroHeads() };
  const notBooked = { missingInBooks: zeroHeads(), shortInBooks: zeroHeads() };
  let otherPeriodCount = 0;
  let openCount = 0;
  let reconciled = 0;
  let portalCount = 0;

  for (const r of rows) {
    const t = byStatus.get(r.status) as ReconStatusTotals;
    if (isOpenStatus(r.status)) openCount++;
    if (r.kind === 'portal' && r.portal) {
      const p = r.portal;
      const sign = rowSign(p.docType);
      portalCount++;
      if (r.status === 'matched' || r.status === 'accepted') reconciled++;
      addTo(t, p, sign);
      addTo(portal, p, sign);
      if (p.itcAvailable !== false) addTo(portalItc, p, sign);
      const inc = classOf(p.docType) === 'inc';
      if (r.status === 'missing_in_books' && inc && p.itcAvailable !== false) {
        for (const h of HEAD_KEYS) notBooked.missingInBooks[h] += p[h];
      }
      const b = r.books;
      if (b && inc && (r.status === 'matched' || r.status === 'partial' || r.status === 'duplicate')) {
        if (p.itcAvailable === false) {
          for (const h of HEAD_KEYS) atRisk.itcNotAvailable[h] += b.itc[h];
        } else if (r.status !== 'matched') {
          for (const h of HEAD_KEYS) {
            atRisk.excessInBooks[h] += Math.max(0, b.itc[h] - p[h]);
            notBooked.shortInBooks[h] += Math.max(0, p[h] - b.itc[h]);
          }
        }
      }
    } else if (r.books) {
      const b = r.books;
      addTo(t, b, rowSign(b.docType));
      if (r.otherPeriod && r.status === 'missing_in_portal') otherPeriodCount++;
      if (r.status === 'missing_in_portal' && classOf(b.docType) === 'inc') {
        for (const h of HEAD_KEYS) atRisk.missingInPortal[h] += b.itc[h];
      }
    }
  }

  const stored = run?.summary ?? null;
  const books = stored ? fromTotals(stored.books) : null;
  const booksItc = stored ? fromTotals(stored.booksEligible) : null;
  const difference: ReconDifference | null = booksItc
    ? {
        taxable: portalItc.taxable - booksItc.taxable,
        igst: portalItc.igst - booksItc.igst,
        cgst: portalItc.cgst - booksItc.cgst,
        sgst: portalItc.sgst - booksItc.sgst,
        cess: portalItc.cess - booksItc.cess,
        tax: portalItc.tax - booksItc.tax,
      }
    : null;

  let staleReason: string | null = null;
  if (run && batch) {
    if (run.batchId !== batch.id || batch.importedAt > run.runAt) staleReason = 'A new file was imported after the last run.';
    else {
      const changed = lastVoucherChange(db, sideOf(source));
      if (changed && changed > run.runAt) staleReason = 'Vouchers were entered or altered after the last run.';
      else if (rows.some((r) => r.kind === 'portal' && r.books && r.status !== 'missing_in_books' && !voucherExists(db, r.books.voucherId))) {
        staleReason = 'A matched voucher was deleted after the last run.';
      } else if (stored && rows.filter((r) => r.kind === 'books').length !== stored.booksOnly) {
        staleReason = 'A voucher missing on the portal was deleted after the last run.';
      }
    }
  } else if (batch && !run) staleReason = 'The file has not been reconciled yet.';

  const warnings = [...(batch?.meta.warnings ?? [])];
  const skipped = Object.entries(batch?.meta.skipped ?? {});
  if (skipped.length > 0) warnings.push(`Not reconciled (no matching books register): ${skipped.map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  const statuses = RECON_STATUSES.map((s) => byStatus.get(s) as ReconStatusTotals).filter((s) => s.count > 0 || s.status !== 'pending');

  return {
    source,
    sourceLabel: RECON_SOURCE_LABELS[source],
    period: rp.key,
    periodLabel: rp.quarter ? `${periodLabel(rp.from.slice(5, 7) + rp.from.slice(0, 4))} – ${periodLabel(rp.key)}` : periodLabel(rp.key),
    from: rp.from,
    to: rp.to,
    batch: batch ? { id: batch.id, fileName: batch.fileName, importedAt: batch.importedAt, docCount: batch.meta.docCount } : null,
    run: run
      ? { id: run.id, source, period: run.period, runAt: run.runAt, by: run.username, tolerance: run.tolerance, from: run.from, to: run.to, counts: run.summary.counts }
      : null,
    stale: staleReason !== null,
    staleReason,
    statuses,
    portal,
    portalItc,
    books,
    booksItc,
    difference,
    itcAtRisk: {
      ...atRisk,
      total: headsTotal(atRisk.missingInPortal) + headsTotal(atRisk.excessInBooks) + headsTotal(atRisk.itcNotAvailable),
    },
    itcNotBooked: { ...notBooked, total: headsTotal(notBooked.missingInBooks) + headsTotal(notBooked.shortInBooks) },
    otherPeriodCount,
    openCount,
    reconciledPct: portalCount === 0 ? 0 : Math.round((1000 * reconciled) / portalCount) / 10,
    warnings,
  };
}

function voucherExists(db: Db, id: number): boolean {
  return db.value<number>('SELECT 1 FROM vouchers WHERE id = :id', { id }) === 1;
}

export function getSummary(db: Db, input: { period: string; source: ReconSource }): ReconSummary {
  return buildSummary(db, input.source, readPeriod(db, input.source, input.period));
}

// ───────────────────────────── Results ─────────────────────────────

function matchesStatus(r: ReconRow, filter: string | undefined): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'open') return isOpenStatus(r.status);
  if (filter === 'other_period') return r.kind === 'books' && r.otherPeriod !== null;
  return r.status === filter;
}

function matchesSearch(r: ReconRow, q: string): boolean {
  const hay = [r.gstin, r.name, r.portal?.docNo, r.books?.docNo, r.books?.voucherNumber, r.books?.partyName, r.remarks]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join('\u0001')
    .toLowerCase();
  return hay.includes(q);
}

export function getResults(db: Db, input: ReconResultsInput): ReconResultsPage {
  const rp = readPeriod(db, input.source, input.period);
  let rows = periodRows(db, input.source, rp.key);
  if (input.supplierGstin) {
    const g = normalizeGstin(input.supplierGstin);
    rows = rows.filter((r) => r.gstin === g);
  }
  const counts: Partial<Record<ReconStatus, number>> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const q = input.search?.trim().toLowerCase() ?? '';
  const filtered = rows.filter((r) => matchesStatus(r, input.status) && (q === '' || matchesSearch(r, q)));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 200;
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length, counts };
}

// ───────────────────────────── Supplier-wise ─────────────────────────────

export function getSupplierSummary(db: Db, input: { period: string; source: ReconSource }): SupplierReconRow[] {
  const rp = readPeriod(db, input.source, input.period);
  const by = new Map<string, SupplierReconRow>();
  for (const r of periodRows(db, input.source, rp.key)) {
    let s = by.get(r.gstin);
    if (!s) {
      s = { gstin: r.gstin, name: null, portalCount: 0, booksCount: 0, counts: {}, openCount: 0, portalTaxable: 0, portalTax: 0, booksTaxable: 0, booksTax: 0, taxDifference: 0, taxableDifference: 0 };
      by.set(r.gstin, s);
    }
    s.name = s.name ?? r.portal?.name ?? r.books?.partyName ?? null;
    s.counts[r.status] = (s.counts[r.status] ?? 0) + 1;
    if (isOpenStatus(r.status)) s.openCount++;
    if (r.portal) {
      const sign = rowSign(r.portal.docType);
      s.portalCount++;
      s.portalTaxable += sign * r.portal.taxable;
      s.portalTax += sign * r.portal.tax;
    }
    if (r.books) {
      const sign = rowSign(r.books.docType);
      s.booksCount++;
      s.booksTaxable += sign * r.books.taxable;
      s.booksTax += sign * r.books.tax;
    }
  }
  const out = [...by.values()];
  for (const s of out) {
    s.taxDifference = s.portalTax - s.booksTax;
    s.taxableDifference = s.portalTaxable - s.booksTaxable;
  }
  return out.sort((a, b) => b.openCount - a.openCount || Math.abs(b.taxDifference) - Math.abs(a.taxDifference) || a.gstin.localeCompare(b.gstin));
}

// ───────────────────────────── Suggestions ─────────────────────────────

/** Probable matches for a portal row (vouchers) or a books-only row (portal documents), best first. */
export function getSuggestions(db: Db, today: string, input: ReconSuggestionsInput): ReconSuggestion[] {
  if (input.portalDocId !== undefined) {
    const doc = getDocRow(db, input.portalDocId);
    if (!doc) throw notFound('Portal document', input.portalDocId);
    const source = doc.source as ReconSource;
    const run = latestRun(db, source, doc.return_period);
    const rp = periodOfLastRun(db, source, doc.return_period);
    const tol = run?.tolerance ?? { amountPaise: 100, dateDays: 0, fuzzyDocNo: true };
    // Vouchers already paired with other documents of this batch are not candidates.
    const taken = new Set<number>();
    for (const r of db.all<{ id: number; matched_voucher_id: number | null; match_details: string | null }>(
      'SELECT id, matched_voucher_id, match_details FROM gst_portal_docs WHERE batch_id = :batch',
      { batch: doc.batch_id },
    )) {
      if (r.id === doc.id) continue;
      if (r.matched_voucher_id !== null) taken.add(r.matched_voucher_id);
      const det = r.match_details ? (JSON.parse(r.match_details) as StoredPortalDetails) : null;
      for (const v of det?.duplicateVoucherIds ?? []) taken.add(v);
    }
    const p = toPortalRec(doc);
    const books = loadBooksDocs(db, { side: sideOf(source), from: addDays(rp.from, -OTHER_PERIOD_WINDOW_DAYS), to: addDays(rp.to, OTHER_PERIOD_WINDOW_DAYS), today });
    const out: ReconSuggestion[] = [];
    for (const b of books) {
      if (taken.has(b.voucherId) || b.voucherId === doc.matched_voucher_id || b.gstin !== p.gstin || b.cls !== classOf(p.docType)) continue;
      const rec: BooksRec = { ...b, inRange: b.docDate >= rp.from && b.docDate <= rp.to };
      const s = suggestionScore(p, rec, tol);
      if (!s) continue;
      out.push({
        voucherId: b.voucherId,
        portalDocId: null,
        docNo: b.docNo,
        docDate: b.docDate,
        voucherNumber: b.number,
        gstin: b.gstin,
        name: b.partyName,
        taxable: b.taxable,
        tax: b.igst + b.cgst + b.sgst + b.cess,
        score: s.score,
        reasons: s.reasons,
      });
    }
    return out.sort((a, b) => b.score - a.score || a.docDate.localeCompare(b.docDate) || (a.voucherId ?? 0) - (b.voucherId ?? 0)).slice(0, 10);
  }

  if (input.voucherId === undefined) throw validation([{ path: 'portalDocId', message: 'Choose a portal document or a voucher' }]);
  if (!input.period || !input.source) throw validation([{ path: 'period', message: 'The period and source are required with a voucher' }]);
  const source = input.source;
  const rp = readPeriod(db, source, input.period);
  const row = booksOnlyRows(db, source, rp.key).find((r) => r.voucher_id === input.voucherId);
  if (!row) throw notFound(`"Missing in portal" row for voucher`, input.voucherId);
  const det = JSON.parse(row.details) as StoredBooksDetails;
  const run = latestRun(db, source, rp.key);
  const tol = run?.tolerance ?? { amountPaise: 100, dateDays: 0, fuzzyDocNo: true };
  const bv = det.books;
  const rec: BooksRec = {
    voucherId: bv.voucherId,
    baseType: bv.baseType,
    voucherTypeName: bv.voucherType,
    number: bv.voucherNumber,
    voucherDate: bv.voucherDate,
    docNo: bv.docNo,
    docNoBasis: bv.docNoBasis,
    docDate: bv.docDate,
    dateBasis: bv.dateBasis,
    gstin: bv.gstin,
    gstinFromLedger: bv.gstinFromLedger,
    partyLedgerId: bv.partyLedgerId,
    partyName: bv.partyName,
    pos: bv.pos,
    reverseCharge: bv.reverseCharge,
    cls: classOf(bv.docType),
    docType: bv.docType,
    nature: null,
    taxable: bv.taxable,
    igst: bv.igst,
    cgst: bv.cgst,
    sgst: bv.sgst,
    cess: bv.cess,
    eligible: { ...bv.itc },
    invoiceValue: bv.invoiceValue,
    rates: bv.rates,
    period: bv.period,
    updatedAt: '',
    inRange: true,
  };
  const batch = latestBatch(db, source, rp.key);
  if (!batch) return [];
  const out: ReconSuggestion[] = [];
  for (const d of db.all<PortalDocRow>(
    `SELECT ${DOC_COLUMNS} FROM gst_portal_docs
      WHERE batch_id = :batch AND match_status IN ('missing_in_books', 'pending') AND counterparty_gstin = :gstin ORDER BY id`,
    { batch: batch.id, gstin: rec.gstin },
  )) {
    const p = toPortalRec(d);
    if (classOf(p.docType) !== rec.cls) continue;
    const s = suggestionScore(p, rec, tol);
    if (!s) continue;
    out.push({
      voucherId: null,
      portalDocId: p.id,
      docNo: p.docNo,
      docDate: p.docDate,
      voucherNumber: null,
      gstin: p.gstin,
      name: d.counterparty_name,
      taxable: p.taxable,
      tax: p.igst + p.cgst + p.sgst + p.cess,
      score: s.score,
      reasons: s.reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.docDate.localeCompare(b.docDate) || (a.portalDocId ?? 0) - (b.portalDocId ?? 0)).slice(0, 10);
}
