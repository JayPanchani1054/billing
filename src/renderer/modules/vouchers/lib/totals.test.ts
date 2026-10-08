import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeInvoice } from '../../../../shared/gst/index.ts';
import type { InvoiceLineInput } from '../../../../shared/gst/index.ts';
import { formReducer, newForm } from './formState.ts';
import type { VoucherForm } from './formState.ts';
import { computeInvoiceTotals, computeLedgerTotals, computeStockTotals, itemProfile, ledgerProfile } from './totals.ts';
import type { ClientItemInfo, ClientLedgerTax, TotalsEnv } from './totals.ts';

const RICE: ClientItemInfo = { id: 1, isService: false, unitSymbol: 'KGS', gst: { rate: 5, cessRate: 0, cessPerUnit: 0, taxability: 'taxable', hsnSac: '1006' } };
const SOAP: ClientItemInfo = { id: 2, isService: false, unitSymbol: 'NOS', gst: { rate: 18, cessRate: 0, cessPerUnit: 0, taxability: 'taxable', hsnSac: '3401' } };
const NOGST: ClientItemInfo = { id: 3, isService: false, unitSymbol: 'NOS', gst: null };

const ledger = (over: Partial<ClientLedgerTax> = {}): ClientLedgerTax => ({
  isSales: false,
  isPurchase: false,
  plAccount: true,
  gstApplicable: false,
  taxability: null,
  rate: null,
  cessRate: null,
  hsnSac: null,
  supplyType: null,
  isReverseCharge: false,
  includeInAssessable: null,
  appropriateBy: null,
  history: [],
  ...over,
});

const LEDGERS = new Map<number, ClientLedgerTax>([
  [10, ledger({ isSales: true, gstApplicable: true, taxability: 'taxable', rate: null })], // Sales
  [20, ledger({ gstApplicable: true, taxability: 'taxable', rate: 18, hsnSac: '996511', supplyType: 'services' })], // Freight Outward (GST 18%)
  [30, ledger({ plAccount: false })], // TCS payable — non-GST, outside the computation
  [40, ledger({ includeInAssessable: 'goods', appropriateBy: 'value' })], // Packing — apportioned into goods
  [50, ledger()], // Consulting income: P&L, not GST-applicable
]);

const env = (over: Partial<TotalsEnv> = {}): TotalsEnv => ({
  direction: 'outward',
  gstOn: true,
  companyStateCode: '27',
  companyRegistration: 'regular',
  party: { registrationType: 'regular', stateCode: '27', gstin: '27AAPFU0939F1ZV' },
  roundOff: { enabled: true, method: 'nearest', unit: 100 },
  items: new Map([
    [1, RICE],
    [2, SOAP],
    [3, NOGST],
  ]),
  ledgerTax: (id) => LEDGERS.get(id),
  defaultLedgerId: 10,
  ...over,
});

function salesForm(): VoucherForm {
  let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
  const k0 = f.items[0].key;
  f = formReducer(f, { type: 'item', key: k0, patch: { itemId: 1, qty: 10, rate: 50 } });
  const k1 = f.items[1].key;
  f = formReducer(f, { type: 'item', key: k1, patch: { itemId: 2, qty: 3, rate: 118.5, discountPct: 10 } });
  const l0 = f.ledgers[0].key;
  f = formReducer(f, { type: 'ledger', key: l0, patch: { ledgerId: 20, amount: 10000 } });
  const l1 = f.ledgers[1].key;
  f = formReducer(f, { type: 'ledger', key: l1, patch: { ledgerId: 30, amount: 100 } });
  return f;
}

