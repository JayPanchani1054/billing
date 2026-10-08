import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffRows, diffSummary, formatValue, humanizeKey, humanizePath, lastKey, parsePath } from './diffFormat.ts';

describe('diff formatting', () => {
  it('parses the core diff path format (dots, indexes, quoted keys)', () => {
    assert.deepEqual(parsePath('lines[2].amount'), [
      { type: 'key', key: 'lines' },
      { type: 'index', index: 2 },
      { type: 'key', key: 'amount' },
    ]);
    assert.deepEqual(parsePath('["GST %"]'), [{ type: 'key', key: 'GST %' }]);
    assert.deepEqual(parsePath('x["a.b"].c'), [
      { type: 'key', key: 'x' },
      { type: 'key', key: 'a.b' },
      { type: 'key', key: 'c' },
    ]);
    assert.deepEqual(parsePath('(value)'), []);
    assert.equal(lastKey('lines[0].amount'), 'amount');
    assert.equal(lastKey('tags[3]'), 'tags');
  });

  it('humanises keys and paths for accountants', () => {
    assert.equal(humanizeKey('openingBalance'), 'Opening balance');
    assert.equal(humanizeKey('opening_balance'), 'Opening balance');
    assert.equal(humanizeKey('gstin'), 'GSTIN');
    assert.equal(humanizeKey('hsnSac'), 'HSN SAC');
    assert.equal(humanizeKey('partyGSTIN'), 'Party GSTIN');
    assert.equal(humanizeKey('mustChangePassword'), 'Must change password');
    assert.equal(humanizePath('lines[0].amount'), 'Lines › 1 › Amount');
    assert.equal(humanizePath('bank.ifsc'), 'Bank › IFSC');
    assert.equal(humanizePath('(value)'), 'Value');
  });

  it('formats paise by key: signed amounts with Dr/Cr, other money with ₹; counts and rates stay numbers', () => {
    // 118000 paise = ₹1,180.00; positive = Dr.
    assert.deepEqual(formatValue(118000, 'amount'), { text: '1,180.00 Dr', style: 'money', raw: '118000 paise' });
    assert.equal(formatValue(-236000, 'openingBalance').text, '2,360.00 Cr');
    assert.equal(formatValue(0, 'openingBalance').text, '0.00');
    assert.equal(formatValue(5000000, 'creditLimit').text, '₹ 50,000.00');
    assert.equal(formatValue(10000000, 'b2clThresholdPaise').text, '₹ 1,00,000.00', 'a …Paise key is always money');
    assert.equal(formatValue(18, 'gstRate').text, '18');
    assert.equal(formatValue(5, 'lockoutThreshold').text, '5');
    assert.equal(formatValue(12.5, 'amount').text, '12.5', 'non-integers are never paise');
    assert.equal(formatValue(7, 'ledgerId').text, '7');
    assert.equal(formatValue(42, null).text, '42');
    // Whole words decide: 'discount' and 'account' contain "count" but are still money.
    // 5000 paise = ₹50.00 (Dr); -123456 paise = 1,234.56 Cr.
    assert.equal(formatValue(5000, 'discountAmount').text, '50.00 Dr');
    assert.equal(formatValue(-123456, 'account_balance').text, '1,234.56 Cr');
    // 250000 paise = ₹2,500.00; 'sortOrder' ends in a non-money word and stays a number.
    assert.equal(formatValue(250000, 'orderValue').text, '₹ 2,500.00');
    assert.equal(formatValue(4, 'sortOrder').text, '4');
    assert.equal(formatValue(3, 'voucherCount').text, '3');
    assert.equal(formatValue(18, 'gstRateValue').text, '18');
  });

  it('formats empties, booleans, long text and objects', () => {
    assert.deepEqual(formatValue(null, 'gstin'), { text: '—', style: 'empty', raw: null });
    assert.equal(formatValue('', 'narration').raw, '(blank)');
    assert.equal(formatValue(true, 'isActive').text, 'Yes');
    assert.equal(formatValue(false, 'isActive').text, 'No');
    assert.equal(formatValue([], 'tags').text, 'None');
    assert.equal(formatValue({}, 'bank').text, 'None');
    const long = 'x'.repeat(400);
    const f = formatValue(long, 'notes');
    assert.equal(f.text.length, 300);
    assert.ok(f.text.endsWith('…'));
    assert.equal(f.raw, long);
    assert.deepEqual(formatValue({ ifsc: 'HDFC0000001' }, 'bank'), { text: '{"ifsc":"HDFC0000001"}', style: 'json', raw: '{"ifsc":"HDFC0000001"}' });
  });

  it('builds rows with sections and a summary', () => {
    const rows = diffRows([
      { path: 'lines[0].amount', kind: 'changed', before: 118000, after: 236000 },
      { path: 'narration', kind: 'added', before: null, after: 'Corrected' },
      { path: 'gstin', kind: 'removed', before: '27AAPFU0939F1ZV', after: null },
    ]);
    assert.deepEqual(rows.map((r) => [r.label, r.section, r.kind, r.before.text, r.after.text]), [
      ['Lines › 1 › Amount', 'Lines', 'changed', '1,180.00 Dr', '2,360.00 Dr'],
      ['Narration', 'Narration', 'added', '—', 'Corrected'],
      ['GSTIN', 'GSTIN', 'removed', '27AAPFU0939F1ZV', '—'],
    ]);
    assert.equal(new Set(rows.map((r) => r.key)).size, 3);
    assert.equal(diffSummary([]).text, 'No field changes');
    assert.equal(diffSummary([{ path: 'a', kind: 'changed', before: 1, after: 2 }, { path: 'b', kind: 'added', before: null, after: 1 }], true).text, '1 changed · 1 added (first part only)');
  });
});
