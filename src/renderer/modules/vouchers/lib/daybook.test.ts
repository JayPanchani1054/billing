import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { GstLineView, InstrumentType, PreviewInventoryLine, VoucherDetail, VoucherDetailEntry, VoucherListRow } from '../../../../shared/types/vouchers.ts';
import {
  baseTypesOf,
  DAYBOOK_CHIPS,
  dayBookDates,
  dayBookEmpty,
  dayBookExportRows,
  dayBookExportTotals,
  dayBookTotals,
  entryDetailLine,
  hiddenItemColumns,
  isWholePeriod,
  keyAfterRemoval,
  lineDescription,
  openTarget,
  partyLine,
  referenceLine,
  SEARCH_MAX,
  searchText,
  toDayBookRow,
  toggleChip,
  typesLabel,
  viewEntryRows,
  viewSections,
  viewStateWords,
  viewTotals,
  voucherCount,
} from './daybook.ts';
import { dayBookSide, defaultTypeFor, partyRequired, singleEntryAccountSide, trackingKinds } from './kinds.ts';

const row = (over: Partial<VoucherListRow>): VoucherListRow => ({
  id: 1,
  date: '2026-10-05',
  number: '1',
  voucherTypeId: 1,
  voucherTypeName: 'Sales',
  baseType: 'sales',
  partyLedgerId: 3,
  partyName: 'Sharma & Sons',
  narration: null,
  amount: 1180000,
  taxable: 1000000,
  tax: 180000,
  referenceNo: null,
  gstNature: 'b2b',
  isOptional: false,
  isCancelled: false,
  isPostDated: false,
  irnStatus: null,
  ...over,
});

describe('day book rows', () => {
  it('sales in Debit, purchase / receipt in Credit, payment in Debit', () => {
    assert.equal(toDayBookRow(row({})).debit, 1180000);
    assert.equal(toDayBookRow(row({ baseType: 'purchase' })).credit, 1180000);
    assert.equal(toDayBookRow(row({ baseType: 'receipt' })).credit, 1180000);
    assert.equal(toDayBookRow(row({ baseType: 'payment' })).debit, 1180000);
    assert.equal(dayBookSide('receipt_note'), 'cr');
    assert.equal(dayBookSide('delivery_note'), 'dr');
  });

  it('cancelled: no amount, flagged; totals skip optional and cancelled', () => {
    const rows = [
      toDayBookRow(row({})),
      toDayBookRow(row({ id: 2, isCancelled: true })),
      toDayBookRow(row({ id: 3, isOptional: true, baseType: 'purchase' })),
      toDayBookRow(row({ id: 4, baseType: 'receipt', amount: 500000, partyName: null, narration: 'Cash deposit' })),
    ];
    assert.deepEqual(rows[1].flags, ['Cancelled']);
    assert.equal(rows[1].debit, 0);
    assert.equal(rows[3].particulars, 'Cash deposit');
    // 11,800.00 Dr; 5,000.00 Cr (the optional purchase is left out)
    assert.deepEqual(dayBookTotals(rows), { debit: 1180000, credit: 500000 });
    assert.deepEqual(dayBookExportRows(rows)[1], ['2026-10-05', 'Sharma & Sons (Cancelled)', 'Sales', '1', null, null]);
  });

  it('chips → base types', () => {
    assert.equal(baseTypesOf([]), undefined);
    assert.deepEqual(baseTypesOf(['notes', 'sales']), ['sales', 'credit_note', 'debit_note']);
    assert.deepEqual(toggleChip(['a'], 'a'), []);
    assert.deepEqual(toggleChip(['a'], 'b'), ['a', 'b']);
  });
});

describe('voucher kinds', () => {
  it('party, single-entry side, tracking documents', () => {
    assert.equal(partyRequired('sales', 'ledger'), false);
    assert.equal(partyRequired('sales', 'item_invoice'), true);
    assert.equal(partyRequired('delivery_note', 'inventory'), true);
    assert.equal(partyRequired('stock_journal', 'inventory'), false);
    assert.equal(singleEntryAccountSide('payment'), 'cr');
    assert.equal(singleEntryAccountSide('receipt'), 'dr');
    assert.equal(singleEntryAccountSide('journal'), null);
    assert.deepEqual(trackingKinds('sales', { trackingNumbers: true, orderProcessing: true }), ['delivery', 'sales_order']);
    assert.deepEqual(trackingKinds('sales', { trackingNumbers: false, orderProcessing: false }), []);
  });

  it('default voucher type: active predefined first', () => {
    const types = [
      { id: 1, baseType: 'sales' as const, isActive: false, isPredefined: true },
      { id: 2, baseType: 'sales' as const, isActive: true, isPredefined: false },
      { id: 3, baseType: 'sales' as const, isActive: true, isPredefined: true },
    ];
    assert.equal(defaultTypeFor(types, 'sales')?.id, 3);
    assert.equal(defaultTypeFor(types.slice(0, 2), 'sales')?.id, 2);
    assert.equal(defaultTypeFor(types, 'payment'), null);
  });
});

