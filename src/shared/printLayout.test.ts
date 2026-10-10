/**
 * (2.0) Print layout model: catalogue (docs/ARCHITECTURE.md › Print layouts (2.0)), resolution, application, validation and the
 * statutory guard. Fixtures: the renderer's hand-made print DTO (src/renderer/modules/print/lib/fixtures.ts,
 * node-importable data) plus variants built from it here (voucher, inventory, credit note, a document with
 * every optional block filled in).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { line, sampleDoc } from '../renderer/modules/print/lib/fixtures.ts';
import {
  applyPrintLayout,
  EMPTY_PRINT_LAYOUT,
  emptyPrintLayout,
  isEmptyPrintLayout,
  isPartShown,
  LAYOUT_RULES,
  layoutSource,
  layoutWarnings,
  legacyKeyAt,
  partsForLayout,
  PRINT_LAYOUT_MAX_ENTRIES,
  PRINT_PARTS,
  PRINT_TEXTS,
  printPart,
  printText,
  printTextDef,
  resolvePrintLayout,
  shadowedByLegacy,
  validatePrintLayout,
  type PrintLayoutSpec,
  type PrintPartDef,
  type PrintPartId,
  type PrintTextDef,
  type PrintTextId,
  type ResolvedPrintLayout,
} from './printLayout.ts';
import { DEFAULT_CONFIG } from './settings.ts';
import type { PrintForex } from './types/forex.ts';
import type { PrintPos } from './types/pos.ts';
import type { PrintVoucherData } from './types/print.ts';

const spec = (o: Partial<PrintLayoutSpec> = {}): PrintLayoutSpec => ({ hide: [], show: [], text: [], ...o });
const hiding = (...ids: PrintPartId[]): ResolvedPrintLayout => resolvePrintLayout(spec({ hide: ids }));

// ───────────────────────────── Fixtures ─────────────────────────────

const FOREX: PrintForex = {
  currency: { symbol: '$', isoCode: 'USD', formalName: 'US Dollar', decimalPlaces: 2 },
  rate: 83,
  lines: [{ rate: 0.6, amount: 6.02 }],
  charges: [],
  tax: 0,
  total: 10.17,
  totalInWords: 'US Dollar Ten and Seventeen Cents Only',
  note: 'Amounts in US Dollar at ₹83.00',
  entries: [],
};
const POS: PrintPos = { kind: 'sale', tenders: [{ label: 'Cash', amount: 84400 }], paid: 84400, credit: 0, cashTendered: 100000, change: 15600, counter: 'C1', cashier: 'Asha' };

/** Every optional block filled in: separate ship-to in another state, IRN, e-way bill, references, payment. */
function fullDoc(): PrintVoucherData {
  const d = sampleDoc();
  return sampleDoc({
    company: { ...d.company, logo: 'data:image/png;base64,AAAA', cin: 'U51909MH2020PTC123456', email: 'a@b.in', website: 'https://example.in' },
    party: { ...(d.party as NonNullable<PrintVoucherData['party']>), phone: '9876543210', email: 'buyer@example.in' },
    consignee: {
      name: 'Acme Warehouse',
      address: 'Plot 9, Hosur Road',
      pincode: '560068',
      stateCode: '29',
      stateName: 'Karnataka',
      country: 'India',
      gstin: '29AAAPA0001A1Z2',
      pan: 'AAAPA0001A',
      registrationType: 'regular',
      phone: '080 1234',
      email: null,
    },
    consigneeSameAsParty: false,
    placeOfSupply: { code: '29', name: 'Karnataka', label: '29-Karnataka' },
    gst: { ...d.gst, interState: true, taxMode: 'igst' },
    endorsement: 'Supply meant for export under LUT',
    notes: ['Tax on this supply is payable by the recipient under reverse charge'],
    reverseCharge: true,
    references: [{ label: "Buyer's Order No.", value: 'PO-77' }],
    referenceNo: 'PO-77',
    referenceDate: '2026-04-10',
    einvoice: { irn: 'a'.repeat(64), ackNo: '1123', ackDate: '2026-04-15', signedQr: 'QRDATA' },
    ewayBill: { number: '331000000001', date: '2026-04-15', validUpto: '2026-04-16' },
    bank: { ledgerId: 9, ledgerName: 'HDFC Bank', accountHolder: 'Test Traders', accountNo: '50100012345678', ifsc: 'HDFC0000001', bankName: 'HDFC Bank', branch: 'Fort', upiId: 'shop@okhdfcbank' },
    upi: { id: 'shop@okhdfcbank', payeeName: 'Test Traders', amount: 84400, note: 'Tax Invoice INV/12', uri: 'upi://pay?pa=shop@okhdfcbank' },
    narration: 'Goods sent by road',
    terms: 'Payment within 30 days',
    forex: FOREX,
    pos: POS,
    mrpSummary: { show: true, mrpValue: 90000, savings: 5600 },
    taxByRate: [{ taxability: 'taxable', rate: 5, cessRate: 0, reverseCharge: false, taxableValue: 50000, cgst: 0, sgst: 0, igst: 2500, cess: 0, tax: 2500 }],
    taxByHsn: [{ hsnSac: '1006', description: null, qty: 10, unit: 'Nos', rate: 5, taxableValue: 50000, cgst: 0, sgst: 0, igst: 2500, cess: 0, tax: 2500 }],
    charges: [{ name: 'TCS', amount: 100 }],
  });
}

function voucherDoc(): PrintVoucherData {
  return sampleDoc({
    layout: 'voucher',
    kind: 'payment_voucher',
    baseType: 'payment',
    title: 'Payment Voucher',
    partyLabel: 'Paid to',
    consignee: null,
    consigneeSameAsParty: false,
    placeOfSupply: null,
    gst: { showTax: false, taxMode: 'none', interState: false, sgstLabel: 'SGST', nature: null },
    lines: [],
    entries: [
      { ledgerName: 'Office Rent', amount: 1000000, debit: 1000000, credit: 0, isCashBank: false, narration: 'April rent', instrument: null, bills: [], costCentres: [] },
      { ledgerName: 'HDFC Bank', amount: -1000000, debit: 0, credit: 1000000, isCashBank: true, narration: null, instrument: 'Cheque 000123', bills: [], costCentres: [] },
    ],
    narration: 'Rent for April',
    declaration: null,
  });
}

