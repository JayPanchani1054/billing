import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { balanceLast, blankLedger, formReducer, isBlankItem, isBlankLedger, itemLineValue, ledgerDifference, newForm, splitForSingle } from './formState.ts';
import type { LedgerRow, VoucherForm } from './formState.ts';

const sales = (): VoucherForm => newForm({ voucherTypeId: 5, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
const journal = (): VoucherForm => newForm({ voucherTypeId: 7, baseType: 'journal', mode: 'ledger', date: '2026-10-05' });

describe('form reducer — rows', () => {
  it('a new invoice has one blank item row and one blank additional-ledger row', () => {
    const f = sales();
    assert.equal(f.items.length, 1);
    assert.ok(isBlankItem(f.items[0]));
    assert.equal(f.ledgers.length, 1);
    assert.ok(isBlankLedger(f.ledgers[0]));
    assert.equal(f.touched, false);
  });

  it('filling the last row appends a new blank row; keys are stable', () => {
    let f = sales();
    const k = f.items[0].key;
    f = formReducer(f, { type: 'item', key: k, patch: { itemId: 3, qty: 2, rate: 10 } });
    assert.equal(f.items.length, 2);
    assert.equal(f.items[0].key, k);
    assert.ok(isBlankItem(f.items[1]));
    assert.notEqual(f.items[1].key, k);
    assert.equal(f.touched, true);
  });

  it('insert before a row and delete keep one trailing blank row', () => {
    let f = sales();
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 3 } });
    const first = f.items[0].key;
    f = formReducer(f, { type: 'itemInsert', beforeKey: first });
    assert.equal(f.items.length, 3);
    assert.ok(isBlankItem(f.items[0]));
    assert.equal(f.items[1].key, first);
    f = formReducer(f, { type: 'itemDelete', key: first });
    assert.ok(f.items.every(isBlankItem));
    assert.ok(isBlankItem(f.items[f.items.length - 1]));
  });

  it('stock journal keeps a blank row on each side', () => {
    const f = newForm({ voucherTypeId: 9, baseType: 'stock_journal', mode: 'inventory', date: '2026-10-05' });
    assert.equal(f.items.filter((r) => r.isConsumption).length, 1);
    assert.equal(f.items.filter((r) => !r.isConsumption).length, 1);
    assert.equal(f.ledgers.length, 0);
  });

  it('itemsAppend (tracking refs) adds rows before the trailing blank', () => {
    let f = sales();
    f = formReducer(f, { type: 'itemsAppend', rows: [{ itemId: 1, qty: 5, rate: 10, trackingRef: 'DN/1' }, { itemId: 2, qty: 1, rate: 99, trackingRef: 'DN/1' }] });
    assert.equal(f.items.length, 3);
    assert.equal(f.items[0].trackingRef, 'DN/1');
    assert.ok(isBlankItem(f.items[2]));
    assert.equal(new Set(f.items.map((r) => r.key)).size, 3);
  });

  it('line value: qty × rate less discount, billed qty wins, typed amount wins', () => {
    const base = sales().items[0];
    // 3 × 118.50 = 355.50 − 10% = 319.95
    assert.equal(itemLineValue({ ...base, qty: 3, rate: 118.5, discountPct: 10 }), 31995);
    assert.equal(itemLineValue({ ...base, qty: 3, billedQty: 2, rate: 100 }), 20000);
    assert.equal(itemLineValue({ ...base, qty: 3, rate: 100, amount: 25000 }), 25000);
    assert.equal(itemLineValue(base), 0);
  });

  it('next voucher keeps type, mode, date and (single entry) the Account', () => {
    let f = newForm({ voucherTypeId: 2, baseType: 'payment', mode: 'ledger', date: '2026-10-07', accountLedgerId: 4 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 8, amount: 1000 } });
    f = formReducer(f, { type: 'patch', patch: { narration: 'Rent' } });
    const n = formReducer(f, { type: 'next' });
    assert.equal(n.date, '2026-10-07');
    assert.equal(n.layout, 'single');
    assert.equal(n.accountLedgerId, 4);
    assert.equal(n.narration, '');
    assert.equal(n.ledgers.length, 1);
    assert.equal(n.touched, false);
  });
});

