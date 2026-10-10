/**
 * (2.0) The print preview editor's rules (R5, docs/ARCHITECTURE.md "Print layouts (2.0)"), pure and tested
 * in layoutParts.test.ts / partsCoverage.test.ts. The catalogue, resolution, application and the statutory
 * warnings are shared (src/shared/printLayout.ts); this file adds what only the renderer needs:
 *
 *   - which parts and texts each template prints (TEMPLATE_PARTS / TEMPLATE_TEXTS; every template file
 *     re-exports its list as SUPPORTED_PARTS), and the template's own default wording;
 *   - whether a part has anything to print on a document;
 *   - the editor model (groups of switches, texts, where each value comes from);
 *   - editing a layer (hide / show / text), and what "Save for {voucher type}" / "Save for all documents"
 *     write — layout ids into the layer, option-owned parts and texts into their option keys (D22);
 *   - the per-print layer remembered for the session (sessionStorage, fails safe).
 *
 * The per-print level of an option-owned part / text is the preview overrides (`print.voucherData
 * { overrides }`, the company keys): a per-print layer never holds such an id (validatePrintLayout).
 */
import type { InvoiceTemplate } from '../../../../shared/settings.ts';
import type { VoucherTypeConfig } from '../../../../shared/types/accounts.ts';
import type { InvoicePrintOptions, InvoicePrintOverrides, PrintPageSize, PrintVoucherData } from '../../../../shared/types/print.ts';
import {
  applyPrintLayout,
  cleanPrintText,
  emptyPrintLayout,
  isEmptyPrintLayout,
  LAYOUT_RULES,
  layoutSource,
  legacyKeyAt,
  printPart,
  PRINT_PARTS,
  PRINT_TEXTS,
  printTextDef,
  resolvePrintLayout,
  validatePrintLayout,
  type PrintLayoutLevel,
  type PrintLayoutSpec,
  type PrintPartDef,
  type PrintPartGroup,
  type PrintPartId,
  type PrintTextDef,
  type PrintTextId,
  type ResolvedPrintLayout,
} from '../../../../shared/printLayout.ts';
import { addressLines, isRoll, itemColumns, showMrp, totalRows, voucherSides } from './layout.ts';

// ───────────────────────────── Templates ─────────────────────────────

/** The component that draws a document: the invoice templates, or the inventory / voucher layouts (any sheet template), or the receipt. */
export type TemplateKind = 'modern' | 'classic' | 'compact' | 'inventory' | 'voucher';

export function templateKind(template: InvoiceTemplate, layout: PrintVoucherData['layout']): TemplateKind {
  if (template === 'compact') return 'compact';
  if (layout === 'voucher') return 'voucher';
  if (layout === 'inventory') return 'inventory';
  return template === 'classic' ? 'classic' : 'modern';
}

/** Source file of each template (templates/), for the coverage test. */
export const TEMPLATE_FILES: Readonly<Record<TemplateKind, string>> = {
  modern: 'ModernInvoice.tsx',
  classic: 'ClassicInvoice.tsx',
  compact: 'CompactDoc.tsx',
  inventory: 'InventoryDoc.tsx',
  voucher: 'VoucherDoc.tsx',
};

/**
 * Parts each template prints and honours (gate, DTO field, column, totals row, option key or page counter).
 * The editor lists PRINT_PARTS ∩ these ∩ the parts of the document's layout. Order follows the catalogue.
 */
