# tds — TDS / TCS screens (renderer)

Core: `src/core/modules/tds` (computation, posting, reports, legal assumptions — read its README).
Everything here is hidden unless F11 › TDS or TCS is on (`anyFeature: ['tds', 'tcs']`); TDS
Receivable needs TDS. Gateway section **TDS / TCS**; every screen is in Go To (Alt+G).

## Screens

| Id | Params | Keys |
|---|---|---|
| `tds.setup` | — | Ctrl+A save · Alt+R create the TDS Receivable ledger |
| `tds.natures` | `{ kind? }` | Enter / Alt+A alter · Alt+C create · Alt+D delete (not system natures) · Ctrl+1 TDS · Ctrl+2 TCS |
| `tds.nature.form` | `{ id?, kind? }` | Enter next field · Alt+R add a dated rate row · Ctrl+A save |
| `tds.ledgers` | `{ role? }` | Enter / Alt+A alter details · Alt+M ledger master · Ctrl+1 parties · Ctrl+2 expenses · Ctrl+3 sales · Ctrl+F search · More › Only ledgers with TDS/TCS details (checkable, keyless) |
| `tds.ledger.form` | `{ ledgerId }` | Enter next field · Ctrl+A save · Alt+M ledger master |
| `tds.computation` | `{ kind? }` | Enter lines · Alt+M party details · Alt+F2 period · Alt+E / Alt+P |
| `tds.lines` | `{ kind?, partyLedgerId?, natureId?, section?, period?, from?, to?, title? }` | Enter / Alt+Enter view voucher · Alt+A alter voucher |
| `tds.outstanding` | `{ kind? }` | Enter lines · Alt+C challan for the highlighted month · Alt+F1 settled months too (checkable) · statements table: Enter opens the return |
| `tds.challans` | `{ kind? }` | Enter alter challan · Alt+C create · Alt+Enter view voucher |
| `tds.challan` | `{ kind?, section?, period?, voucherId? }` | Enter next field · Alt+S fill the suggested tax + interest · Ctrl+A save |
| `tds.return` | `{ form?, fyStart?, quarter? }` | Ctrl+1 deductees · Ctrl+2 challans · Alt+S save the CSV files · Alt+R record filing · Enter voucher |
| `tds.receivable` | `{ fyStart? }` | Alt+I import 26AS CSV · Enter customer ledger · Alt+M customer details · Alt+R create the ledger |
| `tds.exceptions` | `{ kind? }` | Enter view voucher · Alt+A alter voucher · Alt+M party details |

Reports use `ReportScreen` (sticky headers, totals, Alt+E Excel/CSV/PDF and Alt+P print through the
shared export path that checks `data.export` and writes the edit log). The statement CSVs are built by
the core (`tds.return.export`, `tds.file` permission, audited) and saved with the native save dialog.

## 2.1 calm: graphs, stats and the template

One graph per report (SPEC-21 §5), built by the pure `lib/charts.ts` and passed as
`graph={reportGraph(spec)}` (`ui/lazyChart.tsx`, so the graph kit loads lazily); Ctrl+J folds them.
Every builder's drawn total equals the table's (tested in `lib/charts.test.ts`):

| Screen | Graph | = table | Stat (toolbar row) |
|---|---|---|---|
| `tds.computation` | bars "Not yet deposited, by section" — inside the Balance cells when every section is one row (≤ 7), else Top 6 + Other | Balance total | — |
| `tds.outstanding` | columns "Left to deposit, by month" — months with an overdue balance orange, the rest grey; Enter on a column = that month's lines | Balance total | "Interest to pay ₹y" — only once some interest was paid (until then the Interest total says it) |
| `tds.challans` | columns "Deposited, by month" over the period — months with a late challan orange | Total column | — |
| `tds.receivable` | bars of the difference from 26AS per customer (inside the Difference cells on a short table); none when all match | Σ \|Difference\| | "Books agree with 26AS ✓" when every row matches |
| `tds.return` | meter "Deposited ₹A of tax ₹B" (both > 0) | Tax total | "Not covered ₹x" / "No challan yet" |
| `tds.exceptions` | none (a to-do list) | — | "Shortfall ₹x · Interest ₹y" — the one total (the table has no total row) |
| `tds.lines`, masters, forms | none | — | — |

The KPI tiles of 2.0 are gone: their figures are the table totals or the stat. Explanations and legal
lines (due dates, interest and late-fee rules, the 26AS CSV columns, the FVU note, the seeded rates)
moved to More › "About this report" (natures: "About these rates"); Create challan and Import 26AS CSV
are secondary buttons — the only filled one on a report is the Quarterly Return's commit, *Save CSV
files* (Alt+S, like a GST return's Export JSON); forms have one Save in the title row (the challan's
footer Save / Back went — Esc goes back, the total sits under the amounts). Status cells are words;
a badge only marks what needs doing (overdue, due, late, mismatch).

## Extension points used

- **Voucher entry** (`EntryPanel.tsx`, rendered by `vouchers/entry/VoucherEntryScreen.tsx` in the side
  column): the TDS / TCS the last server check computed, per section with its note. 2.1 (D16): the
  panel renders nothing while no line is computed (and the voucher is no challan), so the grid keeps
  the full width; Alt+U is registered above that return and always works (the gate is
  `entryPanelShown` in `lib/model.ts`; `lib/entryPanel.test.ts` pins it and the hook order). **Alt+U** opens a
  dialog to change an amount (a reason is required when it differs from the computed one) or choose
  the nature to deduct under (advance payment / journal without TDS-applicable ledgers). The choice
  travels in `VoucherForm.tds` → `VoucherInput.tds`.
- **Voucher view** (`VoucherPanel.tsx`, `ModuleDef.voucherPanels`): the voucher's TDS lines with what
  has been deposited, or the challan with what it cleared; Alt+U alters the challan / opens the lines.
- **Gateway notice** (`notices.tsx`): deposits overdue or due within a week, or a statement past its
  due date, as on the working date (dismissed for the day).
- **Ledger master** (accounts `LedgerFormScreen.tsx`, Other settings): an "Open TDS / TCS details"
  button for a saved ledger.

## Files

`index.ts` (ModuleDef), `components.tsx` (turned-off screen, TDS/TCS switch, CSV save/open),
`NatureScreens.tsx`, `LedgerScreens.tsx`, `SetupScreen.tsx`, `ReportScreens.tsx`, `ChallanScreen.tsx`,
`ReturnScreen.tsx`, `ReceivableScreen.tsx`, `EntryPanel.tsx`, `VoucherPanel.tsx`, `notices.tsx`,
`lib/model.ts` (pure: labels, form checks, export tables, override editing, notice text — tested in
`lib/model.test.ts`), `lib/charts.ts` (pure: the graphs and stats — tested in `lib/charts.test.ts`).
No stylesheet.
