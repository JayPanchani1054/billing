/**
 * gstrecon services: import portal files, run the reconciliation, record manual decisions.
 * Queries (summary, results, supplier-wise, suggestions) are in queries.ts; exports in export.ts.
 */
import { createHash } from 'node:crypto';
import { addDays } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type {
  ImportBatchView,
  ReconDecisionInput,
  ReconDecisionResult,
  ReconImportConflict,
  ReconImportInput,
  ReconImportResult,
  ReconRow,
  ReconRunInput,
  ReconRunView,
  ReconSource,
  ReconStatus,
  ReconSummary,
  ReconTolerance,
  TaxTotals,
} from '../../../shared/types/gstrecon.ts';
import { DEFAULT_RECON_TOLERANCE, RECON_SOURCE_LABELS } from '../../../shared/types/gstrecon.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, conflict, notFound, rule, validation } from '../../lib/errors.ts';
import { loadBooksDocs } from './books.ts';
import { classOf, OTHER_PERIOD_WINDOW_DAYS, portalDocKey, reconcile, type BooksRec, type OtherPeriodDoc, type PortalRec } from './matcher.ts';
import { parsePortalFile } from './parsers.ts';
import { buildSummary } from './queries.ts';
import {
  batchesFor,
  companyInfo,
  deleteDecision,
  docsOfBatch,
  getBatch,
  getDecision,
  getDocRow,
  isOpenStatus,
  latestBatch,
  latestRun,
  listBatchRecs,
  listRuns,
  loadDecisions,
  loadRows,
  periodOfLastRun,
  requirePeriod,
  sideOf,
  toBooksView,
  toPortalRec,
  upsertDecision,
  type BatchMeta,
  type BatchRec,
  type PortalDocRow,
  type StoredBooksDetails,
  type StoredPortalDetails,
  type StoredRunSummary,
} from './store.ts';
import { isMonthPeriod, periodLabel, periodShort, shiftPeriod, type ResolvedPeriod } from './values.ts';

const who = (ctx: CompanyCtx): { userId: number | null; username: string | null; at: string } => ({
  userId: ctx.session.userId,
  username: ctx.session.displayName || ctx.session.username,
  at: ctx.clock.now().toISOString(),
});

function emptyTaxTotals(): TaxTotals {
  return { count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 };
}

// ───────────────────────────── Import ─────────────────────────────

/**
 * Import a portal file as a new batch. Refuses a file of another GSTIN, another period or another return.
 * Re-importing the same source + period needs `replace: true` (otherwise CONFLICT with both counts);
 * the earlier batch and its results are removed, manual decisions are kept (they are keyed by document).
 */
