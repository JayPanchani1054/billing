import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { deleteItem } from '../inventory/items.ts';
import { bomCost, bomRevisions, deleteBom, getBom, listBoms, saveBom } from './bom.ts';
import { mfgKit, post } from './testkit.ts';

function issuesOf(fn: () => unknown): Array<{ path: string; message: string }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError && e.code === 'VALIDATION') return e.details as Array<{ path: string; message: string }>;
    throw e;
  }
  assert.fail('expected a VALIDATION error');
}

describe('Bill of Materials master', () => {
  test('create, default, alter with revision history and edit log', () => {
    const k = mfgKit();
    const { t, I } = k;
    const std = saveBom(t.ctx, {
      itemId: I.chair,
      name: 'Standard',
      outputQty: 10,
      lines: [
        { kind: 'component', itemId: I.steel, qty: 50 },
        { kind: 'component', itemId: I.paint, qty: 4 },
        { kind: 'scrap', itemId: I.scrap, qty: 5, valueBasis: 'rate', valueRate: 20 },
      ],
    });
    assert.equal(std.isDefault, true, 'the first BOM of an item is its default');
    assert.equal(std.revision, 1);
    assert.deepEqual(std.lines.map((l) => [l.kind, l.itemName, l.qty]), [
      ['component', 'Steel Sheet', 50],
      ['component', 'Paint', 4],
      ['scrap', 'Scrap Metal', 5],
    ]);
    const deluxe = saveBom(t.ctx, { itemId: I.chair, name: 'Deluxe', outputQty: 1, isDefault: true, lines: [{ kind: 'component', itemId: I.steel, qty: 6 }] });
    assert.equal(deluxe.isDefault, true);
    assert.equal(getBom(t.db, std.id).isDefault, false, 'only one default per item');

    const altered = saveBom(t.ctx, { id: std.id, itemId: I.chair, name: 'Standard', outputQty: 10, lines: [{ kind: 'component', itemId: I.steel, qty: 55 }], expectedUpdatedAt: std.updatedAt });
    assert.equal(altered.revision, 2);
    const revs = bomRevisions(t.db, std.id);
    assert.deepEqual(revs.map((r) => r.revision), [2, 1]);
    assert.equal(revs[1].snapshot.lines.length, 3, 'revision 1 keeps the original lines');
    assert.equal(revs[0].snapshot.lines[0].qty, 55);
    const log = t.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE entity_type = 'bom' AND entity_id = :id ORDER BY id`, { id: std.id });
    assert.deepEqual(log.map((l) => l.action), ['create', 'alter']);
    assert.equal(listBoms(t.db, { itemId: I.chair }).total, 2);
    t.close();
  });

  test('rules: components, self-reference, circular BOMs, value basis, duplicate names, stale alter', () => {
    const k = mfgKit();
    const { t, I } = k;
    assert.ok(issuesOf(() => saveBom(t.ctx, { itemId: I.chair, name: 'X', outputQty: 1, lines: [] })).some((i) => i.path === 'lines'));
    assert.ok(issuesOf(() => saveBom(t.ctx, { itemId: I.chair, name: 'X', outputQty: 1, lines: [{ kind: 'component', itemId: I.chair, qty: 1 }] })).some((i) => i.path === 'lines[0].itemId'));
    assert.ok(
      issuesOf(() =>
        saveBom(t.ctx, {
          itemId: I.chair,
          name: 'X',
          outputQty: 1,
          lines: [
            { kind: 'component', itemId: I.steel, qty: 1 },
            { kind: 'by_product', itemId: I.scrap, qty: 1, valueBasis: 'percent', valuePct: 120 },
          ],
        }),
      ).some((i) => i.path === 'lines[1].valuePct'),
    );
    saveBom(t.ctx, { itemId: I.chair, name: 'Standard', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 1 }] });
    assert.ok(issuesOf(() => saveBom(t.ctx, { itemId: I.chair, name: 'standard', outputQty: 1, lines: [{ kind: 'component', itemId: I.paint, qty: 1 }] })).some((i) => i.path === 'name'));
    // Steel made from Chair while Chair is made from Steel → circular.
    assert.ok(issuesOf(() => saveBom(t.ctx, { itemId: I.steel, name: 'Recycle', outputQty: 1, lines: [{ kind: 'component', itemId: I.chair, qty: 1 }] })).some((i) => i.path === 'lines'));
    const b = saveBom(t.ctx, { itemId: I.scrap, name: 'S', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 1 }] });
    assert.throws(
      () => saveBom(t.ctx, { id: b.id, itemId: I.scrap, name: 'S', outputQty: 2, lines: [{ kind: 'component', itemId: I.steel, qty: 1 }], expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }),
      (e: unknown) => e instanceof AppError && e.code === 'CONFLICT',
    );
    t.close();
  });

  test('permissions: Data Entry may create but not alter or delete', () => {
    const k = mfgKit();
    const { t, I } = k;
    const ctx = t.ctxAs({ role: 'Data Entry' });
    const b = saveBom(ctx, { itemId: I.chair, name: 'A', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 1 }] });
    assert.throws(() => saveBom(ctx, { id: b.id, itemId: I.chair, name: 'B', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 1 }] }), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
    assert.throws(() => deleteBom(ctx, b.id), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
    t.close();
  });

  test('delete: refused while a voucher uses it; items in a BOM cannot be deleted', () => {
    const k = mfgKit();
    const { t, I, VT } = k;
    const b = saveBom(t.ctx, { itemId: I.chair, name: 'Standard', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 5 }] });
    for (const itemId of [I.chair, I.steel]) {
      assert.throws(() => deleteItem(t.ctx, itemId), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /bill\(s\) of materials/.test(e.message));
    }
    post(k, {
      voucherTypeId: VT.manufacturing,
      date: '2026-05-10',
      mode: 'inventory',
      stockJournal: { bomId: b.id, lines: [{ role: 'product', itemId: I.chair, qty: 1 }, { role: 'component', itemId: I.steel, qty: 5 }] },
    });
    assert.equal(getBom(t.db, b.id).usedInVouchers, 1);
    assert.throws(() => deleteBom(t.ctx, b.id), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /Mark it inactive/.test(e.message));
    const unused = saveBom(t.ctx, { itemId: I.chair, name: 'Spare', outputQty: 1, lines: [{ kind: 'component', itemId: I.paint, qty: 1 }] });
    deleteBom(t.ctx, unused.id);
    assert.equal(listBoms(t.db, { itemId: I.chair }).total, 1);
    t.close();
  });

  test('cost estimate at current cost (FIFO-aware), less scrap at its rate', () => {
    const k = mfgKit();
    const { t, I } = k;
    const b = saveBom(t.ctx, {
      itemId: I.chair,
      name: 'Standard',
      outputQty: 10,
      lines: [
        { kind: 'component', itemId: I.steel, qty: 50 },
        { kind: 'component', itemId: I.paint, qty: 4 },
        { kind: 'scrap', itemId: I.scrap, qty: 5, valueBasis: 'rate', valueRate: 20 },
      ],
    });
    // 20 chairs: steel 100 kg × ₹50 = 5,000.00; paint 8 L × ₹200 = 1,600.00; scrap 10 kg × ₹20 = 200.00
    // estimate = 6,600.00 − 200.00 = 6,400.00 → ₹320/chair
    const c = bomCost(t.db, t.today, { id: b.id, qty: 20, asOf: '2026-06-30' });
    assert.equal(c.componentCost, 660000);
    assert.equal(c.byProductValue, 20000);
    assert.equal(c.estimatedCost, 640000);
    assert.equal(c.unitCost, 320);
    assert.deepEqual(c.lines.map((l) => [l.itemName, l.qty, l.value]), [
      ['Steel Sheet', 100, 500000],
      ['Paint', 8, 160000],
      ['Scrap Metal', 10, 20000],
    ]);
    t.close();
  });
});
