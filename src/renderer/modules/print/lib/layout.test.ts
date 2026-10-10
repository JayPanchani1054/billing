import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sampleDoc, line } from './fixtures.ts';
import { applyPrintLayout, resolvePrintLayout, type PrintPartId, type PrintTextId } from '../../../../shared/printLayout.ts';
import {
  addressLines,
  classicTaxRows,
  compactLineInfo,
  copyLabel,
  documentTitle,
  headerRefs,
  headerRefsWithParts,
  itemColumns,
  nativePageSize,
  pageSizeFor,
  partyBoxLabel,
  partyIds,
  pdfFileName,
  qtyText,
  resolveCopies,
  resolveTemplate,
  taxabilityText,
  templateForPageSize,
  isRoll,
  rollHeightMm,
  showMrp,
  mrpText,
  toggleCopy,
  totalRows,
  voucherSides,
} from './layout.ts';

describe('templates, paper and copies', () => {
  it('resolves the template and paper size', () => {
    const doc = sampleDoc({ defaultTemplate: 'classic' });
    assert.equal(resolveTemplate(doc), 'classic');
    assert.equal(resolveTemplate(doc, 'compact'), 'compact');
    assert.equal(resolveTemplate(doc, 'fancy'), 'classic');
    assert.equal(pageSizeFor('compact', 'A4'), '80mm');
    assert.equal(pageSizeFor('modern', 'A5'), 'A5');
    assert.equal(pageSizeFor('modern', '80mm'), 'A4');
    assert.equal(pageSizeFor('classic'), 'A4');
    assert.equal(templateForPageSize('modern', '80mm', 'classic'), 'compact');
    assert.equal(templateForPageSize('compact', 'A4', 'classic'), 'classic');
    assert.equal(templateForPageSize('compact', 'A5', 'compact'), 'modern');
    assert.deepEqual(nativePageSize('A5'), { pageSize: 'A5', landscape: false });
    assert.deepEqual(nativePageSize('A5-landscape'), { pageSize: 'A5', landscape: true });
    assert.deepEqual(nativePageSize('80mm'), { pageSize: '80mm', landscape: false });
    assert.deepEqual(nativePageSize('Legal'), { pageSize: 'Legal', landscape: false });
  });

  it('rolls and configured paper', () => {
    assert.equal(pageSizeFor('compact', '58mm'), '58mm');
    assert.equal(pageSizeFor('compact', undefined, { rollWidth: '58mm' }), '58mm');
    assert.equal(pageSizeFor('compact', 'A5', { rollWidth: '80mm' }), '80mm');
    assert.equal(pageSizeFor('modern', undefined, { paperSize: 'A5-landscape' }), 'A5-landscape');
    assert.equal(pageSizeFor('classic', 'Legal', { paperSize: 'A5' }), 'Legal');
    assert.equal(pageSizeFor('modern', '58mm', { paperSize: 'Letter' }), 'Letter');
    assert.equal(templateForPageSize('classic', '58mm', 'modern'), 'compact');
    assert.equal(isRoll('58mm'), true);
    assert.equal(isRoll('A5-landscape'), false);
    // 480 px at 96 px per inch = 5 in = 127 mm → 127 + 4 mm feed; the tallest copy decides; sheets need no length.
    assert.equal(rollHeightMm('80mm', [200, 480]), 131);
    assert.equal(rollHeightMm('80mm', []), null);
    assert.equal(rollHeightMm('A4', [500]), null);
  });

  it('MRP column and text', () => {
    const doc = sampleDoc({ mrpSummary: { show: true, mrpValue: 599_00, savings: 68_00 }, lines: [line({ mrp: 599_00 })] });
    assert.equal(itemColumns(doc, { pageSize: 'A4', template: 'modern' }).mrp, true);
    assert.equal(showMrp(doc), true);
    assert.equal(mrpText(doc.lines[0]), '599.00');
    assert.equal(showMrp(sampleDoc({ mrpSummary: { show: false, mrpValue: 599_00, savings: 0 } })), false, 'option off');
    assert.equal(showMrp(sampleDoc({ mrpSummary: null })), false);
    assert.equal(mrpText(line({ mrp: null })), '');
  });

  it('copies: configured, a count, or a list — always in order, never empty', () => {
    const doc = sampleDoc();
    assert.deepEqual(resolveCopies(doc), ['original', 'duplicate']);
    assert.deepEqual(resolveCopies(doc, 3), ['original', 'duplicate', 'triplicate']);
    assert.deepEqual(resolveCopies(doc, ['triplicate', 'original']), ['original', 'triplicate']);
    assert.deepEqual(resolveCopies(doc, []), ['original']);
    assert.deepEqual(resolveCopies(sampleDoc({ layout: 'voucher' })), ['original'], 'vouchers default to one copy');
    assert.deepEqual(toggleCopy(['original'], 'triplicate'), ['original', 'triplicate']);
    assert.deepEqual(toggleCopy(['original'], 'original'), ['original'], 'the last copy cannot be removed');
  });

  it('copy labels: none on a single accounting voucher', () => {
    assert.equal(copyLabel(sampleDoc(), 'duplicate', 2), 'Duplicate for Transporter');
    assert.equal(copyLabel(sampleDoc({ layout: 'voucher' }), 'original', 1), null);
    assert.equal(copyLabel(sampleDoc({ layout: 'voucher', copyLabels: { original: 'Original', duplicate: 'Duplicate', triplicate: 'Triplicate' } }), 'duplicate', 2), 'Duplicate');
  });
});