export function importPortalFile(ctx: CompanyCtx, input: ReconImportInput): ReconImportResult {
  const db = ctx.db;
  const company = companyInfo(db);
  if (!company.gstin) {
    throw rule('The company has no GSTIN. Enter it in Company › Alter before importing GST portal files.');
  }
  const label = RECON_SOURCE_LABELS[input.source];
  const parsed = parsePortalFile(input.bytes, input.source);

  if (parsed.gstin && parsed.gstin !== company.gstin) {
    throw rule(
      `This ${label} belongs to GSTIN ${parsed.gstin}, but the open company's GSTIN is ${company.gstin}. Open the right company, or download the file for ${company.gstin} from the GST portal.`,
    );
  }
  const requested = input.period?.trim() || null;
  if (requested !== null && !isMonthPeriod(requested)) {
    throw validation([{ path: 'period', message: `"${requested}" is not a return period. Use MMYYYY, for example 042026 for April 2026.` }]);
  }
  if (requested && parsed.period && requested !== parsed.period) {
    throw validation([
      {
        path: 'period',
        message: `The file is the ${label} for ${periodLabel(parsed.period)} (${parsed.period}), but you chose ${periodLabel(requested)} (${requested}). Choose ${periodLabel(parsed.period)}, or pick the file for ${periodLabel(requested)}.`,
      },
    ]);
  }
  const period = requested ?? parsed.period;
  if (!period) {
    throw validation([{ path: 'period', message: `The file does not say which return period it is for. Choose the period (month) of this ${label}.` }]);
  }

  const totals = emptyTaxTotals();
  for (const d of parsed.docs) {
    const s = classOf(d.docType) === 'dec' ? -1 : 1;
    totals.count++;
    totals.taxable += s * d.taxable;
    totals.igst += s * d.igst;
    totals.cgst += s * d.cgst;
    totals.sgst += s * d.sgst;
    totals.cess += s * d.cess;
  }
  totals.tax = totals.igst + totals.cgst + totals.sgst + totals.cess;
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const at = ctx.clock.now().toISOString();
  const by = ctx.session.displayName || ctx.session.username;

  return db.transaction(() => {
    const existing = batchesFor(db, input.source, period);
    if (existing.length > 0 && !input.replace) {
      const e = existing[0];
      const details: ReconImportConflict = {
        existingBatchId: e.id,
        existingDocCount: e.meta.docCount,
        existingFileName: e.fileName,
        existingImportedAt: e.importedAt,
        newDocCount: parsed.docs.length,
        source: input.source,
        period,
      };
      throw conflict(
        `The ${label} for ${periodLabel(period)} was already imported on ${e.importedAt.slice(0, 10)} (${e.meta.docCount} documents${e.fileName ? `, ${e.fileName}` : ''}). This file has ${parsed.docs.length} documents. Import again with "Replace" to use the new file; your links, accepted and ignored documents are kept.`,
        details,
      );
    }
    let replacedBatchId: number | null = null;
    for (const e of existing) {
      removeBatch(db, e);
      replacedBatchId = replacedBatchId ?? e.id;
    }

    const meta: BatchMeta = {
      v: 1,
      source: input.source,
      period,
      format: parsed.format,
      gstin: parsed.gstin,
      docCount: parsed.docs.length,
      sections: parsed.sections,
      skipped: parsed.skipped,
      totals,
      warnings: parsed.warnings,
      sha256,
      generatedOn: parsed.generatedOn,
      importedBy: by,
    };
    const batchId = db.run('INSERT INTO import_batches (kind, file_name, imported_at, user_id, meta) VALUES (:kind, :file, :at, :uid, :meta)', {
      kind: input.source,
      file: input.fileName,
      at,
      uid: ctx.session.userId,
      meta: JSON.stringify(meta),
    }).lastInsertRowid;

    for (const d of parsed.docs) {
      db.run(
        `INSERT INTO gst_portal_docs (batch_id, source, return_period, counterparty_gstin, counterparty_name, doc_type, doc_no, doc_date,
           place_of_supply, is_reverse_charge, taxable_value, igst, cgst, sgst, cess, invoice_value, itc_available, filing_status, raw,
           match_status, section, doc_key, supplier_period, filing_date, meta)
         VALUES (:batch, :source, :period, :gstin, :name, :type, :no, :date, :pos, :rcm, :taxable, :igst, :cgst, :sgst, :cess, :value,
           :itc, :filing, :raw, 'pending', :section, :key, :sp, :fd, :meta)`,
        {
          batch: batchId,
          source: input.source,
          period,
          gstin: d.gstin,
          name: d.name,
          type: d.docType,
          no: d.docNo,
          date: d.docDate,
          pos: d.pos,
          rcm: d.reverseCharge,
          taxable: d.taxable,
          igst: d.igst,
          cgst: d.cgst,
          sgst: d.sgst,
          cess: d.cess,
          value: d.invoiceValue,
          itc: d.itcAvailable === null ? null : d.itcAvailable,
          filing: d.filingStatus,
          raw: JSON.stringify(d.raw),
          section: d.section,
          key: portalDocKey(d.gstin, d.docType, d.docNo),
          sp: d.supplierPeriod,
          fd: d.filingDate,
          meta: JSON.stringify({
            rates: d.rates,
            itcReason: d.itcReason,
            invoiceType: d.invoiceType,
            original: d.original,
            applicablePct: d.applicablePct,
            irn: d.irn,
            irnDate: d.irnDate,
            sourceType: d.sourceType,
          }),
        },
      );
    }
    ctx.audit({
      action: 'import',
      entityType: 'gst_import_batch',
      entityId: batchId,
      entityLabel: `${label} ${periodShort(period)} (${input.fileName})`,
      after: { source: input.source, period, fileName: input.fileName, docCount: parsed.docs.length, sha256, replacedBatchId },
    });
    return {
      batchId,
      source: input.source,
      period,
      periodLabel: periodLabel(period),
      format: parsed.format,
      docCount: parsed.docs.length,
      sections: parsed.sections,
      skipped: parsed.skipped,
      totals,
      warnings: parsed.warnings,
      replacedBatchId,
    };
  });
}

