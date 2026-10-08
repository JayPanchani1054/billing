import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQty } from '../../../../shared/format.ts';
import { itemGotoResults, itemGotoTarget } from './goto.ts';

test('opens the stock item report when registered, else the item form', () => {
  assert.deepEqual(itemGotoTarget(7, (id) => id === 'stock.item'), { screen: 'stock.item', params: { itemId: 7 } });
  assert.deepEqual(itemGotoTarget(7, () => false), { screen: 'inventory.item.form', params: { id: 7 } });
});

test('results carry group, stock and search keywords', () => {
  const out = itemGotoResults(
    [
      { id: 1, name: 'Basmati Rice', alias: 'Rice', partNo: 'R-1', barcode: '890100', groupName: 'Grains', unitSymbol: 'Kg', unitDecimals: 3, stockQty: 1234.5 },
      { id: 2, name: 'Installation', groupName: null, isService: true, stockQty: 0 },
    ],
    () => false,
    formatQty,
  );
  assert.equal(out[0].id, 'item:1');
  assert.equal(out[0].description, 'Grains · 1,234.500 Kg in stock');
  assert.deepEqual(out[0].keywords, ['Rice', 'R-1', '890100']);
  assert.equal(out[1].description, 'Stock item · Service');
  assert.equal(out[1].screen, 'inventory.item.form');
});
