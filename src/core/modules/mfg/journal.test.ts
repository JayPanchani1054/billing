import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { VoucherInput, VoucherPreview } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { AppError } from '../../lib/errors.ts';
import { saveFeatures } from '../company/service.ts';
import { closingStockValue, computeStockValuation } from '../inventory/valuation.ts';
import { itemVouchers } from '../stock/itemVouchers.ts';
import { cancelVoucher, deleteVoucher, previewVoucher, setVoucherOptional } from '../vouchers/service.ts';
import { saveBom } from './bom.ts';
import { getJournal, productionRegister } from './journalQueries.ts';
import { mfgKit, post, purchase, type MfgKit } from './testkit.ts';

/**
 * Hand-verified Manufacturing Journal (testkit masters; BOM "Standard" for 10 chairs: Steel 50 kg, Paint 4 L,
 * scrap 5 kg of Scrap Metal at ₹20/kg). 10-May-2026: make 20 chairs, labour ₹1,000 + 5% overhead.
 *   Paint purchase 01-May: 10 L @ ₹220 (FIFO layers: 10 @ 200, 10 @ 220).
 *   Steel (avg): 100 kg × ₹50 = 5,000.00            Paint (FIFO): 8 L of the ₹200 layer = 1,600.00
 *   C = 6,600.00   A = 1,000.00 + 5% × 6,600.00 (330.00) = 1,330.00   P = 7,930.00
 *   scrap 10 kg × ₹20 = 200.00 → Chair 20 = 7,730.00 (₹386.50 each)
 *   Closing stock = opening 7,000.00 + paint 2,200.00 + additional 1,330.00 = 10,530.00 (+ the press die 25,000.00):
 *     chair 7,730.00 + scrap 200.00 + paint (2 @ 200 + 10 @ 220) 2,600.00 + steel 0 = 10,530.00
 */
function journal(k: MfgKit, bomId: number, qty = 20, over: Partial<VoucherInput> = {}): VoucherInput {
  const { I, VT, L } = k;
  return {
    voucherTypeId: VT.manufacturing,
    date: '2026-05-10',
    mode: 'inventory',
    narration: 'Batch 7',
    stockJournal: {
      bomId,
      lines: [
        { role: 'product', itemId: I.chair, qty },
        { role: 'component', itemId: I.steel, qty: qty * 5 },
        { role: 'component', itemId: I.paint, qty: (qty * 4) / 10 },
        { role: 'scrap', itemId: I.scrap, qty: qty / 2, valueBasis: 'rate', valueRate: 20 },
      ],
      additionalCosts: [
        { ledgerId: L.labour, basis: 'amount', value: 100000 },
        { label: 'Factory overhead', basis: 'percent', value: 5 },
      ],
    },
    ...over,
  };
}

function setup(): { k: MfgKit; bomId: number } {
  const k = mfgKit();
  const bom = saveBom(k.t.ctx, {
    itemId: k.I.chair,
    name: 'Standard',
    outputQty: 10,
    lines: [
      { kind: 'component', itemId: k.I.steel, qty: 50 },
      { kind: 'component', itemId: k.I.paint, qty: 4 },
      { kind: 'scrap', itemId: k.I.scrap, qty: 5, valueBasis: 'rate', valueRate: 20 },
    ],
  });
  purchase(k, '2026-05-01', [{ itemId: k.I.paint, qty: 10, rate: 220 }]);
  return { k, bomId: bom.id };
}

const row = (k: MfgKit, itemId: number, from = '2026-04-01', to = '2026-06-30') =>
  computeStockValuation(k.t.db, { from, to, today: k.t.today, itemIds: [itemId] }).rows.find((r) => r.itemId === itemId);

