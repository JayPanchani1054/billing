import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstIssue, Gstr1DocRow, Gstr1SectionId, Gstr1SectionResult, Gstr1SectionSummary, Gstr1Summary } from '../../../../shared/types/gst-returns.ts';
import { GSTR1_SECTIONS } from '../../../../shared/types/gst-returns.ts';
import { buildTiles, countText, GSTR1_TILES, issuesForSections, sectionExport, sectionLayout, signedInvoiceValue, summaryExport, tileDef, tileOfSection } from './gstr1.ts';

const ROWS: ReadonlySet<Gstr1SectionId> = new Set(['b2cs', 'nil', 'hsn_b2b', 'hsn_b2c', 'at', 'atadj']);

function sec(id: Gstr1SectionId, v: Partial<Gstr1SectionSummary> = {}): Gstr1SectionSummary {
  return {
    id,
    table: id,
    title: id,
    count: 0,
    countLabel: id === 'doc' ? 'series' : ROWS.has(id) ? 'rows' : 'documents',
    invoiceValue: 0,
    taxable: 0,
    igst: 0,
    cgst: 0,
    sgst: 0,
    cess: 0,
    ...v,
  };
}

function issue(section: Gstr1SectionId | null, severity: GstIssue['severity']): GstIssue {
  return {
    code: 'hsn_missing',
    severity,
    voucherId: section ? 1 : null,
    voucherNumber: 'S-1',
    voucherTypeName: 'Sales',
    date: '2026-04-02',
    partyName: 'Acme',
    section,
    message: 'm',
    fix: 'f',
  };
}

// Amounts in paise.
const values: Partial<Record<Gstr1SectionId, Partial<Gstr1SectionSummary>>> = {
  // 2 invoices: 3,000.00 taxable; intra 1,000.00 @18 (C/S 90.00 each) + inter 2,000.00 @18 (IGST 360.00).
  b2b: { count: 2, taxable: 300000, igst: 36000, cgst: 9000, sgst: 9000, invoiceValue: 354000 },
  // Export with payment 5,000.00 @18 → IGST 900.00; LUT export 10,000.00, no tax.
  exp_wp: { count: 1, taxable: 500000, igst: 90000, invoiceValue: 590000 },
  exp_wop: { count: 1, taxable: 1000000, invoiceValue: 1000000 },
  // Notes reduce: CDNR 500.00 @18 (IGST 90.00), CDNUR 10,000.00 @18 (IGST 1,800.00).
  cdnr: { count: 1, taxable: -50000, igst: -9000, invoiceValue: -59000 },
  cdnur: { count: 1, taxable: -1000000, igst: -180000, invoiceValue: -1180000 },
  hsn_b2b: { count: 3, taxable: 250000 },
  hsn_b2c: { count: 2, taxable: 1500000 },
  doc: { count: 2 },
  at: { note: 'Advances are not derived from the books.' },
};

const summary: Gstr1Summary = {
  period: { key: '042026', kind: 'month', label: 'Apr 2026', from: '2026-04-01', to: '2026-04-30', fp: '042026' },
  gstin: '27AAAPA0001A1Z5',
  companyName: 'Test Co',
  sections: GSTR1_SECTIONS.map((id) => sec(id, values[id])),
  b2cs: [],
  nil: [],
  hsnB2b: [],
  hsnB2c: [],
  docs: [],
  // 3,000.00 + 5,000.00 + 10,000.00 − 500.00 − 10,000.00 = 7,500.00 taxable; tax 360 + 90 + 90 + 900 − 90 − 1,800 = −450.00.
  totals: { taxable: 750000, igst: -63000, cgst: 9000, sgst: 9000, cess: 0 },
  issues: [issue('b2b', 'error'), issue('cdnur', 'warning'), issue('doc', 'warning'), issue(null, 'warning')],
  notes: [],
  excluded: { optional: 1, cancelled: 1, notGst: 0 },
};