function challanDoc(): PrintVoucherData {
  const d = sampleDoc();
  return sampleDoc({
    layout: 'inventory',
    kind: 'delivery_challan',
    baseType: 'delivery_note',
    title: 'Delivery Challan',
    partyLabel: 'Consignee (Ship to)',
    consignee: d.party,
    consigneeSameAsParty: true,
    gst: { showTax: false, taxMode: 'none', interState: false, sgstLabel: 'SGST', nature: null },
    copyLabels: { original: 'Original for Consignee', duplicate: 'Duplicate for Transporter', triplicate: 'Triplicate for Consigner' },
    declaration: null,
  });
}

function creditNote(): PrintVoucherData {
  return sampleDoc({ kind: 'credit_note', baseType: 'credit_note', title: 'Credit Note', originalInvoice: { number: 'INV/9', date: '2026-04-01', reason: 'Goods returned' }, declaration: null });
}

const FIXTURES: Array<[string, () => PrintVoucherData]> = [
  ['tax invoice (fixtures.ts)', () => sampleDoc()],
  ['tax invoice, every block', fullDoc],
  ['payment voucher', voucherDoc],
  ['delivery challan', challanDoc],
  ['credit note', creditNote],
];

/** Money-carrying fields: applyPrintLayout passes them through by reference. */
const MONEY_FIELDS = ['lines', 'totals', 'charges', 'taxByRate', 'taxByHsn', 'entries', 'upi', 'mrpSummary', 'bank'] as const;

// ───────────────────────────── Catalogue ─────────────────────────────

