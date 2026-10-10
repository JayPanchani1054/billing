/**
 * Regression tests of the final-wave gap fixes in the mfg module (each fails if its defect returns).
 * Testkit masters (testkit.ts): Mehta Textiles = principal, "Mehta Goods" = party_with_us godown.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { saveFeatures } from '../company/service.ts';
import { listItems } from '../inventory/items.ts';
import { batchesFor, stockByItem, stockOnHand } from '../inventory/stock.ts';
import { reorderStatus } from '../stock/orders.ts';
import { AppError } from '../../lib/errors.ts';
import { duplicateVoucher, loadVoucherRow, saveVoucher, storedInput } from '../vouchers/service.ts';
import { mfgKit, post, purchase } from './testkit.ts';

describe('mfg gaps — a principal’s goods are not in our quantities', () => {
  test('stockByItem / item list / reorder status leave the principal’s godown out unless it is asked for', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    t.db.run('UPDATE stock_items SET reorder_level = 50 WHERE id = :id', { id: I.fabric });
    // 100 m of Mehta's fabric received for job work, 5 m of our own fabric bought.
    post(k, {
      voucherTypeId: VT.materialIn,
      date: '2026-06-01',
      mode: 'inventory',
      partyLedgerId: L.mehta,
      stockJournal: { thirdPartyGodownId: G.mehta, lines: [{ role: 'receipt', itemId: I.fabric, qty: 100, rate: 100 }] },
    });
    purchase(k, '2026-06-02', [{ itemId: I.fabric, qty: 5, rate: 90 }]);
    const asOf = '2026-06-30';
    // Ours: 5 (not 105). Asking for Mehta's godown explicitly still shows the 100 lying there.
    assert.equal(stockByItem(t.db, { asOf, today: t.today, itemIds: [I.fabric] }).get(I.fabric), 5);
    assert.equal(stockByItem(t.db, { asOf, today: t.today }).get(I.fabric), 5, 'all-items query too');
    assert.equal(stockByItem(t.db, { asOf, today: t.today, godownId: G.mehta }).get(I.fabric), 100);
    assert.equal(stockOnHand(t.db, { itemId: I.fabric, asOf, today: t.today }), 5);
    assert.equal(stockOnHand(t.db, { itemId: I.fabric, asOf, today: t.today, godownId: G.mehta }), 100);
    // Items with no principal's goods are unaffected (opening 100 kg of steel in Main Location).
    assert.equal(stockByItem(t.db, { asOf, today: t.today, itemIds: [I.steel] }).get(I.steel), 100);
    // Item list closing quantity.
    const row = listItems(t.db, { search: 'Fabric', withStock: true, asOf }, t.today).rows.find((r) => r.id === I.fabric);
    assert.equal(row?.stockQty, 5);
    // Reorder status: 5 on hand against a level of 50 → short by 45 (the principal's 100 m do not cover it).
    const re = reorderStatus(t.db, t.today, { asOf }).rows.find((r) => r.itemId === I.fabric);
    assert.equal(re?.closingQty, 5);
    assert.equal(re?.shortfall, 45);
    t.close();
  });

  test('batch balances without a godown are ours only', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    saveFeatures(t.ctx, { batches: true });
    t.db.run('UPDATE stock_items SET maintain_batches = 1 WHERE id = :id', { id: I.fabric });
    post(k, {
      voucherTypeId: VT.materialIn,
      date: '2026-06-01',
      mode: 'inventory',
      partyLedgerId: L.mehta,
      stockJournal: { thirdPartyGodownId: G.mehta, lines: [{ role: 'receipt', itemId: I.fabric, qty: 100, rate: 100, batchName: 'MEHTA-1' }] },
    });
    assert.deepEqual(batchesFor(t.db, I.fabric, null, '2026-06-30', { today: t.today }), []);
    assert.equal(batchesFor(t.db, I.fabric, G.mehta, '2026-06-30', { today: t.today })[0]?.qty, 100);
    t.close();
  });
});

describe('mfg gaps — altering a classed journal without its details', () => {
  test('the plain Stock Journal screen (no stockJournal block) is refused with a clear message; the mfg screen still alters it', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    const out = post(k, {
      voucherTypeId: VT.materialOut,
      date: '2026-06-01',
      mode: 'inventory',
      partyLedgerId: L.ravi,
      stockJournal: { thirdPartyGodownId: G.ravi, process: 'Machining', lines: [{ role: 'transfer', itemId: I.steel, qty: 10, rate: 50 }] },
    });
    const row = loadVoucherRow(t.db, out.id);
    assert.ok(row);
    const stored = storedInput(t.db, row);
    assert.ok(stored.stockJournal, 'the stored input keeps the block');
    // What the plain screen sends: the derived item lines, no block.
    const plain = { ...stored, id: out.id, expectedUpdatedAt: row.updated_at, acknowledgeWarnings: true };
    delete plain.stockJournal;
    const refused = (re: RegExp) => (e: unknown): boolean =>
      e instanceof AppError && e.code === 'VALIDATION' && re.test(JSON.stringify(e.details));
    assert.throws(() => saveVoucher(t.ctx, plain), refused(/job work .*Transactions › Material Out/));
    // Nothing was lost: the details are still there.
    assert.equal(t.db.value('SELECT class FROM stock_journal_details WHERE voucher_id = :id', { id: out.id }), 'material_out');
    // With the feature off the message says how to get back to the right screen.
    saveFeatures(t.ctx, { jobWork: false });
    assert.throws(() => saveVoucher(t.ctx, plain), refused(/Turn on Job work/));
    saveFeatures(t.ctx, { jobWork: true });
    // Altering through the block (the mfg screen) still works and keeps the class.
    saveVoucher(t.ctx, { ...stored, id: out.id, narration: 'altered', acknowledgeWarnings: true });
    assert.equal(t.db.value('SELECT class FROM stock_journal_details WHERE voucher_id = :id', { id: out.id }), 'material_out');
    // Duplicating from the general voucher screen drops a challan line's return-date extension.
    const ext = post(k, {
      voucherTypeId: VT.materialOut, date: '2026-06-03', mode: 'inventory', partyLedgerId: L.ravi,
      stockJournal: { thirdPartyGodownId: G.ravi, lines: [{ role: 'transfer', itemId: I.steel, qty: 5, rate: 50, extendedTo: '2027-12-31' }] },
    });
    const dup = duplicateVoucher(t.ctx, ext.id);
    assert.equal(dup.stockJournal?.lines[0].extendedTo, undefined);
    assert.equal(dup.stockJournal?.lines[0].qty, 5);
    // A plain stock journal (no details) is altered on the plain screen as before.
    const sj = post(k, { voucherTypeId: VT.stockJournal, date: '2026-06-02', mode: 'inventory', items: [{ itemId: I.steel, qty: 1, rate: 50, isConsumption: true }, { itemId: I.scrap, qty: 1, rate: 50 }] });
    const sjRow = loadVoucherRow(t.db, sj.id);
    assert.ok(sjRow);
    saveVoucher(t.ctx, { ...storedInput(t.db, sjRow), id: sj.id, narration: 'plain alter', acknowledgeWarnings: true });
    t.close();
  });
});
