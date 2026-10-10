import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkNumberingScheme, effectiveText, expandedMaxLength, expandNumberingText, formatSchemeNumber, hasMonthToken, parseSchemeSeq, tokenProblems } from './numbering.ts';

describe('numbering tokens (shared)', () => {
  it('expands with the voucher date and the FY start month', () => {
    assert.equal(expandNumberingText('INV/{FY}/', '2027-03-31'), 'INV/26-27/');
    assert.equal(expandNumberingText('INV/{fy}/', '2027-04-01'), 'INV/27-28/');
    assert.equal(expandNumberingText('{FYYYYY}', '2026-04-01'), '2026-27');
    assert.equal(expandNumberingText('{YY}{MM}{MMM}', '2026-12-31'), '2612Dec');
    // A calendar-year company (FY from January).
    assert.equal(expandNumberingText('{FY}|{FYYYYY}', '2026-06-01', 1), '26|2026');
    assert.equal(expandNumberingText(null, '2026-06-01'), '');
  });
  it('flags unknown tokens and stray braces; measures the longest expansion', () => {
    assert.deepEqual(tokenProblems('A/{FY}/'), []);
    assert.equal(tokenProblems('A/{YEAR}/').length, 1);
    assert.equal(tokenProblems('A/{FY/').length, 1);
    assert.equal(expandedMaxLength('INV/{FYYYYY}/{MMM}'), 4 + 7 + 1 + 3);
    assert.equal(hasMonthToken('X{mm}'), true);
  });
  it('dated rows: latest row on or before the date wins; null text = none', () => {
    const rows = [
      { applicableFrom: '2026-10-01', text: 'B/' },
      { applicableFrom: '2027-01-01', text: null },
    ];
    assert.equal(effectiveText('A/', rows, '2026-09-30'), 'A/');
    assert.equal(effectiveText('A/', rows, '2026-10-01'), 'B/');
    assert.equal(effectiveText('A/', rows, '2027-02-01'), null);
    const n = { prefix: 'A/', suffix: null, width: 3, prefixRows: rows };
    assert.equal(formatSchemeNumber(n, 7, '2026-11-01'), 'B/007');
    assert.equal(parseSchemeSeq(n, 'B/007', '2026-11-01'), 7);
    assert.equal(parseSchemeSeq(n, '007', '2027-02-01'), 7);
  });
  it('GST checks use every variant', () => {
    const base = { method: 'automatic' as const, prefix: 'A/', suffix: null, start: 1, width: 4, restart: 'yearly' as const };
    assert.equal(checkNumberingScheme('sales', base, true).errors.length, 0);
    const bad = checkNumberingScheme('sales', { ...base, prefixRows: [{ applicableFrom: '2026-10-01', text: 'A B/' }] }, true);
    assert.equal(bad.errors[0]?.path, 'numbering.prefixRows[0].text');
    const monthly = checkNumberingScheme('sales', { ...base, restart: 'monthly', prefix: 'A/{MM}/', prefixRows: [{ applicableFrom: '2026-10-01', text: 'B/' }] }, true);
    assert.ok(monthly.errors.some((e) => e.path === 'numbering.restart'), 'a dated prefix without the month repeats numbers');
  });
});

describe('typed numbers and scheme summary (2.0)', () => {
  it('gstDocNumberProblems: empty, longer than 16, characters other than letters, digits, / and -', async () => {
    const { gstDocNumberProblems } = await import('./numbering.ts');
    assert.deepEqual(gstDocNumberProblems('INV/26-27/0141'), []);
    assert.deepEqual(gstDocNumberProblems('  '), ['Enter the invoice number.']);
    assert.deepEqual(gstDocNumberProblems('INV/2026-27/00001'), ['GST invoice numbers can have at most 16 characters; this one has 17.']);
    assert.deepEqual(gstDocNumberProblems('A B#1#'), ["GST invoice numbers may contain only letters, digits, '/' and '-' (not a space, '#')."]);
  });
  it('voucherNumberProblems: other vouchers 1–60 characters without control characters', async () => {
    const { voucherNumberProblems } = await import('./numbering.ts');
    assert.deepEqual(voucherNumberProblems('Cash book p.12 (old)', false), []);
    assert.deepEqual(voucherNumberProblems('', false), ['Enter the voucher number.']);
    assert.equal(voucherNumberProblems('x'.repeat(61), false).length, 1);
    assert.match(voucherNumberProblems('a\tb', false)[0], /control characters/);
    assert.deepEqual(voucherNumberProblems('A B', true), ["GST invoice numbers may contain only letters, digits, '/' and '-' (not a space)."]);
  });
  it('describeScheme: example, next FY, longest number and when it restarts', async () => {
    const { describeScheme } = await import('./numbering.ts');
    const n = { method: 'automatic' as const, prefix: 'INV/{FY}/', suffix: null, start: 1, width: 4, restart: 'yearly' as const };
    assert.deepEqual(describeScheme(n, '2026-10-10'), {
      example: 'INV/26-27/0001',
      nextFy: { date: '2027-04-01', number: 'INV/27-28/0001' },
      longest: 4 + 5 + 1 + 4,
      resetsOn: 'financial year',
    });
    assert.deepEqual(describeScheme(n, '2026-10-10', 4, 42).example, 'INV/26-27/0042');
    // Never restarts: the next FY continues the sequence.
    assert.deepEqual(describeScheme({ ...n, restart: 'never' }, '2026-10-10', 4, 42).nextFy, { date: '2027-04-01', number: 'INV/27-28/0042' });
    assert.equal(describeScheme({ ...n, restart: 'monthly', prefix: 'S/{MMM}/' }, '2026-10-10').resetsOn, 'month');
    // A calendar-year company: the next FY starts on 1 January.
    assert.deepEqual(describeScheme({ ...n, prefix: '{FY}/' }, '2026-10-10', 1).nextFy, { date: '2027-01-01', number: '27/0001' });
  });
});
