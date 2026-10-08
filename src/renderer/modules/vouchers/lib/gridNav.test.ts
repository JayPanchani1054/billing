import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cellId, headerId } from './errorPaths.ts';
import { entrySections, initialFocusId, neighbourSection, nextCell, rowAfterDelete, verticalCell } from './gridNav.ts';
import type { GridModel } from './gridNav.ts';

const filled = new Set(['r1', 'r2']);
const model: GridModel = {
  columns: ['item', 'batch', 'qty', 'rate', 'amount'],
  rowKeys: ['r1', 'r2', 'r3'],
  isBlank: (k) => !filled.has(k),
  skip: (k, c) => c === 'batch' && k !== 'r2', // only r2's item keeps batches
};

describe('grid keyboard model', () => {
  it('Enter walks the cells of a row, skipping cells that do not apply', () => {
    assert.deepEqual(nextCell(model, { rowKey: 'r1', column: 'item' }, 'forward'), { kind: 'cell', rowKey: 'r1', column: 'qty' });
    assert.deepEqual(nextCell(model, { rowKey: 'r2', column: 'item' }, 'forward'), { kind: 'cell', rowKey: 'r2', column: 'batch' });
  });

  it('Enter on the last cell goes to the next row first cell', () => {
    assert.deepEqual(nextCell(model, { rowKey: 'r1', column: 'amount' }, 'forward'), { kind: 'cell', rowKey: 'r2', column: 'item' });
  });

  it('Enter on the item cell of an empty row leaves the grid', () => {
    assert.deepEqual(nextCell(model, { rowKey: 'r3', column: 'item' }, 'forward'), { kind: 'exit-forward' });
  });

  it('Shift+Enter goes back, across rows, and out of the first cell of the first row', () => {
    assert.deepEqual(nextCell(model, { rowKey: 'r2', column: 'item' }, 'back'), { kind: 'cell', rowKey: 'r1', column: 'amount' });
    assert.deepEqual(nextCell(model, { rowKey: 'r1', column: 'qty' }, 'back'), { kind: 'cell', rowKey: 'r1', column: 'item' });
    assert.deepEqual(nextCell(model, { rowKey: 'r1', column: 'item' }, 'back'), { kind: 'exit-back' });
  });

  it('a stale row key exits instead of throwing', () => {
    assert.deepEqual(nextCell(model, { rowKey: 'gone', column: 'item' }, 'forward'), { kind: 'exit-forward' });
  });

  it('focus after delete and vertical moves', () => {
    assert.equal(rowAfterDelete(['a', 'b', 'c'], 'b'), 'c');
    assert.equal(rowAfterDelete(['a', 'b', 'c'], 'c'), 'b');
    assert.equal(rowAfterDelete(['a'], 'a'), null);
    assert.deepEqual(verticalCell(model, { rowKey: 'r2', column: 'batch' }, 'up'), { kind: 'cell', rowKey: 'r1', column: 'item' });
    assert.deepEqual(verticalCell(model, { rowKey: 'r1', column: 'qty' }, 'down'), { kind: 'cell', rowKey: 'r2', column: 'qty' });
    assert.equal(verticalCell(model, { rowKey: 'r3', column: 'qty' }, 'down'), null);
  });
});

describe('entry sections', () => {
  it('orders the body by mode', () => {
    assert.deepEqual(entrySections('item_invoice', 'sales'), ['items', 'ledgers', 'narration']);
    assert.deepEqual(entrySections('accounting_invoice', 'sales'), ['ledgers', 'narration']);
    assert.deepEqual(entrySections('ledger', 'payment'), ['ledgers', 'narration']);
    assert.deepEqual(entrySections('inventory', 'delivery_note'), ['items', 'narration']);
    assert.deepEqual(entrySections('inventory', 'stock_journal'), ['items:src', 'items:dst', 'narration']);
  });

  it('moves between neighbours, header before and accept after', () => {
    const s = entrySections('item_invoice', 'sales');
    assert.equal(neighbourSection(s, 'items', 'forward'), 'ledgers');
    assert.equal(neighbourSection(s, 'items', 'back'), 'header');
    assert.equal(neighbourSection(s, 'narration', 'forward'), 'accept');
    assert.equal(neighbourSection(s, 'narration', 'back'), 'ledgers');
  });
});

describe('where the cursor starts', () => {
  const base = { manualNumber: false, referenceFirst: false, partyShown: false, singleAccount: false, firstSection: 'ledgers' as const, firstRowKey: 'l1' };
  it('manual number, then the supplier invoice no., then the party, then the Account, else the first line', () => {
    assert.equal(initialFocusId({ ...base, manualNumber: true, partyShown: true }), headerId('number'));
    assert.equal(initialFocusId({ ...base, referenceFirst: true, partyShown: true }), headerId('referenceNo'));
    assert.equal(initialFocusId({ ...base, partyShown: true }), headerId('party'));
    assert.equal(initialFocusId({ ...base, singleAccount: true }), headerId('account'));
    assert.equal(initialFocusId(base), cellId('ledgers', 'l1', 'ledger'));
    assert.equal(initialFocusId({ ...base, firstSection: 'items:src', firstRowKey: 'i2' }), cellId('items', 'i2', 'item'));
    assert.equal(initialFocusId({ ...base, firstRowKey: null }), headerId('date'));
  });
});