describe('print layout catalogue (ids are persisted)', () => {
  it('parts: ids, groups, layouts, kinds, locks, legacy keys and statutory particulars', () => {
    const L = (p: PrintPartDef): string => (p.layouts.length === 3 ? 'all' : p.layouts.join('+'));
    const rows = (PRINT_PARTS as readonly PrintPartDef[]).map((p) =>
      [p.id, p.group, L(p), p.kind, p.locked ? 'locked' : '', p.legacy ? `${p.legacy.company ?? '-'}/${p.legacy.voucherType ?? '-'}` : '', p.statutory ?? ''].join(' | '),
    );
    assert.deepEqual(rows, [
      'logo | header | all | dto |  |  | ',
      'company.name | header | all | gate |  |  | supplier',
      'company.address | header | all | gate |  |  | supplier',
      'company.gstin | header | all | dto |  |  | supplier',
      'company.pan | header | all | dto |  |  | ',
      'company.cin | header | all | dto |  |  | ',
      'company.contact | header | all | dto |  |  | ',
      'title | header | all | gate |  |  | title',
      'copyLabel | header | invoice+inventory | gate |  |  | copies',
      'endorsement | header | invoice | dto |  |  | ',
      'statutoryNotes | header | invoice | dto |  |  | reverseCharge',
      'stamp | header | all | gate | locked |  | ',
      'doc.number | details | all | gate | locked |  | ',
      'doc.date | details | all | gate | locked |  | ',
      'refs | details | invoice+inventory | dto |  |  | ',
      'placeOfSupply | details | invoice+inventory | dto |  |  | placeOfSupply',
      'ewayBill | details | invoice+inventory | dto |  |  | ',
      'originalInvoice | details | invoice | dto |  |  | originalInvoice',
      'party | parties | all | gate |  |  | recipient',
      'party.gstin | parties | invoice+inventory | dto |  |  | recipientGstin',
      'party.contact | parties | all | dto |  |  | ',
      'consignee | parties | invoice+inventory | dto |  |  | delivery',
      'col.sno | columns | invoice+inventory | column |  |  | ',
      'col.description | columns | invoice+inventory | column | locked |  | ',
      'col.hsn | columns | invoice+inventory | column |  |  | hsn',
      'col.batch | columns | invoice+inventory | column |  |  | ',
      'col.qty | columns | invoice+inventory | column |  |  | quantity',
      'col.unit | columns | invoice+inventory | column |  |  | quantity',
      'col.mrp | columns | invoice+inventory | legacy |  | showMrp/showMrp | ',
      'col.rate | columns | invoice+inventory | column |  |  | ',
      'col.discount | columns | invoice+inventory | column |  |  | ',
      'col.taxable | columns | invoice | column |  |  | taxableValue',
      'col.gstRate | columns | invoice | column |  |  | tax',
      'lineTax | columns | invoice | legacy |  | itemwiseTax/itemwiseTax | ',
      'col.cgst | columns | invoice | column |  |  | tax',
      'col.sgst | columns | invoice | column |  |  | tax',
      'col.igst | columns | invoice | column |  |  | tax',
      'col.cess | columns | invoice | column |  |  | tax',
      'col.amount | columns | invoice+inventory | column |  |  | ',
      'totals.taxable | totals | invoice | total |  |  | taxableValue',
      'totals.taxHeads | totals | invoice | total |  |  | tax',
      'totals.charges | totals | invoice | total |  |  | ',
      'totals.roundOff | totals | invoice | total |  |  | ',
      'totals.grand | totals | invoice+voucher | total | locked |  | ',
      'mrpSaved | totals | invoice | gate |  |  | ',
      'amountInWords | totals | all | gate |  |  | ',
      'taxInWords | totals | invoice | gate |  |  | ',
      'hsnSummary | totals | invoice | legacy |  | showHsnSummary/showHsnSummary | hsn',
      'taxSummary | totals | invoice | gate |  |  | ',
      'bank | payment | invoice | legacy |  | showBankDetails/showBankDetails | ',
      'upiQr | payment | invoice | legacy |  | showUpiQr/showUpiQr | ',
      'forex | payment | invoice+voucher | dto |  |  | ',
      'pos | payment | invoice | dto |  |  | ',
      'einvoice | einvoice | invoice | dto |  |  | einvoice',
      'narration | footer | all | dto |  |  | ',
      'declaration | footer | invoice | dto |  |  | ',
      'terms | footer | invoice | dto |  |  | ',
      'notes | footer | all | gate |  |  | ',
      'signature | footer | all | gate |  |  | signature',
      'generatedLine | footer | all | gate |  |  | ',
      'footer | footer | all | gate |  |  | ',
      'pageNumbers | footer | all | page |  |  | ',
      'entries | voucher | voucher | gate | locked |  | ',
      'receivedBy | voucher | voucher | gate |  |  | ',
    ]);
  });

  it('texts: ids, limits, multi-line and legacy keys', () => {
    const rows = (PRINT_TEXTS as readonly PrintTextDef[]).map((t) =>
      [t.id, t.max, t.multiline ? 'multi' : '', t.legacy ? `${t.legacy.company ?? '-'}/${t.legacy.voucherType ?? '-'}` : ''].join(' | '),
    );
    assert.deepEqual(rows, [
      'title | 60 |  | -/printTitle',
      'copy.original | 40 |  | ',
      'copy.duplicate | 40 |  | ',
      'copy.triplicate | 40 |  | ',
      'label.party | 40 |  | ',
      'label.consignee | 40 |  | ',
      'col.description | 24 |  | ',
      'col.hsn | 24 |  | ',
      'col.qty | 24 |  | ',
      'col.rate | 24 |  | ',
      'col.discount | 24 |  | ',
      'col.taxable | 24 |  | ',
      'col.amount | 24 |  | ',
      'label.amountInWords | 40 |  | ',
      'label.total | 30 |  | ',
      'declaration | 2000 | multi | declaration/declaration',
      'terms | 4000 | multi | terms/terms',
      'notes | 1000 | multi | ',
      'signatoryLabel | 100 |  | signatoryLabel/-',
      'signFor | 120 |  | ',
      'footer | 200 | multi | ',
      'generatedLine | 120 |  | ',
    ]);
  });

  it('ids are unique; legacy company keys exist in Invoice Printing; every part has a label; statutory keys resolve', () => {
    const parts = PRINT_PARTS.map((p) => p.id);
    const texts = PRINT_TEXTS.map((t) => t.id);
    assert.equal(new Set(parts).size, parts.length);
    assert.equal(new Set(texts).size, texts.length);
    for (const d of [...PRINT_PARTS, ...PRINT_TEXTS] as Array<PrintPartDef | PrintTextDef>) {
      assert.ok(d.label.trim().length > 0, d.id);
      if (d.legacy?.company) assert.ok(d.legacy.company in DEFAULT_CONFIG.invoice, `${d.id}: config.invoice.${d.legacy.company}`);
    }
    for (const p of PRINT_PARTS as readonly PrintPartDef[]) {
      if (p.statutory) assert.ok(LAYOUT_RULES[p.statutory].rule.startsWith('Rule '), p.id);
      if (p.kind === 'legacy') assert.ok(p.legacy?.company && p.legacy.voucherType, `${p.id} has both option keys`);
    }
    assert.equal(printPart('col.hsn')?.label, 'HSN/SAC');
    assert.equal(printTextDef('terms')?.max, 4000);
    assert.equal(printPart('nope'), undefined);
  });

  it('partsForLayout lists the parts of one family', () => {
    const voucher = partsForLayout('voucher').map((p) => p.id);
    assert.ok(voucher.includes('entries') && voucher.includes('receivedBy') && voucher.includes('totals.grand'));
    assert.ok(!voucher.includes('col.hsn') && !voucher.includes('consignee'));
    const inventory = partsForLayout('inventory').map((p) => p.id);
    assert.ok(inventory.includes('col.qty') && !inventory.includes('col.taxable') && !inventory.includes('entries'));
  });

  it('legacyKeyAt: the per-print level is owned by the preview overrides (company keys)', () => {
    const title = printTextDef('title') as PrintTextDef;
    const sign = printTextDef('signatoryLabel') as PrintTextDef;
    assert.equal(legacyKeyAt(title, 'company'), undefined);
    assert.equal(legacyKeyAt(title, 'voucherType'), 'printTitle');
    assert.equal(legacyKeyAt(title, 'print'), undefined);
    assert.equal(legacyKeyAt(sign, 'voucherType'), undefined);
    assert.equal(legacyKeyAt(sign, 'print'), 'signatoryLabel');
  });

  it('EMPTY_PRINT_LAYOUT is frozen; emptyPrintLayout() is a fresh copy', () => {
    assert.ok(Object.isFrozen(EMPTY_PRINT_LAYOUT) && Object.isFrozen(EMPTY_PRINT_LAYOUT.hide));
    assert.throws(() => (EMPTY_PRINT_LAYOUT.hide as string[]).push('logo'));
    const e = emptyPrintLayout();
    e.hide.push('logo');
    assert.equal(EMPTY_PRINT_LAYOUT.hide.length, 0);
    assert.ok(isEmptyPrintLayout(EMPTY_PRINT_LAYOUT) && isEmptyPrintLayout(null) && !isEmptyPrintLayout(e));
    assert.deepEqual(DEFAULT_CONFIG.invoice.layout, { hide: [], show: [], text: [] });
  });
});

// ───────────────────────────── Resolution ─────────────────────────────

