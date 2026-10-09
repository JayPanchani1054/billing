/**
 * GSTR-1: placement of every outward document into a return table, the table-wise summary, the
 * voucher-level drill-down and the "uncertain transactions" list. The JSON file is built from the
 * same computation in gstr1-json.ts.
 *
 * Placement (document nature → table; credit/debit notes by party type):
 *   b2b             4A (4B when reverse charge)        notes → 9B CDNR (inv_typ R)
 *   sez_wpay/_lut   6B (SEWP / SEWOP)                   notes → 9B CDNR (SEWP / SEWOP)
 *   deemed_export   6C (DE)                             notes → 9B CDNR (DE)
 *   b2cl            5                                   notes → 9B CDNUR B2CL
 *   export_wpay/lut 6A (WPAY / WOPAY)                   notes → 9B CDNUR EXPWP / EXPWOP
 *   b2cs            7 (aggregated)                      notes → netted into 7 (unless the original invoice was B2CL / export)
 *   nil_exempt      8                                   notes → netted into 8
 * Lines that are exempt / nil-rated / non-GST always go to table 8 (split inter/intra × registered/
 * unregistered), whatever the document's table. Composition and non-GST companies file no GSTR-1.
 */
import { formatMoney } from '../../../shared/format.ts';
import { POS_OTHER_COUNTRIES, SERVICES_UQC } from '../../../shared/gst/index.ts';
import type { GstNature } from '../../../shared/types/gst.ts';
import type {
  GstHsnRow,
  GstIssue,
  Gstr1B2csRow,
  Gstr1DocRow,
  Gstr1DocSeries,
  Gstr1NilRow,
  Gstr1SectionId,
  Gstr1SectionResult,
  Gstr1SectionSummary,
  Gstr1Summary,
  ReturnPeriodRef,
  TaxValue,
} from '../../../shared/types/gst-returns.ts';
import { GSTR1_SECTIONS } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { rule } from '../../lib/errors.ts';
import { issue, outwardIssues, sortIssues } from './checks.ts';
import type { GstCompany, GstDoc, GstDocLine } from './docs.ts';
import { addTV, isRegisteredDoc, isZeroTV, lineTV, loadDocs, posName, rateSplit, reportHsn, zeroTV } from './docs.ts';

export interface SectionMeta {
  table: string;
  title: string;
  countLabel: Gstr1SectionSummary['countLabel'];
}

export const SECTION_META: Readonly<Record<Gstr1SectionId, SectionMeta>> = {
  b2b: { table: '4A', title: 'B2B invoices — registered persons', countLabel: 'documents' },
  b2b_rcm: { table: '4B', title: 'B2B invoices — tax payable by the recipient (reverse charge)', countLabel: 'documents' },
  b2cl: { table: '5', title: 'B2C large — inter-state invoices above the B2CL threshold', countLabel: 'documents' },
  exp_wp: { table: '6A', title: 'Exports with payment of IGST (WPAY)', countLabel: 'documents' },
  exp_wop: { table: '6A', title: 'Exports under LUT / bond (WOPAY)', countLabel: 'documents' },
  sez_wp: { table: '6B', title: 'Supplies to SEZ with payment of IGST (SEWP)', countLabel: 'documents' },
  sez_wop: { table: '6B', title: 'Supplies to SEZ without payment of IGST (SEWOP)', countLabel: 'documents' },
  de: { table: '6C', title: 'Deemed exports (DE)', countLabel: 'documents' },
  b2cs: { table: '7', title: 'B2C small — by place of supply and rate', countLabel: 'rows' },
  nil: { table: '8', title: 'Nil rated, exempt and non-GST supplies', countLabel: 'documents' },
  cdnr: { table: '9B', title: 'Credit / debit notes — registered (CDNR)', countLabel: 'documents' },
  cdnur: { table: '9B', title: 'Credit / debit notes — unregistered (CDNUR)', countLabel: 'documents' },
  at: { table: '11A(1)', title: 'Advances received — tax liability', countLabel: 'rows' },
  atadj: { table: '11B(1)', title: 'Advances adjusted against invoices', countLabel: 'rows' },
  hsn_b2b: { table: '12', title: 'HSN summary — B2B supplies', countLabel: 'rows' },
  hsn_b2c: { table: '12', title: 'HSN summary — B2C supplies', countLabel: 'rows' },
  doc: { table: '13', title: 'Documents issued', countLabel: 'series' },
};

