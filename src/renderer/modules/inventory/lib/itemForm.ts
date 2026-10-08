/**
 * Stock item form model (pure, tested in itemForm.test.ts): the draft, its conversion from/to the
 * API DTOs, client-side checks (the core re-validates everything) and the plain-language texts the
 * form shows (costing methods, taxability, HSN hint).
 */
import type { CostingMethod, StockItemDetail, StockItemSaveInput, Taxability } from '../../../../shared/types/inventory.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { formatMoney, formatPercent } from '../../../../shared/format.ts';
import { percentOf } from '../../../../shared/money.ts';
import type { GstDraft } from './gstDraft.ts';
import { emptyGstDraft, gstChanged, gstDraftFrom, gstSaveFields, hsnDiffers, validateGstDraft } from './gstDraft.ts';
import type { OpeningContext, OpeningDraft } from './opening.ts';
import { openingDraftsFromRows, openingsChanged, openingWarnings, toOpeningInputs, validateOpenings } from './opening.ts';

export interface ItemDraft extends GstDraft {
  // Basic
  name: string;
  alias: string;
  partNo: string;
  barcode: string;
  description: string;
  groupId: number | null;
  categoryId: number | null;
  unitId: number | null;
  altUnitId: number | null;
  /** Base units in 1 alternate unit (1 Box = 12 Nos → 12). */
  altConversion: number | null;
  isService: boolean;
  isActive: boolean;
  // Tax (GstDraft fields) + price entry
  rateInclusiveOfTax: boolean;
  // Pricing (paise)
  mrp: number | null;
  sellingPrice: number | null;
  purchasePrice: number | null;
  standardCost: number | null;
  // Stock
  costingMethod: CostingMethod;
  reorderLevel: number | null;
  minOrderQty: number | null;
  maintainBatches: boolean;
  trackMfgDate: boolean;
  useExpiry: boolean;
  openings: OpeningDraft[];
}

export function emptyItemDraft(init: { name?: string; groupId?: number | null } = {}): ItemDraft {
  return {
    name: init.name ?? '',
    alias: '',
    partNo: '',
    barcode: '',
    description: '',
    groupId: init.groupId ?? null,
    categoryId: null,
    unitId: null,
    altUnitId: null,
    altConversion: null,
    isService: false,
    isActive: true,
    ...emptyGstDraft(),
    rateInclusiveOfTax: false,
    mrp: null,
    sellingPrice: null,
    purchasePrice: null,
    standardCost: null,
    costingMethod: 'avg_cost',
    reorderLevel: null,
    minOrderQty: null,
    maintainBatches: false,
    trackMfgDate: false,
    useExpiry: false,
    openings: [],
  };
}

export function itemDraftFromDetail(d: StockItemDetail): ItemDraft {
  return {
    name: d.name,
    alias: d.alias ?? '',
    partNo: d.partNo ?? '',
    barcode: d.barcode ?? '',
    description: d.description ?? '',
    groupId: d.groupId,
    categoryId: d.categoryId,
    unitId: d.unitId,
    altUnitId: d.altUnitId,
    altConversion: d.altConversion,
    isService: d.isService,
    isActive: d.isActive,
    ...gstDraftFrom(d),
    rateInclusiveOfTax: d.rateInclusiveOfTax,
    mrp: d.mrp,
    sellingPrice: d.sellingPrice,
    purchasePrice: d.purchasePrice,
    standardCost: d.standardCost,
    costingMethod: d.costingMethod,
    reorderLevel: d.reorderLevel,
    minOrderQty: d.minOrderQty,
    maintainBatches: d.maintainBatches,
    trackMfgDate: d.trackMfgDate,
    useExpiry: d.useExpiry,
    openings: openingDraftsFromRows(d.openings),
  };
}

const trimOrNull = (s: string): string | null => {
  const t = s.trim();
  return t === '' ? null : t;
};

/**
 * True when the item's own GST details differ from the saved item (HSN included while the item
 * has its own details — a dated change records it in the rate history, as the core does).
 */
export function gstDetailsChanged(draft: ItemDraft, saved: StockItemDetail | null): boolean {
  return gstChanged(draft, saved);
}

/** True when the HSN/SAC differs from the saved item. */
export function hsnChanged(draft: ItemDraft, saved: StockItemDetail | null): boolean {
  return hsnDiffers(draft, saved);
}

/** Unsaved changes (openings compared by what would be saved). */
export function itemDraftDirty(draft: ItemDraft, base: ItemDraft): boolean {
  const strip = (d: ItemDraft): unknown => ({
    ...d,
    openings: d.openings
      .filter((o) => o.qty !== null || o.rate !== null || o.valueOverridden || o.batchName.trim() !== '')
      .map((o) => [o.godownId, o.batchName.trim(), o.mfgDate, o.expiryDate, o.qty, o.rate, o.valueOverridden ? o.value : null]),
    name: d.name.trim(),
    alias: d.alias.trim(),
    partNo: d.partNo.trim(),
    barcode: d.barcode.trim(),
    description: d.description.trim(),
    hsnSac: d.hsnSac.trim(),
  });
  return JSON.stringify(strip(draft)) !== JSON.stringify(strip(base));
}