describe('GSTR-1 tiles', () => {
  it('has one tile per return table, covering every section exactly once', () => {
    assert.deepEqual(
      GSTR1_TILES.map((t) => t.id),
      ['4A', '4B', '5', '6A', '6B', '6C', '7', '8', '9B', '11', '12', '13'],
    );
    const covered = GSTR1_TILES.flatMap((t) => t.sections).sort();
    assert.deepEqual(covered, [...GSTR1_SECTIONS].sort());
    assert.equal(tileOfSection('exp_wop'), '6A');
    assert.equal(tileOfSection('cdnur'), '9B');
    assert.equal(tileOfSection('hsn_b2c'), '12');
    assert.equal(tileDef('99'), null);
  });

  it('sums the sections of combined tables', () => {
    const tiles = new Map(buildTiles(summary).map((t) => [t.id, t]));
    const a4 = tiles.get('4A');
    assert.ok(a4);
    // tax = 360.00 + 90.00 + 90.00 = 540.00
    assert.deepEqual([a4.count, a4.taxable, a4.tax, a4.invoiceValue, a4.errors, a4.warnings, a4.empty], [2, 300000, 54000, 354000, 1, 0, false]);
    const a6 = tiles.get('6A');
    assert.ok(a6);
    // 1 + 1 documents; 5,000.00 + 10,000.00 taxable; IGST 900.00
    assert.deepEqual([a6.count, a6.taxable, a6.tax, a6.invoiceValue], [2, 1500000, 90000, 1590000]);
    const b9 = tiles.get('9B');
    assert.ok(b9);
    // −500.00 − 10,000.00 taxable; IGST −90.00 − 1,800.00
    assert.deepEqual([b9.count, b9.taxable, b9.tax, b9.warnings], [2, -1050000, -189000, 1]);
    const t12 = tiles.get('12');
    assert.ok(t12);
    assert.deepEqual([t12.count, t12.countLabel, t12.taxable], [5, 'rows', 1750000]);
    const t13 = tiles.get('13');
    assert.ok(t13);
    assert.deepEqual([t13.count, t13.countLabel, t13.warnings], [2, 'series', 1]);
    const t11 = tiles.get('11');
    assert.ok(t11);
    assert.deepEqual([t11.empty, t11.notes], [true, ['Advances are not derived from the books.']]);
    assert.equal(tiles.get('4B')?.empty, true);
  });

  it('filters issues by section and lays out drill-downs by section kind', () => {
    assert.equal(issuesForSections(summary.issues, ['cdnr', 'cdnur']).length, 1);
    assert.equal(issuesForSections(summary.issues, ['b2cs']).length, 0);
    assert.equal(sectionLayout('b2b'), 'documents');
    assert.equal(sectionLayout('cdnur'), 'documents');
    assert.equal(sectionLayout('b2cs'), 'b2cs');
    assert.equal(sectionLayout('hsn_b2b'), 'hsn');
    assert.equal(sectionLayout('doc'), 'doc');
    assert.equal(sectionLayout('atadj'), 'advances');
    assert.equal(countText(1, 'documents'), '1 document');
    assert.equal(countText(3, 'rows'), '3 rows');
    assert.equal(countText(2, 'series'), '2 series');
  });

  it('exports the summary table with the totals line', () => {
    const e = summaryExport(summary);
    assert.equal(e.rows.length, 12);
    assert.deepEqual(e.rows[3], ['6A', 'Exports', 2, 1500000, 90000, 0, 0, 0, 90000]);
    // total tax −630.00 + 90.00 + 90.00 = −450.00
    assert.deepEqual(e.totals, ['', 'Tax on outward supplies (excl. 4B)', null, 750000, -63000, 9000, 9000, 0, -45000]);
    assert.equal(e.columns.length, e.rows[0].length);
    assert.match(e.subtitle ?? '', /Apr 2026 · GSTIN 27AAAPA0001A1Z5/);
  });
});

