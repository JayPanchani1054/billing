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
