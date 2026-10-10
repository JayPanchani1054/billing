# Stock module (core): inventory reports

Read-only inventory reports in the conventional mould: Stock Summary (by group, by category), Stock Item
Vouchers, Godown Summary, Movement Analysis, Ageing, Reorder Status, Negative Stock, Batch Summary,
Pending Orders (order processing), Item Profitability and the Physical Stock variance register.

Every value comes from, or is proven against, the **inventory module's valuation engine**
(`computeStockValuation`, see `src/core/modules/inventory/README.md`). Totals tie to the closing
stock in the P&L and Balance Sheet.

| File | Contents |
|---|---|
| `routes.ts` | The 12 `stock.*` routes and their input schemas |
| `common.ts` | Period check, item / tree (group, category, godown) lookups, movement loader, `QtySum` |
| `trace.ts` | Per-movement cost values: a thin wrapper over the engine's own replay (`traceStockMovements`, see below) |
| `summary.ts` | `stock.summary`, `stock.categorySummary`, `stock.godownSummary` |
| `itemVouchers.ts` | `stock.itemVouchers` |
| `movement.ts` | `stock.movement` |
| `ageing.ts` | `stock.ageing` |
| `orders.ts` | `stock.pendingOrders`, `stock.reorder` (and `orderPositions`, `pendingQtyByItem`) |
| `exceptions.ts` | `stock.negative`, `stock.batches` |
| `profitability.ts` | `stock.profitability`, `stock.physicalVariance` |
| `testkit.ts` | Scenario posted through the vouchers service (used by tests only) |

DTOs: `src/shared/types/stock.ts`. No migration is needed (`070_stock.ts` stays empty).

## Routes

All company scope, `reports.view`, `transactional: false` (read-only, nothing is written or audited) —
except `stock.profitability`, which needs `reports.financial` (item margins are P&L information;
the Data Entry role holds `reports.view` only).

| Route | Input | Output |
|---|---|---|
| `stock.summary` | `{ from, to, groupId?, categoryId?, godownId?, showValues? (true), showZero? (false) }` | `StockSummaryResult` — tree rows (`g:<id>` groups, `i:<id>` items) with opening / inward / outward / closing `{ qty, value }` (+ closing `rate`), totals |
| `stock.categorySummary` | `{ from, to, godownId?, showValues?, showZero? }` | `StockSummaryResult` with `c:<id>` category rows; items without a category under `c:none` "Not categorised" |
| `stock.itemVouchers` | `{ itemId, from, to, godownId? }` | `StockItemVouchersResult` — opening, one row per voucher (in / out qty + value at cost, running closing), totals, closing |
| `stock.godownSummary` | `{ godownId?, asOf, showZero? }` | `GodownSummaryResult` — godown tree (`gd:<id>`) with the items held there (`gi:<godown>:<item>`), qty, rate, value |
| `stock.movement` | `{ from, to, itemId? \| groupId? }` | `StockMovementResult` — inward by party, outward by party (qty, value, avg rate, vouchers, per-item breakdown) + party-less `internal` quantities |
| `stock.ageing` | `{ asOf, buckets? ([30,60,90,180]), groupId? }` | `StockAgeingResult` — per item qty / value per age bucket, oldest inward date, average age |
| `stock.reorder` | `{ asOf }` | `ReorderStatusResult` — items below reorder level with pending purchase / sales orders and the quantity to order |
| `stock.negative` | `{ asOf }` | `NegativeStockResult` — items below zero in total or in any godown, with the date they went negative |
| `stock.batches` | `{ itemId?, asOf, expiringWithinDays? }` | `BatchSummaryResult` — batch balances (FEFO), days to expiry, status `expired / expiring / ok / no_expiry` |
| `stock.pendingOrders` | `{ kind: 'sales' \| 'purchase', asOf }` | `PendingOrdersResult` — order lines with ordered / fulfilled / pending qty, pending value, due date, days overdue; balances pre-closed on or before `asOf` (documents module, `order_closures`) are subtracted and shown as `closedQty` |
| `stock.profitability` | `{ from, to, groupId? }` | `ProfitabilityResult` — per item sales, returns, net sales, cost of goods sold, gross profit, GP % |
| `stock.physicalVariance` | `{ from, to }` | `PhysicalVarianceResult` — physical stock lines: counted, book, difference, value at cost |