/** Delete a batch with its documents and results (decisions stay). */
function removeBatch(db: Db, b: BatchRec): number {
  const n = db.run('DELETE FROM gst_portal_docs WHERE batch_id = :id', { id: b.id }).changes;
  db.run('DELETE FROM gstrecon_books_only WHERE source = :source AND return_period = :period', { source: b.kind, period: b.meta.period });
  db.run('UPDATE gstrecon_runs SET batch_id = NULL WHERE batch_id = :id', { id: b.id });
  db.run('DELETE FROM import_batches WHERE id = :id', { id: b.id });
  return n;
}

export function listBatches(db: Db, filter: { period?: string; source?: ReconSource }): ImportBatchView[] {
  return listBatchRecs(db, filter).map((b) => {
    const run = latestRun(db, b.kind, b.meta.period);
    const counts = run && run.batchId === b.id ? run.summary.counts : null;
    const open = counts ? (['partial', 'missing_in_books', 'missing_in_portal', 'duplicate'] as ReconStatus[]).reduce((a, s) => a + (counts[s] ?? 0), 0) : null;
    return {
      id: b.id,
      source: b.kind,
      period: b.meta.period,
      periodLabel: periodLabel(b.meta.period),
      fileName: b.fileName,
      format: b.meta.format,
      importedAt: b.importedAt,
      importedBy: b.meta.importedBy,
      docCount: b.meta.docCount,
      totals: b.meta.totals,
      warnings: b.meta.warnings,
      skipped: b.meta.skipped,
      lastRunAt: run && run.batchId === b.id ? run.runAt : null,
      openCount: open,
    };
  });
}

export function deleteBatch(ctx: CompanyCtx, id: number): { id: number; deletedDocs: number } {
  const b = getBatch(ctx.db, id);
  if (!b) throw notFound('Import', id);
  const deleted = removeBatch(ctx.db, b);
  ctx.audit({
    action: 'delete',
    entityType: 'gst_import_batch',
    entityId: id,
    entityLabel: `${RECON_SOURCE_LABELS[b.kind]} ${periodShort(b.meta.period)} (${b.fileName ?? 'file'})`,
    before: { source: b.kind, period: b.meta.period, fileName: b.fileName, docCount: b.meta.docCount },
  });
  return { id, deletedDocs: deleted };
}

// ───────────────────────────── Run ─────────────────────────────

export function resolveTolerance(t: Partial<ReconTolerance> | undefined, base: ReconTolerance = DEFAULT_RECON_TOLERANCE): ReconTolerance {
  return {
    amountPaise: t?.amountPaise ?? base.amountPaise,
    dateDays: t?.dateDays ?? base.dateDays,
    fuzzyDocNo: t?.fuzzyDocNo ?? base.fuzzyDocNo,
  };
}

/** Portal documents of the same source in the ±2 surrounding imported periods. */
function otherPeriodDocs(db: Db, source: ReconSource, period: string): OtherPeriodDoc[] {
  const periods = [-2, -1, 1, 2].map((n) => shiftPeriod(period, n));
  const out: OtherPeriodDoc[] = [];
  for (const p of periods) {
    const b = latestBatch(db, source, p);
    if (!b) continue;
    for (const r of db.all<{ id: number; counterparty_gstin: string; doc_type: string; doc_no: string }>(
      'SELECT id, counterparty_gstin, doc_type, doc_no FROM gst_portal_docs WHERE batch_id = :id',
      { id: b.id },
    )) {
      out.push({ period: p, docId: r.id, gstin: r.counterparty_gstin, docType: r.doc_type as OtherPeriodDoc['docType'], docNo: r.doc_no });
    }
  }
  return out;
}

/**
 * Reconcile one source + period and store the results (portal rows, books-only rows, run record).
 * Synchronous; callers provide the transaction.
 */
