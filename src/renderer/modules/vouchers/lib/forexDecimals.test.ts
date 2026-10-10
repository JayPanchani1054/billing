/**
 * Final wave: voucher entry in a foreign currency with 0, 3 or 4 decimal places. The form's amount
 * fields hold the foreign amount in 10^-d units (VoucherForm.forexDecimals); loading, rescaling, line
 * values and the input sent to the server keep every decimal of the currency.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { formatAmountText, parseAmountText } from '../../../ui/lib/numeric.ts';
import { decodeForex, encodeForex, forexBills } from '../../forex/lib/entry.ts';
import { buildVoucherInput, formFromInput } from './buildInput.ts';
import { amountDecimals, formReducer, itemLineValue, newForm, rescaleAmounts } from './formState.ts';

describe('forex decimals in voucher entry', () => {
  it('encodes / decodes at the currency decimals', () => {
    assert.equal(encodeForex(12.345, 3), 12345);
    assert.equal(decodeForex(12345, 3), 12.345);
    assert.equal(encodeForex(1250, 0), 1250);
    assert.equal(decodeForex(1250, 0), 1250);
    assert.equal(encodeForex(1.2345, 4), 12345);
    assert.deepEqual(forexBills([{ refType: 'new', billName: 'K-1', amount: 12345 }], 3), [{ refType: 'new', billName: 'K-1', amount: 12345, forexAmount: 12.345 }]);
  });

  it('amount fields parse and show 0 / 3 / 4 decimals', () => {
    const r = parseAmountText('12.345', 3);
    assert.ok(r.ok && r.paise === 12345);
    const y = parseAmountText('1,250', 0);
    assert.ok(y.ok && y.paise === 1250);
    const e = parseAmountText('2*1.2345', 4);
    assert.ok(e.ok && e.paise === 24690);
    assert.equal(formatAmountText(12345, { decimals: 3 }), '12.345');
    assert.equal(formatAmountText(125000, { decimals: 0 }), '1,25,000');
    assert.equal(formatAmountText(12345, {}), '123.45', 'default stays paise');
  });

  it('item line value in the currency unit; a 3-decimal invoice round-trips through the form exactly', () => {
    const row = { ...newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' }).items[0], itemId: 7, qty: 2, rate: 1.2345 };
    assert.equal(itemLineValue(row, 3), 2469); // 2 × 1.2345 = 2.469
    assert.equal(itemLineValue(row, 4), 24690);
    assert.equal(itemLineValue(row), 247); // paise as before

    const input: VoucherInput = {
      voucherTypeId: 1,
      date: '2026-10-05',
      mode: 'accounting_invoice',
      partyLedgerId: 9,
      forex: { currencyId: 3, rate: 270.5 },
      ledgers: [{ ledgerId: 20, amount: 0, forexAmount: 12.345 }],
      partyBillAllocations: [{ refType: 'new', billName: 'K-1', amount: 0, forexAmount: 12.345 }],
    };
    // Loaded at 4 decimals (exact), then rescaled to the currency's 3.
    let f = formFromInput(input, { baseType: 'sales', alter: false });
    assert.equal(amountDecimals(f), 4);
    assert.equal(f.ledgers[0].amount, 123450);
    f = formReducer(f, { type: 'forexUnit', decimals: 3 });
    assert.equal(amountDecimals(f), 3);
    assert.equal(f.ledgers[0].amount, 12345);
    assert.equal(f.partyBills?.[0].amount, 12345);
    const out = buildVoucherInput(f).input;
    assert.equal(out.ledgers?.[0].forexAmount, 12.345, 'the third decimal reaches the server');
    assert.equal(out.partyBillAllocations?.[0].forexAmount, 12.345);
    assert.equal((out as unknown as Record<string, unknown>).forexDecimals, undefined, 'a form-only field is never sent');
    // Leaving the currency (party in rupees): the amounts go back to paise.
    const back = rescaleAmounts(f, 2);
    assert.equal(back.ledgers[0].amount, 1235);
    assert.equal(back.forexDecimals, undefined);
  });

  it('a typed amount on a 0-decimal currency is sent in whole units', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05', partyLedgerId: 9 });
    f = formReducer(f, { type: 'patch', patch: { forex: { currencyId: 4, rate: 0.56 } } });
    f = formReducer(f, { type: 'forexUnit', decimals: 0 });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 7, qty: 3, rate: 1000, amount: 3001 } });
    const items = buildVoucherInput(f).input.items ?? [];
    assert.equal(items[0].forexAmount, 3001);
    assert.equal(items[0].forexRate, 1000);
  });
});
