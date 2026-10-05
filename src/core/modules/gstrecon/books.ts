/**
 * Books side of the reconciliation: vouchers + gst_lines as written by the posting engine. Tax is never
 * recomputed — values are sums of gst_lines.
 *
 * Inward (GSTR-2A / 2B): purchases and purchase returns (debit notes; a credit note received from a
 * supplier is recorded as a debit note) from suppliers with a GSTIN.
 *   document no.  = reference_no (supplier invoice no.), else the voucher number
 *   document date = reference_date (supplier invoice date), else the voucher date
 *   left out: imports, unregistered / composition suppliers, documents with no taxable line (nil/exempt
 *   supplies are reported in summary tables, not invoice-wise).
 * Outward (GSTR-1): sales, credit notes and debit notes reported invoice-wise (B2B, SEZ, deemed export,
 *   B2CL, exports); document no./date = voucher number/date. B2CL and export documents have no
 *   counterparty GSTIN on the portal, so their GSTIN is ''.
 *
 * Books filter: affects_books = 1 AND (is_post_dated = 0 OR date <= :today).
 */
import { GST_NATURES, gstinStateCode, isOutwardNature, normalizeGstin, normalizeStateCode } from '../../../shared/gst/index.ts';
import type { GstNature } from '../../../shared/types/gst.ts';
import type { PortalDocType } from '../../../shared/types/gstrecon.ts';
import type { Db } from '../../db/db.ts';
import { periodOfDate } from './values.ts';

export type DocClass = 'inc' | 'dec';
export type Side = 'inward' | 'outward';

export interface BooksDoc {
  voucherId: number;
  baseType: string;
  voucherTypeName: string;
  number: string | null;
  voucherDate: string;
  docNo: string;
  docNoBasis: 'reference_no' | 'voucher_number';
  docDate: string;
  dateBasis: 'reference_date' | 'voucher_date';
  gstin: string;
  gstinFromLedger: boolean;
  partyLedgerId: number | null;
  partyName: string | null;
  pos: string | null;
  reverseCharge: boolean;
  cls: DocClass;
  docType: PortalDocType;
  nature: GstNature | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  eligible: { igst: number; cgst: number; sgst: number; cess: number };
  invoiceValue: number;
  rates: number[];
  period: string;
  updatedAt: string;
}

interface VoucherRow {
  id: number;
  base_type: string;
  vt_name: string;
  number: string | null;
  date: string;
  reference_no: string | null;
  reference_date: string | null;
  party_ledger_id: number | null;
  party_name: string | null;
  party_gstin: string | null;
  ledger_gstin: string | null;
  ledger_name: string | null;
  place_of_supply: string | null;
  is_reverse_charge: number;
  gst_nature: string | null;
  total_amount: number;
  original_invoice_no: string | null;
  updated_at: string;
}

