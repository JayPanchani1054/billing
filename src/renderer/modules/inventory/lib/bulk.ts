/**
 * Multiple stock item creation grid (Tally's "Multiple Stock Items"), pure part — tested in
 * bulk.test.ts. Each non-blank row becomes one StockItemSaveInput; the core creates all rows or
 * none and reports the first problem with its row number.
 */
import type { StockItemSaveInput } from '../../../../shared/types/inventory.ts';
import { isRetiredSlabOn, isStandardRate, isValidRate } from '../../../../shared/gst/index.ts';
import { formatPercent } from '../../../../shared/format.ts';
import { validateHsnSac } from '../../../../shared/validators.ts';
import { calculatedValue, newRowKey } from './opening.ts';

export interface BulkRow {
  key: string;
  name: string;
  alias: string;
  /** null = the grid's default group ("Under" at the top). */
  groupId: number | null;
  unitId: number | null;
  hsnSac: string;
  gstRate: number | null;
  /** Paise. */
  sellingPrice: number | null;
  openingQty: number | null;
  /** Rupees per base unit. */
  openingRate: number | null;
}

export function emptyBulkRow(unitId: number | null = null): BulkRow {
  return { key: newRowKey('b'), name: '', alias: '', groupId: null, unitId, hsnSac: '', gstRate: null, sellingPrice: null, openingQty: null, openingRate: null };
}

/** A row with no name and nothing else typed (ignored). The pre-filled unit does not count. */
export function isBlankBulkRow(r: BulkRow): boolean {
  return (
    r.name.trim() === '' &&
    r.alias.trim() === '' &&
    r.groupId === null &&
    r.hsnSac.trim() === '' &&
    r.gstRate === null &&
    r.sellingPrice === null &&
    r.openingQty === null &&
    r.openingRate === null
  );
}

export interface BulkContext {
  gstEnabled: boolean;
  /** Godown for opening stock when the company keeps several godowns (null: Main Location / not needed). */
  openingGodownId: number | null;
  multipleGodowns: boolean;
  /** Decimal places per unit id (for opening quantity checks). */
  unitDecimals: (unitId: number) => number;
}

/** Problems keyed `${row.key}.${field}`; also flags duplicate names within the grid. */
export function validateBulkRows(rows: readonly BulkRow[], ctx: BulkContext): Record<string, string> {
  const out: Record<string, string> = {};
  const names = new Map<string, number>();
  rows.forEach((r, i) => {
    if (isBlankBulkRow(r)) return;
    const at = (f: keyof BulkRow, msg: string): void => {
      if (!out[`${r.key}.${f}`]) out[`${r.key}.${f}`] = msg;
    };
    const name = r.name.trim();
    if (!name) at('name', 'Enter the item name');
    else {
      const k = name.toLowerCase();
      const prev = names.get(k);
      if (prev !== undefined) at('name', `Same name as row ${prev + 1}`);
      else names.set(k, i);
    }
    if (r.alias.trim() && r.alias.trim().toLowerCase() === name.toLowerCase()) at('alias', 'The alias must differ from the name');
    if (r.unitId === null) at('unitId', 'Choose the unit');
    if (ctx.gstEnabled) {
      const hsn = r.hsnSac.replace(/\s+/g, '');
      if (hsn) {
        // Rows here are goods (services are created on the item form): SAC codes are refused like the core does.
        const err = validateHsnSac(hsn, 'goods');
        if (err) at('hsnSac', /SAC/.test(err) ? `${err}. Create services on the stock item form (Alt+C there).` : err);
      }
      if (r.gstRate !== null && (!isValidRate(r.gstRate) || !isStandardRate(r.gstRate)))
        at('gstRate', `${r.gstRate}% is not a notified GST rate — use the item form for special rates`);
    }
    if (r.sellingPrice !== null && r.sellingPrice < 0) at('sellingPrice', 'Price cannot be negative');
    if (r.openingQty !== null) {
      if (!(r.openingQty > 0)) at('openingQty', 'Quantity must be more than 0 (leave blank for none)');
      else if (r.unitId !== null) {
        const dp = ctx.unitDecimals(r.unitId);
        const f = 10 ** dp;
        if (Math.abs(Math.round(r.openingQty * f) / f - r.openingQty) > 1e-9) at('openingQty', dp === 0 ? 'This unit takes whole numbers only' : `This unit allows ${dp} decimal places`);
      }
      if (ctx.multipleGodowns && ctx.openingGodownId === null) at('openingQty', 'Choose the godown for opening stock at the top');
    } else if (r.openingRate !== null) at('openingQty', 'Enter the opening quantity for this rate');
    if (r.openingRate !== null && r.openingRate < 0) at('openingRate', 'Rate cannot be negative');
  });
  return out;
}

