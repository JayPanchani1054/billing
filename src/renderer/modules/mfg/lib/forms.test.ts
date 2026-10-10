import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BomDetail, MfgJournalDetail, PendingJobWorkResult } from '../../../../shared/types/mfg.ts';
import { blankBomRow, bomFormFrom, emptyBomForm, mapBomErrors, toBomInput } from './bomForm.ts';
import { applyBom, blankCost, blankRow, emptyForm, fromDetail, mapErrors, sectionsFor, toVoucherInput } from './journalForm.ts';
import { alertText, pendingJobWorkExport, returnStatusText } from './model.ts';

const BOM: BomDetail = {
  id: 7,
  guid: 'g',
  itemId: 3,
  itemName: 'Chair',
  unit: 'Nos',
  unitDecimals: 0,
  name: 'Standard',
  outputQty: 10,
  isDefault: true,
  isActive: true,
  revision: 2,
  notes: null,
  usedInVouchers: 0,
  createdAt: '',
  updatedAt: '',
  lines: [
    { lineNo: 1, kind: 'component', itemId: 1, itemName: 'Steel', unit: 'Kg', unitDecimals: 3, qty: 50, godownId: null, godownName: null, valueBasis: null, valueRate: null, valuePct: null, notes: null },
    { lineNo: 2, kind: 'component', itemId: 2, itemName: 'Paint', unit: 'Ltr', unitDecimals: 3, qty: 4, godownId: 9, godownName: 'Paint store', valueBasis: null, valueRate: null, valuePct: null, notes: null },
    { lineNo: 3, kind: 'scrap', itemId: 4, itemName: 'Scrap', unit: 'Kg', unitDecimals: 3, qty: 5, godownId: null, godownName: null, valueBasis: 'rate', valueRate: 20, valuePct: null, notes: null },
  ],
};

describe('journal form', () => {
  test('sections follow the class and the kind of the job work godown', () => {
    assert.deepEqual(sectionsFor('manufacturing', null), { products: true, components: true, material: null, costs: true, needsGodown: false });
    assert.equal(sectionsFor('material_out', null).needsGodown, true);
    assert.equal(sectionsFor('material_out', 'ours_with_party').material, 'transfer');
    assert.equal(sectionsFor('material_out', 'party_with_us').material, 'issue');
    assert.deepEqual(sectionsFor('material_in', 'ours_with_party'), { products: true, components: true, material: 'transfer', costs: true, needsGodown: false });
    assert.equal(sectionsFor('material_in', 'party_with_us').material, 'receipt');
  });

  test('applying a BOM scales components and scrap, keeps material lines', () => {
    const f0 = emptyForm('material_in', 5, '2026-05-10');
    const withMaterial = { ...f0, rows: [blankRow('transfer', { itemId: 8, itemName: 'Die', qty: 1 })] };
    const f = applyBom(withMaterial, BOM, 25, 42);
    assert.equal(f.bomId, 7);
    assert.deepEqual(
      f.rows.map((r) => [r.role, r.itemName, r.qty, r.godownId]),
      [
        ['product', 'Chair', 25, null],
        ['scrap', 'Scrap', 12.5, null],
        ['component', 'Steel', 125, 42],
        ['component', 'Paint', 10, 9],
        ['transfer', 'Die', 1, null],
      ],
    );
  });

  test('voucher input: filled rows only, costs, job work fields; server errors map back to rows', () => {
    let f = applyBom(emptyForm('manufacturing', 5, '2026-05-10'), BOM, 20, null);
    f = { ...f, rows: [...f.rows, blankRow('component')], costs: [blankCost({ ledgerId: 11, amount: 100000 }), blankCost({ label: 'Overhead', basis: 'percent', pct: 5 }), blankCost()] };
    const built = toVoucherInput(f);
    const block = built.input.stockJournal;
    assert.ok(block);
    assert.equal(block.lines.length, 4, 'the blank component row is not sent');
    assert.deepEqual(block.additionalCosts, [
      { basis: 'amount', value: 100000, ledgerId: 11 },
      { basis: 'percent', value: 5, label: 'Overhead' },
    ]);
    assert.equal(block.thirdPartyGodownId, undefined);
    assert.deepEqual(block.lines[1], { role: 'scrap', itemId: 4, qty: 10, valueBasis: 'rate', valueRate: 20 });
    const errs = mapErrors({ 'stockJournal.lines[2].qty': 'bad qty', 'stockJournal.additionalCosts[1].value': 'bad pct', partyLedgerId: 'party', 'stockJournal.bomId': 'bom', other: 'x' }, built);
    assert.equal(errs.rows.get(f.rows[2].key), 'bad qty');
    assert.equal(errs.costs.get(f.costs[1].key), 'bad pct');
    assert.deepEqual(errs.fields, { partyLedgerId: 'party', bomId: 'bom' });
    assert.deepEqual(errs.general, ['x']);

    const out = toVoucherInput(
      { ...emptyForm('material_out', 6, '2026-05-10'), partyLedgerId: 2, thirdPartyGodownId: 3, jobWorkOrderId: 4, rows: [blankRow('transfer', { itemId: 1, qty: 60, rate: 50, goodsType: 'inputs' })] },
      { id: 99, updatedAt: 'u', number: '1' },
    ).input;
    assert.deepEqual(out.stockJournal, { lines: [{ role: 'transfer', itemId: 1, qty: 60, goodsType: 'inputs', rate: 50 }], thirdPartyGodownId: 3, jobWorkOrderId: 4 });
    assert.equal(out.id, 99);
    assert.equal(out.expectedUpdatedAt, 'u');
    assert.equal(out.partyLedgerId, 2);
  });

  test('a saved journal comes back into the form with item names', () => {
    const d: MfgJournalDetail = {
      id: 1,
      voucherTypeId: 5,
      class: 'manufacturing',
      date: '2026-05-10',
      number: '3',
      partyLedgerId: null,
      narration: 'n',
      isOptional: false,
      updatedAt: 'u',
      bomName: 'Standard',
      orderNumber: null,
      items: [{ id: 3, name: 'Chair', unit: 'Nos', decimals: 0 }],
      ledgers: [],
      block: { bomId: 7, lines: [{ role: 'product', itemId: 3, qty: 20 }], additionalCosts: [{ basis: 'percent', value: 5, label: 'OH' }] },
    };
    const f = fromDetail(d);
    assert.deepEqual([f.number, f.bomId, f.rows[0].itemName, f.rows[0].unit, f.costs[0].pct, f.costs[0].label], ['3', 7, 'Chair', 'Nos', 5, 'OH']);
  });
});

