/**
 * "Uncertain transactions": checks that find documents the GST portal would reject or that would make
 * a return wrong. Shared by GSTR-1 (outward), gst.exceptions (outward + inward) and GSTR-3B (count).
 * Every issue names the voucher and says how to fix it.
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import {
  B2CL_THRESHOLD_BEFORE_2024_08_PAISE,
  B2CL_THRESHOLD_REVISED_ON,
  isStandardRate,
  validateGstin,
} from '../../../shared/gst/index.ts';
import type { GstIssue, GstIssueCode, Gstr1SectionId } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import type { GstCompany, GstDoc, GstDocLine } from './docs.ts';
import { docLabel, taxTotal } from './docs.ts';

const inr = (p: number): string => formatMoney(p, { symbol: true });

/** GSTN document number rule (GSTR-1 and e-invoice): ≤ 16 characters, letters, digits, '/' and '-'. */
export const DOC_NO_RE = /^[A-Za-z0-9/-]{1,16}$/;

export function docNumberProblem(no: string | null): string | null {
  if (no === null || no.trim() === '') return 'has no document number';
  const n = no.trim();
  if (n.length > 16) return `number "${n}" is longer than 16 characters`;
  if (!DOC_NO_RE.test(n)) return `number "${n}" contains characters other than letters, digits, '/' and '-'`;
  if (!/[1-9A-Za-z]/.test(n)) return `number "${n}" has no letter or non-zero digit`;
  return null;
}

/** HSN/SAC problem for a line: missing, shorter than required, or malformed. */
export function hsnProblem(l: GstDocLine, minDigits: number): { code: 'hsn_missing' | 'hsn_short' | 'hsn_invalid'; text: string } | null {
  const h = l.hsn;
  if (!h) return { code: 'hsn_missing', text: 'has no HSN/SAC' };
  if (!/^\d+$/.test(h)) return { code: 'hsn_invalid', text: `HSN/SAC "${h}" must contain digits only` };
  if (h.length < minDigits) return { code: 'hsn_short', text: `HSN/SAC "${h}" has ${h.length} digits; at least ${minDigits} are required` };
  if (h.length !== 4 && h.length !== 6 && h.length !== 8) return { code: 'hsn_invalid', text: `HSN/SAC "${h}" must have 4, 6 or 8 digits` };
  if (l.supplyType === 'services' && !h.startsWith('99')) return { code: 'hsn_invalid', text: `"${h}" is marked as a service but SAC codes start with 99` };
  return null;
}

export function issue(
  d: GstDoc | null,
  code: GstIssueCode,
  severity: GstIssue['severity'],
  message: string,
  fix: string,
  section: Gstr1SectionId | null = null,
): GstIssue {
  return {
    code,
    severity,
    voucherId: d?.id ?? null,
    voucherNumber: d?.number ?? null,
    voucherTypeName: d?.voucherTypeName ?? null,
    date: d?.date ?? null,
    partyName: d?.party.name ?? null,
    section,
    message,
    fix,
  };
}

const lineList = (lines: readonly GstDocLine[]): string => {
  const nos = lines.map((l) => l.lineNo);
  return nos.length === 1 ? `line ${nos[0]}` : `lines ${nos.slice(0, 5).join(', ')}${nos.length > 5 ? ` and ${nos.length - 5} more` : ''}`;
};

const REGISTERED_SECTIONS: ReadonlySet<Gstr1SectionId> = new Set(['b2b', 'b2b_rcm', 'sez_wp', 'sez_wop', 'de', 'cdnr']);
const B2C_SECTIONS: ReadonlySet<Gstr1SectionId> = new Set(['b2cl', 'b2cs', 'cdnur']);

/** Statutory B2CL threshold for an invoice date (configured value from 1-Aug-2024). */
export function b2clThreshold(company: GstCompany, date: string): number {
  return date < B2CL_THRESHOLD_REVISED_ON ? B2CL_THRESHOLD_BEFORE_2024_08_PAISE : company.config.gst.b2clThresholdPaise;
}

export interface OutwardCheckContext {
  /** Section of the document's taxable lines (null when only nil/exempt lines or not reported). */
  section: Gstr1SectionId | null;
  /** Credit/debit note: original invoice found in the books (null when not a note). */
  originalFound: boolean | null;
}