export const TEMPLATE_PARTS: Readonly<Record<TemplateKind, readonly PrintPartId[]>> = {
  modern: [
    'logo', 'company.name', 'company.address', 'company.gstin', 'company.pan', 'company.cin', 'company.contact',
    'title', 'copyLabel', 'endorsement', 'statutoryNotes', 'stamp',
    'doc.number', 'doc.date', 'refs', 'placeOfSupply', 'ewayBill', 'originalInvoice',
    'party', 'party.gstin', 'party.contact', 'consignee',
    'col.sno', 'col.description', 'col.hsn', 'col.batch', 'col.qty', 'col.unit', 'col.mrp', 'col.rate', 'col.discount',
    'col.taxable', 'col.gstRate', 'lineTax', 'col.cgst', 'col.sgst', 'col.igst', 'col.cess', 'col.amount',
    'totals.taxable', 'totals.taxHeads', 'totals.charges', 'totals.roundOff', 'totals.grand',
    'mrpSaved', 'amountInWords', 'taxInWords', 'hsnSummary', 'taxSummary',
    'bank', 'upiQr', 'forex', 'pos', 'einvoice',
    'narration', 'declaration', 'terms', 'notes', 'signature', 'generatedLine', 'footer', 'pageNumbers',
  ],
  classic: [
    'logo', 'company.name', 'company.address', 'company.gstin', 'company.pan', 'company.contact',
    'title', 'copyLabel', 'endorsement', 'statutoryNotes', 'stamp',
    'doc.number', 'doc.date', 'refs', 'placeOfSupply', 'ewayBill', 'originalInvoice',
    'party', 'party.gstin', 'party.contact', 'consignee',
    'col.sno', 'col.description', 'col.hsn', 'col.batch', 'col.qty', 'col.unit', 'col.mrp', 'col.rate', 'col.discount', 'col.gstRate',
    'totals.taxHeads', 'totals.charges', 'totals.roundOff', 'totals.grand',
    'mrpSaved', 'amountInWords', 'taxInWords', 'taxSummary',
    'bank', 'upiQr', 'forex', 'pos', 'einvoice',
    'narration', 'declaration', 'terms', 'notes', 'signature', 'generatedLine', 'footer', 'pageNumbers',
  ],
  compact: [
    'company.name', 'company.address', 'company.gstin', 'company.contact',
    'title', 'copyLabel', 'endorsement', 'statutoryNotes', 'stamp',
    'doc.number', 'doc.date', 'refs', 'placeOfSupply', 'ewayBill', 'originalInvoice',
    'party', 'party.gstin', 'consignee',
    'col.description', 'col.hsn', 'col.qty', 'col.unit', 'col.mrp', 'col.rate', 'col.discount', 'col.gstRate', 'col.amount',
    'totals.taxable', 'totals.taxHeads', 'totals.charges', 'totals.roundOff', 'totals.grand',
    'mrpSaved', 'amountInWords', 'taxSummary',
    'upiQr', 'pos', 'einvoice',
    'narration', 'declaration', 'terms', 'notes', 'signature', 'footer',
    'entries',
  ],
  inventory: [
    'logo', 'company.name', 'company.address', 'company.gstin', 'company.pan', 'company.cin', 'company.contact',
    'title', 'stamp',
    'doc.number', 'doc.date', 'refs', 'ewayBill',
    'party', 'party.gstin', 'party.contact', 'consignee',
    'col.sno', 'col.description', 'col.batch', 'col.qty', 'col.unit', 'col.rate', 'col.amount',
    'amountInWords',
    'narration', 'notes', 'signature', 'footer', 'pageNumbers',
  ],
  voucher: [
    'logo', 'company.name', 'company.address', 'company.gstin', 'company.pan', 'company.cin', 'company.contact',
    'title', 'stamp',
    'doc.number', 'doc.date',
    'party',
    'totals.grand', 'amountInWords',
    'forex',
    'narration', 'notes', 'signature', 'footer', 'pageNumbers',
    'entries', 'receivedBy',
  ],
};

/** Texts each template prints (DTO-backed texts reach every template through the document itself). */
export const TEMPLATE_TEXTS: Readonly<Record<TemplateKind, readonly PrintTextId[]>> = {
  modern: [
    'title', 'copy.original', 'copy.duplicate', 'copy.triplicate', 'label.party', 'label.consignee',
    'col.description', 'col.hsn', 'col.qty', 'col.rate', 'col.discount', 'col.taxable', 'col.amount',
    'label.amountInWords', 'label.total', 'declaration', 'terms', 'notes', 'signatoryLabel', 'signFor', 'footer', 'generatedLine',
  ],
  classic: [
    'title', 'copy.original', 'copy.duplicate', 'copy.triplicate', 'label.party', 'label.consignee',
    'col.description', 'col.hsn', 'col.qty', 'col.rate', 'col.discount', 'col.amount',
    'label.amountInWords', 'label.total', 'declaration', 'terms', 'notes', 'signatoryLabel', 'signFor', 'footer', 'generatedLine',
  ],
  compact: [
    'title', 'copy.original', 'copy.duplicate', 'copy.triplicate', 'label.party', 'label.consignee',
    'label.total', 'declaration', 'terms', 'notes', 'signatoryLabel', 'signFor', 'footer',
  ],
  inventory: [
    'title', 'copy.original', 'copy.duplicate', 'copy.triplicate', 'label.party', 'label.consignee',
    'col.description', 'col.qty', 'col.rate', 'col.amount',
    'label.amountInWords', 'label.total', 'notes', 'signatoryLabel', 'signFor', 'footer',
  ],
  voucher: ['title', 'copy.original', 'copy.duplicate', 'copy.triplicate', 'label.amountInWords', 'label.total', 'notes', 'signatoryLabel', 'footer'],
};

/**
 * The template's own wording of a text (what prints when no layer changes it) — the single source the
 * templates print through `printText(doc, id, templateText(…))`. DTO-backed texts read the document.
 */
