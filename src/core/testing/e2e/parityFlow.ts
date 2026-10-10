/**
 * The Tally-parity business flows shared by the Playwright spec e2e/parity.spec.ts (which runs these
 * calls through `window.pevqori.api` in the built app, then drives the screens) and its API-level twin
 * parity.test.ts (which runs them through runtime.dispatch in `npm test`). One copy of every master,
 * input and expected figure, so the UI flow and its twin cannot drift apart.
 *
 * Pure data + calls through the `ApiCall` it is given: no imports at runtime (the Playwright spec
 * loads this file too).
 *
 * Figures (all paise; GST 18 % intra-state = CGST 9 % + SGST 9 %):
 *   Quotation → Sales 1: 10 Nos × ₹100.00 = ₹1,000.00 + ₹90.00 + ₹90.00 = ₹1,180.00.
 *   POS bill: 1 Nos scanned at ₹100.00 + ₹18.00 GST = ₹118.00; UPI ₹50.00 + cash ₹68.00; cash handed
 *     over ₹100.00 → change ₹32.00.
 *   Purchase with TDS: Contract Charges ₹40,000.00 + CGST ₹3,600.00 + SGST ₹3,600.00 = ₹47,200.00;
 *     194C, deductee a firm: 2 % × ₹40,000.00 = ₹800.00 TDS; the contractor is credited ₹46,400.00.
 *   Export invoice under LUT: US$ 2,000.00 @ ₹83.00 = ₹1,66,000.00, no IGST (zero-rated, s.16 IGST Act).
 *   Manufacturing Journal from the BOM (1 Bolt Kit = 5 Steel Bolt M8): 2 kits consume 10 bolts at the
 *     ₹60.00 average cost = ₹600.00 → ₹300.00 per kit.
 *   Cheque: Payment of ₹25,000.00 from HDFC Bank → leaf 001001, "Twenty Five Thousand Only".
 */

/** A route call that returns the data or throws (spec: window.pevqori.api; twin: runtime.dispatch). */
export type ApiCall = <T>(route: string, input?: unknown) => Promise<T>;

/** Rupees → paise for the 2-decimal literals below. */
const P = (rupees: number): number => Math.round(rupees * 100);

