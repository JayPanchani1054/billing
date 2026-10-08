import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MovementPartyRow, NegativeStockRow, StockSummaryRow } from '../../../../shared/types/stock.ts';
import {
  ageingExport,
  batchStatusInfo,
  expiryText,
  godownDrill,
  keysUpToLevel,
  movementDrill,
  movementTree,
  negativeTree,
  overdueText,
  paramId,
  paramsPeriod,
  parentKeys,
  pendingOrdersExport,
  qtyDecimals,
  qtyText,
  rateText,
  signedAmountText,
  summaryDrill,
  summaryExport,
  visibleRows,
} from './model.ts';

const qv = (qty: number | null, value: number) => ({ qty, value });

function row(over: Partial<StockSummaryRow> & Pick<StockSummaryRow, 'key' | 'kind' | 'level'>): StockSummaryRow {
  return {
    id: 1,
    name: over.key,
    parentKey: null,
    hasChildren: false,
    unit: 'Nos',
    costingMethod: null,
    opening: qv(10, 1_00_000),
    inward: qv(5, 50_000),
    outward: qv(3, 30_000),
    closing: { qty: 12, value: 1_20_000, rate: 100 },
    ...over,
  };
}

const TREE: StockSummaryRow[] = [
  row({ key: 'g:1', kind: 'group', level: 0, hasChildren: true, id: 1 }),
  row({ key: 'g:2', kind: 'group', level: 1, parentKey: 'g:1', hasChildren: true, id: 2 }),
  row({ key: 'i:7', kind: 'item', level: 2, parentKey: 'g:2', id: 7 }),
  row({ key: 'i:8', kind: 'item', level: 0, id: 8 }),
];

describe('params and text', () => {
  test('paramsPeriod accepts an ordered ISO range only', () => {
    assert.deepEqual(paramsPeriod({ from: '2026-04-01', to: '2026-04-30' }), { from: '2026-04-01', to: '2026-04-30' });
    assert.equal(paramsPeriod({ from: '2026-04-30', to: '2026-04-01' }), null);
    assert.equal(paramsPeriod({ from: '01-04-2026', to: '2026-04-30' }), null);
    assert.equal(paramsPeriod(undefined), null);
    assert.equal(paramId(7), 7);
    assert.equal(paramId('7'), undefined);
    assert.equal(paramId(0), undefined);
  });

  test('quantities show only the decimals they need, Indian grouped, with the unit', () => {
    assert.equal(qtyDecimals(12), 0);
    assert.equal(qtyDecimals(2.5), 1);
    assert.equal(qtyDecimals(0.125), 3);
    assert.equal(qtyText(125000, 'Nos'), '1,25,000 Nos');
    assert.equal(qtyText(12.5, 'Kg'), '12.5 Kg');
    assert.equal(qtyText(-5, 'Nos'), '-5 Nos');
    assert.equal(qtyText(null, 'Nos'), '');
    assert.equal(qtyText(0, 'Nos', { blankZero: true }), '');
    assert.equal(rateText(119.3325), '119.3325');
    assert.equal(rateText(100), '100.00');
    assert.equal(rateText(null), '');
  });

  test('batch status, expiry and overdue texts', () => {
    assert.deepEqual(batchStatusInfo('expired'), { label: 'Expired', tone: 'danger' });
    assert.deepEqual(batchStatusInfo('expiring'), { label: 'Expiring soon', tone: 'warning' });
    assert.equal(expiryText(15), '15 days left');
    assert.equal(expiryText(1), '1 day left');
    assert.equal(expiryText(0), 'Expires today');
    assert.equal(expiryText(-5), 'Expired 5 days ago');
    assert.equal(expiryText(null), '');
    assert.equal(overdueText(36), '36 days overdue');
    assert.equal(overdueText(null), '');
  });
});

