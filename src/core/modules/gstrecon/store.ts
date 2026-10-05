/**
 * Persistence helpers for the reconciliation tables: import batches, portal documents, run history,
 * books-only rows and decisions, and their mapping to DTOs. Every query is parameterised.
 */
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type {
  BooksDocView,
  DiffField,
  FieldDiff,
  MatchMethod,
  PortalDocType,
  PortalDocView,
  PortalFileFormat,
  PortalSection,
  ReconBaseStatus,
  ReconRow,
  ReconSource,
  ReconStatus,
  ReconTolerance,
  TaxTotals,
} from '../../../shared/types/gstrecon.ts';
import { DEFAULT_RECON_TOLERANCE } from '../../../shared/types/gstrecon.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import type { BooksRec, Decision, PortalRec, Totals } from './matcher.ts';
import { classOf } from './matcher.ts';
import { periodLabel, resolveReconPeriod, type ResolvedPeriod } from './values.ts';

// ───────────────────────────── Company & periods ─────────────────────────────

export interface CompanyInfo {
  name: string;
  gstin: string | null;
  stateCode: string | null;
}

export function companyInfo(db: Db): CompanyInfo {
  const r = db.get<{ name: string; gstin: string | null; state_code: string | null }>('SELECT name, gstin, state_code FROM company WHERE id = 1');
  return { name: r?.name ?? '', gstin: r?.gstin ? normalizeGstin(r.gstin) : null, stateCode: r?.state_code ?? null };
}

export const sideOf = (source: ReconSource): 'inward' | 'outward' => (source === 'gstr1' ? 'outward' : 'inward');

/** Resolve the period input or throw VALIDATION on `period`. */
export function requirePeriod(period: string, source: ReconSource): ResolvedPeriod {
  const r = resolveReconPeriod(period, source === 'gstr1');
  if (!r) {
    throw validation([
      {
        path: 'period',
        message:
          source === 'gstr1'
            ? `"${period}" is not a return period. Use MMYYYY such as 042026 (April 2026) or a quarter such as 2026-27-Q1.`
            : `"${period}" is not a return period. Use MMYYYY, for example 042026 for April 2026.`,
      },
    ]);
  }
  return r;
}

// ───────────────────────────── Import batches ─────────────────────────────

export interface BatchMeta {
  v: 1;
  source: ReconSource;
  period: string;
  format: PortalFileFormat;
  gstin: string | null;
  docCount: number;
  sections: Record<string, number>;
  skipped: Record<string, number>;
  totals: TaxTotals;
  warnings: string[];
  sha256: string;
  generatedOn: string | null;
  importedBy: string | null;
}

export interface BatchRec {
  id: number;
  kind: ReconSource;
  fileName: string | null;
  importedAt: string;
  userId: number | null;
  meta: BatchMeta;
}

interface BatchRow {
  id: number;
  kind: string;
  file_name: string | null;
  imported_at: string;
  user_id: number | null;
  meta: string | null;
}

export const RECON_KINDS = ['gstr2b', 'gstr2a', 'gstr1'] as const;

function toBatch(r: BatchRow): BatchRec {
  return { id: r.id, kind: r.kind as ReconSource, fileName: r.file_name, importedAt: r.imported_at, userId: r.user_id, meta: JSON.parse(r.meta ?? '{}') as BatchMeta };
}

export function batchesFor(db: Db, source: ReconSource, period: string): BatchRec[] {
  return db
    .all<BatchRow>(
      `SELECT id, kind, file_name, imported_at, user_id, meta FROM import_batches
        WHERE kind = :source AND json_extract(meta, '$.period') = :period ORDER BY id DESC`,
      { source, period },
    )
    .map(toBatch);
}

export function latestBatch(db: Db, source: ReconSource, period: string): BatchRec | null {
  return batchesFor(db, source, period)[0] ?? null;
}

export function getBatch(db: Db, id: number): BatchRec | null {
  const r = db.get<BatchRow>(
    `SELECT id, kind, file_name, imported_at, user_id, meta FROM import_batches WHERE id = :id AND kind IN ('gstr2b', 'gstr2a', 'gstr1')`,
    { id },
  );
  return r ? toBatch(r) : null;
}