describe('resolvePrintLayout — company ‹ voucher type ‹ print', () => {
  it('a higher layer`s show undoes a lower hide; its hide re-hides', () => {
    const company = spec({ hide: ['logo', 'col.hsn', 'bank' as PrintPartId] });
    const vt = spec({ show: ['logo'], hide: ['col.batch'] });
    const print = spec({ show: ['col.hsn', 'col.batch'], hide: ['logo'] });
    assert.deepEqual([...resolvePrintLayout(company).hidden].sort(), ['bank', 'col.hsn', 'logo']);
    assert.deepEqual([...resolvePrintLayout(company, vt).hidden].sort(), ['bank', 'col.batch', 'col.hsn']);
    const all = resolvePrintLayout(company, vt, print);
    assert.deepEqual([...all.hidden].sort(), ['bank', 'logo']);
    assert.deepEqual([...(all.shown ?? [])].sort(), ['col.batch', 'col.hsn']);
  });

  it('within one layer hide wins over show; null / undefined layers are skipped', () => {
    const r = resolvePrintLayout(null, spec({ hide: ['logo'], show: ['logo'] }), undefined);
    assert.deepEqual([...r.hidden], ['logo']);
  });

  it('locked parts are never hidden, even from crafted layers', () => {
    const crafted = { hide: ['doc.number', 'doc.date', 'stamp', 'totals.grand', 'col.description', 'entries', 'logo'], show: [], text: [] } as unknown as PrintLayoutSpec;
    assert.deepEqual([...resolvePrintLayout(crafted).hidden], ['logo']);
  });

  it("texts: the highest layer wins; '' is a value (print nothing), an absent id inherits", () => {
    const company = spec({ text: [{ id: 'title', value: 'Invoice' }, { id: 'footer', value: 'Thank you' }] });
    const vt = spec({ text: [{ id: 'footer', value: '' }] });
    const r = resolvePrintLayout(company, vt);
    assert.equal(r.texts.get('title'), 'Invoice');
    assert.equal(r.texts.get('footer'), '');
    assert.equal(r.texts.has('notes'), false);
    assert.equal(resolvePrintLayout(company, vt, spec({ text: [{ id: 'footer', value: 'Visit again' }] })).texts.get('footer'), 'Visit again');
  });

  it('unknown ids, malformed entries and non-arrays are ignored (stale session layers never break printing)', () => {
    const junk = { hide: 'logo', show: [42, null], text: [null, { id: 'nope', value: 'x' }, { id: 'title', value: 7 }, { id: 'notes', value: 'ok' }] } as unknown as PrintLayoutSpec;
    const r = resolvePrintLayout(junk, { hide: ['logo', 'not-a-part'] } as unknown as PrintLayoutSpec);
    assert.deepEqual([...r.hidden], ['logo']);
    assert.deepEqual([...r.texts], [['notes', 'ok']]);
  });

  it('layoutSource names the level a part / text comes from', () => {
    const layers = { company: spec({ hide: ['logo'], text: [{ id: 'footer', value: 'a' }] }), voucherType: spec({ show: ['logo'] }), print: spec({ hide: ['col.hsn'] }) };
    assert.equal(layoutSource(layers, 'logo'), 'voucherType');
    assert.equal(layoutSource(layers, 'col.hsn'), 'print');
    assert.equal(layoutSource(layers, 'col.batch'), 'default');
    assert.equal(layoutSource(layers, 'footer', 'text'), 'company');
    assert.equal(layoutSource(layers, 'footer'), 'default', 'the footer part is untouched; only its text is set');
    assert.equal(layoutSource({}, 'title', 'text'), 'default');
  });
});

// ───────────────────────────── Application ─────────────────────────────