export function templateText(kind: TemplateKind, id: PrintTextId, doc: PrintVoucherData, opts: { lineTax?: boolean } = {}): string {
  const classic = kind === 'classic';
  switch (id) {
    case 'title':
      return doc.title;
    case 'copy.original':
      return doc.copyLabels.original;
    case 'copy.duplicate':
      return doc.copyLabels.duplicate;
    case 'copy.triplicate':
      return doc.copyLabels.triplicate;
    case 'label.party':
      return doc.partyLabel;
    case 'label.consignee':
      return doc.consigneeLabel;
    case 'col.description':
      return classic ? 'Description of Goods / Services' : 'Description';
    case 'col.hsn':
      return 'HSN/SAC';
    case 'col.qty':
      return kind === 'modern' ? 'Qty' : 'Quantity';
    case 'col.rate':
      return 'Rate';
    case 'col.discount':
      return classic ? 'Disc. %' : 'Disc.';
    case 'col.taxable':
      return 'Taxable';
    case 'col.amount':
      return kind === 'modern' && opts.lineTax ? 'Total' : 'Amount';
    case 'label.amountInWords':
      return classic ? 'Amount Chargeable (in words)' : kind === 'inventory' ? 'Value in words' : 'Amount in words';
    case 'label.total':
      if (kind === 'voucher' || (kind === 'compact' && doc.layout === 'voucher')) return 'Amount';
      return kind === 'inventory' ? (doc.baseType === 'stock_journal' ? 'Production value' : 'Total value') : 'Total';
    case 'declaration':
      return doc.declaration ?? '';
    case 'terms':
      return doc.terms ?? '';
    case 'signatoryLabel':
      return doc.signatoryLabel;
    case 'signFor':
      return classic ? 'for {company}' : 'For {company}';
    case 'generatedLine':
      if (classic) return `This is a Computer Generated ${doc.layout === 'invoice' && doc.baseType === 'sales' ? 'Invoice' : 'Document'}`;
      return doc.layout === 'invoice' && doc.baseType === 'sales' ? 'This is a computer-generated invoice.' : 'This is a computer-generated document.';
    case 'notes':
    case 'footer':
      return '';
    default:
      return '';
  }
}

/** "For {company}" with the company's printed name filled in. */
export function signForText(text: string, doc: Pick<PrintVoucherData, 'company'>): string {
  return text.split('{company}').join(doc.company.displayName);
}

/** Parts the editor lists for a document drawn with a template: catalogue order. */
export function supportedParts(doc: Pick<PrintVoucherData, 'layout'>, template: InvoiceTemplate): PrintPartDef[] {
  const allowed = new Set<string>(TEMPLATE_PARTS[templateKind(template, doc.layout)]);
  return (PRINT_PARTS as readonly PrintPartDef[]).filter((p) => allowed.has(p.id) && p.layouts.includes(doc.layout));
}

export function supportedTexts(doc: Pick<PrintVoucherData, 'layout'>, template: InvoiceTemplate): PrintTextDef[] {
  const allowed = new Set<string>(TEMPLATE_TEXTS[templateKind(template, doc.layout)]);
  return (PRINT_TEXTS as readonly PrintTextDef[]).filter((t) => allowed.has(t.id));
}

// ───────────────────────────── Application (the one choke point) ─────────────────────────────

/** Layers that replace / add to a document's saved ones: `company` replaces the saved company layer (the
 *  Invoice Printing draft), `print` is this print's layer. */
export interface LayoutLayers {
  company?: PrintLayoutSpec | null;
  print?: PrintLayoutSpec | null;
}

/** The resolved layout of a document: saved company ‹ saved voucher type ‹ this print. */
export function resolveDocLayout(doc: Pick<PrintVoucherData, 'savedLayout'>, layers: LayoutLayers = {}): ResolvedPrintLayout {
  return resolvePrintLayout(layers.company ?? doc.savedLayout?.company, doc.savedLayout?.voucherType, layers.print);
}

/** The document as it prints: applyPrintLayout over its saved layers and these (templates/PrintDocuments.tsx). */
export function layoutDoc(doc: PrintVoucherData, layers: LayoutLayers = {}): PrintVoucherData {
  return applyPrintLayout(doc, resolveDocLayout(doc, layers));
}

// ───────────────────────────── Data per part ─────────────────────────────

/**
 * Whether a part has anything to print on this document with this template (the editor says "nothing to
 * print on this document" otherwise and keeps the switch). `doc` is the document as core built it, with
 * the texts of the resolved layers for the text-only parts (notes, footer).
 */
