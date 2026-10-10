/**
 * Export invoice print: amounts in the document currency with INR equivalents and the rate; GST in INR.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrintDataFor } from '../print/data.ts';
import { forexCompany } from './testkit.ts';

test('export invoice with IGST prints USD lines, the rate, USD total and words; INR totals unchanged', () => {
  const f = forexCompany();
  const item = f.t.addStockItem({ name: 'Granite Slab', unit: 'Nos', gstRate: 18, hsnSac: '6802', openingQty: 50, openingRate: 1000 });
  // 4 × $125.50 = $502.00 at ₹84 = ₹42,168.00; IGST 18% = ₹7,590.24 → ₹49,758.24.
  // Party $: 502 + 759024/84/100 = 502 + 90.36 = $592.36.
  const r = f.save({
    base: 'sales',
    date: '2026-05-10',
    mode: 'item_invoice',
    partyLedgerId: f.customer,
    placeOfSupply: '96',
    exportDetails: { withPayment: true, shippingBillNo: 'SB-9', portCode: 'INNSA1' },
    forex: { currencyId: f.usd, rate: 84 },
    items: [{ itemId: item, qty: 4, rate: 125.5 }],
  });
  const d = buildPrintDataFor(f.t.ctx, r.id);
  assert.equal(d.totals.taxable, 4_216_800);
  assert.equal(d.totals.igst, 759_024);
  assert.equal(d.totals.grandTotal, 4_975_824);
  assert.ok(d.forex);
  assert.equal(d.forex.rate, 84);
  assert.deepEqual(d.forex.lines, [{ rate: 125.5, amount: 502 }]);
  assert.equal(d.forex.total, 592.36);
  assert.equal(d.forex.tax, 90.36);
  assert.equal(d.forex.totalInWords, 'US Dollar Five Hundred Ninety Two and 36/100 Only');
  assert.match(d.forex.note, /₹84\.00 per USD; GST is computed and payable in rupees/);
  assert.ok(d.references.some((x) => x.label === 'Currency' && x.value === 'USD'));
});

test('a receipt prints the foreign amount and rate of the party entry; rupee vouchers have no block', () => {
  const f = forexCompany();
  const r = f.save({
    base: 'receipt',
    date: '2026-06-01',
    mode: 'ledger',
    ledgers: [
      { ledgerId: f.bank, amount: 8_450_000 },
      { ledgerId: f.customer, amount: 0, forexAmount: -1000, exchangeRate: 84.5 },
    ],
  });
  const d = buildPrintDataFor(f.t.ctx, r.id);
  assert.deepEqual(d.forex?.entries.map((e) => e.text), ['$ 1,000.00 @ ₹84.50']);
  const plain = f.save({ base: 'journal', date: '2026-06-01', mode: 'ledger', ledgers: [{ ledgerId: f.exportSales, amount: 100 }, { ledgerId: f.importPurchase, amount: -100 }] });
  assert.equal(buildPrintDataFor(f.t.ctx, plain.id).forex, undefined);
});