describe('computeInvoiceTotals — item invoice, intra-state', () => {
  it('hand-verified: 5% + 18% buckets, GST freight, non-GST TCS outside, round off', () => {
    const t = computeInvoiceTotals(salesForm(), env());
    // Rice 10 × 50.00 = 500.00 @5%; Soap 3 × 118.50 = 355.50 − 10% (35.55) = 319.95 @18%;
    // Freight 100.00 @18% (GST-applicable ledger → computed line); TCS 1.00 outside the computation.
    // 5% bucket: 500.00 → CGST 12.50 + SGST 12.50 = 25.00
    // 18% bucket: 319.95 + 100.00 = 419.95 → each head round(419.95 × 9%) = round(37.7955) = 37.80 → 75.60
    assert.equal(t.taxable, 91995);
    assert.equal(t.tax, 2500 + 7560);
    assert.equal(t.computation?.totals.cgst, 1250 + 3780);
    assert.equal(t.computation?.totals.igst, 0);
    assert.equal(t.outside, 100);
    // 919.95 + 100.60 + 1.00 = 1,021.55 → nearest rupee 1,022.00 (round off +0.45)
    assert.equal(t.beforeRound, 102155);
    assert.equal(t.grandTotal, 102200);
    assert.equal(t.roundOff, 45);
  });

  it('parity: the same lines through computeInvoice directly give the same taxable and tax', () => {
    const f = salesForm();
    const lines: InvoiceLineInput[] = [
      { key: f.items[0].key, kind: 'item', qty: 10, rate: 50, taxability: 'taxable', gstRate: 5, cessRate: 0, cessPerUnit: 0, hsnSac: '1006', supplyKind: 'goods', uqc: 'KGS', rateInclusiveOfTax: false, reverseCharge: false },
      { key: f.items[1].key, kind: 'item', qty: 3, rate: 118.5, discountPct: 10, taxability: 'taxable', gstRate: 18, cessRate: 0, cessPerUnit: 0, hsnSac: '3401', supplyKind: 'goods', uqc: 'NOS', rateInclusiveOfTax: false, reverseCharge: false },
      { key: f.ledgers[0].key, kind: 'ledger', amount: 10000, taxability: 'taxable', gstRate: 18, cessRate: 0, hsnSac: '996511', supplyKind: 'services', apportion: 'none', reverseCharge: false },
    ];
    const direct = computeInvoice(lines, {
      direction: 'outward',
      invoiceDate: '2026-10-05',
      companyStateCode: '27',
      companyRegistration: 'regular',
      partyRegistration: 'regular',
      partyStateCode: '27',
      partyGstin: '27AAPFU0939F1ZV',
      consigneeStateCode: null,
      placeOfSupply: null,
      exportWithPayment: false,
      reverseCharge: false,
      roundOff: { enabled: false, method: 'nearest', unit: 100 },
    });
    const t = computeInvoiceTotals(f, env());
    assert.equal(t.taxable, direct.totals.taxable);
    assert.equal(t.tax, direct.totals.tax);
    assert.deepEqual(
      t.computation?.lines.map((l) => [l.key, l.taxableValue, l.tax]),
      direct.lines.map((l) => [l.key, l.taxableValue, l.tax]),
    );
    // Per-row figures are keyed by the form row.
    assert.equal(t.lines.get(f.items[1].key)?.taxable, 31995);
    assert.equal(t.lines.get(f.ledgers[1].key)?.taxability, 'non_gst');
  });

  it('inter-state party → IGST only', () => {
    const t = computeInvoiceTotals(salesForm(), env({ party: { registrationType: 'regular', stateCode: '29', gstin: '29AAPFU0939F1ZQ' } }));
    // IGST: 5% of 500.00 = 25.00; 18% of 419.95 = 75.591 → 75.59
    assert.equal(t.computation?.totals.igst, 2500 + 7559);
    assert.equal(t.computation?.totals.cgst, 0);
    assert.equal(t.computation?.interState, true);
  });

  it('GST off: no tax at all, totals are the line values', () => {
    const t = computeInvoiceTotals(salesForm(), env({ gstOn: false }));
    // 500.00 + 319.95 + freight 100.00 (not GST, not a sales account → outside) + 1.00 = 920.95 → 921.00
    assert.equal(t.tax, 0);
    assert.equal(t.beforeRound, 50000 + 31995 + 10000 + 100);
    assert.equal(t.grandTotal, 92100);
  });

  it('round-off disabled keeps paise', () => {
    const t = computeInvoiceTotals(salesForm(), env({ roundOff: { enabled: false, method: 'nearest', unit: 100 } }));
    assert.equal(t.grandTotal, 102155);
    assert.equal(t.roundOff, 0);
  });

  it('apportioned packing charge is absorbed into the goods value', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 1, qty: 10, rate: 50 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 40, amount: 5000 } });
    const t = computeInvoiceTotals(f, env({ roundOff: { enabled: false, method: 'nearest', unit: 100 } }));
    // Goods 500.00 + packing 50.00 absorbed → taxable 550.00 @5% = 27.50 → 577.50
    assert.equal(t.taxable, 55000);
    assert.equal(t.tax, 2750);
    assert.equal(t.grandTotal, 57750);
  });

  it('item without its own GST falls back to the sales ledger; none at all → 0%', () => {
    assert.equal(itemProfile(NOGST, ledger({ gstApplicable: true, taxability: 'taxable', rate: 12 }), '2026-10-05', null).rate, 12);
    assert.equal(itemProfile(NOGST, undefined, '2026-10-05', null).rate, 0);
    assert.equal(itemProfile(RICE, undefined, '2026-10-05', 12).rate, 12);
  });

  it('ledger profile: history row in force on the date wins over the columns', () => {
    const t = ledger({ gstApplicable: true, taxability: 'taxable', rate: 18, history: [{ applicableFrom: '2026-01-01', hsnSac: '9965', taxability: 'taxable', rate: 12, cessRate: 0 }] });
    assert.equal(ledgerProfile(t, '2025-12-31').rate, 18);
    assert.equal(ledgerProfile(t, '2026-01-01').rate, 12);
    assert.equal(ledgerProfile(t, '2026-01-01').supplyKind, 'services');
    assert.equal(ledgerProfile(ledger(), '2026-01-01').taxability, 'non_gst');
    assert.equal(ledgerProfile(ledger(), '2026-01-01', { rate: 5 }).rate, 5);
  });

  it('accounting invoice: a positive P&L line is computed, its rate override applies', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'accounting_invoice', date: '2026-10-05' });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 50, amount: 100000, gstRate: 18 } });
    const t = computeInvoiceTotals(f, env());
    // 1,000.00 @18% = 180.00 → 1,180.00
    assert.equal(t.tax, 18000);
    assert.equal(t.grandTotal, 118000);
  });
});