describe('opening, deleting and exporting from a register', () => {
  it('Enter alters; cancelled vouchers, generated e-invoices and read-only users get the view', () => {
    const live = toDayBookRow(row({}));
    assert.equal(live.irnGenerated, false);
    assert.equal(openTarget(live, true), 'vouchers.entry');
    assert.equal(openTarget(live, false), 'vouchers.view');
    assert.equal(openTarget(toDayBookRow(row({ isCancelled: true })), true), 'vouchers.view');
    const irn = toDayBookRow(row({ irnStatus: 'generated' }));
    assert.equal(irn.irnGenerated, true);
    assert.equal(openTarget(irn, true), 'vouchers.view');
    assert.equal(openTarget(toDayBookRow(row({ irnStatus: 'pending' })), true), 'vouchers.entry');
  });

  it('after a delete the next row is highlighted (else the previous one)', () => {
    const rows = [1, 2, 3].map((id) => toDayBookRow(row({ id })));
    assert.equal(keyAfterRemoval(rows, 2), '3');
    assert.equal(keyAfterRemoval(rows, 3), '2');
    assert.equal(keyAfterRemoval(rows.slice(0, 1), 1), null);
    assert.equal(keyAfterRemoval(rows, 99), null);
  });

  it('export totals skip optional and cancelled vouchers, like the screen', () => {
    const rows = [
      row({ id: 1, amount: 1180000 }), // sales → Debit 11,800.00
      row({ id: 2, baseType: 'receipt', voucherTypeName: 'Receipt', amount: 500000 }), // receipt → Credit 5,000.00
      row({ id: 3, amount: 99900, isOptional: true }), // not counted
      row({ id: 4, amount: 77700, isCancelled: true }), // not counted (and shown blank)
    ].map(toDayBookRow);
    assert.deepEqual(dayBookExportTotals(rows), ['', 'Total (optional and cancelled vouchers not counted)', '', '', 1180000, 500000]);
  });

  it('search text is trimmed and capped at the route limit (100 characters)', () => {
    assert.equal(searchText('  INV/42  '), 'INV/42');
    assert.equal(searchText('x'.repeat(150)).length, SEARCH_MAX);
    assert.equal(SEARCH_MAX, 100);
  });
});

describe('Day Book 2.1: one date for one day, From – To only for a range', () => {
  const day = { from: '2026-10-10', to: '2026-10-10' };
  const range = { from: '2026-10-01', to: '2026-10-10' };

  it('one day shows one date; a range (or a range asked for with Alt+F2 / Date range…) shows From and To', () => {
    assert.equal(dayBookDates(day, false), 'single');
    assert.equal(dayBookDates(range, false), 'range');
    assert.equal(dayBookDates(day, true), 'range', 'Alt+F2 / More › Date range… opens the To date even on one day');
    assert.equal(dayBookDates(range, true), 'range');
  });

  it('"Whole period" is checked only when the range is exactly the period', () => {
    const period = { from: '2026-04-01', to: '2026-10-10' };
    assert.equal(isWholePeriod(period, period), true);
    assert.equal(isWholePeriod(range, period), false);
    assert.equal(isWholePeriod({ from: '2026-04-01', to: '2026-10-09' }, period), false);
  });

  it('the voucher-types menu button says what it filters', () => {
    assert.equal(typesLabel([]), 'All vouchers');
    assert.equal(typesLabel(['receipt', 'sales']), 'Sales, Receipt', 'in menu order, not click order');
    assert.equal(typesLabel(['sales']), 'Sales');
    assert.equal(typesLabel(['sales', 'receipt', 'journal']), '3 types');
    assert.equal(typesLabel(['orders'], DAYBOOK_CHIPS.filter((c) => c.id !== 'orders')), 'All vouchers', 'a type whose feature is off is not counted');
    assert.equal(typesLabel(['nope']), 'All vouchers');
  });

  it('the count in words', () => {
    assert.equal(voucherCount(0), '0 vouchers');
    assert.equal(voucherCount(1), '1 voucher');
    assert.equal(voucherCount(6), '6 vouchers');
    assert.equal(voucherCount(123456), '1,23,456 vouchers');
  });

  it('empty: one line and at most one link', () => {
    assert.deepEqual(dayBookEmpty({ filtered: false, range: day, wholePeriod: false }), { title: 'No vouchers on 10-Oct-26', link: 'whole' });
    assert.deepEqual(dayBookEmpty({ filtered: false, range, wholePeriod: false }), { title: 'No vouchers in this period', link: 'whole' });
    assert.deepEqual(dayBookEmpty({ filtered: false, range, wholePeriod: true }), { title: 'No vouchers in this period', link: null });
    assert.deepEqual(dayBookEmpty({ filtered: true, range: day, wholePeriod: false }), { title: 'No vouchers match', link: 'clear' });
  });
});

