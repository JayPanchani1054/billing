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
| `history.ts` | Removing one dated GST row of an item or group (`inventory.gstHistory.delete`) |
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
  audited with before/after snapshots in the same transaction — including compound units altered
  by a rename / decimals change of their parts, and an item's price-list slabs when it is deleted.
- **Opening stock** is dated at the books beginning. It cannot be added, changed or removed (nor an
  item with opening stock deleted) while the books are locked on or after that date (`LOCKED`).
  Quantities are at most 1e12 and each row's value at most ₹9,00,00,00,00,000.00 (safe paise).
  A batch name is required for batch items only while the company's *Batches* feature is on (the
  posting engine records batches only then); an item cannot stop maintaining batches while its
  opening stock is batch-wise (re-enter the openings in the same save).
- **Units:** decimal places cannot be reduced below what existing opening / voucher quantities of
  items counted in the unit (or in a compound unit built on it) need. A compound unit always has its
  second unit's decimal places.

## What moves stock

One definition, used by every quantity and value function (`STOCK_MOVEMENT_FILTER` in `stock.ts`):

- `stock_openings` rows (opening stock at books beginning) always count;
- `inventory_entries ie JOIN vouchers v` where
  `ie.affects_stock = 1`
  `AND v.is_optional = 0 AND v.is_cancelled = 0`
  `AND (v.is_post_dated = 0 OR ie.date <= :today)`
  `AND v.base_type NOT IN ('sales_order','purchase_order','memorandum')`
  `AND ie.date <= :asOf`.

An entry without a godown counts in *Main Location*. Godown filters are exact by default; with
`includeSubGodowns: true` (functions and the `stockOnHand` / `batches` / `valuation` routes) a godown
also covers every godown under it, like Tally's godown summary of a parent location. Batch names
match case-insensitively.

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