export interface ItemFormContext {
  gstEnabled: boolean;
  /** Company F12 › GST › HSN digits (4, 6 or 8): the minimum digits for GSTR-1. */
  hsnDigits: number;
  /** Opening grid columns and rules. */
  opening: OpeningContext;
  /** The item already has dated GST history (changes then need an "applicable from" date). */
  hasGstHistory: boolean;
  /**
   * GST the item would inherit from its stock group chain (null: none, so the ledger's rate is
   * used; undefined: not known yet). Only used for warnings.
   */
  inheritedGst?: InheritedGst | null;
}

export type ItemErrors = Record<string, string>;

/**
 * Client-side checks before saving; keys are the API field paths ('name', 'gstRate',
 * 'openings.2.qty' …) so server errors land in the same place. Returns {} when fine.
 */
export function validateItemDraft(d: ItemDraft, saved: StockItemDetail | null, ctx: ItemFormContext): ItemErrors {
  const e: ItemErrors = {};
  if (!d.name.trim()) e.name = 'Enter the stock item name';
  if (d.alias.trim() && d.alias.trim().toLowerCase() === d.name.trim().toLowerCase()) e.alias = 'The alias must be different from the name';
  if (d.unitId === null) e.unitId = 'Choose the unit of measure (e.g. Nos, Kg)';
  if (d.altUnitId !== null) {
    if (d.altUnitId === d.unitId) e.altUnitId = 'The alternate unit must be different from the base unit';
    else if (d.altConversion === null || !(d.altConversion > 0)) e.altConversion = 'Enter how many base units make 1 alternate unit (more than 0)';
  }
  if (ctx.gstEnabled) Object.assign(e, validateGstDraft(d, saved, { kind: d.isService ? 'services' : 'goods', hasHistory: ctx.hasGstHistory }));
  const neg = (v: number | null, k: string, label: string): void => {
    if (v !== null && v < 0) e[k] = `${label} cannot be negative`;
  };
  neg(d.mrp, 'mrp', 'MRP');
  neg(d.sellingPrice, 'sellingPrice', 'Selling price');
  neg(d.purchasePrice, 'purchasePrice', 'Purchase price');
  neg(d.standardCost, 'standardCost', 'Standard cost');
  neg(d.reorderLevel, 'reorderLevel', 'Reorder level');
  neg(d.minOrderQty, 'minOrderQty', 'Minimum order quantity');
  if (d.costingMethod === 'std_cost' && d.standardCost === null) e.standardCost = 'Enter the standard cost: the costing method is Standard Cost';
  // A service keeps no stock: its batch settings are hidden and saved as off (itemSaveInput), so a
  // leftover "Keep in batches" from before the switch is not an error the user could not see.
  if (!d.isService) {
    const oe = validateOpenings(d.openings, ctx.opening);
    for (const [k, msg] of Object.entries(oe)) e[`openings.${k}`] = msg;
  }
  return e;
}

/** Non-blocking notes shown above the Save button. */
export function itemDraftWarnings(d: ItemDraft, ctx: ItemFormContext): string[] {
  const w: string[] = [];
  const hsn = d.hsnSac.replace(/\s+/g, '');
  if (ctx.gstEnabled && hsn && /^\d+$/.test(hsn) && hsn.length < ctx.hsnDigits)
    w.push(`GSTR-1 needs at least ${ctx.hsnDigits} digits of HSN/SAC for your turnover (F12 › GST). '${hsn}' has ${hsn.length}.`);
  if (ctx.gstEnabled && !d.isService && !hsn && d.gstApplicable) w.push('No HSN code: invoices and GSTR-1 need one. You can add it later.');
  if (ctx.gstEnabled && !d.gstApplicable && ctx.inheritedGst === null)
    w.push('No GST rate is set on this item or its stock group, so invoices will take the rate of the sales or purchase ledger. Turn on "Set GST details here" to give the item its own rate.');
  // MRP includes tax. Compare it with the selling price as charged to the customer: as typed when
  // prices include GST, else plus GST at the item's (or inherited) rate when known.
  if (d.mrp !== null && d.sellingPrice !== null) {
    const rate = !ctx.gstEnabled ? 0 : d.gstApplicable ? (d.taxability === 'taxable' ? d.gstRate : 0) : ctx.inheritedGst ? (ctx.inheritedGst.taxability === 'taxable' ? ctx.inheritedGst.rate : 0) : null;
    if (d.rateInclusiveOfTax || rate === null) {
      if (d.sellingPrice > d.mrp) w.push(`The selling price is above the MRP (${formatMoney(d.mrp, { symbol: true })}). Check the prices — an item may not be sold above its MRP.`);
    } else {
      const withTax = d.sellingPrice + percentOf(d.sellingPrice, rate);
      if (withTax > d.mrp)
        w.push(
          `The selling price plus ${formatPercent(rate)} GST is ${formatMoney(withTax, { symbol: true })}, above the MRP of ${formatMoney(d.mrp, { symbol: true })}. Check the prices — MRP includes tax.`,
        );
    }
  }
  if (!d.isService) w.push(...openingWarnings(d.openings));
  return w;
}

