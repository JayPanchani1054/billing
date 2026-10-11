# Documents module UI (`src/renderer/modules/documents`)

Screens for quotations / proforma invoices, recurring vouchers, bills pending, order pre-close,
scenarios and budgets. Core rules and routes: `src/core/modules/documents/README.md`.

## Screens, keys and where they are reached

| Screen id | Params | Reached from | Keys |
|---|---|---|---|
| `documents.quotations` | `{baseType?, status?}` | Gateway › Reports › Quotation Register; Go To; dashboard card | Enter View · Ctrl+1 Quotations · Ctrl+2 Proforma · Ctrl+3…8 status filter · Alt+C Create · Alt+V Convert to Sales Invoice · Alt+O Convert to Sales Order · Alt+S Accept / reject · Alt+E / Alt+P |
| `documents.quotation.status` | `{id}` (dialog) | Alt+S on the register / voucher view | Ctrl+A Save · Esc |
| `documents.recurring` | — | Gateway › Masters › Recurring Vouchers; Go To | Enter Alter · Alt+C Create · Alt+S Pause / resume · Alt+R Due vouchers · Alt+D Delete · Alt+E |
| `documents.recurring.form` | `{id?}` · `{sourceVoucherId?}` | Enter on a template; **Alt+R in voucher view** (make recurring); Alt+C on the list (pick the voucher) | Enter Next field · Ctrl+A Save · Alt+U Undo skip · Alt+H Edit history · Alt+D Delete |
| `documents.recurring.due` | — | Gateway › Transactions › Due Recurring Vouchers; Gateway notice on company open; dashboard card; Go To | Space / Alt+T Tick · Ctrl+A Post ticked · Enter Edit & post (voucher entry pre-filled) · Alt+O Change amount · Alt+S Skip · Alt+R Templates · Alt+E |
| `documents.billsPending` | `{kind?, partyLedgerId?}` | Gateway › Inventory Reports › Sales / Purchase Bills Pending; dashboard card; Go To | Enter Open note / show lines · Ctrl+1 Sales · Ctrl+2 Purchase · Ctrl+3 Lines · Ctrl+4 By party · Ctrl+5 By item · Alt+I Invoice now / Enter bill · Alt+F2 Date · Alt+E / Alt+P |
| `documents.order.preclose` | `{orderId, kind?, itemId?}` (dialog) | **Alt+L** on Pending Orders (stock) and in the order's voucher view | Enter Next field · Ctrl+A Pre-close · Esc |
| `documents.scenarios` | — | Gateway › Masters › Scenarios; Go To | Enter Alter · Alt+C Create · Alt+D Delete |
| `documents.budgets` | — | Gateway › Masters › Budgets; Go To | Enter Alter · Alt+C Create · Alt+V Variance · Alt+D Delete |
| `documents.budget.form` | `{id?}` | Enter on a budget; Alt+M on the variance report | Enter Next field · Ctrl+D Remove line · Ctrl+A Save · Alt+H Edit history · Alt+D Delete |
| `documents.budget.variance` | `{budgetId?}` | Gateway › Reports › Budget Variance; Alt+V on budgets; Go To | Enter Drill down (a group opens Group Summary under the same scenario) · Ctrl+1 Budget period · Ctrl+2 Report period · Alt+B Budget · Alt+S Scenario · Alt+M Alter budget · Alt+E / Alt+P. Total = each amount once (`inTotal`) |

Quotation / Proforma Invoice **entry** is `vouchers.entry` (Gateway › Transactions, F10, Go To) with
two extra header fields handled by the vouchers module: *Valid until* (quotation / proforma) and
*Applicable up to* (reversing journal). Conversions and recurring "Edit & post" open `vouchers.entry`
with `{draft: {...}}`; the entry screen fetches `documents.draft`, shows a "Converts a quotation" /
"Recurring voucher · 2026-05" badge, and returns to the list after saving.

## 2.1 calm and graphs (SPEC-21, WP-L1)

