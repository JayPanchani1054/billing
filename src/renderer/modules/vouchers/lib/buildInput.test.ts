import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { ACCOUNT_ROW, buildVoucherInput, formFromInput } from './buildInput.ts';
import { formReducer, isBlankLedger, newForm } from './formState.ts';

describe('buildVoucherInput', () => {
  it('item invoice: blank rows dropped, keys map input index → row', () => {
    let f = newForm({ voucherTypeId: 5, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05', partyLedgerId: 31 });
    const a = f.items[0].key;
    f = formReducer(f, { type: 'item', key: a, patch: { itemId: 1, qty: 10, rate: 50, discountPct: 0 } });
    const b = f.items[1].key;
    f = formReducer(f, { type: 'item', key: b, patch: { itemId: 2, qty: 3, rate: 118.5, discountPct: 10, gstRateOverride: 12, batchName: ' B1 ' } });
    f = formReducer(f, { type: 'itemInsert', beforeKey: b }); // a blank row in the middle
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 20, amount: -5000 } });
    f = formReducer(f, { type: 'patch', patch: { referenceNo: '  ', narration: 'Thanks', placeOfSupply: '27' } });
    const { input, itemKeys, ledgerKeys } = buildVoucherInput(f);
    assert.equal(input.mode, 'item_invoice');
    assert.equal(input.partyLedgerId, 31);
    assert.equal(input.referenceNo, undefined);
    assert.equal(input.narration, 'Thanks');
    assert.equal(input.placeOfSupply, '27');
    assert.deepEqual(input.items, [
      { itemId: 1, qty: 10, rate: 50 },
      { itemId: 2, qty: 3, rate: 118.5, discountPct: 10, gstRateOverride: 12, batchName: 'B1' },
    ]);
    assert.deepEqual(itemKeys, [a, b]);
    assert.deepEqual(input.ledgers, [{ ledgerId: 20, amount: -5000 }]);
    assert.equal(ledgerKeys.length, 1);
    assert.equal(input.isOptional, false);
    assert.equal(input.id, undefined);
  });

  it('single-entry payment: Account first (Cr Σ), particulars Dr; account path maps to ACCOUNT_ROW', () => {
    let f = newForm({ voucherTypeId: 2, baseType: 'payment', mode: 'ledger', date: '2026-10-05', accountLedgerId: 4 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 8, amount: 50000, narration: 'Oct rent' } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 9, amount: 2500, bills: [{ refType: 'against', billName: 'B-7', amount: 2500 }] } });
    f = formReducer(f, { type: 'patch', patch: { accountInstrument: { type: 'cheque', number: '000123', bankName: '' } } });
    const { input, ledgerKeys } = buildVoucherInput(f);
    assert.deepEqual(input.ledgers, [
      { ledgerId: 4, amount: -52500, instrument: { type: 'cheque', number: '000123' } },
      { ledgerId: 8, amount: 50000, narration: 'Oct rent' },
      { ledgerId: 9, amount: 2500, billAllocations: [{ refType: 'against', billName: 'B-7', amount: 2500 }] },
    ]);
    assert.equal(ledgerKeys[0], ACCOUNT_ROW);
    assert.equal((input.ledgers ?? []).reduce((s, l) => s + l.amount, 0), 0);
    assert.equal(input.partyLedgerId, undefined);
  });

  it('double-entry journal sends signed amounts as typed', () => {
    let f = newForm({ voucherTypeId: 7, baseType: 'journal', mode: 'ledger', date: '2026-10-05' });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 1, amount: 1000 } });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 2 } }); // auto −1000
    const { input } = buildVoucherInput(f);
    assert.deepEqual(input.ledgers, [
      { ledgerId: 1, amount: 1000 },
      { ledgerId: 2, amount: -1000 },
    ]);
  });

  it('stock journal: source side first, isConsumption on every line', () => {
    let f = newForm({ voucherTypeId: 9, baseType: 'stock_journal', mode: 'inventory', date: '2026-10-05' });
    const dst = f.items.find((r) => !r.isConsumption)?.key as string;
    f = formReducer(f, { type: 'item', key: dst, patch: { itemId: 2, qty: 4, rate: 130 } });
    const src = f.items.find((r) => r.isConsumption)?.key as string;
    f = formReducer(f, { type: 'item', key: src, patch: { itemId: 1, qty: 10, rate: 50 } });
    const { input, itemKeys } = buildVoucherInput(f);
    assert.deepEqual(input.items, [
      { itemId: 1, qty: 10, rate: 50, isConsumption: true },
      { itemId: 2, qty: 4, rate: 130, isConsumption: false },
    ]);
    assert.deepEqual(itemKeys, [src, dst]);
    assert.equal(input.ledgers, undefined);
  });

  it('accounting invoice line carries the GST override', () => {
    let f = newForm({ voucherTypeId: 5, baseType: 'sales', mode: 'accounting_invoice', date: '2026-10-05', partyLedgerId: 31 });
    f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 50, amount: 100000, gstRate: 18, hsnSac: '998314' } });
    const { input } = buildVoucherInput(f);
    assert.deepEqual(input.ledgers, [{ ledgerId: 50, amount: 100000, gst: { rate: 18, hsnSac: '998314' } }]);
    assert.equal(input.items, undefined);
  });
});