export function performRun(ctx: CompanyCtx, source: ReconSource, rp: ResolvedPeriod, tolerance: ReconTolerance): void {
  const db = ctx.db;
  const label = RECON_SOURCE_LABELS[source];
  const batch = latestBatch(db, source, rp.key);
  if (!batch) {
    throw new AppError('NOT_FOUND', `No ${label} has been imported for ${periodLabel(rp.key)}. Import the ${label} file of that period first.`);
  }
  const today = ctx.clock.today();
  const side = sideOf(source);
  const portalRows = docsOfBatch(db, batch.id);
  const portal = portalRows.map(toPortalRec);
  const decisions = loadDecisions(db, source, rp.key);

  const windowFrom = addDays(rp.from, -OTHER_PERIOD_WINDOW_DAYS);
  const windowTo = addDays(rp.to, OTHER_PERIOD_WINDOW_DAYS);
  const loaded = loadBooksDocs(db, { side, from: windowFrom, to: windowTo, today });
  const have = new Set(loaded.map((b) => b.voucherId));
  const linked = decisions.map((d) => d.linkVoucherId).filter((id): id is number => id !== null && !have.has(id));
  const extra = linked.length > 0 ? loadBooksDocs(db, { side, today, voucherIds: linked }) : [];
  const books: BooksRec[] = [...loaded, ...extra].map((b) => ({ ...b, inRange: b.docDate >= rp.from && b.docDate <= rp.to }));

  const outcome = reconcile({ source, portal, books, decisions, tolerance, otherPeriods: otherPeriodDocs(db, source, rp.key) });
  const booksById = new Map(books.map((b) => [b.voucherId, b]));

  for (const o of outcome.portal) {
    const b = o.voucherId !== null ? (booksById.get(o.voucherId) ?? null) : null;
    const details: StoredPortalDetails = {
      v: 1,
      baseStatus: o.baseStatus,
      method: o.method,
      manual: o.manual,
      books: b ? toBooksView(b) : null,
      diffs: o.diffs,
      duplicateVoucherIds: o.duplicateVoucherIds,
      duplicateOfDocId: o.duplicateOfDocId,
      suggestionCount: o.suggestionCount,
      notes: o.notes,
    };
    db.run('UPDATE gst_portal_docs SET match_status = :status, matched_voucher_id = :vid, match_details = :details, remarks = :remarks WHERE id = :id', {
      id: o.docId,
      status: o.status,
      vid: o.voucherId,
      details: JSON.stringify(details),
      remarks: o.remarks,
    });
  }
  db.run('DELETE FROM gstrecon_books_only WHERE source = :source AND return_period = :period', { source, period: rp.key });
  for (const o of outcome.booksOnly) {
    const b = booksById.get(o.voucherId) as BooksRec;
    const details: StoredBooksDetails = {
      v: 1,
      books: toBooksView(b),
      otherPeriod: o.otherPeriod,
      otherPeriodDocId: o.otherPeriodDocId,
      duplicateVoucherIds: o.duplicateVoucherIds,
      suggestionCount: o.suggestionCount,
      notes: o.notes,
      remarks: o.remarks,
    };
    db.run('INSERT INTO gstrecon_books_only (source, return_period, voucher_id, status, details) VALUES (:source, :period, :vid, :status, :details)', {
      source,
      period: rp.key,
      vid: o.voucherId,
      status: o.status,
      details: JSON.stringify(details),
    });
  }
  const counts: Partial<Record<ReconStatus, number>> = {};
  for (const [k, n] of Object.entries(outcome.counts)) if (n > 0) counts[k as ReconStatus] = n;
  const summary: StoredRunSummary = { v: 1, counts, books: outcome.books, booksEligible: outcome.booksEligible, booksOnly: outcome.booksOnly.length, batchId: batch.id };
  const w = who(ctx);
  db.run(
    `INSERT INTO gstrecon_runs (source, return_period, batch_id, run_at, user_id, username, date_from, date_to, tolerance, summary)
     VALUES (:source, :period, :batch, :at, :uid, :uname, :from, :to, :tol, :summary)`,
    {
      source,
      period: rp.key,
      batch: batch.id,
      at: w.at,
      uid: w.userId,
      uname: w.username,
      from: rp.from,
      to: rp.to,
      tol: JSON.stringify(tolerance),
      summary: JSON.stringify(summary),
    },
  );
  // Keep the last 50 runs per source + period.
  db.run(
    `DELETE FROM gstrecon_runs WHERE source = :source AND return_period = :period AND id NOT IN
       (SELECT id FROM gstrecon_runs WHERE source = :source AND return_period = :period ORDER BY id DESC LIMIT 50)`,
    { source, period: rp.key },
  );
}

