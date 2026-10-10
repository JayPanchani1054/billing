import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Itc04Result, JobWorkOrderDetail, JobWorkOrderListRow } from '../../../../shared/types/mfg.ts';
import { blankCost, blankRow, emptyForm, lineValuesByKey, pickType, sectionsFor, withTrailingBlanks } from './journalForm.ts';
import { bomListExport, itc04ReturnedExport, itc04SentExport, itc04Title, jobWorkOrdersExport, orderStatusText } from './model.ts';
import { blankOrderRow, emptyOrderForm, godownForParty, mapOrderErrors, orderFormFrom, toOrderInput } from './orderForm.ts';

describe('journal entry helpers', () => {
  test('the voucher type: as asked, else the first active one of the class', () => {
    const types = [
      { id: 1, name: 'Mfg (old)', class: 'manufacturing' as const, isActive: false },
      { id: 2, name: 'Manufacturing Journal', class: 'manufacturing' as const, isActive: true },
      { id: 3, name: 'Material Out', class: 'material_out' as const, isActive: true },
    ];
    assert.equal(pickType(types, {})?.id, 2, 'default class is manufacturing, inactive types skipped');
    assert.equal(pickType(types, { cls: 'material_out' })?.id, 3);
    assert.equal(pickType(types, { cls: 'material_in' }), null);
    assert.equal(pickType(types, { voucherTypeId: 1 })?.id, 1, 'an explicit (even inactive) type is honoured — alteration');
  });

  test('one trailing blank row per section, one product row, costs only where they apply', () => {
    const mfg = sectionsFor('manufacturing', null);
    let f = withTrailingBlanks(emptyForm('manufacturing', 5, '2026-05-10'), mfg);
    assert.deepEqual(
      f.rows.map((r) => r.role),
      ['product', 'scrap', 'component'],
    );
    assert.equal(f.costs.length, 1, 'a blank additional-cost row');
    assert.equal(withTrailingBlanks(f, mfg), f, 'stable: no new object when nothing changes');
    // Typing on the blank component row adds another blank one after it.
    const comp = f.rows[2];
    f = withTrailingBlanks({ ...f, rows: f.rows.map((r) => (r.key === comp.key ? { ...r, itemId: 9, qty: 2 } : r)) }, mfg);
    assert.deepEqual(
      f.rows.map((r) => [r.role, r.itemId]),
      [
        ['product', null],
        ['scrap', null],
        ['component', 9],
        ['component', null],
      ],
    );
    // Extra blanks collapse to one.
    f = withTrailingBlanks({ ...f, rows: [...f.rows, blankRow('component'), blankRow('component')], costs: [blankCost({ amount: 500 }), blankCost(), blankCost()] }, mfg);
    assert.equal(f.rows.filter((r) => r.role === 'component').length, 2);
    assert.equal(f.costs.length, 2);

    // Material Out to our job worker: transfer lines only, no costs.
    const out = withTrailingBlanks({ ...emptyForm('material_out', 6, '2026-05-10'), costs: [blankCost({ amount: 1 })] }, sectionsFor('material_out', 'ours_with_party'));
    assert.deepEqual(
      out.rows.map((r) => r.role),
      ['transfer'],
    );
    assert.equal(out.costs.length, 0);
    // No job work godown chosen yet: nothing to enter.
    assert.equal(withTrailingBlanks(emptyForm('material_in', 7, '2026-05-10'), sectionsFor('material_in', null)).rows.length, 0);
    // Material In from our job worker: product, by-products, components consumed there, material returned.
    assert.deepEqual(
      withTrailingBlanks(emptyForm('material_in', 7, '2026-05-10'), sectionsFor('material_in', 'ours_with_party')).rows.map((r) => r.role),
      ['product', 'scrap', 'component', 'transfer'],
    );
  });

  test('preview values are matched to rows by the keys sent', () => {
    const m = lineValuesByKey([1000, null, 250], ['a', 'b', 'c']);
    assert.deepEqual([...m], [
      ['a', 1000],
      ['c', 250],
    ]);
    assert.equal(lineValuesByKey(undefined, ['a']).size, 0);
  });
});

