/**
 * Price list grid (pure, tested in slabs.test.ts). A price list gives each stock item one or more
 * quantity slabs for a price level from a date: slab k applies to qtyFrom ≤ qty < qtyTo (qtyTo
 * blank = no upper limit). Slabs of one item must not overlap — the same rule as the core
 * (`slabIssues` in core/modules/inventory/prices.ts), checked here so the grid can point at the
 * exact cell before saving.
 */
import type { PriceListItem, PriceListSaveRow, PriceSlab } from '../../../../shared/types/inventory.ts';
import { formatIndianNumber } from '../../../../shared/format.ts';
import { roundTo } from '../../../../shared/money.ts';
import { newRowKey } from './opening.ts';

const EPS = 1e-9;

export interface SlabDraft {
  key: string;
  itemId: number;
  qtyFrom: number | null;
  /** null = no upper limit. */
  qtyTo: number | null;
  /** Rupees per base unit. */
  rate: number | null;
  discountPct: number | null;
}

export interface ItemSlabs {
  itemId: number;
  itemName: string;
  unitSymbol: string;
  /** Paise — the item's default selling price, shown for reference. */
  sellingPrice: number | null;
  /** Date of the list currently applicable (null: none). */
  applicableFrom: string | null;
  slabs: SlabDraft[];
}

/** A quantity for messages: 1000 → '1,000', 2.5 → '2.5'. */
export function qtyText(q: number): string {
  const frac = (q.toFixed(6).split('.')[1] ?? '').replace(/0+$/, '');
  return formatIndianNumber(q, frac.length);
}

/** "0 to 10" / "10 and above". */
export function slabRangeText(from: number | null, to: number | null): string {
  const f = qtyText(from ?? 0);
  return to === null ? `${f} and above` : `${f} to under ${qtyText(to)}`;
}

export function emptySlab(itemId: number, qtyFrom: number | null = 0): SlabDraft {
  return { key: newRowKey('s'), itemId, qtyFrom, qtyTo: null, rate: null, discountPct: null };
}

/** True when nothing was typed in the slab (apart from the default "from 0"). */
export function isBlankSlab(s: SlabDraft): boolean {
  return s.rate === null && s.qtyTo === null && (s.discountPct === null || s.discountPct === 0) && (s.qtyFrom === null || s.qtyFrom === 0);
}

/**
 * Problems in one item's slabs, keyed `${slab.key}.${field}`. Rules (as in the core):
 *  - a rate is required (0 allowed), discount 0–100, quantities ≥ 0;
 *  - 'up to' must be more than 'from';
 *  - no two slabs may overlap: after sorting by 'from', each slab must start at or after the
 *    previous slab's 'up to', and only the last slab may be open-ended.
 */
export function slabErrors(slabs: readonly SlabDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  const at = (s: SlabDraft, f: 'qtyFrom' | 'qtyTo' | 'rate' | 'discountPct', msg: string): void => {
    const k = `${s.key}.${f}`;
    if (!out[k]) out[k] = msg;
  };
  const live = slabs.filter((s) => !isBlankSlab(s));
  for (const s of live) {
    if (s.qtyFrom === null) at(s, 'qtyFrom', "Enter the 'from' quantity (0 for the first slab)");
    else if (s.qtyFrom < 0) at(s, 'qtyFrom', 'Quantity cannot be negative');
    if (s.qtyTo !== null && s.qtyFrom !== null && !(s.qtyTo > s.qtyFrom + EPS)) at(s, 'qtyTo', `'Up to' must be more than ${qtyText(s.qtyFrom)}`);
    if (s.rate === null) at(s, 'rate', 'Enter the rate');
    else if (s.rate < 0) at(s, 'rate', 'Rate cannot be negative');
    if (s.discountPct !== null && (s.discountPct < 0 || s.discountPct > 100)) at(s, 'discountPct', 'Discount must be between 0 and 100%');
  }
  const sorted = live.filter((s) => s.qtyFrom !== null && !out[`${s.key}.qtyTo`]).sort((a, b) => (a.qtyFrom ?? 0) - (b.qtyFrom ?? 0));
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1];
    const b = sorted[k];
    if (a.qtyTo === null || (b.qtyFrom ?? 0) < a.qtyTo - EPS)
      at(b, 'qtyFrom', `Overlaps the slab ${slabRangeText(a.qtyFrom, a.qtyTo)} — each quantity may fall in only one slab`);
  }
  return out;
}

/**
 * Quantity ranges no slab covers (non-blocking: those quantities use the item's default selling
 * price). E.g. slabs 0–10 and 20+ leave "10 to under 20".
 */