- **Bills Pending**: graph *Unbilled challans by age* / *Bills awaited by age* (`lib/charts.ts ›
  billsPendingChart`; ordinal columns, 0–7 days grey) over the rows the table shows; the view tabs (Note
  lines · By party · By item) are the toolbar row; Sales / Purchase is Ctrl+1 / Ctrl+2 (More) and the title;
  a party / item filter is the context run (Ctrl+3 clears it); the CGST s.31 / Rule 55 note is More › About
  this report and the banner is one line; ages are plain "12 days".
- **Budget Variance**: graph *Over and under budget* (`budgetVarianceChart`, polarity bars: under budget
  slot 1, over slot 2), drawn inline under the Variance cells when the table is exactly its ≤ 7 lines;
  lines inside another line or without a budget stay in the table only. The variance rules are in About.
- **Quotation Register**: no graph (two numbers): stat *Open ₹x · Conversion y %* (`quotationsStat`; the
  open value is dropped when it is the visible total row); status filter *All statuses ▾* (Ctrl+3…8 are
  ticked More items) — the total row adds up the documents the filter lists (`quotationsShown`), the
  whole register under *All statuses*; statuses as plain words.
- **Due Recurring Vouchers**: stat *To post ₹x* (`recurringDueStat`, the ticked amount); the footer counts
  the ticked lines only; a changed amount is marked \* with a tooltip.
- Lists (Recurring Vouchers, Scenarios, Budgets) show a count in the context run and *Create …* as the
  secondary button; forms lose the icon tiles, legends and teaching sentences (hints on focus; the
  scenario rules are the dialog's description). Home notice: one line, link-style *Review & post*;
  dashboard card without badges (the unbilled challan value is its own row; the CGST s.31 rule its tooltip).

## Extension points used (app/registry.ts)

- `gatewayNotices: [RecurringDueNotice]` — "N recurring vouchers are due" banner on the Gateway when the
  company opens; dismissed for the rest of the working day (per company, `localStorage`, falls back to
  showing again when storage is unavailable).
- `dashboardCards: [DocumentsCard]` — recurring due, open / expiring quotations, unbilled challans > 7 days.
- `voucherPanels: [VoucherDocumentsPanel]` — on `vouchers.view`: status, validity, converted from / into,
  recurring link, pre-closed balances (Reopen); rail keys Alt+V / Alt+O convert, Alt+S status,
  Alt+R make recurring, Alt+L pre-close order.

The **scenario picker (Alt+S) and budget column (Alt+B)** of the Trial Balance, P&L and Balance Sheet
are in the reports module (`reports/overlay.tsx`, `reports/lib/overlay.ts`), since renderer modules do
not import each other's screens; they call this module's routes. The Trial Balance variance uses the
budget's basis per row (`basisByKey`): nett budgets against Debit − Credit, closing-balance budgets
against the closing balance, none for a group mixing both.

## Files

| File | What |
|---|---|
| `index.ts` | ModuleDef: screens, menu, extension points |
| `QuotationsScreen.tsx` | Register + status dialog |
| `RecurringScreens.tsx` | Templates, template form, due list (+ amount / skip dialogs) |
| `PendingScreens.tsx` | Bills pending, pre-close dialog |
| `PlanningScreens.tsx` | Scenarios, budgets, budget form, variance |
| `components.tsx` | Gateway notice, dashboard card, voucher panel |
| `lib/model.ts` (+ `model.test.ts`) | Pure helpers: labels, schedule text and checks, post selection, bills grouping and ageing, pre-close quantities, scenario checks, budget lines, variance drill / status, exports |
| `lib/keys21.test.ts` | Every screen file still registers each key it had in 2.0 (2.1 moved actions, never hid them) |
| `lib/charts.ts` (+ `charts.test.ts`) | Graphs and stats (2.1): bills pending by age (graph total = the Pending value total), budget variance bars (each bar = its line's \|variance\|, signed from the budget's side; Σ of the bars = the table's variance total when every line is on one side), quotation and due-recurring stats |

Tests: `node --test "src/renderer/modules/documents/**/*.test.ts"`.