export function listBatchRecs(db: Db, filter: { period?: string; source?: ReconSource }): BatchRec[] {
  return db
    .all<BatchRow>(
      `SELECT id, kind, file_name, imported_at, user_id, meta FROM import_batches
        WHERE kind IN ('gstr2b', 'gstr2a', 'gstr1')
          AND (:period IS NULL OR json_extract(meta, '$.period') = :period)
          AND (:source IS NULL OR kind = :source)
        ORDER BY substr(json_extract(meta, '$.period'), 3, 4) DESC, substr(json_extract(meta, '$.period'), 1, 2) DESC, kind, id DESC`,
      { period: filter.period ?? null, source: filter.source ?? null },
    )
    .map(toBatch);
}

// ───────────────────────────── Portal documents ─────────────────────────────

export interface PortalDocMeta {
  rates: number[];
  itcReason: string | null;
  invoiceType: string | null;
  original: { docNo: string; docDate: string | null } | null;
  applicablePct: number | null;
  irn: string | null;
  irnDate: string | null;
  sourceType: string | null;
}

export interface PortalDocRow {
  id: number;
  batch_id: number;
  source: string;
  return_period: string;
  counterparty_gstin: string;
  counterparty_name: string | null;
  doc_type: string;
  doc_no: string;
  doc_date: string;
  place_of_supply: string | null;
  is_reverse_charge: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoice_value: number;
  itc_available: number | null;
  filing_status: string | null;
  match_status: string;
  matched_voucher_id: number | null;
  match_details: string | null;
  remarks: string | null;
  section: string | null;
  doc_key: string | null;
  supplier_period: string | null;
  filing_date: string | null;
  meta: string | null;
}

export const DOC_COLUMNS = `id, batch_id, source, return_period, counterparty_gstin, counterparty_name, doc_type, doc_no, doc_date,
  place_of_supply, is_reverse_charge, taxable_value, igst, cgst, sgst, cess, invoice_value, itc_available, filing_status,
  match_status, matched_voucher_id, match_details, remarks, section, doc_key, supplier_period, filing_date, meta`;

export function docsOfBatch(db: Db, batchId: number): PortalDocRow[] {
  return db.all<PortalDocRow>(`SELECT ${DOC_COLUMNS} FROM gst_portal_docs WHERE batch_id = :batchId ORDER BY id`, { batchId });
}

export function getDocRow(db: Db, id: number): PortalDocRow | null {
  return db.get<PortalDocRow>(`SELECT ${DOC_COLUMNS} FROM gst_portal_docs WHERE id = :id`, { id }) ?? null;
}

function parseMeta(s: string | null): PortalDocMeta {
  const m = (s ? JSON.parse(s) : {}) as Partial<PortalDocMeta>;
  return {
    rates: m.rates ?? [],
    itcReason: m.itcReason ?? null,
    invoiceType: m.invoiceType ?? null,
    original: m.original ?? null,
    applicablePct: m.applicablePct ?? null,
    irn: m.irn ?? null,
    irnDate: m.irnDate ?? null,
    sourceType: m.sourceType ?? null,
  };
}

export function toPortalView(r: PortalDocRow): PortalDocView {
  const meta = parseMeta(r.meta);
  return {
    id: r.id,
    section: (r.section as PortalSection | null) ?? null,
    gstin: r.counterparty_gstin,
    name: r.counterparty_name,
    docType: r.doc_type as PortalDocType,
    docNo: r.doc_no,
    docDate: r.doc_date,
    pos: r.place_of_supply,
    reverseCharge: r.is_reverse_charge === 1,
    taxable: r.taxable_value,
    igst: r.igst,
    cgst: r.cgst,
    sgst: r.sgst,
    cess: r.cess,
    tax: r.igst + r.cgst + r.sgst + r.cess,
    invoiceValue: r.invoice_value,
    rates: meta.rates,
    itcAvailable: r.itc_available === null ? null : r.itc_available === 1,
    itcReason: meta.itcReason,
    supplierPeriod: r.supplier_period,
    filingDate: r.filing_date,
    filingStatus: r.filing_status,
    invoiceType: meta.invoiceType,
    original: meta.original,
    applicablePct: meta.applicablePct,
  };
}