describe('computeLedgerTotals', () => {
  it('double entry: Σ Dr, Σ Cr and the difference', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'journal', mode: 'ledger', date: '2026-10-05' });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 50000 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 2, amount: -30000 } });
    assert.deepEqual(computeLedgerTotals(f), { debit: 50000, credit: 30000, difference: 20000, account: 0 });
  });

  it('single entry payment: the account is credited with Σ particulars', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'payment', mode: 'ledger', date: '2026-10-05', accountLedgerId: 9 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 50000 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 2, amount: 2500 } });
    assert.deepEqual(computeLedgerTotals(f), { debit: 52500, credit: 52500, difference: 0, account: -52500 });
  });
});

describe('computeStockTotals', () => {
  it('stock journal sides', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'stock_journal', mode: 'inventory', date: '2026-10-05' });
    const src = f.items.find((r) => r.isConsumption)?.key as string;
    f = formReducer(f, { type: 'item', key: src, patch: { itemId: 1, qty: 10, rate: 50 } });
    const dst = f.items.find((r) => !r.isConsumption)?.key as string;
    f = formReducer(f, { type: 'item', key: dst, patch: { itemId: 2, qty: 4, rate: 130 } });
    // 10 × 50 = 500.00 consumed; 4 × 130 = 520.00 produced
    assert.deepEqual(computeStockTotals(f), { total: 102000, consumption: 50000, production: 52000, qty: 14 });
  });
});