describe('addresses and header', () => {
  it('splits multi-line addresses and adds state / PIN / foreign country', () => {
    assert.deepEqual(addressLines(sampleDoc().company), ['12 MG Road', 'Fort', 'Maharashtra - 400001']);
    assert.deepEqual(addressLines({ ...sampleDoc().party!, address: null, stateName: null, pincode: null, country: 'USA' }), ['USA']);
    assert.deepEqual(addressLines(null), []);
  });
  it('party identifiers', () => {
    assert.deepEqual(partyIds(sampleDoc().party), [
      { label: 'GSTIN/UIN', value: '27AAAPA0001A1Z6' },
      { label: 'PAN', value: 'AAAPA0001A' },
      { label: 'State', value: 'Maharashtra, Code 27' },
    ]);
    const unreg = { ...sampleDoc().party!, gstin: null, pan: null, registrationType: 'unregistered' };
    assert.deepEqual(partyIds(unreg, false), [{ label: 'GSTIN/UIN', value: 'Unregistered' }]);
  });
  it('classic buyer box label: combined only when the buyer is also the ship-to', () => {
    assert.equal(partyBoxLabel(sampleDoc()), 'Consignee (Ship to) / Buyer (Bill to)');
    assert.equal(partyBoxLabel(sampleDoc({ consigneeSameAsParty: false })), 'Buyer (Bill to)');
    // Purchase: no ship-to box at all → just the supplier.
    assert.equal(partyBoxLabel(sampleDoc({ partyLabel: 'Supplier (Bill from)', consigneeLabel: 'Ship to', consignee: null, consigneeSameAsParty: false })), 'Supplier (Bill from)');
    // Challan: the party already is the consignee — never "Consignee / Consignee".
    assert.equal(partyBoxLabel(sampleDoc({ partyLabel: 'Consignee (Ship to)', consigneeLabel: 'Consignee (Ship to)' })), 'Consignee (Ship to)');
  });

  it('header references: number, date, place of supply, reverse charge, e-way bill, references', () => {
    const doc = sampleDoc({ ewayBill: { number: '321009876543', date: '2026-04-15', validUpto: null }, references: [{ label: 'Vehicle No.', value: 'MH12AB1234' }] });
    assert.deepEqual(headerRefs(doc), [
      { label: 'Invoice No.', value: 'INV/12' },
      { label: 'Dated', value: '15-Apr-2026' },
      { label: 'Place of Supply', value: '27-Maharashtra' },
      { label: 'Reverse Charge', value: 'No' },
      { label: 'e-Way Bill No.', value: '321009876543 dated 15-Apr-2026' },
      { label: 'Vehicle No.', value: 'MH12AB1234' },
    ]);
    const note = headerRefs(sampleDoc({ kind: 'credit_note', baseType: 'credit_note', originalInvoice: { number: 'INV/3', date: '2026-04-01', reason: 'Rate difference' } }));
    assert.equal(note[0].label, 'Note No.');
    assert.deepEqual(note.slice(2, 4), [
      { label: 'Against Invoice', value: 'INV/3 dated 01-Apr-2026' },
      { label: 'Reason', value: 'Rate difference' },
    ]);
    const purchase = headerRefs(sampleDoc({ baseType: 'purchase', kind: 'purchase_voucher', referenceNo: 'SUP-77', referenceDate: '2026-04-14' }));
    assert.deepEqual(purchase[2], { label: 'Supplier Invoice No.', value: 'SUP-77 dated 14-Apr-2026' });
    const voucher = headerRefs(sampleDoc({ layout: 'voucher', kind: 'payment_voucher' }));
    assert.deepEqual(voucher.map((r) => r.label), ['Voucher No.', 'Dated']);
  });
});

