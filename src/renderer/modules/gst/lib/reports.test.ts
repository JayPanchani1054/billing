import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstItcResult, GstRegisterResult, GstRegisterRow, Gstr9Summary } from '../../../../shared/types/gst-returns.ts';
import { bulkFileMessage, exceptionsExport, gstr9Export, hsnExport, itcExport, registerExport, sumTax } from './reports.ts';

const z = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

function regRow(over: Partial<GstRegisterRow>): GstRegisterRow {
  return {
    voucherId: 1,
    date: '2026-04-02',
    number: 'P-1',
    voucherTypeName: 'Purchase',
    baseType: 'purchase',
    partyName: 'Steel Suppliers',
    gstin: '27AAAPA0012A1Z5',
    stateCode: '27',
    stateName: 'Maharashtra',
    nature: 'inward_regular' as GstRegisterRow['nature'],
    natureLabel: 'Regular',
    reverseCharge: false,
    supplierInvoiceNo: 'SS/101',
    supplierInvoiceDate: '2026-04-01',
    invoiceValue: 354_000,
    sign: 1,
    rates: [],
    nonTaxable: 0,
    taxable: 300_000,
    igst: 0,
    cgst: 27_000,
    sgst: 27_000,
    cess: 0,
    ...over,
  };
}

describe('GST export tables', () => {
  it('purchase register carries supplier invoice columns and signed totals', () => {
    // P-1 3,000.00 @18 (C/S 270.00 each) and return DN-1 −500.00 (C/S −45.00 each).
    const r: GstRegisterResult = {
      from: '2026-04-01',
      to: '2026-04-30',
      kind: 'purchase',
      rows: [regRow({}), regRow({ voucherId: 2, number: 'DN-1', sign: -1, taxable: -50_000, cgst: -4_500, sgst: -4_500, invoiceValue: -59_000, reverseCharge: true })],
      totals: { taxable: 250_000, igst: 0, cgst: 22_500, sgst: 22_500, cess: 0, invoiceValue: 295_000, nonTaxable: 0 },
      rateTotals: [],
    };
    const e = registerExport(r);
    assert.equal(e.columns.length, 16); // 9 text columns + taxable, 4 heads, exempt, invoice value
    for (const row of e.rows) assert.equal(row.length, e.columns.length);
    assert.equal(e.totals?.length, e.columns.length);
    assert.equal(e.rows[1][8], 'Regular (RCM)');
    assert.deepEqual(e.rows[1].slice(9), [-50_000, 0, -4_500, -4_500, 0, 0, -59_000]);
    assert.deepEqual(e.totals?.slice(9), [250_000, 0, 22_500, 22_500, 0, 0, 295_000]);
    const sales = registerExport({ ...r, kind: 'sales' });
    assert.equal(sales.columns.length, 14); // no supplier invoice no. / date
    for (const row of sales.rows) assert.equal(row.length, 14);
  });

  it('HSN, ITC and exceptions tables are rectangular', () => {
    const h = hsnExport(
      [{ hsn: '', description: 'Steel', uqc: 'KGS', qty: 10, rate: 18, taxable: 100_000, igst: 0, cgst: 9_000, sgst: 9_000, cess: 0, total: 118_000, supplyType: 'goods' }],
      { taxable: 100_000, igst: 0, cgst: 9_000, sgst: 9_000, cess: 0, total: 118_000 },
    );
    assert.equal(h.rows[0][0], '(missing)');
    assert.equal(h.rows[0].length, h.columns.length);
    assert.equal(h.totals?.length, h.columns.length);

    const itc: GstItcResult = {
      from: '2026-04-01',
      to: '2026-04-30',
      rows: [
        { partyLedgerId: 3, partyName: 'KC', gstin: null, documents: 1, taxable: 520_000, eligible: { igst: 90_000, cgst: 0, sgst: 0, cess: 0 }, ineligible: { igst: 1_000, cgst: 0, sgst: 0, cess: 0 }, reverseCharge: z(), imports: z() },
      ],
      totals: { taxable: 520_000, eligible: { igst: 90_000, cgst: 0, sgst: 0, cess: 0 }, ineligible: { igst: 1_000, cgst: 0, sgst: 0, cess: 0 }, reverseCharge: z(), imports: z() },
      byEligibility: [],
    };
    const i = itcExport(itc);
    assert.deepEqual(i.rows[0], ['KC', '', 1, 520_000, 90_000, 0, 0, 0, 1_000, 0, 0]);
    assert.equal(i.totals?.length, i.columns.length);
    assert.equal(sumTax({ igst: 1, cgst: 2, sgst: 3, cess: 4 }), 10);

    const x = exceptionsExport({
      from: '2026-04-01',
      to: '2026-04-30',
      issues: [{ code: 'hsn_missing', severity: 'error', voucherId: 1, voucherNumber: 'S-1', voucherTypeName: 'Sales', date: '2026-04-02', partyName: null, section: 'b2b', message: 'm', fix: 'f' }],
      counts: { errors: 1, warnings: 0, byCode: { hsn_missing: 1 } },
    });
    assert.deepEqual(x.rows[0], ['Error', 'HSN/SAC missing', '2026-04-02', 'Sales S-1', '', 'm', 'f']);
  });

  it('GSTR-9 table 9 is split into payable, ITC and cash rows', () => {
    const tv = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const s: Gstr9Summary = {
      fy: '2026-27',
      from: '2026-04-01',
      to: '2027-03-31',
      gstin: null,
      companyName: 'Test',
      caption: 'Prepared from books — verify before filing',
      table4: [{ key: '4A', label: 'B2C', ...tv, taxable: 100 }],
      table5: [],
      table6: [],
      table9: [{ head: 'igst', label: 'IGST', payable: 1_000, paidCash: 400, paidItc: { igst: 600, cgst: 0, sgst: 0, cess: 0 } }],
      hsnOutward: [],
      hsnInward: [],
      months: [],
      notes: [],
    };
    const e = gstr9Export(s);
    assert.deepEqual(e.rows, [
      ['II', '4A', 'B2C', 100, 0, 0, 0, 0],
      ['IV', '9', 'IGST — tax payable', 1_000, null, null, null, null],
      ['IV', '9', 'IGST — paid through ITC (by credit head)', null, 600, 0, 0, 0],
      ['IV', '9', 'IGST — paid in cash', 400, null, null, null, null],
    ]);
    assert.match(e.subtitle ?? '', /Prepared from books — verify before filing/);
  });

  it('describes a saved bulk file', () => {
    assert.equal(bulkFileMessage({ documents: 3, rejected: [], warnings: [] }), '3 documents in the file');
    assert.equal(bulkFileMessage({ documents: 1, rejected: [{ voucherId: 1, number: null, errors: [] }], warnings: ['w'] }), '1 document in the file · 1 left out (see the list) · 1 note');
  });
});
