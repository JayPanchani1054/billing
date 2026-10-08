/**
 * Opening stock grid of the stock item form (pure, tested in opening.test.ts).
 *
 * Each row holds quantity (base unit), rate (rupees per base unit, like voucher lines) and value
 * (paise). The value is calculated as round(qty × rate × 100) paise until the user types a value
 * of their own (override, as in Tally): from then on the value is kept when the quantity changes,
 * the rate shown is value ÷ qty, and only the value is sent (the core derives the rate). Typing a
 * rate again switches the row back to calculated.
 */
import type { StockOpeningInput, StockOpeningRow } from '../../../../shared/types/inventory.ts';
import { MAX_LINE_PAISE } from '../../../../shared/gst/index.ts';
import { lineAmount, roundTo } from '../../../../shared/money.ts';
import { formatMoney } from '../../../../shared/format.ts';

/** Largest opening quantity the core accepts (base units). */
export const MAX_OPENING_QTY = 1e12;

/** Decimal places of rate inputs (₹ per base unit). The core may store more (e.g. a rate worked out as value ÷ qty). */
export const RATE_DECIMALS = 4;

/**
 * True when `next` is only `current` as an input showing `decimals` places displays it — what a
 * number field commits when the user merely moves through it (Enter / Tab). Such a commit must not
 * count as an edit: re-saving 0.333333 as 0.3333 would change a value worked out from it.
 */
export function isShownValue(next: number | null, current: number | null, decimals: number): boolean {
  return next !== null && current !== null && next !== current && roundTo(current, decimals) === next;
}

export interface OpeningDraft {
  /** Stable React key. */
  key: string;
  godownId: number | null;
  batchName: string;
  mfgDate: string | null;
  expiryDate: string | null;
  qty: number | null;
  /** Rupees per base unit, as typed. */
  rate: number | null;
  /** Paise — the user's own value while `valueOverridden`, else the last calculated value. */
  value: number | null;
  valueOverridden: boolean;
}

let seq = 0;
/** A fresh key for a new grid row. */
export function newRowKey(prefix = 'o'): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export function emptyOpening(godownId: number | null = null): OpeningDraft {
  return { key: newRowKey(), godownId, batchName: '', mfgDate: null, expiryDate: null, qty: null, rate: null, value: null, valueOverridden: false };
}

/** qty × rate in paise (rounded once), or null until both are known. */
export function calculatedValue(qty: number | null, rate: number | null): number | null {
  if (qty === null || rate === null || !Number.isFinite(qty) || !Number.isFinite(rate)) return null;
  const raw = qty * rate * 100;
  if (!Number.isFinite(raw) || Math.abs(raw) > MAX_LINE_PAISE) return null;
  return lineAmount(qty, rate);
}

/** The value the row will be saved with (paise), or null when it cannot be worked out yet. */
export function rowValue(row: OpeningDraft): number | null {
  return row.valueOverridden ? row.value : calculatedValue(row.qty, row.rate);
}

/** The rate shown for the row: as typed, or value ÷ qty (4 decimals) for an overridden value. */
export function rowRate(row: OpeningDraft): number | null {
  if (!row.valueOverridden) return row.rate;
  if (row.value === null || row.qty === null || !(row.qty > 0)) return null;
  return roundTo(row.value / 100 / row.qty, 4);
}

export type OpeningField = 'godownId' | 'batchName' | 'mfgDate' | 'expiryDate' | 'qty' | 'rate' | 'value';