interface LineRow {
  voucher_id: number;
  rate: number;
  taxability: string;
  itc_eligibility: string | null;
  is_reverse_charge: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

const NATURE_SET: ReadonlySet<string> = new Set(GST_NATURES);
const INWARD_EXCLUDED: ReadonlySet<string> = new Set(['import_goods', 'import_services', 'inward_unregistered', 'inward_composition', 'inward_nil_exempt']);
/** Outward natures reported document-wise in GSTR-1. */
const OUTWARD_DOC_NATURES: ReadonlySet<string> = new Set(['b2b', 'sez_wpay', 'sez_lut', 'deemed_export', 'b2cl', 'export_wpay', 'export_lut']);
const NO_CTIN_NATURES: ReadonlySet<string> = new Set(['b2cl', 'export_wpay', 'export_lut']);

function directionOf(baseType: string, nature: GstNature | null): Side {
  if (baseType === 'sales') return 'outward';
  if (baseType === 'purchase') return 'inward';
  if (nature) return isOutwardNature(nature) ? 'outward' : 'inward';
  return baseType === 'credit_note' ? 'outward' : 'inward';
}

const BASE_TYPES: Readonly<Record<Side, readonly string[]>> = {
  inward: ['purchase', 'debit_note', 'credit_note'],
  outward: ['sales', 'credit_note', 'debit_note'],
};

export interface LoadBooksOptions {
  side: Side;
  /** Document-date window (reference date for inward, voucher date for outward). */
  from?: string;
  to?: string;
  today: string;
  /** Load exactly these vouchers (no date window); still subject to the books filter and side. */
  voucherIds?: readonly number[];
}

/** Vouchers of one side, with their gst_lines totals. Sorted by document date, then voucher id. */
export function loadBooksDocs(db: Db, opts: LoadBooksOptions): BooksDoc[] {
  const types = BASE_TYPES[opts.side];
  const dateExpr = opts.side === 'inward' ? 'COALESCE(v.reference_date, v.date)' : 'v.date';
  const params: Record<string, string | number> = { today: opts.today, t0: types[0], t1: types[1], t2: types[2] };
  let where = `v.base_type IN (:t0, :t1, :t2) AND v.affects_books = 1 AND (v.is_post_dated = 0 OR v.date <= :today)`;
  if (opts.voucherIds) {
    if (opts.voucherIds.length === 0) return [];
    const ids = [...new Set(opts.voucherIds)].filter((n) => Number.isSafeInteger(n));
    where += ` AND v.id IN (SELECT value FROM json_each(:ids))`;
    params.ids = JSON.stringify(ids);
  } else {
    if (opts.from) {
      where += ` AND ${dateExpr} >= :from`;
      params.from = opts.from;
    }
    if (opts.to) {
      where += ` AND ${dateExpr} <= :to`;
      params.to = opts.to;
    }
  }
  const vouchers = db.all<VoucherRow>(
    `SELECT v.id, v.base_type, vt.name AS vt_name, v.number, v.date, v.reference_no, v.reference_date,
            v.party_ledger_id, v.party_name, v.party_gstin, l.gstin AS ledger_gstin, l.name AS ledger_name,
            v.place_of_supply, v.is_reverse_charge, v.gst_nature, v.total_amount, v.original_invoice_no, v.updated_at
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
      WHERE ${where}
      ORDER BY ${dateExpr}, v.id`,
    params,
  );
  if (vouchers.length === 0) return [];
  const lines = db.all<LineRow>(
    `SELECT g.voucher_id, g.rate, g.taxability, g.itc_eligibility, MAX(g.is_reverse_charge) AS is_reverse_charge,
            SUM(g.taxable_value) AS taxable, SUM(g.igst) AS igst, SUM(g.cgst) AS cgst, SUM(g.sgst) AS sgst, SUM(g.cess) AS cess
       FROM gst_lines g
      WHERE g.voucher_id IN (SELECT v.id FROM vouchers v WHERE ${where})
      GROUP BY g.voucher_id, g.rate, g.taxability, g.itc_eligibility`,
    params,
  );
  const byVoucher = new Map<number, LineRow[]>();
  for (const l of lines) {
    const list = byVoucher.get(l.voucher_id) ?? [];
    list.push(l);
    byVoucher.set(l.voucher_id, list);
  }

  const out: BooksDoc[] = [];
  for (const v of vouchers) {
    const nature = v.gst_nature && NATURE_SET.has(v.gst_nature) ? (v.gst_nature as GstNature) : null;
    if (directionOf(v.base_type, nature) !== opts.side) continue;
    const ls = byVoucher.get(v.id) ?? [];
    const taxableLines = ls.filter((l) => l.taxability === 'taxable');
    if (taxableLines.length === 0) continue;

    const snapshot = normalizeGstin(v.party_gstin);
    const ledgerGstin = normalizeGstin(v.ledger_gstin);
    let gstin = snapshot || ledgerGstin;
    const gstinFromLedger = !snapshot && !!ledgerGstin;
    if (opts.side === 'inward') {
      if (!gstin || (nature !== null && INWARD_EXCLUDED.has(nature))) continue;
    } else {
      if (nature !== null && !OUTWARD_DOC_NATURES.has(nature)) continue;
      if (nature === null && !gstin) continue;
      if (nature !== null && NO_CTIN_NATURES.has(nature)) gstin = '';
    }

    const inward = opts.side === 'inward';
    const docNoRaw = inward ? (v.reference_no ?? '').trim() : '';
    const docNo = docNoRaw || (v.number ?? '').trim();
    const docDate = inward && v.reference_date ? v.reference_date : v.date;

    let cls: DocClass = 'inc';
    let docType: PortalDocType = 'invoice';
    if (v.base_type === 'credit_note') {
      cls = 'dec';
      docType = 'credit_note';
    } else if (v.base_type === 'debit_note') {
      // Inward: a purchase return = the supplier's credit note. Outward: a debit note to the customer.
      cls = inward ? 'dec' : 'inc';
      docType = inward ? 'credit_note' : 'debit_note';
    } else if (inward && v.original_invoice_no) {
      docType = 'debit_note'; // a supplier's debit note booked as a purchase against an original invoice
    }

    let taxable = 0;
    let igst = 0;
    let cgst = 0;
    let sgst = 0;
    let cess = 0;
    const eligible = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const rates = new Set<number>();
    let rcmLine = false;
    for (const l of ls) {
      if (l.taxability === 'taxable') {
        taxable += l.taxable;
        if (l.taxable !== 0) rates.add(l.rate);
      }
      igst += l.igst;
      cgst += l.cgst;
      sgst += l.sgst;
      cess += l.cess;
      if (l.is_reverse_charge === 1) rcmLine = true;
      if (!inward || l.itc_eligibility !== 'ineligible') {
        eligible.igst += l.igst;
        eligible.cgst += l.cgst;
        eligible.sgst += l.sgst;
        eligible.cess += l.cess;
      }
    }
    const pos = normalizeStateCode(v.place_of_supply) || (inward ? null : gstin ? gstinStateCode(gstin) || null : null);

    out.push({
      voucherId: v.id,
      baseType: v.base_type,
      voucherTypeName: v.vt_name,
      number: v.number,
      voucherDate: v.date,
      docNo,
      docNoBasis: docNoRaw ? 'reference_no' : 'voucher_number',
      docDate,
      dateBasis: inward && v.reference_date ? 'reference_date' : 'voucher_date',
      gstin,
      gstinFromLedger,
      partyLedgerId: v.party_ledger_id,
      partyName: v.party_name ?? v.ledger_name,
      pos,
      reverseCharge: v.is_reverse_charge === 1 || rcmLine,
      cls,
      docType,
      nature,
      taxable,
      igst,
      cgst,
      sgst,
      cess,
      eligible,
      invoiceValue: v.total_amount,
      rates: [...rates].sort((a, b) => a - b),
      period: periodOfDate(docDate),
      updatedAt: v.updated_at,
    });
  }
  return out;
}

/** Latest updated_at among the vouchers a reconciliation of this side reads (stale-run detection). */
export function lastVoucherChange(db: Db, side: Side): string | null {
  const types = BASE_TYPES[side];
  return db.value<string>('SELECT MAX(updated_at) FROM vouchers WHERE base_type IN (:t0, :t1, :t2)', { t0: types[0], t1: types[1], t2: types[2] }) ?? null;
}