describe('columns and totals', () => {
  it('item columns follow the data and the options', () => {
    const doc = sampleDoc();
    const cols = itemColumns(doc, { pageSize: 'A4', template: 'modern' });
    assert.deepEqual(cols, {
      sno: true,
      hsn: true,
      batch: false,
      qty: true,
      unit: true,
      rate: true,
      discount: true,
      gstRate: true,
      taxable: true,
      mrp: false,
      lineTax: false,
      igst: false,
      cgstSgst: true,
      cess: false,
      amount: true,
      lineHeads: { cgst: false, sgst: false, igst: false, cess: false },
    });
    const lineTax = sampleDoc({ options: { ...doc.options, itemwiseTax: true } });
    assert.equal(itemColumns(lineTax, { pageSize: 'A4', template: 'modern' }).lineTax, true);
    assert.equal(itemColumns(lineTax, { pageSize: 'A5', template: 'modern' }).lineTax, false, 'no per-line tax on A5');
    const unpriced = sampleDoc({ layout: 'inventory', gst: { ...doc.gst, showTax: false }, lines: [line({ rate: 0, amount: 0, hsnSac: null })] });
    const c2 = itemColumns(unpriced, { pageSize: 'A4', template: 'modern' });
    assert.deepEqual([c2.rate, c2.amount, c2.hsn], [false, false, false]);
  });

  it('totals rows: taxable, heads, charges, round off, total (tie: 770.00 + 36.80 + 36.80 + 0.40 = 844.00)', () => {
    const doc = sampleDoc({ charges: [] });
    const rows = totalRows(doc);
    assert.deepEqual(
      rows.map((r) => [r.label, r.amount]),
      [
        ['Taxable Value', 77000],
        ['CGST', 3680],
        ['SGST', 3680],
        ['Round Off', 40],
        ['Total', 84400],
      ],
    );
    assert.equal(rows.slice(0, -1).reduce((a, r) => a + r.amount, 0), rows[rows.length - 1].amount);
    const ut = totalRows(sampleDoc({ gst: { ...doc.gst, sgstLabel: 'UTGST', taxMode: 'cgst_utgst' } }));
    assert.equal(ut[2].label, 'UTGST');
    const plain = totalRows(sampleDoc({ gst: { ...doc.gst, showTax: false }, totals: { ...doc.totals, cgst: 0, sgst: 0, tax: 0, roundOff: 0, grandTotal: 77000 } }));
    assert.deepEqual(plain.map((r) => r.label), ['Total']);
  });

  it('classic tax rows show the half rate only when one rate applies', () => {
    const single = sampleDoc({ lines: [line()], totals: { ...sampleDoc().totals, cgst: 1250, sgst: 1250 } });
    assert.deepEqual(classicTaxRows(single), [
      { label: 'CGST', rate: '2.5%', amount: 1250 },
      { label: 'SGST', rate: '2.5%', amount: 1250 },
    ]);
    assert.deepEqual(classicTaxRows(sampleDoc()).map((r) => r.rate), ['', '']);
  });

  it('receipt line info: HSN and the GST rate on every taxed line (Rule 46), with or without HSN', () => {
    assert.equal(compactLineInfo(line(), true), 'HSN 1006 · GST 5%');
    assert.equal(compactLineInfo(line({ hsnSac: null, gstRate: 18 }), true), 'GST 18%', 'rate prints even without an HSN code');
    assert.equal(compactLineInfo(line({ taxability: 'exempt', gstRate: 0 }), true), 'HSN 1006 · GST Exempt');
    assert.equal(compactLineInfo(line(), false), 'HSN 1006', 'bill of supply / composition: no rate');
    assert.equal(compactLineInfo(line({ hsnSac: null }), false), '');
    assert.equal(compactLineInfo(line({ kind: 'ledger', absorbed: true, hsnSac: null }), true), 'Included in the taxable value');
    assert.deepEqual((['taxable', 'exempt', 'nil_rated', 'non_gst'] as const).map(taxabilityText), ['', 'Exempt', 'Nil', 'Non-GST']);
  });

  it('payment voucher sides', () => {
    const doc = sampleDoc({
      layout: 'voucher',
      entries: [
        { ledgerName: 'Supreme Suppliers', amount: 100000, debit: 100000, credit: 0, isCashBank: false, narration: null, instrument: null, bills: [], costCentres: [] },
        { ledgerName: 'HDFC Bank', amount: -100000, debit: 0, credit: 100000, isCashBank: true, narration: null, instrument: 'Cheque 1', bills: [], costCentres: [] },
      ],
    });
    assert.deepEqual(voucherSides(doc), { accounts: ['Supreme Suppliers'], through: ['HDFC Bank'] });
  });
});

