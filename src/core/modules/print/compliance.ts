/**
 * Statutory checks on a document about to be printed (tested in compliance.test.ts). They never block
 * printing: each problem becomes a plain-English line in PrintVoucherData.warnings ("Before you print").
 * Voucher entry already warns about most of these when saving; the print preview repeats them because
 * the user may have acknowledged the warning, or masters may have changed since.
 *
 * References (CGST Rules): 46(b) serial number of at most 16 characters (letters, digits, '-' and '/');
 * 46(d)/(e) recipient name, address, GSTIN — and for an unregistered recipient with a taxable value of
 * ₹50,000 or more, name, address and state with its code; 46(g) HSN (Notification 78/2020-CT: 4 digits
 * on B2B invoices up to ₹5 crore turnover, 6 digits on every invoice above); 46(n) place of supply;
 * proviso to 46 — export invoices carry the country of destination; 53(1)(g) credit / debit notes
 * carry the serial number and date of the invoice they adjust; 55(1)(a) challan serial number;
 * 48(4)/(5) — once e-invoicing applies, a B2B invoice / note without an IRN is not a valid invoice.
 */
import type { PrintDocKind, PrintVoucherData } from '../../../shared/types/print.ts';
import type { CompanyGstStatus } from './titles.ts';

/** B2C invoices with a taxable value at or above this need the recipient's address and state (Rule 46(e)). */
export const B2C_ADDRESS_THRESHOLD_PAISE = 50_000_00;

/** GSTN document number rule: 1–16 characters, letters, digits, '/' and '-'. */
const DOC_NO = /^[A-Za-z0-9/-]{1,16}$/;

/** Documents the company issues under GST that carry a GSTN serial number. */
const NUMBERED_KINDS: ReadonlySet<PrintDocKind> = new Set<PrintDocKind>([
  'tax_invoice',
  'bill_of_supply',
  'invoice_cum_bill_of_supply',
  'export_invoice',
  'sez_invoice',
  'self_invoice',
  'credit_note',
  'debit_note',
  'delivery_challan',
]);

/** Invoices / notes issued to a recipient (Rule 46 / 53 particulars apply). */
const RECIPIENT_KINDS: ReadonlySet<PrintDocKind> = new Set<PrintDocKind>([
  'tax_invoice',
  'bill_of_supply',
  'invoice_cum_bill_of_supply',
  'export_invoice',
  'sez_invoice',
  'credit_note',
  'debit_note',
]);

/** Documents that carry tax and so need HSN / place of supply. */
const TAX_KINDS: ReadonlySet<PrintDocKind> = new Set<PrintDocKind>([
  'tax_invoice',
  'invoice_cum_bill_of_supply',
  'export_invoice',
  'sez_invoice',
  'credit_note',
  'debit_note',
]);

export interface ComplianceContext {
  /** The company issues this document (outward supply, or a self invoice). */
  issuedByCompany: boolean;
  companyGst: CompanyGstStatus;
  /** F12 › GST › HSN digits (4 up to ₹5 crore turnover, 6 or 8 above). */
  hsnDigits: number;
  /** F11 › e-Invoicing is on: B2B invoices and notes need an IRN before they are issued. */
  einvoice: boolean;
}

/** Natures where a taxable line legitimately carries no tax (zero-rated supplies). */
const ZERO_RATED = new Set(['export_lut', 'export_wpay', 'sez_lut', 'sez_wpay']);