// ───────────────────────────── Inherited GST ─────────────────────────────

/** GST columns of a stock group as listed by 'inventory.group.list'. */
export interface GroupGstRow {
  id: number;
  name: string;
  parentId: number | null;
  /** The group's own details are complete (core columnsComplete). */
  gstApplicable: boolean;
  taxability: Taxability | null;
  gstRate: number | null;
  cessRate: number | null;
  cessPerUnit: number;
}

export interface InheritedGst {
  groupId: number;
  groupName: string;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  cessPerUnit: number;
}

/**
 * The GST an item under `groupId` inherits today: the nearest group up the chain with its own
 * details (a group's columns always hold the details in force now). null when none has any.
 */
export function inheritedGroupGst(groups: readonly GroupGstRow[], groupId: number | null): InheritedGst | null {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<number>();
  let g = groupId === null ? undefined : byId.get(groupId);
  while (g && !seen.has(g.id)) {
    seen.add(g.id);
    if (g.gstApplicable) {
      const taxability = g.taxability ?? 'taxable';
      const taxable = taxability === 'taxable';
      return {
        groupId: g.id,
        groupName: g.name,
        taxability,
        rate: taxable ? (g.gstRate ?? 0) : 0,
        cessRate: taxable ? (g.cessRate ?? 0) : 0,
        cessPerUnit: taxable ? g.cessPerUnit : 0,
      };
    }
    g = g.parentId === null ? undefined : byId.get(g.parentId);
  }
  return null;
}

/**
 * "Inherits 18% GST from the stock group 'Kitchen'." — the hint under "Set GST details here" of an
 * item (`for: 'item'`) or of a stock group inheriting from its parent chain (`for: 'group'`).
 */
export function inheritedGstText(inh: InheritedGst | null, forMaster: 'item' | 'group' = 'item'): string {
  if (!inh)
    return forMaster === 'item'
      ? 'No GST rate is set on its stock group either, so invoices use the rate of the sales or purchase ledger.'
      : 'No group above it has GST details either, so its items use their own rate, or else the sales or purchase ledger.';
  const what = gstSummary({ taxability: inh.taxability, rate: inh.rate, cessRate: inh.cessRate, cessPerUnit: inh.cessPerUnit });
  return `Inherits ${what} from the ${forMaster === 'item' ? 'stock' : 'parent'} group '${inh.groupName}'.`;
}

/**
 * The save input. Create: every field. Alter: every editable field (the core keeps a field that is
 * unchanged); GST details and the "applicable from" date are sent only when they changed, and the
 * opening stock only when the grid changed (so a locked period never blocks an unrelated edit).
 */
export function itemSaveInput(d: ItemDraft, saved: StockItemDetail | null, ctx: ItemFormContext): StockItemSaveInput {
  const input: StockItemSaveInput = {
    name: d.name.trim(),
    alias: trimOrNull(d.alias),
    partNo: trimOrNull(d.partNo),
    barcode: trimOrNull(d.barcode),
    description: trimOrNull(d.description),
    groupId: d.groupId,
    categoryId: d.categoryId,
    altUnitId: d.altUnitId,
    altConversion: d.altUnitId === null ? null : d.altConversion,
    isService: d.isService,
    isActive: d.isActive,
    rateInclusiveOfTax: d.rateInclusiveOfTax,
    mrp: d.mrp,
    sellingPrice: d.sellingPrice,
    purchasePrice: d.purchasePrice,
    standardCost: d.standardCost,
    costingMethod: d.costingMethod,
    reorderLevel: d.reorderLevel,
    minOrderQty: d.minOrderQty,
    maintainBatches: d.isService ? false : d.maintainBatches,
    trackMfgDate: d.isService || !d.maintainBatches ? false : d.trackMfgDate,
    useExpiry: d.isService || !d.maintainBatches ? false : d.useExpiry,
  };
  if (saved) input.id = saved.id;
  if (d.unitId !== null) input.unitId = d.unitId;
  if (ctx.gstEnabled) Object.assign(input, gstSaveFields(d, saved));
  if (d.isService) {
    if (!saved || saved.openings.length > 0) input.openings = [];
  } else if (!saved || openingsChanged(saved.openings, d.openings, ctx.opening)) {
    input.openings = toOpeningInputs(d.openings, ctx.opening);
  }
  return input;
}