describe('files and formatting', () => {
  it('PDF file names are safe for Windows', () => {
    assert.equal(pdfFileName(sampleDoc()), 'Tax Invoice INV-12 - Acme Traders.pdf');
    assert.equal(pdfFileName(sampleDoc({ number: null, party: null })), 'Tax Invoice 15-Apr-2026.pdf');
    assert.equal(pdfFileName(sampleDoc({ party: { ...sampleDoc().party!, name: 'A<b>c:d*?"|' } })), 'Tax Invoice INV-12 - A-b-c-d-.pdf');
  });
  it('document title', () => {
    assert.equal(documentTitle([sampleDoc()]), 'Tax Invoice INV/12');
    assert.equal(documentTitle([sampleDoc(), sampleDoc()]), '2 documents');
  });
  it('quantities use Indian grouping and the unit decimals', () => {
    assert.equal(qtyText(1234567, 0), '12,34,567');
    assert.equal(qtyText(12.5, 3), '12.500');
    assert.equal(qtyText(null, 2), '');
  });
});

/** The document as a print layout lays it out (hide these parts, replace these texts). */
function laidOut(doc = sampleDoc(), hide: PrintPartId[] = [], text: Array<{ id: PrintTextId; value: string }> = []) {
  return applyPrintLayout(doc, resolvePrintLayout({ hide, show: [], text }));
}

