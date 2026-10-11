# Forex renderer module (`forex`)

Screens and UI pieces of multi-currency (core: `src/core/modules/forex`, README there). Everything is
behind F11 › Multiple currencies (`feature: 'multiCurrency'`): menus and Go To hide it while off, and a
screen opened anyway shows how to turn it on (`ForexOff`).

| Screen id | Title | Menu / Go To | Keys |
|---|---|---|---|
| `forex.settings` | Multi-currency Settings | Masters | Enter next · Ctrl+A save · Alt+R rates of exchange |
| `forex.outstanding` {kind?, ledgerId?} | Forex Outstanding | Reports | Enter ledger / bill voucher · Ctrl+1/2/3 all / receivables / payables · Alt+L ledger in both currencies · Alt+O opening in currency · Alt+V revaluation · Alt+E / Alt+P |
| `forex.ledger` {ledgerId?, from?, to?} | Ledger in Foreign Currency | Reports | Alt+L change ledger · Enter voucher · Alt+A alter · Alt+R rupee ledger · Alt+O opening · Alt+M master · Alt+V revaluation · Alt+F2 · Alt+E / Alt+P |
| `forex.revaluation` {asOf?} | Forex Revaluation | Reports | Ctrl+A post journal (dialog: date, narration, preview) · Alt+R type closing rates · Alt+T rate type · Enter / Alt+L ledger · Alt+F2 · Alt+E / Alt+P |
| `forex.opening` {ledgerId?} | Opening Balance in Currency | Masters (asks for the ledger) · Alt+O from the above | Enter next · Alt+R fill at a rate · Ctrl+A save · Alt+M master |

Graphs (2.1, SPEC-21 §5; pure builders in `lib/charts.ts`, tested in `lib/charts.test.ts`, drawn
through `reportGraph` of `ui/lazyChart.tsx`; Ctrl+J folds them):

* `forex.outstanding` — Receivables (Ctrl+2) or Payables (Ctrl+3): columns of the bills by age (Not
  due grey, then 1–30 … over 90 days on the indigo ramp), in rupees at the closing rate (as carried
  without a rate); Σ = the side's unpaid bill rows — an advance or on-account amount (a bill on the
  other side) is not drawn. "All" (Ctrl+1) has no graph. The stat says, per currency, the net in the
  currency and, in brackets, the unrealised gain / loss in exact rupees ("USD $ 2,000.00 Dr (₹4,000
  gain)"; ≤ 3 figures; more currencies → a count); it replaces the 2.0 tiles.
* `forex.revaluation` — bars of the unrealised adjustment per party (gain indigo, loss orange), inside
  the Adjustment cells when every party is one line (≤ 7); Σ = the net. The takeaway counts parties
  ("Gain on 5 parties, loss on 2; largest loss …"), never the folded "Other" bar.
* `forex.ledger` — a line of the balance in the currency (opening, then the end of each day; ≥ 3
  voucher rows; ≤ 480 points), ending on the closing balance. Detail class: folded by default.
* None for settings and openings. Explanations moved to More › "About this report"; the voucher-entry
  side panel renders nothing until there is an invoice currency or a foreign line the server check
  priced (`entryPanelShown` in `lib/entry.ts`, pinned by `lib/entryPanel.test.ts`).

Elsewhere:

* **Voucher entry** (vouchers module renders them): `ForexDialogs.tsx` — `ForexInvoiceDialog` (Alt+Y on
  an invoice: currency of the party and rate, Alt+R master rate), `ForexLineDialog` (opens on leaving
  a line of a foreign ledger, Alt+Y later: amount in the currency, rate, rupees, bill-wise split in the
  currency with the realised difference per bill), `ForexPartyBillsDialog` (Alt+B on a foreign-currency
  invoice); `EntryPanel.tsx` side panel; `lib/entry.ts` form ⇄ input conventions (invoice amount fields
  hold foreign × 100).
* **Voucher view**: `VoucherPanel.tsx` (ModuleDef.voucherPanels) — currency, rate, foreign entries,
  realised gain / loss; Alt+Y opens the ledger in both currencies.
* **Print**: `PrintBlock.tsx` (+ pure `lib/print.ts`) rendered by the Modern, Classic and Voucher templates.
* **Links**: Ledger Vouchers (reports) Alt+R and Party Outstanding Alt+Y open the forex views of a ledger
  kept in a foreign currency (`hooks.ts › useForexContext`).

Pure logic with tests: `lib/model.ts` (labels, report rows, exports, revaluation inputs, opening checks),
`lib/entry.ts`, `lib/print.ts`. Styles: `forex.css` (tokens only, prefix `bx-fx-`).
