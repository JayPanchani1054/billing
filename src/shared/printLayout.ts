/**
 * (2.0) Print layouts — what prints on a document, and with which words (R5, docs/ARCHITECTURE.md
 * "Print layouts (2.0)"). Pure data and functions: used by core (validation of saved layers, pass-through
 * in print/data.ts) and by the renderer (resolution, application in templates/PrintDocuments.tsx, the
 * preview editor). No React, no DOM, no node:* — safe on both sides.
 *
 * Model
 *   - A *part* is a printable block or column (PRINT_PARTS); a *text* is a printed wording (PRINT_TEXTS).
 *     Part and text ids are persisted: never rename or remove one.
 *   - A layout *layer* (PrintLayoutSpec) hides / shows parts and replaces texts. Layers, lowest first:
 *     company (config.invoice.layout) ‹ voucher type (voucher_types.config.printLayout) ‹ this print.
 *     A layer's `show` undoes a lower layer's `hide`; locked parts can never be hidden.
 *   - Parts and texts that an existing option key already controls (Show HSN summary, bank details, UPI QR,
 *     item-wise tax, MRP column; declaration, terms, signatory label, voucher-type print title) stay owned
 *     by that key (`legacy`) and never appear in a layer at a level where the key exists.
 *   - Core never removes data because of a layout: it validates the saved layers and passes them through
 *     (PrintVoucherData.savedLayout); the renderer resolves the layers and applies them with
 *     applyPrintLayout at one choke point. Money is never recomputed or altered here.
 */
import type { VoucherTypeConfig } from './types/accounts.ts';
import type { InvoicePrintOptions, PrintAddress, PrintDocKind, PrintLayout, PrintVoucherData } from './types/print.ts';

// ───────────────────────────── Catalogue types ─────────────────────────────

export type PrintPartGroup = 'header' | 'details' | 'parties' | 'columns' | 'totals' | 'payment' | 'einvoice' | 'footer' | 'voucher';

/**
 * How a hidden part disappears:
 *   dto    — applyPrintLayout nulls / empties the DTO field(s);
 *   gate   — the template checks isPartShown(doc, id);
 *   column — the item-column builder ANDs "not hidden";
 *   total  — the totals-row builder filters it out;
 *   legacy — an existing option key (live through the preview overrides, saved to that key);
 *   page   — the page-number counters (pageCss(…, 'none')).
 */
export type PrintPartKind = 'dto' | 'gate' | 'column' | 'total' | 'legacy' | 'page';

/** Option keys that own a part / text: company `config.invoice.<key>`, voucher type `config.<key>`. */
export interface PrintLegacyKeys {
  company?: keyof InvoicePrintOptions;
  voucherType?: keyof VoucherTypeConfig;
}

export interface PrintPartDef {
  /** Stable, persisted. */
  id: string;
  group: PrintPartGroup;
  /** Shown in the editor. */
  label: string;
  layouts: ReadonlyArray<PrintLayout>;
  kind: PrintPartKind;
  /** Can never be hidden. */
  locked?: boolean;
  /** Option key that owns this part (D22). */
  legacy?: PrintLegacyKeys;
  /** Statutory particular (key of LAYOUT_RULES): hiding it adds a warning on the documents it applies to. */
  statutory?: LayoutRuleKey;
}

export interface PrintTextDef {
  /** Stable, persisted. */
  id: string;
  label: string;
  /** Longest value accepted (characters). */
  max: number;
  multiline?: boolean;
  /** Option key that owns this text (D22). */
  legacy?: PrintLegacyKeys;
}

export type PrintLayoutLevel = 'company' | 'voucherType' | 'print';

// ───────────────────────────── Statutory particulars ─────────────────────────────

/**
 * Statutory particulars a part carries. `rule` is the citation for a tax invoice (CGST Rule 46, or 48 for
 * copies and e-invoices) — shown as the amber note in the editor; layoutWarnings cites the rule of the
 * document actually printed (Rule 49 bill of supply, Rule 53 credit / debit note, Rule 55 delivery challan).
 */
export const LAYOUT_RULES = {
  supplier: { rule: 'Rule 46(a)', what: 'your name, address and GSTIN' },
  recipient: { rule: 'Rule 46(d), (e)', what: "the buyer's name and address" },
  recipientGstin: { rule: 'Rule 46(d)', what: "the buyer's GSTIN" },
  delivery: { rule: 'Rule 46(o)', what: 'the delivery address (ship-to)' },
  hsn: { rule: 'Rule 46(g)', what: 'the HSN/SAC codes' },
  quantity: { rule: 'Rule 46(i)', what: 'the quantity and unit of goods' },
  taxableValue: { rule: 'Rule 46(k)', what: 'the taxable value' },
  tax: { rule: 'Rule 46(l), (m)', what: 'the rate and amount of tax' },
  placeOfSupply: { rule: 'Rule 46(n)', what: 'the place of supply' },
  reverseCharge: { rule: 'Rule 46(p)', what: 'the reverse-charge note' },
  signature: { rule: 'Rule 46(q)', what: 'the signature' },
  copies: { rule: 'Rule 48(1)', what: 'the copy marking (Original / Duplicate / Triplicate)' },
  einvoice: { rule: 'Rule 48(4)', what: 'the e-invoice IRN and QR code' },
  title: { rule: 'Rule 46', what: 'the document title' },
  originalInvoice: { rule: 'Rule 53', what: 'the original invoice number and date' },
} as const satisfies Record<string, { rule: string; what: string }>;

export type LayoutRuleKey = keyof typeof LAYOUT_RULES;

// ───────────────────────────── Part catalogue (§7.2) ─────────────────────────────

