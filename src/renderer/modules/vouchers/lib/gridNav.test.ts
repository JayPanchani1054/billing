import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cellId, headerId } from './errorPaths.ts';
import { chargesCollapsible, entrySections, initialFocusId, neighbourSection, nextCell, opensBeforeFocus, rowAfterDelete, verticalCell } from './gridNav.ts';
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

describe('Charges & discounts (2.1, D17): a closed disclosure inside the same Enter chain', () => {
  const items: GridModel = { columns: ['item', 'qty', 'rate', 'amount'], rowKeys: ['i1', 'i2'], isBlank: (k) => k === 'i2' };
  const charges: GridModel = { columns: ['ledger', 'amount'], rowKeys: ['l1'], isBlank: () => true };
  const sections = entrySections('item_invoice', 'sales');

  it('Enter on an empty item row leaves the items for the charges — the 2.0 stop — and opens them first', () => {
    assert.deepEqual(nextCell(items, { rowKey: 'i2', column: 'item' }, 'forward'), { kind: 'exit-forward' });
    const next = neighbourSection(sections, 'items', 'forward');
    assert.equal(next, 'ledgers');
    assert.equal(opensBeforeFocus(next, { collapsible: chargesCollapsible('item_invoice', 'sales'), open: false }), true);
    // Already open (a charge exists, or opened earlier): nothing to open, the cursor just moves.
    assert.equal(opensBeforeFocus(next, { collapsible: true, open: true }), false);
  });

  it('Enter on an empty charge row goes to the narration; Shift+Enter from the narration opens the charges again', () => {
    assert.deepEqual(nextCell(charges, { rowKey: 'l1', column: 'ledger' }, 'forward'), { kind: 'exit-forward' });
    assert.equal(neighbourSection(sections, 'ledgers', 'forward'), 'narration');
    const back = neighbourSection(sections, 'narration', 'back');
    assert.equal(back, 'ledgers');
    assert.equal(opensBeforeFocus(back, { collapsible: true, open: false }), true);
    assert.equal(opensBeforeFocus('narration', { collapsible: true, open: false }), false);
    assert.equal(opensBeforeFocus('accept', { collapsible: true, open: false }), false);
  });

  it('only the item-invoice layout folds its ledger lines (an accounting invoice or a voucher IS its lines)', () => {
    assert.equal(chargesCollapsible('item_invoice', 'sales'), true);
    assert.equal(chargesCollapsible('item_invoice', 'purchase'), true);
    assert.equal(chargesCollapsible('accounting_invoice', 'sales'), false);
    assert.equal(chargesCollapsible('ledger', 'receipt'), false);
    assert.equal(chargesCollapsible('inventory', 'delivery_note'), false);
    assert.equal(opensBeforeFocus('ledgers', { collapsible: chargesCollapsible('accounting_invoice', 'sales'), open: false }), false);
  });
});