export const PARITY = {
  /** The twin's fixed working date (the Playwright spec uses the real date). */
  today: '2026-10-09',
  company: { name: 'Parity Traders E2E', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra', stateCode: '27', pan: 'AAPFU0939F' },
  /** F11 features this flow switches on (beyond the wizard's defaults: stock, bill-wise, GST). */
  features: ['tds', 'multiCurrency', 'chequePrinting', 'manufacturing', 'pos'] as const,
  customer: { name: 'Kavya Traders', gstin: '27AAAPA0002A1Z5' },
  item: { name: 'Steel Bolt M8', unit: 'Nos', hsn: '7318', gstRate: 18, barcode: '8901030865278', mrp: P(150), sellingPrice: P(100), openingQty: 100, openingRate: 60 },
  quotation: { qty: 10, rate: 100, total: P(1_180), taxable: P(1_000) },
  pos: { qty: 1, total: P(118), upi: P(50), cash: P(68), tendered: P(100), change: P(32), upiMode: 'UPI' },
  bank: { name: 'HDFC Bank' },
  tds: {
    supplier: 'Sharma Contractors',
    supplierGstin: '27ABCFS1234C1ZO',
    pan: 'ABCFS1234C',
    tan: 'MUMS12345A',
    expense: 'Contract Charges',
    sac: '995411',
    supplierInvoiceNo: 'SC/101',
    amount: P(40_000),
    tds: P(800),
    total: P(47_200),
    partyCredit: P(46_400),
    section: '194C',
  },
  forex: {
    customer: 'Pacific Retail LLC',
    country: 'United States',
    ledger: 'Export of Services',
    sac: '998314',
    currency: { symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2 },
    amount: 2000,
    rate: 83,
    inr: P(166_000),
    lut: 'AD270426000123X',
  },
  kit: { name: 'Bolt Kit', perKit: 5, qty: 2, consumed: 10, cost: P(600) },
  cheque: { payee: 'Gupta Stationers', amount: P(25_000), fromNo: 1001, toNo: 1025, leaf: '001001', words: 'Twenty Five Thousand Only', figures: '**25,000.00/-' },
} as const;

/** Ids of the masters seeded by seedParityMasters. */
export interface ParityMasters {
  groups: Record<string, number>;
  /** Predefined voucher type id by base type ('sales', 'purchase', 'payment', 'quotation', …). */
  types: Record<string, number>;
  customer: number;
  item: number;
  kit: number;
  bom: number;
  bank: number;
  upiMode: number;
  supplier: number;
  expense: number;
  usd: number;
  overseas: number;
  exportSales: number;
  payee: number;
}

/** First and last day of the financial year (April–March) containing `iso`. */
export function financialYearOf(iso: string): { from: string; to: string } {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

interface Row {
  id: number;
  name: string;
}

/**
 * The masters of the flows, created through the API (allowed in e2e: it goes through the real IPC
 * and core). Run after the company is created and PARITY.features are on.
 */
export async function seedParityMasters(call: ApiCall, today: string): Promise<ParityMasters> {
  const groupRows = (await call<{ rows: Row[] }>('accounts.group.list', {})).rows;
  const groups: Record<string, number> = {};
  for (const g of groupRows) groups[g.name] = g.id;
  const gid = (name: string): number => {
    const id = groups[name];
    if (!id) throw new Error(`Group "${name}" is missing`);
    return id;
  };
  const types: Record<string, number> = {};
  for (const t of (await call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {})).rows) {
    if (t.isPredefined && types[t.baseType] === undefined) types[t.baseType] = t.id;
  }
  const units = (await call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {})).rows;
  const nos = units.find((u) => u.symbol === PARITY.item.unit);
  if (!nos) throw new Error('Unit Nos is missing');

  // Main Location (predefined): opening stock names its godown once Multiple godowns is on.
  const godowns = (await call<{ rows: Array<{ id: number; isPredefined: boolean }> }>('inventory.godown.list', {})).rows;
  const main = godowns.find((g) => g.isPredefined)?.id;
  if (!main) throw new Error('Main Location is missing');

  const customer = (await call<Row>('accounts.ledger.save', { name: PARITY.customer.name, groupId: gid('Sundry Debtors'), gstin: PARITY.customer.gstin, stateCode: '27', registrationType: 'regular' })).id;
  const item = (
    await call<{ item: Row }>('inventory.item.save', {
      name: PARITY.item.name,
      unitId: nos.id,
      gstApplicable: true,
      taxability: 'taxable',
      gstRate: PARITY.item.gstRate,
      hsnSac: PARITY.item.hsn,
      barcode: PARITY.item.barcode,
      mrp: PARITY.item.mrp,
      sellingPrice: PARITY.item.sellingPrice,
      openings: [{ qty: PARITY.item.openingQty, rate: PARITY.item.openingRate, godownId: main }],
    })
  ).item.id;
  const kit = (await call<{ item: Row }>('inventory.item.save', { name: PARITY.kit.name, unitId: nos.id, gstApplicable: true, taxability: 'taxable', gstRate: PARITY.item.gstRate, hsnSac: PARITY.item.hsn })).item.id;
  const bom = (await call<Row>('mfg.bom.save', { itemId: kit, name: 'Standard', outputQty: 1, lines: [{ kind: 'component', itemId: item, qty: PARITY.kit.perKit }] })).id;

  // Bank: UPI tender of the POS counter and the cheque book.
  const bank = (await call<Row>('accounts.ledger.save', { name: PARITY.bank.name, groupId: gid('Bank Accounts') })).id;
  const upiMode = (await call<Row>('pos.tenderMode.save', { name: PARITY.pos.upiMode, kind: 'upi', ledgerId: bank })).id;
  // The e2e run must never wait on an OS print dialog: no receipt printing after a POS bill.
  await call('pos.settings.save', { printAfterSave: false });
  await call('cheques.book.save', { bankLedgerId: bank, fromNo: PARITY.cheque.fromNo, toNo: PARITY.cheque.toNo, digits: 6 });
  const payee = (await call<Row>('accounts.ledger.save', { name: PARITY.cheque.payee, groupId: gid('Sundry Creditors'), billWise: false })).id;

  // TDS: deductor, a firm as deductee, Contract Charges under 194C.
  await call('tds.settings.save', { tan: PARITY.tds.tan, deductorCategory: 'company', responsiblePerson: 'R. Sharma', responsibleDesignation: 'Director', buyer194Q: false, roundToRupee: true });
  const supplier = (
    await call<Row>('accounts.ledger.save', { name: PARITY.tds.supplier, groupId: gid('Sundry Creditors'), gstin: PARITY.tds.supplierGstin, stateCode: '27', registrationType: 'regular' })
  ).id;
  const expense = (
    await call<Row>('accounts.ledger.save', { name: PARITY.tds.expense, groupId: gid('Direct Expenses'), gstApplicable: true, gstTaxability: 'taxable', gstRate: 18, hsnSac: PARITY.tds.sac, gstSupplyType: 'services' })
  ).id;
  const natures = await call<Array<{ id: number; section: string }>>('tds.natures.list', { kind: 'tds' });
  const c194 = natures.find((n) => n.section === PARITY.tds.section);
  if (!c194) throw new Error('TDS nature 194C is missing');
  await call('tds.ledgers.save', { ledgerId: supplier, applicable: true, deducteeType: 'firm', pan: PARITY.tds.pan });
  await call('tds.ledgers.save', { ledgerId: expense, applicable: true, natureId: c194.id });

  // Exports: US Dollar, an overseas customer billed in it, export of services, LUT for the year.
  const fx = PARITY.forex;
  const usd = (await call<Row>('accounts.currency.save', { ...fx.currency })).id;
  const fy = financialYearOf(today);
  await call('company.config.save', { gst: { lutNumber: fx.lut, lutValidFrom: fy.from, lutValidTo: fy.to } });
  const overseas = (await call<Row>('accounts.ledger.save', { name: fx.customer, groupId: gid('Sundry Debtors'), registrationType: 'overseas', country: fx.country, billWise: true, currencyId: usd })).id;
  const exportSales = (
    await call<Row>('accounts.ledger.save', { name: fx.ledger, groupId: gid('Sales Accounts'), gstApplicable: true, gstTaxability: 'taxable', gstRate: 18, hsnSac: fx.sac, gstSupplyType: 'services' })
  ).id;

  return { groups, types, customer, item, kit, bom, bank, upiMode, supplier, expense, usd, overseas, exportSales, payee };
}