describe('job work order form', () => {
  test('input from the form; blank rows dropped; header and line errors mapped', () => {
    const f = { ...emptyOrderForm('out', '2026-05-01'), partyLedgerId: 4, godownId: 8, itemId: 3, qty: 100, bomId: 7, dueDate: '2026-06-30', process: ' Machining ', rate: 12.5 };
    f.rows = [blankOrderRow({ itemId: 1, qty: 500, goodsType: 'inputs' }), blankOrderRow({ itemId: 2, qty: 1, goodsType: 'tools' }), blankOrderRow()];
    const { input, lineKeys } = toOrderInput(f);
    assert.ok(input);
    assert.deepEqual(input, {
      direction: 'out',
      date: '2026-05-01',
      partyLedgerId: 4,
      godownId: 8,
      itemId: 3,
      qty: 100,
      bomId: 7,
      dueDate: '2026-06-30',
      process: 'Machining',
      rate: 12.5,
      status: 'open',
      narration: null,
      lines: [
        { itemId: 1, qty: 500, goodsType: 'inputs' },
        { itemId: 2, qty: 1, goodsType: 'tools' },
      ],
    });
    assert.equal(lineKeys.length, 2);
    const errs = mapOrderErrors({ 'lines[1].qty': 'q', godownId: 'g', other: 'x' }, lineKeys);
    assert.equal(errs.rows.get(f.rows[1].key), 'q');
    assert.deepEqual(errs.fields, { godownId: 'g' });
    assert.deepEqual(errs.general, ['x']);
    assert.equal(toOrderInput(emptyOrderForm('in', '2026-05-01')).input, null, 'no party yet');
    // Without a product the BOM and quantity are not sent.
    const noItem = toOrderInput({ ...f, itemId: null }, { id: 9, updatedAt: 'u' }).input;
    assert.deepEqual([noItem?.qty, noItem?.bomId, noItem?.id, noItem?.expectedUpdatedAt], [null, null, 9, 'u']);
  });

  test('a saved order comes back; the party’s godown of the right kind is found', () => {
    const d: JobWorkOrderDetail = {
      id: 9,
      guid: 'g',
      direction: 'in',
      number: 'JWI-3',
      date: '2026-05-01',
      partyLedgerId: 4,
      partyName: 'Principal Ltd',
      godownId: 8,
      godownName: 'Principal stock',
      itemId: 3,
      itemName: 'Shaft',
      unit: 'Nos',
      qty: 50,
      bomId: null,
      bomName: null,
      dueDate: null,
      process: 'Turning',
      rate: null,
      status: 'open',
      narration: null,
      lines: [{ lineNo: 1, itemId: 1, itemName: 'Bar', unit: 'Kg', qty: 75, goodsType: 'inputs', sentQty: 75, returnedQty: 30 }],
      productDoneQty: 20,
      vouchers: [],
      createdAt: '',
      updatedAt: 'u',
    };
    const f = orderFormFrom(d);
    assert.deepEqual([f.number, f.process, f.rows[0].itemName, f.rows[0].qty], ['JWI-3', 'Turning', 'Bar', 75]);
    const godowns = [
      { id: 1, kind: 'none' as const, partyLedgerId: null },
      { id: 2, kind: 'party_with_us' as const, partyLedgerId: 4 },
      { id: 3, kind: 'ours_with_party' as const, partyLedgerId: 4 },
    ];
    assert.equal(godownForParty(godowns, 4, 'ours_with_party')?.id, 3);
    assert.equal(godownForParty(godowns, 4, null)?.id, 2);
    assert.equal(godownForParty(godowns, 5, null), null);
    assert.equal(godownForParty(godowns, null, null), null);
  });
});

describe('export layouts', () => {
  test('BOM list and job work orders', () => {
    const b = bomListExport([{ id: 1, itemId: 3, itemName: 'Chair', unit: 'Nos', name: 'Standard', outputQty: 10, isDefault: true, isActive: true, revision: 2, components: 2, byProducts: 1, updatedAt: '' }]);
    assert.deepEqual(b.rows[0], ['Chair', 'Standard', 10, 'Nos', 'Yes', 'Yes', 2, 1, 2]);
    assert.equal(b.columns.length, b.rows[0].length);
    const row: JobWorkOrderListRow = { id: 1, direction: 'out', number: 'JWO-1', date: '2026-05-01', partyName: 'Ravi', itemName: 'Chair', unit: 'Nos', qty: 100, productDoneQty: 40, pendingQty: 60, dueDate: '2026-05-31', status: 'open', overdue: true };
    const o = jobWorkOrdersExport([row], 'out');
    assert.equal(o.rows[0][9], 'Overdue');
    assert.equal(o.columns.length, o.rows[0].length);
    assert.equal(orderStatusText({ status: 'closed', overdue: true }), 'Closed');
    assert.equal(orderStatusText({ status: 'open', overdue: false }), 'Open');
  });

  test('ITC-04 tables keep the form’s column order; unregistered job workers report the state', () => {
    const r: Itc04Result = {
      from: '2026-04-01',
      to: '2026-09-30',
      frequency: 'half_yearly',
      dueDate: '2026-10-25',
      warnings: [],
      sent: [
        { jobWorkerGstin: null, jobWorkerState: '27', jobWorkerName: 'Ravi', challanNo: 'MO/1', challanDate: '2026-05-10', goodsType: 'capital_goods', description: 'Steel', hsn: '7208', uqc: 'KGS', qty: 60, taxableValue: 300000, igstRate: 0, cgstRate: 9, sgstRate: 9, cessRate: 0, voucherId: 1, lineNo: 1, key: 'm:1' },
      ],
      returned: [
        { table: '5A', jobWorkerGstin: '27AAAAA0000A1Z5', jobWorkerState: '27', jobWorkerName: 'Ravi', docNo: 'MI/1', docDate: '2026-06-01', originalChallanNo: 'MO/1', originalChallanDate: '2026-05-10', description: 'Steel', uqc: 'KGS', qty: 50, receivedDescription: 'Chair', receivedUqc: 'NOS', receivedQty: 10, lossesQty: 0, natureOfJobWork: 'Welding', voucherId: 2, lineNo: 2, key: '5:0' },
      ],
    };
    const s = itc04SentExport(r);
    assert.deepEqual(s.rows[0].slice(0, 5), ['', '27', 'MO/1', '2026-05-10', 'Capital Goods']);
    assert.equal(s.totals?.[9], 300000);
    assert.equal(s.columns.length, s.rows[0].length);
    const t = itc04ReturnedExport(r);
    assert.deepEqual(t.rows[0].slice(0, 3), ['5A', '27AAAAA0000A1Z5', '']);
    assert.equal(t.columns.length, t.rows[0].length);
    assert.equal(itc04Title('2026-04-01', '2026-09-30'), 'ITC-04 Apr-2026 to Sep-2026');
  });
});
