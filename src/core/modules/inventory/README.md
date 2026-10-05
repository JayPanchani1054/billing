# Inventory module (core)

Inventory masters (units, stock groups, stock categories, godowns, stock items, price levels and
price lists), the GST profile resolver for stock items, and the stock quantity / valuation engine
used by vouchers and reports.

| File | Contents |
|---|---|
| `routes.ts` | All `inventory.*` routes and their input schemas |
| `units.ts` | Simple and compound units |
| `masters.ts` | Stock groups (GST details + history), stock categories, godowns |
| `items.ts` | Stock items: list / get / save / delete / bulk create / picker |
| `gst.ts` | GST details validation, effective-dated history, `resolveItemGstProfile` |
| `prices.ts` | Price levels, price lists (quantity slabs), `priceFor` |
| `stock.ts` | Stock movement filter, `stockOnHand`, `batchesFor`, `stockByItem` |
| `valuation.ts` | `computeStockValuation`, `closingStockValue`, `openingStockValue`, `currentUnitCost` |
| `index.ts` | Public API for other modules (import from here) |
| `testkit.ts` | Test-only SQL helpers that write vouchers + inventory entries directly |

DTOs and the route table are in `src/shared/types/inventory.ts`. Migration `040_inventory.ts` adds
`stock_groups.cess_per_unit` and lookup indexes.

## Conventions

- Quantities are REAL in the item's **base unit**; inward `+`, outward `−`.
- Every `value` is integer **paise**. Item prices (`mrp`, `sellingPrice`, `purchasePrice`,
  `standardCost`) are paise. Opening-stock and price-list `rate`s are **rupees per base unit**
  (REAL), like voucher lines.
- Saves are create (no `id`) or alter (`id`). On alter, an omitted field keeps its value and `null`
  clears it. Save routes are open to `masters.view`; the service then requires `masters.create`
  (new) or `masters.alter` (existing). Deletes need `masters.delete`. Every create/alter/delete is
  audited with before/after snapshots in the same transaction.

## What moves stock

One definition, used by every quantity and value function (`STOCK_MOVEMENT_FILTER` in `stock.ts`):

- `stock_openings` rows (opening stock at books beginning) always count;
- `inventory_entries ie JOIN vouchers v` where
  `ie.affects_stock = 1`
  `AND v.is_optional = 0 AND v.is_cancelled = 0`
  `AND (v.is_post_dated = 0 OR ie.date <= :today)`
  `AND v.base_type NOT IN ('sales_order','purchase_order','memorandum')`
  `AND ie.date <= :asOf`.

An entry without a godown counts in *Main Location*. Godown filters are exact: sub-godowns are not
included. Batch names match case-insensitively.

### Contract for the posting engine (vouchers)

| Voucher | `inventory_entries.qty` | `amount` |
|---|---|---|
| Purchase, Receipt Note | `+qty` | taxable value (inward value) |
| Sales, Delivery Note, Debit Note (purchase return), Rejections Out | `−qty` | sale value (ignored for cost) |
| Credit Note (sales return), Rejections In | `+qty` | ignored: re-enters at current cost |
| Stock Journal | consumption `−qty` with `is_consumption = 1`; production `+qty` | production: value if known, else `0` (gets the consumed cost) |
| Physical Stock | **signed difference** (counted − book quantity at save time) | ignored: valued at current cost |
| Invoice line tracked against a delivery/receipt note | any | `affects_stock = 0` |
| Orders, Memorandum | any | never move stock |

Use `stockOnHand(db, { …, excludeVoucherId })` to compute the book quantity while altering a voucher.

## GST profile of a stock item

`resolveItemGstProfile(db, itemId, date)` returns `{ source, sourceId, applicableFrom, taxability,
rate, cessRate, cessPerUnit, hsnSac } | null`. Precedence (the vouchers engine must use this exact
function or `createGstResolver` for bulk):

1. the item's `gst_rate_history` row with the latest `applicable_from ≤ date`;
2. the item's own columns, when `gst_applicable = 'applicable'` **and** the details are complete
   (a rate is set, or the taxability is exempt / nil-rated / non-GST);
3. the stock group chain, nearest group first: the group's history row (latest `≤ date`), then its
   columns under the same completeness rule;
4. `null` → the caller falls back to the sales/purchase ledger.