describe('applyPrintLayout', () => {
  for (const [name, make] of FIXTURES) {
    it(`${name}: every part, one at a time — doc never mutated, money passed through by reference`, () => {
      for (const p of PRINT_PARTS as readonly PrintPartDef[]) {
        const doc = make();
        const before = structuredClone(doc);
        const out = applyPrintLayout(doc, hiding(p.id as PrintPartId));
        assert.deepEqual(doc, before, `${p.id}: input untouched`);
        assert.notEqual(out, doc);
        for (const f of MONEY_FIELDS) assert.equal(out[f], doc[f], `${p.id}: ${f} by reference`);
        assert.equal(out.totals.grandTotal, doc.totals.grandTotal);
        assert.equal(out.amountInWords, doc.amountInWords);
        assert.equal(out.number, doc.number);
        assert.equal(out.date, doc.date);
        assert.equal(out.status, doc.status);
        assert.deepEqual(out.applied?.hidden, p.locked ? [] : [p.id], p.id);
        assert.equal(isPartShown(out, p.id as PrintPartId), !!p.locked);
      }
    });

    it(`${name}: an empty layout changes nothing but adds an empty 'applied'`, () => {
      const doc = make();
      const out = applyPrintLayout(doc, resolvePrintLayout(EMPTY_PRINT_LAYOUT));
      const { applied, ...rest } = out;
      assert.deepEqual(rest, doc);
      assert.deepEqual(applied, { hidden: [], texts: {} });
      for (const k of Object.keys(doc) as Array<keyof PrintVoucherData>) assert.equal(out[k], doc[k], `${k} same reference`);
    });
  }

  it('DTO parts null / empty their fields', () => {
    const doc = fullDoc();
    const cases: Array<[PrintPartId, (d: PrintVoucherData) => unknown, unknown]> = [
      ['logo', (d) => d.company.logo, null],
      ['company.cin', (d) => d.company.cin, null],
      ['company.contact', (d) => [d.company.phone, d.company.email, d.company.website], [null, null, null]],
      ['endorsement', (d) => d.endorsement, null],
      ['statutoryNotes', (d) => d.notes, []],
      ['refs', (d) => [d.references, d.referenceNo, d.referenceDate], [[], null, null]],
      ['placeOfSupply', (d) => d.placeOfSupply, null],
      ['ewayBill', (d) => d.ewayBill, null],
      ['originalInvoice', (d) => creditNoteApplied('originalInvoice').originalInvoice, null],
      ['party.contact', (d) => [d.party?.phone, d.party?.email, d.party?.name], [null, null, 'Acme Traders']],
      ['consignee', (d) => [d.consignee, d.consigneeSameAsParty], [null, false]],
      ['forex', (d) => d.forex, null],
      ['pos', (d) => d.pos, null],
      ['einvoice', (d) => d.einvoice, null],
      ['narration', (d) => d.narration, null],
      ['declaration', (d) => d.declaration, null],
      ['terms', (d) => d.terms, null],
    ];
    for (const [id, pick, want] of cases) assert.deepEqual(pick(applyPrintLayout(doc, hiding(id))), want, id);
    // Gates / columns / totals / page / legacy leave the DTO as it is (templates check `applied`).
    for (const id of ['company.name', 'title', 'col.hsn', 'totals.roundOff', 'pageNumbers', 'bank', 'signature'] as PrintPartId[]) {
      const { applied, ...rest } = applyPrintLayout(doc, hiding(id));
      assert.deepEqual(rest, doc, id);
      assert.deepEqual(applied?.hidden, [id]);
    }
  });

  it('company GSTIN hidden → its PAN goes too, unless a layer explicitly shows company.pan', () => {
    const doc = sampleDoc();
    const g = applyPrintLayout(doc, hiding('company.gstin'));
    assert.deepEqual([g.company.gstin, g.company.pan], [null, null]);
    const kept = applyPrintLayout(doc, resolvePrintLayout(spec({ hide: ['company.gstin'] }), spec({ show: ['company.pan'] })));
    assert.deepEqual([kept.company.gstin, kept.company.pan], [null, 'AAPFU0939F']);
    const panOnly = applyPrintLayout(doc, hiding('company.pan'));
    assert.deepEqual([panOnly.company.gstin, panOnly.company.pan], ['27AAPFU0939F1ZV', null]);
    // A show later hidden again does not keep the PAN.
    const rehidden = applyPrintLayout(doc, resolvePrintLayout(spec({ show: ['company.pan'] }), spec({ hide: ['company.gstin', 'company.pan'] })));
    assert.equal(rehidden.company.pan, null);
  });

  it("party GSTIN hidden → GSTIN, PAN and registration type cleared; a ship-to that IS the party follows; a separate one does not", () => {
    const same = sampleDoc({ consignee: sampleDoc().party, consigneeSameAsParty: true });
    const s = applyPrintLayout(same, hiding('party.gstin'));
    assert.deepEqual([s.party?.gstin, s.party?.pan, s.party?.registrationType, s.party?.name], [null, null, null, 'Acme Traders']);
    assert.deepEqual([s.consignee?.gstin, s.consignee?.pan, s.consignee?.registrationType], [null, null, null]);
    assert.equal(same.party?.gstin, '27AAAPA0001A1Z6', 'input untouched');
    const sep = applyPrintLayout(fullDoc(), hiding('party.gstin', 'party.contact'));
    assert.equal(sep.party?.gstin, null);
    assert.equal(sep.party?.phone, null);
    assert.equal(sep.consignee?.gstin, '29AAAPA0001A1Z2', 'separate ship-to keeps its GSTIN');
    assert.equal(sep.consignee?.phone, '080 1234');
    // No party at all: nothing to clear, no crash.
    assert.equal(applyPrintLayout(sampleDoc({ party: null }), hiding('party.gstin')).party, null);
  });

  it('consignee hidden wins over the party edge case', () => {
    const same = sampleDoc({ consignee: sampleDoc().party, consigneeSameAsParty: true });
    const out = applyPrintLayout(same, hiding('party.gstin', 'consignee'));
    assert.deepEqual([out.consignee, out.consigneeSameAsParty, out.party?.gstin], [null, false, null]);
  });

  it('texts: DTO-backed texts are written into their fields, every text is in applied.texts', () => {
    const doc = sampleDoc();
    const out = applyPrintLayout(
      doc,
      resolvePrintLayout(
        spec({
          text: [
            { id: 'title', value: 'GST Invoice' },
            { id: 'copy.duplicate', value: 'Transporter copy' },
            { id: 'label.party', value: 'Billed to' },
            { id: 'label.consignee', value: 'Shipped to' },
            { id: 'declaration', value: '' },
            { id: 'terms', value: '1. Goods once sold…' },
            { id: 'signatoryLabel', value: 'Proprietor' },
            { id: 'footer', value: 'Thank you' },
            { id: 'col.hsn', value: 'HSN' },
          ],
        }),
      ),
    );
    assert.equal(out.title, 'GST Invoice');
    assert.deepEqual(out.copyLabels, { ...doc.copyLabels, duplicate: 'Transporter copy' });
    assert.notEqual(out.copyLabels, doc.copyLabels);
    assert.equal(out.partyLabel, 'Billed to');
    assert.equal(out.consigneeLabel, 'Shipped to');
    assert.equal(out.declaration, null, "'' prints nothing");
    assert.equal(out.terms, '1. Goods once sold…');
    assert.equal(out.signatoryLabel, 'Proprietor');
    assert.equal(printText(out, 'footer', ''), 'Thank you');
    assert.equal(printText(out, 'col.hsn', 'HSN/SAC'), 'HSN');
    assert.equal(printText(out, 'col.qty', 'Qty'), 'Qty', 'not replaced → fallback');
    assert.equal(printText(doc, 'col.qty', 'Qty'), 'Qty', 'no applied at all → fallback');
    assert.equal(out.applied?.texts.title, 'GST Invoice');
    assert.equal(doc.title, 'Tax Invoice', 'input untouched');
  });

  it('a hidden declaration / terms stays hidden even when a text is set for it', () => {
    const out = applyPrintLayout(sampleDoc(), resolvePrintLayout(spec({ hide: ['declaration'], text: [{ id: 'declaration', value: 'New words' }] })));
    assert.equal(out.declaration, null);
  });

  it('isPartShown on a document without applied → everything shown', () => {
    assert.equal(isPartShown(sampleDoc(), 'logo'), true);
  });

  it('applied.hidden is sorted and stable', () => {
    const out = applyPrintLayout(sampleDoc(), hiding('signature', 'col.hsn', 'logo'));
    assert.deepEqual(out.applied?.hidden, ['col.hsn', 'logo', 'signature']);
  });
});

function creditNoteApplied(id: PrintPartId): PrintVoucherData {
  return applyPrintLayout(creditNote(), hiding(id));
}

// ───────────────────────────── Validation ─────────────────────────────