/** 'gstrecon.run' / 'gstrecon.gstr1.compare': reconcile and return the summary. */
export function runRecon(ctx: CompanyCtx, input: ReconRunInput): ReconSummary {
  const rp = requirePeriod(input.period, input.source);
  const tolerance = resolveTolerance(input.tolerance);
  ctx.db.transaction(() => performRun(ctx, input.source, rp, tolerance));
  return buildSummary(ctx.db, input.source, rp);
}

/** Re-run with the last run's tolerance and range (after a manual decision). */
function rerun(ctx: CompanyCtx, source: ReconSource, period: string): void {
  const last = latestRun(ctx.db, source, period);
  const rp = periodOfLastRun(ctx.db, source, period);
  performRun(ctx, source, rp, last?.tolerance ?? DEFAULT_RECON_TOLERANCE);
}

export function runHistory(db: Db, source: ReconSource, period: string): ReconRunView[] {
  const rp = requirePeriod(period, source);
  return listRuns(db, source, rp.key).map((r) => ({
    id: r.id,
    source: r.source,
    period: r.period,
    runAt: r.runAt,
    by: r.username,
    tolerance: r.tolerance,
    from: r.from,
    to: r.to,
    counts: r.summary.counts,
  }));
}

// ───────────────────────────── Decisions ─────────────────────────────

function docLabel(r: PortalDocRow): string {
  return `${RECON_SOURCE_LABELS[r.source as ReconSource] ?? r.source} ${periodShort(r.return_period)} · ${r.counterparty_gstin || 'no GSTIN'} · ${r.doc_no}`;
}

function requireDoc(db: Db, id: number): PortalDocRow {
  const r = getDocRow(db, id);
  if (!r) throw notFound('Portal document', id);
  return r;
}

function rowFor(db: Db, doc: PortalDocRow): ReconRow | null {
  const source = doc.source as ReconSource;
  return loadRows(db, source, doc.return_period, doc.batch_id).find((r) => r.portalDocId === doc.id) ?? null;
}

function voucherLabel(db: Db, id: number): string {
  const v = db.get<{ number: string | null; reference_no: string | null; vt: string }>(
    'SELECT v.number, v.reference_no, vt.name AS vt FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id',
    { id },
  );
  return v ? `${v.vt} ${v.number ?? ''}${v.reference_no ? ` (${v.reference_no})` : ''}`.trim() : `voucher ${id}`;
}

/** Explain why a voucher cannot take part in this reconciliation. */
function explainUnlinkable(db: Db, voucherId: number, source: ReconSource, today: string): never {
  const v = db.get<{ id: number; base_type: string; affects_books: number; is_cancelled: number; is_optional: number; is_post_dated: number; date: string }>(
    'SELECT id, base_type, affects_books, is_cancelled, is_optional, is_post_dated, date FROM vouchers WHERE id = :id',
    { id: voucherId },
  );
  if (!v) throw notFound('Voucher', voucherId);
  const label = voucherLabel(db, voucherId);
  const kinds = source === 'gstr1' ? 'a sales invoice, credit note or debit note' : 'a purchase or a purchase return (debit note)';
  if (v.is_cancelled === 1) throw rule(`${label} is cancelled, so it cannot be linked. Link ${kinds} that is in the books.`);
  if (v.is_optional === 1) throw rule(`${label} is optional (not in the books), so it cannot be linked. Make it regular first.`);
  if (v.is_post_dated === 1 && v.date > today) throw rule(`${label} is post-dated (${v.date}); it is not in the books yet.`);
  if (v.affects_books !== 1) throw rule(`${label} does not affect the books, so it cannot be linked.`);
  throw rule(
    `${label} cannot be linked to a ${RECON_SOURCE_LABELS[source]} document: it must be ${kinds} entered in invoice mode with GST details${source === 'gstr1' ? '' : ' and the supplier’s GSTIN'}.`,
  );
}

