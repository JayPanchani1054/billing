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

describe('Dr/Cr must agree before saving', () => {
  it('an unbalanced journal is flagged on the last line with the difference and the Ctrl+B hint', () => {
    let f = newForm({ voucherTypeId: 7, baseType: 'journal', mode: 'ledger', date: '2026-10-05' });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 100000 } });
    const second = f.ledgers[1].key;
    f = formReducer(f, { type: 'ledger', key: second, patch: { ledgerId: 2, amount: -75050 } });
    const r = clientIssues(f, env);
    // Dr 1,000.00 − Cr 750.50 = 249.50 more debit.
    assert.equal(r.first, cellId('ledgers', second, 'amount'));
    assert.match(r.cells[cellId('ledgers', second, 'amount')], /differ by ₹ 249\.50 \(more debit\).*Ctrl\+B/);
    f = formReducer(f, { type: 'balanceLast' });
    assert.deepEqual(clientIssues(f, env).cells, {});
  });

  it('the single-entry layout balances itself (no difference check)', () => {
    let f = newForm({ voucherTypeId: 3, baseType: 'receipt', mode: 'ledger', date: '2026-10-05', accountLedgerId: 4 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 9, amount: 25000 } });
    assert.deepEqual(clientIssues(f, env).cells, {});
  });
});

describe('bill-wise details that no longer match', () => {
  it('a ledger line whose amount changed after allocating bills', () => {
    let f = newForm({ voucherTypeId: 3, baseType: 'receipt', mode: 'ledger', date: '2026-10-05', accountLedgerId: 4 });
    const k = f.ledgers[0].key;
    f = formReducer(f, { type: 'ledger', key: k, patch: { ledgerId: 9, amount: 50000, bills: [{ refType: 'against', billName: 'S/1', amount: 50000 }] } });
    assert.deepEqual(clientIssues(f, env).cells, {});
    f = formReducer(f, { type: 'ledger', key: k, patch: { amount: 45000 } });
    assert.match(clientIssues(f, env).cells[cellId('ledgers', k, 'amount')], /add up to ₹ 500\.00, not ₹ 450\.00.*Alt\+B/);
  });

  it('the invoice party allocation against the current invoice total', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05', partyLedgerId: 4 });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 1, qty: 1, rate: 100 } });
    f = formReducer(f, { type: 'patch', patch: { partyBills: [{ refType: 'new', billName: '1', amount: 11800 }] } });
    assert.deepEqual(clientIssues(f, { ...env, invoiceTotal: 11800 }).cells, {});
    assert.match(clientIssues(f, { ...env, invoiceTotal: 12980 }).cells[headerId('party')], /₹ 118\.00 but the invoice total is ₹ 129\.80/);
    // Without a known total (not an invoice with a bill-wise party) nothing is checked.
    assert.deepEqual(clientIssues(f, env).cells, {});
  });
});