/** Apply one cell edit and keep value/rate consistent (see the module comment). */
export function editOpening(row: OpeningDraft, field: OpeningField, v: number | string | null): OpeningDraft {
  switch (field) {
    case 'godownId':
      return { ...row, godownId: typeof v === 'number' ? v : null };
    case 'batchName':
      return { ...row, batchName: typeof v === 'string' ? v : '' };
    case 'mfgDate':
      return { ...row, mfgDate: typeof v === 'string' && v ? v : null };
    case 'expiryDate':
      return { ...row, expiryDate: typeof v === 'string' && v ? v : null };
    case 'qty': {
      const qty = typeof v === 'number' ? v : null;
      return row.valueOverridden ? { ...row, qty } : { ...row, qty, value: calculatedValue(qty, row.rate) };
    }
    case 'rate': {
      const rate = typeof v === 'number' ? v : null;
      // Moving through the cell re-formats a stored 6-decimal rate to 4 decimals: not an edit.
      if (!row.valueOverridden && isShownValue(rate, row.rate, RATE_DECIMALS)) return row;
      return { ...row, rate, valueOverridden: false, value: calculatedValue(row.qty, rate) };
    }
    case 'value': {
      const value = typeof v === 'number' ? Math.round(v) : null;
      const calc = calculatedValue(row.qty, row.rate);
      // Clearing the value, or typing exactly the calculated one, goes back to calculated.
      if (value === null || (calc !== null && value === calc)) return { ...row, valueOverridden: false, value: calc };
      // Keep the effective rate visible as the typed rate when the user later un-overrides.
      return { ...row, value, valueOverridden: true };
    }
  }
}

/** A row with nothing typed (ignored on save). The godown alone does not count. */
export function isBlankOpening(row: OpeningDraft): boolean {
  return row.qty === null && row.rate === null && (row.value === null || !row.valueOverridden) && row.batchName.trim() === '' && row.mfgDate === null && row.expiryDate === null;
}

export interface OpeningTotals {
  qty: number;
  /** Paise. */
  value: number;
  /** Weighted rate (rupees per base unit), 0 without quantity. */
  rate: number;
}

/** Totals of the non-blank rows (quantities in base units, value in paise). */
export function openingTotals(rows: readonly OpeningDraft[]): OpeningTotals {
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    if (isBlankOpening(r)) continue;
    qty += r.qty ?? 0;
    value += rowValue(r) ?? 0;
  }
  qty = roundTo(qty, 6);
  return { qty, value, rate: qty > 0 ? roundTo(value / 100 / qty, 4) : 0 };
}

export interface OpeningContext {
  /** Godown column shown and required (multipleGodowns feature on). */
  multipleGodowns: boolean;
  /** Batch columns shown (item maintained in batches and Batches feature on). */
  batches: boolean;
  /** Mfg / expiry columns shown. */
  trackMfgDate: boolean;
  useExpiry: boolean;
  unitSymbol: string;
  unitDecimals: number;
}

const decimalsOk = (qty: number, places: number): boolean => Math.abs(roundTo(qty, places) - qty) < 1e-9;