/** Rows for 'inventory.item.bulkCreate' (blank rows dropped), with each input's grid row key. */
export function bulkInputs(rows: readonly BulkRow[], ctx: BulkContext): Array<{ key: string; input: StockItemSaveInput }> {
  const out: Array<{ key: string; input: StockItemSaveInput }> = [];
  for (const r of rows) {
    if (isBlankBulkRow(r)) continue;
    const input: StockItemSaveInput = { name: r.name.trim() };
    if (r.alias.trim()) input.alias = r.alias.trim();
    if (r.groupId !== null) input.groupId = r.groupId;
    if (r.unitId !== null) input.unitId = r.unitId;
    if (ctx.gstEnabled) {
      const hsn = r.hsnSac.replace(/\s+/g, '');
      if (hsn) input.hsnSac = hsn;
      if (r.gstRate !== null) {
        input.gstApplicable = true;
        input.taxability = 'taxable';
        input.gstRate = r.gstRate;
      }
    }
    if (r.sellingPrice !== null) input.sellingPrice = r.sellingPrice;
    if (r.openingQty !== null && r.openingQty > 0) {
      const opening: NonNullable<StockItemSaveInput['openings']>[number] = { qty: r.openingQty };
      if (ctx.multipleGodowns && ctx.openingGodownId !== null) opening.godownId = ctx.openingGodownId;
      if (r.openingRate !== null) {
        opening.rate = r.openingRate;
        const v = calculatedValue(r.openingQty, r.openingRate);
        if (v !== null) opening.value = v;
      }
      input.openings = [opening];
    }
    out.push({ key: r.key, input });
  }
  return out;
}

/** Grid columns a server message can be shown on. */
const BULK_CELLS: ReadonlySet<string> = new Set(['name', 'alias', 'groupId', 'unitId', 'hsnSac', 'gstRate', 'sellingPrice', 'openingQty', 'openingRate']);

/**
 * 'rows[3].name' from the server → the grid key of that input row and the cell ('name'). Fields
 * the grid has no column for (barcode, cess…) land on the row's name cell, so no message is lost.
 */
export function bulkErrorTarget(path: string, sent: ReadonlyArray<{ key: string }>): { key: string; field: string } | null {
  const m = /^rows\[(\d+)\]\.?([A-Za-z]+)?(?:\[\d+\]\.?([A-Za-z]+))?/.exec(path);
  if (!m) return null;
  const row = sent[Number(m[1])];
  if (!row) return null;
  const f = m[2] ?? 'name';
  let field = f;
  if (f === 'openings') field = m[3] === 'rate' || m[3] === 'value' ? 'openingRate' : 'openingQty';
  else if (f === 'gstApplicable' || f === 'taxability' || f === 'allowNonStandardRate') field = 'gstRate';
  return { key: row.key, field: BULK_CELLS.has(field) ? field : 'name' };
}

/** Non-blocking notes: rows on a GST slab retired on 22-Sep-2025 (12% / 28% for most goods). */
export function bulkWarnings(rows: readonly BulkRow[], ctx: Pick<BulkContext, 'gstEnabled'>, date: string): string[] {
  if (!ctx.gstEnabled) return [];
  const hits: string[] = [];
  rows.forEach((r, i) => {
    if (!isBlankBulkRow(r) && r.gstRate !== null && isRetiredSlabOn(r.gstRate, date)) hits.push(`row ${i + 1} (${formatPercent(r.gstRate)})`);
  });
  return hits.length
    ? [`The 12% and 28% slabs were merged into 5%, 18% and 40% for most goods from 22-Sep-2025. Check the GST rate of ${hits.join(', ')}.`]
    : [];
}