/** Quotation 1 to the customer: 10 × ₹100.00, valid for 30 days. */
export function quotationInput(m: ParityMasters, today: string): Record<string, unknown> {
  return {
    voucherTypeId: m.types.quotation,
    date: today,
    mode: 'item_invoice',
    partyLedgerId: m.customer,
    validUntil: addDays(today, 30),
    items: [{ itemId: m.item, qty: PARITY.quotation.qty, rate: PARITY.quotation.rate }],
  };
}

/** Export of services to the overseas customer, invoiced in US$ under LUT (accounting invoice). */
export function exportInvoiceInput(m: ParityMasters, today: string): Record<string, unknown> {
  const fx = PARITY.forex;
  return {
    voucherTypeId: m.types.sales,
    date: today,
    mode: 'accounting_invoice',
    partyLedgerId: m.overseas,
    placeOfSupply: '96',
    exportDetails: { withPayment: false },
    forex: { currencyId: m.usd, rate: fx.rate, rateType: 'standard' },
    ledgers: [{ ledgerId: m.exportSales, amount: 0, forexAmount: fx.amount }],
    acknowledgeWarnings: true,
  };
}

/** Payment by cheque from the bank (the leaf is filled in from the cheque book on save). */
export function chequePaymentInput(m: ParityMasters, today: string): Record<string, unknown> {
  return {
    voucherTypeId: m.types.payment,
    date: today,
    mode: 'ledger',
    acknowledgeWarnings: true,
    ledgers: [
      { ledgerId: m.payee, amount: PARITY.cheque.amount },
      { ledgerId: m.bank, amount: -PARITY.cheque.amount, instrument: { type: 'cheque' } },
    ],
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
