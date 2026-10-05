/**
 * GSTR-9 annual summary: April-2026 dataset (testkit.ts) + three May vouchers. The annual figures
 * must equal the sum of the monthly GSTR-3B / GSTR-1 computations. Amounts in paise.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Gstr9Row, Gstr9Summary, TaxHead } from '../../../shared/types/gst-returns.ts';
import { loadCompany } from './docs.ts';
import { computeGstr3b } from './gstr3b.ts';
import { computeGstr9, GSTR9_CAPTION } from './gstr9.ts';
import { parsePeriodKey } from './period.ts';
import { aprilDataset, insertDoc, type Dataset } from './testkit.ts';

const r = (rows: Gstr9Row[], key: string) => {
  const x = rows.find((y) => y.key === key);
  assert.ok(x, key);
  return [x.taxable, x.igst, x.cgst, x.sgst];
};

describe('GSTR-9', () => {
  let ds: Dataset;
  let g: Gstr9Summary;
  before(() => {
    ds = aprilDataset();
    const { t, P } = ds;
    insertDoc(t, { type: 'sales', number: 'M-1', date: '2026-05-05', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '7208', uqc: 'KGS', qty: 20, rate: 18, taxable: 200000, cgst: 18000, sgst: 18000 }] });
    insertDoc(t, { type: 'purchase', number: 'M-2', date: '2026-05-06', party: P.steel, nature: 'inward_b2b', refNo: 'SS/150', refDate: '2026-05-06', lines: [{ hsn: '7208', uqc: 'KGS', qty: 10, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }] });
    insertDoc(t, { type: 'sales', number: 'M-3', date: '2026-05-07', party: P.cash, nature: 'b2cs', pos: '27', lines: [{ hsn: '8471', uqc: 'NOS', qty: 1, rate: 18, taxable: 50000, cgst: 4500, sgst: 4500 }] });
    t.clock.setToday('2026-06-15');
    g = computeGstr9(t.db, loadCompany(t.db), '2026-27', t.today);
  });
  after(() => ds.t.close());

  it('is labelled as prepared from books and covers April–March', () => {
    assert.equal(g.caption, GSTR9_CAPTION);
    assert.equal(g.caption, 'Prepared from books — verify before filing');
    assert.deepEqual([g.from, g.to, g.months.length, g.months[0].period, g.months[11].period], ['2026-04-01', '2027-03-31', 12, '042026', '032027']);
    assert.ok(g.notes.some((n) => /not ended yet/.test(n)));
  });

  it('table 9 (tax payable and paid) equals the sum of the monthly GSTR-3B computations', () => {
    const company = loadCompany(ds.t.db);
    const months = ['042026', '052026'].map((k) => computeGstr3b(ds.t.db, company, parsePeriodKey(k) as NonNullable<ReturnType<typeof parsePeriodKey>>, ds.t.today));
    for (const h of ['igst', 'cgst', 'sgst', 'cess'] as TaxHead[]) {
      const row = g.table9.find((x) => x.head === h);
      const payable = months.reduce((s, m) => s + (m.payment.rows.find((x) => x.head === h)?.liability ?? 0) + (m.payment.rows.find((x) => x.head === h)?.rcmLiability ?? 0), 0);
      const cash = months.reduce((s, m) => s + (m.payment.rows.find((x) => x.head === h)?.cash ?? 0) + (m.payment.rows.find((x) => x.head === h)?.rcmLiability ?? 0), 0);
      assert.equal(row?.payable, payable, h);
      assert.equal(row?.paidCash, cash, h);
    }
    // May: CGST/SGST 180 + 45 = 225 each, set off by May's ITC 90 each → cash 135 each.
    assert.deepEqual(g.months[1].cash, { igst: 0, cgst: 13500, sgst: 13500, cess: 0 });
    assert.deepEqual(g.months[1].itc, { igst: 0, cgst: 9000, sgst: 9000, cess: 0 });
    // April cash (2,765.924 → see gstr3b.test.ts) + May; months without data are zero.
    assert.equal(g.table9.find((x) => x.head === 'igst')?.paidCash, 2751924);
    assert.equal(g.table9.find((x) => x.head === 'cgst')?.paidCash, 7000 + 13500);
    assert.deepEqual(g.months[5].outwardTax, { igst: 0, cgst: 0, sgst: 0, cess: 0 });
  });

  it('tables 4 and 5 roll up the outward supplies of the year', () => {
    // 4A B2C: B2CL 84,750 + B2CS 85,245.76 − CDNUR(B2CL) 10,000 + May B2CS 500 = 1,60,495.76
    assert.deepEqual(r(g.table4, '4A'), [16049576, 2870924, 8350, 8350]);
    // 4B B2B: April 4,100 + May 2,000
    assert.deepEqual(r(g.table4, '4B'), [610000, 46800, 28250, 28250]);
    assert.deepEqual(r(g.table4, '4C'), [500000, 90000, 0, 0]);
    assert.deepEqual(r(g.table4, '4D'), [100000, 18000, 0, 0]);
    assert.deepEqual(r(g.table4, '4E'), [200000, 36000, 0, 0]);
    assert.deepEqual(r(g.table4, '4G'), [350000, 36000, 7000, 7000]);
    assert.deepEqual(r(g.table4, '4I'), [50000, 9000, 0, 0]);
    // 4N = 4H − 4I: taxable 1,78,095.76 − 500 = 1,77,595.76;
    // IGST 28,709.24 + 468 + 900 + 180 + 360 + 360 (4G) − 90 = 30,887.24; CGST = SGST 83.50 + 282.50 + 70 = 436.00
    assert.deepEqual(r(g.table4, '4N'), [17759576, 3088724, 43600, 43600]);
    assert.deepEqual(r(g.table5, '5A'), [1000000, 0, 0, 0]);
    assert.deepEqual(r(g.table5, '5B'), [400000, 0, 0, 0]);
    assert.deepEqual(r(g.table5, '5C'), [100000, 0, 2500, 2500]);
    assert.deepEqual([r(g.table5, '5D')[0], r(g.table5, '5E')[0], r(g.table5, '5F')[0]], [30000, 50000, 70000]);
    // Turnover 5N = 4N + 5M − 4G = 1,77,595.76 + 16,500 − 3,500 = 1,90,595.76
    // (= GSTR-1 net 1,85,595.76 + May 2,500 + reverse charge 1,000 + nil/exempt/non-GST 1,500)
    assert.equal(r(g.table5, '5N')[0], 19059576);
  });

  it('table 6 splits the ITC of the year and reconciles with GSTR-3B 4(A)', () => {
    assert.deepEqual(r(g.table6, '6A'), [0, 307000, 38500, 38500]);
    assert.deepEqual(r(g.table6, '6B1').slice(1), [0, 31500, 31500]); // 270 − 45 + 90
    assert.deepEqual(r(g.table6, '6B2').slice(1), [90000, 0, 0]);
    assert.deepEqual(r(g.table6, '6B3').slice(1), [1000, 0, 0]); // blocked staff lunch (services)
    assert.deepEqual(r(g.table6, '6C').slice(1), [0, 4500, 4500]); // lawyer (unregistered)
    assert.deepEqual(r(g.table6, '6D').slice(1), [0, 2500, 2500]); // GTA (registered)
    assert.deepEqual(r(g.table6, '6E').slice(1), [180000, 0, 0]);
    assert.deepEqual(r(g.table6, '6F').slice(1), [36000, 0, 0]);
    assert.deepEqual(r(g.table6, '6J').slice(1), [0, 0, 0]);
    assert.deepEqual(r(g.table6, '7E').slice(1), [1000, 0, 0]);
    assert.equal(g.hsnOutward.length > 0 && g.hsnInward.length > 0, true);
  });
});
