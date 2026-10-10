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

Tests: `node --test "src/renderer/modules/documents/**/*.test.ts"`.
