/**
 * Pure presentation rules for printed documents (tested in layout.test.ts). Templates stay thin:
 * every decision about which columns, rows, labels and copies appear lives here.
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatIndianNumber, formatMoney, formatPercent, formatRate } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { InvoiceTemplate } from '../../../../shared/settings.ts';
import type { PrintAddress, PrintCopy, PrintLine, PrintPageSize, PrintVoucherData } from '../../../../shared/types/print.ts';
import { PRINT_COPIES } from '../../../../shared/types/print.ts';

// ───────────────────────────── Formatting ─────────────────────────────

/** '1,23,456.50' (Indian grouping). */
export const money = (p: Paise): string => formatMoney(p);
/** '' for zero, else money. */
export const moneyOrBlank = (p: Paise): string => (p === 0 ? '' : formatMoney(p));
/** '₹ 1,23,456.50'. */
export const rupees = (p: Paise): string => formatMoney(p, { symbol: true });
export const qtyText = (q: number | null, decimals: number): string => (q === null ? '' : formatIndianNumber(q, Math.max(0, Math.min(6, decimals))));
export const rateText = (r: number | null): string => (r === null ? '' : formatRate(r));
export const pctText = (r: number): string => formatPercent(r);
export const dateText = (iso: string | null | undefined): string => (iso ? formatDate(iso) : '');

// ───────────────────────────── Templates, page sizes, copies ─────────────────────────────

export const TEMPLATE_LABELS: Readonly<Record<InvoiceTemplate, string>> = {
  modern: 'Modern',
  classic: 'Classic (boxed)',
  compact: 'Compact receipt (80 mm)',
};

export const PAGE_SIZE_LABELS: Readonly<Record<PrintPageSize, string>> = { A4: 'A4', A5: 'A5', '80mm': '80 mm roll' };

export function isTemplate(x: unknown): x is InvoiceTemplate {
  return x === 'modern' || x === 'classic' || x === 'compact';
}

export function isPageSize(x: unknown): x is PrintPageSize {
  return x === 'A4' || x === 'A5' || x === '80mm';
}

/** Template to use: the requested one when valid, else the document's default. */
export function resolveTemplate(doc: Pick<PrintVoucherData, 'defaultTemplate'>, requested?: unknown): InvoiceTemplate {
  return isTemplate(requested) ? requested : doc.defaultTemplate;
}

/** Page size that goes with a template (compact receipts print on an 80 mm roll). */
export function pageSizeFor(template: InvoiceTemplate, requested?: unknown): PrintPageSize {
  if (template === 'compact') return '80mm';
  if (isPageSize(requested) && requested !== '80mm') return requested;
  return 'A4';
}

/** Template to use when the user picks a page size (80 mm forces the compact receipt). */
export function templateForPageSize(current: InvoiceTemplate, size: PrintPageSize, fallback: InvoiceTemplate): InvoiceTemplate {
  if (size === '80mm') return 'compact';
  if (current === 'compact') return fallback === 'compact' ? 'modern' : fallback;
  return current;
}

/**
 * Paper size the main process understands ('print.savePdf' / 'print.toPdf'). An 80 mm receipt is laid
 * out at 80 mm width inside an A4 PDF page (thermal printers take the width from the CSS layout).
 */
export function nativePageSize(size: PrintPageSize): 'A4' | 'A5' {
  return size === 'A5' ? 'A5' : 'A4';
}

/** Copies to print: requested (count 1–3 or list) or the configured copies; always in Original → Triplicate order. */
export function resolveCopies(doc: Pick<PrintVoucherData, 'options' | 'layout'>, requested?: unknown): PrintCopy[] {
  let list: PrintCopy[];
  if (typeof requested === 'number' && Number.isInteger(requested) && requested >= 1) {
    list = PRINT_COPIES.slice(0, Math.min(3, requested));
  } else if (Array.isArray(requested)) {
    list = PRINT_COPIES.filter((c) => requested.includes(c));
  } else {
    list = doc.layout === 'voucher' ? ['original'] : PRINT_COPIES.filter((c) => doc.options.copies.includes(c));
  }
  return list.length > 0 ? list : ['original'];
}