Errors: reversed period → `VALIDATION` on `to`; unknown item / group / category / godown →
`NOT_FOUND`; both `itemId` and `groupId` on `stock.movement` → `VALIDATION` on `groupId`; age
buckets not ascending → `VALIDATION` on `buckets[i]`.

## Rules

**What counts.** Exactly the engine's stock filter (`STOCK_MOVEMENT_FILTER`): opening stock, plus
inventory entries that move stock — not optional, not cancelled, not orders / memorandum, post-dated
only once the working date reaches them, and invoice lines that bill a delivery / receipt note (or a
rejection) excluded because the note moved the goods. Services keep no stock and are never listed.

**Stock Summary.** Values from one engine run for the period. Tree: sub-groups first, then items,
each by name; items without a group at the top level. A group's quantity is the sum of its items'
only when the group has *Add quantities* on and the items share one unit (else `null`); values
always add up. `groupId` shows that group's contents at the top level; `categoryId` keeps items of
that category (and its sub-categories); `godownId` covers that godown and the godowns under it
(quantities and movements of the godown, values at the item's overall unit cost, as the engine
does). `showValues: false` adds up quantities straight from the movements (no valuation) and returns
`valuesShown: false` with every value 0. Groups without listed items are hidden.

**Per-movement values (`trace.ts`).** The item ledger, profitability, FIFO ageing and the physical
register need the cost of each voucher line, not only period totals. The inventory engine records
them during its own replay (`traceStockMovements` in `inventory/valuation.ts`): the cost it applied
to every line of the traced items and each item's closing at the end of every day with a movement,
together with the valuation itself — ONE replay, no second "proof" run and no per-day fallback.
The figures are the engine's by construction (`trace.test.ts` and `inventory/engine.test.ts` keep the
equivalence with independent per-day engine runs as a property test). Stock Item Vouchers and Ageing
take the valuation and the line costs from that same pass; profitability and the physical register
trace the items they need.

**Stock Item Vouchers.** One row per voucher (all its lines of the item). Particulars = party name,
else "Stock Journal" / "Physical stock count" / voucher type. The running value is re-based on the
engine's closing at the end of every day, so the last row always equals the Stock Summary's closing
(including Average Cost re-pricing after negative stock). A stock-journal transfer between godowns
shows both its inward and outward.

**Godown Summary.** Quantities per exact godown. Values: one engine run gives each item's closing
value, split over the godowns holding it by quantity (largest remainder), so the godowns add up to
the closing stock to the paisa (rounding each godown alone could leave it a paisa or more off). An
item with negative or zero stock somewhere is valued per godown by the engine instead (godown
quantity × the item's unit cost). A godown's value includes its sub-godowns; its quantity is not
shown (items differ in units). Empty godowns are hidden unless `showZero` (a godown asked for by
`godownId` is always shown).

**Movement Analysis.** Party movements only: inward = purchase, receipt note, rejection in, credit
note (sales return); outward = sales, delivery note, rejection out, debit note (purchase return).
Quantity and value come from the lines that physically moved the stock (a delivery note counts when
the goods left; the invoice billing it is not counted again); value = line value before GST.
Stock journals and physical stock are reported as `internal` quantities. Vouchers without a party
ledger are pooled under one row "Without a party ledger". Rows sorted by value.

**Ageing.** FIFO by inward date whatever the costing method: the stock on hand is the latest
inwards (net positive quantity per voucher, so a godown transfer does not renew the age; opening
stock dated at the books beginning, each opening row its own layer for FIFO items). Values add up
to the engine closing value: FIFO items value each slice at the cost of the inward it came from
(the remaining layers, from `trace.ts`; any rounding residue spread by quantity); other methods
hold every unit at one cost, so the closing value is split by quantity. Default buckets 0–30,
31–60, 61–90, 91–180, over 180 days. Only items with stock > 0.

**Orders.** Order lines carry the order number in `order_ref`; fulfilment = delivery notes (sales)
/ receipt notes (purchase) and invoices that do **not** bill a note, with the same `order_ref`, same
party, same item — matched to the order's lines in date order (the vouchers module's
`trackingRefs` rule), counting only documents dated on or before `asOf`. Optional and cancelled
documents never count. Due date = the order's effective ("due on") date when entered; overdue days
are counted to `asOf`. Pending value = `lineAmount(pending, rate, discount%)`.

