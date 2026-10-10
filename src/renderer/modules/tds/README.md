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
| `tds.ledgers` | `{ role? }` | Enter / Alt+A alter details · Alt+M ledger master · Ctrl+1 parties · Ctrl+2 expenses · Ctrl+3 sales · Ctrl+F search |
| `tds.ledger.form` | `{ ledgerId }` | Enter next field · Ctrl+A save · Alt+M ledger master |
| `tds.computation` | `{ kind? }` | Enter lines · Alt+M party details · Alt+F2 period · Alt+E / Alt+P |
| `tds.lines` | `{ kind?, partyLedgerId?, natureId?, section?, period?, from?, to?, title? }` | Enter / Alt+Enter view voucher · Alt+A alter voucher |
| `tds.outstanding` | `{ kind? }` | Enter lines · Alt+C challan for the highlighted month · Alt+F1 include settled · statements table: Enter opens the return |
| `tds.challans` | `{ kind? }` | Enter alter challan · Alt+C create · Alt+Enter view voucher |
| `tds.challan` | `{ kind?, section?, period?, voucherId? }` | Enter next field · Alt+S fill the suggested tax + interest · Ctrl+A save |
| `tds.return` | `{ form?, fyStart?, quarter? }` | Ctrl+1 deductees · Ctrl+2 challans · Alt+S save the CSV files · Alt+R record filing · Enter voucher |
| `tds.receivable` | `{ fyStart? }` | Alt+I import 26AS CSV · Enter customer ledger · Alt+M customer details · Alt+R create the ledger |
| `tds.exceptions` | `{ kind? }` | Enter view voucher · Alt+A alter voucher · Alt+M party details |

Reports use `ReportScreen` (sticky headers, totals, Alt+E Excel/CSV/PDF and Alt+P print through the
shared export path that checks `data.export` and writes the edit log). The statement CSVs are built by
the core (`tds.return.export`, `tds.file` permission, audited) and saved with the native save dialog.

## Extension points used

- **Voucher entry** (`EntryPanel.tsx`, rendered by `vouchers/entry/VoucherEntryScreen.tsx` in the side
  column): the TDS / TCS the last server check computed, per section with its note; **Alt+U** opens a
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
`lib/model.test.ts`).