/** Manually pair a portal document with a voucher. The link survives re-runs and re-imports. */
export function linkDoc(ctx: CompanyCtx, input: { portalDocId: number; voucherId: number }): ReconRow | null {
  const db = ctx.db;
  const doc = requireDoc(db, input.portalDocId);
  const source = doc.source as ReconSource;
  const today = ctx.clock.today();
  const b = loadBooksDocs(db, { side: sideOf(source), today, voucherIds: [input.voucherId] })[0];
  if (!b) explainUnlinkable(db, input.voucherId, source, today);
  const key = doc.doc_key ?? portalDocKey(doc.counterparty_gstin, doc.doc_type as PortalRec['docType'], doc.doc_no);
  const other = db.get<{ doc_key: string }>(
    `SELECT doc_key FROM gstrecon_decisions WHERE source = :source AND return_period = :period AND link_voucher_id = :vid AND doc_key IS NOT NULL AND doc_key <> :key`,
    { source, period: doc.return_period, vid: input.voucherId, key },
  );
  if (other) {
    const otherDoc = db.get<{ doc_no: string; counterparty_gstin: string }>(
      'SELECT doc_no, counterparty_gstin FROM gst_portal_docs WHERE batch_id = :batch AND doc_key = :key',
      { batch: doc.batch_id, key: other.doc_key },
    );
    throw conflict(
      `${voucherLabel(db, input.voucherId)} is already linked to ${otherDoc ? `document ${otherDoc.doc_no} of ${otherDoc.counterparty_gstin}` : 'another document'}. Unlink that document first.`,
    );
  }
  const before = getDecision(db, { source, period: doc.return_period, docKey: key, voucherId: null });
  upsertDecision(
    db,
    { source, period: doc.return_period, docKey: key, voucherId: null },
    { linkVoucherId: input.voucherId, resolution: before?.resolution === 'ignore' ? null : (before?.resolution ?? null) },
    who(ctx),
  );
  ctx.audit({
    action: 'alter',
    entityType: 'gst_portal_doc',
    entityId: doc.id,
    entityLabel: docLabel(doc),
    before: { status: doc.match_status, voucherId: doc.matched_voucher_id, link: before?.linkVoucherId ?? null },
    after: { link: input.voucherId, voucher: voucherLabel(db, input.voucherId) },
  });
  rerun(ctx, source, doc.return_period);
  return rowFor(db, requireDoc(db, doc.id));
}

/**
 * Remove the manual link and any accept/ignore of a portal document, or the accept/ignore of a
 * books-only voucher (voucherId + period + source). The row is reconciled automatically again.
 */
export function unlinkDoc(ctx: CompanyCtx, input: { portalDocId?: number; voucherId?: number; period?: string; source?: ReconSource }): ReconRow | null {
  const db = ctx.db;
  if (input.portalDocId !== undefined) {
    const doc = requireDoc(db, input.portalDocId);
    const source = doc.source as ReconSource;
    const key = doc.doc_key ?? portalDocKey(doc.counterparty_gstin, doc.doc_type as PortalRec['docType'], doc.doc_no);
    const before = getDecision(db, { source, period: doc.return_period, docKey: key, voucherId: null });
    if (!before) return rowFor(db, doc);
    deleteDecision(db, { source, period: doc.return_period, docKey: key, voucherId: null });
    ctx.audit({
      action: 'alter',
      entityType: 'gst_portal_doc',
      entityId: doc.id,
      entityLabel: docLabel(doc),
      before: { link: before.linkVoucherId, resolution: before.resolution, remarks: before.remarks },
      after: { link: null, resolution: null },
    });
    rerun(ctx, source, doc.return_period);
    return rowFor(db, requireDoc(db, doc.id));
  }
  const { voucherId, period, source } = requireBooksTarget(input);
  const rp = requirePeriod(period, source);
  const before = getDecision(db, { source, period: rp.key, docKey: null, voucherId });
  if (before) {
    deleteDecision(db, { source, period: rp.key, docKey: null, voucherId });
    ctx.audit({
      action: 'alter',
      entityType: 'voucher',
      entityId: voucherId,
      entityLabel: `${RECON_SOURCE_LABELS[source]} ${periodShort(rp.key)} · ${voucherLabel(db, voucherId)}`,
      before: { resolution: before.resolution, remarks: before.remarks },
      after: { resolution: null },
    });
    rerun(ctx, source, rp.key);
  }
  return loadRows(db, source, rp.key, latestBatch(db, source, rp.key)?.id ?? null).find((r) => r.kind === 'books' && r.voucherId === voucherId) ?? null;
}