**Reorder Status.** Items with a reorder level (> 0): net available = closing + pending purchase
orders − pending sales orders; shortfall = max(0, level − net); listed when the stock on hand or
the net available is below the level; quantity to order = the shortfall, at least the item's
minimum order quantity (0 when open purchase orders already cover it).

**Negative Stock.** Items whose total is below zero, or that are below zero in any godown (the item
total may be positive). `negativeSince` = first day of the current negative run. Value = engine
closing value (negative stock valued at the last known cost — purchase price before any purchase).

**Batch Summary.** `batchesFor` per item (all godowns): positive balances in FEFO order. Days to
expiry = expiry − asOf; `expired` (< 0), `expiring` (≤ window, default 30 days), `ok`, `no_expiry`.
`expiringWithinDays` keeps only expired / expiring. Items that keep batches or carry batch names.

**Profitability.** Cost matched to invoices: sales = taxable value of sales-invoice item lines in
the books (incl. lines billing a delivery note), quantity as billed, plus the item lines of debit
notes to customers (upward price revisions: value only — no quantity, no cost — so net sales agree with
the P&L's Sales Accounts); returns = credit-note item lines; cost = each invoice line's own movement cost (credit notes come back at cost and reduce it),
or — for a line billing a delivery note / rejection in — the note's cost per unit × billed qty,
wherever the note is dated. Un-invoiced delivery notes, stock journals, physical losses and
purchase returns are not cost of sales. Sales / credit notes use the books filter (`BOOKS_FILTER`).
GP % = GP ÷ net sales × 100 (2 dp; null without net sales). Rows sorted by gross profit.

**Physical Variance.** Every count of regular physical stock vouchers in the period: counted
quantity (from the voucher as entered), book = counted − difference (the posting engine stores
counted − book), the difference and its value at cost (+ gain, − loss). Lines of one voucher counting
the same item / godown / batch (two racks) are one row: Σ counted, the real book quantity, Σ
difference, Σ value.

## Worked numbers (tests)

`testkit.ts` posts the inventory README's April example for item A (Average Cost) and runs a FIFO
item through the same trades, then May–June notes, orders, a physical count, batches with expiry,
negative stock, a godown transfer and an optional voucher. Key figures: April A closing 8 / ₹954.66,
FIFO closing 16 / ₹2,023.30; Kitchenware 28 / ₹3,932.62; A's April GP ₹996.02 (26.77 %); pending
purchase order 30 worth ₹3,600, 36 days overdue; reorder: 18 + 30 − 6 = 42 < 50 → order 25.

Run: `node --test "src/core/modules/stock/**/*.test.ts"`.

## Performance

Every report runs at most ONE valuation replay (`perf.test.ts` asserts the count, the deterministic
part of the budget). On 8,000 items / 60,000 item invoices over two years (in-memory, `perf.test.ts`):
Item Profitability (year) ≈ 0.3 s · Stock Item Vouchers ≈ 5 ms (the item index) · Ageing ≈ 0.45 s ·
Stock Summary ≈ 0.25 s. On the auditors' 60,000-voucher file company (8,000 items, 130,000 movements
since 2021): profitability 0.6–0.8 s (was 2.2–3.2 s), item vouchers 3–5 ms (was 0.1–0.26 s), ageing
≈ 0.6 s (was 1.1–1.7 s); a repeated Stock Summary / valuation with unchanged books comes from the
inventory memo (≈ 20 ms).

## Known gaps

- Batch Summary is not split by godown; batch values are not shown.
- Orders have no per-line due date (the voucher's effective date is used); order numbers that
  repeat across years for the same party share fulfilment (same limitation as `vouchers.trackingRefs`).
- Movement Analysis values notes at their own rate, not at the invoice that later bills them.
- Ageing treats LIFO items like the others (FIFO ages, value split by quantity).
- Godowns holding our goods with a job worker ("our stock with third party") are valued like own stock;
  a principal's goods with us ("third-party stock with us", mfg module) are never valued and stay out of
  closing stock — the valuation engine leaves them out (inventory/valuation.ts).