/** Matcher input from a stored portal document. */
export function toPortalRec(r: PortalDocRow): PortalRec {
  const meta = parseMeta(r.meta);
  return {
    id: r.id,
    gstin: r.counterparty_gstin,
    docType: r.doc_type as PortalDocType,
    docNo: r.doc_no,
    docDate: r.doc_date,
    pos: r.place_of_supply,
    reverseCharge: r.is_reverse_charge === 1,
    taxable: r.taxable_value,
    igst: r.igst,
    cgst: r.cgst,
    sgst: r.sgst,
    cess: r.cess,
    invoiceValue: r.invoice_value,
    rates: meta.rates,
    itcAvailable: r.itc_available === null ? null : r.itc_available === 1,
  };
}

// ───────────────────────────── Stored results ─────────────────────────────

/** gst_portal_docs.match_details */
export interface StoredPortalDetails {
  v: 1;
  baseStatus: ReconBaseStatus;
  method: MatchMethod | null;
  manual: boolean;
  books: BooksDocView | null;
  diffs: FieldDiff[];
  duplicateVoucherIds: number[];
  duplicateOfDocId: number | null;
  suggestionCount: number;
  notes: string[];
}

/** gstrecon_books_only.details */
export interface StoredBooksDetails {
  v: 1;
  books: BooksDocView;
  otherPeriod: string | null;
  otherPeriodDocId: number | null;
  duplicateVoucherIds: number[];
  suggestionCount: number;
  notes: string[];
  remarks: string | null;
}

export interface BooksOnlyRow {
  id: number;
  source: string;
  return_period: string;
  voucher_id: number;
  status: string;
  details: string;
}

export function booksOnlyRows(db: Db, source: ReconSource, period: string): BooksOnlyRow[] {
  return db.all<BooksOnlyRow>(
    'SELECT id, source, return_period, voucher_id, status, details FROM gstrecon_books_only WHERE source = :source AND return_period = :period ORDER BY id',
    { source, period },
  );
}

export function toBooksView(b: BooksRec): BooksDocView {
  return {
    voucherId: b.voucherId,
    voucherNumber: b.number,
    voucherType: b.voucherTypeName,
    baseType: b.baseType,
    docNo: b.docNo,
    docNoBasis: b.docNoBasis,
    docDate: b.docDate,
    dateBasis: b.dateBasis,
    voucherDate: b.voucherDate,
    partyLedgerId: b.partyLedgerId,
    partyName: b.partyName,
    gstin: b.gstin,
    gstinFromLedger: b.gstinFromLedger,
    pos: b.pos,
    reverseCharge: b.reverseCharge,
    docType: b.docType,
    taxable: b.taxable,
    igst: b.igst,
    cgst: b.cgst,
    sgst: b.sgst,
    cess: b.cess,
    tax: b.igst + b.cgst + b.sgst + b.cess,
    eligibleTax: b.eligible.igst + b.eligible.cgst + b.eligible.sgst + b.eligible.cess,
    itc: { ...b.eligible },
    invoiceValue: b.invoiceValue,
    rates: b.rates,
    period: b.period,
    inPeriod: b.inRange,
  };
}

const OPEN: ReadonlySet<ReconStatus> = new Set(['partial', 'missing_in_books', 'missing_in_portal', 'duplicate']);
export const isOpenStatus = (s: ReconStatus): boolean => OPEN.has(s);