/** Problems per cell, keyed `${rowIndex}.${field}` (index into `rows`, blank rows skipped). */
export function validateOpenings(rows: readonly OpeningDraft[], ctx: OpeningContext): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    if (isBlankOpening(r)) return;
    const at = (f: OpeningField, msg: string): void => {
      if (!out[`${i}.${f}`]) out[`${i}.${f}`] = msg;
    };
    if (ctx.multipleGodowns && r.godownId === null) at('godownId', 'Choose the godown');
    const batch = r.batchName.trim();
    if (ctx.batches && !batch) at('batchName', 'Enter the batch name');
    if (r.mfgDate && r.expiryDate && r.expiryDate < r.mfgDate) at('expiryDate', 'Expiry is before the manufacturing date');
    if (r.qty === null) at('qty', 'Enter the quantity');
    else if (!(r.qty > 0)) at('qty', 'Quantity must be more than 0 — remove the row for no stock');
    else if (r.qty > MAX_OPENING_QTY) at('qty', 'This quantity is too large — check it');
    else if (!decimalsOk(r.qty, ctx.unitDecimals))
      at('qty', ctx.unitDecimals === 0 ? `${ctx.unitSymbol || 'This unit'} takes whole numbers only` : `${ctx.unitSymbol || 'This unit'} allows ${ctx.unitDecimals} decimal place${ctx.unitDecimals === 1 ? '' : 's'}`);
    if (r.rate !== null && r.rate < 0) at('rate', 'Rate cannot be negative');
    if (r.valueOverridden && r.value !== null && r.value < 0) at('value', 'Value cannot be negative');
    const v = r.valueOverridden ? r.value : r.qty !== null && r.rate !== null ? r.qty * r.rate * 100 : 0;
    if (v !== null && (!Number.isFinite(v) || Math.abs(v) > MAX_LINE_PAISE))
      at(r.valueOverridden ? 'value' : 'rate', `The value is too large (more than ${formatMoney(MAX_LINE_PAISE, { symbol: true })}) — check the quantity and rate`);
    const key = `${ctx.multipleGodowns ? (r.godownId ?? '') : ''}|${ctx.batches ? batch.toLowerCase() : ''}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      // Point at a column the user can see: with neither godowns nor batches shown, every row is the
      // same "Main Location" row, so the quantities belong together.
      if (ctx.batches) at('batchName', `Same ${ctx.multipleGodowns ? 'godown and batch' : 'batch'} as row ${prev + 1} — combine them`);
      else if (ctx.multipleGodowns) at('godownId', `Same godown as row ${prev + 1} — combine them`);
      else at('qty', `Row ${prev + 1} already has the opening stock — enter the total quantity in one row`);
    } else seen.set(key, i);
  });
  return out;
}

/** Rows for StockItemSaveInput.openings (blank rows dropped; hidden columns not sent). */
export function toOpeningInputs(rows: readonly OpeningDraft[], ctx: OpeningContext): StockOpeningInput[] {
  const out: StockOpeningInput[] = [];
  for (const r of rows) {
    if (isBlankOpening(r) || r.qty === null) continue;
    const input: StockOpeningInput = { qty: r.qty };
    if (ctx.multipleGodowns && r.godownId !== null) input.godownId = r.godownId;
    if (ctx.batches) {
      const b = r.batchName.trim();
      if (b) input.batchName = b;
      if (b && ctx.trackMfgDate && r.mfgDate) input.mfgDate = r.mfgDate;
      if (b && ctx.useExpiry && r.expiryDate) input.expiryDate = r.expiryDate;
    }
    if (r.valueOverridden) {
      if (r.value !== null) input.value = r.value;
    } else if (r.rate !== null) {
      input.rate = r.rate;
      const v = calculatedValue(r.qty, r.rate);
      if (v !== null) input.value = v;
    }
    out.push(input);
  }
  return out;
}

/**
 * Grid row index of each row toOpeningInputs sends (blank rows are dropped there): the server
 * reports problems as `openings[i]` over the rows it received, the form keys them by grid row.
 */
export function sentOpeningIndexes(rows: readonly OpeningDraft[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (!isBlankOpening(r) && r.qty !== null) out.push(i);
  });
  return out;
}

/**
 * Re-key server field errors from sent-row indexes to grid-row indexes: 'openings.1.godownId' for
 * the second row sent becomes 'openings.2.godownId' when grid row 0 was blank. Other keys are kept.
 */
export function openingErrorsToGrid(fields: Readonly<Record<string, string>>, rows: readonly OpeningDraft[]): Record<string, string> {
  const map = sentOpeningIndexes(rows);
  const out: Record<string, string> = {};
  for (const [k, msg] of Object.entries(fields)) {
    const m = /^openings\.(\d+)\.(.+)$/.exec(k);
    const grid = m ? map[Number(m[1])] : undefined;
    const key = m && grid !== undefined ? `openings.${grid}.${m[2]}` : k;
    out[key] = out[key] && out[key] !== msg ? `${out[key]} ${msg}` : msg;
  }
  return out;
}

/** Grid rows from saved opening stock. A stored value that differs from qty × rate is an override. */
export function openingDraftsFromRows(rows: readonly StockOpeningRow[]): OpeningDraft[] {
  return rows.map((o) => {
    const calc = calculatedValue(o.qty, o.rate);
    const overridden = calc === null || calc !== o.value;
    return {
      key: newRowKey(),
      godownId: o.godownId,
      batchName: o.batchName ?? '',
      mfgDate: o.mfgDate,
      expiryDate: o.expiryDate,
      qty: o.qty,
      rate: o.rate,
      value: o.value,
      valueOverridden: overridden,
    };
  });
}

/**
 * True when the grid would save something different from the stored rows (order-insensitive),
 * so an unchanged grid is not re-sent (re-sending is harmless, but a locked period refuses changes).
 */
export function openingsChanged(saved: readonly StockOpeningRow[], rows: readonly OpeningDraft[], ctx: OpeningContext): boolean {
  const next = toOpeningInputs(rows, ctx);
  if (next.length !== saved.length) return true;
  // The rate is compared for calculated rows only (a rate typed as 100.0004 instead of 100 may give
  // the same value in paise but is still a change); a typed value is compared by value alone, the
  // core derives its rate.
  const keyOf = (godownId: number | null | undefined, batch: string | null | undefined, mfg: string | null | undefined, exp: string | null | undefined, qty: number, value: number | null | undefined, rate: number | null): string =>
    JSON.stringify([ctx.multipleGodowns ? (godownId ?? null) : null, (batch ?? '').toLowerCase(), mfg ?? null, exp ?? null, qty, value ?? null, rate]);
  const a = saved.map((o) => keyOf(o.godownId, o.batchName, o.mfgDate, o.expiryDate, o.qty, o.value, calculatedValue(o.qty, o.rate) === o.value ? o.rate : null)).sort();
  const b = next.map((o) => keyOf(o.godownId, o.batchName, o.mfgDate, o.expiryDate, o.qty, o.value ?? calculatedValue(o.qty, o.rate ?? null), o.rate ?? null)).sort();
  return a.some((k, i) => k !== b[i]);
}

/** Columns of the grid that are on screen for a context (errors on hidden ones move to the quantity). */
export function openingFieldShown(field: OpeningField, ctx: OpeningContext): boolean {
  switch (field) {
    case 'godownId':
      return ctx.multipleGodowns;
    case 'batchName':
      return ctx.batches;
    case 'mfgDate':
      return ctx.batches && ctx.trackMfgDate;
    case 'expiryDate':
      return ctx.batches && ctx.useExpiry;
    default:
      return true;
  }
}

const OPENING_FIELDS: readonly OpeningField[] = ['godownId', 'batchName', 'mfgDate', 'expiryDate', 'qty', 'rate', 'value'];

/**
 * Errors keyed `${index}.${field}` with those of hidden columns (e.g. a server message about the
 * godown while only Main Location is in use) moved onto the row's quantity cell, so no message is
 * ever invisible. Keys that are not cell keys are kept as they are.
 */
export function remapOpeningErrors(errors: Readonly<Record<string, string | undefined>>, ctx: OpeningContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, msg] of Object.entries(errors)) {
    if (!msg) continue;
    const m = /^(\d+)\.(\w+)$/.exec(k);
    const field = m?.[2] as OpeningField | undefined;
    const target = m && field && OPENING_FIELDS.includes(field) && !openingFieldShown(field, ctx) ? `${m[1]}.qty` : k;
    out[target] = out[target] && out[target] !== msg ? `${out[target]} ${msg}` : msg;
  }
  return out;
}

/** Non-blocking notes on the grid: rows with a quantity but no rate or value are valued at ₹0. */
export function openingWarnings(rows: readonly OpeningDraft[]): string[] {
  const zero: number[] = [];
  rows.forEach((r, i) => {
    if (isBlankOpening(r) || r.qty === null || !(r.qty > 0)) return;
    if (r.valueOverridden ? r.value === null : r.rate === null) zero.push(i + 1);
  });
  if (zero.length === 0) return [];
  return [`Opening stock row${zero.length === 1 ? '' : 's'} ${zero.join(', ')} ${zero.length === 1 ? 'has' : 'have'} no rate or value, so ${zero.length === 1 ? 'it is' : 'they are'} valued at ₹0. Enter the cost if the stock cost something.`];
}
