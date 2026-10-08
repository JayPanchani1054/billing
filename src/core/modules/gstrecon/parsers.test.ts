import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { FileFormatError } from '../../lib/text.ts';
import type { XlsxCell } from '../../lib/xlsx.ts';
import { createZip } from '../../lib/zip.ts';
import { detectJsonKind } from './portal-json.ts';
import { findHeader, matchHeader } from './portal-xlsx.ts';
import { parsePortalFile } from './parsers.ts';
import { B2B_HEAD_1, B2B_HEAD_2, enc, excel2b, gstr2bJson, inv2a, nt2a, S1, S2, S3 } from './testkit.ts';

const OWN = '27AAPFU0939F1ZV';

function throwsWith(fn: () => unknown, re: RegExp, type: 'file' | 'validation' = 'file'): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AppError, `expected an AppError, got ${String(caught)}`);
  if (type === 'file') assert.ok(caught instanceof FileFormatError, `expected FileFormatError, got ${(caught as Error).name}`);
  assert.equal((caught as AppError).code, 'VALIDATION');
  assert.match((caught as AppError).message, re);
  return caught as AppError;
}

/** A realistic GSTR-2B: multi-rate invoice, IGST invoice, ITC-not-available, credit & debit notes, amendment, ISD/IMPG. */
function realistic2b(): Record<string, unknown> {
  return gstr2bJson({
    gstin: OWN,
    rtnprd: '042026',
    b2b: [
      {
        ctin: S1,
        trdnm: 'SUPREME SUPPLIERS',
        inv: [
          // ₹10,000 @18% (CGST 900 + SGST 900) + ₹2,000 @5% (CGST 50 + SGST 50) → value 13,000
          { inum: 'INV/001/26-27', dt: '05-04-2026', items: [[18, 10000, 0, 900, 900], [5, 2000, 0, 50, 50]] },
          { inum: 'INV/002/26-27', dt: '07-04-2026', itcavl: 'N', rsn: 'P', items: [[18, 1000, 0, 90, 90]] },
        ],
      },
      { ctin: S2, trdnm: 'BANGALORE COMPONENTS', inv: [{ inum: 'BC/77', dt: '12-04-2026', pos: '27', items: [[18, 20000.5, 3600.09, 0, 0, 12.34]] }] },
    ],
    b2ba: [{ ctin: S3, inv: [{ inum: 'LT-10A', dt: '02-04-2026', oinum: 'LT-10', oidt: '28-03-2026', items: [[12, 500, 0, 30, 30]] }] }],
    cdnr: [{ ctin: S1, nt: [{ ntnum: 'CN-1', typ: 'C', dt: '20-04-2026', items: [[18, 200, 0, 18, 18]] }, { ntnum: 'DN-1', typ: 'D', dt: '21-04-2026', items: [[18, 100, 0, 9, 9]] }] }],
    extra: {
      isd: [{ ctin: '27AAAAA0000A1Z5', doclist: [{ docnum: 'ISD1' }, { docnum: 'ISD2' }] }],
      impg: [{ boenum: '1234567', igst: 100 }],
    },
  });
}