describe('trees', () => {
  test('parent keys, default expansion and visible rows', () => {
    assert.deepEqual([...parentKeys(TREE)], ['g:1', 'g:2']);
    assert.deepEqual([...keysUpToLevel(TREE, 1)], ['g:1']);
    assert.deepEqual(visibleRows(TREE, new Set(['g:1'])).map((r) => r.key), ['g:1', 'g:2', 'i:8']);
    assert.deepEqual(visibleRows(TREE, new Set(['g:1', 'g:2'])).map((r) => r.key), ['g:1', 'g:2', 'i:7', 'i:8']);
    assert.deepEqual(visibleRows(TREE, new Set(['g:2'])).map((r) => r.key), ['g:1', 'i:8'], 'a collapsed ancestor hides its grandchildren');
  });

  test('movement tree: party rows with item children; drill party → ledger, item → stock item', () => {
    const parties: MovementPartyRow[] = [
      { key: 'p:20', partyLedgerId: 20, partyName: 'Supreme', qty: 20, value: 2_30_000, avgRate: 115, vouchers: 1, items: [{ itemId: 1, itemName: 'Tumbler', unit: 'Nos', qty: 20, value: 2_30_000, avgRate: 115 }] },
      { key: 'p:0', partyLedgerId: null, partyName: 'Without a party', qty: null, value: 0, avgRate: null, vouchers: 1, items: [] },
    ];
    const t = movementTree(parties);
    assert.deepEqual(t.map((r) => [r.key, r.level, r.parentKey, r.unit]), [
      ['p:20', 0, null, 'Nos'],
      ['p:20:i:1', 1, 'p:20', 'Nos'],
      ['p:0', 0, null, null],
    ]);
    const range = { from: '2026-04-01', to: '2026-04-30' };
    assert.deepEqual(movementDrill(t[0], range), { screen: 'reports.ledger', params: { ledgerId: 20, ...range } });
    assert.deepEqual(movementDrill(t[1], range), { screen: 'stock.item', params: { itemId: 1, ...range } });
    assert.equal(movementDrill(t[2], range), null);
  });

  test('negative tree: item then the godowns that are below zero', () => {
    const rows: NegativeStockRow[] = [
      { itemId: 5, name: 'Cable', unit: 'Nos', groupName: null, qty: -5, value: -45_000, negativeSince: '2026-06-05', godowns: [{ godownId: 1, godownName: 'Main', qty: -5, negativeSince: '2026-06-05' }] },
    ];
    assert.deepEqual(negativeTree(rows).map((r) => [r.key, r.kind, r.qty, r.value]), [
      ['n:5', 'item', -5, -45_000],
      ['n:5:g:1', 'godown', -5, null],
    ]);
  });
});

describe('drill-down', () => {
  const ctx = { from: '2026-04-01', to: '2026-04-30' };
  test('summary: group → sub-summary, category → summary by category, item → item vouchers (godown kept)', () => {
    assert.deepEqual(summaryDrill(TREE[0], ctx), { screen: 'stock.summary', params: { ...ctx, groupId: 1 } });
    assert.deepEqual(summaryDrill(TREE[2], { ...ctx, godownId: 3 }), { screen: 'stock.item', params: { ...ctx, godownId: 3, itemId: 7 } });
    assert.deepEqual(summaryDrill(row({ key: 'c:4', kind: 'category', level: 0, id: 4 }), ctx), { screen: 'stock.summary', params: { ...ctx, categoryId: 4 } });
    assert.equal(summaryDrill(row({ key: 'c:none', kind: 'category', level: 0, id: null }), ctx), null);
    // A group opened under a category filter keeps the filter (the drilled total equals the row).
    assert.deepEqual(summaryDrill(TREE[0], { ...ctx, categoryId: 4 }), { screen: 'stock.summary', params: { ...ctx, groupId: 1, categoryId: 4 } });
  });

  test('godown summary: item → its vouchers in that godown; godown → stock summary of the godown', () => {
    const base = { key: 'gd:2', kind: 'godown' as const, godownId: 2, itemId: null, name: 'Shop', level: 0, parentKey: null, hasChildren: true, unit: null, qty: null, rate: null, value: 71_964, isThirdParty: false };
    assert.deepEqual(godownDrill(base, ctx), { screen: 'stock.summary', params: { godownId: 2, ...ctx } });
    assert.deepEqual(godownDrill({ ...base, key: 'gi:2:1', kind: 'item', itemId: 1 }, ctx), { screen: 'stock.item', params: { itemId: 1, godownId: 2, ...ctx } });
  });
});