describe('Manufacturing Journal', () => {
  test('preview estimate, posting, engine values, Balance Sheet stock and no ledger entries', () => {
    const { k, bomId } = setup();
    const { t, I } = k;
    const pv: VoucherPreview = previewVoucher(t.ctx, journal(k, bomId));
    assert.ok(pv.stockJournal);
    assert.equal(pv.stockJournal.consumed, 660000);
    assert.equal(pv.stockJournal.additional, 133000);
    assert.deepEqual(pv.stockJournal.additionalValues, [100000, 33000]);
    assert.equal(pv.stockJournal.byProducts, 20000);
    assert.equal(pv.stockJournal.productValue, 773000);
    assert.equal(pv.stockJournal.productRate, 386.5);
    assert.equal(pv.entries.length, 0, 'a stock journal posts no ledger entries');
    assert.equal(pv.inventory.filter((l) => l.isConsumption).length, 2);

    const saved = post(k, journal(k, bomId));
    assert.equal(t.db.value('SELECT COUNT(*) FROM ledger_entries WHERE voucher_id = :id', { id: saved.id }), 0);
    assert.equal(t.db.value('SELECT total_amount FROM vouchers WHERE id = :id', { id: saved.id }), 793000, 'chair 7,730 + scrap 200 (estimate)');
    const d = t.db.get<{ class: string; item_id: number; qty: number; bom_id: number; bom_revision: number }>('SELECT * FROM stock_journal_details WHERE voucher_id = :id', { id: saved.id });
    assert.deepEqual([d?.class, d?.item_id, d?.qty, d?.bom_id, d?.bom_revision], ['manufacturing', I.chair, 20, bomId, 1]);

    assert.deepEqual(row(k, I.chair)?.inward, { qty: 20, value: 773000 });
    assert.deepEqual(row(k, I.scrap)?.closing.value, 20000);
    assert.deepEqual(row(k, I.steel)?.outward, { qty: 100, value: 500000 });
    assert.equal(row(k, I.paint)?.closing.value, 260000);
    // Opening 5,000 + 2,000 (+ die 25,000) = 32,000.00; + paint 2,200.00 + additional 1,330.00 = 35,530.00
    assert.equal(closingStockValue(t.db, { asOf: '2026-06-30', today: t.today }), 3553000);

    // The stock item ledger agrees with the summary.
    const iv = itemVouchers(t.db, t.today, { itemId: I.chair, from: '2026-04-01', to: '2026-06-30' });
    assert.equal(iv.totals.inwardValue, 773000);
    assert.equal(iv.closing.value, 773000);

    const reg = productionRegister(t.ctx, { from: '2026-04-01', to: '2026-06-30' });
    assert.equal(reg.rows.length, 1);
    assert.deepEqual(
      [reg.rows[0].consumed, reg.rows[0].additional, reg.rows[0].byProducts, reg.rows[0].productValue, reg.rows[0].productRate],
      [660000, 133000, 20000, 773000, 386.5],
    );
    // BOM estimate at today's cost: steel 100 × ₹50, paint at the current FIFO layer ₹200 → 6,600 − 200 = 6,400.00
    assert.equal(reg.rows[0].bomEstimate, 640000);
    t.close();
  });

  test('a back-dated purchase re-values the finished goods in every report (costs are not frozen)', () => {
    const { k, bomId } = setup();
    const { t, I } = k;
    post(k, journal(k, bomId));
    // Steel 100 kg @ ₹60 on 05-May (before the journal): average (5,000 + 6,000) / 200 = ₹55 → 100 kg = 5,500.00
    // C = 5,500 + 1,600 = 7,100.00; A = 1,000 + 355 = 1,355.00; P = 8,455.00; chair = 8,255.00
    purchase(k, '2026-05-05', [{ itemId: I.steel, qty: 100, rate: 60 }]);
    assert.equal(row(k, I.chair)?.closing.value, 825500);
    const reg = productionRegister(t.ctx, { from: '2026-04-01', to: '2026-06-30' });
    assert.equal(reg.rows[0].productValue, 825500);
    assert.equal(reg.rows[0].additional, 135500);
    t.close();
  });

  test('alter, optional, cancel and delete keep the derived rows in step', () => {
    const { k, bomId } = setup();
    const { t, I } = k;
    const saved = post(k, journal(k, bomId));
    const count = (table: string): number => Number(t.db.value(`SELECT COUNT(*) FROM ${table} WHERE voucher_id = :id`, { id: saved.id }));
    assert.deepEqual([count('stock_journal_details'), count('stock_journal_lines'), count('stock_journal_costs')], [1, 4, 2]);

    const detail = getJournal(t.ctx, saved.id);
    assert.equal(detail.block.lines.length, 4);
    post(k, { ...journal(k, bomId, 10), id: saved.id, expectedUpdatedAt: saved.updatedAt });
    assert.equal(t.db.value('SELECT qty FROM stock_journal_details WHERE voucher_id = :id', { id: saved.id }), 10);
    // 10 chairs: steel 50 kg (2,500.00) + paint 4 L (800.00) = 3,300.00; A = 1,000 + 165 = 1,165.00; scrap 5 × 20 = 100.00 → 4,365.00
    assert.equal(row(k, I.chair)?.closing.value, 436500);

    setVoucherOptional(t.ctx, saved.id, true, true);
    assert.equal(row(k, I.chair)?.closing.qty ?? 0, 0, 'optional: no stock movement');
    assert.equal(t.db.value('SELECT affects_stock FROM stock_journal_details WHERE voucher_id = :id', { id: saved.id }), 0);
    setVoucherOptional(t.ctx, saved.id, false, true);
    assert.equal(row(k, I.chair)?.closing.qty, 10);

    const fresh = t.db.value<string>('SELECT updated_at FROM vouchers WHERE id = :id', { id: saved.id }) as string;
    cancelVoucher(t.ctx, saved.id, 'wrong batch', fresh);
    assert.deepEqual([count('stock_journal_details'), count('stock_journal_lines'), count('stock_journal_costs')], [0, 0, 0]);

    const again = post(k, journal(k, bomId));
    deleteVoucher(t.ctx, again.id);
    assert.equal(t.db.value('SELECT COUNT(*) FROM stock_journal_lines WHERE voucher_id = :id', { id: again.id }), 0);
    t.close();
  });

  test('rules: one product, components needed, BOM of the product, feature on, classed types only', () => {
    const { k, bomId } = setup();
    const { t, I, VT } = k;
    const code = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        if (e instanceof AppError) return `${e.code}:${JSON.stringify(e.details ?? '')}:${e.message}`;
        throw e;
      }
      return 'ok';
    };
    const two = journal(k, bomId);
    two.stockJournal?.lines.push({ role: 'product', itemId: I.scrap, qty: 1 });
    assert.match(code(() => post(k, two)), /VALIDATION.*stockJournal\.lines/);
    const none = journal(k, bomId);
    if (none.stockJournal) none.stockJournal.lines = none.stockJournal.lines.filter((l) => l.role !== 'component');
    assert.match(code(() => post(k, none)), /components consumed/);
    const otherBom = saveBom(t.ctx, { itemId: I.scrap, name: 'S', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 1 }] });
    assert.match(code(() => post(k, journal(k, otherBom.id))), /stockJournal\.bomId/);
    assert.match(code(() => post(k, { ...journal(k, bomId), voucherTypeId: VT.stockJournal })), /stockJournal.*not a Manufacturing Journal/);
    saveFeatures(t.ctx, { manufacturing: false });
    assert.match(code(() => post(k, journal(k, bomId))), /BUSINESS_RULE.*turned off/);
    t.close();
  });

  test('by-products at a percentage of cost; a by-product worth more than the cost needs confirmation', () => {
    const { k } = setup();
    const { t, I, VT } = k;
    const input: VoucherInput = {
      voucherTypeId: VT.manufacturing,
      date: '2026-05-10',
      mode: 'inventory',
      stockJournal: {
        lines: [
          { role: 'component', itemId: I.steel, qty: 10 },
          { role: 'product', itemId: I.chair, qty: 2 },
          { role: 'by_product', itemId: I.scrap, qty: 1, valueBasis: 'percent', valuePct: 10 },
        ],
      },
    };
    // C = 10 × ₹50 = 500.00; scrap 10% = 50.00; chairs 450.00
    post(k, input);
    assert.equal(row(k, I.scrap)?.closing.value, 5000);
    assert.equal(row(k, I.chair)?.closing.value, 45000);
    const over: VoucherInput = {
      ...input,
      stockJournal: { lines: [{ role: 'component', itemId: I.steel, qty: 1 }, { role: 'product', itemId: I.chair, qty: 1 }, { role: 'scrap', itemId: I.scrap, qty: 1, valueBasis: 'rate', valueRate: 100 }] },
    };
    const pv = previewVoucher(t.ctx, over);
    assert.ok(pv.warnings.some((w) => w.code === 'mfg' && /nil/.test(w.message)));
    t.close();
  });

  test('end to end through the dispatcher: vouchers.save with a stockJournal block, then the register', async () => {
    const { k, bomId } = setup();
    const { t } = k;
    const res = await t.call(routes, 'vouchers.save', { ...journal(k, bomId), acknowledgeWarnings: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    const reg = await t.callOk<{ rows: Array<{ productValue: number }> }>(routes, 'mfg.production.register', { from: '2026-04-01', to: '2026-06-30' });
    assert.equal(reg.rows[0].productValue, 773000);
    const ctx = await t.callOk<{ voucherType: { class: string }; nextNumber: string | null }>(routes, 'mfg.journal.context', { voucherTypeId: k.VT.manufacturing, date: '2026-05-11' });
    assert.equal(ctx.voucherType.class, 'manufacturing');
    assert.equal(ctx.nextNumber, '2');
    const bad = await t.call(routes, 'vouchers.save', { ...journal(k, bomId), stockJournal: { lines: [{ role: 'product', itemId: k.I.chair, qty: 1, bogus: 1 }] } });
    assert.equal(bad.ok, false);
    t.close();
  });
});
