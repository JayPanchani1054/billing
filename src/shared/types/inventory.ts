/**
 * DTOs for the inventory module (src/core/modules/inventory). All routes are company scope.
 *
 * Units
 *   'inventory.unit.list'        UnitListInput            → ListResult<UnitDto>               masters.view
 *   'inventory.unit.get'         IdInput                  → UnitDto                           masters.view
 *   'inventory.unit.save'        UnitSaveInput            → UnitDto                           masters.create | masters.alter (by id)
 *   'inventory.unit.delete'      IdInput                  → DeleteResult                      masters.delete
 * Stock groups / categories / godowns (trees)
 *   'inventory.group.list'       TreeListInput            → ListResult<StockGroupDto>         masters.view
 *   'inventory.group.get'        IdInput                  → StockGroupDetail                  masters.view
 *   'inventory.group.save'       StockGroupSaveInput      → StockGroupDetail                  masters.create | masters.alter
 *   'inventory.group.delete'     IdInput                  → DeleteResult                      masters.delete
 *   'inventory.category.list|get|save|delete'  (TreeListInput / IdInput / StockCategorySaveInput) → StockCategoryDto
 *   'inventory.godown.list|get|save|delete'    (TreeListInput / IdInput / GodownSaveInput)        → GodownDto
 * Stock items
 *   'inventory.item.list'        StockItemListInput       → ListResult<StockItemListRow>      masters.view
 *   'inventory.item.get'         IdInput                  → StockItemDetail                   masters.view
 *   'inventory.item.save'        StockItemSaveInput       → StockItemSaveResult               masters.create | masters.alter
 *   'inventory.item.delete'      IdInput                  → DeleteResult                      masters.delete
 *   'inventory.item.bulkCreate'  StockItemBulkCreateInput → StockItemBulkCreateResult         masters.create
 *   'inventory.item.picker'      ItemPickerInput          → ItemPickerRow[]                   masters.view
 *   'inventory.item.priceFor'    PriceForInput            → PriceForResult                    masters.view
 *   'inventory.item.gstProfile'  ItemGstProfileInput      → ItemGstProfile | null             masters.view
 * GST history
 *   'inventory.gstHistory.delete' IdInput                 → DeleteResult                      masters.alter
 * Price levels / price lists
 *   'inventory.priceLevel.list'  ListInput                → ListResult<PriceLevelDto>         masters.view
 *   'inventory.priceLevel.save'  PriceLevelSaveInput      → PriceLevelDto                     masters.create | masters.alter
 *   'inventory.priceLevel.delete' IdInput                 → DeleteResult                      masters.delete
 *   'inventory.priceList.get'    PriceListGetInput        → PriceListDto                      masters.view
 *   'inventory.priceList.save'   PriceListSaveInput       → PriceListDto                      masters.create | masters.alter
 * Stock engine
 *   'inventory.stockOnHand'      StockOnHandInput         → StockOnHandResult                 masters.view
 *   'inventory.batches'          BatchesInput             → BatchBalance[]                    masters.view
 *   'inventory.valuation'        StockValuationInput      → StockValuationResult              reports.view (transactional: false)
 *
 * Conventions: quantities are REAL in the item's base unit; item prices (mrp, sellingPrice,
 * purchasePrice, standardCost) and every `value` are integer paise; opening/price-list `rate`s are
 * rupees per base unit (REAL), like voucher lines.
 */
import type { Taxability } from './gst.ts';
import type { ThirdPartyKind } from './mfg.ts';

export type { Taxability };

export interface ListInput {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
}

export interface IdInput {
  id: number;
}

export interface DeleteResult {
  id: number;
  deleted: true;
}

// ───────────────────────────── Units ─────────────────────────────

