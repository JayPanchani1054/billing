/**
 * Regression tests: stock and bill-wise integrity, alter safety, bank links and field paths.
 * Company: Maharashtra (27), working date 15-Apr-2026. Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { pendingBills } from './bills.ts';
import { getVoucher } from './queries.ts';
import { deleteVoucher, previewVoucher, saveVoucher, setVoucherOptional } from './service.ts';
import { bills, purchaseInput, salesInput, save, setupKit, stockOf, throwsApp, throwsField, type Kit } from './testkit.ts';

const physical = (k: Kit, counts: number[]): VoucherInput => ({
  voucherTypeId: k.vt.physical_stock,
  date: k.t.today,
  mode: 'inventory',
  items: counts.map((qty) => ({ itemId: k.I.mixer, qty, rate: 150 })),
});

describe('physical stock', () => {
  it('lines counting the same item and godown are added up, not each set against the book quantity', () => {
    const k = setupKit();
    // Book 50. Counted 30 (rack A) + 20 (rack B) = 50 → no adjustment.
    // Before the fix each line was diffed against the full book: (30 − 50) + (20 − 50) = −50 → stock 0.
    const a = save(k, physical(k, [30, 20]));
    assert.deepEqual(k.t.db.all('SELECT qty FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id: a.id }).map((r) => (r as { qty: number }).qty), [-20, 20]);
    assert.equal(stockOf(k, k.I.mixer), 50);
    // Counted 30 + 10 = 40 against a book of 50 → −10 → stock 40.
    save(k, physical(k, [30, 10]));
    assert.equal(stockOf(k, k.I.mixer), 40);
    k.t.close();
  });
});

describe('negative stock per batch', () => {
  it('a batch line is checked against that batch, not the whole item', () => {
    const k = setupKit({ features: { batches: true } });
    const med = k.t.addStockItem({ name: 'Medicine', gstRate: 5, hsnSac: '3004', maintainBatches: true, openingQty: 10, openingRate: 5, batchName: 'B1' });
    k.t.db.run(`INSERT INTO stock_openings (item_id, godown_id, batch_name, qty, rate, value) VALUES (:i, :g, 'B2', 5, 5, 2500)`, { i: med, g: k.t.ids.mainGodownId });
    const sell = (batchName: string, qty: number) => previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: med, qty, rate: 10, batchName }] }));
    // Item total 15 (B1 10 + B2 5): selling 8 of B2 used to pass because only the item total was checked.
    const w = sell('B2', 8).warnings.find((x) => x.code === 'negative_stock');
    assert.equal(w?.message, 'Stock of Medicine (batch B2) in Main Location will go negative: 5 Nos available, 8 Nos required.');
    assert.equal(w?.path, 'items[0]');
    assert.equal(sell('B2', 5).warnings.some((x) => x.code === 'negative_stock'), false);
    assert.equal(sell('B1', 8).warnings.some((x) => x.code === 'negative_stock'), false);
    k.t.close();
  });
});

describe('default bill names never net two documents together', () => {
  it('a credit note numbered like an open invoice gets its own bill', () => {
    const k = setupKit();
    save(k, salesInput(k)); // Sales 1: ₹1,180.00 → bill '1' Dr 118000
    // Credit Note 1 (own series) without an original invoice: ₹200 + 18% = ₹236.00 Cr.
    // Before the fix its new reference '1' was netted into the invoice's bill: one bill '1' of ₹944.00.
    const cn = save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    assert.deepEqual(bills(k, cn.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['new', '1/2026-27', -23600]]);
    assert.deepEqual(
      pendingBills(k.t.db, k.L.acme, k.t.today, k.t.today).map((b) => [b.billName, b.amount]),
      [
        ['1', 118000],
        ['1/2026-27', -23600],
      ],
    );
    k.t.close();
  });

  it('the same number next financial year, and a supplier reusing an invoice number, get the year', () => {
    const k = setupKit();
    save(k, salesInput(k, { date: '2026-04-15' })); // Sales 1 of 2026-27
    const next = save(k, salesInput(k, { date: '2027-04-05' })); // Sales 1 of 2027-28 (yearly restart)
    assert.equal(next.number, '1');
    assert.deepEqual(bills(k, next.id).map((b) => b.bill_name), ['1/2027-28']);
    assert.deepEqual(pendingBills(k.t.db, k.L.acme, '2027-04-05', k.t.today).map((b) => [b.billName, b.billDate, b.amount]), [
      ['1', '2026-04-15', 118000],
      ['1/2027-28', '2027-04-05', 118000],
    ]);
    save(k, purchaseInput(k, { date: '2026-04-15', referenceNo: 'SUP-101' }));
    const p2 = save(k, purchaseInput(k, { date: '2027-04-05', referenceNo: 'SUP-101' }));
    assert.deepEqual(bills(k, p2.id).map((b) => b.bill_name), ['SUP-101/2027-28']);
    k.t.close();
  });

  it('an altered voucher keeps its bill name even after the colliding bill is gone', () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    const cn = save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    assert.deepEqual(bills(k, cn.id).map((b) => b.bill_name), ['1/2026-27']);
    deleteVoucher(k.t.ctx, inv.id);
    save(k, { ...getVoucher(k.t.db, cn.id).input, narration: 'edited' });
    assert.deepEqual(bills(k, cn.id).map((b) => b.bill_name), ['1/2026-27'], 'receipts made against 1/2026-27 still find it');
    k.t.close();
  });
});

describe('alter keeps dependent documents valid', () => {
  const receiptAgainst1 = (k: Kit): VoucherInput => ({
    voucherTypeId: k.vt.receipt,
    date: k.t.today,
    mode: 'ledger',
    ledgers: [
      { ledgerId: k.L.bank, amount: 50000 },
      { ledgerId: k.L.acme, amount: -50000, billAllocations: [{ refType: 'against', billName: '1', amount: 50000 }] },
    ],
  });

  it('a settled invoice cannot move to another party or become optional', () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    save(k, receiptAgainst1(k));
    // Before the fix both alters went through and left Receipt 1 settling a bill that no longer exists.
    throwsApp(() => save(k, { ...getVoucher(k.t.db, inv.id).input, partyLedgerId: k.L.walkin }), 'BUSINESS_RULE', /Bill 1 of Acme Traders is settled by Receipt 1 dated 15-Apr-2026/);
    throwsApp(() => setVoucherOptional(k.t.ctx, inv.id, true, true), 'BUSINESS_RULE', /settled by Receipt 1/);
    // Changing the amount keeps the bill: allowed (₹1,180.00 → ₹2,360.00; ₹500.00 settled → ₹1,860.00 pending).
    save(k, { ...getVoucher(k.t.db, inv.id).input, items: [{ itemId: k.I.mixer, qty: 10, rate: 200 }] });
    assert.deepEqual(pendingBills(k.t.db, k.L.acme, k.t.today, k.t.today).map((b) => [b.billName, b.amount]), [['1', 236000 - 50000]]);
    k.t.close();
  });

  it('a billed delivery note keeps its party, billed items and regular status', () => {
    const k = setupKit();
    const dnInput: VoucherInput = { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] };
    const dn = save(k, dnInput);
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200, trackingRef: '1' }] }));
    assert.equal(stockOf(k, k.I.mixer), 45);
    const current = (): VoucherInput => getVoucher(k.t.db, dn.id).input;
    throwsApp(() => save(k, { ...current(), partyLedgerId: k.L.walkin }), 'BUSINESS_RULE', /billed in Sales 1 dated 15-Apr-2026/);
    throwsApp(() => setVoucherOptional(k.t.ctx, dn.id, true, true), 'BUSINESS_RULE', /must stay a regular voucher/);
    throwsApp(() => save(k, { ...current(), items: [{ itemId: k.I.rice, qty: 5, rate: 50 }] }), 'BUSINESS_RULE', /Mixer Grinder of this note has been billed/);
    assert.equal(stockOf(k, k.I.mixer), 45, 'the invoice line still relies on the note');
    // Correcting the quantity is fine.
    save(k, { ...current(), items: [{ itemId: k.I.mixer, qty: 6, rate: 200 }] });
    assert.equal(stockOf(k, k.I.mixer), 44);
    k.t.close();
  });
});

describe('tracked invoice lines (billing a delivery note)', () => {
  const dn = (k: Kit, over: Partial<VoucherInput> = {}): VoucherInput => ({
    voucherTypeId: k.vt.delivery_note,
    date: k.t.today,
    mode: 'inventory',
    partyLedgerId: k.L.acme,
    items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }],
    ...over,
  });

  it('billing an optional note is flagged: neither document would move the stock', () => {
    const k = setupKit();
    save(k, dn(k, { isOptional: true }));
    const p = previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200, trackingRef: '1' }] }));
    // Before the fix the optional note counted as found: no warning, and stock stayed at 50 for good.
    const w = p.warnings.find((x) => x.code === 'tracking_ref');
    assert.match(w?.message ?? '', /delivery note 1 is optional, so it has not moved any stock/);
    assert.equal(w?.level, 'confirm');
    k.t.close();
  });

  it('billing more than the note has left is flagged with the quantity that would not move', () => {
    const k = setupKit();
    save(k, dn(k)); // 5 delivered → stock 45
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 3, rate: 200, trackingRef: '1' }] })); // 3 billed, 2 left
    // Billing 2 + 4 on two lines: 2 are pending, the other 4 would never leave stock.
    const p = previewVoucher(k.t.ctx, salesInput(k, {
      items: [
        { itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '1' },
        { itemId: k.I.mixer, qty: 4, rate: 200, trackingRef: '1' },
      ],
    }));
    assert.deepEqual(
      p.warnings.filter((w) => w.code === 'tracking_ref').map((w) => [w.path, w.message]),
      [['items[1].trackingRef', 'Line 2 (Mixer Grinder): delivery note 1 has 0 Nos left to bill, so 4 Nos of this line will not change stock. Enter the extra quantity on a separate line without the tracking reference.']],
    );
    // Exactly the pending quantity: no warning; an alter of that invoice does not count itself.
    const ok = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '1' }] }));
    assert.deepEqual(ok.warnings, []);
    assert.deepEqual(previewVoucher(k.t.ctx, { ...getVoucher(k.t.db, ok.id).input, narration: 'x' }).warnings, []);
    assert.equal(stockOf(k, k.I.mixer), 45);
    k.t.close();
  });
});

describe('bank reconciliation links', () => {
  it('making a reconciled voucher optional unmatches its statement line (kept bank date)', () => {
    const k = setupKit();
    const rec = save(k, { voucherTypeId: k.vt.receipt, date: k.t.today, mode: 'ledger', ledgers: [{ ledgerId: k.L.bank, amount: 50000 }, { ledgerId: k.L.acme, amount: -50000 }] });
    const entry = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :b', { id: rec.id, b: k.L.bank }) as number;
    k.t.db.run('UPDATE ledger_entries SET bank_date = :d WHERE id = :id', { d: '2026-04-16', id: entry });
    const batch = k.t.db.run(`INSERT INTO import_batches (kind, imported_at) VALUES ('bank_statement', :ts)`, { ts: k.t.clock.now().toISOString() }).lastInsertRowid;
    const line = k.t.db.run(
      `INSERT INTO bank_statement_lines (batch_id, ledger_id, txn_date, amount, status, matched_entry_id) VALUES (:b, :l, '2026-04-16', 50000, 'matched', :e)`,
      { b: batch, l: k.L.bank, e: entry },
    ).lastInsertRowid;
    // Before the fix the statement line stayed 'matched' to an entry that no longer counts in the books.
    setVoucherOptional(k.t.ctx, rec.id, true);
    assert.deepEqual(k.t.db.get('SELECT status, matched_entry_id FROM bank_statement_lines WHERE id = :id', { id: line }), { status: 'unmatched', matched_entry_id: null });
    assert.equal(k.t.db.value('SELECT bank_date FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :b', { id: rec.id, b: k.L.bank }), '2026-04-16');
    k.t.close();
  });
});

describe('field paths for hard errors', () => {
  it('stale or inactive masters and manual-number problems point at the input field', () => {
    const k = setupKit({ features: { costCentres: true } });
    throwsField(() => save(k, salesInput(k, { ledgers: [{ ledgerId: k.L.freight, amount: 100 }, { ledgerId: 99999, amount: 100 }] })), 'ledgers[1].ledgerId', /no longer exists/);
    throwsField(() => save(k, salesInput(k, { items: [{ itemId: 99999, qty: 1, rate: 1 }] })), 'items[0].itemId', /stock item no longer exists/);
    throwsField(() => save(k, salesInput(k, { partyLedgerId: 99999 })), 'partyLedgerId', /party ledger no longer exists/);
    k.t.db.run('UPDATE stock_items SET is_active = 0 WHERE id = :id', { id: k.I.rice });
    throwsField(() => save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 1 }, { itemId: k.I.rice, qty: 1, rate: 1 }] })), 'items[1].itemId', /Rice Bag is inactive/);
    const rent = k.t.addLedger({ name: 'Rent CC', group: 'INDIRECT_EXPENSES', costCentres: true });
    throwsField(
      () =>
        save(k, {
          voucherTypeId: k.vt.journal,
          date: k.t.today,
          mode: 'ledger',
          ledgers: [{ ledgerId: rent, amount: 100, costAllocations: [{ costCentreId: 4242, amount: 100 }] }, { ledgerId: k.L.capital, amount: -100 }],
        }),
      'ledgers[0].costAllocations[0].costCentreId',
      /cost centre no longer exists/,
    );
    k.t.db.run(`UPDATE voucher_types SET numbering_method = 'manual' WHERE id = :id`, { id: k.vt.sales });
    save(k, salesInput(k, { number: 'A-1' }));
    const dup = throwsApp(() => save(k, salesInput(k, { number: 'A-1' })), 'CONFLICT', /already used/);
    assert.deepEqual((dup.details as Array<{ path: string }>).map((i) => i.path), ['number']);
    k.t.close();
  });

  it('a strict save (no acknowledgement) with only informational warnings succeeds', () => {
    const k = setupKit();
    const plain = k.t.addStockItem({ name: 'Loose Item', gstRate: 18, openingQty: 10, openingRate: 10 });
    const res = saveVoucher(k.t.ctx, salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: plain, qty: 1, rate: 100 }] }));
    assert.deepEqual(res.warnings.map((w) => [w.code, w.level]), [['gst_missing_hsn', 'info']]);
    k.t.close();
  });
});