describe('(2.0) print layouts: columns, totals and header references', () => {
  it('an empty layout changes no column, row or reference', () => {
    for (const doc of [sampleDoc(), sampleDoc({ options: { ...sampleDoc().options, itemwiseTax: true } }), sampleDoc({ layout: 'inventory' })]) {
      const plain = laidOut(doc);
      assert.deepEqual(itemColumns(plain, { pageSize: 'A4', template: 'modern' }), itemColumns(doc, { pageSize: 'A4', template: 'modern' }));
      assert.deepEqual(totalRows(plain), totalRows(doc));
      assert.deepEqual(headerRefs(plain), headerRefs(doc));
    }
  });

  it('hidden columns are ANDed into the data-driven ones; a column never shows without data', () => {
    const cols = itemColumns(laidOut(sampleDoc(), ['col.hsn', 'col.discount', 'col.sno', 'col.unit', 'col.gstRate', 'col.batch']), { pageSize: 'A4', template: 'modern' });
    assert.deepEqual([cols.hsn, cols.discount, cols.sno, cols.unit, cols.gstRate], [false, false, false, false, false]);
    assert.deepEqual([cols.qty, cols.rate, cols.amount], [true, true, true], 'the others stay');
    // Showing a column with no data on the document prints nothing (no batch on these lines).
    assert.equal(itemColumns(laidOut(), { pageSize: 'A4', template: 'modern' }).batch, false);
    // Hiding the rate column of an unpriced stock document changes nothing (it had no data).
    const unpriced = sampleDoc({ layout: 'inventory', gst: { ...sampleDoc().gst, showTax: false }, lines: [line({ rate: 0, amount: 0, hsnSac: null })] });
    assert.equal(itemColumns(laidOut(unpriced, ['col.rate']), { pageSize: 'A4', template: 'modern' }).rate, false);
  });

  it('per-line tax columns: only on wide paper, only for heads present, each one can be hidden', () => {
    const doc = sampleDoc({ options: { ...sampleDoc().options, itemwiseTax: true } });
    const wide = itemColumns(doc, { pageSize: 'A4', template: 'modern' });
    assert.deepEqual(wide.lineHeads, { cgst: true, sgst: true, igst: false, cess: false });
    assert.deepEqual(itemColumns(laidOut(doc, ['col.sgst']), { pageSize: 'Letter', template: 'modern' }).lineHeads, { cgst: true, sgst: false, igst: false, cess: false });
    for (const narrow of ['A5', '80mm', '58mm'] as const) {
      const c = itemColumns(doc, { pageSize: narrow, template: 'modern' });
      assert.equal(c.lineTax, false, narrow);
      assert.deepEqual(c.lineHeads, { cgst: false, sgst: false, igst: false, cess: false }, narrow);
    }
    assert.equal(itemColumns(doc, { pageSize: 'A4', template: 'compact' }).lineTax, false, 'never on the receipt');
    const taxableHidden = itemColumns(laidOut(doc, ['col.taxable']), { pageSize: 'A4', template: 'modern' });
    assert.deepEqual([taxableHidden.taxable, taxableHidden.amount], [false, true]);
  });

  it('totals rows: hidden rows are filtered, the grand total is locked, amounts untouched', () => {
    const doc = sampleDoc({ charges: [{ name: 'TCS', amount: 100 }], totals: { ...sampleDoc().totals, charges: 100, grandTotal: 84500 } });
    const all = totalRows(doc);
    assert.deepEqual(
      all.map((r) => r.part),
      ['totals.taxable', 'totals.taxHeads', 'totals.taxHeads', 'totals.charges', 'totals.roundOff', 'totals.grand'],
    );
    const filtered = totalRows(laidOut(doc, ['totals.taxable', 'totals.taxHeads', 'totals.charges', 'totals.roundOff', 'totals.grand']));
    assert.deepEqual(filtered.map((r) => [r.label, r.amount]), [['Total', 84500]], 'only the (locked) grand total is left, with its amount');
    assert.deepEqual(totalRows(laidOut(doc, ['totals.roundOff'])).map((r) => r.label), ['Taxable Value', 'CGST', 'SGST', 'TCS', 'Total']);
  });

  it('header references carry their part; hidden DTO parts drop out', () => {
    const doc = sampleDoc({
      referenceNo: 'PO-9',
      ewayBill: { number: '321009876543', date: null, validUpto: null },
      references: [{ label: 'Vehicle No.', value: 'MH12AB1234' }],
    });
    assert.deepEqual(
      headerRefsWithParts(doc).map((r) => [r.label, r.part ?? null]),
      [
        ['Invoice No.', 'doc.number'],
        ['Dated', 'doc.date'],
        ['Reference No.', 'refs'],
        ['Place of Supply', 'placeOfSupply'],
        ['Reverse Charge', null],
        ['e-Way Bill No.', 'ewayBill'],
        ['Vehicle No.', 'refs'],
      ],
    );
    assert.deepEqual(headerRefs(laidOut(doc, ['refs', 'ewayBill', 'placeOfSupply', 'doc.number'])).map((r) => r.label), ['Invoice No.', 'Dated', 'Reverse Charge'], 'the number is locked');
  });

  it('receipt line info honours hidden HSN and GST rate', () => {
    assert.equal(compactLineInfo(line(), true, { hsn: false }), 'GST 5%');
    assert.equal(compactLineInfo(line(), true, { gstRate: false }), 'HSN 1006');
    assert.equal(compactLineInfo(line(), true, { hsn: true, gstRate: true }), 'HSN 1006 · GST 5%');
  });
});