/** Kinds reported to the IRP when e-invoicing applies (B2B / export / SEZ invoices and notes; not bills of supply). */
const EINVOICE_KINDS: ReadonlySet<PrintDocKind> = new Set<PrintDocKind>([
  'tax_invoice',
  'invoice_cum_bill_of_supply',
  'export_invoice',
  'sez_invoice',
  'credit_note',
  'debit_note',
]);

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Problems with the statutory particulars of `doc`, written for an accountant. Empty when fine. */
export function complianceWarnings(
  doc: Pick<PrintVoucherData, 'kind' | 'layout' | 'number' | 'party' | 'placeOfSupply' | 'lines' | 'totals' | 'originalInvoice' | 'status' | 'gst' | 'einvoice'>,
  c: ComplianceContext,
): string[] {
  if (c.companyGst === 'unregistered' || !c.issuedByCompany || doc.status.cancelled || doc.status.optional) return [];
  const out: string[] = [];
  const kind = doc.kind;
  const docName = kind === 'credit_note' ? 'credit note' : kind === 'debit_note' ? 'debit note' : kind === 'delivery_challan' ? 'challan' : 'invoice';

  // Rule 46(b) / 55(1)(a): serial number.
  if (NUMBERED_KINDS.has(kind)) {
    const n = (doc.number ?? '').trim();
    if (n === '') {
      out.push(`This ${docName} has no number. A GST ${docName} must carry a serial number (CGST Rule 46): alter the voucher and give it one.`);
    } else if (!DOC_NO.test(n)) {
      out.push(
        `${docName[0].toUpperCase()}${docName.slice(1)} number ${n} is not valid for GST: it must have at most 16 characters — letters, digits, "-" and "/" only (CGST Rule 46). ` +
          'Change the numbering prefix / suffix of the voucher type.',
      );
    }
  }

  if (doc.layout !== 'invoice' || !RECIPIENT_KINDS.has(kind)) return out;

  // Rule 46(d) / (e): recipient particulars.
  const p = doc.party;
  if (p) {
    if (!p.gstin && (p.registrationType === 'regular' || p.registrationType === 'composition' || p.registrationType === 'sez')) {
      out.push(
        `The buyer${p.name ? ` ${p.name}` : ''} is marked as GST-registered but has no GSTIN. CGST Rule 46 requires the recipient's GSTIN: ` +
          'add it in the party ledger and alter the voucher, or mark the party unregistered.',
      );
    } else if (p.gstin) {
      if (!p.address) {
        out.push(`The buyer${p.name ? ` ${p.name}` : ''} is GST-registered but has no address. CGST Rule 46 requires the recipient's address: add it in the party ledger and alter the voucher.`);
      }
    } else if (doc.totals.taxable >= B2C_ADDRESS_THRESHOLD_PAISE && kind !== 'export_invoice') {
      const missing = [!p.name ? 'name' : null, !p.address ? 'address' : null, !p.stateCode ? 'state' : null].filter((x): x is string => x !== null);
      if (missing.length > 0) {
        out.push(
          `This ${docName} to an unregistered buyer is for ₹50,000 or more, so the buyer's name, address and state with its code must be printed (CGST Rule 46(e)). ` +
            `Missing: ${missing.join(', ')}. Add ${plural(missing.length, 'it', 'them')} in the party details of the voucher.`,
        );
      }
    }
  }

  // Proviso to Rule 46: export invoices name the country of destination.
  if (kind === 'export_invoice' && !(p?.country && p.country.trim().toLowerCase() !== 'india')) {
    out.push("The country of destination is not known for this export invoice. Set the buyer's country in the party ledger so it prints (proviso to CGST Rule 46).");
  }

  // Rule 48(4)/(5): with e-invoicing on, a B2B / export / SEZ invoice or note needs its IRN first.
  const b2bRecipient = !!p?.gstin || kind === 'export_invoice' || kind === 'sez_invoice';
  if (c.einvoice && c.companyGst === 'regular' && b2bRecipient && EINVOICE_KINDS.has(kind) && !doc.einvoice) {
    out.push(
      `This ${docName} has no IRN yet. With e-invoicing, a ${docName} to a registered buyer is valid only after it is reported to the IRP: ` +
        'generate the e-invoice (GST › e-Invoice) and print again so the IRN and QR code appear.',
    );
  }

  // A taxable line at 0% on a regular dealer's invoice usually means the GST rate is missing in the master.
  if (c.companyGst === 'regular' && !ZERO_RATED.has(doc.gst.nature ?? '')) {
    const noRate = doc.lines.filter((l) => !l.absorbed && l.taxability === 'taxable' && l.gstRate === 0 && l.taxableValue !== 0);
    if (noRate.length > 0) {
      const names = noRate.slice(0, 5).map((l) => `${l.sl} (${l.name})`);
      const more = noRate.length > 5 ? ` and ${noRate.length - 5} more` : '';
      out.push(
        `${plural(noRate.length, 'Line', 'Lines')} ${names.join(', ')}${more} ${plural(noRate.length, 'is', 'are')} taxable but ${plural(noRate.length, 'has', 'have')} no GST rate, so no tax was charged. ` +
          'If GST applies, set the rate in the stock item or ledger and alter the voucher; if the goods are exempt or nil-rated, mark them so.',
      );
    }
  }

  if (!TAX_KINDS.has(kind) || !doc.gst.showTax) return out;

  // Rule 46(n): place of supply.
  if (!doc.placeOfSupply) out.push('This invoice has no place of supply. Alter the voucher and choose the place of supply (CGST Rule 46).');

  // Rule 46(g) + Notification 78/2020-CT: HSN / SAC.
  const everyInvoice = c.hsnDigits >= 6;
  if (everyInvoice || b2bRecipient) {
    const min = Math.max(4, Math.min(8, Math.trunc(c.hsnDigits) || 4));
    const bad = doc.lines.filter((l) => {
      if (l.absorbed || l.taxableValue === 0 || l.taxability === 'non_gst') return false;
      const digits = (l.hsnSac ?? '').replace(/\D/g, '').length;
      return digits < (everyInvoice ? min : 4);
    });
    if (bad.length > 0) {
      const names = bad.slice(0, 5).map((l) => `${l.sl} (${l.name})`);
      const more = bad.length > 5 ? ` and ${bad.length - 5} more` : '';
      out.push(
        `HSN/SAC code missing or shorter than ${everyInvoice ? min : 4} digits on ${plural(bad.length, 'line', 'lines')} ${names.join(', ')}${more}. ` +
          'GST invoices must show it: set it in the stock item or ledger and save the voucher again.',
      );
    }
  }

  // Rule 53(1)(g): notes refer to the invoice they adjust.
  if ((kind === 'credit_note' || kind === 'debit_note') && !doc.originalInvoice) {
    out.push(`This ${docName} does not say which invoice it adjusts. Rule 53 requires the original invoice number and date: alter the voucher and fill in "Original invoice".`);
  }
  return out;
}