describe('exports', () => {
  const totals = { openingValue: 2_00_000, inwardValue: 1_00_000, outwardValue: 60_000, closingValue: 2_40_000 };
  test('condensed summary: particulars, unit, closing qty / rate / value; tree levels kept', () => {
    const e = summaryExport(TREE, { detailed: false, valuesShown: true, totals });
    assert.deepEqual(e.columns.map((c) => c.header), ['Particulars', 'Unit', 'Closing qty', 'Rate', 'Closing value']);
    assert.deepEqual(e.rows[2], ['i:7', 'Nos', 12, 100, 1_20_000]);
    assert.deepEqual(e.totals, ['Grand Total', '', null, null, 2_40_000]);
    assert.deepEqual(e.levels, [0, 1, 2, 0]);
  });

  test('detailed summary has opening / inward / outward; without values only quantities', () => {
    const d = summaryExport(TREE, { detailed: true, valuesShown: true, totals });
    assert.equal(d.columns.length, 2 + 3 * 2 + 3);
    assert.deepEqual(d.totals, ['Grand Total', '', null, 2_00_000, null, 1_00_000, null, 60_000, null, null, 2_40_000]);
    assert.equal(d.landscape, true);
    const q = summaryExport(TREE, { detailed: true, valuesShown: false, totals });
    assert.deepEqual(q.columns.map((c) => c.header), ['Particulars', 'Unit', 'Opening qty', 'Inward qty', 'Outward qty', 'Closing qty']);
    assert.equal(q.totals, undefined);
  });

  test('ageing export shows bucket values or quantities', () => {
    const d = {
      asOf: '2026-06-30',
      buckets: [
        { label: '0–75 days', fromDays: 0, toDays: 75 },
        { label: 'Over 75 days', fromDays: 76, toDays: null },
      ],
      rows: [{ itemId: 2, name: 'Bottle', unit: 'Nos', groupId: 2, groupName: 'Kitchen', qty: 16, value: 2_02_330, buckets: [{ qty: 3, value: 37_937 }, { qty: 13, value: 1_64_393 }], oldestDate: '2026-04-05', averageAgeDays: 77 }],
      totals: { value: 2_02_330, buckets: [37_937, 1_64_393] },
    };
    assert.deepEqual(ageingExport(d, 'value').rows[0], ['Bottle', 'Kitchen', 16, 'Nos', 2_02_330, 37_937, 1_64_393, 77]);
    assert.deepEqual(ageingExport(d, 'qty').rows[0].slice(5, 7), [3, 13]);
  });

  test('pending orders export names the fulfilment column by kind', () => {
    const e = pendingOrdersExport([], 'purchase', 0);
    assert.ok(e.columns.some((c) => c.header === 'Received'));
    assert.ok(e.columns.some((c) => c.header === 'Supplier'));
    assert.ok(pendingOrdersExport([], 'sales', 0).columns.some((c) => c.header === 'Delivered'));
  });
});

describe('signedAmountText (no bare minus in reports)', () => {
  test('negatives in parentheses, Indian grouping, zero blank only when asked', () => {
    assert.equal(signedAmountText(1_23_456_78), '1,23,456.78');
    // negative stock of 5 @ ₹90 = −45,000 paise
    assert.equal(signedAmountText(-45_000), '(450.00)');
    assert.equal(signedAmountText(-12_34_567_89), '(12,34,567.89)');
    assert.equal(signedAmountText(0), '0.00');
    assert.equal(signedAmountText(0, true), '');
    assert.equal(signedAmountText(null), '');
    assert.equal(signedAmountText(undefined), '');
  });
});