function requireBooksTarget(input: { voucherId?: number; period?: string; source?: ReconSource }): { voucherId: number; period: string; source: ReconSource } {
  if (input.voucherId === undefined) throw validation([{ path: 'portalDocId', message: 'Choose a portal document (or a voucher with its period and source)' }]);
  if (!input.period) throw validation([{ path: 'period', message: 'The return period is required with a voucher' }]);
  if (!input.source) throw validation([{ path: 'source', message: 'The source (GSTR-2B, GSTR-2A or GSTR-1) is required with a voucher' }]);
  return { voucherId: input.voucherId, period: input.period, source: input.source };
}

/** Accept differences / ignore rows (portal documents and/or books-only vouchers). */
export function resolveDocs(ctx: CompanyCtx, resolution: 'accept' | 'ignore', input: ReconDecisionInput): ReconDecisionResult {
  const db = ctx.db;
  const remarks = input.remarks?.trim() || null;
  const touched = new Map<string, { source: ReconSource; period: string }>();
  let updated = 0;
  const verb = resolution === 'accept' ? 'accepted' : 'ignored';
  for (const id of input.portalDocIds ?? []) {
    const doc = requireDoc(db, id);
    const source = doc.source as ReconSource;
    const key = doc.doc_key ?? portalDocKey(doc.counterparty_gstin, doc.doc_type as PortalRec['docType'], doc.doc_no);
    const before = getDecision(db, { source, period: doc.return_period, docKey: key, voucherId: null });
    upsertDecision(db, { source, period: doc.return_period, docKey: key, voucherId: null }, { resolution, remarks }, who(ctx));
    ctx.audit({
      action: 'alter',
      entityType: 'gst_portal_doc',
      entityId: doc.id,
      entityLabel: docLabel(doc),
      before: { status: doc.match_status, resolution: before?.resolution ?? null, remarks: before?.remarks ?? null },
      after: { resolution, remarks },
    });
    touched.set(`${source}|${doc.return_period}`, { source, period: doc.return_period });
    updated++;
  }
  if (input.voucherIds && input.voucherIds.length > 0) {
    const { period, source } = requireBooksTarget({ voucherId: input.voucherIds[0], period: input.period, source: input.source });
    const rp = requirePeriod(period, source);
    const rows = new Set(
      db.all<{ voucher_id: number }>('SELECT voucher_id FROM gstrecon_books_only WHERE source = :source AND return_period = :period', { source, period: rp.key }).map(
        (r) => r.voucher_id,
      ),
    );
    for (const vid of input.voucherIds) {
      if (!rows.has(vid)) {
        throw rule(`${voucherLabel(db, vid)} is not a "missing in portal" row of ${RECON_SOURCE_LABELS[source]} ${periodLabel(rp.key)}, so it cannot be ${verb} here. Run the reconciliation first.`);
      }
      const before = getDecision(db, { source, period: rp.key, docKey: null, voucherId: vid });
      upsertDecision(db, { source, period: rp.key, docKey: null, voucherId: vid }, { resolution, remarks }, who(ctx));
      ctx.audit({
        action: 'alter',
        entityType: 'voucher',
        entityId: vid,
        entityLabel: `${RECON_SOURCE_LABELS[source]} ${periodShort(rp.key)} · ${voucherLabel(db, vid)}`,
        before: { resolution: before?.resolution ?? null, remarks: before?.remarks ?? null },
        after: { resolution, remarks },
      });
      touched.set(`${source}|${rp.key}`, { source, period: rp.key });
      updated++;
    }
  }
  if (updated === 0) throw validation([{ path: 'portalDocIds', message: `Choose at least one row to mark as ${verb}` }]);
  let last: { source: ReconSource; period: string } | null = null;
  for (const t of touched.values()) {
    rerun(ctx, t.source, t.period);
    last = t;
  }
  const l = last as { source: ReconSource; period: string };
  return { updated, summary: buildSummary(db, l.source, periodOfLastRun(db, l.source, l.period)) };
}