export function slabGaps(slabs: readonly SlabDraft[]): string[] {
  const sorted = slabs.filter((s) => !isBlankSlab(s) && s.qtyFrom !== null).sort((a, b) => (a.qtyFrom ?? 0) - (b.qtyFrom ?? 0));
  const gaps: string[] = [];
  if (sorted.length === 0) return gaps;
  if ((sorted[0].qtyFrom ?? 0) > EPS) gaps.push(slabRangeText(0, sorted[0].qtyFrom));
  for (let k = 1; k < sorted.length; k++) {
    const prevTo = sorted[k - 1].qtyTo;
    const from = sorted[k].qtyFrom ?? 0;
    if (prevTo !== null && from > prevTo + EPS) gaps.push(slabRangeText(prevTo, from));
  }
  return gaps;
}

/** Suggested 'from' for a new slab: the previous slab's 'up to' (0 for the first). */
export function nextSlabFrom(slabs: readonly SlabDraft[]): number {
  let best = 0;
  for (const s of slabs) if (s.qtyTo !== null && s.qtyTo > best) best = s.qtyTo;
  return best;
}

/** Grid model from the server's price list (items without a list get one blank slab). */
export function itemSlabsFromList(rows: readonly PriceListItem[]): ItemSlabs[] {
  return rows.map((r) => ({
    itemId: r.itemId,
    itemName: r.itemName,
    unitSymbol: r.unitSymbol,
    sellingPrice: r.sellingPrice,
    applicableFrom: r.applicableFrom,
    slabs: r.slabs.length
      ? r.slabs.map((s: PriceSlab) => ({ key: newRowKey('s'), itemId: r.itemId, qtyFrom: s.qtyFrom, qtyTo: s.qtyTo, rate: s.rate, discountPct: s.discountPct }))
      : [emptySlab(r.itemId)],
  }));
}

const slabSig = (s: { qtyFrom: number | null; qtyTo: number | null; rate: number | null; discountPct: number | null }): string =>
  JSON.stringify([s.qtyFrom ?? 0, s.qtyTo, s.rate, s.discountPct ?? 0]);

/** Slabs of an item as the grid would save them (blank ones dropped), sorted by 'from'. */
export function liveSlabs(slabs: readonly SlabDraft[]): SlabDraft[] {
  return slabs.filter((s) => !isBlankSlab(s)).sort((a, b) => (a.qtyFrom ?? 0) - (b.qtyFrom ?? 0));
}

/**
 * The save input for the items whose slabs changed against `original` (the list as loaded for
 * the date). An item whose slabs were all removed is cleared — but only when its list was dated
 * exactly on `applicableFrom` (an older list stays; the new date simply has nothing to replace).
 * An item whose list came from an earlier date and is unchanged is not re-saved.
 */
export function priceListChanges(
  items: readonly ItemSlabs[],
  original: readonly ItemSlabs[],
  applicableFrom: string,
): { rows: PriceListSaveRow[]; clearItemIds: number[]; changedItemIds: number[]; keptItemIds: number[] } {
  const before = new Map(original.map((o) => [o.itemId, liveSlabs(o.slabs).map(slabSig).join('|')]));
  const beforeFrom = new Map(original.map((o) => [o.itemId, o.applicableFrom]));
  const rows: PriceListSaveRow[] = [];
  const clearItemIds: number[] = [];
  const changedItemIds: number[] = [];
  /** Items whose slabs were all removed but whose list is dated earlier: nothing to save on this date. */
  const keptItemIds: number[] = [];
  for (const it of items) {
    const live = liveSlabs(it.slabs);
    const sig = live.map(slabSig).join('|');
    if (sig === (before.get(it.itemId) ?? '')) continue;
    changedItemIds.push(it.itemId);
    if (live.length === 0) {
      if (beforeFrom.get(it.itemId) === applicableFrom) clearItemIds.push(it.itemId);
      else keptItemIds.push(it.itemId);
      continue;
    }
    for (const s of live)
      rows.push({ itemId: it.itemId, qtyFrom: s.qtyFrom ?? 0, qtyTo: s.qtyTo, rate: s.rate ?? 0, discountPct: s.discountPct ?? 0 });
  }
  return { rows, clearItemIds, changedItemIds, keptItemIds };
}

/** Net rate after discount (rupees): 100 at 10% → 90. */
export function netRate(rate: number | null, discountPct: number | null): number | null {
  if (rate === null) return null;
  return roundTo(rate * (1 - (discountPct ?? 0) / 100), 4);
}