describe('BOM form', () => {
  test('round trip and error mapping', () => {
    const f = bomFormFrom(BOM);
    assert.equal(f.rows.length, 3);
    const { input, lineKeys } = toBomInput({ ...f, rows: [...f.rows, blankBomRow()] }, { id: 7, updatedAt: 'u' });
    assert.ok(input);
    assert.equal(input.lines.length, 3);
    assert.deepEqual(input.lines[2], { kind: 'scrap', itemId: 4, qty: 5, godownId: null, valueBasis: 'rate', valueRate: 20, valuePct: null });
    assert.deepEqual(input.lines[0].valueBasis, null);
    assert.equal(input.expectedUpdatedAt, 'u');
    const m = mapBomErrors({ 'lines[1].qty': 'q', name: 'n', x: 'g' }, lineKeys);
    assert.equal(m.rows.get(f.rows[1].key), 'q');
    assert.deepEqual(m.fields, { name: 'n' });
    assert.equal(toBomInput(emptyBomForm(null)).input, null, 'no item chosen yet');
  });
});

describe('report model', () => {
  test('status texts and the pending job work export', () => {
    assert.equal(returnStatusText('overdue', -51), 'Overdue by 51 days');
    assert.equal(returnStatusText('due_soon', 1), 'Due in 1 day');
    assert.equal(returnStatusText('due_soon', 0), 'Due today');
    assert.equal(returnStatusText('no_limit', null), 'No time limit');
    const res: PendingJobWorkResult = {
      asOf: '2026-06-30',
      rows: [
        { key: 'm:1', direction: 'out', voucherId: 1, lineNo: 2, challanNo: '1', sentOn: '2025-05-10', partyLedgerId: 1, partyName: 'Ravi', godownId: 2, godownName: 'JW', itemId: 3, itemName: 'Steel', unit: 'Kg', goodsType: 'inputs', sentQty: 60, returnedQty: 50, pendingQty: 10, pendingValue: 50000, dueDate: '2026-05-10', daysLeft: -51, status: 'overdue', ageDays: 416, orderNo: 'JWO-1' },
      ],
      unexplained: [],
      counts: { overdue: 1, dueSoon: 0, total: 1 },
      overdueValue: 50000,
    };
    const t = pendingJobWorkExport(res, 'out');
    assert.equal(t.rows[0][12], 'Overdue by 51 days');
    assert.equal(t.totals?.[10], 50000);
    assert.equal(t.columns.length, t.rows[0].length);
    assert.match(alertText({ overdue: 1, dueSoon: 2, nextDue: '2026-07-20' }) ?? '', /1 challan line is past the return date.*2 due within 30 days \(first on 20-Jul-2026\)/);
    assert.equal(alertText({ overdue: 0, dueSoon: 0, nextDue: null }), null);
  });
});