// ─────────────── Voucher view ───────────────

const inv = (over: Partial<PreviewInventoryLine>): PreviewInventoryLine => ({
  lineNo: 1,
  itemId: 1,
  itemName: 'Brass Hinge 4in',
  unit: 'Nos',
  godownId: 1,
  godownName: 'Main Location',
  batchName: null,
  qty: -100,
  billedQty: null,
  rate: 14500,
  discountPct: 0,
  amount: 1450000,
  ledgerId: 5,
  affectsStock: true,
  trackingRef: null,
  orderRef: null,
  isConsumption: false,
  hsnSac: '8302',
  gstRate: 18,
  ...over,
});

const gl = (over: Partial<GstLineView>): GstLineView => ({
  lineNo: 1,
  source: 'item',
  itemId: 1,
  ledgerId: null,
  description: null,
  hsnSac: '8302',
  uqc: 'NOS',
  qty: 100,
  supplyType: 'goods',
  taxability: 'taxable',
  rate: 18,
  cessRate: 0,
  taxableValue: 1450000,
  igst: 0,
  cgst: 130500,
  sgst: 130500,
  cess: 0,
  isReverseCharge: false,
  itcEligibility: null,
  ...over,
});

/** The counted rows (not the Total, not the muted tax the party is not paid). */
const sumBut = (rows: ReturnType<typeof viewTotals>) => rows.filter((r) => !r.grand && !r.muted).reduce((s, r) => s + r.amount, 0);