/** Map a server field path ('openings[2].qty') to the form's error key ('openings.2.qty'). */
export function formErrorKey(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1');
}

// ───────────────────────────── Texts ─────────────────────────────

export interface CostingInfo {
  value: CostingMethod;
  label: string;
  /** One or two plain sentences for a shopkeeper. */
  explain: string;
}

export const COSTING_INFO: readonly CostingInfo[] = [
  {
    value: 'avg_cost',
    label: 'Average cost',
    explain: 'Each sale is valued at the average purchase cost of the stock you hold at that moment. Best for most traders.',
  },
  {
    value: 'fifo',
    label: 'First in, first out (FIFO)',
    explain: 'Stock bought first is treated as sold first, so closing stock is valued at your latest purchase prices. Good for perishable goods.',
  },
  {
    value: 'lifo',
    label: 'Last in, first out (LIFO)',
    explain: 'Stock bought last is treated as sold first, so closing stock is valued at your oldest prices. Not allowed under Indian accounting standards (AS 2) for published accounts.',
  },
  {
    value: 'last_purchase',
    label: 'Last purchase cost',
    explain: 'All stock is valued at the rate of your most recent purchase.',
  },
  {
    value: 'std_cost',
    label: 'Standard cost',
    explain: 'All stock is valued at a fixed standard cost you set below. The difference from actual purchase prices shows as a price variance. Common in manufacturing.',
  },
];

export function costingInfo(m: CostingMethod): CostingInfo {
  return COSTING_INFO.find((c) => c.value === m) ?? COSTING_INFO[0];
}

export const TAXABILITY_OPTIONS: ReadonlyArray<{ value: Taxability; label: string; description: string }> = [
  { value: 'taxable', label: 'Taxable', description: 'GST is charged at the rate below.' },
  { value: 'exempt', label: 'Exempt', description: 'Notified as exempt from GST (e.g. fresh vegetables, unbranded grains).' },
  { value: 'nil_rated', label: 'Nil rated', description: 'Taxable at 0% (e.g. salt, some food grains).' },
  { value: 'non_gst', label: 'Non-GST', description: 'Outside GST altogether (e.g. petrol, diesel, alcohol for drinking).' },
];

export function taxabilityLabel(t: Taxability | null | undefined): string {
  return TAXABILITY_OPTIONS.find((o) => o.value === t)?.label ?? 'Taxable';
}

/** Hint under the HSN/SAC field. */
export function hsnHint(hsnDigits: number, isService: boolean): string {
  return isService
    ? `SAC code for services — starts with 99, ${hsnDigits === 4 ? '4 or 6' : hsnDigits} digits or more.`
    : `HSN code — at least ${hsnDigits} digits for your turnover (set in F12 › GST). 4, 6 or 8 digits.`;
}

/** "18% GST + 1% cess" / "Exempt" for lists, pickers and history rows. */
export function gstSummary(g: { taxability: Taxability | null; rate: number | null; cessRate?: number | null; cessPerUnit?: number | null } | null): string {
  if (!g) return '';
  if (g.taxability && g.taxability !== 'taxable') return taxabilityLabel(g.taxability);
  if (g.rate === null) return '';
  const parts = [`${formatPercent(g.rate)} GST`];
  if (g.cessRate) parts.push(`${formatPercent(g.cessRate)} cess`);
  if (g.cessPerUnit) parts.push(`${formatMoney(g.cessPerUnit, { symbol: true })}/unit cess`);
  return parts.join(' + ');
}

/** Where an item's GST comes from, in words (for the Tax tab). */
export function effectiveGstText(
  eff: { source: 'item_history' | 'item' | 'group_history' | 'group'; applicableFrom: string | null; taxability: Taxability; rate: number; cessRate: number; cessPerUnit: number } | null,
  groupName: string | null,
): string {
  if (!eff) return 'No GST rate is set on this item or its stock group, so invoices use the rate of the sales or purchase ledger.';
  const what = gstSummary({ taxability: eff.taxability, rate: eff.rate, cessRate: eff.cessRate, cessPerUnit: eff.cessPerUnit });
  const since = eff.applicableFrom ? ` (from ${formatDate(eff.applicableFrom)})` : '';
  switch (eff.source) {
    case 'item':
    case 'item_history':
      return `Today: ${what}${since}, set on this item.`;
    case 'group':
    case 'group_history':
      return `Today: ${what}${since}, taken from the stock group${groupName ? ` '${groupName}' or above it` : ''}.`;
  }
}
