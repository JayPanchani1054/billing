/**
 * Read routes: list (filters, search, paging, sums), pending bills (incl. opening bills), entry and
 * party context, voucher detail — exercised through the real dispatcher.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  PartyContext,
  PendingBill,
  TrackingDoc,
  VoucherDetail,
  VoucherEntryContext,
  VoucherInput,
  VoucherListResult,
  VoucherPreview,
  VoucherSaveResult,
} from '../../../shared/types/vouchers.ts';
import { vouchersRoutes } from './routes.ts';
import { cancelVoucher } from './service.ts';
import { purchaseInput, salesInput, save, setupKit, type Kit } from './testkit.ts';

function seedDayBook(k: Kit): { sales: VoucherSaveResult[]; purchase: VoucherSaveResult; journal: VoucherSaveResult } {
  const sales = [
    save(k, salesInput(k, { date: '2026-04-02', narration: 'Diwali order' })), // ₹1,180.00
    save(k, salesInput(k, { date: '2026-04-05', partyLedgerId: k.L.blr, items: [{ itemId: k.I.rice, qty: 2, rate: 100 }] })), // 200 + IGST 10 = ₹210.00
    save(k, salesInput(k, { date: '2026-04-09', isOptional: true })),
    save(k, salesInput(k, { date: '2026-04-12' })),
  ];
  const purchase = save(k, purchaseInput(k, { date: '2026-04-03', referenceNo: 'BILL-77' })); // ₹1,680.00
  const journal = save(k, { voucherTypeId: k.vt.journal, date: '2026-04-04', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 50000 }, { ledgerId: k.L.capital, amount: -50000 }] });
  cancelVoucher(k.t.ctx, sales[3].id, 'Customer refused');
  return { sales, purchase, journal };
}

describe('vouchers.list', () => {
  it('filters, flags, search, paging and sums', async () => {
    const k = setupKit();
    const { sales, purchase, journal } = seedDayBook(k);
    const list = (q: Record<string, unknown>) => k.t.callOk<VoucherListResult>(vouchersRoutes, 'vouchers.list', { from: '2026-04-01', to: '2026-04-30', ...q });

    const all = await list({});
    assert.equal(all.total, 6);
    assert.deepEqual(all.rows.map((r) => r.id), [sales[0].id, purchase.id, journal.id, sales[1].id, sales[2].id, sales[3].id]);
    const opt = all.rows.find((r) => r.id === sales[2].id);
    assert.deepEqual([opt?.isOptional, opt?.voucherTypeName, opt?.baseType, opt?.partyName], [true, 'Sales', 'sales', 'Acme Traders']);
    const cancelled = all.rows.find((r) => r.id === sales[3].id);
    assert.deepEqual([cancelled?.isCancelled, cancelled?.amount, cancelled?.number], [true, 0, '4']);
    assert.equal(all.rows.find((r) => r.id === journal.id)?.partyName, 'Office Rent', 'first ledger when there is no party');
    // 1,180 + 1,680 + 500 + 210 + 1,180 (optional) + 0 (cancelled) = ₹4,750.00
    assert.equal(all.sums.amount, 475000);

    const books = await list({ includeOptional: false, includeCancelled: false });
    assert.equal(books.total, 4);
    assert.equal(books.sums.amount, 118000 + 168000 + 50000 + 21000);

    const salesOnly = await list({ baseTypes: ['sales'], includeCancelled: false, sort: 'date_desc' });
    assert.deepEqual(salesOnly.rows.map((r) => r.id), [sales[2].id, sales[1].id, sales[0].id]);
    assert.equal((await list({ voucherTypeIds: [k.vt.purchase] })).rows[0].referenceNo, 'BILL-77');
    assert.equal((await list({ partyLedgerId: k.L.blr })).total, 1);
    assert.equal((await list({ ledgerId: k.L.rent })).rows[0].id, journal.id);
    assert.equal((await list({ ledgerId: k.L.OUTPUT_IGST })).rows[0].id, sales[1].id);

    // Search: narration, party name, reference, number and exact amount.
    assert.deepEqual((await list({ search: 'diwali' })).rows.map((r) => r.id), [sales[0].id]);
    assert.deepEqual((await list({ search: 'bangalore' })).rows.map((r) => r.id), [sales[1].id]);
    assert.deepEqual((await list({ search: 'bill-77' })).rows.map((r) => r.id), [purchase.id]);
    assert.deepEqual((await list({ search: '1,680.00' })).rows.map((r) => r.id), [purchase.id]);
    assert.deepEqual((await list({ search: '210' })).rows.map((r) => r.id), [sales[1].id]);
    assert.equal((await list({ search: '%' })).total, 0, 'LIKE wildcards are literal');

    // Paging keeps the total.
    const page = await list({ limit: 2, offset: 2 });
    assert.equal(page.total, 6);
    assert.deepEqual(page.rows.map((r) => r.id), [journal.id, sales[1].id]);
    const r = await k.t.call(vouchersRoutes, 'vouchers.list', { from: '2026-04-01', to: '2026-04-30', limit: 5000 });
    assert.equal(r.ok ? 'ok' : r.error.code, 'VALIDATION');
    k.t.close();
  });

  it('post-dated filter', async () => {
    const k = setupKit();
    save(k, { voucherTypeId: k.vt.payment, date: '2026-04-30', isPostDated: true, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 100 }, { ledgerId: k.L.bank, amount: -100 }] });
    save(k, { voucherTypeId: k.vt.payment, date: '2026-04-15', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 200 }, { ledgerId: k.L.bank, amount: -200 }] });
    const res = await k.t.callOk<VoucherListResult>(vouchersRoutes, 'vouchers.list', { from: '2026-04-01', to: '2026-04-30', onlyPostDated: true });
    assert.deepEqual(res.rows.map((r) => [r.amount, r.isPostDated]), [[100, true]]);
    k.t.close();
  });
});

describe('pending bills & party context', () => {
  it('nets opening bills and voucher allocations per bill name', async () => {
    const k = setupKit();
    const party = k.t.addLedger({
      name: 'Old Customer',
      group: 'SUNDRY_DEBTORS',
      stateCode: '27',
      creditDays: 15,
      creditLimit: 5_00_000_00,
      openingBalance: 150000,
      openingBills: [
        { name: 'OB-1', date: '2026-03-01', amount: 100000, dueDate: '2026-03-31' },
        { name: 'OB-2', date: '2026-03-10', amount: 50000 },
      ],
    });
    // New invoice: ₹1,180.00 (bill '1', due 15 days later).
    const inv = save(k, salesInput(k, { partyLedgerId: party }));
    // Receipt ₹1,300.00: ₹1,000 against OB-1 (cleared), ₹300 against OB-2 (₹200 left).
    const rec = save(k, {
      voucherTypeId: k.vt.receipt,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.bank, amount: 130000 },
        {
          ledgerId: party,
          amount: -130000,
          billAllocations: [
            { refType: 'against', billName: 'OB-1', amount: 100000 },
            { refType: 'against', billName: 'OB-2', amount: 30000 },
          ],
        },
      ],
    });
    const bills = await k.t.callOk<PendingBill[]>(vouchersRoutes, 'vouchers.pendingBills', { ledgerId: party, asOf: k.t.today });
    assert.deepEqual(
      bills.map((b) => [b.billName, b.billDate, b.dueDate, b.amount, b.originalAmount, b.source, b.voucherId]),
      [
        ['OB-2', '2026-03-10', null, 20000, 50000, 'opening', null],
        ['1', '2026-04-15', '2026-04-30', 118000, 118000, 'voucher', inv.id],
      ],
    );
    // As of before the receipt and the invoice: only opening bills.
    const early = await k.t.callOk<PendingBill[]>(vouchersRoutes, 'vouchers.pendingBills', { ledgerId: party, asOf: '2026-04-01' });
    assert.deepEqual(early.map((b) => [b.billName, b.amount]), [['OB-1', 100000], ['OB-2', 50000]]);
    // Excluding the receipt being altered re-opens what it settled.
    const excl = await k.t.callOk<PendingBill[]>(vouchersRoutes, 'vouchers.pendingBills', { ledgerId: party, asOf: k.t.today, excludeVoucherId: rec.id });
    assert.deepEqual(excl.map((b) => [b.billName, b.amount]), [['OB-1', 100000], ['OB-2', 50000], ['1', 118000]]);

    const ctx = await k.t.callOk<PartyContext>(vouchersRoutes, 'vouchers.partyContext', { ledgerId: party, date: k.t.today });
    // Balance: 1,500 + 1,180 − 1,300 = ₹1,380.00 Dr.
    assert.deepEqual([ctx.kind, ctx.billWise, ctx.creditDays, ctx.creditLimit, ctx.balance, ctx.stateCode], ['debtor', true, 15, 5_00_000_00, 138000, '27']);
    assert.equal(ctx.pendingBills.length, 2);
    const bank = await k.t.callOk<PartyContext>(vouchersRoutes, 'vouchers.partyContext', { ledgerId: k.L.bank, date: k.t.today });
    assert.deepEqual([bank.kind, bank.billWise, bank.balance, bank.pendingBills.length], ['bank', false, 130000, 0]);
    k.t.close();
  });
});

describe('entry context, preview, detail', () => {
  it('entryContext gives the entry screen everything in one call', async () => {
    const k = setupKit();
    save(k, salesInput(k));
    const c = await k.t.callOk<VoucherEntryContext>(vouchersRoutes, 'vouchers.entryContext', { voucherTypeId: k.vt.sales, date: k.t.today });
    assert.equal(c.voucherType.baseType, 'sales');
    assert.equal(c.nextNumber, '2');
    assert.deepEqual(c.allowedModes, ['item_invoice', 'accounting_invoice', 'ledger']);
    assert.equal(c.defaultMode, 'item_invoice');
    assert.equal(c.company.stateCode, '27');
    assert.equal(c.company.gstEnabled, true);
    assert.equal(c.company.financialYear.label, '2026-27');
    assert.equal(c.ledgers.output.CGST, k.L.OUTPUT_CGST);
    assert.equal(c.ledgers.rcm.IGST, k.L.RCM_IGST);
    assert.equal(c.ledgers.cash, k.L.cash);
    assert.equal(c.defaultLedgerId, k.L.sales);
    assert.equal(c.mainGodownId, k.t.ids.mainGodownId);
    assert.equal(c.config.roundOff.unit, 100);
    assert.equal(c.features.billWise, true);
    assert.deepEqual(c.permissions, { canAlter: true, canBackdate: true, canDelete: true });
    const p = await k.t.callOk<VoucherEntryContext>(vouchersRoutes, 'vouchers.entryContext', { voucherTypeId: k.vt.payment, date: k.t.today });
    assert.deepEqual(p.allowedModes, ['ledger']);
    assert.equal(await k.t.callOk<string>(vouchersRoutes, 'vouchers.nextNumber', { voucherTypeId: k.vt.payment, date: k.t.today }), '1');
    k.t.close();
  });

  it('preview route returns entries with names, computation and warnings without writing', async () => {
    const k = setupKit();
    const p = await k.t.callOk<VoucherPreview>(vouchersRoutes, 'vouchers.preview', salesInput(k, { items: [{ itemId: k.I.mixer, qty: 60, rate: 200 }] }));
    assert.equal(p.number, '1');
    assert.equal(p.computation?.nature, 'b2b');
    assert.deepEqual(p.entries.map((e) => [e.ledgerName, e.role]), [['Acme Traders', 'party'], ['Sales', 'sales'], ['Output CGST', 'tax'], ['Output SGST/UTGST', 'tax']]);
    assert.equal(p.entries[0].billAllocations[0].billName, '1');
    assert.deepEqual([p.inventory[0].itemName, p.inventory[0].unit, p.inventory[0].godownName, p.inventory[0].qty], ['Mixer Grinder', 'Nos', 'Main Location', -60]);
    assert.equal(p.gstLines.length, 1);
    assert.deepEqual(p.warnings.map((w) => w.code), ['negative_stock']);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers'), 0);
    k.t.close();
  });

  it('vouchers.get returns everything needed to view, print and alter', async () => {
    const k = setupKit({ security: true });
    const input: VoucherInput = salesInput(k, {
      referenceNo: 'PO-9',
      narration: 'Full detail',
      consignee: { name: 'Acme Warehouse', stateCode: '27', pincode: '400002' },
      dispatch: { vehicleNo: 'MH01AB1234', distanceKm: 12 },
      orderDetails: { buyersOrderNo: 'PO-9', orderDate: '2026-04-01' },
      party: { pincode: '400003' },
      items: [{ itemId: k.I.mixer, qty: 5, rate: 200, description: 'Blue colour' }],
    });
    const res = await k.t.callOk<VoucherSaveResult>(vouchersRoutes, 'vouchers.save', input);
    const d = await k.t.callOk<VoucherDetail>(vouchersRoutes, 'vouchers.get', { id: res.id });
    assert.deepEqual(d.voucherType, { id: k.vt.sales, name: 'Sales', baseType: 'sales' });
    assert.equal(d.mode, 'item_invoice');
    assert.equal(d.number, '1');
    assert.equal(d.partyLedgerName, 'Acme Traders');
    assert.equal(d.party.pincode, '400003');
    assert.equal(d.party.registrationType, 'regular');
    assert.deepEqual(d.consignee, { name: 'Acme Warehouse', stateCode: '27', pincode: '400002' });
    assert.deepEqual(d.dispatch, { vehicleNo: 'MH01AB1234', distanceKm: 12 });
    assert.equal(d.orderDetails?.buyersOrderNo, 'PO-9');
    assert.deepEqual(d.totals, { amount: 118000, taxable: 100000, tax: 18000, roundOff: 0 });
    assert.equal(d.entries.length, 4);
    assert.equal(d.entries[0].billAllocations[0].dueDate, '2026-05-15');
    assert.equal(d.inventory[0].itemName, 'Mixer Grinder');
    assert.equal(d.gstLines[0].cgst, 9000);
    assert.equal(d.createdBy.name, 'Test Owner');
    assert.equal(d.createdBy.id, k.t.ids.ownerUserId);
    assert.equal(d.input.id, res.id);
    assert.equal(d.input.expectedUpdatedAt, d.updatedAt);
    assert.equal(d.input.items?.[0].description, 'Blue colour');
    // Round trip: the detail input saves back unchanged.
    const again = await k.t.callOk<VoucherSaveResult>(vouchersRoutes, 'vouchers.save', d.input);
    assert.deepEqual([again.id, again.number, again.totals.grandTotal], [res.id, '1', 118000]);
    const dup = await k.t.callOk<VoucherInput>(vouchersRoutes, 'vouchers.duplicate', { id: res.id });
    assert.equal(dup.id, undefined);
    const opt = await k.t.callOk<VoucherSaveResult>(vouchersRoutes, 'vouchers.setOptional', { id: res.id, optional: true });
    assert.equal(opt.number, '1');
    assert.equal((await k.t.callOk<VoucherDetail>(vouchersRoutes, 'vouchers.get', { id: res.id })).isOptional, true);
    const missing = await k.t.call(vouchersRoutes, 'vouchers.get', { id: 99999 });
    assert.equal(missing.ok ? 'ok' : missing.error.code, 'NOT_FOUND');
    const docs = await k.t.callOk<TrackingDoc[]>(vouchersRoutes, 'vouchers.trackingRefs', { partyLedgerId: k.L.acme, kind: 'delivery' });
    assert.deepEqual(docs, []);
    k.t.close();
  });
});
