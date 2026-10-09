/**
 * GST registers, HSN summary, ITC report and exceptions on the April-2026 dataset (testkit.ts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { loadCompany } from './docs.ts';
import { exceptionsReport, gstRegister, hsnSummary, itcReport } from './reports.ts';
import { aprilDataset, insertDoc, setupParties, type Dataset } from './testkit.ts';

const A = ['2026-04-01', '2026-04-30'] as const;

describe('GST registers and analysis — April 2026', () => {
  let ds: Dataset;
  before(() => {
    ds = aprilDataset();
  });
  after(() => ds.t.close());

  it('sales register: one signed row per outward document, totals and rate totals', () => {
    const r = gstRegister(ds.t.db, loadCompany(ds.t.db), ...A, 'sales', ds.t.today);
    assert.equal(r.rows.length, 17, 'S-1…S-14 + CN-1…CN-3 (cancelled S-15 and optional S-16 excluded)');
    // GSTR-1 net 1,85,595.76 + reverse-charge S-3 1,000.00 = 1,86,595.76; CGST = SGST 141.00 + 25.00
    assert.deepEqual([r.totals.taxable, r.totals.igst, r.totals.cgst, r.totals.sgst, r.totals.nonTaxable], [18659576, 3052724, 16600, 16600, 150000]);
    // Σ invoice values 2,31,413.00 − credit notes 12,508.00 = 2,18,905.00
    assert.equal(r.totals.invoiceValue, 21890500);
    assert.deepEqual(r.rateTotals.map((x) => [x.rate, x.taxable, x.cgst]), [[5, 160000, 4000], [18, 18499576, 12600]]);
    const cn2 = r.rows.find((x) => x.number === 'CN-2');
    assert.deepEqual([cn2?.sign, cn2?.taxable, cn2?.igst, cn2?.invoiceValue, cn2?.stateCode, cn2?.natureLabel], [-1, -1000000, -180000, -1180000, '07', 'B2C Small']);
  });

  it('purchase register: supplier invoice no./date, purchase return negative', () => {
    const r = gstRegister(ds.t.db, loadCompany(ds.t.db), ...A, 'purchase', ds.t.today);
    assert.deepEqual(r.rows.map((x) => x.number), ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6', 'P-7', 'P-8', 'DN-1']);
    assert.deepEqual([r.rows[0].supplierInvoiceNo, r.rows[0].supplierInvoiceDate, r.rows[0].stateCode], ['SS/101', '2026-04-04', '27']);
    // taxable lines: 3,000 + 5,200 + 1,000 + 500 + 2,000 + 10,000 + 300 − 500 = 21,500.00
    assert.deepEqual([r.totals.taxable, r.totals.igst, r.totals.cgst, r.totals.sgst, r.totals.nonTaxable], [2150000, 307000, 29500, 29500, 65000]);
  });

  it('ITC by supplier and by eligibility (eligible total = GSTR-3B 4(C))', () => {
    const r = itcReport(ds.t.db, loadCompany(ds.t.db), ...A, ds.t.today);
    assert.deepEqual(
      r.rows.map((x) => [x.partyName, x.documents, x.taxable, x.eligible.igst, x.eligible.cgst, x.ineligible.igst, x.reverseCharge.igst + x.reverseCharge.cgst, x.imports.igst]),
      [
        ['Global Imports LLC', 1, 1000000, 180000, 0, 0, 0, 180000],
        ['GTA Transport Co', 1, 100000, 0, 2500, 0, 2500, 0],
        ['Karnataka Components', 1, 520000, 90000, 0, 1000, 0, 0],
        ['Lawyer Associates', 1, 50000, 0, 4500, 0, 4500, 0],
        ['Small Composition Supplier', 1, 30000, 0, 0, 0, 0, 0],
        ['Steel Suppliers', 2, 250000, 0, 22500, 0, 0, 0],
        ['US Software Inc', 1, 200000, 36000, 0, 0, 36000, 0],
      ],
    );
    assert.deepEqual(r.totals.eligible, { igst: 306000, cgst: 29500, sgst: 29500, cess: 0 });
    assert.deepEqual(r.totals.ineligible, { igst: 1000, cgst: 0, sgst: 0, cess: 0 });
    assert.deepEqual(
      r.byEligibility.map((x) => [x.eligibility, x.taxable, x.tax.igst, x.tax.cgst]),
      [
        ['inputs', 1280000, 180000, 22500],
        ['capital_goods', 500000, 90000, 0],
        ['input_services', 350000, 36000, 7000],
        ['ineligible', 20000, 1000, 0],
      ],
    );
  });

  it('HSN summary of inward supplies (signed, 4 digits)', () => {
    const r = hsnSummary(ds.t.db, loadCompany(ds.t.db), ...A, 'inward', ds.t.today);
    assert.deepEqual(
      r.rows.map((x) => [x.hsn, x.uqc, x.qty, x.rate, x.taxable, x.igst, x.cgst]),
      [
        ['0401', 'LTR', 80, 0, 40000, 0, 0],
        ['2710', 'LTR', 25, 0, 25000, 0, 0],
        ['7208', 'KGS', 3, 0, 30000, 0, 0],
        ['7208', 'KGS', 25, 18, 250000, 0, 22500],
        ['8471', 'NOS', 15, 18, 1500000, 270000, 0],
        ['9963', 'NA', 0, 5, 20000, 1000, 0],
        ['9965', 'NA', 0, 5, 100000, 0, 2500],
        ['9982', 'NA', 0, 18, 50000, 0, 4500],
        ['9983', 'NA', 0, 18, 200000, 36000, 0],
      ],
    );
    const out = hsnSummary(ds.t.db, loadCompany(ds.t.db), ...A, 'outward', ds.t.today);
    assert.equal(out.totals.taxable, 18659576 + 150000, 'all outward lines incl. reverse charge and nil/exempt/non-GST');
  });

  it('exceptions: GSTR-1 checks + purchase-side checks, errors first', () => {
    const r = exceptionsReport(ds.t.db, loadCompany(ds.t.db), ...A, ds.t.today);
    assert.deepEqual(
      r.issues.map((i) => [i.severity, i.code, i.voucherNumber]),
      [
        ['error', 'rcm_without_liability', 'P-4'],
        ['error', 'supplier_invoice_missing', 'P-4'],
        ['warning', 'export_shipping_bill_missing', 'S-9'],
        ['warning', 'optional_in_series', 'S-16'],
        ['warning', 'note_without_original', 'CN-3'],
      ],
    );
    assert.deepEqual([r.counts.errors, r.counts.warnings, r.counts.byCode.rcm_without_liability], [2, 3, 1]);
  });
});

describe('purchase-side checks', () => {
  it('ITC from a supplier without GSTIN, invalid supplier GSTIN, ITC after the s.16(4) time limit', () => {
    const { t, P } = setupParties({ today: '2027-12-10' });
    const noGstin = t.addLedger({ name: 'Unknown Vendor', group: 'SUNDRY_CREDITORS', registrationType: 'regular' });
    const typo = t.addLedger({ name: 'Typo Vendor', group: 'SUNDRY_CREDITORS', gstin: '27AAAPA0099A1Z0' });
    insertDoc(t, { type: 'purchase', number: 'Q1', date: '2027-12-05', party: noGstin, partyGstin: null, nature: 'inward_b2b', refNo: 'U-1', refDate: '2027-12-01', lines: [{ hsn: '8471', rate: 18, taxable: 10000, cgst: 900, sgst: 900 }] });
    insertDoc(t, { type: 'purchase', number: 'Q2', date: '2027-12-05', party: typo, nature: 'inward_b2b', refNo: 'T-1', refDate: '2027-12-01', lines: [{ hsn: '8471', rate: 18, taxable: 10000, cgst: 900, sgst: 900 }] });
    // Invoice of 1-May-2026 (FY 2026-27): ITC only up to 30-Nov-2027.
    insertDoc(t, { type: 'purchase', number: 'Q3', date: '2027-12-05', party: P.steel, nature: 'inward_b2b', refNo: 'OLD-9', refDate: '2026-05-01', lines: [{ hsn: '7208', rate: 18, taxable: 10000, cgst: 900, sgst: 900 }] });
    const r = exceptionsReport(t.db, loadCompany(t.db), '2027-12-01', '2027-12-31', t.today);
    assert.deepEqual(
      r.issues.map((i) => [i.voucherNumber, i.code, i.severity]),
      [
        ['Q1', 'itc_without_gstin', 'error'],
        ['Q2', 'supplier_gstin_invalid', 'error'],
        ['Q3', 'itc_time_limit', 'warning'],
      ],
    );
    assert.match(r.issues[2].message, /30-Nov-2027/);
    assert.equal(makeGstin('27', testPan(99)).length, 15);
    t.close();
  });
});
