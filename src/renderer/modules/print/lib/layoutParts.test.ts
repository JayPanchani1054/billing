/**
 * (2.0) The print preview editor's rules (layoutParts.ts): template part lists, data per part, the editor
 * model, editing a layer, what "Save for …" writes, session memory. Money is never touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../../../shared/settings.ts';
import {
  EMPTY_PRINT_LAYOUT,
  emptyPrintLayout,
  isPrintPartId,
  isPrintTextId,
  layoutWarnings,
  printPart,
  PRINT_PARTS,
  resolvePrintLayout,
  validatePrintLayout,
  type PrintLayoutSpec,
  type PrintPartId,
} from '../../../../shared/printLayout.ts';
import type { PrintVoucherData } from '../../../../shared/types/print.ts';
import { line, sampleDoc } from './fixtures.ts';
import {
  cleanOverrides,
  companyPatch,
  editorModel,
  emptyEdit,
  isEmptyEdit,
  layoutDoc,
  mergeIntoLayer,
  overridesAfterSave,
  pageNumbersShown,
  parseSessionEdit,
  partHasData,
  previewOverridesOf,
  remainingPerPrint,
  serialiseSessionEdit,
  sessionKey,
  setLayerText,
  setPartShown,
  signForText,
  supportedParts,
  supportedTexts,
  TEMPLATE_PARTS,
  TEMPLATE_TEXTS,
  templateKind,
  templateText,
  voucherTypePatch,
  VOUCHER_TYPE_RESET,
  type EditorInput,
  type PerPrintEdit,
  type TemplateKind,
} from './layoutParts.ts';

const KINDS: readonly TemplateKind[] = ['modern', 'classic', 'compact', 'inventory', 'voucher'];

const layer = (o: Partial<PrintLayoutSpec> = {}): PrintLayoutSpec => ({ ...emptyPrintLayout(), ...o });

function input(doc: PrintVoucherData, o: Partial<EditorInput> = {}): EditorInput {
  return {
    doc,
    template: 'modern',
    pageSize: 'A4',
    level: 'print',
    layers: { company: doc.savedLayout?.company ?? EMPTY_PRINT_LAYOUT, voucherType: doc.savedLayout?.voucherType ?? EMPTY_PRINT_LAYOUT, print: EMPTY_PRINT_LAYOUT },
    options: doc.options,
    baseOptions: doc.options,
    overrides: {},
    vtConfig: null,
    vtName: 'Sales',
    ...o,
  };
}

const voucherDoc = (): PrintVoucherData =>
  sampleDoc({
    layout: 'voucher',
    kind: 'payment_voucher',
    baseType: 'payment',
    lines: [],
    entries: [
      { ledgerName: 'Supreme Suppliers', amount: 100000, debit: 100000, credit: 0, isCashBank: false, narration: null, instrument: null, bills: [], costCentres: [] },
      { ledgerName: 'HDFC Bank', amount: -100000, debit: 0, credit: 100000, isCashBank: true, narration: null, instrument: null, bills: [], costCentres: [] },
    ],
  });

describe('template part and text lists', () => {
  it('every listed id is in the catalogue and belongs to a layout the template draws', () => {
    for (const kind of KINDS) {
      for (const id of TEMPLATE_PARTS[kind]) {
        const def = printPart(id);
        assert.ok(def, `${kind}: ${id}`);
        const layouts = kind === 'voucher' ? ['voucher'] : kind === 'inventory' ? ['inventory'] : kind === 'compact' ? ['invoice', 'voucher', 'inventory'] : ['invoice'];
        assert.ok(def.layouts.some((l) => layouts.includes(l)), `${kind}: ${id} is not a part of its documents`);
      }
      for (const id of TEMPLATE_TEXTS[kind]) assert.ok(isPrintTextId(id), `${kind}: text ${id}`);
      assert.equal(new Set(TEMPLATE_PARTS[kind]).size, TEMPLATE_PARTS[kind].length, `${kind}: duplicates`);
    }
  });

  it('page numbers: sheets only; locked parts are listed where they print', () => {
    for (const kind of ['modern', 'classic', 'inventory', 'voucher'] as const) assert.ok(TEMPLATE_PARTS[kind].includes('pageNumbers'), kind);
    assert.equal(TEMPLATE_PARTS.compact.includes('pageNumbers'), false, 'a roll has no page numbers');
    for (const kind of KINDS) for (const id of ['stamp', 'doc.number', 'doc.date'] as const) assert.ok(TEMPLATE_PARTS[kind].includes(id), `${kind} ${id}`);
    assert.ok(TEMPLATE_PARTS.voucher.includes('entries') && TEMPLATE_PARTS.compact.includes('entries'));
    // The receipt has no ship-to columns, HSN summary, per-line tax or page counter (spec §7.2).
    for (const id of ['hsnSummary', 'lineTax', 'col.cgst', 'col.sgst', 'col.igst', 'col.cess', 'pageNumbers', 'bank'] as const) assert.equal(TEMPLATE_PARTS.compact.includes(id), false, id);
  });

  it('the editor lists catalogue ∩ template ∩ layout, in catalogue order', () => {
    const inv = supportedParts(sampleDoc(), 'modern').map((p) => p.id);
    assert.ok(inv.includes('col.hsn') && inv.includes('bank') && !inv.includes('entries') && !inv.includes('receivedBy'));
    const order = (PRINT_PARTS as readonly { id: string }[]).map((p) => p.id);
    assert.deepEqual([...inv].sort((a, b) => order.indexOf(a) - order.indexOf(b)), inv);
    const vch = supportedParts(voucherDoc(), 'classic').map((p) => p.id);
    assert.ok(vch.includes('entries') && vch.includes('receivedBy') && !vch.includes('col.hsn') && !vch.includes('copyLabel'));
    const receipt = supportedParts(sampleDoc(), 'compact').map((p) => p.id);
    assert.ok(!receipt.includes('pageNumbers') && receipt.includes('consignee'));
    assert.equal(templateKind('classic', 'voucher'), 'voucher');
    assert.equal(templateKind('compact', 'voucher'), 'compact');
    assert.equal(templateKind('modern', 'inventory'), 'inventory');
    assert.ok(supportedTexts(sampleDoc(), 'compact').every((t) => !t.id.startsWith('col.')), 'the receipt has no column headings');
  });

  it("template defaults are the 1.0 wording (an empty layout prints today's document)", () => {
    const doc = sampleDoc();
    assert.equal(templateText('modern', 'col.qty', doc), 'Qty');
    assert.equal(templateText('classic', 'col.qty', doc), 'Quantity');
    assert.equal(templateText('classic', 'col.description', doc), 'Description of Goods / Services');
    assert.equal(templateText('modern', 'col.amount', doc, { lineTax: true }), 'Total');
    assert.equal(templateText('modern', 'col.amount', doc), 'Amount');
    assert.equal(templateText('classic', 'label.amountInWords', doc), 'Amount Chargeable (in words)');
    assert.equal(templateText('inventory', 'label.total', sampleDoc({ baseType: 'stock_journal' })), 'Production value');
    assert.equal(templateText('compact', 'label.total', voucherDoc()), 'Amount');
    assert.equal(templateText('modern', 'generatedLine', doc), 'This is a computer-generated invoice.');
    assert.equal(templateText('modern', 'generatedLine', voucherDoc()), 'This is a computer-generated document.');
    assert.equal(templateText('classic', 'generatedLine', doc), 'This is a Computer Generated Invoice');
    assert.equal(signForText(templateText('classic', 'signFor', doc), doc), 'for Test Traders');
    assert.equal(signForText('Signed for {company} ({company})', doc), 'Signed for Test Traders (Test Traders)');
    assert.equal(templateText('modern', 'notes', doc), '');
    assert.equal(templateText('modern', 'title', doc), 'Tax Invoice');
  });
});

describe('applying the layout at the choke point', () => {
  it('no layout: the same document, only `applied` added (money by reference)', () => {
    for (const doc of [sampleDoc(), voucherDoc(), sampleDoc({ layout: 'inventory', kind: 'delivery_challan' })]) {
      const out = layoutDoc(doc);
      const { applied, ...rest } = out;
      assert.deepEqual(rest, doc);
      assert.deepEqual(applied, { hidden: [], texts: {} });
      assert.equal(out.lines, doc.lines);
      assert.equal(out.totals, doc.totals);
    }
  });

  it('saved layers, a replacing company layer and this print resolve in order', () => {
    const doc = sampleDoc({ savedLayout: { company: layer({ hide: ['logo', 'company.cin'] }), voucherType: layer({ show: ['logo'] }) } });
    assert.deepEqual(layoutDoc(doc).applied?.hidden, ['company.cin']);
    assert.deepEqual(layoutDoc(doc, { print: layer({ hide: ['col.hsn'] }) }).applied?.hidden, ['col.hsn', 'company.cin']);
    assert.deepEqual(layoutDoc(doc, { company: layer({ hide: ['terms'] }) }).applied?.hidden, ['terms'], 'the draft replaces the saved company layer');
  });

  it('page numbers print unless every document hides them', () => {
    const hidden = layoutDoc(sampleDoc(), { print: layer({ hide: ['pageNumbers'] }) });
    assert.equal(pageNumbersShown([hidden]), false);
    assert.equal(pageNumbersShown([hidden, layoutDoc(sampleDoc())]), true);
    assert.equal(pageNumbersShown([]), true);
  });
});

describe('data per part', () => {
  const view = { template: 'modern' as const, pageSize: 'A4' as const };
  it('says what has nothing to print on this document', () => {
    const doc = sampleDoc();
    assert.equal(partHasData(doc, 'bank', view), false);
    assert.equal(partHasData(sampleDoc({ bank: { ledgerId: 1, ledgerName: 'HDFC', accountHolder: null, accountNo: '123', ifsc: null, bankName: null, branch: null, upiId: null } }), 'bank', view), true);
    assert.equal(partHasData(doc, 'col.hsn', view), true);
    assert.equal(partHasData(doc, 'col.batch', view), false);
    assert.equal(partHasData(sampleDoc({ lines: [line({ batch: 'B1' })] }), 'col.batch', view), true);
    assert.equal(partHasData(doc, 'col.taxable', view), false, 'only with per-line tax columns');
    assert.equal(partHasData(doc, 'totals.roundOff', view), true);
    assert.equal(partHasData(doc, 'einvoice', view), false);
    assert.equal(partHasData(doc, 'notes', view), false);
    assert.equal(partHasData(doc, 'notes', { ...view, texts: new Map([['notes', 'Goods once sold…']]) }), true);
    assert.equal(partHasData(doc, 'pageNumbers', { ...view, pageSize: '80mm' }), false);
    assert.equal(partHasData(voucherDoc(), 'party', { ...view, template: 'classic' }), true, 'paid to: the accounts of a payment');
    // A hidden column is still "data" for the editor: the switch says what showing it would print.
    assert.equal(partHasData(layoutDoc(doc, { print: layer({ hide: ['col.hsn'] }) }), 'col.hsn', view), true);
  });
});

describe('editor model', () => {
  it('groups the parts, counts what is shown and says where a value comes from', () => {
    const doc = sampleDoc({ savedLayout: { company: layer({ hide: ['company.contact'] }), voucherType: layer({ hide: ['col.discount'] }) } });
    const m = editorModel(input(doc, { layers: { company: doc.savedLayout!.company, voucherType: doc.savedLayout!.voucherType, print: layer({ hide: ['col.hsn'] }) } }));
    const rows = new Map(m.groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
    assert.equal(rows.get('company.contact')?.sourceText, 'Hidden for all documents');
    assert.equal(rows.get('col.discount')?.sourceText, 'Hidden for Sales');
    assert.equal(rows.get('col.hsn')?.sourceText, 'This print');
    assert.equal(rows.get('col.hsn')?.shown, false);
    assert.equal(rows.get('col.hsn')?.rule, 'Rule 46(g)');
    assert.equal(rows.get('doc.number')?.locked, true);
    assert.equal(rows.get('doc.number')?.sourceText, 'Always printed');
    assert.equal(rows.get('bank')?.flag, 'showBankDetails');
    assert.equal(rows.get('bank')?.empty, true, 'shown but no bank chosen: nothing to print');
    assert.equal(rows.get('einvoice')?.label, 'e-Invoice IRN and QR code', 'GSTN spelling');
    assert.equal(rows.get('ewayBill')?.label, 'e-Way Bill number');
    const columns = m.groups.find((g) => g.id === 'columns');
    assert.ok(columns && columns.shownCount === columns.rows.filter((r) => r.shown).length);
    assert.deepEqual(
      m.groups.map((g) => g.id),
      ['header', 'details', 'parties', 'columns', 'totals', 'payment', 'einvoice', 'footer'],
    );
  });

  it('option-owned parts read the effective options and their source', () => {
    const doc = sampleDoc();
    const off = { ...doc.options, showBankDetails: false };
    const print = editorModel(input(doc, { options: off, overrides: { showBankDetails: false } }));
    const bank = print.groups.flatMap((g) => g.rows).find((r) => r.id === 'bank');
    assert.deepEqual([bank?.shown, bank?.source, bank?.sourceText], [false, 'print', 'This print']);
    const byType = editorModel(input(doc, { options: off, vtConfig: { showBankDetails: false } }));
    assert.equal(byType.groups.flatMap((g) => g.rows).find((r) => r.id === 'bank')?.sourceText, 'Hidden for Sales');
    const inSettings = editorModel(input(doc, { options: off }));
    assert.equal(inSettings.groups.flatMap((g) => g.rows).find((r) => r.id === 'bank')?.sourceText, 'Off in Invoice Printing');
  });

  it('texts: the edited level value, the inherited placeholder, and option-owned texts', () => {
    const doc = sampleDoc({ savedLayout: { company: layer({ text: [{ id: 'footer', value: 'Thank you' }] }), voucherType: EMPTY_PRINT_LAYOUT } });
    const m = editorModel(input(doc, { layers: { ...input(doc).layers, print: layer({ text: [{ id: 'col.qty', value: 'Nos.' }] }) } }));
    const t = new Map(m.texts.map((r) => [r.id, r]));
    assert.deepEqual([t.get('col.qty')?.value, t.get('col.qty')?.placeholder, t.get('col.qty')?.sourceText], ['Nos.', 'Qty', 'This print']);
    assert.deepEqual([t.get('footer')?.value, t.get('footer')?.placeholder, t.get('footer')?.sourceText], ['', 'Thank you', 'Saved for all documents']);
    assert.equal(t.get('declaration')?.option, 'declaration');
    assert.equal(t.get('declaration')?.placeholder, DEFAULT_CONFIG.invoice.declaration);
    assert.equal(t.get('title')?.option, null, 'the title is a layout text at print level (the voucher type owns its Print title)');
    // Company level (Invoice Printing): option texts show the draft value.
    const company = editorModel(input(doc, { level: 'company', options: { ...doc.options, terms: 'Net 30' } }));
    const terms = company.texts.find((r) => r.id === 'terms');
    assert.deepEqual([terms?.value, terms?.option, terms?.sourceText], ['Net 30', 'terms', '']);
  });

  it('statutory warnings come from the shared guard on the document as core built it', () => {
    const doc = sampleDoc({ options: { ...sampleDoc().options, showHsnSummary: false }, taxByHsn: [] });
    const lines = layoutWarnings(doc, resolvePrintLayout({ hide: ['col.hsn', 'party.gstin'], show: [], text: [] }));
    assert.ok(lines.some((l) => /HSN\/SAC codes/.test(l) && /Rule 46\(g\)/.test(l)));
    assert.ok(lines.some((l) => /buyer's GSTIN/.test(l)));
  });
});

describe('editing a layer', () => {
  it('hide / show: a show is written only when a lower layer hides the part; locked parts never change', () => {
    const below = resolvePrintLayout(layer({ hide: ['logo'] }));
    let l = setPartShown(emptyPrintLayout(), 'col.hsn', false, below);
    assert.deepEqual(l, layer({ hide: ['col.hsn'] }));
    l = setPartShown(l, 'col.hsn', true, below);
    assert.deepEqual(l, layer(), 'nothing below hides it: the entry just goes');
    l = setPartShown(l, 'logo', true, below);
    assert.deepEqual(l, layer({ show: ['logo'] }));
    assert.equal(setPartShown(l, 'doc.number', false, below), l);
    assert.equal(setPartShown(l, 'nope' as PrintPartId, false, below), l);
  });

  it('texts are cleaned like the save routes; null inherits', () => {
    let l = setLayerText(emptyPrintLayout(), 'title', 'Bill\tof\u0007 Supply');
    assert.deepEqual(l.text, [{ id: 'title', value: 'Bill of Supply' }]);
    l = setLayerText(l, 'title', 'x'.repeat(100));
    assert.equal(l.text[0].value.length, 60);
    l = setLayerText(l, 'footer', 'line 1\nline 2');
    assert.deepEqual(l.text[1], { id: 'footer', value: 'line 1\nline 2' });
    assert.deepEqual(setLayerText(l, 'title', null).text.map((t) => t.id), ['footer']);
  });

  it('merging this print into a saved layer keeps it minimal and valid', () => {
    const saved = layer({ hide: ['logo'], text: [{ id: 'footer', value: 'Old' }] });
    const merged = mergeIntoLayer(saved, layer({ hide: ['col.hsn'], show: ['logo'], text: [{ id: 'footer', value: 'New' }] }), []);
    assert.deepEqual(merged, layer({ hide: ['col.hsn'], text: [{ id: 'footer', value: 'New' }] }));
    const overCompany = mergeIntoLayer(EMPTY_PRINT_LAYOUT, layer({ show: ['logo'] }), [layer({ hide: ['logo'] })]);
    assert.deepEqual(overCompany, layer({ show: ['logo'] }), "a voucher type shows what the company hides");
    assert.deepEqual(validatePrintLayout(merged, 'company').issues, []);
  });
});

describe('saving (D22: option keys stay the owners)', () => {
  const edit = (o: Partial<PerPrintEdit>): PerPrintEdit => ({ ...emptyEdit(), ...o });

  it('Save for a voucher type: layout ids into the layer, flags / declaration / terms / title into keys', () => {
    const p = voucherTypePatch(
      edit({
        layer: layer({ hide: ['col.hsn'], text: [{ id: 'title', value: 'Invoice' }, { id: 'footer', value: 'Thanks' }] }),
        overrides: { showBankDetails: false, showHsnSummary: false, terms: 'Net 30', declaration: '', signatoryLabel: 'Proprietor' },
      }),
      { company: EMPTY_PRINT_LAYOUT, voucherType: layer({ hide: ['logo'] }) },
    );
    assert.deepEqual(p.issues, []);
    assert.equal(p.config.printTitle, 'Invoice');
    assert.equal(p.config.showBankDetails, false);
    assert.equal(p.config.showHsnSummary, false);
    assert.equal(p.config.terms, 'Net 30');
    assert.equal(p.config.declaration, null, "'' = print no declaration: the part is hidden, the key cleared");
    assert.deepEqual(p.config.printLayout, {
      hide: ['logo', 'col.hsn', 'declaration'],
      show: [],
      text: [
        { id: 'footer', value: 'Thanks' },
        { id: 'signatoryLabel', value: 'Proprietor' },
      ],
    });
    assert.deepEqual(p.writtenTexts, ['title']);
    assert.deepEqual(validatePrintLayout(p.config.printLayout, 'voucherType').issues, [], 'the accounts.voucherType.save schema accepts it');
    assert.equal(voucherTypePatch(edit({ layer: layer({ hide: ['logo'] }) }), { company: EMPTY_PRINT_LAYOUT, voucherType: layer({ hide: ['logo'] }) }).config.printLayout?.hide.length, 1);
    assert.equal(voucherTypePatch(edit({ layer: layer({ show: ['logo'] }) }), { company: EMPTY_PRINT_LAYOUT, voucherType: layer({ hide: ['logo'] }) }).config.printLayout, null, 'an empty layer is removed');
  });

  it('Save for all documents: the company layer and the Invoice Printing keys', () => {
    const p = companyPatch(edit({ layer: layer({ hide: ['logo'], text: [{ id: 'title', value: 'Invoice' }] }), overrides: { showUpiQr: true, signatoryLabel: 'Partner' } }), { company: layer({ hide: ['company.cin'] }) });
    assert.deepEqual(p.issues, []);
    assert.deepEqual(p.invoice.layout, layer({ hide: ['company.cin', 'logo'], text: [{ id: 'title', value: 'Invoice' }] }));
    assert.equal(p.invoice.showUpiQr, true);
    assert.equal(p.invoice.signatoryLabel, 'Partner');
    assert.deepEqual(validatePrintLayout(p.invoice.layout, 'company').issues, []);
  });

  it('after saving, only what the saved layers do not already give stays on this print', () => {
    const change = layer({ hide: ['col.hsn', 'logo'], show: ['terms'], text: [{ id: 'footer', value: 'A' }, { id: 'title', value: 'Invoice' }] });
    const after = remainingPerPrint(change, { company: layer({ hide: ['terms'] }), voucherType: layer({ hide: ['col.hsn'], text: [{ id: 'footer', value: 'A' }] }) }, { texts: ['title'] });
    assert.deepEqual(after, layer({ hide: ['logo'], show: ['terms'] }));
    assert.deepEqual(overridesAfterSave({ showBankDetails: false, terms: 'x' }, 'voucherType', null), {});
    assert.deepEqual(overridesAfterSave({ showBankDetails: false, terms: 'x' }, 'company', { showBankDetails: true }), { showBankDetails: false }, 'the voucher type still decides: keep it on this print');
  });

  it('Reset for a voucher type clears the layer and every show / hide flag, not its texts', () => {
    assert.deepEqual(Object.keys(VOUCHER_TYPE_RESET).sort(), ['itemwiseTax', 'printLayout', 'showBankDetails', 'showHsnSummary', 'showMrp', 'showUpiQr']);
    assert.ok(Object.values(VOUCHER_TYPE_RESET).every((v) => v === null));
  });
});

describe('session memory and overrides', () => {
  it('round-trips, and anything malformed or empty is ignored', () => {
    const e: PerPrintEdit = { layer: layer({ hide: ['logo'], text: [{ id: 'footer', value: 'x' }] }), overrides: { showBankDetails: false } };
    assert.deepEqual(parseSessionEdit(serialiseSessionEdit(e)), e);
    assert.equal(parseSessionEdit(null), null);
    assert.equal(parseSessionEdit('{not json'), null);
    assert.equal(parseSessionEdit(JSON.stringify({ v: 2, layer: e.layer })), null);
    assert.equal(parseSessionEdit(serialiseSessionEdit(emptyEdit())), null);
    // Stale or crafted entries: unknown / locked / option-owned ids dropped; overrides typed.
    const crafted = parseSessionEdit(JSON.stringify({ v: 1, layer: { hide: ['doc.number', 'bank', 'logo', 'zzz'], text: [{ id: 'declaration', value: 'x' }] }, overrides: { showBankDetails: 'no', terms: 5, signatoryLabel: 'A\u0000B', evil: true } }));
    assert.deepEqual(crafted, { layer: layer({ hide: ['logo'] }), overrides: { signatoryLabel: 'AB' } });
    assert.equal(sessionKey('c1', 7), 'pevqori.printLayout.c1.7');
  });

  it('overrides carry option-owned values only; none → the 1.0 request', () => {
    assert.deepEqual(cleanOverrides({ showMrp: true, layout: { hide: ['logo'] }, upiId: 'x@y', declaration: 'd'.repeat(3000) }), { showMrp: true, declaration: 'd'.repeat(2000) });
    assert.equal(previewOverridesOf(emptyEdit()), undefined);
    assert.deepEqual(previewOverridesOf({ layer: emptyPrintLayout(), overrides: { itemwiseTax: true } }), { itemwiseTax: true });
    assert.equal(isEmptyEdit({ layer: layer({ hide: ['logo'] }), overrides: {} }), false);
    assert.equal(isEmptyEdit(undefined), true);
  });

  it('every id the editor can write at print level validates at print level', () => {
    for (const p of PRINT_PARTS) {
      if (('locked' in p && p.locked) || ('legacy' in p && p.legacy)) continue;
      assert.ok(isPrintPartId(p.id));
      assert.deepEqual(validatePrintLayout({ hide: [p.id] }, 'print').issues, [], p.id);
    }
  });
});