export function toggleCopy(copies: readonly PrintCopy[], copy: PrintCopy): PrintCopy[] {
  const next = copies.includes(copy) ? copies.filter((c) => c !== copy) : [...copies, copy];
  const ordered = PRINT_COPIES.filter((c) => next.includes(c));
  return ordered.length > 0 ? ordered : [...copies];
}

/** Copy label printed on the document; none for a single copy of an accounting voucher. */
export function copyLabel(doc: Pick<PrintVoucherData, 'copyLabels' | 'layout'>, copy: PrintCopy, total: number): string | null {
  if (doc.layout === 'voucher' && total <= 1) return null;
  return doc.copyLabels[copy];
}

// ───────────────────────────── Addresses ─────────────────────────────

/** Address lines (multi-line address kept), then 'State - PIN', then country when not India. */
export function addressLines(a: PrintAddress | null): string[] {
  if (!a) return [];
  const lines = (a.address ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const place = [a.stateName, a.pincode].filter(Boolean).join(' - ');
  if (place) lines.push(place);
  if (a.country && a.country.toLowerCase() !== 'india') lines.push(a.country);
  return lines;
}

/** Statutory identifiers of a party box as label/value pairs. */
export function partyIds(a: PrintAddress | null, showState = true): Array<{ label: string; value: string }> {
  if (!a) return [];
  const out: Array<{ label: string; value: string }> = [];
  if (a.gstin) out.push({ label: 'GSTIN/UIN', value: a.gstin });
  else if (a.registrationType === 'unregistered' || a.registrationType === 'consumer') out.push({ label: 'GSTIN/UIN', value: 'Unregistered' });
  if (a.pan) out.push({ label: 'PAN', value: a.pan });
  if (showState && a.stateName) out.push({ label: 'State', value: a.stateCode ? `${a.stateName}, Code ${a.stateCode}` : a.stateName });
  if (a.phone) out.push({ label: 'Phone', value: a.phone });
  if (a.email) out.push({ label: 'E-mail', value: a.email });
  return out;
}

/**
 * Label of the classic layout's buyer box: 'Consignee (Ship to) / Buyer (Bill to)' when the buyer is
 * also the ship-to, else the party label alone (supplier of a purchase, or a separate consignee box).
 */
export function partyBoxLabel(doc: Pick<PrintVoucherData, 'partyLabel' | 'consigneeLabel' | 'consigneeSameAsParty'>): string {
  if (!doc.consigneeSameAsParty || doc.partyLabel === doc.consigneeLabel) return doc.partyLabel;
  return `${doc.consigneeLabel} / ${doc.partyLabel}`;
}

// ───────────────────────────── Header references ─────────────────────────────

export interface LabelValue {
  label: string;
  value: string;
}

/** Number / date / place of supply / reverse charge / e-way bill / references for the header grid. */
export function headerRefs(doc: PrintVoucherData): LabelValue[] {
  const noLabel =
    doc.layout === 'voucher'
      ? 'Voucher No.'
      : doc.kind === 'credit_note' || doc.kind === 'debit_note'
        ? 'Note No.'
        : doc.kind === 'sales_order' || doc.kind === 'purchase_order'
          ? 'Order No.'
          : doc.kind === 'delivery_challan'
            ? 'Challan No.'
            : doc.kind === 'quotation'
              ? 'Quotation No.'
              : doc.kind === 'proforma_invoice'
                ? 'Proforma No.'
            : doc.layout === 'inventory'
              ? 'Voucher No.'
              : 'Invoice No.';
  const out: LabelValue[] = [
    { label: noLabel, value: doc.number ?? '—' },
    { label: 'Dated', value: dateText(doc.date) },
  ];
  if (doc.referenceNo) {
    const label = doc.baseType === 'purchase' || doc.baseType === 'debit_note' ? 'Supplier Invoice No.' : 'Reference No.';
    out.push({ label, value: doc.referenceDate ? `${doc.referenceNo} dated ${dateText(doc.referenceDate)}` : doc.referenceNo });
  }
  if (doc.originalInvoice) {
    out.push({ label: 'Against Invoice', value: doc.originalInvoice.date ? `${doc.originalInvoice.number} dated ${dateText(doc.originalInvoice.date)}` : doc.originalInvoice.number });
    if (doc.originalInvoice.reason) out.push({ label: 'Reason', value: doc.originalInvoice.reason });
  }
  if (doc.placeOfSupply && doc.layout !== 'voucher') out.push({ label: 'Place of Supply', value: doc.placeOfSupply.label });
  if (doc.layout === 'invoice' && doc.gst.showTax) out.push({ label: 'Reverse Charge', value: doc.reverseCharge ? 'Yes' : 'No' });
  if (doc.ewayBill) out.push({ label: 'e-Way Bill No.', value: doc.ewayBill.date ? `${doc.ewayBill.number} dated ${dateText(doc.ewayBill.date)}` : doc.ewayBill.number });
  return [...out, ...doc.references];
}

// ───────────────────────────── Item table columns ─────────────────────────────

export interface ItemColumns {
  hsn: boolean;
  batch: boolean;
  qty: boolean;
  rate: boolean;
  discount: boolean;
  /** Per-line taxable value + tax columns. */
  lineTax: boolean;
  /** Which tax heads the per-line / summary tables show. */
  igst: boolean;
  cgstSgst: boolean;
  cess: boolean;
  amount: boolean;
}

export function itemColumns(doc: PrintVoucherData, opts: { pageSize: PrintPageSize; template: InvoiceTemplate }): ItemColumns {
  const lines = doc.lines;
  const narrow = opts.pageSize !== 'A4';
  const priced = doc.layout !== 'inventory' || lines.some((l) => (l.rate ?? 0) !== 0 || l.amount !== 0);
  const heads = taxHeads(doc);
  return {
    hsn: lines.some((l) => !!l.hsnSac) || doc.gst.showTax,
    batch: lines.some((l) => !!l.batch),
    qty: lines.some((l) => l.qty !== null),
    rate: priced && lines.some((l) => l.rate !== null),
    discount: lines.some((l) => l.discount !== 0 || l.discountPct !== 0),
    lineTax: doc.layout === 'invoice' && doc.gst.showTax && doc.options.itemwiseTax && !narrow && opts.template !== 'compact',
    igst: heads.igst,
    cgstSgst: heads.cgstSgst,
    cess: heads.cess,
    amount: priced,
  };
}

/** Tax heads present on the document (by tax mode, plus any head with an amount). */
export function taxHeads(doc: PrintVoucherData): { igst: boolean; cgstSgst: boolean; cess: boolean } {
  const any = (f: (l: PrintLine) => number): boolean => doc.lines.some((l) => f(l) !== 0);
  return {
    igst: doc.gst.showTax && (doc.gst.taxMode === 'igst' || any((l) => l.igst)),
    cgstSgst: doc.gst.showTax && (doc.gst.taxMode === 'cgst_sgst' || doc.gst.taxMode === 'cgst_utgst' || any((l) => l.cgst + l.sgst)),
    cess: doc.gst.showTax && any((l) => l.cess),
  };
}

// ───────────────────────────── Totals ─────────────────────────────

export interface TotalRow {
  label: string;
  amount: Paise;
  kind: 'subtotal' | 'tax' | 'charge' | 'roundoff' | 'total';
}

/** Rows of the totals box: taxable value, tax heads, charges, round off, total. */
export function totalRows(doc: PrintVoucherData): TotalRow[] {
  const t = doc.totals;
  const rows: TotalRow[] = [];
  const hasAdjustments = t.tax !== 0 || t.charges !== 0 || t.roundOff !== 0;
  if (doc.layout === 'invoice' && hasAdjustments) rows.push({ label: doc.gst.showTax ? 'Taxable Value' : 'Sub Total', amount: t.taxable, kind: 'subtotal' });
  if (doc.gst.showTax) {
    if (t.cgst !== 0) rows.push({ label: 'CGST', amount: t.cgst, kind: 'tax' });
    if (t.sgst !== 0) rows.push({ label: doc.gst.sgstLabel, amount: t.sgst, kind: 'tax' });
    if (t.igst !== 0) rows.push({ label: 'IGST', amount: t.igst, kind: 'tax' });
    if (t.cess !== 0) rows.push({ label: 'Cess', amount: t.cess, kind: 'tax' });
  }
  for (const c of doc.charges) rows.push({ label: c.name, amount: c.amount, kind: 'charge' });
  if (t.roundOff !== 0) rows.push({ label: 'Round Off', amount: t.roundOff, kind: 'roundoff' });
  rows.push({ label: 'Total', amount: t.grandTotal, kind: 'total' });
  return rows;
}

/** Tax head rows for the classic (Tally) layout, with rates when a single rate applies. */
export function classicTaxRows(doc: PrintVoucherData): Array<{ label: string; rate: string; amount: Paise }> {
  if (!doc.gst.showTax) return [];
  const rates = (pick: (l: PrintLine) => number): string => {
    const set = new Set(doc.lines.filter((l) => pick(l) !== 0).map((l) => l.gstRate));
    if (set.size !== 1) return '';
    const r = [...set][0];
    return pctText(pick === igstOf ? r : r / 2);
  };
  const out: Array<{ label: string; rate: string; amount: Paise }> = [];
  const t = doc.totals;
  if (t.cgst !== 0) out.push({ label: 'CGST', rate: rates(cgstOf), amount: t.cgst });
  if (t.sgst !== 0) out.push({ label: doc.gst.sgstLabel, rate: rates(sgstOf), amount: t.sgst });
  if (t.igst !== 0) out.push({ label: 'IGST', rate: rates(igstOf), amount: t.igst });
  if (t.cess !== 0) out.push({ label: 'Cess', rate: '', amount: t.cess });
  return out;
}
const cgstOf = (l: PrintLine): number => l.cgst;
const sgstOf = (l: PrintLine): number => l.sgst;
const igstOf = (l: PrintLine): number => l.igst;

/** Short taxability label for rate columns ('' for taxable lines). */
export function taxabilityText(t: PrintLine['taxability']): string {
  return t === 'exempt' ? 'Exempt' : t === 'nil_rated' ? 'Nil' : t === 'non_gst' ? 'Non-GST' : '';
}

/**
 * Second line of a receipt item: 'HSN 1006 · GST 5%' (Rule 46: HSN and rate per line). The rate prints
 * on every taxed line, with or without an HSN code; absorbed charges show neither.
 */
export function compactLineInfo(l: PrintLine, showTax: boolean): string {
  if (l.absorbed) return 'Included in the taxable value';
  const parts: string[] = [];
  if (l.hsnSac) parts.push(`HSN ${l.hsnSac}`);
  if (showTax) parts.push(`GST ${l.taxability === 'taxable' ? pctText(l.gstRate) : taxabilityText(l.taxability)}`);
  return parts.join(' · ');
}

// ───────────────────────────── Vouchers ─────────────────────────────

/** Payment / receipt summary: the accounts paid/received and the cash/bank ledgers it went through. */
export function voucherSides(doc: PrintVoucherData): { accounts: string[]; through: string[] } {
  const accounts = doc.entries.filter((e) => !e.isCashBank).map((e) => e.ledgerName);
  const through = doc.entries.filter((e) => e.isCashBank).map((e) => e.ledgerName);
  return { accounts: [...new Set(accounts)], through: [...new Set(through)] };
}

// ───────────────────────────── Files ─────────────────────────────

/** 'Tax Invoice 12 - Acme Traders.pdf' with characters Windows forbids replaced. */
export function pdfFileName(doc: Pick<PrintVoucherData, 'title' | 'number' | 'party' | 'date'>): string {
  const parts = [doc.title, doc.number ?? dateText(doc.date)].filter(Boolean).join(' ');
  const party = doc.party?.name ? ` - ${doc.party.name}` : '';
  const name = `${parts}${party}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150);
  return `${name || 'Document'}.pdf`;
}

/** Window/document title of the printable HTML. */
export function documentTitle(docs: readonly Pick<PrintVoucherData, 'title' | 'number'>[]): string {
  if (docs.length === 1) return [docs[0].title, docs[0].number].filter(Boolean).join(' ');
  return `${docs.length} documents`;
}
