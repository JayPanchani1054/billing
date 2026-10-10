/**
 * Go To ('items' provider) result building — pure, tested in goto.test.ts. Results open the stock
 * item report ('stock.item' { itemId }) when the stock module registered it, else the item form.
 */

export interface GotoItemRow {
  id: number;
  name: string;
  alias?: string | null;
  /** Additional aliases (dataplus). */
  otherAliases?: string[];
  partNo?: string | null;
  barcode?: string | null;
  groupName?: string | null;
  unitSymbol?: string;
  unitDecimals?: number;
  stockQty?: number;
  isService?: boolean;
}

export interface GotoResult {
  id: string;
  label: string;
  group: string;
  description: string;
  keywords: string[];
  screen: string;
  params: Record<string, unknown>;
  /** The item form, for a user who may not open the stock report (the palette checks nav.canOpen). */
  fallback?: { screen: string; params: Record<string, unknown> };
}

export const STOCK_ITEM_REPORT = 'stock.item';
export const ITEM_FORM = 'inventory.item.form';

/** Where a Go To result for an item opens. */
export function itemGotoTarget(itemId: number, hasScreen: (id: string) => boolean): { screen: string; params: Record<string, unknown> } {
  return hasScreen(STOCK_ITEM_REPORT) ? { screen: STOCK_ITEM_REPORT, params: { itemId } } : { screen: ITEM_FORM, params: { id: itemId } };
}

/** "Electronics · 12 Nos in stock" — the second line in the palette. */
export function itemGotoDescription(r: GotoItemRow, formatQty: (q: number, decimals: number, unit?: string) => string): string {
  const parts: string[] = [];
  parts.push(r.groupName?.trim() || 'Stock item');
  if (r.isService) parts.push('Service');
  else if (typeof r.stockQty === 'number' && Number.isFinite(r.stockQty)) parts.push(`${formatQty(r.stockQty, r.unitDecimals ?? 0, r.unitSymbol)} in stock`);
  return parts.join(' · ');
}

export function itemGotoResults(
  rows: readonly GotoItemRow[],
  hasScreen: (id: string) => boolean,
  formatQty: (q: number, decimals: number, unit?: string) => string,
): GotoResult[] {
  return rows.map((r) => {
    const target = itemGotoTarget(r.id, hasScreen);
    return {
      id: `item:${r.id}`,
      label: r.name,
      group: 'Stock Items',
      description: itemGotoDescription(r, formatQty),
      keywords: [r.alias ?? '', r.partNo ?? '', r.barcode ?? '', ...(r.otherAliases ?? [])].filter((k) => k.trim() !== ''),
      screen: target.screen,
      params: target.params,
      ...(target.screen !== ITEM_FORM ? { fallback: { screen: ITEM_FORM, params: { id: r.id } } } : {}),
    };
  });
}