describe('GSTR-1 section drill-down export', () => {
  const period = { key: '042026', kind: 'month' as const, label: 'Apr 2026', from: '2026-04-01', to: '2026-04-30', fp: '042026' };
  function doc(id: number, sign: 1 | -1, taxable: number, igst: number, invoiceValue: number, noteType: 'C' | null): Gstr1DocRow {
    return {
      voucherId: id,
      voucherTypeName: noteType ? 'Credit Note' : 'Sales',
      baseType: noteType ? 'credit_note' : 'sales',
      number: `${noteType ? 'CN' : 'S'}-${id}`,
      date: '2026-04-05',
      partyName: 'Delhi Retail Buyer',
      gstin: null,
      pos: '07',
      posName: 'Delhi',
      invoiceValue,
      sign,
      reverseCharge: false,
      noteType,
      invoiceType: null,
      exportType: null,
      cdnurType: null,
      shippingBill: null,
      originalInvoiceNo: noteType ? 'S-4' : null,
      originalInvoiceDate: noteType ? '2026-04-05' : null,
      nature: 'b2cs',
      rates: [],
      taxable,
      igst,
      cgst: 0,
      sgst: 0,
      cess: 0,
    };
  }

  it('signs the invoice value like the amounts so the column adds up', () => {
    assert.equal(signedInvoiceValue({ invoiceValue: 11_800, sign: -1 }), -11_800);
    assert.equal(signedInvoiceValue({ invoiceValue: 11_800, sign: 1 }), 11_800);
  });

  it('document rows: totals equal the sum of the (signed) rows', () => {
    // S-5 inter-state B2CS 84,745.76 + IGST 15,254.24 = 1,00,000.00; CN-3 reduces by 100.00 + 18.00 = 118.00.
    const rows = [doc(5, 1, 8_474_576, 1_525_424, 10_000_000, null), doc(3, -1, -10_000, -1_800, 11_800, 'C')];
    const d: Gstr1SectionResult = {
      period,
      section: 'b2cs',
      table: '7',
      title: 'B2C others',
      rows,
      totals: { taxable: 8_464_576, igst: 1_523_624, cgst: 0, sgst: 0, cess: 0, invoiceValue: 10_000_000 - 11_800 },
      b2cs: [],
    };
    const docsOnly = { ...d, section: 'cdnur' as const, b2cs: undefined };
    const e = sectionExport(docsOnly);
    assert.equal(e.period, 'Apr 2026');
    const ivCol = e.columns.findIndex((c) => c.header === 'Invoice value');
    const txCol = e.columns.findIndex((c) => c.header === 'Taxable value');
    assert.deepEqual(
      e.rows.map((r) => [r[ivCol], r[txCol]]),
      [
        [10_000_000, 8_474_576],
        [-11_800, -10_000],
      ],
    );
    assert.ok(e.totals);
    // 1,00,000.00 − 118.00 = 99,882.00 → 9,988,200 paise; taxable 84,745.76 − 100.00 = 84,645.76.
    assert.equal(e.totals[ivCol], 9_988_200);
    assert.equal(e.totals[txCol], 8_464_576);
    assert.equal(e.rows[1][e.columns.findIndex((c) => c.header === 'Original invoice')], 'S-4 · 2026-04-05');
    for (const r of e.rows) assert.equal(r.length, e.columns.length);
    assert.equal(e.totals.length, e.columns.length);
  });

  it('aggregate tables carry a totals row', () => {
    const b2cs: Gstr1SectionResult = {
      period,
      section: 'b2cs',
      table: '7',
      title: 'B2C others',
      rows: [],
      totals: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, invoiceValue: 0 },
      b2cs: [
        { supplyType: 'INTRA', pos: '27', posName: 'Maharashtra', rate: 18, type: 'OE', documents: 3, taxable: 50_000, igst: 0, cgst: 4_500, sgst: 4_500, cess: 0 },
        { supplyType: 'INTER', pos: '07', posName: 'Delhi', rate: 18, type: 'OE', documents: 1, taxable: 8_474_576, igst: 1_525_424, cgst: 0, sgst: 0, cess: 0 },
      ],
    };
    const e = sectionExport(b2cs);
    // documents 3 + 1 = 4; taxable 500.00 + 84,745.76 = 85,245.76.
    assert.deepEqual(e.totals, ['Total', '', null, 4, 8_524_576, 1_525_424, 4_500, 4_500, 0]);
    const nil = sectionExport({
      ...b2cs,
      section: 'nil',
      b2cs: undefined,
      nil: [
        { supplyType: 'INTRAB2C', label: 'Intra-state to unregistered', exempt: 30_000, nil: 50_000, nonGst: 70_000 },
        { supplyType: 'INTRB2B', label: 'Inter-state to registered', exempt: 1_000, nil: 0, nonGst: 0 },
      ],
    });
    assert.deepEqual(nil.totals, ['Total', 50_000, 31_000, 70_000]);
    const hsn = sectionExport({
      ...b2cs,
      section: 'hsn_b2c',
      b2cs: undefined,
      hsn: [{ hsn: '8471', description: 'PC', uqc: 'NOS', qty: 2, rate: 18, taxable: 20_000, igst: 0, cgst: 1_800, sgst: 1_800, cess: 0, total: 23_600, supplyType: 'goods' }],
    });
    assert.deepEqual(hsn.totals, ['Total', '', '', null, null, 20_000, 0, 1_800, 1_800, 0, 23_600]);
  });
});
