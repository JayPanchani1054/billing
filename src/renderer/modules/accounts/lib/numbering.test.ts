import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherNumbering } from '../../../../shared/types/accounts.ts';
import { badCharacters, checkNumbering, defaultLedgerSide, formatNumber, newTypeNumbering, numberLength, numberingPreview, restartText, seriesClashes, seriesClashWarning } from './numbering.ts';

const n = (over: Partial<VoucherNumbering> = {}): VoucherNumbering => ({ method: 'automatic', prefix: null, suffix: null, start: 1, width: 0, restart: 'yearly', ...over });

describe('numbering preview', () => {
  it('formats prefix + zero-padded number + suffix (same as vouchers formatVoucherNumber)', () => {
    assert.equal(formatNumber(n({ prefix: 'INV/', suffix: '/26-27', width: 4 }), 7), 'INV/0007/26-27');
    assert.equal(formatNumber(n(), 12), '12');
  });

  it('live preview shows the first two numbers; none/manual → null', () => {
    assert.deepEqual(numberingPreview(n({ prefix: 'S-', start: 100 })), { first: 'S-100', second: 'S-101' });
    assert.equal(numberingPreview(n({ method: 'manual' })), null);
    assert.equal(numberingPreview(n({ method: 'none' })), null);
  });

  it('length meter: prefix 4 + max(width 4, start digits 1) + suffix 6 = 14', () => {
    assert.equal(numberLength(n({ prefix: 'INV/', suffix: '/26-27', width: 4 })), 14);
  });

  it('restart text', () => {
    assert.match(restartText('monthly'), /every month/);
    assert.match(restartText('yearly', '2027-28'), /2027-28/);
  });
});

describe('checkNumbering — GST invoice-number rules (mirror of core)', () => {
  it('bad characters are errors for GST documents of a GST company', () => {
    const r = checkNumbering('sales', n({ prefix: 'INV #' }), true);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].path, 'numbering.prefix');
    assert.match(r.errors[0].message, /a space, '#'/);
    assert.deepEqual(badCharacters('A_B.C'), ['_', '.']);
  });

  it('…and only warnings for other types or a non-GST company', () => {
    assert.equal(checkNumbering('payment', n({ prefix: 'PAY #' }), true).errors.length, 0);
    assert.equal(checkNumbering('payment', n({ prefix: 'PAY #' }), true).warnings.length, 1);
    assert.equal(checkNumbering('sales', n({ prefix: 'INV #' }), false).errors.length, 0);
  });

  it('17 characters is refused: prefix 10 + width 5 + suffix 2', () => {
    const r = checkNumbering('sales', n({ prefix: 'ABCDEFGHIJ', width: 5, suffix: '-X' }), true);
    assert.match(r.errors[0].message, /17 characters long/);
  });

  it('headroom under 6 digits warns with the last safe number', () => {
    // 16 − prefix 8 − suffix 3 = 5 digits of room → numbers exceed 16 characters after 99,999.
    const r = checkNumbering('sales', n({ prefix: 'INV/2627', suffix: '/MH' }), true);
    assert.equal(r.errors.length, 0);
    assert.match(r.warnings[0], /after no\. 99,999/);
  });

  it('monthly restart and no numbering are errors; manual warns', () => {
    assert.equal(checkNumbering('credit_note', n({ restart: 'monthly' }), true).errors[0].path, 'numbering.restart');
    assert.equal(checkNumbering('debit_note', n({ method: 'none' }), true).errors[0].path, 'numbering.method');
    const manual = checkNumbering('sales', n({ method: 'manual', restart: 'monthly' }), true);
    assert.equal(manual.errors.length, 0);
    assert.match(manual.warnings[0], /unique within the financial year/);
    // Purchase numbers are the supplier's: no GST rule.
    assert.deepEqual(checkNumbering('purchase', n({ restart: 'monthly' }), true), { errors: [], warnings: [] });
  });

  it('default ledger side per base type', () => {
    assert.equal(defaultLedgerSide('sales'), 'sales');
    assert.equal(defaultLedgerSide('debit_note'), 'purchase');
    assert.equal(defaultLedgerSide('payment'), null);
  });
});

describe('a new voucher type gets its own number series', () => {
  it('takes the parent\'s method, padding and restart but not its prefix, suffix or start (same as the core)', () => {
    const parent = n({ prefix: 'INV/', suffix: '/26', start: 500, width: 4, restart: 'never', method: 'automatic_override' });
    assert.deepEqual(newTypeNumbering(parent), { method: 'automatic_override', prefix: null, suffix: null, start: 1, width: 4, restart: 'never' });
    assert.deepEqual(newTypeNumbering(null), n());
  });

  const types = [
    { id: 1, name: 'Sales', baseType: 'sales' as const, isActive: true, numbering: n() },
    { id: 2, name: 'Export Sales', baseType: 'sales' as const, isActive: true, numbering: n({ prefix: 'EXP/' }) },
    { id: 3, name: 'Old Series', baseType: 'sales' as const, isActive: false, numbering: n({ prefix: 'CS/' }) },
    { id: 4, name: 'Credit Note', baseType: 'credit_note' as const, isActive: true, numbering: n() },
    { id: 5, name: 'Payment', baseType: 'payment' as const, isActive: true, numbering: n() },
  ];

  it('two automatic sales series without a prefix clash (both issue 1, 2, …)', () => {
    assert.deepEqual(seriesClashes(types, null, 'sales', n()), ['Sales']);
    const w = seriesClashWarning(['Sales'], n());
    assert.match(w ?? '', /“Sales” already numbers documents without a prefix, so both series would issue 1, 2/);
  });

  it('prefix compared without case; padding must match; own row, inactive types and other kinds ignored', () => {
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ prefix: 'exp/' })), ['Export Sales']);
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ prefix: 'EXP/', width: 4 })), []);
    assert.deepEqual(seriesClashes(types, 2, 'sales', n({ prefix: 'EXP/' })), []);
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ prefix: 'CS/' })), []);
    // Credit notes are a separate document kind; payments are not GST documents at all.
    assert.deepEqual(seriesClashes(types, null, 'credit_note', n({ prefix: 'EXP/' })), []);
    assert.deepEqual(seriesClashes(types, null, 'payment', n()), []);
    // Manual numbering issues nothing automatically.
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ method: 'manual' })), []);
    assert.equal(seriesClashWarning([], n()), null);
  });
});

describe('tokens and dated rows in the form preview (dataplus)', () => {
  it('previews numbers for the working date and measures the longest expansion', () => {
    const scheme = n({ prefix: 'INV/{FY}/', width: 4, prefixRows: [{ applicableFrom: '2026-10-01', text: '{MMM}/' }] });
    assert.deepEqual(numberingPreview(scheme, '2026-09-01'), { first: 'INV/26-27/0001', second: 'INV/26-27/0002' });
    assert.deepEqual(numberingPreview(scheme, '2026-10-05'), { first: 'Oct/0001', second: 'Oct/0002' });
    assert.equal(numberLength(scheme), 4 + 5 + 1 + 4);
    assert.equal(checkNumbering('sales', n({ prefix: 'X/{BAD}/' }), true).errors.length, 1);
  });
});