const ALL = ['invoice', 'voucher', 'inventory'] as const;
const INV = ['invoice'] as const;
const INV_STOCK = ['invoice', 'inventory'] as const;
const INV_VCH = ['invoice', 'voucher'] as const;
const VCH = ['voucher'] as const;

export const PRINT_PARTS = [
  // Header
  { id: 'logo', group: 'header', label: 'Logo', layouts: ALL, kind: 'dto' },
  { id: 'company.name', group: 'header', label: 'Business name', layouts: ALL, kind: 'gate', statutory: 'supplier' },
  { id: 'company.address', group: 'header', label: 'Business address', layouts: ALL, kind: 'gate', statutory: 'supplier' },
  { id: 'company.gstin', group: 'header', label: 'Your GSTIN', layouts: ALL, kind: 'dto', statutory: 'supplier' },
  { id: 'company.pan', group: 'header', label: 'Your PAN', layouts: ALL, kind: 'dto' },
  { id: 'company.cin', group: 'header', label: 'Company CIN', layouts: ALL, kind: 'dto' },
  { id: 'company.contact', group: 'header', label: 'Phone, e-mail and website', layouts: ALL, kind: 'dto' },
  { id: 'title', group: 'header', label: 'Document title', layouts: ALL, kind: 'gate', statutory: 'title' },
  { id: 'copyLabel', group: 'header', label: 'Copy label (Original / Duplicate …)', layouts: INV, kind: 'gate', statutory: 'copies' },
  { id: 'endorsement', group: 'header', label: 'Export / SEZ endorsement', layouts: INV, kind: 'dto' },
  { id: 'statutoryNotes', group: 'header', label: 'Statutory notes (reverse charge, composition)', layouts: INV, kind: 'dto', statutory: 'reverseCharge' },
  { id: 'stamp', group: 'header', label: 'CANCELLED / OPTIONAL stamp', layouts: ALL, kind: 'gate', locked: true },
  // Details
  { id: 'doc.number', group: 'details', label: 'Document number', layouts: ALL, kind: 'gate', locked: true },
  { id: 'doc.date', group: 'details', label: 'Date', layouts: ALL, kind: 'gate', locked: true },
  { id: 'refs', group: 'details', label: 'References (order, dispatch, due date)', layouts: INV_STOCK, kind: 'dto' },
  { id: 'placeOfSupply', group: 'details', label: 'Place of supply', layouts: INV, kind: 'dto', statutory: 'placeOfSupply' },
  { id: 'ewayBill', group: 'details', label: 'E-way bill number', layouts: INV_STOCK, kind: 'dto' },
  { id: 'originalInvoice', group: 'details', label: 'Original invoice (credit / debit note)', layouts: INV, kind: 'dto', statutory: 'originalInvoice' },
  // Parties
  { id: 'party', group: 'parties', label: 'Bill-to party', layouts: ALL, kind: 'gate', statutory: 'recipient' },
  { id: 'party.gstin', group: 'parties', label: "Party's GSTIN and PAN", layouts: INV_STOCK, kind: 'dto', statutory: 'recipientGstin' },
  { id: 'party.contact', group: 'parties', label: "Party's phone and e-mail", layouts: ALL, kind: 'dto' },
  { id: 'consignee', group: 'parties', label: 'Ship-to (consignee)', layouts: INV_STOCK, kind: 'dto', statutory: 'delivery' },
  // Item columns
  { id: 'col.sno', group: 'columns', label: 'S.No.', layouts: INV_STOCK, kind: 'column' },
  { id: 'col.description', group: 'columns', label: 'Description', layouts: INV_STOCK, kind: 'column', locked: true },
  { id: 'col.hsn', group: 'columns', label: 'HSN/SAC', layouts: INV, kind: 'column', statutory: 'hsn' },
  { id: 'col.batch', group: 'columns', label: 'Batch', layouts: INV_STOCK, kind: 'column' },
  { id: 'col.qty', group: 'columns', label: 'Quantity', layouts: INV_STOCK, kind: 'column', statutory: 'quantity' },
  { id: 'col.unit', group: 'columns', label: 'Unit', layouts: INV_STOCK, kind: 'column', statutory: 'quantity' },
  { id: 'col.mrp', group: 'columns', label: 'MRP', layouts: INV, kind: 'legacy', legacy: { company: 'showMrp', voucherType: 'showMrp' } },
  { id: 'col.rate', group: 'columns', label: 'Rate', layouts: INV_STOCK, kind: 'column' },
  { id: 'col.discount', group: 'columns', label: 'Discount', layouts: INV, kind: 'column' },
  { id: 'col.taxable', group: 'columns', label: 'Taxable value', layouts: INV, kind: 'column', statutory: 'taxableValue' },
  { id: 'col.gstRate', group: 'columns', label: 'GST rate', layouts: INV, kind: 'column', statutory: 'tax' },
  { id: 'lineTax', group: 'columns', label: 'Tax amount on each line', layouts: INV, kind: 'legacy', legacy: { company: 'itemwiseTax', voucherType: 'itemwiseTax' } },
  { id: 'col.cgst', group: 'columns', label: 'CGST column', layouts: INV, kind: 'column', statutory: 'tax' },
  { id: 'col.sgst', group: 'columns', label: 'SGST / UTGST column', layouts: INV, kind: 'column', statutory: 'tax' },
  { id: 'col.igst', group: 'columns', label: 'IGST column', layouts: INV, kind: 'column', statutory: 'tax' },
  { id: 'col.cess', group: 'columns', label: 'Cess column', layouts: INV, kind: 'column', statutory: 'tax' },
  { id: 'col.amount', group: 'columns', label: 'Amount', layouts: INV_STOCK, kind: 'column' },
  // Totals and words
  { id: 'totals.taxable', group: 'totals', label: 'Taxable value total', layouts: INV, kind: 'total', statutory: 'taxableValue' },
  { id: 'totals.taxHeads', group: 'totals', label: 'Tax totals (CGST, SGST, IGST, cess)', layouts: INV, kind: 'total', statutory: 'tax' },
  { id: 'totals.charges', group: 'totals', label: 'Other charges', layouts: INV, kind: 'total' },
  { id: 'totals.roundOff', group: 'totals', label: 'Round off', layouts: INV, kind: 'total' },
  { id: 'totals.grand', group: 'totals', label: 'Grand total', layouts: INV_VCH, kind: 'total', locked: true },
  { id: 'mrpSaved', group: 'totals', label: '"You saved" against MRP', layouts: INV, kind: 'gate' },
  { id: 'amountInWords', group: 'totals', label: 'Amount in words', layouts: ALL, kind: 'gate' },
  { id: 'taxInWords', group: 'totals', label: 'Tax amount in words', layouts: INV, kind: 'gate' },
  { id: 'hsnSummary', group: 'totals', label: 'HSN/SAC summary', layouts: INV, kind: 'legacy', legacy: { company: 'showHsnSummary', voucherType: 'showHsnSummary' }, statutory: 'hsn' },
  { id: 'taxSummary', group: 'totals', label: 'Tax summary by rate', layouts: INV, kind: 'gate' },
  // Payment
  { id: 'bank', group: 'payment', label: 'Bank details', layouts: INV, kind: 'legacy', legacy: { company: 'showBankDetails', voucherType: 'showBankDetails' } },
  { id: 'upiQr', group: 'payment', label: 'UPI QR code', layouts: INV, kind: 'legacy', legacy: { company: 'showUpiQr', voucherType: 'showUpiQr' } },
  { id: 'forex', group: 'payment', label: 'Foreign-currency amounts', layouts: INV_VCH, kind: 'dto' },
  { id: 'pos', group: 'payment', label: 'Payment received at the counter', layouts: INV, kind: 'dto' },
  // E-invoice
  { id: 'einvoice', group: 'einvoice', label: 'E-invoice IRN and QR code', layouts: INV, kind: 'dto', statutory: 'einvoice' },
  // Footer
  { id: 'narration', group: 'footer', label: 'Narration', layouts: ALL, kind: 'dto' },
  { id: 'declaration', group: 'footer', label: 'Declaration', layouts: INV, kind: 'dto' },
  { id: 'terms', group: 'footer', label: 'Terms and conditions', layouts: INV, kind: 'dto' },
  { id: 'notes', group: 'footer', label: 'Notes', layouts: ALL, kind: 'gate' },
  { id: 'signature', group: 'footer', label: 'Signature', layouts: ALL, kind: 'gate', statutory: 'signature' },
  { id: 'generatedLine', group: 'footer', label: '"Computer-generated" line', layouts: ALL, kind: 'gate' },
  { id: 'footer', group: 'footer', label: 'Footer line', layouts: ALL, kind: 'gate' },
  { id: 'pageNumbers', group: 'footer', label: 'Page numbers', layouts: ALL, kind: 'page' },
  // Voucher layouts
  { id: 'entries', group: 'voucher', label: 'Ledger entries', layouts: VCH, kind: 'gate', locked: true },
  { id: 'receivedBy', group: 'voucher', label: '"Received by" signature lines', layouts: VCH, kind: 'gate' },
] as const satisfies readonly PrintPartDef[];