describe('GSTR-2B JSON', () => {
  it('parses every document with amounts in paise, ISO dates, codes and normalised types', () => {
    const f = parsePortalFile(enc(realistic2b()), 'gstr2b');
    assert.equal(f.kind, 'gstr2b');
    assert.equal(f.format, 'json');
    assert.equal(f.gstin, OWN);
    assert.equal(f.period, '042026');
    assert.equal(f.generatedOn, '2026-05-14');
    assert.deepEqual(f.sections, { b2b: 3, b2ba: 1, cdnr: 2 });
    assert.deepEqual(f.skipped, { ISD: 2, IMPG: 1 });
    assert.equal(f.docs.length, 6);

    const inv1 = f.docs[0];
    assert.equal(inv1.section, 'b2b');
    assert.equal(inv1.gstin, S1);
    assert.equal(inv1.name, 'SUPREME SUPPLIERS');
    assert.equal(inv1.docType, 'invoice');
    assert.equal(inv1.docNo, 'INV/001/26-27');
    assert.equal(inv1.docDate, '2026-04-05');
    // taxable 10,000 + 2,000 = 12,000.00; CGST 900 + 50 = 950.00; SGST 950.00; value 13,900.00
    assert.equal(inv1.taxable, 1_200_000);
    assert.equal(inv1.cgst, 95_000);
    assert.equal(inv1.sgst, 95_000);
    assert.equal(inv1.igst, 0);
    assert.equal(inv1.invoiceValue, 1_390_000);
    assert.deepEqual(inv1.rates, [5, 18]);
    assert.equal(inv1.pos, '27');
    assert.equal(inv1.itcAvailable, true);
    assert.equal(inv1.supplierPeriod, '042026');
    assert.equal(inv1.filingDate, '2026-05-11');
    assert.equal(inv1.invoiceType, 'R');

    const blocked = f.docs[1];
    assert.equal(blocked.itcAvailable, false);
    assert.match(blocked.itcReason ?? '', /^P: Place of supply/);

    const igst = f.docs[2];
    // 20,000.50 → 2000050 paise; IGST 3,600.09 → 360009; cess 12.34 → 1234
    assert.equal(igst.taxable, 2_000_050);
    assert.equal(igst.igst, 360_009);
    assert.equal(igst.cess, 1234);

    const amend = f.docs.find((d) => d.section === 'b2ba');
    assert.deepEqual(amend?.original, { docNo: 'LT-10', docDate: '2026-03-28' });
    const notes = f.docs.filter((d) => d.section === 'cdnr').map((d) => [d.docNo, d.docType, d.taxable]);
    assert.deepEqual(notes, [['CN-1', 'credit_note', 20_000], ['DN-1', 'debit_note', 10_000]]);
  });

  it('accepts the variant whose root holds docdata directly', () => {
    const f = parsePortalFile(enc(gstr2bJson({ gstin: OWN, rtnprd: '052026', wrap: false, b2b: [{ ctin: S1, inv: [{ inum: '9', dt: '01-05-2026', items: [[5, 100, 0, 2.5, 2.5]] }] }] })), 'gstr2b');
    assert.equal(f.period, '052026');
    assert.equal(f.docs.length, 1);
    assert.equal(f.docs[0].cgst, 250);
  });

  it('skips documents it cannot reconcile, with one grouped warning per problem', () => {
    const json = gstr2bJson({
      gstin: OWN,
      rtnprd: '042026',
      b2b: [{ ctin: S1, inv: [{ inum: '', dt: '01-04-2026', items: [] }, { inum: 'A1', dt: '31-04-2026', items: [] }, { inum: 'A2', dt: '30-04-2026', items: [] }] }],
    });
    const f = parsePortalFile(enc(json), 'gstr2b');
    assert.equal(f.docs.length, 1);
    assert.ok(f.warnings.some((w) => /has no document number; it was skipped/.test(w)));
    assert.ok(f.warnings.some((w) => /B2B A1 of .*date "31-04-2026" is not a valid date/.test(w)));
    assert.ok(f.warnings.some((w) => /no item details/.test(w)));
  });

  it('a non-numeric amount is a file error naming the document', () => {
    const json = gstr2bJson({ gstin: OWN, rtnprd: '042026', b2b: [{ ctin: S1, inv: [{ inum: 'X1', dt: '01-04-2026', items: [[18, 100, 0, 9, 9]] }] }] });
    ((((json.data as Record<string, unknown>).docdata as Record<string, unknown>).b2b as Array<{ inv: Array<{ items: Array<Record<string, unknown>> }> }>)[0].inv[0].items[0]).txval = 'abc';
    throwsWith(() => parsePortalFile(enc(json), 'gstr2b'), /B2B X1 of 27.*taxable value "abc" is not an amount/);
  });

  it('a multi-part ZIP download is merged; parts of different periods are refused', () => {
    const a = gstr2bJson({ gstin: OWN, rtnprd: '042026', b2b: [{ ctin: S1, inv: [{ inum: '1', dt: '01-04-2026', items: [[5, 100, 0, 2.5, 2.5]] }] }] });
    const b = gstr2bJson({ gstin: OWN, rtnprd: '042026', b2b: [{ ctin: S2, inv: [{ inum: '2', dt: '02-04-2026', items: [[18, 100, 18, 0, 0]] }] }] });
    const zip = createZip([{ name: 'part_1.json', data: JSON.stringify(a) }, { name: 'part_2.json', data: JSON.stringify(b) }]);
    const f = parsePortalFile(zip, 'gstr2b');
    assert.equal(f.format, 'zip');
    assert.deepEqual(f.docs.map((d) => d.docNo), ['1', '2']);
    const c = gstr2bJson({ gstin: OWN, rtnprd: '052026', b2b: [] });
    const bad = createZip([{ name: 'a.json', data: JSON.stringify(a) }, { name: 'b.json', data: JSON.stringify(c) }]);
    throwsWith(() => parsePortalFile(bad, 'gstr2b'), /mixes returns of different periods \(042026, 052026\)/);
  });
});