describe('voucher view: the document (SPEC-21 §1.5)', () => {
  it('context: the date, then state words only; Cancelled is the one danger word', () => {
    const base = { isCancelled: false, isOptional: false, isPostDated: false, affectsBooks: true, irn: { irn: null, ackNo: null, ackDate: null, signedQr: null, status: null } };
    assert.deepEqual(viewStateWords(base), { danger: null, words: [] });
    assert.deepEqual(viewStateWords({ ...base, isOptional: true, affectsBooks: false }), { danger: null, words: ['Optional'] });
    assert.deepEqual(viewStateWords({ ...base, isPostDated: true, affectsBooks: false }), { danger: null, words: ['Post-dated', 'Not in the books'] });
    assert.deepEqual(viewStateWords({ ...base, isCancelled: true, affectsBooks: false }), { danger: 'Cancelled', words: [] });
    assert.deepEqual(viewStateWords({ ...base, irn: { ...base.irn, status: 'generated' } }), { danger: null, words: ['e-Invoice generated'] });
  });

  it('party and references: one line each', () => {
    const party = { name: 'Asha Retail', address: null, stateCode: '27', gstin: '27AAAPA0002A1Z5', registrationType: null, pincode: null };
    assert.equal(partyLine({ party, partyLedgerName: 'Asha Retail' }), 'Asha Retail · GSTIN 27AAAPA0002A1Z5');
    assert.equal(partyLine({ party: { ...party, name: null, gstin: null }, partyLedgerName: 'Kumar Builders' }), 'Kumar Builders');
    assert.equal(partyLine({ party: { ...party, name: null }, partyLedgerName: null }), '');
    const refs = { referenceNo: 'PO-551', referenceDate: '2026-10-08', originalInvoiceNo: null, originalInvoiceDate: null, ewayBill: { number: '3410', date: null, validUpto: null }, isReverseCharge: false };
    assert.equal(referenceLine(refs), 'Ref. PO-551 dt 8-Oct-26 · e-Way Bill 3410');
    assert.equal(referenceLine({ ...refs, referenceNo: null, ewayBill: { number: null, date: null, validUpto: null }, originalInvoiceNo: 'INV-12', originalInvoiceDate: '2026-10-02', isReverseCharge: true }), 'Against INV-12 dt 2-Oct-26 · Reverse charge');
    assert.equal(referenceLine({ ...refs, referenceNo: null, ewayBill: { number: null, date: null, validUpto: null } }), '');
  });

  it('sections: entries by default without item lines, behind Detailed for invoices; focus on the items of an invoice', () => {
    const entries = [{}] as VoucherDetail['entries'];
    const invoice = { mode: 'item_invoice' as const, inventory: [inv({})], entries, gstLines: [gl({})], isCancelled: false };
    assert.deepEqual(viewSections(invoice, false), { entries: false, gst: false, totals: true, focus: 'items' });
    assert.deepEqual(viewSections(invoice, true), { entries: true, gst: true, totals: true, focus: 'items' });
    const receipt = { mode: 'ledger' as const, inventory: [], entries, gstLines: [], isCancelled: false };
    assert.deepEqual(viewSections(receipt, false), { entries: true, gst: false, totals: false, focus: 'entries' });
    assert.deepEqual(viewSections({ ...invoice, isCancelled: true }, false).totals, false, 'a cancelled invoice carries no amount');
    assert.deepEqual(viewSections({ ...receipt, entries: [] }, false), { entries: false, gst: false, totals: false, focus: null });
  });

  it('empty item columns hide: one godown, no discount, one GST rate; HSN only in Detailed', () => {
    const one = [inv({}), inv({ lineNo: 2, itemName: 'Door Handle Set' })];
    assert.deepEqual(hiddenItemColumns(one, false), ['godownName', 'discountPct', 'hsnSac', 'gstRate']);
    assert.deepEqual(hiddenItemColumns(one, true), ['discountPct'], 'Detailed shows the godown, HSN and GST % that print');
    const mixed = [inv({}), inv({ lineNo: 2, godownName: 'Shop', discountPct: 5, gstRate: 12 })];
    assert.deepEqual(hiddenItemColumns(mixed, false), ['hsnSac']);
    assert.deepEqual(hiddenItemColumns(mixed, true), []);
    assert.deepEqual(hiddenItemColumns([inv({ hsnSac: null, gstRate: null })], true), ['discountPct', 'hsnSac', 'gstRate']);
  });

  it('totals block: Taxable · CGST 9% · SGST 9% · Total ₹ — the rows add up to the voucher amount', () => {
    const rows = viewTotals({ totals: { amount: 2714000, taxable: 2300000, roundOff: 0 }, gstLines: [gl({ taxableValue: 2300000, cgst: 207000, sgst: 207000 })], inventory: [] });
    assert.deepEqual(
      rows.map((r) => [r.label, r.amount]),
      [
        ['Taxable', 2300000],
        ['CGST 9%', 207000],
        ['SGST 9%', 207000],
        ['Total ₹', 2714000],
      ],
    );
    assert.equal(sumBut(rows), rows[rows.length - 1].amount);
  });

  it('totals block: IGST, several rates (no rate in the label), charges and round off still add up', () => {
    const lines = [gl({ taxableValue: 100000, cgst: 0, sgst: 0, igst: 18000 }), gl({ lineNo: 2, rate: 12, taxableValue: 50000, cgst: 0, sgst: 0, igst: 6000, cess: 500 })];
    const rows = viewTotals({ totals: { amount: 180000, taxable: 150000, roundOff: -50 }, gstLines: lines, inventory: [] });
    assert.deepEqual(
      rows.map((r) => [r.key, r.label, r.amount]),
      [
        ['base', 'Taxable', 150000],
        ['igst', 'IGST', 24000],
        ['cess', 'Cess', 500],
        ['other', 'Other charges', 5550],
        ['roundOff', 'Round off', -50],
        ['total', 'Total ₹', 180000],
      ],
    );
    assert.equal(sumBut(rows), 180000);
  });

  it('totals block without GST: the items, then the total', () => {
    const rows = viewTotals({ totals: { amount: 1000000, taxable: 0, roundOff: 0 }, gstLines: [], inventory: [inv({ amount: 600000 }), inv({ lineNo: 2, amount: 400000 }), inv({ lineNo: 3, amount: 999, isConsumption: true })] });
    assert.deepEqual(rows.map((r) => [r.label, r.amount]), [['Value', 1000000], ['Total ₹', 1000000]]);
    assert.equal(sumBut(rows), 1000000);
  });

  it('totals block: reverse-charge tax is one muted row outside the Total (no bogus negative charge)', () => {
    // A purchase under reverse charge: 10,000 + 18 % — the supplier is paid 10,000; the 1,800 is the buyer's to pay.
    const rows = viewTotals({ totals: { amount: 1000000, taxable: 1000000, roundOff: 0 }, gstLines: [gl({ taxableValue: 1000000, cgst: 90000, sgst: 90000, isReverseCharge: true })], inventory: [] });
    assert.deepEqual(
      rows.map((r) => [r.key, r.label, r.amount, r.muted === true]),
      [
        ['base', 'Taxable', 1000000, false],
        ['reverse', 'Reverse charge tax', 180000, true],
        ['total', 'Total ₹', 1000000, false],
      ],
    );
    assert.equal(sumBut(rows), 1000000);
    assert.ok(!rows.some((r) => r.key === 'other'), 'the reverse-charge tax is not a "charge" of −1,800');
  });

  it('totals block: a mixed invoice keeps the paid heads in the Total and the reverse-charge tax outside', () => {
    const lines = [gl({ taxableValue: 100000, cgst: 9000, sgst: 9000 }), gl({ lineNo: 2, rate: 5, taxableValue: 40000, cgst: 1000, sgst: 1000, isReverseCharge: true })];
    const rows = viewTotals({ totals: { amount: 158000, taxable: 140000, roundOff: 0 }, gstLines: lines, inventory: [] });
    assert.deepEqual(
      rows.map((r) => [r.label, r.amount]),
      [
        ['Taxable', 140000],
        ['CGST 9%', 9000],
        ['SGST 9%', 9000],
        ['Reverse charge tax', 2000],
        ['Total ₹', 158000],
      ],
      'the rate of the paid lines labels the heads',
    );
    assert.equal(sumBut(rows), 158000);
  });

  it('totals block: IGST on an import paid at customs stays outside the Total', () => {
    const rows = viewTotals({ totals: { amount: 500000, taxable: 500000, roundOff: 0 }, gstLines: [gl({ taxableValue: 500000, cgst: 0, sgst: 0, igst: 90000 })], inventory: [] });
    assert.deepEqual(
      rows.map((r) => [r.key, r.label, r.amount, r.muted === true]),
      [
        ['base', 'Taxable', 500000, false],
        ['customs', 'Tax paid at customs', 90000, true],
        ['total', 'Total ₹', 500000, false],
      ],
    );
    assert.equal(sumBut(rows), 500000);
  });

  it('totals block: CGST + UTGST in a union territory without a legislature (Chandigarh), SGST elsewhere', () => {
    const v = { totals: { amount: 118000, taxable: 100000, roundOff: 0 }, gstLines: [gl({ taxableValue: 100000, cgst: 9000, sgst: 9000 })], inventory: [] };
    assert.deepEqual(viewTotals({ ...v, placeOfSupply: '04' }).map((r) => r.label), ['Taxable', 'CGST 9%', 'UTGST 9%', 'Total ₹']);
    assert.deepEqual(viewTotals({ ...v, placeOfSupply: '07' }).map((r) => r.label), ['Taxable', 'CGST 9%', 'SGST 9%', 'Total ₹'], 'Delhi has a legislature: SGST');
  });
});