export type PrintPartId = (typeof PRINT_PARTS)[number]['id'];

// ───────────────────────────── Text catalogue (§7.3) ─────────────────────────────

export const PRINT_TEXTS = [
  { id: 'title', label: 'Document title', max: 60, legacy: { voucherType: 'printTitle' } },
  { id: 'copy.original', label: 'Copy label: original', max: 40 },
  { id: 'copy.duplicate', label: 'Copy label: duplicate', max: 40 },
  { id: 'copy.triplicate', label: 'Copy label: triplicate', max: 40 },
  { id: 'label.party', label: '"Bill to" label', max: 40 },
  { id: 'label.consignee', label: '"Ship to" label', max: 40 },
  { id: 'col.description', label: 'Column heading: description', max: 24 },
  { id: 'col.hsn', label: 'Column heading: HSN/SAC', max: 24 },
  { id: 'col.qty', label: 'Column heading: quantity', max: 24 },
  { id: 'col.rate', label: 'Column heading: rate', max: 24 },
  { id: 'col.discount', label: 'Column heading: discount', max: 24 },
  { id: 'col.taxable', label: 'Column heading: taxable value', max: 24 },
  { id: 'col.amount', label: 'Column heading: amount', max: 24 },
  { id: 'label.amountInWords', label: '"Amount in words" label', max: 40 },
  { id: 'label.total', label: '"Total" label', max: 30 },
  { id: 'declaration', label: 'Declaration', max: 2000, multiline: true, legacy: { company: 'declaration', voucherType: 'declaration' } },
  { id: 'terms', label: 'Terms and conditions', max: 4000, multiline: true, legacy: { company: 'terms', voucherType: 'terms' } },
  { id: 'notes', label: 'Notes printed above the terms', max: 1000, multiline: true },
  { id: 'signatoryLabel', label: 'Signatory label', max: 100, legacy: { company: 'signatoryLabel' } },
  { id: 'signFor', label: '"For {company}" line', max: 120 },
  { id: 'footer', label: 'Footer line', max: 200, multiline: true },
  { id: 'generatedLine', label: '"Computer-generated" text', max: 120 },
] as const satisfies readonly PrintTextDef[];