export function partHasData(doc: PrintVoucherData, id: PrintPartId, view: { template: InvoiceTemplate; pageSize: PrintPageSize; texts?: ReadonlyMap<PrintTextId, string> }): boolean {
  const raw: PrintVoucherData = doc.applied ? { ...doc, applied: undefined } : doc;
  const cols = itemColumns(raw, view);
  const kind = templateKind(view.template, doc.layout);
  const c = doc.company;
  const p = doc.party;
  const hasLines = doc.lines.length > 0;
  const t = doc.totals;
  switch (id) {
    case 'logo':
      return !!c.logo;
    case 'company.address':
      return addressLines(c).length > 0;
    case 'company.gstin':
      return !!c.gstin;
    case 'company.pan':
      return !!c.pan;
    case 'company.cin':
      return !!c.cin;
    case 'company.contact':
      return !!(c.phone || c.email || c.website);
    case 'endorsement':
      return !!doc.endorsement;
    case 'statutoryNotes':
      return doc.notes.length > 0;
    case 'stamp':
      return doc.status.cancelled || doc.status.optional || doc.sample;
    case 'refs':
      return !!doc.referenceNo || doc.references.length > 0;
    case 'placeOfSupply':
      return !!doc.placeOfSupply;
    case 'ewayBill':
      return !!doc.ewayBill;
    case 'originalInvoice':
      return !!doc.originalInvoice;
    case 'party':
      return kind === 'voucher' ? (doc.baseType === 'payment' || doc.baseType === 'receipt') && voucherSides(doc).accounts.length > 0 : !!p;
    case 'party.gstin':
      return !!(p && (p.gstin || p.pan));
    case 'party.contact':
      return !!(p && (p.phone || p.email));
    case 'consignee':
      return !!doc.consignee && (kind === 'modern' ? true : !doc.consigneeSameAsParty);
    case 'col.sno':
    case 'col.description':
      return hasLines;
    case 'col.hsn':
      return hasLines && cols.hsn;
    case 'col.batch':
      return cols.batch;
    case 'col.qty':
      return cols.qty;
    case 'col.unit':
      return doc.lines.some((l) => l.qty !== null && !!l.unit);
    case 'col.mrp':
      return showMrp(doc);
    case 'col.rate':
      return cols.rate;
    case 'col.discount':
      return cols.discount;
    case 'col.taxable':
      return cols.lineTax;
    case 'col.gstRate':
      return hasLines && doc.gst.showTax && !(kind === 'modern' && cols.lineTax);
    case 'lineTax':
      return cols.lineTax;
    case 'col.cgst':
    case 'col.sgst':
      return cols.lineTax && cols.cgstSgst;
    case 'col.igst':
      return cols.lineTax && cols.igst;
    case 'col.cess':
      return cols.lineTax && cols.cess;
    case 'col.amount':
      return hasLines && cols.amount;
    case 'totals.taxable':
      return totalRows(raw).some((r) => r.part === 'totals.taxable');
    case 'totals.taxHeads':
      return doc.gst.showTax && (t.cgst !== 0 || t.sgst !== 0 || t.igst !== 0 || t.cess !== 0);
    case 'totals.charges':
      return doc.charges.length > 0;
    case 'totals.roundOff':
      return t.roundOff !== 0;
    case 'mrpSaved':
      return showMrp(doc) && (doc.mrpSummary?.savings ?? 0) > 0;
    case 'amountInWords':
      return kind === 'inventory' ? cols.amount && t.grandTotal !== 0 : kind === 'compact' ? t.grandTotal !== 0 : !!doc.amountInWords;
    case 'taxInWords':
      return !!doc.taxInWords;
    case 'hsnSummary':
      return doc.gst.showTax && doc.taxByHsn.length > 0;
    case 'taxSummary':
      return doc.gst.showTax && (kind === 'classic' ? doc.taxByHsn.length > 0 : kind === 'compact' ? doc.taxByRate.length > 0 : doc.taxByHsn.length > 0 || doc.taxByRate.length > 0);
    case 'bank':
      return !!doc.bank && !!(doc.bank.accountNo || doc.bank.ifsc);
    case 'upiQr':
      return !!doc.upi && !doc.status.cancelled;
    case 'forex':
      return !!doc.forex;
    case 'pos':
      return !!doc.pos;
    case 'einvoice':
      return !!doc.einvoice;
    case 'narration':
      return !!doc.narration;
    case 'declaration':
      return !!doc.declaration;
    case 'terms':
      return !!doc.terms;
    case 'notes':
      return (view.texts?.get('notes') ?? '') !== '';
    case 'footer':
      return (view.texts?.get('footer') ?? '') !== '';
    case 'pageNumbers':
      return !isRoll(view.pageSize);
    case 'entries':
      return doc.entries.length > 0;
    case 'company.name':
    case 'title':
    case 'copyLabel':
    case 'doc.number':
    case 'doc.date':
    case 'totals.grand':
    case 'signature':
    case 'generatedLine':
    case 'receivedBy':
      return true;
    default:
      return true;
  }
}