/** All rows of a period: portal documents of the batch, then vouchers missing on the portal. */
export function loadRows(db: Db, source: ReconSource, period: string, batchId: number | null): ReconRow[] {
  const rows: ReconRow[] = [];
  if (batchId !== null) {
    for (const r of docsOfBatch(db, batchId)) {
      const portal = toPortalView(r);
      const det = r.match_details ? (JSON.parse(r.match_details) as StoredPortalDetails) : null;
      const books = det?.books ?? null;
      const status = r.match_status as ReconStatus;
      rows.push({
        kind: 'portal',
        key: `p${r.id}`,
        portalDocId: r.id,
        voucherId: books ? books.voucherId : null,
        status,
        baseStatus: det?.baseStatus ?? (status === 'accepted' || status === 'ignored' ? 'pending' : status),
        gstin: portal.gstin,
        name: portal.name ?? books?.partyName ?? null,
        docType: portal.docType,
        portal,
        books,
        diffs: det?.diffs ?? [],
        difference: books
          ? {
              taxable: portal.taxable - books.taxable,
              igst: portal.igst - books.igst,
              cgst: portal.cgst - books.cgst,
              sgst: portal.sgst - books.sgst,
              cess: portal.cess - books.cess,
              tax: portal.tax - books.tax,
            }
          : null,
        method: det?.method ?? null,
        manual: det?.manual ?? false,
        otherPeriod: null,
        duplicateVoucherIds: det?.duplicateVoucherIds ?? [],
        duplicateOfDocId: det?.duplicateOfDocId ?? null,
        suggestionCount: det?.suggestionCount ?? 0,
        notes: det?.notes ?? [],
        remarks: r.remarks,
      });
    }
  }
  for (const r of booksOnlyRows(db, source, period)) {
    const det = JSON.parse(r.details) as StoredBooksDetails;
    rows.push({
      kind: 'books',
      key: `b${r.voucher_id}`,
      portalDocId: null,
      voucherId: r.voucher_id,
      status: r.status as ReconStatus,
      baseStatus: 'missing_in_portal',
      gstin: det.books.gstin,
      name: det.books.partyName,
      docType: det.books.docType,
      portal: null,
      books: det.books,
      diffs: [],
      difference: null,
      method: null,
      manual: false,
      otherPeriod: det.otherPeriod,
      duplicateVoucherIds: det.duplicateVoucherIds,
      duplicateOfDocId: null,
      suggestionCount: det.suggestionCount,
      notes: det.notes,
      remarks: det.remarks,
    });
  }
  rows.sort(
    (a, b) =>
      a.gstin.localeCompare(b.gstin) ||
      (a.portal?.docDate ?? a.books?.docDate ?? '').localeCompare(b.portal?.docDate ?? b.books?.docDate ?? '') ||
      (a.portal?.docNo ?? a.books?.docNo ?? '').localeCompare(b.portal?.docNo ?? b.books?.docNo ?? '', 'en', { numeric: true }) ||
      a.key.localeCompare(b.key),
  );
  return rows;
}

/** Sign of a row's values in totals: credit notes (portal) / purchase returns (books) reduce. */
export const rowSign = (docType: PortalDocType): number => (classOf(docType) === 'dec' ? -1 : 1);

// ───────────────────────────── Runs ─────────────────────────────

export interface StoredRunSummary {
  v: 1;
  counts: Partial<Record<ReconStatus, number>>;
  books: Totals;
  booksEligible: Totals;
  /** Number of books-only rows written by the run. */
  booksOnly: number;
  batchId: number | null;
}

export interface RunRec {
  id: number;
  source: ReconSource;
  period: string;
  batchId: number | null;
  runAt: string;
  userId: number | null;
  username: string | null;
  from: string;
  to: string;
  tolerance: ReconTolerance;
  summary: StoredRunSummary;
}

interface RunRow {
  id: number;
  source: string;
  return_period: string;
  batch_id: number | null;
  run_at: string;
  user_id: number | null;
  username: string | null;
  date_from: string;
  date_to: string;
  tolerance: string;
  summary: string;
}

function toRun(r: RunRow): RunRec {
  return {
    id: r.id,
    source: r.source as ReconSource,
    period: r.return_period,
    batchId: r.batch_id,
    runAt: r.run_at,
    userId: r.user_id,
    username: r.username,
    from: r.date_from,
    to: r.date_to,
    tolerance: { ...DEFAULT_RECON_TOLERANCE, ...(JSON.parse(r.tolerance) as Partial<ReconTolerance>) },
    summary: JSON.parse(r.summary) as StoredRunSummary,
  };
}

export function latestRun(db: Db, source: ReconSource, period: string): RunRec | null {
  const r = db.get<RunRow>('SELECT * FROM gstrecon_runs WHERE source = :source AND return_period = :period ORDER BY id DESC LIMIT 1', { source, period });
  return r ? toRun(r) : null;
}

export function listRuns(db: Db, source: ReconSource, period: string, limit = 20): RunRec[] {
  return db
    .all<RunRow>('SELECT * FROM gstrecon_runs WHERE source = :source AND return_period = :period ORDER BY id DESC LIMIT :limit', { source, period, limit })
    .map(toRun);
}

/** Resolved period of the last run (keeps a GSTR-1 quarter range), else the month. */
export function periodOfLastRun(db: Db, source: ReconSource, period: string): ResolvedPeriod {
  const run = latestRun(db, source, period);
  const month = requirePeriod(period, source);
  if (!run) return month;
  return { key: period, from: run.from, to: run.to, label: run.from === month.from && run.to === month.to ? periodLabel(period) : month.label, quarter: run.from !== month.from };
}

// ───────────────────────────── Decisions ─────────────────────────────