describe('validatePrintLayout', () => {
  it('a clean spec passes unchanged', () => {
    const s = spec({ hide: ['logo', 'col.hsn'], show: ['company.pan'], text: [{ id: 'footer', value: 'Thanks' }] });
    assert.deepEqual(validatePrintLayout(s, 'company'), { value: s, issues: [] });
    assert.deepEqual(validatePrintLayout(undefined, 'company'), { value: { hide: [], show: [], text: [] }, issues: [] });
    assert.deepEqual(validatePrintLayout(null, 'print').issues, []);
  });

  it('unknown, locked and malformed ids are dropped with issues', () => {
    const r = validatePrintLayout({ hide: ['logo', 'doc.number', 'nope', 7, 'totals.grand'], show: ['entries'], text: [] }, 'company');
    assert.deepEqual(r.value.hide, ['logo']);
    assert.deepEqual(r.value.show, []);
    assert.deepEqual(
      r.issues.map((i) => i.path),
      ['hide[1]', 'hide[2]', 'hide[3]', 'hide[4]', 'show[0]'],
    );
    assert.match(r.issues[0].message, /Document number is always printed/);
    assert.match(r.issues[1].message, /not a part/);
  });

  it('legacy-owned ids are dropped at the level that owns them', () => {
    const smuggled = {
      hide: ['bank', 'hsnSummary', 'upiQr', 'lineTax', 'col.mrp'],
      show: [],
      text: [
        { id: 'declaration', value: 'x' },
        { id: 'terms', value: 'x' },
        { id: 'title', value: 'Bill' },
        { id: 'signatoryLabel', value: 'Partner' },
      ],
    };
    const company = validatePrintLayout(smuggled, 'company');
    assert.deepEqual(company.value, { hide: [], show: [], text: [{ id: 'title', value: 'Bill' }] });
    assert.equal(company.issues.length, 8);
    assert.equal(company.issues[0].message, 'Bank details has its own setting in Invoice Printing');
    for (const i of company.issues) assert.doesNotMatch(i.message, /show[A-Z]|itemwiseTax|printTitle/, 'no internal option names in user-facing text');
    const vt = validatePrintLayout(smuggled, 'voucherType');
    assert.deepEqual(vt.value, { hide: [], show: [], text: [{ id: 'signatoryLabel', value: 'Partner' }] });
    assert.equal(vt.issues.find((i) => i.path === 'text[2].id')?.message, 'Document title has its own setting in the voucher type');
    const print = validatePrintLayout(smuggled, 'print');
    assert.deepEqual(print.value, { hide: [], show: [], text: [{ id: 'title', value: 'Bill' }] });
  });

  it('at most 200 entries per list', () => {
    const many = Array.from({ length: 250 }, () => 'logo');
    const r = validatePrintLayout({ hide: many, show: [], text: [] }, 'company');
    assert.deepEqual(r.value.hide, ['logo']);
    assert.deepEqual(r.issues, [{ path: 'hide', message: `hide has too many entries (max ${PRINT_LAYOUT_MAX_ENTRIES})` }]);
    const exactly = validatePrintLayout({ hide: many.slice(0, 200) }, 'company');
    assert.deepEqual(exactly.issues, []);
  });

  it('texts: clipped to their max (with an issue), control characters stripped, newlines only where multi-line', () => {
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const ESC = String.fromCharCode(27);
    const C1 = String.fromCharCode(0x85);
    const r = validatePrintLayout(
      {
        text: [
          { id: 'footer', value: `Line 1${NUL}\r\nLine${BEL} 2\t!` },
          { id: 'title', value: `Tax\nInvoice${ESC}${C1}` },
          { id: 'generatedLine', value: 'x'.repeat(130) },
          { id: 'notes', value: `<script>alert(1)</script> & "quotes"` },
        ],
      },
      'company',
    );
    assert.deepEqual(r.value.text, [
      { id: 'footer', value: 'Line 1\nLine 2 !' },
      { id: 'title', value: 'Tax Invoice' },
      { id: 'generatedLine', value: 'x'.repeat(120) },
      { id: 'notes', value: '<script>alert(1)</script> & "quotes"' },
    ]);
    assert.deepEqual(r.issues, [{ path: 'text[2].value', message: '"Computer-generated" text is too long (120 characters at most)' }]);
  });

  it('tabs become spaces so pasted terms keep their word breaks', () => {
    const r = validatePrintLayout({ text: [{ id: 'terms', value: '1.\tGoods once sold\r\n2.\tNo returns' }] }, 'voucherType');
    assert.equal(r.issues.length, 1, 'terms are owned by the voucher type key');
    const c = validatePrintLayout({ text: [{ id: 'notes', value: '1.\tGoods once sold\r\n2.\tNo returns' }] }, 'voucherType');
    assert.deepEqual(c.value.text, [{ id: 'notes', value: '1. Goods once sold\n2. No returns' }]);
  });

  it('an unknown top-level key is bounded in the issue (it reaches the log line)', () => {
    const r = validatePrintLayout({ ['k'.repeat(500)]: 1 }, 'company');
    assert.deepEqual(r.issues.map((i) => i.path.length), [40]);
  });

  it('a clipped text never ends in half a surrogate pair', () => {
    const r = validatePrintLayout({ text: [{ id: 'label.total', value: `${'a'.repeat(29)}😀😀` }] }, 'company');
    assert.equal(r.value.text[0].value, 'a'.repeat(29));
  });

  it('duplicates collapse: a part once, a part hidden and shown stays hidden, a text named twice keeps its last value', () => {
    const r = validatePrintLayout(
      { hide: ['logo', 'logo', 'col.hsn'], show: ['col.hsn', 'company.pan', 'company.pan'], text: [{ id: 'footer', value: 'a' }, { id: 'notes', value: 'n' }, { id: 'footer', value: 'b' }] },
      'company',
    );
    assert.deepEqual(r.value, { hide: ['logo', 'col.hsn'], show: ['company.pan'], text: [{ id: 'notes', value: 'n' }, { id: 'footer', value: 'b' }] });
    assert.deepEqual(r.issues, []);
  });

  it('corrupt shapes → empty spec with issues (never throws)', () => {
    for (const bad of ['garbage', 42, [], true]) {
      const r = validatePrintLayout(bad, 'company');
      assert.deepEqual(r.value, { hide: [], show: [], text: [] });
      assert.equal(r.issues.length, 1);
    }
    const r = validatePrintLayout({ hide: 'logo', show: {}, text: [null, ['x'], { id: 3 }, { id: 'footer' }, { id: 'nope', value: '' }], extra: 1 }, 'company');
    assert.deepEqual(r.value, { hide: [], show: [], text: [] });
    assert.deepEqual(
      r.issues.map((i) => i.path),
      ['extra', 'hide', 'show', 'text[0]', 'text[1]', 'text[2].id', 'text[3].value', 'text[4].id'],
    );
  });
});