export type PrintTextId = (typeof PRINT_TEXTS)[number]['id'];

const PART_BY_ID: ReadonlyMap<string, PrintPartDef> = new Map(PRINT_PARTS.map((p) => [p.id, p as PrintPartDef]));
const TEXT_BY_ID: ReadonlyMap<string, PrintTextDef> = new Map(PRINT_TEXTS.map((t) => [t.id, t as PrintTextDef]));

export function printPart(id: string): PrintPartDef | undefined {
  return PART_BY_ID.get(id);
}

export function printTextDef(id: string): PrintTextDef | undefined {
  return TEXT_BY_ID.get(id);
}

export function isPrintPartId(id: unknown): id is PrintPartId {
  return typeof id === 'string' && PART_BY_ID.has(id);
}

export function isPrintTextId(id: unknown): id is PrintTextId {
  return typeof id === 'string' && TEXT_BY_ID.has(id);
}

/** Parts of the catalogue that apply to a family of documents (the editor intersects with the template's SUPPORTED_PARTS). */
export function partsForLayout(layout: PrintLayout): PrintPartDef[] {
  return (PRINT_PARTS as readonly PrintPartDef[]).filter((p) => p.layouts.includes(layout));
}

/**
 * The option key that owns `def` at a level, if any. The per-print level uses the preview overrides
 * (`print.voucherData { overrides }`, a partial `config.invoice`), so its owner is the company key.
 */
export function legacyKeyAt(def: PrintPartDef | PrintTextDef, level: PrintLayoutLevel): string | undefined {
  return level === 'voucherType' ? def.legacy?.voucherType : def.legacy?.company;
}

// ───────────────────────────── Stored shape ─────────────────────────────

/** Stored shape (company config, voucher-type config, session). Arrays only — mergeDefaults-safe. */
export interface PrintLayoutSpec {
  hide: PrintPartId[];
  /** Beats a lower layer's hide. */
  show: PrintPartId[];
  /** '' = print nothing for that text; an absent id inherits. */
  text: Array<{ id: PrintTextId; value: string }>;
}

/** The empty layer (today's output). Frozen: copy it before changing it. */
export const EMPTY_PRINT_LAYOUT: PrintLayoutSpec = Object.freeze({
  hide: Object.freeze([]) as unknown as PrintPartId[],
  show: Object.freeze([]) as unknown as PrintPartId[],
  text: Object.freeze([]) as unknown as PrintLayoutSpec['text'],
});

/** A fresh, mutable empty layer. */
export function emptyPrintLayout(): PrintLayoutSpec {
  return { hide: [], show: [], text: [] };
}

export function isEmptyPrintLayout(spec: PrintLayoutSpec | null | undefined): boolean {
  return !spec || (spec.hide.length === 0 && spec.show.length === 0 && spec.text.length === 0);
}

export interface ResolvedPrintLayout {
  hidden: ReadonlySet<PrintPartId>;
  texts: ReadonlyMap<PrintTextId, string>;
  /** Parts a layer explicitly shows and no higher layer hides (e.g. `company.pan` kept while the GSTIN is hidden). */
  shown?: ReadonlySet<PrintPartId>;
}

const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/**
 * company ‹ voucherType ‹ print. hidden = ((company.hide) − vt.show ∪ vt.hide) − print.show ∪ print.hide,
 * minus locked parts. Within one layer `hide` wins over `show`. Texts: the highest layer that names a text
 * wins ('' included — it prints nothing). Unknown ids and malformed entries are ignored, so a stale session
 * layer can never break printing.
 */
export function resolvePrintLayout(...layers: Array<PrintLayoutSpec | null | undefined>): ResolvedPrintLayout {
  const hidden = new Set<PrintPartId>();
  const shown = new Set<PrintPartId>();
  const texts = new Map<PrintTextId, string>();
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const id of listOf(layer.show)) {
      if (!isPrintPartId(id)) continue;
      hidden.delete(id);
      shown.add(id);
    }
    for (const id of listOf(layer.hide)) {
      if (!isPrintPartId(id) || PART_BY_ID.get(id)?.locked) continue;
      hidden.add(id);
      shown.delete(id);
    }
    for (const t of listOf(layer.text)) {
      if (!t || typeof t !== 'object') continue;
      const { id, value } = t as { id?: unknown; value?: unknown };
      if (isPrintTextId(id) && typeof value === 'string') texts.set(id, value);
    }
  }
  return { hidden, texts, shown };
}

/** Which level a part's visibility (or a text's value) comes from — for the editor ("Hidden for Sales"). */
export function layoutSource(
  layers: { company?: PrintLayoutSpec | null; voucherType?: PrintLayoutSpec | null; print?: PrintLayoutSpec | null },
  id: PrintPartId | PrintTextId,
  what: 'part' | 'text' = 'part',
): 'default' | 'company' | 'voucherType' | 'print' {
  const order: Array<'print' | 'voucherType' | 'company'> = ['print', 'voucherType', 'company'];
  for (const level of order) {
    const l = layers[level];
    if (!l) continue;
    if (what === 'part' ? listOf(l.hide).includes(id) || listOf(l.show).includes(id) : listOf(l.text).some((t) => (t as { id?: unknown } | null)?.id === id)) {
      return level;
    }
  }
  return 'default';
}

// ───────────────────────────── Validation ─────────────────────────────

export interface PrintLayoutIssue {
  path: string;
  message: string;
}

/** Most entries accepted per list (hide / show / text). */
export const PRINT_LAYOUT_MAX_ENTRIES = 200;