interface DecisionRow {
  id: number;
  doc_key: string | null;
  voucher_id: number | null;
  link_voucher_id: number | null;
  resolution: string | null;
  remarks: string | null;
}

export function loadDecisions(db: Db, source: ReconSource, period: string): Decision[] {
  return db
    .all<DecisionRow>(
      'SELECT id, doc_key, voucher_id, link_voucher_id, resolution, remarks FROM gstrecon_decisions WHERE source = :source AND return_period = :period ORDER BY id',
      { source, period },
    )
    .map((d) => ({
      docKey: d.doc_key,
      voucherId: d.voucher_id,
      linkVoucherId: d.link_voucher_id,
      resolution: d.resolution === 'accept' || d.resolution === 'ignore' ? d.resolution : null,
      remarks: d.remarks,
    }));
}

export interface DecisionTarget {
  source: ReconSource;
  period: string;
  docKey: string | null;
  voucherId: number | null;
}

export function getDecision(db: Db, t: DecisionTarget): (Decision & { id: number }) | null {
  const r =
    t.docKey !== null
      ? db.get<DecisionRow>(
          'SELECT id, doc_key, voucher_id, link_voucher_id, resolution, remarks FROM gstrecon_decisions WHERE source = :source AND return_period = :period AND doc_key = :key',
          { source: t.source, period: t.period, key: t.docKey },
        )
      : db.get<DecisionRow>(
          'SELECT id, doc_key, voucher_id, link_voucher_id, resolution, remarks FROM gstrecon_decisions WHERE source = :source AND return_period = :period AND doc_key IS NULL AND voucher_id = :vid',
          { source: t.source, period: t.period, vid: t.voucherId },
        );
  if (!r) return null;
  return {
    id: r.id,
    docKey: r.doc_key,
    voucherId: r.voucher_id,
    linkVoucherId: r.link_voucher_id,
    resolution: r.resolution === 'accept' || r.resolution === 'ignore' ? r.resolution : null,
    remarks: r.remarks,
  };
}

/** Insert or update the decision of a portal document (docKey) or books-only voucher. */
export function upsertDecision(
  db: Db,
  t: DecisionTarget,
  patch: { linkVoucherId?: number | null; resolution?: 'accept' | 'ignore' | null; remarks?: string | null },
  who: { userId: number | null; username: string | null; at: string },
): void {
  const cur = getDecision(db, t);
  const link = patch.linkVoucherId !== undefined ? patch.linkVoucherId : (cur?.linkVoucherId ?? null);
  const resolution = patch.resolution !== undefined ? patch.resolution : (cur?.resolution ?? null);
  const remarks = patch.remarks !== undefined ? patch.remarks : (cur?.remarks ?? null);
  if (cur) {
    if (link === null && resolution === null) {
      db.run('DELETE FROM gstrecon_decisions WHERE id = :id', { id: cur.id });
      return;
    }
    db.run(
      `UPDATE gstrecon_decisions SET link_voucher_id = :link, resolution = :resolution, remarks = :remarks,
              user_id = :uid, username = :uname, updated_at = :at WHERE id = :id`,
      { id: cur.id, link, resolution, remarks, uid: who.userId, uname: who.username, at: who.at },
    );
    return;
  }
  if (link === null && resolution === null) return;
  db.run(
    `INSERT INTO gstrecon_decisions (source, return_period, doc_key, voucher_id, link_voucher_id, resolution, remarks, user_id, username, updated_at)
     VALUES (:source, :period, :key, :vid, :link, :resolution, :remarks, :uid, :uname, :at)`,
    {
      source: t.source,
      period: t.period,
      key: t.docKey,
      vid: t.docKey === null ? t.voucherId : null,
      link,
      resolution,
      remarks,
      uid: who.userId,
      uname: who.username,
      at: who.at,
    },
  );
}

export function deleteDecision(db: Db, t: DecisionTarget): boolean {
  const cur = getDecision(db, t);
  if (!cur) return false;
  db.run('DELETE FROM gstrecon_decisions WHERE id = :id', { id: cur.id });
  return true;
}

export const DIFF_FIELDS: readonly DiffField[] = [
  'taxable',
  'igst',
  'cgst',
  'sgst',
  'cess',
  'date',
  'pos',
  'rate',
  'reverse_charge',
  'itc',
  'doc_type',
  'doc_no',
  'invoice_value',
  'gstin',
  'books_period',
];