describe('GSTR-2A and GSTR-1 JSON', () => {
  const twoA = {
    gstin: OWN,
    fp: '042026',
    b2b: [{ ctin: S1, cfs: 'Y', cfs3b: 'Y', fldtr1: '10-May-26', flprdr1: 'Apr-26', inv: [inv2a({ inum: 'S-1', idt: '03-04-2026', items: [[18, 1000, 0, 90, 90]] })] }],
    b2ba: [{ ctin: S2, cfs: 'Y', inv: [inv2a({ inum: 'B-2', idt: '04-04-2026', pos: '27', oinum: 'B-1', oidt: '30-03-2026', items: [[18, 500, 90, 0, 0]] })] }],
    cdn: [{ ctin: S1, cfs: 'N', nt: [nt2a({ nt_num: 'C-1', nt_dt: '09-04-2026', ntty: 'C', items: [[18, 100, 0, 9, 9]] })] }],
    tds: [{ gstin_deductor: 'x', amt_ded: 1 }],
  };

  it('parses GSTR-2A b2b / b2ba / cdn with filing status and period', () => {
    const f = parsePortalFile(enc(twoA), 'gstr2a');
    assert.equal(f.period, '042026');
    assert.deepEqual(f.sections, { b2b: 1, b2ba: 1, cdnr: 1 });
    assert.deepEqual(f.skipped, { TDS: 1 });
    const [inv, amend, note] = f.docs;
    assert.equal(inv.filingStatus, 'Y');
    assert.equal(inv.filingDate, '2026-05-10');
    assert.equal(inv.supplierPeriod, '042026');
    assert.equal(inv.itcAvailable, null);
    assert.equal(amend.igst, 9_000);
    assert.deepEqual(amend.original, { docNo: 'B-1', docDate: '2026-03-30' });
    assert.equal(note.docType, 'credit_note');
    assert.equal(note.filingStatus, 'N');
  });

  it('parses GSTR-1 b2b, b2cl, cdnr, cdnur and exports; B2CS/HSN are summary sections', () => {
    const g1 = {
      gstin: OWN,
      fp: '042026',
      version: 'GST3.2.1',
      hash: 'hash',
      b2b: [{ ctin: S2, inv: [inv2a({ inum: 'INV-1', idt: '02-04-2026', pos: '29', items: [[18, 1000, 180, 0, 0]] })] }],
      b2cl: [{ pos: '29', inv: [{ inum: 'INV-2', idt: '03-04-2026', val: 236000, itms: [{ num: 1, itm_det: { rt: 18, txval: 200000, iamt: 36000, csamt: 0 } }] }] }],
      cdnr: [{ ctin: S2, nt: [nt2a({ nt_num: 'CN-5', nt_dt: '04-04-2026', ntty: 'C', pos: '29', items: [[18, 100, 18, 0, 0]] })] }],
      cdnur: [{ typ: 'EXPWP', ntty: 'C', nt_num: 'CN-6', nt_dt: '05-04-2026', val: 118, itms: [{ num: 1, itm_det: { rt: 18, txval: 100, iamt: 18, csamt: 0 } }] }],
      exp: [{ exp_typ: 'WOPAY', inv: [{ inum: 'EXP-1', idt: '06-04-2026', val: 5000, sbpcode: 'INNSA1', itms: [{ txval: 5000, rt: 0, iamt: 0, csamt: 0 }] }] }],
      b2cs: [{ sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 5, txval: 100, camt: 2.5, samt: 2.5, csamt: 0 }],
      hsn: { hsn_b2b: [{ num: 1, hsn_sc: '8471' }] },
      doc_issue: { doc_det: [] },
    };
    assert.equal(detectJsonKind(g1), 'gstr1');
    const f = parsePortalFile(enc(g1), 'gstr1');
    assert.deepEqual(f.sections, { b2b: 1, b2cl: 1, cdnr: 1, cdnur: 1, exp: 1 });
    assert.deepEqual(Object.keys(f.skipped).sort(), ['B2CS', 'DOC_ISSUE', 'HSN']);
    const byNo = new Map(f.docs.map((d) => [d.docNo, d]));
    assert.equal(byNo.get('INV-2')?.gstin, '');
    assert.equal(byNo.get('INV-2')?.pos, '29'); // B2CL takes POS from its group
    assert.equal(byNo.get('INV-2')?.taxable, 20_000_000);
    assert.equal(byNo.get('CN-6')?.pos, '96');
    assert.equal(byNo.get('EXP-1')?.pos, '96');
    assert.equal(byNo.get('EXP-1')?.invoiceType, 'WOPAY');
  });

  it('refuses a file of another return with a clear message on `source`', () => {
    const e1 = throwsWith(() => parsePortalFile(enc(twoA), 'gstr2b'), /This is a GSTR-2A file, not GSTR-2B. Choose "GSTR-2A" as the source/, 'validation');
    assert.deepEqual((e1.details as Array<{ path: string }>)[0].path, 'source');
    throwsWith(() => parsePortalFile(enc(realistic2b()), 'gstr2a'), /This is a GSTR-2B file, not GSTR-2A/, 'validation');
    throwsWith(() => parsePortalFile(enc(twoA), 'gstr1'), /This is a GSTR-2A file, not GSTR-1/, 'validation');
    throwsWith(() => parsePortalFile(enc({ gstin: OWN, fp: '042026', b2b: [] }), 'gstr2b'), /no "docdata" section/, 'validation');
    throwsWith(() => parsePortalFile(enc({ hello: 'world' }), 'gstr2a'), /none of the b2b \/ cdnr \/ docdata sections/);
  });

  it('broken files: invalid JSON, HTML pages, empty and old .xls files', () => {
    throwsWith(() => parsePortalFile(new TextEncoder().encode('{"data": {"gstin": "27'), 'gstr2b'), /not valid JSON .* download it again/);
    throwsWith(() => parsePortalFile(new TextEncoder().encode('<html><body>Session expired</body></html>'), 'gstr2b'), /web page \(HTML\/XML\)/);
    throwsWith(() => parsePortalFile(new Uint8Array(0), 'gstr2b'), /The file is empty/);
    throwsWith(() => parsePortalFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'gstr2b'), /old Excel 97-2003 \(\.xls\)/);
    // UTF-8 BOM is fine.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(realistic2b())]);
    assert.equal(parsePortalFile(bom, 'gstr2b').docs.length, 6);
  });
});