/** Page numbers print unless every document's resolved layout hides them. */
export function pageNumbersShown(docs: readonly PrintVoucherData[]): boolean {
  return docs.length === 0 || docs.some((d) => !d.applied || !d.applied.hidden.includes('pageNumbers'));
}

// ───────────────────────────── Option-owned parts and texts (D22) ─────────────────────────────

/** Boolean option keys of `config.invoice` that own a part (company key = preview override key). */
export type LegacyFlag = 'showMrp' | 'itemwiseTax' | 'showHsnSummary' | 'showBankDetails' | 'showUpiQr';
/** Text option keys of `config.invoice` that own a text. */
export type LegacyText = 'declaration' | 'terms' | 'signatoryLabel';

export const LEGACY_FLAGS: readonly LegacyFlag[] = ['showMrp', 'itemwiseTax', 'showHsnSummary', 'showBankDetails', 'showUpiQr'];
export const LEGACY_TEXTS: readonly LegacyText[] = ['declaration', 'terms', 'signatoryLabel'];

export function legacyFlagOf(def: PrintPartDef): LegacyFlag | null {
  const k = def.legacy?.company;
  return k && (LEGACY_FLAGS as readonly string[]).includes(k) ? (k as LegacyFlag) : null;
}

export function legacyTextOf(def: PrintTextDef): LegacyText | null {
  const k = def.legacy?.company;
  return k && (LEGACY_TEXTS as readonly string[]).includes(k) ? (k as LegacyText) : null;
}

/** The preview overrides a layout editor may send (option-owned parts and texts only). */
export type LayoutOverrides = Partial<Pick<InvoicePrintOptions, LegacyFlag | LegacyText>>;

/** Untrusted → clean overrides: known keys of the right type, texts cleaned and clipped like layout texts. */
export function cleanOverrides(x: unknown): LayoutOverrides {
  const out: LayoutOverrides = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  const src = x as Record<string, unknown>;
  for (const k of LEGACY_FLAGS) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  for (const k of LEGACY_TEXTS) {
    const v = src[k];
    const def = printTextDef(k);
    if (typeof v === 'string' && def) out[k] = cleanPrintText(def, v).value;
  }
  return out;
}

// ───────────────────────────── Layer editing ─────────────────────────────

const without = <T,>(list: readonly T[], x: T): T[] => list.filter((y) => y !== x);

function copyLayer(l: PrintLayoutSpec | null | undefined): PrintLayoutSpec {
  return l ? { hide: [...l.hide], show: [...l.show], text: l.text.map((t) => ({ ...t })) } : emptyPrintLayout();
}

/**
 * Show or hide a part in `layer`; `below` is what the layers under it resolve to. Showing a part that a
 * lower layer hides adds it to `show`; showing one nothing hides just removes the entry. Locked parts and
 * unknown ids leave the layer as it is.
 */
export function setPartShown(layer: PrintLayoutSpec, id: PrintPartId, shown: boolean, below: ResolvedPrintLayout): PrintLayoutSpec {
  const def = printPart(id);
  if (!def || def.locked) return layer;
  const out = copyLayer(layer);
  out.hide = without(out.hide, id);
  out.show = without(out.show, id);
  if (!shown) out.hide.push(id);
  else if (below.hidden.has(id)) out.show.push(id);
  return out;
}

/** Set (string) or remove (null → inherit) a text in `layer`. Values are cleaned like the save routes do. */
export function setLayerText(layer: PrintLayoutSpec, id: PrintTextId, value: string | null): PrintLayoutSpec {
  const def = printTextDef(id);
  if (!def) return layer;
  const out = copyLayer(layer);
  out.text = out.text.filter((t) => t.id !== id);
  if (value !== null) out.text.push({ id, value: cleanPrintText(def, value).value });
  return out;
}

/**
 * The per-print layer applied onto a saved layer (`base`, with `lower` the layers under it): its hides and
 * shows and texts written into that layer, the result kept minimal (a show nothing below hides is dropped).
 */
export function mergeIntoLayer(base: PrintLayoutSpec, change: PrintLayoutSpec, lower: ReadonlyArray<PrintLayoutSpec | null | undefined>): PrintLayoutSpec {
  const below = resolvePrintLayout(...lower);
  let out = copyLayer(base);
  for (const id of change.show) out = setPartShown(out, id, true, below);
  for (const id of change.hide) out = setPartShown(out, id, false, below);
  for (const t of change.text) out = setLayerText(out, t.id, t.value);
  return out;
}

/**
 * What remains of the per-print layer once new saved layers took effect: only entries whose result the
 * saved layers do not already give (so the preview looks the same after "Save for …").
 */
