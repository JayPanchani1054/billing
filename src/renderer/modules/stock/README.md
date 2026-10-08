# Stock reports UI (`src/renderer/modules/stock`)

Inventory reports in the Gateway section **Inventory Reports**. Every screen needs the company's
**Inventory** feature (F11); Godown Summary also needs *Multiple godowns*, Batch Summary *Batches*
and Pending Orders *Order processing*. Access: `reports.view` (Item Profitability:
`reports.financial`, like the P&L). Core API and rules:
`src/core/modules/stock/README.md`; DTOs: `src/shared/types/stock.ts`.

## Screens

| id | params | what | keys (besides Alt+F2 period/date, Alt+E export, Alt+P print, Esc back) |
|---|---|---|---|
| `stock.summary` | `{ from?, to?, groupId?, categoryId?, godownId? }` | Stock Summary: groups → items, closing qty / rate / value; Detailed adds opening, inward, outward. Godown and category filters in the toolbar | Enter group → its summary, item → `stock.item` · Alt+F1 Detailed · Alt+V Quantities only · Alt+Z All items · Alt+X Expand/collapse all |
| `stock.categories` | `{ from?, to? }` | Same by stock category ("Not categorised" bucket) | Enter category → `stock.summary { categoryId }` |
| `stock.item` | `{ itemId, from?, to?, godownId? }` | Stock Item Vouchers: opening, each voucher's inward / outward qty and value at cost, running closing; footer opening / totals / closing. Item and godown pickers in the toolbar | Enter → `vouchers.view { id }` · Alt+M item master |
| `stock.godowns` | `{ godownId? }` | Godown Summary as on the period end | Enter item → its vouchers in that godown, godown → Stock Summary of the godown · Alt+Z empty godowns · Alt+X |
| `stock.movement` | `{ itemId?, groupId?, from?, to? }` | Movement Analysis: parties (→ items) with qty, avg rate, value; banner for party-less quantities | Alt+I Inward · Alt+O Outward · Enter party → `reports.ledger`, item → `stock.item` · Alt+X |
| `stock.ageing` | `{ groupId? }` | Stock Ageing as on: bucket presets (30/60/90/180, 15/30/45/60, 90/180/365) | Alt+Q values ↔ quantities · Enter → item |
| `stock.reorder` | — | Reorder Status: in stock, level, on order, promised, net, shortfall, order now | Alt+O new Purchase Order · Enter → item |
| `stock.negative` | — | Negative Stock: item → godowns below zero, since when; guidance banner | Enter → item (in that godown) · Alt+X |
| `stock.batches` | `{ itemId? }` | Batch Summary: batches with mfg / expiry, days left, status badge; expired-stock banner | Alt+W expiry filter (all → 30 → 90 days) · Enter → item |
| `stock.pendingOrders` | `{ kind?: 'sales' \| 'purchase' }` | Pending orders as on: ordered / delivered (received) / pending, value, due date, overdue badge | Alt+S Sales · Alt+U Purchase · Alt+C new order · Enter → `vouchers.view` (the order) |
| `stock.profitability` | `{ groupId?, from?, to? }` | Item Profitability: net qty, sales, returns, net sales, COGS, GP, GP % | Enter → item |
| `stock.physicalVariance` | `{ from?, to? }` | Physical Stock Register: counted vs books, difference, gain / loss at cost | Alt+C new count · Enter → voucher |

Drill-downs keep the period: a report opened with `{ from, to }` shows that range until the user
changes the global period (Alt+F2). Items opened from an as-on report show the financial year up
to the as-on date. Go To: the inventory module's `items` provider opens `stock.item` (it checks this
screen is registered), so no provider is registered here.

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

## Pure logic (tested: `node --test "src/renderer/modules/stock/**/*.test.ts"`)

`lib/model.ts`: params → period / ids, tree helpers (parent keys, default expansion, visible rows),
quantity / rate / expiry / overdue texts, batch status badges, drill-down targets, movement and
negative-stock trees, and the export tables of every report.