// Control characters (C0 except newline, DEL, C1). Built from code points so the source stays plain ASCII.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(9)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`, 'g');

/**
 * Clean one text value: tabs become spaces, other control characters are dropped (newlines kept on
 * multi-line texts, else spaces), clipped to max.
 */
export function cleanPrintText(def: PrintTextDef, value: string): { value: string; clipped: boolean } {
  let s = value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  if (!def.multiline) s = s.replace(/\n/g, ' ');
  s = s.replace(CONTROL, '');
  if (s.length <= def.max) return { value: s, clipped: false };
  let cut = s.slice(0, def.max);
  // Never leave half a surrogate pair at the end.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { value: cut, clipped: true };
}

/** Where the option that owns a part / text is changed, per level (plain words for the refusal message). */
const LEVEL_OWNER: Record<PrintLayoutLevel, string> = {
  company: 'Invoice Printing',
  voucherType: 'the voucher type',
  print: 'the print options',
};

const ownedMessage = (def: PrintPartDef | PrintTextDef, level: PrintLayoutLevel): string => `${def.label} has its own setting in ${LEVEL_OWNER[level]}`;

/**
 * Untrusted → clean spec: unknown, locked and legacy-at-this-level ids dropped, at most 200 entries per
 * list, texts clipped to their max, control characters (except newlines in multi-line texts) stripped,
 * duplicate ids collapsed (a text named twice keeps its last value; a part both hidden and shown in the
 * same layer stays hidden). Every dropped or changed entry is an issue (paths relative to the spec) — the
 * save routes refuse a spec with issues; print data logs them and uses the clean value.
 */
