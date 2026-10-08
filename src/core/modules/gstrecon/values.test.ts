import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isMonthPeriod,
  parseItcAvailability,
  parsePortalAmount,
  parsePortalDate,
  parseRate,
  parseStateCode,
  parseSupplierPeriod,
  periodFromFyMonth,
  periodLabel,
  periodRange,
  resolveReconPeriod,
  shiftPeriod,
} from './values.ts';

describe('portal value parsing', () => {
  it('amounts: rupees (number or text) → paise; empty → 0; junk → null', () => {
    assert.equal(parsePortalAmount(729248.16), 72924816);
    assert.equal(parsePortalAmount(1.005), 101); // half away from zero after float snapping
    assert.equal(parsePortalAmount(0.1 + 0.2), 30);
    assert.equal(parsePortalAmount('1,23,456.50'), 12345650);
    assert.equal(parsePortalAmount('₹ 50'), 5000);
    assert.equal(parsePortalAmount('Rs. 1,000'), 100000);
    assert.equal(parsePortalAmount('-12.5'), -1250);
    assert.equal(parsePortalAmount(''), 0);
    assert.equal(parsePortalAmount(null), 0);
    assert.equal(parsePortalAmount(undefined), 0);
    assert.equal(parsePortalAmount('12a'), null);
    assert.equal(parsePortalAmount(Number.NaN), null);
    assert.equal(parsePortalAmount(true), null);
  });

  it('dates: portal and Excel spellings → ISO; impossible dates → null', () => {
    assert.equal(parsePortalDate('05-04-2026'), '2026-04-05');
    assert.equal(parsePortalDate('5/4/2026'), '2026-04-05');
    assert.equal(parsePortalDate('05.04.2026'), '2026-04-05');
    assert.equal(parsePortalDate('05-04-26'), '2026-04-05');
    assert.equal(parsePortalDate('10-May-26'), '2026-05-10'); // GSTR-2A fldtr1
    assert.equal(parsePortalDate('10 Sept 2026'), '2026-09-10');
    assert.equal(parsePortalDate('2026-04-05'), '2026-04-05');
    assert.equal(parsePortalDate('2026-04-05T10:20:00'), '2026-04-05');
    assert.equal(parsePortalDate(46117), '2026-04-05'); // Excel serial (1900 system)
    assert.equal(parsePortalDate('46117'), '2026-04-05');
    assert.equal(parsePortalDate('31-02-2026'), null);
    assert.equal(parsePortalDate('29-02-2028'), '2028-02-29');
    assert.equal(parsePortalDate('10-Marching-26'), null);
    assert.equal(parsePortalDate(''), null);
    assert.equal(parsePortalDate(12), null);
  });

  it('place of supply: codes, labels, names and alpha codes → state code', () => {
    assert.equal(parseStateCode('27'), '27');
    assert.equal(parseStateCode(7), '07');
    assert.equal(parseStateCode('7'), '07');
    assert.equal(parseStateCode('27-Maharashtra'), '27');
    assert.equal(parseStateCode('29 - Karnataka'), '29');
    assert.equal(parseStateCode('Maharashtra'), '27');
    assert.equal(parseStateCode('Jammu & Kashmir'), '01');
    assert.equal(parseStateCode('Orissa'), '21');
    assert.equal(parseStateCode('MH'), '27');
    assert.equal(parseStateCode('Atlantis'), null);
    assert.equal(parseStateCode('55'), null);
    assert.equal(parseStateCode(''), null);
  });

  it('rates, ITC availability', () => {
    assert.equal(parseRate('18'), 18);
    assert.equal(parseRate('18%'), 18);
    assert.equal(parseRate(0.25), 0.25);
    assert.equal(parseRate('x'), null);
    assert.equal(parseRate(101), null);
    assert.equal(parseItcAvailability('Y'), true);
    assert.equal(parseItcAvailability('Yes'), true);
    assert.equal(parseItcAvailability('T'), true);
    assert.equal(parseItcAvailability('No'), false);
    assert.equal(parseItcAvailability(''), null);
  });

  it('return periods', () => {
    assert.equal(isMonthPeriod('042026'), true);
    assert.equal(isMonthPeriod('132026'), false);
    assert.equal(isMonthPeriod('042016'), false); // before GST
    assert.deepEqual(periodRange('022028'), { from: '2028-02-01', to: '2028-02-29' });
    assert.equal(shiftPeriod('012026', -2), '112025');
    assert.equal(shiftPeriod('112026', 2), '012027');
    assert.equal(periodLabel('042026'), 'April 2026');
    assert.deepEqual(resolveReconPeriod('2026-27-Q1', true), { key: '062026', from: '2026-04-01', to: '2026-06-30', label: 'Q1 2026-27', quarter: true });
    assert.equal(resolveReconPeriod('2026-27-Q1', false), null);
    assert.equal(resolveReconPeriod('2026-28-Q1', true), null);
  });

  it('supplier filing periods and Read-me periods', () => {
    assert.equal(parseSupplierPeriod('042026'), '042026');
    assert.equal(parseSupplierPeriod("Apr'26"), '042026');
    assert.equal(parseSupplierPeriod('Apr-2026'), '042026');
    assert.equal(parseSupplierPeriod('April 2026'), '042026');
    assert.equal(parseSupplierPeriod('04-2026'), '042026');
    assert.equal(parseSupplierPeriod('2026-04'), '042026');
    assert.equal(parseSupplierPeriod('April'), null);
    assert.equal(periodFromFyMonth('April', '2026-27'), '042026');
    assert.equal(periodFromFyMonth('January', '2026-27'), '012027');
    assert.equal(periodFromFyMonth('Foo', '2026-27'), null);
  });
});