export function remainingPerPrint(change: PrintLayoutSpec, saved: { company: PrintLayoutSpec; voucherType: PrintLayoutSpec }, written: { texts?: readonly PrintTextId[] } = {}): PrintLayoutSpec {
  const r = resolvePrintLayout(saved.company, saved.voucherType);
  return {
    hide: change.hide.filter((id) => !r.hidden.has(id)),
    show: change.show.filter((id) => r.hidden.has(id)),
    text: change.text.filter((t) => !(written.texts ?? []).includes(t.id) && r.texts.get(t.id) !== t.value),
  };
}

// ───────────────────────────── Saving (D22) ─────────────────────────────

export interface PerPrintEdit {
  /** The per-print layout layer (never holds option-owned ids). */
  layer: PrintLayoutSpec;
  /** Option-owned parts and texts for this print (sent as `print.voucherData { overrides }`). */
  overrides: LayoutOverrides;
}

export function emptyEdit(): PerPrintEdit {
  return { layer: emptyPrintLayout(), overrides: {} };
}

export function isEmptyEdit(e: PerPrintEdit | null | undefined): boolean {
  return !e || (isEmptyPrintLayout(e.layer) && Object.keys(e.overrides).length === 0);
}

const VT_FLAG_KEYS: Record<LegacyFlag, keyof VoucherTypeConfig> = {
  showMrp: 'showMrp',
  itemwiseTax: 'itemwiseTax',
  showHsnSummary: 'showHsnSummary',
  showBankDetails: 'showBankDetails',
  showUpiQr: 'showUpiQr',
};