/** Sections whose rows are documents. */
export const DOC_SECTIONS: ReadonlySet<Gstr1SectionId> = new Set(['b2b', 'b2b_rcm', 'b2cl', 'exp_wp', 'exp_wop', 'sez_wp', 'sez_wop', 'de', 'cdnr', 'cdnur']);

export const NIL_LABELS: Readonly<Record<Gstr1NilRow['supplyType'], string>> = {
  INTRB2B: 'Inter-state supplies to registered persons',
  INTRAB2B: 'Intra-state supplies to registered persons',
  INTRB2C: 'Inter-state supplies to unregistered persons',
  INTRAB2C: 'Intra-state supplies to unregistered persons',
};

const DOC_TYPE_LABELS: Readonly<Record<1 | 4 | 5, string>> = {
  1: 'Invoices for outward supply',
  4: 'Debit notes',
  5: 'Credit notes',
};

export const ADVANCES_NOTE =
  'Table 11 (advances received / adjusted) is not derived: receipts do not record the rate and place of supply of the advance. Add tax on advances for services manually on the portal.';
export const AMENDMENTS_NOTE = 'Amendment tables (9A, 9C, 10, 11B(2)) are not prepared — amend earlier periods on the portal.';

export interface Placement {
  doc: GstDoc;
  /** Section of the taxable lines (null: none / not reported). */
  section: Gstr1SectionId | null;
  invoiceType: 'R' | 'SEWP' | 'SEWOP' | 'DE' | null;
  exportType: 'WPAY' | 'WOPAY' | null;
  cdnurType: 'B2CL' | 'EXPWP' | 'EXPWOP' | null;
  /** Lines reported in `section` (taxability 'taxable'). */
  taxable: GstDocLine[];
  /** Exempt / nil / non-GST lines (table 8). */
  nil: GstDocLine[];
  registered: boolean;
  hsnSide: 'b2b' | 'b2c';
  /** Tax payable by the recipient: excluded from the supplier's liability. */
  rcm: boolean;
  /** Credit/debit notes: original invoice found (null for invoices). */
  originalFound: boolean | null;
}

export interface Gstr1Computation {
  company: GstCompany;
  period: ReturnPeriodRef;
  /** Outward documents in the books (period). */
  docs: GstDoc[];
  /** Outward documents placed in GSTR-1 (excludes composition / non-GST documents). */
  placements: Placement[];
  /** Outward cancelled documents in the period (table 13 only). */
  cancelled: GstDoc[];
  b2cs: Gstr1B2csRow[];
  nil: Gstr1NilRow[];
  hsnB2b: GstHsnRow[];
  hsnB2c: GstHsnRow[];
  docSeries: Array<Gstr1DocSeries & { docIds: number[] }>;
  issues: GstIssue[];
  notes: string[];
  excluded: { optional: number; cancelled: number; notGst: number };
}

interface OriginalInfo {
  nature: GstNature | null;
}