Rate, cess and taxability come from the one level that resolved. HSN/SAC comes from that level;
when it has none, from the first non-empty HSN/SAC along the same chain in the same order (item
history, item columns — even without a rate — then each group's history and columns), exactly as
`vouchers/taxprofile.ts` does for its levels 2–4. Non-taxable profiles always have rate, cess and
per-unit cess 0.

**History rules on save** (items and groups): with `gstApplicableFrom` the details are written as a
history row on that date (same date → replaced). When history is introduced for a master that
already had details in its columns, the earlier details are first recorded from the books-beginning
date, so older dates keep the earlier rate. Changing GST details **without** a date while dated
history exists is refused (the accountant must say from when). `gstApplicable: false` removes the
master's history so it inherits again.

## Valuation methods

The engine replays movements in order — date, then voucher id (entry order), then line — starting
from the opening stock. Each item keeps a cost state for its `costing_method`. Notation: `Q` quantity
on hand, `V` value on hand (paise), `q` movement quantity (positive), `round` = `roundPaise` (half
away from zero).

### Average Cost (`avg_cost`, default) — running weighted average

- Inward of `q` worth `v`: `Q ← Q + q`, `V ← V + v`.
- Outward of `q`: value `= round(q × V / Q)`; when the outward empties the stock (`q = Q`) the value is
  exactly `V` (no rounding residue). `Q ← Q − q`, `V ← V − value`.
- So each outward is valued at the average **at its time**, not the period-end average.

### FIFO / LIFO (`fifo`, `lifo`) — cost layers

- Each inward (and each opening-stock row) adds a layer `(q, v)`.
- An outward consumes the oldest (FIFO) / newest (LIFO) layers; a partly consumed layer gives
  `round(take × layerV / layerQ)` and keeps the remainder.

### Last Purchase Cost (`last_purchase`)

- `rate` = `v / q` of the last inward valued at its own amount (purchase, receipt note, production
  with an amount, opening stock) up to that point. Inwards of value 0 (free goods) do not set it.
- Outward value `= round(q × rate)` at the outward's time; closing value `= round(Q × rate)` with the
  last rate on or before the period end.

### Standard Cost (`std_cost`)

- Outward value `= round(q × standard_cost)`; opening and closing value `= round(Q × standard_cost)`.
  Inwards are still reported at their own amount (so opening + inward − outward need not equal
  closing; the difference is the purchase price variance). Saving an item with this method requires
  a standard cost.

### Inward values

| Inward | Value |
|---|---|
| Purchase, Receipt Note, any type not listed below | entry `amount` (taxable, excl. GST); if 0, `qty × rate`; else 0 |
| Credit Note (sales return), Rejections In, Physical Stock gain, positive lines on Sales / Delivery Note / Debit Note / Rejections Out | **current cost** × q |
| Stock Journal production | its `amount` when > 0; otherwise its share of (consumed cost − Σ production amounts given), split by quantity (largest remainder); with no consumption in the voucher, current cost |

*Current cost* = `V/Q` (avg; last average when `Q ≤ 0`), the oldest layer's rate (FIFO), the newest
layer's rate (LIFO), the last purchase rate, or the standard cost. All outwards are valued at cost.
Stock journal consumption lines are processed before production lines of the same voucher.

### Negative stock

An outward beyond the quantity on hand is valued at the **last known cost**: the last average / last
consumed layer's rate / last inward rate; before any inward, the standard cost, else the purchase
price, else 0. Closing value of negative stock is `Q × last known cost` (negative).
For `avg_cost`, the next inward into negative stock restarts the average at that inward's rate
(`V ← round((Q + q) × v / q)`); for layers it first fills the shortfall and only the rest becomes a
layer. The repricing of the shortfall is not pushed back into earlier outwards, so for an item that
went negative, opening + inward − outward can differ from closing by that repricing. Values are
always safe integers — never `NaN`.

### Godown filter

Quantities and inward/outward movements are those of that godown (exact). Opening and closing
values use the **item's** unit cost across all godowns: `round(godownQ × V/Q)`.

### Worked example (also `valuation.test.ts`)

Item A, opening 10 Nos @ ₹100 (`V = 1,00,000` p). Product B has no opening.

| Date | Entry | Average Cost | FIFO |
|---|---|---|---|
| 01-Apr | Opening 10 | Q 10, V 1,00,000 | [10 : 1,00,000] |
| 05-Apr | Purchase +20 @ ₹115 = 2,30,000 | Q 30, V 3,30,000 (11,000/unit) | [10 : 1,00,000][20 : 2,30,000] |
| 10-Apr | Sale −15 | 15 × 11,000 = **1,65,000** → Q 15, V 1,65,000 | 1,00,000 + 5 × 11,500 = **1,57,500** → [15 : 1,72,500] |
| 15-Apr | Purchase +10 @ ₹133.33 = 1,33,330 | Q 25, V 2,98,330 (11,933.2) | [15 : 1,72,500][10 : 1,33,330] |
| 20-Apr | Credit note +3 (at current cost) | 3 × 11,933.2 = 35,799.6 → **35,800** → Q 28, V 3,34,130 | oldest layer 11,500 × 3 = **34,500** |
| 25-Apr | Stock journal −8 A → +4 B | 8 × 3,34,130 / 28 = 95,465.71 → **95,466**; B = 95,466 | 8 × 11,500 = **92,000**; B = 92,000 |
| 28-Apr | Sale −12 | 12 × 2,38,664 / 20 = 1,43,198.4 → **1,43,198** | 7 → 80,500 + 5 × 13,333 = 66,665 → **1,47,165** |
| 30-Apr | Closing | **Q 8, V 95,466** (₹119.3325/unit) | **[5 : 66,665][3 : 34,500] = 1,01,165** |

April stock summary for A (Average Cost): opening 10 / 1,00,000; inward 33 / 3,99,130; outward 35 /
4,03,664; closing 8 / 95,466 (1,00,000 + 3,99,130 − 4,03,664 = 95,466).

## Exported helpers (`index.ts`)

```ts
// GST
resolveItemGstProfile(db: Db, itemId: number, date: string): ItemGstProfile | null
resolveGroupGstProfile(db: Db, groupId: number | null, date: string): ItemGstProfile | null
createGstResolver(db: Db, date: string): (item: ItemGstSource) => ItemGstProfile | null   // bulk, same result
columnsComplete(row): boolean                                                            // "own details usable" rule

// Quantities
STOCK_MOVEMENT_FILTER: string            // SQL condition on `ie`/`v`, needs :today
stockOnHand(db, { itemId, godownId?, batchName?, asOf, excludeVoucherId?, today? }): number
batchesFor(db, itemId, godownId: number | null | undefined, asOf, { today?, excludeVoucherId? }?): BatchBalance[]  // FEFO
stockByItem(db, { asOf, today?, godownId?, itemIds?, excludeVoucherId? }): Map<number, number>
itemHasTransactions(db, itemId): boolean
roundQty(q): number                      // 6 decimals

// Values (paise)
computeStockValuation(db, { from, to, itemIds?, godownId?, today }): StockValuationResult
closingStockValue(db, { asOf, today, godownId? }): number     // Balance Sheet / P&L closing stock
openingStockValue(db, { from, today, godownId? }): number     // value at the start of `from`
currentUnitCost(db, { itemId, asOf, today }): number          // rupees per base unit

// Prices & masters
priceFor(db, { itemId, priceLevelId?, date, qty, side? }): PriceForResult
slabForQty(slabs, qty): PriceSlab | null
getItem(db, id, asOf): StockItemDetail;  listItems(db, input, today);  itemPicker(db, input, today)
booksFrom(db): string;  mainGodownId(db): number;  compoundSymbol(first, conversion, second): string
inventoryRoutes
```

`today` is the working date (`ctx.clock.today()`); when `stockOnHand`/`batchesFor`/`stockByItem` get
no `today`, post-dated vouchers up to `asOf` count.

## Known gaps

- Physical stock entries must carry the signed difference; a later back-dated entry before a
  physical stock voucher is not re-absorbed (Tally re-bases on the counted quantity).
- Godown filters are exact (no roll-up of sub-godowns); third-party godowns are valued like own stock.
- Value-only inward lines (qty 0, amount > 0) are ignored by the valuation.
- An item switched from "inherit GST" to its own details with a later `applicableFrom` uses the new
  details for earlier dates too (history cannot express "inherit until").
- Market valuation (`market_valuation`) is stored but not used; no lower-of-cost-or-market.