export interface UnitDto {
  id: number;
  guid: string;
  /** Simple: 'Nos'. Compound: generated, e.g. 'Box of 12 Nos'. */
  symbol: string;
  formalName: string | null;
  uqc: string | null;
  decimalPlaces: number;
  isCompound: boolean;
  firstUnitId: number | null;
  firstUnitSymbol: string | null;
  /** 1 first unit = conversion × second unit. */
  conversion: number | null;
  secondUnitId: number | null;
  secondUnitSymbol: string | null;
  /** Number of stock items using it as base or alternate unit. */
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UnitListInput extends ListInput {
  kind?: 'simple' | 'compound';
}

export interface SimpleUnitSaveInput {
  id?: number;
  kind: 'simple';
  symbol: string;
  formalName?: string | null;
  /** GST UQC; default suggestUqc(symbol) (then formal name). */
  uqc?: string | null;
  /** 0–4 (default 0). */
  decimalPlaces?: number;
}

export interface CompoundUnitSaveInput {
  id?: number;
  kind: 'compound';
  firstUnitId: number;
  /** > 0: 1 first unit = conversion second units (1 Box = 12 Nos). */
  conversion: number;
  secondUnitId: number;
}

export type UnitSaveInput = SimpleUnitSaveInput | CompoundUnitSaveInput;

// ───────────────────────────── GST details (groups & items) ─────────────────────────────

export interface GstHistoryRow {
  id: number;
  applicableFrom: string;
  hsnSac: string | null;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  /** Specific cess, paise per base unit. */
  cessPerUnit: number;
}

/** Resolved GST profile of a stock item on a date (see resolveItemGstProfile). */
export interface ItemGstProfile {
  source: 'item_history' | 'item' | 'group_history' | 'group';
  /** Stock item id (item sources) or stock group id (group sources). */
  sourceId: number;
  /** Effective date of the history row; null for current master columns. */
  applicableFrom: string | null;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  cessPerUnit: number;
  hsnSac: string | null;
}

export interface ItemGstProfileInput {
  itemId: number;
  date: string;
}

/** GST fields shared by stock group and stock item save inputs. */
export interface GstFieldsInput {
  /** true: this master carries its own GST details. Default: true when a rate or a non-taxable taxability is given. */
  gstApplicable?: boolean;
  hsnSac?: string | null;
  taxability?: Taxability;
  gstRate?: number | null;
  cessRate?: number | null;
  /** Paise per base unit. */
  cessPerUnit?: number | null;
  /** Date the (changed) GST details apply from; creates/updates a gst_rate_history row. */
  gstApplicableFrom?: string;
  /** Accept a GST rate that is not a notified slab (GST_RATES). */
  allowNonStandardRate?: boolean;
}

// ───────────────────────────── Trees: groups, categories, godowns ─────────────────────────────

export interface TreeListInput extends ListInput {
  /** Only direct children of this parent (null = top level). Omit for all. */
  parentId?: number | null;
}

export interface StockGroupDto {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parentId: number | null;
  parentName: string | null;
  addQuantities: boolean;
  gstApplicable: boolean;
  hsnSac: string | null;
  taxability: Taxability | null;
  gstRate: number | null;
  cessRate: number | null;
  cessPerUnit: number;
  childCount: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StockGroupDetail extends StockGroupDto {
  gstHistory: GstHistoryRow[];
  /** Ancestors, nearest first. */
  path: Array<{ id: number; name: string }>;
}

export interface StockGroupSaveInput extends GstFieldsInput {
  id?: number;
  name: string;
  alias?: string | null;
  parentId?: number | null;
  addQuantities?: boolean;
}

export interface StockCategoryDto {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parentId: number | null;
  parentName: string | null;
  childCount: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StockCategorySaveInput {
  id?: number;
  name: string;
  alias?: string | null;
  parentId?: number | null;
}

export interface GodownDto {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parentId: number | null;
  parentName: string | null;
  address: string | null;
  /** 'Main Location' — cannot be deleted. */
  isPredefined: boolean;
  isThirdParty: boolean;
  /** Job work (mfg module): whose stock this is; 'none' for own premises. */
  thirdPartyKind: ThirdPartyKind;
  /** Job worker / principal the godown belongs to. */
  partyLedgerId: number | null;
  partyName: string | null;
  childCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GodownSaveInput {
  id?: number;
  name: string;
  alias?: string | null;
  parentId?: number | null;
  address?: string | null;
  /** Legacy switch: true = our stock with a third party (thirdPartyKind wins when both are given). */
  isThirdParty?: boolean;
  thirdPartyKind?: ThirdPartyKind;
  partyLedgerId?: number | null;
}

// ───────────────────────────── Stock items ─────────────────────────────

export type CostingMethod = 'avg_cost' | 'fifo' | 'lifo' | 'last_purchase' | 'std_cost';
export const COSTING_METHODS: readonly CostingMethod[] = ['avg_cost', 'fifo', 'lifo', 'last_purchase', 'std_cost'];
export type MarketValuation = 'avg_price' | 'last_sale' | 'std_price';
export const MARKET_VALUATIONS: readonly MarketValuation[] = ['avg_price', 'last_sale', 'std_price'];

export interface StockItemListInput extends ListInput {
  groupId?: number;
  categoryId?: number;
  /** With groupId/categoryId: include items of sub-groups/sub-categories (default true). */
  includeSubgroups?: boolean;
  /** Add stockQty (as of asOf, default today) to each returned row. */
  withStock?: boolean;
  asOf?: string;
  /** Hide deactivated items (default false). */
  activeOnly?: boolean;
}

export interface StockItemListRow {
  id: number;
  name: string;
  alias: string | null;
  /** Additional aliases after `alias` (dataplus; omitted when there are none). */
  otherAliases?: string[];
  partNo: string | null;
  barcode: string | null;
  groupId: number | null;
  groupName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  unitId: number;
  unitSymbol: string;
  hsnSac: string | null;
  gstRate: number | null;
  isService: boolean;
  isActive: boolean;
  maintainBatches: boolean;
  costingMethod: CostingMethod;
  sellingPrice: number | null;
  mrp: number | null;
  /** Present only when withStock was requested. */
  stockQty?: number;
}

export interface StockOpeningRow {
  id: number;
  godownId: number;
  godownName: string;
  batchName: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  qty: number;
  /** Rupees per base unit. */
  rate: number;
  /** Paise. */
  value: number;
}

export interface StockOpeningInput {
  /** Required when the multipleGodowns feature is on; otherwise Main Location. */
  godownId?: number | null;
  /** Required when the item is maintained in batches. */
  batchName?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
  qty: number;
  /** Rupees per base unit (default value / qty). */
  rate?: number | null;
  /** Paise (default qty × rate rounded to paise). */
  value?: number | null;
}

export interface PriceSlab {
  qtyFrom: number;
  /** Exclusive upper bound; null = no upper limit. */
  qtyTo: number | null;
  /** Rupees per base unit. */
  rate: number;
  discountPct: number;
}

export interface ItemPriceListEntry {
  priceLevelId: number;
  priceLevelName: string;
  applicableFrom: string;
  slabs: PriceSlab[];
}

export interface StockItemDetail {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  /** Every alias in order: `alias` (the first) followed by the additional aliases (dataplus; always
   * filled by the core — optional only so hand-built test details stay valid). */
  aliases?: string[];
  partNo: string | null;
  barcode: string | null;
  description: string | null;
  groupId: number | null;
  groupName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  unitId: number;
  unitSymbol: string;
  unitDecimals: number;
  altUnitId: number | null;
  altUnitSymbol: string | null;
  /** Base units per 1 alternate unit. */
  altConversion: number | null;
  maintainBatches: boolean;
  trackMfgDate: boolean;
  useExpiry: boolean;
  costingMethod: CostingMethod;
  marketValuation: MarketValuation;
  isService: boolean;
  gstApplicable: boolean;
  hsnSac: string | null;
  taxability: Taxability;
  gstRate: number | null;
  cessRate: number | null;
  cessPerUnit: number;
  rateInclusiveOfTax: boolean;
  mrp: number | null;
  sellingPrice: number | null;
  purchasePrice: number | null;
  standardCost: number | null;
  reorderLevel: number | null;
  minOrderQty: number | null;
  isActive: boolean;
  openings: StockOpeningRow[];
  openingTotal: { qty: number; value: number };
  gstHistory: GstHistoryRow[];
  /** GST profile resolved as of the working date (null: falls back to the sales/purchase ledger). */
  effectiveGst: ItemGstProfile | null;
  /** Price list applicable on the working date, per price level. */
  priceLists: ItemPriceListEntry[];
  /** Item has inventory entries (unit can no longer change; cannot be deleted). */
  hasTransactions: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create (no id) or alter (id). On alter, omitted fields keep their current value and `null`
 * clears a nullable field; `openings` (when given) replaces all opening rows.
 */
export interface StockItemSaveInput extends GstFieldsInput {
  id?: number;
  name?: string;
  alias?: string | null;
  /**
   * The complete alias list (dataplus): the first becomes `alias`, the rest are additional aliases.
   * When given it replaces `alias` and every additional alias; omit it to keep them.
   */
  aliases?: string[];
  partNo?: string | null;
  barcode?: string | null;
  description?: string | null;
  groupId?: number | null;
  categoryId?: number | null;
  unitId?: number;
  altUnitId?: number | null;
  altConversion?: number | null;
  maintainBatches?: boolean;
  trackMfgDate?: boolean;
  useExpiry?: boolean;
  costingMethod?: CostingMethod;
  marketValuation?: MarketValuation;
  isService?: boolean;
  rateInclusiveOfTax?: boolean;
  mrp?: number | null;
  sellingPrice?: number | null;
  purchasePrice?: number | null;
  standardCost?: number | null;
  reorderLevel?: number | null;
  minOrderQty?: number | null;
  isActive?: boolean;
  openings?: StockOpeningInput[];
}

export interface StockItemSaveResult {
  item: StockItemDetail;
  /** Non-blocking notes for the user (e.g. batches feature is off). */
  warnings: string[];
}

export interface StockItemBulkCreateInput {
  /** Default stock group for rows that do not name one. */
  groupId?: number | null;
  rows: StockItemSaveInput[];
}

export interface StockItemBulkCreateResult {
  created: Array<{ id: number; name: string }>;
  warnings: string[];
}

export interface ItemPickerInput {
  /** Date for GST resolution, price list and stock (default: working date). */
  asOf?: string;
  /** Stock quantity in this godown only (default: all godowns). */
  godownId?: number;
  /** Add the price-level rate applicable on asOf for quantity 1. */
  priceLevelId?: number;
  /** Only items whose name, alias, part no. or barcode contains this text (names starting with it first). */
  search?: string;
  /** At most this many rows (default: all). */
  limit?: number;
}

export interface ItemPickerRow {
  id: number;
  name: string;
  alias: string | null;
  /** Additional aliases after `alias` (dataplus; omitted when there are none) — searched by pickers. */
  otherAliases?: string[];
  partNo: string | null;
  barcode: string | null;
  unitSymbol: string;
  unitDecimals: number;
  altUnit: { id: number; symbol: string; conversion: number } | null;
  groupName: string | null;
  gst: { rate: number; cessRate: number; cessPerUnit: number; taxability: Taxability; hsnSac: string | null } | null;
  /** Paise. */
  sellingPrice: number | null;
  purchasePrice: number | null;
  mrp: number | null;
  /** Price-level slab for quantity 1 (rupees), when priceLevelId was given and a list applies. */
  priceLevel: { rate: number; discountPct: number } | null;
  stockQty: number;
  isService: boolean;
  maintainBatches: boolean;
}

// ───────────────────────────── Price levels & lists ─────────────────────────────

export interface PriceLevelDto {
  id: number;
  guid: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PriceLevelSaveInput {
  id?: number;
  name: string;
}

export interface PriceListGetInput {
  priceLevelId: number;
  date: string;
  search?: string;
  groupId?: number;
  /** Also return items that have no price list on the date (slabs: []). */
  includeAllItems?: boolean;
}

export interface PriceListItem {
  itemId: number;
  itemName: string;
  unitSymbol: string;
  /** Paise — the item's default selling price, for reference. */
  sellingPrice: number | null;
  /** Date of the applicable list (null when the item has none on the date). */
  applicableFrom: string | null;
  slabs: PriceSlab[];
}

export interface PriceListDto {
  priceLevelId: number;
  priceLevelName: string;
  date: string;
  rows: PriceListItem[];
}

export interface PriceListSaveRow {
  itemId: number;
  qtyFrom: number;
  qtyTo?: number | null;
  rate: number;
  discountPct?: number;
}

export interface PriceListSaveInput {
  priceLevelId: number;
  applicableFrom: string;
  /** Slabs per item; each item present here gets its slabs on applicableFrom replaced. */
  rows: PriceListSaveRow[];
  /** Remove the list dated applicableFrom for these items. */
  clearItemIds?: number[];
}

export interface PriceForInput {
  itemId: number;
  priceLevelId?: number;
  date: string;
  qty: number;
  /** Default 'sales'. Purchase uses the item's purchase price (price lists are for sales). */
  side?: 'sales' | 'purchase';
}

export interface PriceForResult {
  /** Rupees per base unit, exclusive of tax. */
  rate: number;
  discountPct: number;
  source: 'price_list' | 'item_default';
  /** Present when source = price_list. */
  applicableFrom?: string;
}

// ───────────────────────────── Stock engine ─────────────────────────────

export interface StockOnHandInput {
  itemId: number;
  godownId?: number;
  /** With godownId: include the godowns under it (default false: that godown only). */
  includeSubGodowns?: boolean;
  batchName?: string;
  asOf: string;
  /** Leave out this voucher (the one being altered on screen). */
  excludeVoucherId?: number;
}

export interface StockOnHandResult {
  itemId: number;
  godownId: number | null;
  batchName: string | null;
  asOf: string;
  qty: number;
}

export interface BatchesInput {
  itemId: number;
  godownId?: number;
  /** With godownId: include the godowns under it (default false: that godown only). */
  includeSubGodowns?: boolean;
  asOf: string;
  /** Leave out this voucher (the one being altered on screen). */
  excludeVoucherId?: number;
}

export interface BatchBalance {
  batchName: string;
  mfgDate: string | null;
  expiryDate: string | null;
  qty: number;
}

export interface StockValuationInput {
  from: string;
  to: string;
  itemIds?: number[];
  godownId?: number;
  /** With godownId: include the godowns under it (the usual godown summary of a parent location). Default false. */
  includeSubGodowns?: boolean;
}

export interface QtyValue {
  qty: number;
  /** Paise. */
  value: number;
}

export interface StockValuationRow {
  itemId: number;
  name: string;
  unit: string;
  groupId: number | null;
  costingMethod: CostingMethod;
  opening: QtyValue;
  inward: QtyValue;
  outward: QtyValue;
  /** rate: rupees per base unit (value ÷ qty; 0 when qty is 0). */
  closing: QtyValue & { rate: number };
}

export interface StockValuationResult {
  from: string;
  to: string;
  godownId: number | null;
  rows: StockValuationRow[];
  /** Paise. Quantities are not totalled (items have different units). */
  totals: { openingValue: number; inwardValue: number; outwardValue: number; closingValue: number };
}
