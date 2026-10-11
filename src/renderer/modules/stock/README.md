# Stock reports UI (`src/renderer/modules/stock`)

Inventory reports in the Gateway section **Inventory Reports**. Every screen needs the company's
**Inventory** feature (F11); Godown Summary also needs *Multiple godowns*, Batch Summary *Batches*
and Pending Orders *Order processing*. Access: `reports.view` (Item Profitability:
`reports.financial`, like the P&L). Core API and rules:
`src/core/modules/stock/README.md`; DTOs: `src/shared/types/stock.ts`.

## Screens

| id | params | what | keys (besides Alt+F2 period/date, Alt+E export, Alt+P print, Esc back) |
|---|---|---|---|
| `stock.summary` | `{ from?, to?, groupId?, categoryId?, godownId? }` | Stock Summary: groups → items, closing qty / rate / value; Detailed adds opening, inward, outward. Category select on the toolbar row (`Stock category`); with godowns, Category and Godown sit behind one "Filters ▾" | Enter group → its summary, item → `stock.item` · Alt+F1 Detailed · Alt+V Quantities only · Alt+Z All items · Alt+X Expand/collapse all |
| `stock.categories` | `{ from?, to? }` | Same by stock category ("Not categorised" bucket) | Enter category → `stock.summary { categoryId }` |
| `stock.item` | `{ itemId, from?, to?, godownId? }` | Stock Item Vouchers: opening, each voucher's inward / outward qty and value at cost, running closing; footer opening / totals / closing. Item and godown pickers in the toolbar | Enter → `vouchers.view { id }` · Alt+M item master |
| `stock.godowns` | `{ godownId? }` | Godown Summary as on the period end | Enter item → its vouchers in that godown, godown → Stock Summary of the godown · Alt+Z empty godowns · Alt+X |
| `stock.movement` | `{ itemId?, groupId?, from?, to? }` | Movement Analysis: Inward · Outward tabs, parties (→ items) with qty, avg rate, value; item and group behind "Filters ▾"; a one-line note under the table for party-less quantities | Alt+I Inward · Alt+O Outward · Enter party → `reports.ledger`, item → `stock.item` · Alt+X |
| `stock.ageing` | `{ groupId? }` | Stock Ageing as on: bucket presets (30/60/90/180, 15/30/45/60, 90/180/365) as checkable, keyless More items | Alt+Q values ↔ quantities · Enter → item |
| `stock.reorder` | — | Reorder Status: in stock, level, on order, promised, net, shortfall, order now | Alt+O new Purchase Order · Enter → item |
| `stock.negative` | — | Negative Stock: item → godowns below zero, since when; guidance in About this report | Enter → item (in that godown) · Alt+X |
| `stock.batches` | `{ itemId? }` | Batch Summary: batches with mfg / expiry, days left, status (a badge only for expired / expiring) | Alt+W expiry filter (all → 30 → 90 days) · Enter → item |
| `stock.pendingOrders` | `{ kind?: 'sales' \| 'purchase' }` | Pending orders as on: ordered / delivered (received) / pending, value, due date, "N days overdue" in danger text | Ctrl+1 Sales · Ctrl+2 Purchase · Alt+C create order · Enter → `vouchers.view` (the order) |
| `stock.profitability` | `{ groupId?, from?, to? }` | Item Profitability: net qty, sales, returns, net sales, COGS, GP, GP % | Enter → item |
| `stock.physicalVariance` | `{ from?, to? }` | Physical Stock Register: counted vs books, difference, gain / loss at cost | Alt+C new count · Enter → voucher |

Drill-downs keep the period: a report opened with `{ from, to }` shows that range until the user
changes the global period (Alt+F2). Items opened from an as-on report show the financial year up
to the as-on date. Go To: the inventory module's `items` provider opens `stock.item` (it checks this
screen is registered), so no provider is registered here.

## Graphs and stats (2.1, SPEC-21 §5)

