/**
 * Server error / warning paths → screen cells (pure; tested in errorPaths.test.ts).
 *
 * The server speaks VoucherInput paths (`items[2].qty`, `ledgers[0].billAllocations[1].billName`,
 * `partyLedgerId`, `date`). The screen addresses cells by row key: `cellId('items', 'i7', 'qty')`.
 */
import type { VoucherWarning } from '../../../../shared/types/vouchers.ts';
import { ACCOUNT_ROW } from './buildInput.ts';

export type Section = 'items' | 'ledgers';

export interface ParsedPath {
  section: Section | null;
  /** Index into the input array (sections only). */
  index: number | null;
  /** First field after the index ('qty', 'billAllocations'…) or the header field ('partyLedgerId'). */
  field: string | null;
  /** The full remainder after the line ('billAllocations[1].billName'). */
  rest: string | null;
}

export function parsePath(path: string): ParsedPath {
  const m = /^(items|ledgers)(?:\[(\d+)\])?(?:\.(.+))?$/.exec(path.trim());
  if (m) {
    const rest = m[3] ?? null;
    const field = rest ? (/^([A-Za-z]+)/.exec(rest)?.[1] ?? null) : null;
    return { section: m[1] as Section, index: m[2] === undefined ? null : Number(m[2]), field, rest };
  }
  const head = /^([A-Za-z]+)/.exec(path.trim());
  return { section: null, index: null, field: head ? head[1] : path.trim() || null, rest: null };
}

/** DOM id of a grid cell (also used as the error-map key). */
export function cellId(section: Section, rowKey: string, field: string): string {
  return `vch-${section}-${rowKey}-${field}`;
}

/** DOM id of a header field. */
export function headerId(field: string): string {
  return `vch-h-${field}`;
}

/** Header fields of the form that have their own input (others fall back to the banner). */
const HEADER_FIELDS: Readonly<Record<string, string>> = {
  date: 'date',
  effectiveDate: 'date',
  number: 'number',
  referenceNo: 'referenceNo',
  referenceDate: 'referenceDate',
  partyLedgerId: 'party',
  party: 'party',
  placeOfSupply: 'placeOfSupply',
  priceLevelId: 'priceLevel',
  narration: 'narration',
  originalInvoiceNo: 'originalInvoiceNo',
  originalInvoiceDate: 'originalInvoiceDate',
  voucherTypeId: 'voucherType',
  partyBillAllocations: 'party',
  mode: 'mode',
};

/** Grid column a line field is shown in. */
const ITEM_FIELDS: Readonly<Record<string, string>> = {
  itemId: 'item',
  godownId: 'godown',
  batchName: 'batch',
  mfgDate: 'batch',
  expiryDate: 'batch',
  qty: 'qty',
  billedQty: 'billedQty',
  altQty: 'qty',
  rate: 'rate',
  discountPct: 'disc',
  amount: 'amount',
  ledgerId: 'item',
  gstRateOverride: 'gst',
  trackingRef: 'item',
  orderRef: 'item',
  description: 'item',
};

const LEDGER_FIELDS: Readonly<Record<string, string>> = {
  ledgerId: 'ledger',
  amount: 'amount',
  billAllocations: 'amount',
  costAllocations: 'amount',
  instrument: 'ledger',
  narration: 'ledger',
  gst: 'gst',
};

export interface CellTarget {
  /** DOM id to focus / key in the error map. */
  id: string;
  section: Section | 'header';
  rowKey: string | null;
  column: string;
}

export interface KeyMaps {
  itemKeys: readonly string[];
  ledgerKeys: readonly string[];
}

/** Where a server path points on screen (null when it cannot be placed: show it in the banner). */
export function targetOf(path: string, maps: KeyMaps): CellTarget | null {
  const p = parsePath(path);
  if (p.section === 'items') {
    if (p.index === null) return null;
    const rowKey = maps.itemKeys[p.index];
    if (!rowKey) return null;
    const column = (p.field && ITEM_FIELDS[p.field]) || 'item';
    return { id: cellId('items', rowKey, column), section: 'items', rowKey, column };
  }
  if (p.section === 'ledgers') {
    if (p.index === null) return null;
    const rowKey = maps.ledgerKeys[p.index];
    if (!rowKey) return null;
    if (rowKey === ACCOUNT_ROW) return { id: headerId('account'), section: 'header', rowKey: null, column: 'account' };
    const column = (p.field && LEDGER_FIELDS[p.field]) || 'ledger';
    return { id: cellId('ledgers', rowKey, column), section: 'ledgers', rowKey, column };
  }
  const field = p.field ? HEADER_FIELDS[p.field] : undefined;
  if (!field) return null;
  return { id: headerId(field), section: 'header', rowKey: null, column: field };
}