describe('GSTR-2B Excel', () => {
  it('maps the portal headings (two-row header with merged groups)', () => {
    assert.equal(matchHeader('GSTIN of supplier'), 'gstin');
    assert.equal(matchHeader('Trade/Legal name'), 'name');
    assert.equal(matchHeader('Invoice Details'), null);
    assert.equal(matchHeader('Invoice Value(₹)'), 'value');
    assert.equal(matchHeader('Taxable Value (₹)'), 'taxable');
    assert.equal(matchHeader('State/UT Tax(₹)'), 'sgst');
    assert.equal(matchHeader('GSTR-1/IFF/GSTR-5 Filing Date'), 'filingDate');
    assert.equal(matchHeader('GSTR-1/IFF/GSTR-5 Period'), 'supplierPeriod');
    assert.equal(matchHeader('Applicable % of Tax Rate'), 'applicablePct');
    assert.equal(matchHeader('Note Supply type'), 'noteSupplyType');
    assert.equal(matchHeader('Note type'), 'docType');
    assert.equal(matchHeader('IRN Date'), 'irnDate');
    assert.equal(matchHeader('Rate (%)'), 'rate');
    const rows = [['Goods and Services Tax - GSTR-2B'], [], B2B_HEAD_1, B2B_HEAD_2, [S1, 'X', '1']].map((r) => r.map((c) => (c === undefined ? null : c))) as Array<Array<string | number | boolean | null>>;
    const h = findHeader(rows);
    assert.equal(h?.end, 3);
    assert.equal(h?.cols.get('docNo'), 2);
    assert.equal(h?.cols.get('igst'), 9);
  });

  it('parses B2B and B2B-CDNR sheets, aggregating rows of the same invoice and reading the period from Read me', () => {
    const b2b: XlsxCell[][] = [
      // Two rows of one invoice (18% and 5%): taxable 10,000 + 2,000; value repeats.
      [S1, 'SUPREME', 'INV/001/26-27', 'Regular', '05-04-2026', 13900, '27-Maharashtra', 'No', 10000, 0, 900, 900, 0, "Apr'26", '11-05-2026', 'Yes', '', '100%', 'e-Invoice', 'abc', '05-04-2026'],
      [S1, 'SUPREME', 'INV/001/26-27', 'Regular', '05-04-2026', 13900, '27-Maharashtra', 'No', 2000, 0, 50, 50, 0, "Apr'26", '11-05-2026', 'Yes', '', '100%', 'e-Invoice', 'abc', '05-04-2026'],
      // Date as a real date cell, POS as a state name, ITC not available.
      [S2, 'BANGALORE', 'BC/77', 'Regular', { v: '2026-04-12', kind: 'date' }, 23600, 'Maharashtra', 'N', 20000, 3600, 0, 0, 0, 'Apr-2026', '11-05-2026', 'No', 'P', '', '', '', ''],
      [S3, 'BAD', '', 'Regular', '05-04-2026', 1, '27', 'N', 1, 0, 0, 0, 0, '', '', 'Yes', '', '', '', '', ''],
      ['Total', '', '', '', '', 37500, '', '', 32000, 3600, 950, 950, 0],
    ];
    const cdnr: XlsxCell[][] = [[S1, 'SUPREME', 'CN-1', 'Credit Note', 'Regular', '20-04-2026', 236, '27-Maharashtra', 'No', 200, 0, 18, 18, 0, "Apr'26", '11-05-2026', 'Yes', '', '', '', '', '']];
    const bytes = excel2b({
      readme: [['GSTR-2B'], ['Financial Year', '2026-27'], ['Tax Period', 'April'], ['GSTIN', OWN]],
      b2b,
      cdnr,
      extraSheets: [{ name: 'IMPG', rows: [['Import of goods'], [], ['Reference date', 'Port code', 'Bill of entry number', 'Bill of entry date', 'Taxable value', 'Integrated tax'], ['01-04-2026', 'INNSA1', '123', '01-04-2026', 100, 18]] }],
    });
    const f = parsePortalFile(bytes, 'gstr2b');
    assert.equal(f.format, 'xlsx');
    assert.equal(f.period, '042026');
    assert.equal(f.gstin, OWN);
    assert.deepEqual(f.sections, { b2b: 2, cdnr: 1 });
    const inv = f.docs[0];
    assert.equal(inv.docNo, 'INV/001/26-27');
    assert.equal(inv.taxable, 1_200_000); // 10,000 + 2,000
    assert.equal(inv.cgst, 95_000); // 900 + 50
    assert.equal(inv.invoiceValue, 1_390_000); // value taken once
    assert.equal(inv.pos, '27');
    assert.equal(inv.supplierPeriod, '042026');
    assert.equal(inv.applicablePct, 100);
    assert.deepEqual((inv.raw as { rows: number[] }).rows, [7, 8]);
    const bc = f.docs[1];
    assert.equal(bc.docDate, '2026-04-12');
    assert.equal(bc.pos, '27');
    assert.equal(bc.itcAvailable, false);
    assert.match(bc.itcReason ?? '', /^P:/);
    assert.equal(f.docs[2].docType, 'credit_note');
    assert.equal(f.docs[2].taxable, 20_000);
    assert.ok(f.warnings.some((w) => /row 10: no document number/.test(w)));
  });

  it('refuses a workbook without B2B sheets or with unrecognised headings', () => {
    const none = excel2b({ extraSheets: [{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]] }] });
    throwsWith(() => parsePortalFile(none, 'gstr2b'), /No "B2B" or "B2B-CDNR" sheet was found/);
    const wrong = excel2b({ extraSheets: [{ name: 'B2B', rows: [['Supplier', 'Bill', 'Amount'], ...Array.from({ length: 6 }, () => ['x', 'y', 1])] }] });
    throwsWith(() => parsePortalFile(wrong, 'gstr2b'), /Sheet "B2B": the column headings were not recognised/);
    throwsWith(() => parsePortalFile(none, 'gstr1'), /GSTR-1 is reconciled from its JSON file/, 'validation');
  });
});