/** Checks for one outward document that is reported in GSTR-1. */
export function outwardIssues(d: GstDoc, company: GstCompany, cx: OutwardCheckContext): GstIssue[] {
  const out: GstIssue[] = [];
  const sec = cx.section;
  const label = docLabel(d);
  const valued = d.lines.filter((l) => l.taxable !== 0 || taxTotal(l) !== 0);

  const noProblem = docNumberProblem(d.number);
  if (noProblem) {
    out.push(
      issue(
        d,
        d.number ? 'doc_no_invalid' : 'doc_no_missing',
        'error',
        `${label} ${noProblem}. GSTN accepts up to 16 letters, digits, '/' and '-'.`,
        'Alter the voucher number (or the voucher type numbering prefix/suffix) so it fits the GSTN format.',
        sec,
      ),
    );
  }

  if (sec !== null && REGISTERED_SECTIONS.has(sec)) {
    if (!d.party.gstin) {
      out.push(
        issue(
          d,
          'gstin_missing',
          'error',
          `${label} is reported as a supply to a registered person but the party has no GSTIN.`,
          `Enter the GSTIN in the party ledger "${d.party.ledgerName ?? d.party.name ?? ''}" (or change its registration type to Unregistered) and re-save the voucher.`,
          sec,
        ),
      );
    } else {
      const g = validateGstin(d.party.gstin);
      if (!g.valid) {
        out.push(
          issue(
            d,
            'gstin_invalid',
            'error',
            `${label}: party GSTIN ${d.party.gstin} is invalid — ${g.error ?? 'check it'}.`,
            'Correct the GSTIN in the party ledger and re-save the voucher (the voucher keeps a copy of the GSTIN).',
            sec,
          ),
        );
      }
    }
  }

  if (sec !== null && B2C_SECTIONS.has(sec) && d.party.gstin && validateGstin(d.party.gstin).valid) {
    out.push(
      issue(
        d,
        'b2c_with_gstin',
        'warning',
        `${label} is reported as B2C although the party has GSTIN ${d.party.gstin}; the buyer will not get credit for it.`,
        'If the buyer is registered, set the party ledger registration type to Regular and re-save the voucher.',
        sec,
      ),
    );
  }

  if (!d.pos && d.nature !== 'export_wpay' && d.nature !== 'export_lut') {
    out.push(
      issue(
        d,
        'pos_missing',
        'error',
        `${label} has no place of supply.`,
        'Set the place of supply on the voucher (or the state in the party ledger) and re-save it.',
        sec,
      ),
    );
  }

  if (d.isNote) {
    if (!d.originalInvoiceNo) {
      out.push(
        issue(
          d,
          'note_without_original',
          'warning',
          `${label} does not refer to an original invoice.`,
          'Enter the original invoice number and date on the note: they decide whether an unregistered-party note goes to CDNUR (B2CL / export) or is netted in B2CS, and are needed by the buyer and for audit.',
          sec,
        ),
      );
    } else if (cx.originalFound === false) {
      out.push(
        issue(
          d,
          'note_without_original',
          'warning',
          `${label} refers to invoice ${d.originalInvoiceNo}${d.originalInvoiceDate ? ` dated ${formatDate(d.originalInvoiceDate)}` : ''}, which is not in the books.`,
          'Check the original invoice number and date on the note.',
          sec,
        ),
      );
    }
  }

  const hsnByCode = new Map<string, { lines: GstDocLine[]; text: string; code: 'hsn_missing' | 'hsn_short' | 'hsn_invalid' }>();
  for (const l of valued) {
    const p = hsnProblem(l, company.config.gst.hsnDigits);
    if (!p) continue;
    const e = hsnByCode.get(p.code) ?? { lines: [], text: p.text, code: p.code };
    e.lines.push(l);
    hsnByCode.set(p.code, e);
  }
  for (const e of hsnByCode.values()) {
    out.push(
      issue(
        d,
        e.code,
        e.code === 'hsn_invalid' ? 'warning' : 'error',
        `${label}: ${lineList(e.lines)} ${e.lines.length === 1 ? e.text : e.text.replace(/^has/, 'have')}${e.lines.length > 1 && e.code !== 'hsn_missing' ? ' (first one shown)' : ''}.`,
        `Enter a ${company.config.gst.hsnDigits}-digit (or longer) HSN/SAC in the stock item or ledger and re-save the voucher. Table 12 (HSN summary) needs it.`,
        sec,
      ),
    );
  }

  const badRates = valued.filter((l) => l.taxability === 'taxable' && !isStandardRate(l.rate));
  if (badRates.length > 0) {
    out.push(
      issue(
        d,
        'rate_not_slab',
        'error',
        `${label}: ${lineList(badRates)} use${badRates.length === 1 ? 's' : ''} ${badRates[0].rate}% which is not a GST rate.`,
        'Correct the GST rate in the stock item / ledger (or the line override) and re-save the voucher.',
        sec,
      ),
    );
  }

  const zeroRated = d.nature.startsWith('export') || d.nature.startsWith('sez');
  if (!zeroRated && d.pos) {
    const wrong = valued.filter((l) => (d.interState ? l.cgst !== 0 || l.sgst !== 0 : l.igst !== 0));
    if (wrong.length > 0) {
      out.push(
        issue(
          d,
          'tax_head_mismatch',
          'error',
          d.interState
            ? `${label} is an inter-state supply (place of supply ${d.pos}) but charges CGST/SGST.`
            : `${label} is an intra-state supply (place of supply ${d.pos}) but charges IGST.`,
          'Check the place of supply and the party state, then re-save the voucher so the tax is recomputed.',
          sec,
        ),
      );
    }
  }

  if (d.lines.length === 0 && d.totalAmount !== 0 && company.registration === 'regular') {
    out.push(
      issue(
        d,
        'no_gst_lines',
        'error',
        `${label} has no GST details, so it is missing from every GST table.`,
        'Open the voucher and re-save it (or set GST details on its sales ledger) so its GST lines are recorded.',
        sec,
      ),
    );
  }

  if ((d.nature === 'export_wpay' || d.nature === 'export_lut') && !d.isNote) {
    const e = d.exportDetails;
    if (!e?.shippingBillNo || !e.shippingBillDate || !e.portCode) {
      out.push(
        issue(
          d,
          'export_shipping_bill_missing',
          'warning',
          `${label} is an export without complete shipping bill details (number, date, port code).`,
          'Add the shipping bill number, date and 6-character port code under Export details once available — needed for the IGST refund / LUT reconciliation.',
          sec,
        ),
      );
    }
  }

  // Negative values per rate (a credit/discount line larger than the goods) cannot be filed.
  const perRate = new Map<number, number>();
  for (const l of d.lines) if (l.taxability === 'taxable') perRate.set(l.rate, (perRate.get(l.rate) ?? 0) + l.taxable);
  if ([...perRate.values()].some((v) => v < 0)) {
    out.push(
      issue(
        d,
        'negative_value',
        'error',
        `${label} has a negative taxable value at some rate.`,
        'Apply discounts on the items instead of a separate negative line, or issue a credit note.',
        sec,
      ),
    );
  }

  if (!d.isNote && (d.nature === 'b2cs' || d.nature === 'b2cl')) {
    const t = b2clThreshold(company, d.date);
    const shouldBeB2cl = d.interState && d.totalAmount > t;
    if (shouldBeB2cl !== (d.nature === 'b2cl')) {
      out.push(
        issue(
          d,
          'nature_mismatch',
          'warning',
          `${label} (${inr(d.totalAmount)}, ${d.interState ? 'inter-state' : 'intra-state'}) is classified ${d.nature.toUpperCase()} but the B2CL rule (inter-state and above ${inr(t)}) says ${shouldBeB2cl ? 'B2CL' : 'B2CS'}.`,
          'Re-save the voucher so its GST classification is recomputed.',
          sec,
        ),
      );
    }
  }
  return out;
}