/** A value the voucher type sets for a key (non-null, non-blank) — it then beats Invoice Printing. */
export function vtSets(vtConfig: VoucherTypeConfig | null | undefined, key: keyof VoucherTypeConfig | undefined): boolean {
  if (!vtConfig || !key) return false;
  const v = vtConfig[key];
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

/**
 * `accounts.voucherType.save { id, config }` for "Save for {voucher type}": the per-print layer merged into
 * the voucher type's layer, option-owned values written to the voucher-type keys — the four flags and the
 * MRP column, declaration and terms (`''` → the part hidden in the layer, the key cleared: a blank key
 * means "as in Invoice Printing"), the document title → Print title; the signatory label has no
 * voucher-type key, so it is a text of the layer. Returns the issues of the merged layer (none expected).
 */
export function voucherTypePatch(edit: PerPrintEdit, saved: { company: PrintLayoutSpec; voucherType: PrintLayoutSpec }): { config: VoucherTypeConfig; layer: PrintLayoutSpec; writtenTexts: PrintTextId[]; issues: string[] } {
  const config: VoucherTypeConfig = {};
  const change = copyLayer(edit.layer);
  const writtenTexts: PrintTextId[] = [];
  // Title → Print title (owned by the voucher type).
  const title = change.text.find((t) => t.id === 'title');
  if (title) {
    change.text = change.text.filter((t) => t.id !== 'title');
    if (title.value === '') {
      change.hide.push('title');
      config.printTitle = null;
    } else config.printTitle = title.value;
    writtenTexts.push('title');
  }
  for (const k of LEGACY_FLAGS) {
    const v = edit.overrides[k];
    if (typeof v === 'boolean') config[VT_FLAG_KEYS[k]] = v as never;
  }
  for (const k of ['declaration', 'terms'] as const) {
    const v = edit.overrides[k];
    if (typeof v !== 'string') continue;
    if (v === '') {
      change.hide.push(k);
      config[k] = null;
    } else {
      config[k] = v;
      change.show.push(k);
    }
  }
  if (typeof edit.overrides.signatoryLabel === 'string') change.text.push({ id: 'signatoryLabel', value: edit.overrides.signatoryLabel });
  const merged = mergeIntoLayer(saved.voucherType, change, [saved.company]);
  const { value, issues } = validatePrintLayout(merged, 'voucherType');
  config.printLayout = isEmptyPrintLayout(value) ? null : value;
  return { config, layer: value, writtenTexts, issues: issues.map((i) => `${i.path}: ${i.message}`) };
}

/**
 * `company.config.save { invoice }` for "Save for all documents": the per-print layer merged into the
 * company layer, option-owned values written to their Invoice Printing keys.
 */
export function companyPatch(edit: PerPrintEdit, saved: { company: PrintLayoutSpec }): { invoice: Partial<InvoicePrintOptions>; layer: PrintLayoutSpec; issues: string[] } {
  const invoice: Partial<InvoicePrintOptions> = {};
  for (const k of LEGACY_FLAGS) {
    const v = edit.overrides[k];
    if (typeof v === 'boolean') invoice[k] = v;
  }
  const change = copyLayer(edit.layer);
  for (const k of LEGACY_TEXTS) {
    const v = edit.overrides[k];
    if (typeof v === 'string') invoice[k] = v;
  }
  // A declaration / terms printed again at company level after a lower layer hid them stays the key's job.
  const merged = mergeIntoLayer(saved.company, change, []);
  const { value, issues } = validatePrintLayout(merged, 'company');
  invoice.layout = value;
  return { invoice, layer: value, issues: issues.map((i) => `${i.path}: ${i.message}`) };
}

/** Overrides still needed after a save at `level` (a voucher type's own key beats a company save). */
export function overridesAfterSave(overrides: LayoutOverrides, level: 'company' | 'voucherType', vtConfig: VoucherTypeConfig | null | undefined): LayoutOverrides {
  if (level === 'voucherType') {
    // signatoryLabel went into the layer; the rest into keys.
    return {};
  }
  const out: LayoutOverrides = {};
  for (const k of LEGACY_FLAGS) if (overrides[k] !== undefined && vtSets(vtConfig, VT_FLAG_KEYS[k])) out[k] = overrides[k];
  for (const k of ['declaration', 'terms'] as const) if (overrides[k] !== undefined && vtSets(vtConfig, k)) out[k] = overrides[k];
  return out;
}

/** What "Reset ▾ › Saved for {voucher type}" clears: the layer and every show / hide choice of the type. */
export const VOUCHER_TYPE_RESET: VoucherTypeConfig = {
  printLayout: null,
  showHsnSummary: null,
  showBankDetails: null,
  showUpiQr: null,
  itemwiseTax: null,
  showMrp: null,
};

// ───────────────────────────── Editor model ─────────────────────────────

export type LayoutValueSource = 'default' | 'company' | 'voucherType' | 'print';

export interface EditorPartRow {
  id: PrintPartId;
  label: string;
  shown: boolean;
  locked: boolean;
  /** Option key that owns the part (its switch writes the key / the preview overrides). */
  flag: LegacyFlag | null;
  /** Nothing to print on this document (the switch stays). */
  empty: boolean;
  /** Statutory citation (e.g. 'Rule 46(g)') — amber when hidden. */
  rule: string | null;
  source: LayoutValueSource;
  /** "Hidden for all documents" / "Hidden for Sales" / "This print" / "Off in Invoice Printing" ('' when nothing to say). */
  sourceText: string;
}

export interface EditorGroup {
  id: PrintPartGroup;
  label: string;
  rows: EditorPartRow[];
  shownCount: number;
}

export interface EditorTextRow {
  id: PrintTextId;
  label: string;
  max: number;
  multiline: boolean;
  /** The value at the edited level ('' = not set there: the placeholder prints). */
  value: string;
  /** What prints when the edited level does not set it. */
  placeholder: string;
  set: boolean;
  /** Option key that owns the text at the edited level. */
  option: LegacyText | null;
  source: LayoutValueSource;
  /** "This print" / "Saved for Sales" / "Saved for all documents" / "From Invoice Printing" ('' for the template's own). */
  sourceText: string;
}

export interface EditorModel {
  groups: EditorGroup[];
  texts: EditorTextRow[];
  /** Statutory warnings for the hidden particulars (layoutWarnings). */
  resolved: ResolvedPrintLayout;
}

export const GROUP_LABELS: Readonly<Record<PrintPartGroup, string>> = {
  header: 'Header',
  details: 'Document details',
  parties: 'Parties',
  columns: 'Item columns',
  totals: 'Totals and words',
  payment: 'Payment',
  einvoice: 'e-Invoice',
  footer: 'Footer',
  voucher: 'Voucher',
};

/** Part / text labels as the app spells GSTN terms ('e-Invoice', 'e-Way Bill'). */
export function displayLabel(label: string): string {
  return label.replace(/\bE-invoice\b/, 'e-Invoice').replace(/\bE-way bill\b/, 'e-Way Bill');
}

export interface EditorInput {
  /** The document as fetched (options include the per-print overrides / the Invoice Printing draft). */
  doc: PrintVoucherData;
  template: InvoiceTemplate;
  pageSize: PrintPageSize;
  /** The edited level: this print (Print Preview) or all documents (Invoice Printing). */
  level: Extract<PrintLayoutLevel, 'print' | 'company'>;
  layers: { company: PrintLayoutSpec; voucherType: PrintLayoutSpec; print: PrintLayoutSpec };
  /** Effective print options (doc.options with the pending overrides / draft applied). */
  options: InvoicePrintOptions;
  /** Option values without this print's overrides (placeholders of option-owned texts). */
  baseOptions: InvoicePrintOptions;
  /** Overrides of this print (print level). */
  overrides: LayoutOverrides;
  vtConfig: VoucherTypeConfig | null;
  vtName: string;
}

function sourceText(source: LayoutValueSource, shown: boolean, vtName: string, owned: boolean): string {
  if (source === 'print') return 'This print';
  if (source === 'voucherType') return `${shown ? 'Shown' : 'Hidden'} for ${vtName}`;
  if (source === 'company') return owned ? (shown ? '' : 'Off in Invoice Printing') : `${shown ? 'Shown' : 'Hidden'} for all documents`;
  return '';
}

export function editorModel(input: EditorInput): EditorModel {
  const { doc, template, pageSize, layers, options, overrides, vtConfig, vtName, level } = input;
  const resolved = resolvePrintLayout(layers.company, layers.voucherType, layers.print);
  const groups = new Map<PrintPartGroup, EditorGroup>();
  for (const def of supportedParts(doc, template)) {
    const id = def.id as PrintPartId;
    const flag = legacyFlagOf(def);
    let shown: boolean;
    let source: LayoutValueSource;
    if (flag) {
      shown = options[flag] === true;
      source = level === 'print' && overrides[flag] !== undefined ? 'print' : vtSets(vtConfig, VT_FLAG_KEYS[flag]) ? 'voucherType' : 'company';
    } else {
      shown = !resolved.hidden.has(id);
      source = def.locked ? 'default' : layoutSource(layers, id, 'part');
    }
    const rule = def.statutory ? LAYOUT_RULES[def.statutory].rule : null;
    const row: EditorPartRow = {
      id,
      label: displayLabel(def.label),
      shown,
      locked: def.locked === true,
      flag,
      empty: shown && !partHasData(doc, id, { template, pageSize, texts: resolved.texts }),
      rule,
      source,
      sourceText: def.locked ? 'Always printed' : sourceText(source, shown, vtName, !!flag),
    };
    let g = groups.get(def.group);
    if (!g) {
      g = { id: def.group, label: GROUP_LABELS[def.group], rows: [], shownCount: 0 };
      groups.set(def.group, g);
    }
    g.rows.push(row);
    if (shown) g.shownCount++;
  }
  const kind = templateKind(template, doc.layout);
  const lineTax = itemColumns(doc.applied ? { ...doc, applied: undefined } : doc, { pageSize, template }).lineTax;
  const below = level === 'print' ? resolvePrintLayout(layers.company, layers.voucherType) : resolvePrintLayout();
  const edited = level === 'print' ? layers.print : layers.company;
  const texts: EditorTextRow[] = supportedTexts(doc, template).map((def) => {
    const id = def.id as PrintTextId;
    const option = legacyKeyAt(def, level) ? legacyTextOf(def) : null;
    let value: string;
    let placeholder: string;
    let set: boolean;
    let source: LayoutValueSource;
    if (option) {
      const v = level === 'print' ? overrides[option] : options[option];
      set = typeof v === 'string' && v !== '';
      value = set ? (v as string) : '';
      placeholder = level === 'print' ? input.baseOptions[option] : '';
      source = level === 'print' && set ? 'print' : vtSets(vtConfig, def.legacy?.voucherType) ? 'voucherType' : 'company';
    } else {
      const mine = edited.text.find((t) => t.id === id);
      set = mine !== undefined;
      value = mine?.value ?? '';
      placeholder = below.texts.get(id) ?? templateText(kind, id, doc, { lineTax });
      source = layoutSource(layers, id, 'text');
    }
    const sourceText =
      source === 'print' ? 'This print' : source === 'voucherType' ? `Saved for ${vtName}` : source === 'company' ? (option ? (level === 'print' ? 'From Invoice Printing' : '') : 'Saved for all documents') : '';
    return { id, label: displayLabel(def.label), max: def.max, multiline: def.multiline === true, value, placeholder, set, option, source, sourceText };
  });
  return { groups: [...groups.values()], texts, resolved };
}

// ───────────────────────────── Session memory ─────────────────────────────

/** sessionStorage key of the per-print layer of a company's voucher type (remembered for the session). */
export function sessionKey(companyId: string, voucherTypeId: number): string {
  return `pevqori.printLayout.${companyId}.${voucherTypeId}`;
}

/** Stored text → a clean edit (anything malformed → null; never throws). */
export function parseSessionEdit(raw: string | null): PerPrintEdit | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as { v?: unknown; layer?: unknown; overrides?: unknown };
    if (o.v !== 1) return null;
    const edit: PerPrintEdit = { layer: validatePrintLayout(o.layer, 'print').value, overrides: cleanOverrides(o.overrides) };
    return isEmptyEdit(edit) ? null : edit;
  } catch {
    return null;
  }
}

export function serialiseSessionEdit(edit: PerPrintEdit): string {
  return JSON.stringify({ v: 1, layer: edit.layer, overrides: edit.overrides });
}

/** Preview overrides for a print: only the option-owned values of this edit (undefined when none — the 1.0 request). */
export function previewOverridesOf(edit: PerPrintEdit): InvoicePrintOverrides | undefined {
  return Object.keys(edit.overrides).length > 0 ? { ...edit.overrides } : undefined;
}
