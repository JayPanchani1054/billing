import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cellId, headerId } from './errorPaths.ts';
import { formReducer, newForm } from './formState.ts';
import { clientIssues } from './validate.ts';

const env = { numberingMethod: 'automatic' as const, referenceRequired: false };

describe('client checks before saving', () => {
  it('item invoice: party, at least one item, quantities', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
    const blank = f.items[0].key;
    let r = clientIssues(f, env);
    assert.equal(r.first, headerId('party'));
    assert.equal(r.cells[cellId('items', blank, 'item')], 'Enter at least one item.');
    f = formReducer(f, { type: 'patch', patch: { partyLedgerId: 4 } });
    f = formReducer(f, { type: 'item', key: blank, patch: { itemId: 1, rate: 50 } });
    r = clientIssues(f, env);
    assert.deepEqual(r.cells, { [cellId('items', blank, 'qty')]: 'Enter the quantity.' });
    f = formReducer(f, { type: 'item', key: blank, patch: { qty: 2 } });
    assert.deepEqual(clientIssues(f, env).cells, {});
  });

  it('manual numbering and a GST purchase need their numbers', () => {
    let f = newForm({ voucherTypeId: 2, baseType: 'purchase', mode: 'accounting_invoice', date: '2026-10-05', partyLedgerId: 9 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 30, amount: 100000 } });
    const r = clientIssues(f, { numberingMethod: 'manual', referenceRequired: true });
    assert.equal(r.first, headerId('number'));
    assert.ok(headerId('referenceNo') in r.cells);
    // An alteration keeps its saved number when the field is left blank.
    assert.equal(headerId('number') in clientIssues({ ...f, id: 5 }, { numberingMethod: 'manual', referenceRequired: false }).cells, false);
  });

  it('single-entry payment needs the cash/bank account and amounts', () => {
    let f = newForm({ voucherTypeId: 3, baseType: 'payment', mode: 'ledger', date: '2026-10-05' });
    assert.equal(f.layout, 'single');
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 7 } });
    const r = clientIssues(f, env);
    assert.equal(r.first, headerId('account'));
    assert.equal(r.cells[cellId('ledgers', f.ledgers[0].key, 'amount')], 'Enter the amount.');
  });

  it('physical stock accepts a counted quantity of zero', () => {
    let f = newForm({ voucherTypeId: 4, baseType: 'physical_stock', mode: 'inventory', date: '2026-10-05' });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 1, qty: 0 } });
    assert.deepEqual(clientIssues(f, env).cells, {});
  });
});
