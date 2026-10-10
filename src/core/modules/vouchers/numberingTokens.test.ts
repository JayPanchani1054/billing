/**
 * Numbering tokens and dated prefix / suffix rows (dataplus, migration 221): expansion with the
 * voucher date, restart periods across the financial-year boundary, the GST invoice-number rules
 * (≤ 16 characters, letters / digits / '-' / '/', unique in the FY) on every variant, and the
 * voucher-type route that stores the rows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FieldIssue } from '../../../shared/api.ts';
import type { VoucherTypeDetail } from '../../../shared/types/accounts.ts';
import { accountsRoutes } from '../accounts/routes.ts';
import { checkNumbering, saveVoucherType } from '../accounts/voucherTypes.ts';
import { AppError } from '../../lib/errors.ts';
import { formatVoucherNumber, loadVoucherType, parseVoucherSeq } from './numbering.ts';
import { nextVoucherNumber } from './service.ts';
import { salesInput, save, setupKit, type Kit } from './testkit.ts';

function salesNumbering(k: Kit, numbering: Record<string, unknown>): VoucherTypeDetail {
  return saveVoucherType(k.t.ctx, { id: k.vt.sales, numbering } as never);
}

function issuesOf(fn: () => unknown): FieldIssue[] {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError && e.code === 'VALIDATION', String(e));
    return e.details as FieldIssue[];
  }
  assert.fail('expected a validation error');
}

describe('numbering tokens', () => {
  it('INV/{FY}/0001 restarts every financial year and carries the year of the voucher date', () => {
    const k = setupKit();
    salesNumbering(k, { prefix: 'INV/{FY}/', width: 4 });
    const a = save(k, salesInput(k, { date: '2026-04-15' }));
    const b = save(k, salesInput(k, { date: '2027-03-31' }));
    const c = save(k, salesInput(k, { date: '2027-04-01' }));
    assert.deepEqual([a.number, b.number, c.number], ['INV/26-27/0001', 'INV/26-27/0002', 'INV/27-28/0001']);
    // The preview follows the date asked for.
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, '2027-04-10'), 'INV/27-28/0002');
    const vt = loadVoucherType(k.t.db, k.vt.sales);
    assert.equal(parseVoucherSeq(vt, 'INV/27-28/0042', '2027-05-01'), 42);
    assert.equal(parseVoucherSeq(vt, 'INV/26-27/0042', '2027-05-01'), null); // other year's format
    k.t.close();
  });

  it('{FYYYYY}, {YY}, {MM}, {MMM} expand from the voucher date', () => {
    const k = setupKit();
    salesNumbering(k, { prefix: '{MMM}{YY}-', suffix: '/{FYYYYY}', width: 0 });
    const vt = loadVoucherType(k.t.db, k.vt.sales);
    // Jan 2027 is in FY 2026-27; {YY} is the calendar year.
    assert.equal(formatVoucherNumber(vt, 5, '2027-01-09', 4), 'Jan27-5/2026-27');
    k.t.close();
  });

  it('a monthly restart is accepted for GST invoices only when the month is in the number', () => {
    const k = setupKit();
    const refused = issuesOf(() => salesNumbering(k, { prefix: 'S/', restart: 'monthly' }));
    assert.ok(refused.some((i) => i.path === 'numbering.restart'), JSON.stringify(refused));
    salesNumbering(k, { prefix: 'S/{FY}/{MM}/', restart: 'monthly', width: 3 });
    const a = save(k, salesInput(k, { date: '2026-04-30' }));
    const b = save(k, salesInput(k, { date: '2026-05-01' }));
    // 'S/26-27/04/001' = 2+5+1+2+1+3 = 14 characters ≤ 16
    assert.deepEqual([a.number, b.number], ['S/26-27/04/001', 'S/26-27/05/001']);
    k.t.close();
  });

  it('GST numbers: longest expansion must fit 16 characters; unknown tokens are refused', () => {
    const k = setupKit();
    // 'INV-NO/' 7 + {FYYYYY} 7 + '/' 1 = 15, plus 2 padded digits = 17 > 16
    const long = issuesOf(() => salesNumbering(k, { prefix: 'INV-NO/{FYYYYY}/', width: 2 }));
    assert.ok(long.some((i) => i.path === 'numbering.prefix' && /17 characters/.test(i.message)), JSON.stringify(long));
    const unknown = issuesOf(() => salesNumbering(k, { prefix: 'INV/{YEAR}/' }));
    assert.ok(unknown.some((i) => /not a numbering token/.test(i.message)), JSON.stringify(unknown));
    // Non-GST voucher type: length is only a warning, but a bad token is still an error.
    const journal = checkNumbering('journal', { method: 'automatic', prefix: 'JOURNAL-VOUCHER/{FYYYYY}/', suffix: null, start: 1, width: 4, restart: 'yearly' }, true);
    assert.equal(journal.errors.length, 0);
    assert.ok(journal.warnings.length > 0);
    k.t.close();
  });
});

describe('dated prefix / suffix rows', () => {
  it('a row replaces the prefix for vouchers dated on or after its date', async () => {
    const k = setupKit();
    const res = await k.t.call(accountsRoutes, 'accounts.voucherType.save', {
      id: k.vt.sales,
      numbering: { prefix: 'A/', width: 3, prefixRows: [{ applicableFrom: '2026-10-01', text: 'B/{MM}/' }], suffixRows: [{ applicableFrom: '2026-12-01', text: '/X' }] },
    });
    assert.ok(res.ok, JSON.stringify(res));
    const detail = res.data as VoucherTypeDetail;
    assert.deepEqual(detail.numbering.prefixRows, [{ applicableFrom: '2026-10-01', text: 'B/{MM}/' }]);
    const a = save(k, salesInput(k, { date: '2026-09-30' }));
    const b = save(k, salesInput(k, { date: '2026-10-01' }));
    const c = save(k, salesInput(k, { date: '2026-12-05' }));
    // One yearly series: the counter keeps running across the prefix change.
    assert.deepEqual([a.number, b.number, c.number], ['A/001', 'B/10/002', 'B/12/003/X']);
    // Saving the type without rows keeps them; an empty list removes them.
    salesNumbering(k, { width: 3 });
    assert.equal(loadVoucherType(k.t.db, k.vt.sales).numberingPrefixRows?.length, 1);
    salesNumbering(k, { prefixRows: [], suffixRows: [] });
    assert.deepEqual(loadVoucherType(k.t.db, k.vt.sales).numberingPrefixRows, []);
    // The edit log keeps the rows in the before image.
    const last = k.t.db.get<{ before_json: string }>(`SELECT before_json FROM audit_log WHERE entity_type = 'voucher_type' ORDER BY id DESC LIMIT 1`);
    assert.match(last?.before_json ?? '', /B\/\{MM\}\//);
    k.t.close();
  });

  it('rows are checked: date after the books beginning, no duplicate dates, GST characters', () => {
    const k = setupKit();
    const dup = issuesOf(() =>
      salesNumbering(k, {
        prefixRows: [
          { applicableFrom: '2026-10-01', text: 'B/' },
          { applicableFrom: '2026-10-01', text: 'C/' },
        ],
      }),
    );
    assert.ok(dup.some((i) => /same date/.test(i.message)), JSON.stringify(dup));
    const early = issuesOf(() => salesNumbering(k, { prefixRows: [{ applicableFrom: '2026-04-01', text: 'B/' }] }));
    assert.ok(early.some((i) => /after the books beginning/.test(i.message)), JSON.stringify(early));
    const bad = issuesOf(() => salesNumbering(k, { prefixRows: [{ applicableFrom: '2026-10-01', text: 'B 1/' }] }));
    assert.ok(bad.some((i) => i.path === 'numbering.prefixRows[0].text' && /a space/.test(i.message)), JSON.stringify(bad));
    k.t.close();
  });

  it('a typed number in the dated format advances nothing it should not: the dated parse uses the date', () => {
    const k = setupKit();
    salesNumbering(k, { prefix: 'A/', prefixRows: [{ applicableFrom: '2026-10-01', text: 'B/' }] });
    const vt = loadVoucherType(k.t.db, k.vt.sales);
    assert.equal(parseVoucherSeq(vt, 'B/7', '2026-11-01'), 7);
    assert.equal(parseVoucherSeq(vt, 'B/7', '2026-09-01'), null);
    assert.equal(parseVoucherSeq(vt, 'A/7', '2026-09-01'), 7);
    k.t.close();
  });
});

describe('numbering tokens and typed numbers (2.0)', () => {
  it('an override in the token format of its date continues the series of that year only', () => {
    const k = setupKit({ today: '2027-04-10', booksFrom: '2026-04-01' });
    salesNumbering(k, { prefix: 'INV/{FY}/', width: 4 });
    save(k, salesInput(k, { date: '2026-05-01' }));
    // Typed in last year's format, dated last year: its sequence is parsed with that year's prefix.
    const typed = save(k, salesInput(k, { date: '2026-06-01', numberOverride: { number: 'INV/26-27/0050', continueSeries: true } }));
    assert.equal(typed.number, 'INV/26-27/0050');
    assert.equal(save(k, salesInput(k, { date: '2026-06-02' })).number, 'INV/26-27/0051');
    // The new year's series is not affected.
    assert.equal(save(k, salesInput(k, { date: '2027-04-10' })).number, 'INV/27-28/0001');
    // Typed in another year's format: no sequence, so continueSeries cannot move the counter.
    const other = save(k, salesInput(k, { date: '2027-04-10', numberOverride: { number: 'INV/26-27/0900', continueSeries: true } }));
    assert.equal(other.number, 'INV/26-27/0900');
    assert.equal(save(k, salesInput(k, { date: '2027-04-10' })).number, 'INV/27-28/0002');
    k.t.close();
  });
});
