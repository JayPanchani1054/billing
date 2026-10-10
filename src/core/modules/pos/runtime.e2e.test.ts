/**
 * POS main flow through the REAL runtime (createRuntime + runtime.dispatch, as Electron main does):
 * company → F11 POS invoicing → UPI tender on the bank → item with barcode / MRP and opening stock →
 * counter context → scan lookup → hold and recall a bill → preview (tenders, change) → save the bill
 * (UPI + cash, cash tendered) → receipt print data (tenders, MRP, "You saved", no pay QR) → customer
 * created by mobile → credit bill → return of one item from the walk-in bill as exchange credit → a
 * new bill paying with that credit → day-end summary → Trial Balance still balances.
 *
 * Figures: soap ₹42.37 ex-GST @ 18 %, MRP ₹59.
 *   Bill 1 (walk-in): 3 soaps = 12,711 taxable; CGST = SGST = 9 % of 12,711 = 1,143.99 → 1,144 each →
 *     14,999 + round off 1 = 15,000 (₹150.00). Paid UPI 5,000 + cash 10,000; cash tendered 20,000 →
 *     change 10,000. MRP 3 × 5,900 = 17,700 − 14,999 charged (round-off is not part of a line) → saved 2,701.
 *   Bill 2 (customer): 2 soaps = 8,474; 762.66 → 763 each → 10,000; cash 4,000, 6,000 on account.
 *   Return of 1 soap from bill 1: 4,237 + 381.33 → 381 × 2 = 4,999 → round off +1 → 5,000 exchange credit.
 *   Bill 3 (walk-in): 1 soap, rounded to 5,000; exchange credit 5,000.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PosContext, PosHeldBill, PosItemLookupResult, PosSummary } from '../../../shared/types/pos.ts';
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import type { VoucherPreview, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { makeGstin, TEST_PAN } from '../../testing/fixtures.ts';
import { startRuntime, type E2E } from '../../testing/e2e/harness.ts';

describe('POS counter end to end (runtime.dispatch)', () => {
  let e: E2E;
  let ctx: PosContext;
  let soap = 0;
  let upiMode = 0;
  let bill1 = 0;
  let ret = 0;
  const today = '2026-10-09';

  before(() => {
    e = startRuntime(today);
  });
  after(async () => {
    await e.close();
  });

  const sale = (items: unknown[], posBill: unknown, extra: Record<string, unknown> = {}) => ({
    voucherTypeId: ctx.saleVoucherTypeId,
    date: today,
    mode: 'item_invoice',
    partyLedgerId: ctx.walkIn?.id,
    placeOfSupply: ctx.companyStateCode ?? undefined,
    items,
    posBill,
    ...extra,
  });
  const cashMode = () => ctx.tenderModes.find((m) => m.kind === 'cash')?.id ?? 0;
  const exchangeMode = () => ctx.tenderModes.find((m) => m.kind === 'exchange')?.id ?? 0;

  it('creates the company and turns POS invoicing on', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Kirana Mart E2E',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: true, billWise: true, gst: true },
    });
    await e.fails('pos.item.lookup', { code: 'x', date: today }, 'BUSINESS_RULE', /POS invoicing is turned off/);
    await e.call('company.features.save', { pos: true });
    const groups = await e.call<{ rows: Array<{ id: number; name: string }> }>('accounts.group.list', {});
    const bankGroup = groups.rows.find((g) => g.name === 'Bank Accounts')?.id;
    const bank = await e.call<{ id: number }>('accounts.ledger.save', { name: 'SBI Current', groupId: bankGroup });
    upiMode = (await e.call<{ id: number }>('pos.tenderMode.save', { name: 'UPI', kind: 'upi', ledgerId: bank.id })).id;
    const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
    const out = await e.call<{ item: { id: number } }>('inventory.item.save', {
      name: 'Neem Soap 75g',
      unitId: units.rows.find((u) => u.symbol === 'Nos')?.id,
      gstApplicable: true,
      taxability: 'taxable',
      gstRate: 18,
      hsnSac: '3401',
      barcode: '8901030865278',
      mrp: 5_900,
      sellingPrice: 4_237,
      openings: [{ qty: 50, rate: 30 }],
    });
    soap = out.item.id;
    ctx = await e.call<PosContext>('pos.context', {});
    assert.equal(ctx.enabled, true);
    assert.ok(ctx.saleVoucherTypeId);
    assert.deepEqual(ctx.tenderModes.map((m) => m.kind), ['cash', 'upi', 'exchange']);
  });

  it('scans by barcode, holds the bill and recalls it', async () => {
    const r = await e.call<PosItemLookupResult>('pos.item.lookup', { code: '8901030865278', date: today });
    assert.equal(r.item?.itemId, soap);
    assert.equal(r.item?.mrp, 5_900);
    assert.equal(r.item?.stock, 50);
    const held = await e.call<PosHeldBill>('pos.held.save', { total: 15_000, draft: { voucherTypeId: ctx.saleVoucherTypeId, lines: [{ itemId: soap, qty: 3, rate: 42.37 }] } });
    assert.equal((await e.call<PosHeldBill[]>('pos.held.list', {})).length, 1);
    const back = await e.call<PosHeldBill>('pos.held.recall', { id: held.id });
    assert.equal(back.draft.lines[0].qty, 3);
    assert.equal((await e.call<PosHeldBill[]>('pos.held.list', {})).length, 0);
  });

  it('previews and saves a split-tender bill with change, and prints it with MRP and You saved', async () => {
    const input = sale([{ itemId: soap, qty: 3, rate: 42.37 }], { tenders: [{ modeId: upiMode, amount: 5_000, reference: 'T123' }, { modeId: cashMode(), amount: 10_000 }], cashTendered: 20_000, counter: 'Counter 1' });
    const p = await e.call<VoucherPreview>('vouchers.preview', input);
    assert.equal(p.totals.grandTotal, 15_000);
    assert.equal(p.posBill?.change, 10_000);
    assert.equal(p.warnings.filter((w) => w.blocking).length, 0);
    const r = await e.call<VoucherSaveResult>('vouchers.save', { ...input, acknowledgeWarnings: true });
    bill1 = r.id;
    assert.match(r.number ?? '', /^POS\/1$/);
    const doc = await e.call<PrintVoucherData>('print.voucherData', { id: bill1 });
    assert.equal(doc.defaultTemplate, 'compact');
    assert.deepEqual(doc.pos?.tenders.map((t) => [t.label, t.amount]), [
      ['UPI (Ref T123)', 5_000],
      ['Cash', 10_000],
    ]);
    assert.equal(doc.pos?.cashTendered, 20_000);
    assert.equal(doc.pos?.change, 10_000);
    assert.equal(doc.pos?.counter, 'Counter 1');
    assert.equal(doc.mrpSummary?.savings, 2_701);
    assert.equal(doc.upi, null);
  });

  it('creates a customer by mobile and sells partly on credit', async () => {
    await e.fails('vouchers.save', sale([{ itemId: soap, qty: 2, rate: 42.37 }], { tenders: [{ modeId: cashMode(), amount: 4_000 }] }), 'BUSINESS_RULE', /walk-in bill is paid in full/);
    assert.deepEqual(await e.call('pos.customer.find', { mobile: '9812345678' }), []);
    const c = await e.call<{ ledgerId: number; name: string }>('pos.customer.create', { name: 'Anita Shah', mobile: '98123 45678' });
    const found = await e.call<Array<{ ledgerId: number }>>('pos.customer.find', { mobile: '+919812345678' });
    assert.deepEqual(found.map((f) => f.ledgerId), [c.ledgerId]);
    const r = await e.call<VoucherSaveResult>('vouchers.save', {
      ...sale([{ itemId: soap, qty: 2, rate: 42.37 }], { tenders: [{ modeId: cashMode(), amount: 4_000 }] }, { partyLedgerId: c.ledgerId }),
      acknowledgeWarnings: true,
    });
    const bills = await e.call<Array<{ billName: string; amount: number }>>('vouchers.pendingBills', { ledgerId: c.ledgerId, asOf: today });
    assert.deepEqual(bills.map((b) => [b.billName, Math.abs(b.amount)]), [[r.number, 6_000]]);
  });

  it('returns one soap from the walk-in bill as exchange credit and uses it on a new bill', async () => {
    const rc = await e.call<{ lines: Array<{ returnable: number; rate: number; index: number }>; returnVoucherTypeId: number; billNumber: string }>('pos.return.context', { voucherId: bill1, date: today });
    assert.equal(rc.lines[0].returnable, 3);
    const r = await e.call<VoucherSaveResult>('vouchers.save', {
      voucherTypeId: rc.returnVoucherTypeId,
      date: today,
      mode: 'item_invoice',
      partyLedgerId: ctx.walkIn?.id,
      placeOfSupply: '27',
      originalInvoiceNo: rc.billNumber,
      originalInvoiceDate: today,
      noteReason: 'Exchange',
      items: [{ itemId: soap, qty: 1, rate: rc.lines[0].rate }],
      posBill: { tenders: [{ modeId: exchangeMode(), amount: 5_000 }], returnOfId: bill1 },
      acknowledgeWarnings: true,
    });
    ret = r.id;
    const open = await e.call<Array<{ voucherId: number; available: number }>>('pos.exchange.open', {});
    assert.deepEqual(open.map((o) => [o.voucherId, o.available]), [[ret, 5_000]]);
    await e.call('vouchers.save', {
      ...sale([{ itemId: soap, qty: 1, rate: 42.37 }], { tenders: [{ modeId: exchangeMode(), amount: 5_000, exchangeVoucherId: ret }] }),
      acknowledgeWarnings: true,
    });
    assert.deepEqual(await e.call('pos.exchange.open', {}), []);
    await e.fails('vouchers.delete', { id: ret }, 'BUSINESS_RULE', /exchange credit of this return was used/);
    // Review regressions through dispatch: a return priced above the bill is refused; the bill with a
    // return cannot be altered to another customer; the return altered as a plain Credit Note
    // (no posBill) keeps its tenders and cannot issue less exchange credit than was used.
    await e.fails(
      'vouchers.save',
      {
        voucherTypeId: rc.returnVoucherTypeId,
        date: today,
        mode: 'item_invoice',
        partyLedgerId: ctx.walkIn?.id,
        placeOfSupply: '27',
        originalInvoiceNo: rc.billNumber,
        originalInvoiceDate: today,
        items: [{ itemId: soap, qty: 1, rate: 4237 }],
        posBill: { tenders: [{ modeId: cashMode(), amount: 5_000_00 }], returnOfId: bill1 },
        acknowledgeWarnings: true,
      },
      'BUSINESS_RULE',
      /charged ₹ 42\.37 for 1/,
    );
    const [anita] = await e.call<Array<{ ledgerId: number }>>('pos.customer.find', { mobile: '9812345678' });
    await e.fails(
      'vouchers.save',
      { ...sale([{ itemId: soap, qty: 3, rate: 42.37 }], { tenders: [{ modeId: cashMode(), amount: 15_000 }] }, { partyLedgerId: anita.ledgerId }), id: bill1, acknowledgeWarnings: true },
      'BUSINESS_RULE',
      /customer cannot change/,
    );
    const stored = await e.call<{ input: Record<string, unknown> }>('vouchers.get', { id: ret });
    const { posBill: _p, ...plain } = stored.input;
    await e.call('vouchers.save', { ...plain, id: ret, narration: 'Exchange — size', acknowledgeWarnings: true });
    assert.deepEqual(await e.call('pos.voucher', { id: ret }), {
      kind: 'return',
      billValue: 5_000,
      paid: 5_000,
      credit: 0,
      cashTendered: null,
      change: 0,
      tenders: [{ modeId: exchangeMode(), name: 'Exchange credit', kind: 'exchange', ledgerId: ctx.tenderModes.find((m) => m.kind === 'exchange')?.ledgerId, ledgerName: 'POS Exchange Credit', amount: 5_000, reference: null, exchangeVoucherId: null }],
      returnOfId: bill1,
      counter: null,
    });
    await e.fails('vouchers.save', { ...plain, id: ret, posBill: { tenders: [{ modeId: cashMode(), amount: 5_000 }], returnOfId: bill1 }, acknowledgeWarnings: true }, 'BUSINESS_RULE', /cannot issue less/);
  });

  it('day-end summary and the Trial Balance agree', async () => {
    const s = await e.call<PosSummary>('pos.summary', { from: today, to: today });
    assert.equal(s.bills, 3);
    assert.equal(s.sales, 30_000); // 15,000 + 10,000 + 5,000
    assert.equal(s.returns, 1);
    assert.equal(s.returnValue, 5_000);
    assert.equal(s.net, 25_000);
    assert.equal(s.netCash, 14_000); // 10,000 + 4,000
    assert.equal(s.creditSales, 6_000);
    assert.equal(s.exchangeIssued, 5_000);
    assert.equal(s.exchangeUsed, 5_000);
    assert.equal(s.changeGiven, 10_000);
    const tb = await e.call<{ totals: { closing: { debit: number; credit: number } } }>('reports.trialBalance', { from: '2026-04-01', to: today });
    assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  });
});