// ─────────────── Voucher view 2.2: line descriptions ───────────────

/** The instrument names voucher entry gives (entry/dialogs.tsx INSTRUMENT_LABEL, a .tsx file node cannot load). */
const INSTRUMENTS: Readonly<Record<InstrumentType, string>> = { cheque: 'Cheque', dd: 'Demand draft', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', card: 'Card', cash: 'Cash', other: 'Other' };

const entry = (over: Partial<VoucherDetailEntry>): VoucherDetailEntry => ({
  id: 7,
  lineNo: 1,
  ledgerId: 12,
  ledgerName: 'Rent',
  amount: 2500000,
  role: 'other',
  gstDutyHead: null,
  narration: null,
  instrument: null,
  bankDate: null,
  billAllocations: [],
  costAllocations: [],
  ...over,
});

describe("voucher view 2.2: a line's own description under its name", () => {
  it('as typed: trimmed, its line breaks kept (CR LF and CR read as LF); nothing when blank', () => {
    assert.equal(lineDescription('  Brass, 4 inch\r\nantique finish\rpack of 2  '), 'Brass, 4 inch\nantique finish\npack of 2');
    for (const blank of ['', '   ', '\n \n', null, undefined]) assert.equal(lineDescription(blank), null, JSON.stringify(blank));
  });

  it('item lines: the description typed on this voucher; nothing when the line has none or the core leaves the field out', () => {
    assert.equal(lineDescription(inv({ description: 'For site 4, Pune\nDeliver by 12-Oct' }).description), 'For site 4, Pune\nDeliver by 12-Oct');
    assert.equal(lineDescription(inv({ description: null }).description), null);
    assert.equal('description' in inv({}), false, 'the fixture is a line from a core that does not send the field');
    assert.equal(lineDescription(inv({}).description), null);
  });

  it('Dr / Cr lines: the narration is the line description, on a line of its own — never inside the details line', () => {
    const rent = entry({
      narration: '  October rent, shop 4\nincl. maintenance ',
      billAllocations: [{ refType: 'new', billName: 'R-10', amount: 2500000, creditDays: 10, dueDate: '2026-10-15' }],
      costAllocations: [{ costCentreId: 1, costCentreName: 'Shop 4', amount: 2500000 }],
    });
    const bank = entry({
      id: 8,
      lineNo: 2,
      ledgerName: 'HDFC Bank',
      amount: -2500000,
      role: 'cash_bank',
      instrument: { type: 'cheque', number: '000123', date: '2026-10-05', bankName: 'HDFC', favouring: 'Kumar Estates' },
      bankDate: '2026-10-07',
    });
    assert.deepEqual(viewEntryRows([rent, bank], INSTRUMENTS), [
      { key: '7', name: 'Rent', description: 'October rent, shop 4\nincl. maintenance', detail: 'New Ref R-10 ₹ 25,000.00 (due 15-Oct-26) · Shop 4 ₹ 25,000.00', debit: 2500000, credit: 0 },
      { key: '8', name: 'HDFC Bank', description: null, detail: 'Cheque 000123 5-Oct-26 HDFC favouring Kumar Estates · Cleared in bank on 7-Oct-26', debit: 0, credit: 2500000 },
    ]);
    assert.equal(entryDetailLine(rent, INSTRUMENTS).includes('October rent'), false);
  });

  it("a hook's narration (TDS) is its line's description; a line with neither shows its name alone", () => {
    const rows = viewEntryRows([entry({ ledgerName: 'TDS on Contracts', amount: -50000, narration: 'TDS u/s 194C @ 1% on ₹ 50,000.00' }), entry({ id: 9, ledgerName: 'Round Off', amount: 0, narration: ' ' })], INSTRUMENTS);
    assert.deepEqual([rows[0].description, rows[0].detail, rows[0].credit], ['TDS u/s 194C @ 1% on ₹ 50,000.00', '', 50000]);
    assert.deepEqual([rows[1].description, rows[1].detail, rows[1].debit, rows[1].credit], [null, '', 0, 0]);
  });

  it('the view renders it as React text on a muted line of its own (pre-line, long words wrap), in normal and Detailed views', () => {
    const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
    const view = read('../VoucherViewScreen.tsx');
    assert.match(view, /const description = lineDescription\(r\.description\);/, 'the item column (every view, every voucher with item lines)');
    assert.match(view, /\{description \? <div className="bx-muted bx-vch-view__desc">\{description\}<\/div> : null\}/);
    assert.match(view, /\{r\.description \? <div className="bx-muted bx-vch-view__desc">\{r\.description\}<\/div> : null\}/, 'the Particulars column');
    assert.match(view, /viewEntryRows\(v\?\.entries \?\? \[\], INSTRUMENT_LABEL\)/);
    assert.doesNotMatch(view, /dangerouslySetInnerHTML/);
    const css = read('../vouchers-view.css');
    const rule = /\.bx-vch-view__desc \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const decl of ['font-size: var(--text-caption);', 'white-space: pre-line;', 'overflow-wrap: anywhere;']) assert.ok(rule.includes(decl), decl);
    assert.match(css, /\.bx-vch-view__row--multiline > td \{[^}]*vertical-align: top;/, 'the amounts stay on the name line of a taller row');
  });
});