export interface MappedErrors {
  /** DOM id → message (first message per cell wins). */
  cells: Record<string, string>;
  /** Messages that have no cell on screen. */
  general: string[];
  /** First placed target in input order (to focus). */
  first: CellTarget | null;
}

/** Map VALIDATION field errors (`{ path: message }`) to cells. */
export function mapFieldErrors(fieldErrors: Readonly<Record<string, string>>, maps: KeyMaps): MappedErrors {
  const cells: Record<string, string> = {};
  const general: string[] = [];
  let first: CellTarget | null = null;
  for (const [path, message] of Object.entries(fieldErrors)) {
    const t = targetOf(path, maps);
    if (!t) {
      general.push(message);
      continue;
    }
    if (!(t.id in cells)) cells[t.id] = message;
    if (!first) first = t;
  }
  return { cells, general, first };
}

/** Group warnings by the row they point at (for inline row markers) and the rest (header list). */
export function warningsByRow(warnings: readonly VoucherWarning[], maps: KeyMaps): { rows: Record<string, VoucherWarning[]>; header: VoucherWarning[] } {
  const rows: Record<string, VoucherWarning[]> = {};
  const header: VoucherWarning[] = [];
  for (const w of warnings) {
    const t = w.path ? targetOf(w.path, maps) : null;
    if (t && t.rowKey) (rows[t.rowKey] ??= []).push(w);
    else header.push(w);
  }
  return { rows, header };
}

/** Split save/preview warnings by level. */
export function splitWarnings(warnings: readonly VoucherWarning[]): { block: VoucherWarning[]; confirm: VoucherWarning[]; info: VoucherWarning[] } {
  const block: VoucherWarning[] = [];
  const confirm: VoucherWarning[] = [];
  const info: VoucherWarning[] = [];
  for (const w of warnings) {
    const level = w.level ?? (w.blocking ? 'block' : 'confirm');
    if (level === 'block') block.push(w);
    else if (level === 'confirm') confirm.push(w);
    else info.push(w);
  }
  return { block, confirm, info };
}

/** Read VoucherWarning[] out of an error's details (BUSINESS_RULE) — tolerant of shapes. */
export function warningsOfDetails(details: unknown): { needsConfirmation: boolean; warnings: VoucherWarning[] } {
  if (typeof details !== 'object' || details === null) return { needsConfirmation: false, warnings: [] };
  const d = details as { needsConfirmation?: unknown; warnings?: unknown };
  const raw = Array.isArray(d.warnings) ? d.warnings : [];
  const warnings: VoucherWarning[] = [];
  for (const w of raw) {
    if (typeof w === 'string') warnings.push({ code: 'gst', message: w, blocking: false, level: 'confirm' });
    else if (typeof w === 'object' && w !== null && typeof (w as VoucherWarning).message === 'string') warnings.push(w as VoucherWarning);
  }
  return { needsConfirmation: d.needsConfirmation === true, warnings };
}

/** Inverse of cellId: which grid cell a DOM id names (null for other ids). */
export function parseCellId(id: string | null | undefined): { section: Section; rowKey: string; column: string } | null {
  const m = /^vch-(items|ledgers)-([A-Za-z0-9]+)-([A-Za-z]+)$/.exec(id ?? '');
  return m ? { section: m[1] as Section, rowKey: m[2], column: m[3] } : null;
}

/**
 * The voucher save warnings protocol, translated for the shell's withConfirmation (which lists
 * strings): only `confirm`-level messages are asked about; `info` ones stay inline on the screen.
 * Returns null when the details are not a needs-confirmation request.
 */
export function confirmationRequest(details: unknown): { confirm: string[]; info: VoucherWarning[]; all: VoucherWarning[] } | null {
  const d = warningsOfDetails(details);
  if (!d.needsConfirmation) return null;
  const s = splitWarnings(d.warnings);
  const confirm = s.confirm.map((w) => w.message);
  return { confirm: confirm.length > 0 ? confirm : d.warnings.filter((w) => w.level !== 'info').map((w) => w.message), info: s.info, all: d.warnings };
}