export function validatePrintLayout(x: unknown, level: PrintLayoutLevel): { value: PrintLayoutSpec; issues: PrintLayoutIssue[] } {
  const issues: PrintLayoutIssue[] = [];
  const value = emptyPrintLayout();
  if (x === null || x === undefined) return { value, issues };
  if (typeof x !== 'object' || Array.isArray(x)) {
    issues.push({ path: '', message: 'A print layout must be an object with hide, show and text lists' });
    return { value, issues };
  }
  const src = x as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (key !== 'hide' && key !== 'show' && key !== 'text' && src[key] !== undefined) {
      const name = key.slice(0, 40);
      issues.push({ path: name, message: `Unknown field "${name}"` });
    }
  }
  const entries = (key: 'hide' | 'show' | 'text'): unknown[] => {
    const raw = src[key];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      issues.push({ path: key, message: `${key} must be a list` });
      return [];
    }
    if (raw.length > PRINT_LAYOUT_MAX_ENTRIES) {
      issues.push({ path: key, message: `${key} has too many entries (max ${PRINT_LAYOUT_MAX_ENTRIES})` });
      return raw.slice(0, PRINT_LAYOUT_MAX_ENTRIES);
    }
    return raw;
  };
  const parts = (key: 'hide' | 'show'): PrintPartId[] => {
    const out: PrintPartId[] = [];
    entries(key).forEach((id, i) => {
      const path = `${key}[${i}]`;
      if (typeof id !== 'string') return void issues.push({ path, message: 'Each entry must be a part id' });
      const def = PART_BY_ID.get(id);
      if (!def) return void issues.push({ path, message: `"${id.slice(0, 60)}" is not a part of a printed document` });
      if (def.locked) return void issues.push({ path, message: `${def.label} is always printed` });
      const owner = legacyKeyAt(def, level);
      if (owner) return void issues.push({ path, message: ownedMessage(def, level) });
      if (!out.includes(id as PrintPartId)) out.push(id as PrintPartId);
    });
    return out;
  };
  value.hide = parts('hide');
  value.show = parts('show').filter((id) => !value.hide.includes(id));
  const texts = new Map<PrintTextId, string>();
  entries('text').forEach((t, i) => {
    const path = `text[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return void issues.push({ path, message: 'Each text must be { id, value }' });
    const { id, value: raw } = t as { id?: unknown; value?: unknown };
    if (typeof id !== 'string') return void issues.push({ path: `${path}.id`, message: 'The text id is missing' });
    const def = TEXT_BY_ID.get(id);
    if (!def) return void issues.push({ path: `${path}.id`, message: `"${id.slice(0, 60)}" is not a printed text` });
    const owner = legacyKeyAt(def, level);
    if (owner) return void issues.push({ path: `${path}.id`, message: ownedMessage(def, level) });
    if (typeof raw !== 'string') return void issues.push({ path: `${path}.value`, message: `${def.label} must be text` });
    const clean = cleanPrintText(def, raw);
    if (clean.clipped) issues.push({ path: `${path}.value`, message: `${def.label} is too long (${def.max.toLocaleString('en-IN')} characters at most)` });
    texts.delete(id as PrintTextId);
    texts.set(id as PrintTextId, clean.value);
  });
  value.text = [...texts].map(([id, v]) => ({ id, value: v }));
  return { value, issues };
}

/**
 * The stored layers of one document as core passes them through: an entry a higher level's legacy key
 * already decides is dropped from the lower layer, so resolution order stays company ‹ voucher type ‹ print
 * even where an option key owns a text at one level only. Today that is (a) the company `title` text
 * when the voucher type has a Print title, and (b) the voucher-type `signatoryLabel` text when the preview
 * overrides set the signatory label.
 */
export function shadowedByLegacy(
  layers: { company: PrintLayoutSpec; voucherType: PrintLayoutSpec },
  set: { voucherType?: Readonly<Record<string, unknown>> | null; overrides?: Readonly<Record<string, unknown>> | null },
): { company: PrintLayoutSpec; voucherType: PrintLayoutSpec } {
  const isSet = (o: Readonly<Record<string, unknown>> | null | undefined, k: string | undefined): boolean => {
    if (!o || !k) return false;
    const val = o[k];
    return val !== undefined && val !== null && !(typeof val === 'string' && val.trim() === '');
  };
  const byOverrides = (def: PrintPartDef | PrintTextDef): boolean => isSet(set.overrides, def.legacy?.company);
  const byVoucherType = (def: PrintPartDef | PrintTextDef): boolean => isSet(set.voucherType, def.legacy?.voucherType);
  const strip = (spec: PrintLayoutSpec, drop: (def: PrintPartDef | PrintTextDef) => boolean): PrintLayoutSpec => {
    const keepPart = (id: PrintPartId): boolean => !drop(PART_BY_ID.get(id) as PrintPartDef);
    const hide = spec.hide.filter(keepPart);
    const show = spec.show.filter(keepPart);
    const text = spec.text.filter((t) => !drop(TEXT_BY_ID.get(t.id) as PrintTextDef));
    return hide.length === spec.hide.length && show.length === spec.show.length && text.length === spec.text.length ? spec : { hide, show, text };
  };
  return {
    company: strip(layers.company, (d) => byVoucherType(d) || byOverrides(d)),
    voucherType: strip(layers.voucherType, byOverrides),
  };
}

// ───────────────────────────── Application ─────────────────────────────

/** True unless applyPrintLayout hid the part on this document (templates' gate). */
export function isPartShown(doc: Pick<PrintVoucherData, 'applied'>, id: PrintPartId): boolean {
  return !doc.applied || !doc.applied.hidden.includes(id);
}

/** The replaced wording of a text on this document, or `fallback` when no layer changed it ('' prints nothing). */
export function printText(doc: Pick<PrintVoucherData, 'applied'>, id: PrintTextId, fallback: string): string {
  const texts = doc.applied?.texts;
  return texts && Object.prototype.hasOwnProperty.call(texts, id) ? (texts[id] as string) : fallback;
}

function withoutGstin(a: PrintAddress): PrintAddress {
  return { ...a, gstin: null, pan: null, registrationType: null };
}

function withoutContact(a: PrintAddress): PrintAddress {
  return { ...a, phone: null, email: null };
}

/**
 * A NEW PrintVoucherData with hidden parts removed and texts replaced. Never mutates `doc`; the money
 * fields (lines, totals, charges, taxByRate, taxByHsn, entries, upi, mrpSummary, forex, pos amounts) are
 * passed through by reference. `applied` records the hidden ids and replaced texts for the template gates.
 */
export function applyPrintLayout(doc: PrintVoucherData, layout: ResolvedPrintLayout): PrintVoucherData {
  const out: PrintVoucherData = { ...doc };
  const h = (id: PrintPartId): boolean => layout.hidden.has(id);
  // Header: company block.
  if (h('logo') || h('company.gstin') || h('company.pan') || h('company.cin') || h('company.contact')) {
    const c = { ...doc.company };
    if (h('logo')) c.logo = null;
    if (h('company.gstin')) {
      c.gstin = null;
      // The PAN is part of the GSTIN: hiding the GSTIN hides it too unless a layer explicitly shows it.
      if (!layout.shown?.has('company.pan')) c.pan = null;
    }
    if (h('company.pan')) c.pan = null;
    if (h('company.cin')) c.cin = null;
    if (h('company.contact')) {
      c.phone = null;
      c.email = null;
      c.website = null;
    }
    out.company = c;
  }
  if (h('endorsement')) out.endorsement = null;
  if (h('statutoryNotes')) out.notes = [];
  // Details.
  if (h('refs')) {
    out.references = [];
    out.referenceNo = null;
    out.referenceDate = null;
  }
  if (h('placeOfSupply')) out.placeOfSupply = null;
  if (h('ewayBill')) out.ewayBill = null;
  if (h('originalInvoice')) out.originalInvoice = null;
  // Parties. When there is no separate ship-to, the consignee block IS the party: it follows the party.
  if (doc.party && (h('party.gstin') || h('party.contact'))) {
    let p = doc.party;
    if (h('party.gstin')) p = withoutGstin(p);
    if (h('party.contact')) p = withoutContact(p);
    out.party = p;
    if (doc.consigneeSameAsParty && doc.consignee) {
      let c = doc.consignee;
      if (h('party.gstin')) c = withoutGstin(c);
      if (h('party.contact')) c = withoutContact(c);
      out.consignee = c;
    }
  }
  if (h('consignee')) {
    out.consignee = null;
    out.consigneeSameAsParty = false;
  }
  // Payment, e-invoice, footer.
  if (h('forex')) out.forex = null;
  if (h('pos')) out.pos = null;
  if (h('einvoice')) out.einvoice = null;
  if (h('narration')) out.narration = null;
  if (h('declaration')) out.declaration = null;
  if (h('terms')) out.terms = null;

  // Texts that have a DTO field are written into it; every replaced text is also in `applied.texts`.
  const texts: Record<string, string> = {};
  let copies = doc.copyLabels;
  for (const [id, value] of layout.texts) {
    texts[id] = value;
    switch (id) {
      case 'title':
        out.title = value;
        break;
      case 'copy.original':
        copies = { ...copies, original: value };
        break;
      case 'copy.duplicate':
        copies = { ...copies, duplicate: value };
        break;
      case 'copy.triplicate':
        copies = { ...copies, triplicate: value };
        break;
      case 'label.party':
        out.partyLabel = value;
        break;
      case 'label.consignee':
        out.consigneeLabel = value;
        break;
      case 'declaration':
        if (!h('declaration')) out.declaration = value === '' ? null : value;
        break;
      case 'terms':
        if (!h('terms')) out.terms = value === '' ? null : value;
        break;
      case 'signatoryLabel':
        out.signatoryLabel = value;
        break;
      default:
        break;
    }
  }
  if (copies !== doc.copyLabels) out.copyLabels = copies;
  out.applied = { hidden: [...layout.hidden].sort(), texts };
  return out;
}

// ───────────────────────────── Statutory guard (§7.5) ─────────────────────────────

type RuleFamily = '46' | '49' | '53' | '55';

const FAMILY: Partial<Record<PrintDocKind, RuleFamily>> = {
  tax_invoice: '46',
  invoice_cum_bill_of_supply: '46',
  export_invoice: '46',
  sez_invoice: '46',
  self_invoice: '46',
  bill_of_supply: '49',
  credit_note: '53',
  debit_note: '53',
  delivery_challan: '55',
};

const DOC_NAME: Partial<Record<PrintDocKind, string>> = {
  tax_invoice: 'tax invoice',
  invoice_cum_bill_of_supply: 'invoice-cum-bill of supply',
  export_invoice: 'export invoice',
  sez_invoice: 'SEZ invoice',
  self_invoice: 'self invoice',
  bill_of_supply: 'bill of supply',
  credit_note: 'credit note',
  debit_note: 'debit note',
  delivery_challan: 'delivery challan',
};

/** The word a document's title must contain, per family / kind. */
function titleWord(kind: PrintDocKind): { re: RegExp; word: string } | null {
  if (kind === 'bill_of_supply') return { re: /bill\s+of\s+supply/i, word: 'Bill of Supply' };
  if (kind === 'credit_note') return { re: /credit\s+note/i, word: 'Credit Note' };
  if (kind === 'debit_note') return { re: /debit\s+note/i, word: 'Debit Note' };
  if (kind === 'delivery_challan') return { re: /challan/i, word: 'Challan' };
  if (FAMILY[kind] === '46') return { re: /invoice/i, word: 'Invoice' };
  return null;
}

/** Citation of a particular for a family; null when the particular is not required on that family. */
function cite(key: LayoutRuleKey, family: RuleFamily): string | null {
  const table: Record<LayoutRuleKey, Partial<Record<RuleFamily, string>>> = {
    supplier: { '46': 'Rule 46(a)', '49': 'Rule 49', '53': 'Rule 53', '55': 'Rule 55' },
    recipient: { '46': 'Rule 46(d), (e)', '49': 'Rule 49', '53': 'Rule 53', '55': 'Rule 55' },
    recipientGstin: { '46': 'Rule 46(d)', '49': 'Rule 49', '53': 'Rule 53', '55': 'Rule 55' },
    delivery: { '46': 'Rule 46(o)', '55': 'Rule 55' },
    hsn: { '46': 'Rule 46(g)', '49': 'Rule 49', '55': 'Rule 55' },
    quantity: { '46': 'Rule 46(i)', '55': 'Rule 55' },
    taxableValue: { '46': 'Rule 46(k)', '49': 'Rule 49', '53': 'Rule 53', '55': 'Rule 55' },
    tax: { '46': 'Rule 46(l), (m)', '53': 'Rule 53' },
    placeOfSupply: { '46': 'Rule 46(n)', '55': 'Rule 55' },
    reverseCharge: { '46': 'Rule 46(p)' },
    signature: { '46': 'Rule 46(q)', '49': 'Rule 49', '53': 'Rule 53', '55': 'Rule 55' },
    copies: { '46': 'Rule 48(1)' },
    einvoice: { '46': 'Rule 48(4)', '53': 'Rule 48(4)' },
    title: { '46': 'Rule 46', '49': 'Rule 49', '53': 'Rule 53', '55': 'Rule 55' },
    originalInvoice: { '53': 'Rule 53' },
  };
  return table[key][family] ?? null;
}

const INWARD_NATURE = /^(inward_|import_)/;

/** Unregistered recipient: name and address are required from this taxable value (Rule 46(e)). */
const B2C_PARTICULARS_PAISE = 50_000_00;

/**
 * Plain-language warnings for statutory particulars hidden on this document (one line each; printing is
 * never blocked). Applies to documents the company issues: tax / export / SEZ / self invoices (Rule 46),
 * bills of supply (Rule 49), credit and debit notes (Rule 53) and delivery challans (Rule 55); an
 * e-invoice's IRN and QR code on any document that has them. A particular the document does not carry
 * (no buyer GSTIN, intra-State supply, services only …) is not warned about. Legacy parts are judged by the
 * resolved options on the document (Show HSN summary …). On a self invoice (reverse charge on a purchase
 * from an unregistered supplier) the party is the supplier (Rule 46(a), whatever the value) and the
 * company is the recipient (Rule 46(d)).
 *
 * `doc` is the document as core built it — NOT the result of applyPrintLayout, which has already removed
 * the hidden values these checks look at.
 */
export function layoutWarnings(doc: PrintVoucherData, layout: ResolvedPrintLayout): string[] {
  const out: string[] = [];
  const hidden = (id: PrintPartId): boolean => layout.hidden.has(id);
  const warn = (key: LayoutRuleKey, family: RuleFamily | null, what: string, where: string, citation?: string): void => {
    const c = citation ?? (family ? cite(key, family) : LAYOUT_RULES[key].rule);
    if (c) out.push(`Hidden on this print: ${what} — required on ${where} (${c}).`);
  };

  // E-invoice: any document carrying an IRN.
  if (doc.einvoice && hidden('einvoice')) {
    out.push(`Hidden on this print: ${LAYOUT_RULES.einvoice.what} — an e-invoice must show them (${LAYOUT_RULES.einvoice.rule}).`);
  }

  const family = FAMILY[doc.kind];
  if (!family) return out;
  const nature = doc.gst.nature ?? '';
  // A debit note to a supplier (purchase return) is not a document the company issues under GST.
  if (doc.kind !== 'self_invoice' && (INWARD_NATURE.test(nature) || (doc.kind === 'debit_note' && /^supplier/i.test(doc.partyLabel)))) return out;
  const name = DOC_NAME[doc.kind] ?? 'invoice';
  const a = (s: string): string => (/^[aeiou]/i.test(s) || /^SEZ/.test(s) ? `an ${s}` : `a ${s}`);
  const onDoc = a(name);
  // Self invoice: the company is the recipient, the party the (unregistered) supplier.
  const selfInvoice = doc.kind === 'self_invoice';
  const own = selfInvoice ? 'Rule 46(d)' : undefined;

  // Supplier (company block).
  if (hidden('company.name')) warn('supplier', family, 'your business name', onDoc, own);
  if (hidden('company.address') && doc.company.address) warn('supplier', family, 'your address', onDoc, own);
  if (hidden('company.gstin') && doc.company.gstin) warn('supplier', family, 'your GSTIN', onDoc, own);

  // Title.
  const tw = titleWord(doc.kind);
  const titleText = layout.texts.get('title');
  if (hidden('title') || titleText === '') warn('title', family, 'the document title', onDoc);
  else if (tw && titleText !== undefined && !tw.re.test(titleText)) {
    const c = cite('title', family);
    out.push(`The title "${titleText}" does not say "${tw.word}" — ${onDoc} must be titled as one (${c}).`);
  }

  // Recipient.
  const p = doc.party;
  const registered = !!p?.gstin;
  if (p && selfInvoice) {
    if (hidden('party')) warn('recipient', family, "the supplier's name and address", onDoc, 'Rule 46(a)');
    else if (registered && hidden('party.gstin')) warn('recipientGstin', family, "the supplier's GSTIN", onDoc, 'Rule 46(a)');
  } else {
    if (p && hidden('party') && (family !== '46' || registered || doc.totals.taxable >= B2C_PARTICULARS_PAISE)) {
      warn('recipient', family, family === '55' ? "the consignee's name and address" : "the buyer's name and address", onDoc);
    }
    if (p && registered && !hidden('party') && hidden('party.gstin')) {
      warn('recipientGstin', family, family === '55' ? "the consignee's GSTIN" : "the buyer's GSTIN", family === '46' ? `a B2B ${name}` : onDoc);
    }
  }
  // Delivery address different from the buyer.
  if (doc.consignee && !doc.consigneeSameAsParty && hidden('consignee')) {
    warn('delivery', family, family === '55' ? 'the consignee (ship-to)' : 'the delivery address (ship-to)', family === '46' ? `${onDoc} when goods go to another address` : onDoc);
  }

  // HSN / SAC: the column and the summary both off.
  const hsnSummaryOff = !doc.options.showHsnSummary || doc.layout !== 'invoice' || doc.taxByHsn.length === 0;
  if (doc.lines.some((l) => !!l.hsnSac) && hidden('col.hsn') && hsnSummaryOff) warn('hsn', family, 'the HSN/SAC codes', onDoc);

  // Quantity and unit of goods.
  const goods = doc.lines.some((l) => l.kind === 'item' && l.qty !== null);
  if (goods && hidden('col.qty')) warn('quantity', family, 'the quantity of goods', onDoc);
  if (goods && hidden('col.unit') && doc.lines.some((l) => l.kind === 'item' && !!l.unit)) warn('quantity', family, 'the unit of quantity', onDoc);

  // Taxable value.
  if (doc.lines.length > 0) {
    const valueHidden = doc.layout === 'invoice' ? hidden('col.taxable') && hidden('totals.taxable') : hidden('col.amount');
    if (valueHidden) warn('taxableValue', family, 'the taxable value', onDoc);
  }

  // Rate and amount of tax.
  if (doc.gst.showTax && doc.totals.tax + doc.totals.reverseChargeTax > 0 && hidden('col.gstRate') && hidden('totals.taxHeads')) {
    warn('tax', family, 'the rate and amount of tax', onDoc);
  }

  // Place of supply on an inter-State supply.
  const pos = doc.placeOfSupply;
  const interState = pos !== null && (doc.gst.interState || (doc.company.stateCode !== null && pos.code !== doc.company.stateCode));
  if (pos && interState && hidden('placeOfSupply')) warn('placeOfSupply', family, 'the place of supply', `an inter-State ${name}`);

  // Reverse charge note.
  if (doc.reverseCharge && doc.notes.length > 0 && hidden('statutoryNotes')) warn('reverseCharge', family, 'the reverse-charge note', onDoc);

  // Signature.
  if (hidden('signature')) warn('signature', family, 'the signature', onDoc);

  // Copy marking on the supplier's goods invoices (a self invoice is the recipient's own record).
  if (hidden('copyLabel') && !selfInvoice && doc.layout === 'invoice' && doc.lines.some((l) => l.kind === 'item')) {
    warn('copies', family, LAYOUT_RULES.copies.what, `${onDoc} for goods`);
  }

  // Credit / debit note: the invoice it adjusts.
  if (doc.originalInvoice && hidden('originalInvoice')) warn('originalInvoice', family, LAYOUT_RULES.originalInvoice.what, onDoc);
  return out;
}