// ───────────────────────────── Legacy shadowing (core pass-through) ─────────────────────────────

describe('shadowedByLegacy', () => {
  it('a voucher-type Print title shadows the company title text; preview overrides shadow the voucher-type signatory text', () => {
    const company = spec({ hide: ['logo'], text: [{ id: 'title', value: 'Invoice' }, { id: 'footer', value: 'f' }] });
    const voucherType = spec({ text: [{ id: 'signatoryLabel', value: 'Partner' }] });
    const none = shadowedByLegacy({ company, voucherType }, {});
    assert.equal(none.company, company);
    assert.equal(none.voucherType, voucherType);
    const blankTitle = shadowedByLegacy({ company, voucherType }, { voucherType: { printTitle: '  ' }, overrides: { signatoryLabel: undefined } });
    assert.equal(blankTitle.company, company, 'a blank print title is not set');
    assert.equal(blankTitle.voucherType, voucherType);
    const both = shadowedByLegacy({ company, voucherType }, { voucherType: { printTitle: 'Retail Invoice' }, overrides: { signatoryLabel: 'Owner' } });
    assert.deepEqual(both.company, spec({ hide: ['logo'], text: [{ id: 'footer', value: 'f' }] }));
    assert.deepEqual(both.voucherType, spec());
  });
});

// ───────────────────────────── Statutory guard ─────────────────────────────

