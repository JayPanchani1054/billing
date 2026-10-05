/**
 * GSTR-1 table-wise summary, drill-down and uncertain transactions on the April-2026 dataset
 * (testkit.ts › aprilDataset — every figure below is worked out there by hand). Amounts in paise.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Gstr1SectionId, Gstr1Summary } from '../../../shared/types/gst-returns.ts';
import { AppError } from '../../lib/errors.ts';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { loadCompany } from './docs.ts';
import { computeGstr1, gstr1Section, gstr1Summary } from './gstr1.ts';
import { resolvePeriod } from './period.ts';
import { aprilDataset, insertDoc, setupParties, type Dataset } from './testkit.ts';

const section = (s: Gstr1Summary, id: Gstr1SectionId) => {
  const x = s.sections.find((r) => r.id === id);
  assert.ok(x, id);
  return x;
};
const pick = (x: { count: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number; invoiceValue: number }) => [
  x.count,
  x.taxable,
  x.igst,
  x.cgst,
  x.sgst,
  x.cess,
  x.invoiceValue,
];

describe('GSTR-1 summary — April 2026 dataset', () => {
  let ds: Dataset;
  let s: Gstr1Summary;
  before(() => {
    ds = aprilDataset();
    s = gstr1Summary(computeGstr1(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today));
  });
  after(() => ds.t.close());

  it('lists every section in table order', () => {
    assert.deepEqual(
      s.sections.map((x) => `${x.table}:${x.id}`),
      ['4A:b2b', '4B:b2b_rcm', '5:b2cl', '6A:exp_wp', '6A:exp_wop', '6B:sez_wp', '6B:sez_wop', '6C:de', '7:b2cs', '8:nil', '9B:cdnr', '9B:cdnur', '11A(1):at', '11B(1):atadj', '12:hsn_b2b', '12:hsn_b2c', '13:doc'],
    );
    assert.equal(s.period.fp, '042026');
    assert.equal(s.gstin, makeGstin('27'));
  });

  it('4A B2B: S-1 intra + S-2 inter (exempt line excluded) + S-14 to a composition dealer', () => {
    // taxable 1,000.00 + 500.00 + 2,000.00 + 600.00 = 4,100.00; IGST 360.00 + 108.00 = 468.00;
    // CGST = SGST = 90.00 + 12.50 = 102.50; invoice values 1,705 + 2,660 + 708 = 5,073.00
    assert.deepEqual(pick(section(s, 'b2b')), [3, 410000, 46800, 10250, 10250, 0, 507300]);
  });

  it('4B reverse charge, 5 B2CL (just above ₹1 lakh), 6A exports, 6B SEZ, 6C deemed exports', () => {
    assert.deepEqual(pick(section(s, 'b2b_rcm')), [1, 100000, 0, 2500, 2500, 0, 100000]);
    assert.deepEqual(pick(section(s, 'b2cl')), [1, 8475000, 1525500, 0, 0, 0, 10000500]);
    assert.deepEqual(pick(section(s, 'exp_wp')), [1, 500000, 90000, 0, 0, 0, 590000]);
    assert.deepEqual(pick(section(s, 'exp_wop')), [1, 1000000, 0, 0, 0, 0, 1000000]);
    assert.deepEqual(pick(section(s, 'sez_wp')), [1, 100000, 18000, 0, 0, 0, 118000]);
    assert.deepEqual(pick(section(s, 'sez_wop')), [1, 400000, 0, 0, 0, 0, 400000]);
    assert.deepEqual(pick(section(s, 'de')), [1, 200000, 36000, 0, 0, 0, 236000]);
  });

  it('7 B2CS aggregated by POS + rate + supply type; ₹1,00,000.00 exactly stays B2CS; CN-3 netted', () => {
    // 07/18 INTER: S-5 84,745.76 + IGST 15,254.24 (= 1,00,000.00, not above the threshold)
    // 27/5  INTRA: S-6 line 2: 100.00, C/S 2.50
    // 27/18 INTRA: S-6 200.00 + S-7 300.00 − CN-3 100.00 = 400.00; CGST 18 + 27 − 9 = 36.00
    assert.deepEqual(
      s.b2cs.map((r) => [r.supplyType, r.pos, r.rate, r.taxable, r.igst, r.cgst, r.sgst, r.documents]),
      [
        ['INTER', '07', 18, 8474576, 1525424, 0, 0, 1],
        ['INTRA', '27', 5, 10000, 0, 250, 250, 1],
        ['INTRA', '27', 18, 40000, 0, 3600, 3600, 3],
      ],
    );
    assert.deepEqual(pick(section(s, 'b2cs')), [3, 8524576, 1525424, 3850, 3850, 0, 0]);
  });

  it('8 nil/exempt/non-GST split inter/intra × registered/unregistered', () => {
    assert.deepEqual(
      s.nil.map((r) => [r.supplyType, r.exempt, r.nil, r.nonGst]),
      [
        ['INTRB2B', 30000, 0, 0], // S-2 exempt rice to Bharat (29)
        ['INTRAB2B', 0, 0, 0],
        ['INTRB2C', 0, 0, 0],
        ['INTRAB2C', 0, 50000, 70000], // S-13 milk (nil) + petrol (non-GST)
      ],
    );
    assert.equal(section(s, 'nil').taxable, 150000);
    assert.equal(section(s, 'nil').count, 2);
  });

  it('9B CDNR (registered) and CDNUR B2CL (original invoice was B2CL although the note itself is small)', () => {
    assert.deepEqual(pick(section(s, 'cdnr')), [1, -50000, -9000, 0, 0, 0, -59000]);
    assert.deepEqual(pick(section(s, 'cdnur')), [1, -1000000, -180000, 0, 0, 0, -1180000]);
  });

  it('11 advances are not derived and say so', () => {
    assert.deepEqual(pick(section(s, 'at')), [0, 0, 0, 0, 0, 0, 0]);
    assert.match(section(s, 'at').note ?? '', /not derived/);
    assert.ok(s.notes.some((n) => /Amendment tables/.test(n)));
  });

  it('12 HSN summary split B2B / B2C, truncated to 4 digits, services NA with qty 0', () => {
    assert.deepEqual(
      s.hsnB2b.map((r) => [r.hsn, r.uqc, r.qty, r.rate, r.taxable, r.igst, r.cgst, r.sgst]),
      [
        ['1006', 'KGS', 100, 0, 30000, 0, 0, 0],
        // 7208 @18: S-1 10 KGS 1,000 + S-2 20 KGS 2,000 − CN-1 5 KGS 500 = 25 KGS 2,500; IGST 360 − 90 = 270
        ['7208', 'KGS', 25, 18, 250000, 27000, 9000, 9000],
        ['8471', 'NOS', 5, 5, 50000, 0, 1250, 1250],
        // 8471 @18: S-10 4 + S-11 1 + S-12 2 + S-14 1 = 8 NOS; 4,000 + 1,000 + 2,000 + 600 = 7,600; IGST 180 + 360 + 108
        ['8471', 'NOS', 8, 18, 760000, 64800, 0, 0],
        ['9965', 'NA', 0, 5, 100000, 0, 2500, 2500],
      ],
    );
    assert.deepEqual(
      s.hsnB2c.map((r) => [r.hsn, r.uqc, r.qty, r.rate, r.taxable, r.igst, r.cgst, r.sgst]),
      [
        ['0401', 'LTR', 100, 0, 50000, 0, 0, 0],
        ['2710', 'LTR', 70, 0, 70000, 0, 0, 0],
        ['7208', 'KGS', 1, 5, 10000, 0, 250, 250],
        ['7208', 'KGS', 100, 18, 1000000, 0, 0, 0],
        // 8471 @18 B2C: S-4 5 + S-5 5 + S-6 2 + S-7 1 + S-8 10 − CN-2 1 − CN-3 1 = 21 NOS;
        // 84,750 + 84,745.76 + 200 + 300 + 5,000 − 10,000 − 100 = 1,64,895.76; IGST 15,255 + 15,254.24 + 900 − 1,800 = 29,609.24
        ['8471', 'NOS', 21, 18, 16489576, 2960924, 3600, 3600],
      ],
    );
  });

  it('13 documents issued: cancelled S-15 counted, optional S-16 not', () => {
    assert.deepEqual(
      s.docs.map((d) => [d.docNum, d.voucherTypeName, d.from, d.to, d.total, d.cancelled, d.missing, d.net]),
      [
        [1, 'Sales', 'S-1', 'S-15', 15, 1, 0, 14],
        [5, 'Credit Note', 'CN-1', 'CN-3', 3, 0, 0, 3],
      ],
    );
    assert.deepEqual(s.excluded, { optional: 1, cancelled: 1, notGst: 0 });
  });

  it('net tax liability excludes reverse charge (4B) and equals the sum of the tables', () => {
    // taxable: 4,100 + 84,750 + 5,000 + 10,000 + 1,000 + 4,000 + 2,000 + 85,245.76 − 500 − 10,000 = 1,85,595.76
    // IGST: 468 + 15,255 + 900 + 180 + 360 + 15,254.24 − 90 − 1,800 = 30,527.24; CGST = SGST = 102.50 + 38.50 = 141.00
    assert.deepEqual(s.totals, { taxable: 18559576, igst: 3052724, cgst: 14100, sgst: 14100, cess: 0 });
  });

  it('lists uncertain transactions with fix hints', () => {
    assert.deepEqual(
      s.issues.map((i) => [i.severity, i.code, i.voucherNumber, i.section]),
      [
        ['warning', 'export_shipping_bill_missing', 'S-9', 'exp_wop'],
        ['warning', 'note_without_original', 'CN-3', 'b2cs'],
      ],
    );
    for (const i of s.issues) assert.ok(i.fix.length > 10 && i.voucherId !== null);
  });

  it('drill-down rows add up to the section totals', () => {
    const c = computeGstr1(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today);
    for (const id of ['b2b', 'b2cs', 'cdnr', 'cdnur', 'nil', 'exp_wp'] as const) {
      const r = gstr1Section(c, id);
      const sum = section(s, id);
      assert.equal(r.totals.taxable, sum.taxable, id);
      assert.equal(r.totals.igst, sum.igst, id);
      assert.equal(r.totals.cgst, sum.cgst, id);
    }
    const b2b = gstr1Section(c, 'b2b');
    assert.deepEqual(
      b2b.rows.map((r) => [r.number, r.gstin, r.pos, r.invoiceType, r.rates.map((x) => [x.rate, x.taxable])]),
      [
        ['S-1', makeGstin('27', testPan(1)), '27', 'R', [[5, 50000], [18, 100000]]],
        ['S-2', makeGstin('29', testPan(2)), '29', 'R', [[18, 200000]]],
        ['S-14', makeGstin('08', testPan(11)), '08', 'R', [[18, 60000]]],
      ],
    );
    const b2cs = gstr1Section(c, 'b2cs');
    assert.deepEqual(b2cs.rows.map((r) => [r.number, r.sign, r.taxable]), [['S-5', 1, 8474576], ['S-6', 1, 30000], ['S-7', 1, 30000], ['CN-3', -1, -10000]]);
    assert.equal(b2cs.b2cs?.length, 3);
    const doc = gstr1Section(c, 'doc');
    assert.equal(doc.rows.length, 18, '15 sales (incl. cancelled) + 3 credit notes');
    const hsn = gstr1Section(c, 'hsn_b2c');
    assert.equal(hsn.totals.taxable, section(s, 'hsn_b2c').taxable);
  });
});

describe('GSTR-1 periods and edge cases', () => {
  it('a quarter covers three months; fp is the last month', () => {
    const { t, P } = setupParties({ today: '2026-07-20' });
    insertDoc(t, { type: 'sales', number: 'A1', date: '2026-04-10', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 10000, cgst: 900, sgst: 900 }] });
    insertDoc(t, { type: 'sales', number: 'A2', date: '2026-06-30', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 20000, cgst: 1800, sgst: 1800 }] });
    insertDoc(t, { type: 'sales', number: 'A3', date: '2026-07-01', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 40000, cgst: 3600, sgst: 3600 }] });
    const q = resolvePeriod({ period: '2026-27-Q1' });
    assert.deepEqual([q.from, q.to, q.fp, q.label], ['2026-04-01', '2026-06-30', '062026', 'Q1 (Apr–Jun) 2026-27']);
    const s = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), q, t.today));
    assert.deepEqual(pick(section(s, 'b2b')).slice(0, 2), [2, 30000]);
    const r = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ from: '2026-06-15', to: '2026-07-05' }), t.today));
    assert.deepEqual(pick(section(r, 'b2b')).slice(0, 2), [2, 60000]);
    assert.equal(r.period.kind, 'range');
    assert.equal(r.period.fp, null);
    t.close();
  });

  it('post-dated vouchers count only once their date is reached', () => {
    const { t, P } = setupParties({ today: '2026-04-10' });
    insertDoc(t, { type: 'sales', number: 'PD1', date: '2026-04-20', postDated: true, party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 10000, cgst: 900, sgst: 900 }] });
    const run = () => gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '042026' }), t.today));
    assert.equal(section(run(), 'b2b').count, 0);
    t.clock.setToday('2026-04-25');
    assert.equal(section(run(), 'b2b').count, 1);
    t.close();
  });

  it('flags invalid GSTIN, short/missing HSN, bad number, non-slab rate, missing POS and IGST on an intra-state supply', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    const bad = t.addLedger({ name: 'Typo Traders', group: 'SUNDRY_DEBTORS', gstin: '27AAAPA0001A1Z0', registrationType: 'regular' });
    insertDoc(t, {
      type: 'sales',
      number: 'INV/2026-27/000001',
      date: '2026-04-02',
      party: bad,
      nature: 'b2b',
      pos: '27',
      lines: [
        { hsn: '84', rate: 18, taxable: 10000, cgst: 900, sgst: 900 },
        { hsn: null, rate: 13, taxable: 10000, igst: 1300 },
      ],
    });
    insertDoc(t, { type: 'sales', number: 'X1', date: '2026-04-03', party: P.acme, nature: 'b2b', pos: null, partyState: null, lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    const s = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '042026' }), t.today));
    const codes = s.issues.map((i) => `${i.voucherNumber}:${i.code}:${i.severity}`).sort();
    assert.deepEqual(codes, [
      'INV/2026-27/000001:doc_no_invalid:error', // 18 characters
      'INV/2026-27/000001:gstin_invalid:error',
      'INV/2026-27/000001:hsn_missing:error',
      'INV/2026-27/000001:hsn_short:error',
      'INV/2026-27/000001:rate_not_slab:error',
      'INV/2026-27/000001:tax_head_mismatch:error',
      'X1:pos_missing:error',
    ]);
    const gst = s.issues.find((i) => i.code === 'gstin_invalid');
    assert.match(gst?.message ?? '', /check character/);
    assert.match(gst?.fix ?? '', /party ledger/);
    t.close();
  });

  it('a B2C invoice classified against the threshold rule is flagged', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    insertDoc(t, { type: 'sales', number: 'B1', date: '2026-04-02', party: P.delhi, nature: 'b2cs', pos: '07', lines: [{ hsn: '8471', rate: 18, taxable: 9000000, igst: 1620000 }] });
    const s = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '042026' }), t.today));
    assert.deepEqual(s.issues.map((i) => i.code), ['nature_mismatch']);
    assert.match(s.issues[0].message, /says B2CL/);
    t.close();
  });

  it('gaps in a number series are reported as cancelled in table 13', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    for (const n of [1, 2, 5]) {
      insertDoc(t, { type: 'sales', number: `INV-${n}`, date: `2026-04-0${n}`, party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    }
    const s = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '042026' }), t.today));
    assert.deepEqual(s.docs.map((d) => [d.from, d.to, d.total, d.cancelled, d.missing, d.net]), [['INV-1', 'INV-5', 5, 2, 2, 3]]);
    assert.deepEqual(s.issues.map((i) => [i.code, i.voucherId]), [['doc_series_gap', null]]);
    t.close();
  });

  it('refuses an unregistered company and explains composition', () => {
    const { t } = setupParties({ registrationType: 'composition' });
    const s = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '042026' }), t.today));
    assert.match(s.notes[0], /Composition taxpayers do not file GSTR-1/);
    t.close();
    const u = setupParties({ gst: false });
    assert.throws(
      () => computeGstr1(u.t.db, loadCompany(u.t.db), resolvePeriod({ period: '042026' }), u.t.today),
      (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE',
    );
    assert.throws(() => resolvePeriod({ period: '132026' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
    u.t.close();
  });
});