/** Last day ITC on an invoice can be taken (s.16(4) as amended 2022): 30 November after the invoice's financial year. */
export function itcDeadline(invoiceDate: string): string {
  const y = Number(invoiceDate.slice(0, 4));
  const m = Number(invoiceDate.slice(5, 7));
  const fyEndYear = m >= 4 ? y + 1 : y;
  return `${fyEndYear}-11-30`;
}

/** Ids of vouchers (among `ids`) that post to a reverse-charge liability ledger. */
export function vouchersWithRcmLiability(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db.all<{ voucher_id: number }>(
    `SELECT DISTINCT le.voucher_id FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
      WHERE le.voucher_id IN (SELECT value FROM json_each(:ids))
        AND (l.gst_tax_direction = 'rcm_liability' OR l.reserved_code LIKE 'RCM\\_%' ESCAPE '\\')`,
    { ids: JSON.stringify(ids) },
  );
  return new Set(rows.map((r) => r.voucher_id));
}

export function isRcmInward(d: GstDoc): boolean {
  return d.direction === 'inward' && (d.reverseCharge || d.nature === 'inward_rcm' || d.nature === 'import_services');
}

/** Checks for one inward document (purchase / purchase return). */
export function inwardIssues(d: GstDoc, rcmLiability: ReadonlySet<number>): GstIssue[] {
  const out: GstIssue[] = [];
  const label = docLabel(d);
  const tax = d.lines.reduce((s, l) => s + taxTotal(l), 0);
  const eligibleTax = d.lines.filter((l) => l.itcEligibility !== 'ineligible').reduce((s, l) => s + taxTotal(l), 0);
  const imports = d.nature === 'import_goods' || d.nature === 'import_services' || d.party.registration === 'overseas';

  if (d.baseType === 'purchase' && (!d.referenceNo || !d.referenceDate)) {
    out.push(
      issue(
        d,
        'supplier_invoice_missing',
        tax !== 0 ? 'error' : 'warning',
        `${label} has no supplier invoice ${!d.referenceNo && !d.referenceDate ? 'number and date' : !d.referenceNo ? 'number' : 'date'}.`,
        imports
          ? 'Enter the bill of entry / supplier invoice number and date in the reference fields: GSTR-2B matching and ITC need them.'
          : "Enter the supplier's invoice number and date in the voucher's reference fields: GSTR-2B matching and ITC need them.",
      ),
    );
  }

  if (d.party.gstin && !imports) {
    const g = validateGstin(d.party.gstin);
    if (!g.valid) {
      out.push(
        issue(
          d,
          'supplier_gstin_invalid',
          'error',
          `${label}: supplier GSTIN ${d.party.gstin} is invalid — ${g.error ?? 'check it'}.`,
          'Correct the GSTIN in the supplier ledger and re-save the voucher; ITC cannot be matched with GSTR-2B otherwise.',
        ),
      );
    }
  } else if (!imports && !isRcmInward(d) && eligibleTax !== 0 && d.nature !== 'inward_sez') {
    out.push(
      issue(
        d,
        'itc_without_gstin',
        'error',
        `${label} claims ${inr(eligibleTax)} input tax from a supplier without a GSTIN.`,
        'Enter the supplier GSTIN in the ledger, or mark the supplier Unregistered so no tax is charged.',
      ),
    );
  }

  if (isRcmInward(d) && d.baseType === 'purchase') {
    if (tax === 0 && d.lines.some((l) => l.taxability === 'taxable' && l.rate > 0)) {
      out.push(
        issue(
          d,
          'rcm_without_liability',
          'error',
          `${label} is under reverse charge but no tax was computed on it.`,
          'Re-save the voucher with reverse charge on so the RCM tax and liability are recorded.',
        ),
      );
    } else if (tax !== 0 && !rcmLiability.has(d.id)) {
      out.push(
        issue(
          d,
          'rcm_without_liability',
          'error',
          `${label} is under reverse charge but posts no reverse-charge tax liability.`,
          'Re-save the voucher: the tax must be credited to the "Payable (Reverse Charge)" ledgers and paid in cash in GSTR-3B.',
        ),
      );
    }
  }

  if (d.baseType === 'purchase' && eligibleTax !== 0) {
    const invDate = d.referenceDate ?? d.date;
    const deadline = itcDeadline(invDate);
    if (d.date > deadline) {
      out.push(
        issue(
          d,
          'itc_time_limit',
          'warning',
          `${label}: ITC on an invoice dated ${formatDate(invDate)} could be taken only up to ${formatDate(deadline)} (s.16(4)).`,
          'Mark the ITC as ineligible on this purchase, or report it in GSTR-3B 4(D)(2).',
        ),
      );
    }
  }

  const badRates = d.lines.filter((l) => l.taxability === 'taxable' && l.taxable !== 0 && !isStandardRate(l.rate));
  if (badRates.length > 0) {
    out.push(
      issue(
        d,
        'rate_not_slab',
        'warning',
        `${label}: ${lineList(badRates)} use${badRates.length === 1 ? 's' : ''} ${badRates[0].rate}% which is not a GST rate.`,
        'Correct the GST rate in the stock item / ledger and re-save the voucher.',
      ),
    );
  }
  return out;
}

export function sortIssues(issues: GstIssue[]): GstIssue[] {
  return issues.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      (a.date ?? '').localeCompare(b.date ?? '') ||
      (a.voucherId ?? 0) - (b.voucherId ?? 0) ||
      a.code.localeCompare(b.code),
  );
}
