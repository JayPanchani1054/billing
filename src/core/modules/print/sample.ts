/**
 * A sample sales invoice for the print-settings preview when the company has no sales yet. It uses
 * the real company profile and options and the GST engine, so it looks exactly like a real invoice.
 */
import { gstinCheckChar } from '../../../shared/gst/gstin.ts';
import { computeInvoice } from '../../../shared/gst/index.ts';
import { roundToUnit } from '../../../shared/money.ts';
import type { InvoiceLineInput } from '../../../shared/types/gst.ts';
import type { InvoicePrintOverrides, PrintLine, PrintVoucherData } from '../../../shared/types/print.ts';
import { amountInWords } from '../../../shared/words.ts';
import {
  address,
  bankDetails,
  companyGstStatus,
  invoiceTotals,
  mrpSummaryOf,
  placeOfSupply,
  printCompany,
  resolveOptions,
  summariseByHsn,
  summariseByRate,
  upiUri,
  type PrintEnv,
} from './data.ts';
import { copyLabels, documentTitle, partyLabels } from './titles.ts';

/** `mrp` in paise per unit (incl. GST): ₹599 and ₹699, above the selling price incl. GST (₹531 and ₹623.44). */
const SAMPLE_ITEMS: ReadonlyArray<{ name: string; hsn: string; qty: number; unit: string; rate: number; disc: number; gst: number; mrp: number }> = [
  { name: 'Steel Water Bottle 1 L', hsn: '7323', qty: 10, unit: 'Nos', rate: 450, disc: 0, gst: 18, mrp: 599_00 },
  { name: 'Basmati Rice 5 kg Bag', hsn: '1006', qty: 4, unit: 'Bag', rate: 625, disc: 5, gst: 5, mrp: 699_00 },
];

export function sampleGstin(stateCode: string): string {
  const first14 = `${stateCode}AAACS1234F1Z`;
  return first14 + gstinCheckChar(first14);
}

export function buildSampleData(env: PrintEnv, overrides?: InvoicePrintOverrides): PrintVoucherData {
  const options = resolveOptions(env, {}, overrides);
  const company = printCompany(env);
  const companyGst = companyGstStatus(env);
  const state = env.profile.stateCode ?? '27';
  const today = env.posting.today;
  const lines: InvoiceLineInput[] = SAMPLE_ITEMS.map((s, i) => ({
    key: `i${i}`,
    kind: 'item',
    description: s.name,
    qty: s.qty,
    rate: s.rate,
    discountPct: s.disc,
    taxability: 'taxable',
    gstRate: s.gst,
    hsnSac: s.hsn,
    supplyKind: 'goods',
    uqc: 'NOS',
  }));
  const comp = computeInvoice(lines, {
    direction: 'outward',
    invoiceDate: today,
    companyStateCode: state,
    companyRegistration: companyGst,
    partyRegistration: 'regular',
    partyStateCode: state,
    roundOff: { enabled: false, method: 'nearest', unit: 100 },
  });
  const ro = env.config.roundOff;
  const before = comp.totals.invoiceValueBeforeRound;
  const grand = ro.enabled && ro.unit > 1 ? roundToUnit(before, ro.unit, ro.method) : before;
  const printLines: PrintLine[] = comp.lines.map((cl, i) => ({
    sl: i + 1,
    kind: 'item',
    name: SAMPLE_ITEMS[i].name,
    description: null,
    hsnSac: cl.hsnSac || null,
    batch: null,
    qty: SAMPLE_ITEMS[i].qty,
    unit: SAMPLE_ITEMS[i].unit,
    qtyDecimals: 0,
    rate: SAMPLE_ITEMS[i].rate,
    discountPct: SAMPLE_ITEMS[i].disc,
    discount: cl.discount,
    amount: cl.postingAmount,
    taxableValue: cl.taxableValue,
    taxability: cl.taxability,
    gstRate: cl.rate,
    cessRate: cl.cessRate,
    cgst: cl.cgst,
    sgst: cl.sgst,
    igst: cl.igst,
    cess: cl.cess,
    tax: cl.tax,
    taxPayable: true,
    absorbed: false,
    reverseCharge: false,
    section: null,
    mrp: SAMPLE_ITEMS[i].mrp,
  }));
  const totals = invoiceTotals(printLines, [], grand - before);
  const showTax = companyGst === 'regular' && comp.taxMode !== 'none';
  const title = documentTitle({
    baseType: 'sales',
    layout: 'invoice',
    companyGst,
    direction: 'outward',
    nature: comp.nature,
    hasTaxedLine: showTax,
    hasUntaxedLine: false,
    exportWithPayment: false,
    partyRegistration: 'regular',
  });
  const party = address({
    name: 'Sample Customer Pvt Ltd',
    address: '21, Industrial Estate, Phase II',
    pincode: env.profile.pincode,
    stateCode: state,
    gstin: companyGst === 'unregistered' ? null : sampleGstin(state),
    registrationType: 'regular',
  });
  const labels = partyLabels('sales', 'outward');
  const bank = options.showBankDetails ? bankDetails(env.db, options.bankLedgerId) : null;
  const upiId = options.upiId.trim() || bank?.upiId || '';
  const note = `${title.title} SAMPLE-1`;
  return {
    id: 0,
    sample: true,
    layout: 'invoice',
    kind: title.kind,
    baseType: 'sales',
    voucherTypeId: 0,
    voucherTypeName: 'Sales',
    title: title.title,
    endorsement: title.endorsement,
    notes: title.notes,
    number: 'SAMPLE-1',
    date: today,
    referenceNo: null,
    referenceDate: null,
    status: { cancelled: false, cancelReason: null, optional: false, postDated: false },
    company,
    partyLabel: labels.party,
    party,
    consigneeLabel: labels.consignee,
    consignee: party,
    consigneeSameAsParty: true,
    placeOfSupply: placeOfSupply(state),
    reverseCharge: false,
    gst: { showTax, taxMode: comp.taxMode, interState: comp.interState, sgstLabel: comp.taxMode === 'cgst_utgst' ? 'UTGST' : 'SGST', nature: comp.nature },
    lines: printLines,
    charges: [],
    taxByRate: showTax ? summariseByRate(printLines) : [],
    taxByHsn: companyGst !== 'unregistered' ? summariseByHsn(printLines) : [],
    totals,
    amountInWords: amountInWords(totals.grandTotal),
    taxInWords: showTax && totals.tax > 0 ? amountInWords(totals.tax) : null,
    entries: [],
    narration: null,
    originalInvoice: null,
    references: [
      { label: "Buyer's Order No.", value: 'PO-0042' },
      { label: 'Dispatched through', value: 'Road' },
    ],
    einvoice: null,
    ewayBill: null,
    bank,
    upi:
      options.showUpiQr && upiId
        ? { id: upiId, payeeName: company.displayName, amount: totals.grandTotal, note, uri: upiUri({ id: upiId, payeeName: company.displayName, amount: totals.grandTotal, note }) }
        : null,
    declaration: options.declaration.trim() || null,
    terms: options.terms.trim() || null,
    signatoryLabel: options.signatoryLabel.trim() || 'Authorised Signatory',
    copyLabels: copyLabels(title.kind, true, true),
    options,
    defaultTemplate: options.template,
    mrpSummary: mrpSummaryOf(printLines, options.showMrp, 'invoice', true),
    navigation: { prevId: null, nextId: null },
    warnings: [],
  };
}