Built by the pure `lib/charts.ts` (tested in `lib/charts.test.ts`: every graph's total equals the table's
total), passed as `graph={reportGraph(spec, { inline })}` (`ui/lazyChart.tsx`, so the chart kit stays out of
the start-up bundle). A builder returns null — no strip, no Ctrl+J — when the data cannot carry a graph
(fewer than 2 non-zero bars, fewer than 2 points on a line — 2.1.1 D2 — or Quantities only).

| Screen | Graph (class) | Total it equals |
|---|---|---|
| `stock.summary` | "Where money is locked in stock": a bar per level-0 row by closing value — inline 4 px bars under *Closing value* for ≤ 7 rows, else Top 6 + Other; polarity when a bar is below zero; none in Quantities only (report) | Grand Total closing value |
| `stock.categories` | "Stock value by category": the same, *Not categorised* grey in the strip (inline bars have one colour: the cell beside them names the row) (report) | Grand Total |
| `stock.godowns` | "Stock value by godown": top-level godowns (report) | Grand Total |
| `stock.movement` | "Biggest buyers" / "Biggest suppliers": parties by value, one colour on both sides (report) | the side's Total |
| `stock.profitability` | "Gross profit by item": top 6 earners + up to 3 loss items + Other, polarity (report) | Total gross profit |
| `stock.ageing` | "Stock value by age": columns per age bucket, ordinal ramp, always value (report) | Σ bucket values = Value total |
| `stock.item` | "Quantity in stock": the running closing quantity in the item's unit (detail — shown by default since 2.1.1) | the closing quantity (last point) |

No graph (§5 "none"), a stat on the toolbar row instead (`StockStat` over `…Stat` builders):
`stock.pendingOrders` "Overdue N lines", `stock.batches` "Expired N · Expiring in 30 days M",
`stock.negative` "Below zero N items", `stock.reorder` "Order now N of M items"; `stock.physicalVariance`
none. Notes that sat above the tables (and the subtitle sentences) are in More › About this report.
Enter on a bar = Enter on its row (`activate`); the "Other" bar opens nothing. Whether the bars are
inline is the kit's count rule (`inlineBars(spec, level-0 rows)`, D26); the bar sits only on the rows the
total adds up (`summaryBarValue`, `godownBarValue`, `movementBarValue` — level-0 rows, top-level godowns,
parties), so the bars always add up to the Grand Total. A stock item's change is measured from its
opening balance.

## Behaviour decisions

- Quantities are shown with their own unit and only the decimals they need (`qtyText`): `12.5 Kg`,
  `1,25,000 Nos`. Group rows show a quantity only when the core can add it up (same unit, *Add
  quantities* on), otherwise blank.
- Values are stock values, not Dr/Cr balances: negative stock, losses and shortages show in
  parentheses — `(1,234.50)`, never a bare minus (UI kit rule) — in a semibold weight (no
  red/green); `signedAmountText` / `amountColumn`. Exports keep the signed number.
- Export / print use exactly what is on screen: visible tree rows (collapsed groups' items are left
  out), the chosen columns (Detailed / values), landscape for wide tables.
- Every empty state says why it is empty and what to do (change the period, set reorder levels,
  turn on batches, …).
- 2.1 toolbar rows hold at most one filter (`StockFilters`: two or more go behind "Filters ▾", whose
  "Clear filters" link resets the active ones); the
  pickers keep their accessible names (`Stock category`, `Godown`, `Stock item`, `Stock group`) without
  a visible "Label :" column.

## Pure logic (tested: `node --test "src/renderer/modules/stock/**/*.test.ts"`)

`lib/model.ts`: params → period / ids, tree helpers (parent keys, default expansion, visible rows),
quantity / rate / expiry / overdue texts, batch status badges, drill-down targets, movement and
negative-stock trees, and the export tables of every report. `lib/charts.ts`: the graph builders and
stats above (folds, gates, takeaways).