describe('layoutWarnings', () => {
  const warningsFor = (doc: PrintVoucherData, ...ids: PrintPartId[]): string[] => layoutWarnings(doc, hiding(...ids));

  it('nothing hidden → no warnings, for every fixture', () => {
    for (const [name, make] of FIXTURES) assert.deepEqual(layoutWarnings(make(), resolvePrintLayout()), [], name);
  });

  it('B2B tax invoice: one plain-language line per hidden particular, citing Rule 46', () => {
    const doc = sampleDoc();
    assert.deepEqual(warningsFor(doc, 'party.gstin'), ["Hidden on this print: the buyer's GSTIN — required on a B2B tax invoice (Rule 46(d))."]);
    assert.deepEqual(warningsFor(doc, 'company.gstin'), ['Hidden on this print: your GSTIN — required on a tax invoice (Rule 46(a)).']);
    assert.deepEqual(warningsFor(doc, 'signature'), ['Hidden on this print: the signature — required on a tax invoice (Rule 46(q)).']);
    assert.deepEqual(warningsFor(doc, 'col.qty', 'col.unit'), [
      'Hidden on this print: the quantity of goods — required on a tax invoice (Rule 46(i)).',
      'Hidden on this print: the unit of quantity — required on a tax invoice (Rule 46(i)).',
    ]);
    assert.deepEqual(warningsFor(doc, 'copyLabel'), [
      'Hidden on this print: the copy marking (Original / Duplicate / Triplicate) — required on a tax invoice for goods (Rule 48(1)).',
    ]);
    assert.deepEqual(warningsFor(doc, 'title'), ['Hidden on this print: the document title — required on a tax invoice (Rule 46).']);
    // Rate and amount of tax: only when both the rate column and the tax totals are hidden.
    assert.deepEqual(warningsFor(doc, 'col.gstRate'), []);
    assert.deepEqual(warningsFor(doc, 'col.gstRate', 'totals.taxHeads'), ['Hidden on this print: the rate and amount of tax — required on a tax invoice (Rule 46(l), (m)).']);
    // Taxable value: the column and the total.
    assert.deepEqual(warningsFor(doc, 'col.taxable'), []);
    assert.deepEqual(warningsFor(doc, 'col.taxable', 'totals.taxable'), ['Hidden on this print: the taxable value — required on a tax invoice (Rule 46(k)).']);
    // Non-statutory parts never warn.
    assert.deepEqual(warningsFor(doc, 'logo', 'col.batch', 'col.discount', 'totals.roundOff', 'footer', 'pageNumbers', 'refs'), []);
  });

  it('HSN: warned only when the column is hidden AND the HSN summary is off or empty', () => {
    const withSummary = sampleDoc({ taxByHsn: fullDoc().taxByHsn });
    assert.deepEqual(warningsFor(withSummary, 'col.hsn'), [], 'the HSN summary still prints the codes');
    const summaryOff = sampleDoc({ taxByHsn: fullDoc().taxByHsn, options: { ...sampleDoc().options, showHsnSummary: false } });
    assert.deepEqual(warningsFor(summaryOff, 'col.hsn'), ['Hidden on this print: the HSN/SAC codes — required on a tax invoice (Rule 46(g)).']);
    assert.equal(warningsFor(sampleDoc(), 'col.hsn').length, 1, 'no HSN rows → the column is the only place');
    const noHsn = sampleDoc({ lines: [line({ hsnSac: null })] });
    assert.deepEqual(warningsFor(noHsn, 'col.hsn'), [], 'nothing to hide');
  });

  it('(V3) HSN: the summary prints inside the "Tax summary" part — hiding that part with the column hides every code', () => {
    // Modern draws the HSN summary as its tax summary table and Classic its HSN table, both gated by `taxSummary`.
    const withSummary = sampleDoc({ taxByHsn: fullDoc().taxByHsn });
    assert.deepEqual(warningsFor(withSummary, 'taxSummary'), [], 'the column still prints the codes');
    assert.deepEqual(warningsFor(withSummary, 'col.hsn', 'taxSummary'), ['Hidden on this print: the HSN/SAC codes — required on a tax invoice (Rule 46(g)).']);
  });

  it('B2C below ₹50,000: the buyer block may go; at ₹50,000 and above it is required (Rule 46(e))', () => {
    const b2c = sampleDoc({ party: { ...(sampleDoc().party as NonNullable<PrintVoucherData['party']>), gstin: null, pan: null, registrationType: 'unregistered' } });
    assert.deepEqual(warningsFor(b2c, 'party'), []);
    assert.deepEqual(warningsFor(b2c, 'party.gstin'), [], 'no GSTIN to hide');
    const big = sampleDoc({ party: b2c.party, totals: { ...b2c.totals, taxable: 50_000_00 } });
    assert.deepEqual(warningsFor(big, 'party'), ["Hidden on this print: the buyer's name and address — required on a tax invoice (Rule 46(d), (e))."]);
  });

  it('inter-State place of supply, separate ship-to, reverse-charge note, e-invoice', () => {
    const doc = fullDoc();
    assert.deepEqual(warningsFor(doc, 'placeOfSupply'), ['Hidden on this print: the place of supply — required on an inter-State tax invoice (Rule 46(n)).']);
    assert.deepEqual(warningsFor(sampleDoc(), 'placeOfSupply'), [], 'intra-State');
    assert.deepEqual(warningsFor(doc, 'consignee'), [
      'Hidden on this print: the delivery address (ship-to) — required on a tax invoice when goods go to another address (Rule 46(o)).',
    ]);
    assert.deepEqual(warningsFor(sampleDoc({ consignee: sampleDoc().party, consigneeSameAsParty: true }), 'consignee'), [], 'ship-to = buyer');
    assert.deepEqual(warningsFor(doc, 'statutoryNotes'), ['Hidden on this print: the reverse-charge note — required on a tax invoice (Rule 46(p)).']);
    assert.deepEqual(warningsFor(doc, 'einvoice'), ['Hidden on this print: the e-invoice IRN and QR code — an e-invoice must show them (Rule 48(4)).']);
    assert.deepEqual(warningsFor(sampleDoc(), 'einvoice'), [], 'no IRN');
  });

  it('a changed title must still name the document', () => {
    const doc = sampleDoc();
    const t = (value: string): string[] => layoutWarnings(doc, resolvePrintLayout(spec({ text: [{ id: 'title', value }] })));
    assert.deepEqual(t('GST INVOICE'), []);
    assert.deepEqual(t('Estimate'), ['The title "Estimate" does not say "Invoice" — a tax invoice must be titled as one (Rule 46).']);
    assert.deepEqual(t(''), ['Hidden on this print: the document title — required on a tax invoice (Rule 46).']);
    const bos = sampleDoc({ kind: 'bill_of_supply', title: 'Bill of Supply' });
    assert.deepEqual(layoutWarnings(bos, resolvePrintLayout(spec({ text: [{ id: 'title', value: 'Invoice' }] }))), [
      'The title "Invoice" does not say "Bill of Supply" — a bill of supply must be titled as one (Rule 49).',
    ]);
  });

  it('bill of supply cites Rule 49; no tax particulars', () => {
    const bos = sampleDoc({ kind: 'bill_of_supply', title: 'Bill of Supply', gst: { ...sampleDoc().gst, showTax: false } });
    assert.deepEqual(warningsFor(bos, 'party.gstin', 'signature', 'col.gstRate', 'totals.taxHeads', 'col.qty'), [
      "Hidden on this print: the buyer's GSTIN — required on a bill of supply (Rule 49).",
      'Hidden on this print: the signature — required on a bill of supply (Rule 49).',
    ]);
  });

  it('credit note cites Rule 53 and needs the original invoice', () => {
    const cn = creditNote();
    assert.deepEqual(warningsFor(cn, 'originalInvoice', 'company.name'), [
      'Hidden on this print: your business name — required on a credit note (Rule 53).',
      'Hidden on this print: the original invoice number and date — required on a credit note (Rule 53).',
    ]);
    assert.deepEqual(warningsFor(cn, 'copyLabel', 'col.qty'), [], 'Rule 48 copies and Rule 46(i) quantity do not apply to notes');
  });

  it('a debit note to a supplier (purchase return) and a purchase are not warned about', () => {
    const toSupplier = sampleDoc({ kind: 'debit_note', partyLabel: 'Supplier (Bill from)', gst: { ...sampleDoc().gst, nature: 'inward_b2b' } });
    assert.deepEqual(warningsFor(toSupplier, 'party.gstin', 'signature'), []);
    const purchase = sampleDoc({ kind: 'purchase_voucher', title: 'Purchase Voucher' });
    assert.deepEqual(warningsFor(purchase, 'party.gstin', 'signature', 'company.gstin'), []);
  });

  it('self invoice: the party is the supplier (required whatever the value), the company the recipient; no copy marking', () => {
    const party = { ...(sampleDoc().party as NonNullable<PrintVoucherData['party']>), gstin: null, pan: null, registrationType: 'unregistered' as const };
    const si = sampleDoc({ kind: 'self_invoice', title: 'Self Invoice', partyLabel: 'Supplier (Bill from)', party, gst: { ...sampleDoc().gst, nature: 'inward_rcm' } });
    assert.ok(si.totals.taxable < 50_000_00, 'below the B2C threshold');
    assert.deepEqual(warningsFor(si, 'party', 'company.gstin', 'copyLabel'), [
      'Hidden on this print: your GSTIN — required on a self invoice (Rule 46(d)).',
      "Hidden on this print: the supplier's name and address — required on a self invoice (Rule 46(a)).",
    ]);
  });

  it('delivery challan cites Rule 55 (consignee wording)', () => {
    const dc = challanDoc();
    assert.deepEqual(warningsFor(dc, 'party', 'party.gstin', 'col.qty', 'col.amount', 'signature'), [
      "Hidden on this print: the consignee's name and address — required on a delivery challan (Rule 55).",
      'Hidden on this print: the quantity of goods — required on a delivery challan (Rule 55).',
      'Hidden on this print: the taxable value — required on a delivery challan (Rule 55).',
      'Hidden on this print: the signature — required on a delivery challan (Rule 55).',
    ]);
  });

  it('payment voucher: no statutory particulars', () => {
    const pv = voucherDoc();
    assert.deepEqual(warningsFor(pv, 'party', 'signature', 'title', 'company.gstin', 'narration', 'receivedBy'), []);
  });
});