describe('formFromInput', () => {
  const saved: VoucherInput = {
    id: 42,
    voucherTypeId: 2,
    date: '2026-10-01',
    number: '17',
    mode: 'ledger',
    narration: 'Rent',
    isOptional: false,
    expectedUpdatedAt: '2026-10-01T10:00:00.000Z',
    ledgers: [
      { ledgerId: 4, amount: -52500, instrument: { type: 'neft', number: 'UTR1' } },
      { ledgerId: 8, amount: 50000 },
      { ledgerId: 9, amount: 2500 },
    ],
  };

  it('a payment with one Cr cash/bank line opens in the single-entry layout', () => {
    const f = formFromInput(saved, { baseType: 'payment', alter: true });
    assert.equal(f.id, 42);
    assert.equal(f.expectedUpdatedAt, '2026-10-01T10:00:00.000Z');
    assert.equal(f.layout, 'single');
    assert.equal(f.accountLedgerId, 4);
    assert.deepEqual(f.accountInstrument, { type: 'neft', number: 'UTR1' });
    assert.deepEqual(
      f.ledgers.filter((r) => !isBlankLedger(r)).map((r) => [r.ledgerId, r.amount]),
      [
        [8, 50000],
        [9, 2500],
      ],
    );
    // Round trip.
    const again = buildVoucherInput(f).input;
    assert.deepEqual(again.ledgers, saved.ledgers);
    assert.equal(again.number, '17');
    assert.equal(again.id, 42);
  });

  it('duplicate: no id / number / updatedAt, the given date', () => {
    const f = formFromInput(saved, { baseType: 'payment', alter: false, date: '2026-10-08' });
    assert.equal(f.id, null);
    assert.equal(f.number, '');
    assert.equal(f.expectedUpdatedAt, null);
    assert.equal(f.date, '2026-10-08');
    assert.equal(f.touched, false);
  });

  it('prefer double: stays in Dr/Cr layout', () => {
    const f = formFromInput(saved, { baseType: 'payment', alter: true, preferLayout: 'double' });
    assert.equal(f.layout, 'double');
    assert.equal(f.ledgers.filter((r) => !isBlankLedger(r)).length, 3);
  });
});

describe('2.0 Change number (Ctrl+R): numberOverride', () => {
  const sale = () => {
    let f = newForm({ voucherTypeId: 5, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05', partyLedgerId: 31 });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 1, qty: 1, rate: 100 } });
    return f;
  };

  it('a new voucher sends no override and no number until the dialog sets one', () => {
    const { input } = buildVoucherInput(sale());
    assert.equal(input.numberOverride, undefined);
    assert.equal(input.number, undefined);
  });

  it('the dialog result is sent as numberOverride (trimmed; reason / continueSeries only when given), never as `number`', () => {
    const f = formReducer(sale(), { type: 'patch', patch: { numberOverride: { number: ' A-100 ', reason: ' Paper bill book ', continueSeries: true } } });
    const { input } = buildVoucherInput(f);
    assert.deepEqual(input.numberOverride, { number: 'A-100', reason: 'Paper bill book', continueSeries: true });
    assert.equal(input.number, undefined, 'the override is explicit; the typed-number path is untouched');
    const bare = buildVoucherInput(formReducer(sale(), { type: 'patch', patch: { numberOverride: { number: 'A-101', reason: '  ' } } })).input;
    assert.deepEqual(bare.numberOverride, { number: 'A-101' });
  });

  it('an alteration keeps its saved number and adds the override; the rest of the input is unchanged', () => {
    const saved: VoucherInput = { id: 42, expectedUpdatedAt: '2026-10-05T10:00:00.000Z', voucherTypeId: 5, date: '2026-10-05', mode: 'item_invoice', number: 'INV/26-27/0042', partyLedgerId: 31, items: [{ itemId: 1, qty: 1, rate: 100 }], ledgers: [] };
    const f = formFromInput(saved, { baseType: 'sales', alter: true });
    assert.equal(f.numberOverride, null);
    const before = buildVoucherInput(f).input;
    const after = buildVoucherInput(formReducer(f, { type: 'patch', patch: { numberOverride: { number: 'INV/26-27/0141' } } })).input;
    assert.equal(after.number, 'INV/26-27/0042');
    const { numberOverride, ...rest } = after;
    assert.deepEqual(numberOverride, { number: 'INV/26-27/0141' });
    assert.deepEqual(rest, before);
  });

  it('the next voucher after a save starts without the override', () => {
    const f = formReducer(sale(), { type: 'patch', patch: { numberOverride: { number: 'A-100' } } });
    const next = formReducer(f, { type: 'next', date: '2026-10-05' });
    assert.equal(next.numberOverride, null);
    assert.equal(buildVoucherInput(next).input.numberOverride, undefined);
  });
});