describe('form reducer — double entry (keyboard-first behaviour)', () => {
  it('picking a ledger on an empty line pre-fills the balancing amount and side', () => {
    let f = journal();
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 120000 } });
    assert.equal(f.ledgers[1].side, 'cr');
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 2 } });
    assert.equal(f.ledgers[1].amount, -120000);
    assert.equal(f.ledgers[1].side, 'cr');
    assert.equal(ledgerDifference(f), 0);
  });

  it('balance it: last filled line gets −Σ others', () => {
    let f = journal();
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 100000 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 2, amount: -40000 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[2].key, patch: { ledgerId: 3, amount: -10000 } });
    const b = balanceLast(f);
    // 1,000.00 Dr − 400.00 Cr → the last line must be 600.00 Cr
    assert.equal(b.ledgers[2].amount, -60000);
    assert.equal(ledgerDifference(b), 0);
    assert.equal(balanceLast(b), b);
  });

  it('single ↔ double layout keeps the amounts', () => {
    let f = newForm({ voucherTypeId: 2, baseType: 'receipt', mode: 'ledger', date: '2026-10-05', accountLedgerId: 4 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 8, amount: 50000 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 9, amount: 25000 } });
    const d = formReducer(f, { type: 'setLayout', layout: 'double' });
    // Receipt: account (bank) Dr 750.00; particulars Cr.
    assert.deepEqual(
      d.ledgers.filter((r) => !isBlankLedger(r)).map((r) => [r.ledgerId, r.amount]),
      [
        [4, 75000],
        [8, -50000],
        [9, -25000],
      ],
    );
    const s = formReducer(d, { type: 'setLayout', layout: 'single' });
    assert.equal(s.layout, 'single');
    assert.equal(s.accountLedgerId, 4);
    assert.deepEqual(
      s.ledgers.filter((r) => !isBlankLedger(r)).map((r) => [r.ledgerId, r.amount]),
      [
        [8, 50000],
        [9, 25000],
      ],
    );
  });

  it('double → single is refused when two lines are on the account side', () => {
    let f = newForm({ voucherTypeId: 2, baseType: 'payment', mode: 'ledger', date: '2026-10-05', layout: 'double' });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 100 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 2, amount: -50 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[2].key, patch: { ledgerId: 3, amount: -50 } });
    const s = formReducer(f, { type: 'setLayout', layout: 'single' });
    assert.equal(s.layout, 'double');
  });
});

describe('form reducer — review fixes', () => {
  it('the next voucher after a save keeps the date and starts with the default party (e.g. Cash for Cash Sales)', () => {
    let f = newForm({ voucherTypeId: 5, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05', partyLedgerId: 1 });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 3, qty: 1, rate: 10 } });
    const next = formReducer(f, { type: 'next', date: '2026-10-06', partyLedgerId: 1 });
    assert.equal(next.partyLedgerId, 1);
    assert.equal(next.date, '2026-10-06');
    assert.equal(next.items.filter((r) => !isBlankItem(r)).length, 0);
    assert.equal(next.touched, false);
    assert.equal(formReducer(f, { type: 'next' }).partyLedgerId, null);
  });

  it('a bank line with a narration or cost centres is not squeezed into the single-entry Account', () => {
    const rows = (account: Partial<LedgerRow>): LedgerRow[] => [
      { ...blankLedger('l1'), ledgerId: 8, amount: 5000 },
      { ...blankLedger('l2'), ledgerId: 4, amount: -5000, ...account },
    ];
    assert.ok(splitForSingle(rows({}), 'cr'));
    assert.equal(splitForSingle(rows({ narration: 'NEFT 8812' }), 'cr'), null);
    assert.equal(splitForSingle(rows({ costs: [{ costCentreId: 1, amount: 5000 }] }), 'cr'), null);
    assert.equal(splitForSingle(rows({ bills: [{ refType: 'on_account', amount: 5000 }] }), 'cr'), null);
  });

  it('new rows carry the alteration-only fields empty', () => {
    const f = sales();
    assert.equal(f.items[0].altQty, null);
    assert.equal(f.items[0].autoRate, null);
    assert.equal(f.ledgers[0].gstExtra, null);
  });
});