/** Find the original sales invoice of a credit/debit note (by number, and date when given). */
export function originalLookup(db: Db): (d: GstDoc) => OriginalInfo | null {
  const cache = new Map<string, OriginalInfo | null>();
  return (d) => {
    const no = d.originalInvoiceNo?.trim();
    if (!no) return null;
    const key = `${no}|${d.originalInvoiceDate ?? ''}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const row = db.get<{ gst_nature: string | null }>(
      `SELECT gst_nature FROM vouchers
        WHERE base_type = 'sales' AND is_optional = 0 AND number = :no COLLATE NOCASE
          ${d.originalInvoiceDate ? 'AND date = :date' : ''}
        ORDER BY date DESC, id DESC LIMIT 1`,
      d.originalInvoiceDate ? { no, date: d.originalInvoiceDate } : { no },
    );
    const info = row ? { nature: (row.gst_nature as GstNature | null) ?? null } : null;
    cache.set(key, info);
    return info;
  };
}

/** Place one outward document. */
export function placeOutward(d: GstDoc, original: OriginalInfo | null): Placement {
  const taxable = d.lines.filter((l) => l.taxability === 'taxable');
  const nil = d.lines.filter((l) => l.taxability !== 'taxable');
  const registered = isRegisteredDoc(d);
  const p: Placement = {
    doc: d,
    section: null,
    invoiceType: null,
    exportType: null,
    cdnurType: null,
    taxable,
    nil,
    registered,
    hsnSide: 'b2c',
    rcm: false,
    originalFound: d.isNote ? original !== null : null,
  };
  let nature = d.nature;
  if (nature === 'composition_outward' || nature === 'no_gst') {
    p.taxable = [];
    p.nil = [];
    return p;
  }
  // A "nil/exempt" document that still carries taxable lines: report them by party type.
  if (nature === 'nil_exempt' && taxable.length > 0) nature = registered ? 'b2b' : 'b2cs';

  switch (nature) {
    case 'b2b':
      p.invoiceType = 'R';
      p.rcm = d.reverseCharge;
      p.section = d.isNote ? 'cdnr' : d.reverseCharge ? 'b2b_rcm' : 'b2b';
      p.hsnSide = 'b2b';
      break;
    case 'sez_wpay':
    case 'sez_lut':
      p.invoiceType = nature === 'sez_wpay' ? 'SEWP' : 'SEWOP';
      p.section = d.isNote ? 'cdnr' : nature === 'sez_wpay' ? 'sez_wp' : 'sez_wop';
      p.hsnSide = 'b2b';
      break;
    case 'deemed_export':
      p.invoiceType = 'DE';
      p.section = d.isNote ? 'cdnr' : 'de';
      p.hsnSide = 'b2b';
      break;
    case 'export_wpay':
    case 'export_lut':
      if (d.isNote) {
        const on = original?.nature;
        const wpay = on === 'export_wpay' || on === 'export_lut' ? on === 'export_wpay' : nature === 'export_wpay';
        p.section = 'cdnur';
        p.cdnurType = wpay ? 'EXPWP' : 'EXPWOP';
      } else {
        p.section = nature === 'export_wpay' ? 'exp_wp' : 'exp_wop';
        p.exportType = nature === 'export_wpay' ? 'WPAY' : 'WOPAY';
      }
      break;
    case 'b2cl':
    case 'b2cs': {
      if (d.isNote) {
        const on = original?.nature ?? null;
        if (on === 'export_wpay' || on === 'export_lut') {
          p.section = 'cdnur';
          p.cdnurType = on === 'export_wpay' ? 'EXPWP' : 'EXPWOP';
        } else if (on === 'b2cl' || (on === null && nature === 'b2cl')) {
          p.section = 'cdnur';
          p.cdnurType = 'B2CL';
        } else {
          p.section = 'b2cs';
        }
      } else {
        p.section = nature;
      }
      break;
    }
    case 'nil_exempt':
      p.section = null;
      p.hsnSide = registered ? 'b2b' : 'b2c';
      break;
    default:
      p.section = null;
  }
  if (p.section === null) p.taxable = [];
  return p;
}

const docIdsSort = (a: GstDoc, b: GstDoc): number =>
  a.date.localeCompare(b.date) || (a.numberSeq ?? 0) - (b.numberSeq ?? 0) || (a.number ?? '').localeCompare(b.number ?? '') || a.id - b.id;

/**
 * A number of an outward voucher type's series held by a voucher that is not an outward GST document of
 * the period: an optional (draft) voucher, or a debit note issued to a supplier (purchase return) in the
 * same Debit Note series. It is neither issued nor cancelled, so Table 13 leaves it out of the range.
 */
export interface SeriesHolder {
  id: number;
  voucherTypeId: number;
  voucherTypeName: string;
  baseType: string;
  number: string;
  numberSeq: number | null;
  date: string;
  optional: boolean;
  cancelled: boolean;
}

function seriesKey(baseType: string, voucherTypeId: number, number: string, numberSeq: number | null): { docNum: 1 | 4 | 5; key: string; seq: number | null } {
  const docNum: 1 | 4 | 5 = baseType === 'credit_note' ? 5 : baseType === 'debit_note' ? 4 : 1;
  const num = number.trim();
  const m = /(\d+)(?=\D*$)/.exec(num);
  const raw = m ? Number(m[1]) : numberSeq;
  const pattern = m ? num.slice(0, m.index) + '#' + num.slice(m.index + m[1].length) : num;
  return { docNum, key: `${docNum}|${voucherTypeId}|${pattern.toUpperCase()}`, seq: raw !== null && Number.isSafeInteger(raw) ? raw : null };
}

/**
 * Document series for table 13 (outward invoices, debit notes, credit notes; cancelled included).
 * `holders`: numbers of the same series held by vouchers that are not outward documents (optional
 * vouchers, purchase-return debit notes) — they are neither "missing" nor "cancelled"; an optional one
 * raises `optional_in_series`, because regularising it later would contradict the filed Table 13.
 */
export function documentSeries(
  docs: readonly GstDoc[],
  holders: readonly SeriesHolder[] = [],
): { series: Array<Gstr1DocSeries & { docIds: number[] }>; issues: GstIssue[] } {
  interface Acc {
    docNum: 1 | 4 | 5;
    voucherTypeId: number;
    voucherTypeName: string;
    items: Array<{ doc: GstDoc; seq: number | null }>;
    held: Array<{ holder: SeriesHolder; seq: number | null }>;
  }
  const groups = new Map<string, Acc>();
  for (const d of docs) {
    if (!d.number || d.number.trim() === '') continue;
    const { docNum, key, seq } = seriesKey(d.baseType, d.voucherTypeId, d.number, d.numberSeq);
    const g = groups.get(key) ?? { docNum, voucherTypeId: d.voucherTypeId, voucherTypeName: d.voucherTypeName, items: [], held: [] };
    g.items.push({ doc: d, seq });
    groups.set(key, g);
  }
  const issues: GstIssue[] = [];
  for (const h of holders) {
    if (!h.number || h.number.trim() === '') continue;
    const { key, seq } = seriesKey(h.baseType, h.voucherTypeId, h.number, h.numberSeq);
    const g = groups.get(key);
    if (g) g.held.push({ holder: h, seq });
    // Only a series that has documents in this return matters (a pro-forma voucher type has its own key).
    if (g && h.optional && !h.cancelled) {
      issues.push({
        ...issue(
          null,
          'optional_in_series',
          'warning',
          `${h.voucherTypeName} ${h.number.trim()} is an optional (draft) voucher holding a number of the GST invoice series. It is not reported in GSTR-1 (Table 13 leaves the number out).`,
          'Before filing, make it regular (it is then reported as issued), or delete it (the number is then reported as cancelled). For pro-forma documents use a voucher type with its own series.',
          'doc',
        ),
        voucherId: h.id,
        voucherNumber: h.number.trim(),
        voucherTypeName: h.voucherTypeName,
        date: h.date,
      });
    }
  }

  const out: Array<Gstr1DocSeries & { docIds: number[] }> = [];
  const emit = (g: Acc, items: Acc['items'], held: Acc['held']): void => {
    const numeric = items.every((i) => i.seq !== null);
    items.sort((a, b) => (numeric ? (a.seq as number) - (b.seq as number) : 0) || docIdsSort(a.doc, b.doc));
    const first = items[0];
    const last = items[items.length - 1];
    const count = items.length;
    // Numbers inside the range held by optional vouchers / purchase returns are not documents of this
    // return: they are left out of the total instead of being counted as missing (= cancelled).
    const used = new Set(items.map((i) => i.seq));
    const heldInRange = numeric
      ? new Set(held.filter((h) => h.seq !== null && h.seq > (first.seq as number) && h.seq < (last.seq as number) && !used.has(h.seq)).map((h) => h.seq))
      : new Set<number | null>();
    const total = numeric ? (last.seq as number) - (first.seq as number) + 1 - heldInRange.size : count;
    const missing = Math.max(0, total - count);
    const cancelled = items.filter((i) => !i.doc.inBooks).length + missing;
    out.push({
      docNum: g.docNum,
      docTypeLabel: DOC_TYPE_LABELS[g.docNum],
      voucherTypeId: g.voucherTypeId,
      voucherTypeName: g.voucherTypeName,
      from: (first.doc.number ?? '').trim(),
      to: (last.doc.number ?? '').trim(),
      total,
      cancelled,
      missing,
      net: total - cancelled,
      docIds: items.map((i) => i.doc.id),
    });
    if (missing > 0) {
      issues.push(
        issue(
          null,
          'doc_series_gap',
          'warning',
          `${g.voucherTypeName}: ${missing} number${missing === 1 ? ' is' : 's are'} missing between ${first.doc.number} and ${last.doc.number} (deleted vouchers). They are reported as cancelled in Table 13.`,
          'If the numbers were never issued, check the voucher numbering; otherwise no action is needed.',
          'doc',
        ),
      );
    }
  };
  for (const g of groups.values()) {
    const seen = new Set<number>();
    let dup = false;
    for (const it of g.items) {
      if (it.seq === null) continue;
      if (seen.has(it.seq)) {
        dup = true;
        break;
      }
      seen.add(it.seq);
    }
    if (!dup) {
      emit(g, g.items, g.held);
      continue;
    }
    // Numbers repeat (monthly restart): one series per month.
    const byMonth = new Map<string, Acc['items']>();
    for (const it of g.items) {
      const k = it.doc.date.slice(0, 7);
      byMonth.set(k, [...(byMonth.get(k) ?? []), it]);
    }
    for (const k of [...byMonth.keys()].sort()) {
      emit(g, byMonth.get(k) as Acc['items'], g.held.filter((h) => h.holder.date.slice(0, 7) === k));
    }
  }
  out.sort((a, b) => a.docNum - b.docNum || a.voucherTypeName.localeCompare(b.voucherTypeName) || a.from.localeCompare(b.from, 'en', { numeric: true }));
  return { series: out, issues };
}

function hsnKey(hsn: string, uqc: string, rate: number): string {
  return `${hsn}|${uqc}|${rate}`;
}

/** Accumulate lines into HSN rows (signed). */
export function hsnAccumulator(digits: number): {
  add(l: GstDocLine, sign: number): void;
  rows(): GstHsnRow[];
} {
  const by = new Map<string, GstHsnRow>();
  return {
    add(l, sign) {
      const services = l.supplyType === 'services' || l.hsn.startsWith('99');
      const hsn = reportHsn(l.hsn, digits);
      const uqc = services ? SERVICES_UQC : l.uqc || 'OTH';
      const key = hsnKey(hsn, uqc, l.rate);
      let r = by.get(key);
      if (!r) {
        r = { hsn, description: '', uqc, qty: 0, rate: l.rate, ...zeroTV(), total: 0, supplyType: services ? 'services' : 'goods' };
        by.set(key, r);
      }
      if (!r.description && l.description) r.description = l.description;
      if (!services) r.qty = Math.round((r.qty + sign * Math.abs(l.qty)) * 1000) / 1000;
      addTV(r, lineTV(l), sign);
      r.total = r.taxable + r.igst + r.cgst + r.sgst + r.cess;
    },
    rows() {
      return [...by.values()]
        .filter((r) => !isZeroTV(r) || r.qty !== 0)
        .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.uqc.localeCompare(b.uqc) || a.rate - b.rate);
    },
  };
}

/**
 * Compute everything GSTR-1 needs for a period. `preloaded` (optional) must be loadDocs() of exactly
 * this period with includeCancelled: true — callers that need the documents for several reports load once.
 */
export function computeGstr1(db: Db, company: GstCompany, period: ReturnPeriodRef, today: string, preloaded?: readonly GstDoc[]): Gstr1Computation {
  if (company.registration === 'unregistered') throw rule('This company is not registered under GST, so it does not file GSTR-1.');
  const all = preloaded ?? loadDocs(db, company, { from: period.from, to: period.to, today, includeCancelled: true });
  const outward = all.filter((d) => d.direction === 'outward');
  const docs = outward.filter((d) => d.inBooks);
  const cancelled = outward.filter((d) => !d.inBooks);
  const lookup = originalLookup(db);

  const placements: Placement[] = [];
  let notGst = 0;
  for (const d of docs) {
    const p = placeOutward(d, d.isNote ? lookup(d) : null);
    if (d.nature === 'composition_outward' || d.nature === 'no_gst') {
      notGst += 1;
      continue;
    }
    placements.push(p);
  }

  // Table 7: B2CS by POS + rate + supply type.
  const b2csBy = new Map<string, Gstr1B2csRow & { ids: Set<number> }>();
  // Table 8.
  const nilBy = new Map<Gstr1NilRow['supplyType'], Gstr1NilRow>();
  for (const k of ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'] as const) nilBy.set(k, { supplyType: k, label: NIL_LABELS[k], exempt: 0, nil: 0, nonGst: 0 });
  const hsnB2b = hsnAccumulator(company.config.gst.hsnDigits);
  const hsnB2c = hsnAccumulator(company.config.gst.hsnDigits);

  for (const p of placements) {
    const d = p.doc;
    if (p.section === 'b2cs') {
      const pos = d.pos || company.stateCode;
      const supplyType = d.interState ? 'INTER' : 'INTRA';
      for (const l of p.taxable) {
        const key = `${pos}|${l.rate}|${supplyType}`;
        let r = b2csBy.get(key);
        if (!r) {
          r = { supplyType, pos, posName: posName(pos), rate: l.rate, type: 'OE', documents: 0, ...zeroTV(), ids: new Set() };
          b2csBy.set(key, r);
        }
        addTV(r, lineTV(l), d.sign);
        r.ids.add(d.id);
      }
    }
    for (const l of p.nil) {
      const k = `${d.interState ? 'INTR' : 'INTRA'}${p.registered ? 'B2B' : 'B2C'}` as Gstr1NilRow['supplyType'];
      const r = nilBy.get(k) as Gstr1NilRow;
      const v = d.sign * l.taxable;
      if (l.taxability === 'exempt') r.exempt += v;
      else if (l.taxability === 'nil_rated') r.nil += v;
      else r.nonGst += v;
    }
    // Taxable lines follow the document's table; nil/exempt lines follow the party (registered → B2B).
    for (const l of p.taxable) (p.hsnSide === 'b2b' ? hsnB2b : hsnB2c).add(l, d.sign);
    for (const l of p.nil) (p.registered ? hsnB2b : hsnB2c).add(l, d.sign);
  }

  const b2cs = [...b2csBy.values()]
    .map(({ ids, ...r }) => ({ ...r, documents: ids.size }))
    .filter((r) => !isZeroTV(r))
    .sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate || a.supplyType.localeCompare(b.supplyType));
  const nil = [...nilBy.values()];

  // Numbers of the outward series held by vouchers that are not outward documents of the period
  // (optional vouchers; debit notes to suppliers sharing the Debit Note series).
  const listed = new Set([...docs, ...cancelled].map((d) => d.id));
  const holders: SeriesHolder[] = db
    .all<{ id: number; vt: number; vt_name: string; base_type: string; number: string; number_seq: number | null; date: string; is_optional: number; is_cancelled: number }>(
      `SELECT v.id, v.voucher_type_id AS vt, vt.name AS vt_name, v.base_type, v.number, v.number_seq, v.date, v.is_optional, v.is_cancelled
         FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE v.base_type IN ('sales', 'credit_note', 'debit_note') AND v.number IS NOT NULL AND v.date >= :from AND v.date <= :to`,
      { from: period.from, to: period.to },
    )
    .filter((r) => !listed.has(r.id))
    .map((r) => ({
      id: r.id,
      voucherTypeId: r.vt,
      voucherTypeName: r.vt_name,
      baseType: r.base_type,
      number: r.number,
      numberSeq: r.number_seq,
      date: r.date,
      optional: r.is_optional === 1,
      cancelled: r.is_cancelled === 1,
    }));
  const { series, issues: seriesIssues } = documentSeries([...docs, ...cancelled], holders);

  const issues: GstIssue[] = [];
  for (const p of placements) {
    issues.push(...outwardIssues(p.doc, company, { section: p.section, originalFound: p.originalFound }));
  }
  issues.push(...seriesIssues);
  for (const r of b2cs) {
    if (r.taxable < 0) {
      issues.push(
        issue(
          null,
          'negative_value',
          'warning',
          `B2CS row for ${r.posName || r.pos} at ${r.rate}% is negative (${formatMoney(r.taxable, { symbol: true })}) after netting credit notes.`,
          'This is allowed on the portal, but check that the credit notes belong to this period and place of supply.',
          'b2cs',
        ),
      );
    }
  }

  const optional =
    db.value<number>(
      `SELECT COUNT(*) FROM vouchers WHERE base_type IN ('sales','credit_note','debit_note') AND is_optional = 1 AND date >= :from AND date <= :to`,
      { from: period.from, to: period.to },
    ) ?? 0;

  const notes: string[] = [ADVANCES_NOTE, AMENDMENTS_NOTE];
  if (company.registration === 'composition') notes.unshift('Composition taxpayers do not file GSTR-1 (they file CMP-08 and GSTR-4). The tables below are empty.');
  if (company.config.gst.filingFrequency === 'quarterly' && period.kind === 'month') {
    notes.push('You file quarterly (QRMP): B2B invoices of the first two months of a quarter may be uploaded through IFF; the quarterly GSTR-1 needs the whole quarter.');
  }

  return {
    company,
    period,
    docs,
    placements,
    cancelled,
    b2cs,
    nil,
    hsnB2b: hsnB2b.rows(),
    hsnB2c: hsnB2c.rows(),
    docSeries: series,
    issues: sortIssues(issues),
    notes,
    excluded: { optional, cancelled: cancelled.length, notGst },
  };
}

/** Section summaries in table order. */
export function summarizeSections(c: Gstr1Computation): Gstr1SectionSummary[] {
  const acc = new Map<Gstr1SectionId, Gstr1SectionSummary>();
  for (const id of GSTR1_SECTIONS) {
    const m = SECTION_META[id];
    acc.set(id, { id, table: m.table, title: m.title, count: 0, countLabel: m.countLabel, invoiceValue: 0, ...zeroTV() });
  }
  const nilDocs = new Set<number>();
  for (const p of c.placements) {
    const d = p.doc;
    if (p.section && DOC_SECTIONS.has(p.section)) {
      const s = acc.get(p.section) as Gstr1SectionSummary;
      s.count += 1;
      s.invoiceValue += d.sign * d.totalAmount;
      for (const l of p.taxable) addTV(s, lineTV(l), d.sign);
    }
    if (p.nil.length > 0) {
      const s = acc.get('nil') as Gstr1SectionSummary;
      for (const l of p.nil) s.taxable += d.sign * l.taxable;
      nilDocs.add(d.id);
    }
  }
  (acc.get('nil') as Gstr1SectionSummary).count = nilDocs.size;
  const b2cs = acc.get('b2cs') as Gstr1SectionSummary;
  b2cs.count = c.b2cs.length;
  for (const r of c.b2cs) addTV(b2cs, r);
  for (const [id, rows] of [
    ['hsn_b2b', c.hsnB2b],
    ['hsn_b2c', c.hsnB2c],
  ] as const) {
    const s = acc.get(id) as Gstr1SectionSummary;
    s.count = rows.length;
    for (const r of rows) addTV(s, r);
  }
  const doc = acc.get('doc') as Gstr1SectionSummary;
  doc.count = c.docSeries.length;
  doc.note = `${c.docSeries.reduce((s, x) => s + x.net, 0)} documents issued net of cancellations`;
  (acc.get('at') as Gstr1SectionSummary).note = ADVANCES_NOTE;
  (acc.get('atadj') as Gstr1SectionSummary).note = ADVANCES_NOTE;
  (acc.get('b2b_rcm') as Gstr1SectionSummary).note = 'Tax shown is payable by the recipient; it is not part of your liability.';
  return GSTR1_SECTIONS.map((id) => acc.get(id) as Gstr1SectionSummary);
}

/** Net tax liability reported in GSTR-1 (excludes reverse-charge supplies). */
export function gstr1Totals(c: Gstr1Computation): TaxValue {
  const t = zeroTV();
  for (const p of c.placements) {
    if (p.rcm || p.section === null || p.section === 'b2cs') continue;
    for (const l of p.taxable) addTV(t, lineTV(l), p.doc.sign);
  }
  for (const r of c.b2cs) addTV(t, r);
  return t;
}

export function gstr1Summary(c: Gstr1Computation): Gstr1Summary {
  return {
    period: c.period,
    gstin: c.company.gstin,
    companyName: c.company.name,
    sections: summarizeSections(c),
    b2cs: c.b2cs,
    nil: c.nil,
    hsnB2b: c.hsnB2b,
    hsnB2c: c.hsnB2c,
    docs: c.docSeries.map(({ docIds: _ids, ...s }) => s),
    totals: gstr1Totals(c),
    issues: c.issues,
    notes: c.notes,
    excluded: c.excluded,
  };
}

function docRow(p: Placement, lines: readonly GstDocLine[], signOverride?: 1 | -1): Gstr1DocRow {
  const d = p.doc;
  const sign = signOverride ?? d.sign;
  const t = zeroTV();
  for (const l of lines) addTV(t, lineTV(l), sign);
  const exp = d.exportDetails;
  return {
    voucherId: d.id,
    voucherTypeName: d.voucherTypeName,
    baseType: d.baseType,
    number: d.number,
    date: d.date,
    partyName: d.party.name,
    gstin: d.party.gstin,
    pos: d.pos,
    posName: d.pos === POS_OTHER_COUNTRIES ? 'Other Countries' : posName(d.pos),
    invoiceValue: d.totalAmount,
    sign,
    reverseCharge: d.reverseCharge,
    noteType: d.isNote ? (d.noteType as 'C' | 'D') : null,
    invoiceType: p.invoiceType,
    exportType: p.exportType,
    cdnurType: p.cdnurType,
    shippingBill:
      p.exportType || p.cdnurType === 'EXPWP' || p.cdnurType === 'EXPWOP'
        ? { number: exp?.shippingBillNo ?? null, date: exp?.shippingBillDate ?? null, portCode: exp?.portCode ?? null }
        : null,
    originalInvoiceNo: d.originalInvoiceNo,
    originalInvoiceDate: d.originalInvoiceDate,
    nature: d.nature,
    rates: rateSplit(lines, sign),
    ...t,
  };
}

/** Voucher-level rows of one section. */
export function gstr1Section(c: Gstr1Computation, section: Gstr1SectionId): Gstr1SectionResult {
  const m = SECTION_META[section];
  const rows: Gstr1DocRow[] = [];
  const result: Gstr1SectionResult = {
    period: c.period,
    section,
    table: m.table,
    title: m.title,
    rows,
    totals: { ...zeroTV(), invoiceValue: 0 },
  };
  if (DOC_SECTIONS.has(section) || section === 'b2cs') {
    for (const p of c.placements) if (p.section === section) rows.push(docRow(p, p.taxable));
    if (section === 'b2cs') result.b2cs = c.b2cs;
  } else if (section === 'nil') {
    for (const p of c.placements) if (p.nil.length > 0) rows.push(docRow(p, p.nil));
    result.nil = c.nil;
  } else if (section === 'hsn_b2b' || section === 'hsn_b2c') {
    const wantB2b = section === 'hsn_b2b';
    for (const p of c.placements) {
      const lines = [...((p.hsnSide === 'b2b') === wantB2b ? p.taxable : []), ...(p.registered === wantB2b ? p.nil : [])];
      if (lines.length > 0) rows.push(docRow(p, lines));
    }
    result.hsn = wantB2b ? c.hsnB2b : c.hsnB2c;
  } else if (section === 'doc') {
    const byId = new Map<number, GstDoc>([...c.docs, ...c.cancelled].map((d) => [d.id, d]));
    for (const s of c.docSeries) {
      for (const id of s.docIds) {
        const d = byId.get(id);
        if (!d) continue;
        const p = c.placements.find((x) => x.doc.id === id) ?? placeOutward(d, null);
        rows.push(docRow(p, d.inBooks ? d.lines : []));
      }
    }
    result.docs = c.docSeries.map(({ docIds: _ids, ...s }) => s);
  }
  for (const r of rows) {
    addTV(result.totals, r);
    result.totals.invoiceValue += r.sign * r.invoiceValue;
  }
  return result;
}