Use `stockOnHand(db, { …, excludeVoucherId })` (or the routes' `excludeVoucherId`) to compute the
book quantity while altering a voucher.

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

- The master's own columns always hold the details **in force now**: a change dated *before* the
  latest dated row (a back-dated correction) only adds a history row, and the item save returns a
  warning saying so.
- `inventory.gstHistory.delete { id }` (masters.alter) removes one dated row of a stock item or
  group (e.g. a wrong date); when it was the latest row, the columns go back to the new latest row.
  Audited as an alteration of the master.
- Taxability: switching a taxable master to exempt / nil-rated / non-GST drops its rate and cess
  (only a rate or cess typed in the same save is an error); switching back to taxable requires a
  rate — the stored 0 is never kept as "taxable at 0%".

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

### Opening stock at the books beginning

For a period starting on or before the books beginning, each item's opening value is the opening
stock **as entered in the item master** (Σ `stock_openings.value`), whatever the costing method —
so the Balance Sheet's opening stock matches the masters. Later periods open with the previous
day's closing value (periods chain). FIFO/LIFO take each opening row as its own layer; the other
methods take the rows together, so Last Purchase starts from the **weighted** opening rate
(Σ value ÷ Σ qty), not from whichever row is last. (Standard Cost therefore shows the revaluation to
standard cost in the first period, like the purchase price variance.)

### Godown filter

Quantities and inward/outward movements are those of that godown (exact, or with its sub-godowns
when `includeSubGodowns`). Opening and closing values use the **item's** unit cost across all
godowns: `round(godownQ × V/Q)`.

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

### Engine performance

- **One replay serves many figures.** `stockValuesAt` takes several whole-company value points
  (opening at the start of a date, closing at the end of one) during one pass — each equal to
  `openingStockValue` / `closingStockValue` for its date. `traceStockMovements` records the cost the
  replay applied to each line of the traced items (and each item's day closings) in the same pass as
  the valuation, so the stock reports never value twice.
- **Memo across requests.** Results (value points; the last 4 full valuations, deep-frozen) are kept
  per open database and keyed on `Db.dataRevision()` — `total_changes()` of the app's connection
  (every save / cancel / delete / import / settings change, even one later rolled back) plus
  `PRAGMA data_version` (commits by any other connection) — and the working date. Nothing is cached
  inside a transaction (uncommitted data could be rolled back). Callers must copy before changing a
  result (`computeStockValuation` returns a frozen object).
- **Index-friendly SQL, no catch-all flags.** Each statement is a constant chosen by shape: the
  whole company is one sequential scan of `inventory_entries` (`NOT INDEXED`, `CROSS JOIN` so the
  plan cannot flip to a per-voucher scan), vouchers by primary key; a few items (up to a quarter of
  the company's items) read their own lines through `idx_ie_item_date` (pinned with `INDEXED BY`)
  plus the other lines of the stock journals they appear in; more items share the scan and the
  replay skips the rest. A `(:filter = 0 OR item_id IN …)` flag would hide the index and, once
  ANALYZE statistics exist, become a skip-scan over every item id (`engine.test.ts` runs ANALYZE and
  checks the plans). The same rule applies to `stockByItem` and the price-list look-ups.
- On the auditors' 60,000-voucher company (8,000 items, 130,000 movements): a whole-company replay
  ≈ 0.35–0.5 s, one item ≈ 3 ms (was 64–80 ms; 0.4 s with statistics).

## Exported helpers (`index.ts`)

```ts
// GST
resolveItemGstProfile(db: Db, itemId: number, date: string): ItemGstProfile | null
resolveGroupGstProfile(db: Db, groupId: number | null, date: string): ItemGstProfile | null
createGstResolver(db: Db, date: string): (item: ItemGstSource) => ItemGstProfile | null   // bulk, same result
columnsComplete(row): boolean                                                            // "own details usable" rule

// Quantities
STOCK_MOVEMENT_FILTER: string            // SQL condition on `ie`/`v`, needs :today
stockOnHand(db, { itemId, godownId?, includeSubGodowns?, batchName?, asOf, excludeVoucherId?, today? }): number
batchesFor(db, itemId, godownId: number | null | undefined, asOf, { today?, excludeVoucherId?, includeSubGodowns? }?): BatchBalance[]  // FEFO
stockByItem(db, { asOf, today?, godownId?, includeSubGodowns?, itemIds?, excludeVoucherId? }): Map<number, number>
godownSet(db, godownId, includeSub): Set<number>   // the godown (+ all godowns under it)
itemHasTransactions(db, itemId): boolean
roundQty(q): number                      // 6 decimals

// Values (paise)
computeStockValuation(db, { from, to, itemIds?, godownId?, includeSubGodowns?, today }): StockValuationResult  // memoised, FROZEN result
stockValuesAt(db, { opening?: dates, closing?: dates, today }): { opening: Map, closing: Map }  // whole company, ONE replay
closingStockValue(db, { asOf, today, godownId?, includeSubGodowns? }): number   // Balance Sheet / P&L closing stock
openingStockValue(db, { from, today, godownId?, includeSubGodowns? }): number   // value at the start of `from` (entered values at books beginning)
currentUnitCost(db, { itemId, asOf, today }): number          // rupees per base unit
traceStockMovements(db, { …valuation options, traceItemIds, traceFrom? }): StockTraceResult  // valuation + cost of every traced line + day closings, ONE replay
stockReplayCount(): number                                    // replays run in this process (tests: "one replay per request")

// Prices & masters
priceFor(db, { itemId, priceLevelId?, date, qty, side? }): PriceForResult
slabForQty(slabs, qty): PriceSlab | null
getItem(db, id, asOf): StockItemDetail;  listItems(db, input, today)
itemPicker(db, { asOf?, godownId?, priceLevelId?, search?, limit? }, today): ItemPickerRow[]   // search: name/alias/part no./barcode
booksFrom(db): string;  mainGodownId(db): number;  compoundSymbol(first, conversion, second): string
inventoryRoutes
```

`today` is the working date (`ctx.clock.today()`); when `stockOnHand`/`batchesFor`/`stockByItem` get
no `today`, post-dated vouchers up to `asOf` count.

## Known gaps

- Physical stock entries must carry the signed difference; a later back-dated entry before a
  physical stock voucher is not re-absorbed (Tally re-bases on the counted quantity).
- Third-party godowns are valued like own stock (the single `is_third_party` flag does not say
  whose stock it is).
- Value-only inward lines (qty 0, amount > 0) are ignored by the valuation.
- Average Cost with negative stock: the next inward restarts the average at its own rate, so for
  that item opening + inward − outward can differ from closing by the re-pricing of the shortfall
  (Standard Cost / Last Purchase show their revaluation the same way).
- An item switched from "inherit GST" to its own details with a later `applicableFrom` uses the new
  details for earlier dates too (history cannot express "inherit until").
- When no level of the item chain has an HSN/SAC the profile's `hsnSac` is null; the vouchers
  engine then also looks at the sales/purchase ledger.
- Market valuation (`market_valuation`) is stored but not used; no lower-of-cost-or-market.
