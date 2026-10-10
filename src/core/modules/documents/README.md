# Documents module (`src/core/modules/documents`)

Tally-parity features around vouchers that are not posting rules themselves:

1. **Quotations and proforma invoices** — non-accounting pre-sale documents with their own numbering,
   validity, status and one-key conversion into a sales order / sales invoice that links back.
2. **Recurring vouchers** — templates made from any saved voucher, a schedule, a due list shown when
   the company opens, review-then-post (idempotent per period), skip / pause.
3. **Sales Bills Pending / Purchase Bills Pending** — delivery / receipt notes (and rejections) not yet
   (fully) invoiced, per party and item, with ageing and "Invoice now".
4. **Order pre-close (short-close)** — close an order's balance with a reason and a date without
   altering the order; reopen.
5. **Reversing Journal "applicable up to" and Scenarios** — provisional vouchers (memorandum, reversing
   journals, optional vouchers) included in the Trial Balance / P&L / Balance Sheet / Group Summary on
   request.
6. **Budgets and Budget Variance** — budgets per group / ledger / cost centre on nett transactions or
   closing balance; variance report; budget column on TB / P&L / BS.

Renderer: `src/renderer/modules/documents` (screens, keys) and `src/renderer/modules/reports/overlay.tsx`
(scenario picker and budget column). User guide: `docs/USER_GUIDE.md` › Documents.

## Files

| File | What |
|---|---|
| `routes.ts` | Route table below. Importing it registers the voucher hook (`hook.ts`). |
| `hook.ts` | Voucher hook (`vouchers/hooks.ts` extension point): validates and stores `validUntil`, `applicableUpto`, `convertedFromId`, `recurring` in the voucher's own save transaction. |
| `common.ts` | Permission helper, voucher references, document status derivation. |
| `quotations.ts` | Register, status, voucher links, conversion / billing drafts (`documents.draft`). |
| `recurring.ts`, `recurringStore.ts`, `schedule.ts` | Templates, schedule arithmetic, due list, post / skip. |
| `billsPending.ts` | Unbilled note lines. |
| `orders.ts`, `closures.ts` | Pre-close / reopen; closures read by `stock/orders.ts` and `vouchers/queries.ts`. |
| `scenarios.ts` | Scenario masters (the report overlay itself is `reports/scenario.ts`). |
| `budgets.ts` | Budget masters, variance report, budget columns. |
| `summary.ts` | Counts for the Gateway notice and dashboard card. |

## Schema (migrations 190–193; versions 190–199 belong to this module)

| Migration | Adds |
|---|---|
| `190_documents` | `vouchers.valid_until`, `vouchers.applicable_upto` (ADD COLUMN); `document_status` (accepted / rejected decision; no row = open); `document_links` (source → target, target UNIQUE, both CASCADE); predefined voucher types *Quotation* and *Proforma Invoice* for existing companies (renamed "… (Bahi)" when the name is taken; skipped on an unseeded database). |
| `191_recurring` | `recurring_templates` (VoucherInput JSON without id / number / date + schedule), `recurring_runs` (UNIQUE `(template_id, period_key)`; status posted / skipped; posted run CASCADEs with its voucher). |
| `192_order_closures` | `order_closures` (order + item, closed qty, date, reason, user; UNIQUE per order + item). |
| `193_budgets` | `scenarios`, `scenario_voucher_types` (include / exclude), `budgets`, `budget_lines` (exactly one of group / ledger / cost centre; basis; signed amount). |

**Why no table rebuild for the new base types:** `voucher_types.base_type` and `vouchers.base_type` have no
CHECK constraint in `001_init`, so `'quotation'` and `'proforma'` were added to `VOUCHER_BASE_TYPES` /
`NON_ACCOUNTING_BASE_TYPES` (extend-only) and need no migration beyond the predefined types.

## Routes

| Route | Access (+ service check) | What |
|---|---|---|
| `documents.quotation.list` | vouchers.view | `{baseType, from, to, status?, partyLedgerId?, search?, limit?}` → rows with derived status, validity, converted-into, value by status, conversion rate |
| `documents.quotation.setStatus` | vouchers.alter | `{id, status: open/accepted/rejected, reason?}` — reason required to reject; audited |
| `documents.links` | vouchers.view | `{voucherId}` → status, converted from / into, applicable up to, recurring run, templates made from it, closures |
| `documents.draft` | vouchers.view | conversion `{sourceId, targetBaseType, voucherTypeId?, date?}` · note billing (same shape) · recurring occurrence `{templateId, periodKey, date?}` → a `VoucherInput` to open in voucher entry (nothing saved) |
| `documents.recurring.list` / `.get` / `.fromVoucher` | vouchers.view | templates; one template with its last 100 runs; suggested template for a saved voucher |
| `documents.recurring.save` | vouchers.create | create from `sourceVoucherId`, or alter; `amount` replaces the single amount; audited |
| `documents.recurring.setActive` | vouchers.create | pause / resume; audited |
| `documents.recurring.delete` | vouchers.delete | template and its run history (posted vouchers stay); audited |
| `documents.recurring.due` | vouchers.view | `{asOf?}` (default today) → occurrences not posted / skipped, oldest first, ≤ 60 per template |
| `documents.recurring.post` | vouchers.create | `{items: [{templateId, periodKey, date?, amount?}], acknowledgeWarnings?}` → per-item outcome; each is an ordinary `saveVoucher` (permissions, period lock, back-date rule, warnings, audit) in its own savepoint |
| `documents.recurring.skip` / `.unskip` | vouchers.create | skip one occurrence (reason in the edit log) / make it due again |
| `documents.billsPending` | reports.view | `{kind: sales/purchase, asOf, partyLedgerId?, itemId?}` |
| `documents.order.preclose` | vouchers.alter (+ vouchers.backdate before today, period lock) | `{orderId, reason, date?, items?: [{itemId, qty?}]}`; audited on the order |
| `documents.order.reopen` | vouchers.alter | `{orderId, itemId?}`; audited |
| `documents.order.closures` | vouchers.view | `{orderId}` |
| `documents.scenario.list` | reports.view | |
| `documents.scenario.get` / `.save` | masters.view (+ masters.create / masters.alter) | audited |
| `documents.scenario.delete` | masters.delete | audited |
| `documents.budget.list` / `.columns` | reports.view | `.columns {budgetId, from, to}` → budget per report row key `g:<id>` / `l:<id>` |
| `documents.budget.get` / `.save` | masters.view (+ masters.create / masters.alter) | audited |
| `documents.budget.delete` | masters.delete | audited |
| `documents.budget.variance` | reports.financial | `{budgetId, from?, to?, scenarioId?}` |
| `documents.summary` | vouchers.view | `{asOf?}` → recurring due (count, value), open / expiring quotations, unbilled challans (only with reports.view) |

The reports routes `reports.trialBalance`, `reports.profitLoss`, `reports.balanceSheet` and
`reports.groupSummary` accept `scenarioId` (reports module, `reports/scenario.ts`).

## 1. Quotations and proforma invoices

- Base types `quotation` and `proforma` (predefined types *Quotation*, *Proforma Invoice*; no hotkey —
  Gateway › Transactions, F10, Go To). Modes: item invoice or accounting invoice. Party required.
- The posting engine prices them like an invoice (GST computed for printing) but writes **no ledger
  entries, no stock movement and no gst_lines**; they are never in GSTR-1 / 3B. Each type has its own
  number series (automatic, yearly), so a quotation never takes a number from the GST invoice series —
  the documented weakness of the old "optional sales" workaround (CGST Rule 46(b): consecutive invoice
  serial numbers).
- `validUntil` (on or after the date) is stored in `vouchers.valid_until`. Duplicating a quotation (Alt+2)
  keeps the validity *length* from the new date (a 15-day offer copied today is valid 15 days from today);
  a reversing journal's "applicable up to" likewise (`vouchers/service.ts › duplicateVoucher`).
- **Status** (derived, `common.ts › documentStatus`), in precedence order: *cancelled* (voucher
  cancelled) → *converted* (a live, not cancelled, target exists) → the user's decision *accepted* /
  *rejected* → *expired* (open and past valid-until) → *open*. Only accepted / rejected are stored.
- **Conversion** (one key: Alt+V invoice, Alt+O sales order): quotation → sales order or sales invoice;
  proforma → sales invoice. `documents.draft` copies party, lines, terms and order details, sets
  "Other references" to the source number and `convertedFromId`; the entry screen opens pre-filled.
  Saving links target → source in the same transaction (hook) and audits "converted" on the source.
  Refused: already converted (one live conversion — cancel or delete the target to convert again),
  cancelled, rejected, a target dated before the source, an accounting-invoice quotation into a sales
  order (orders need stock items). An alter never adds, moves or removes a link, but it is re-checked
  against it: the converted voucher may not be altered to a date before its quotation / proforma, nor
  the quotation to a date after the voucher it was converted into (field error on `date`).
- **Printing**: titles "Quotation" / "Proforma Invoice" (a voucher type's print title may replace the
  title); a proforma always carries **"This is not a tax invoice"**; both print "Valid Until", terms of
  sale, and the proforma prints bank details / UPI QR for an advance (print module, `titles.ts`, `data.ts`).

## 2. Recurring vouchers

- **Template** = the saved voucher minus what is specific to one document (number, date, bill-wise
  references — each posting makes a new reference; tracking / order references; cheque number and date;
  the supplier's invoice number; conversion / recurring links; validity dates). The user is told what was
  not copied. A physical stock count cannot recur; a cancelled voucher cannot be the source; a voucher
  type with manual numbering is refused (postings are numbered automatically).
- **Schedule**: monthly / quarterly / half-yearly / yearly on a day of the month (1–31, or 0 = last
  day; a day past the end of a short month falls on its last day), or every N days (1–366); start and
  optional (inclusive) end. Month-based steps count from the start date's month.
- **Period keys** make posting idempotent: `'YYYY-MM'` for month-based frequencies (changing the day never
  re-opens a posted month), `'YYYY-MM-DD'` for every-N-days. `recurring_runs` is UNIQUE per template +
  key and the hook checks it inside the save transaction, so an occurrence is **never posted twice**
  (also not by two users at once). Deleting the posted voucher makes the occurrence due again (a
  *cancelled* posted voucher keeps its occurrence dealt with — delete it to post the period again).
- **Changing a schedule** (`schedule.ts › scheduleShifts`): a new day of the month, end date or a start on
  the same grid keeps the keys. A change that moves occurrences onto other dates — another frequency or
  interval, an every-N-days start that is not a whole number of intervals away, a quarterly /
  half-yearly / yearly start in another phase — must start **on or after the date the current schedule
  would post next** after the last posted / skipped occurrence; otherwise refused (`startDate` field
  error). Example: quarterly from 5-May with May posted → monthly may start 5-Aug at the earliest (June and
  July are inside the quarter already billed). An alter without `isActive` keeps a paused template paused.
- **Amount override** (README anchor used by the code): when the voucher has exactly one amount — a
  ledger-mode voucher with one Dr and one Cr line, an accounting invoice with one ledger line, or an
  item invoice / stock voucher with one item line — `amount` replaces it (both sides of the pair; the
  ledger line before tax; the item line's value, qty and rate kept) for the template or for one
  occurrence. Anything with several amounts or cost-centre splits: use *Edit & post*.
- **Narration placeholders**: `{period}` / `{month}` → "May 2026" (or the date for every-N-days),
  `{date}` → the posting date, `{fy}` → "2026-27".
- **Due list**: active templates, occurrences up to `asOf` not posted or skipped, oldest first, at most 60
  per template (then `truncated`). The schedule is walked in windows (`undoneOccurrences`), so years of
  dealt-with daily occurrences never hide the next ones (the next-due date likewise). Nothing posts by itself (no background process): the Gateway shows a
  dismissible notice when the company opens and the dashboard has a card.
- **Posting**: each item is a normal `saveVoucher` in its own savepoint — one failing (locked period, a
  warning needing confirmation, a deleted ledger) does not stop the others; the response lists each
  outcome; the screen asks and re-posts those needing confirmation with `acknowledgeWarnings`.

## 3. Bills pending

Sales: delivery notes billed by sales invoices, rejections-in by credit notes. Purchase: receipt notes
by purchase invoices, rejections-out by debit notes. Billing is matched per party + note number
(`tracking_ref`) + item, applied to the note's lines in line order (the `vouchers.trackingRefs` rule),
counting invoices dated on or before `asOf`. Optional and cancelled documents never count.
`totals.olderThan7Days` counts delivery / receipt notes (challans) with a line unbilled for more than 7
days — not rejections, which await a credit / debit note rather than an invoice. Value =
pending qty × the note's rate less discount (a stock-only challan has value 0). `ageDays` = asOf − note
date. "Invoice now" = `documents.draft {sourceId: note, targetBaseType}` with the pending quantities and
`trackingRef` = the note number (no second stock movement). Legal context shown to the user: for a
taxable supply of goods the invoice is due before or at removal (CGST Act s.31(1)); a delivery challan
covers job work, goods on approval, transport other than for supply and quantity-unknown removals
(CGST Rule 55).

## 4. Order pre-close

A closure is per order + item: `closed_qty` (≤ the pending balance as of the closure date), date, reason,
user. The order is never altered. Pending Orders, Reorder Status and the "From orders" picker subtract
closures dated on or before their as-of date, from the order's last lines backwards. Reopen deletes the
closure. Both are audited on the order, need `vouchers.alter`, `vouchers.backdate` for a date before
today, and respect the period lock. Optional and cancelled orders cannot be pre-closed.

## 5. Reversing journals and scenarios

- `applicableUpto` (on or after the journal date) is stored in `vouchers.applicable_upto`. A reversing
  journal never posts to the books (`affects_books = 0`, as before).
- A scenario = include actuals (yes / no) + voucher types whose **provisional** vouchers are added +
  voucher types whose regular vouchers are left out (only with actuals). Provisional = memorandum
  vouchers; reversing journals while the report date `to` ≤ applicable up to (none = no limit);
  optional vouchers. Cancelled vouchers never count; post-dated ones follow the books filter. Types that
  post no ledger entries (orders, notes, stock journals, quotations) are refused.
- The overlay adds per-ledger deltas to the balance engine (`reports/scenario.ts`), so every total,
  the Balance Sheet balancing and drill-downs into Group Summary stay consistent. Stock values are not
  affected. Ledger Vouchers, outstanding, GST returns and the Day Book always show the books.

## 6. Budgets

- A budget has a period and lines; each line targets one group, ledger or cost centre, **on nett
  transactions** (what should move in the period) or **on closing balance** (where the balance should
  stand), amount signed Dr + / Cr − (an expense budget Dr, a sales budget Cr). One line per master.
- **Report period ≠ budget period**: nett-transaction budgets are pro-rated by days of overlap (rounded
  to the paisa); closing-balance budgets are shown as they are. This pro-rating is our documented choice
  (Tally shows budgets for their own period) so a monthly review of an annual budget works.
- **Actuals**: nominal ledgers as in the P&L (period movement; + opening when the period contains the
  books beginning); other ledgers Dr − Cr of the period; closing = the Trial-Balance closing at `to`;
  groups = the sum over their ledgers (Profit & Loss A/c excluded; closing stock is not a ledger balance);
  cost centres (with sub-centres) = cost allocations. With `scenarioId` both the ledger and the
  cost-centre figures follow the scenario (`reports/scenario.ts › scenarioCostCentreAdjust`: excluded
  types out, provisional vouchers of included types in, books dropped when actuals are not included).
  Memorandum vouchers and reversing journals keep their cost-centre split (stored with
  `affects_books = 0`, so no books report counts it) for this.
- **Variance** = actual − budget (Dr + / Cr −); variance % = variance ÷ |budget| × 100 (2 decimals; null for
  a zero budget); "over budget" = actual beyond the budget on the budget's own side.
- **Totals** of the variance report count each amount once: a ledger or group under a budgeted group,
  a cost centre under a budgeted centre, and cost-centre lines when the budget also has group / ledger
  lines (they split the same ledger amounts) are shown with `inTotal: false` and left out of `totals`.
- **Budget columns** for TB / P&L / BS: per row key, with `basisByKey`; a group without its own line shows
  the sum of the budgets below it (basis `mixed` when they differ); cost-centre lines have no row there.
  The Trial Balance variance compares like with like: nett-transactions budget vs Debit − Credit of the
  period, closing-balance budget vs the closing balance; none for a `mixed` group.

## Tests

`quotations.test.ts`, `recurring.test.ts`, `schedule.test.ts`, `billsPending.test.ts`, `budgets.test.ts`
(scenarios included), `review.test.ts` (regressions from the review: schedule changes, long catch-up,
paused alter, pre-close duplicates, challan count, duplicate validity, budget totals / basis) against a
real in-memory company, and `e2e.test.ts` through `runtime.dispatch`
(quotation → invoice, recurring post twice → once, bills pending → invoice, pre-close / reopen, reversing
journal under a scenario, pro-rated budget variance, edit log); `gaps.test.ts` (final wave: conversion
dates re-checked on alteration; cost-centre actuals under a scenario).

## Known gaps

- Recurring vouchers post only when someone reviews the due list (no unattended auto-posting: the app has
  no background process, and posting without review would bypass warnings).
- A quotation in a foreign currency, revision history of a quotation (Tally keeps none either) and an
  e-mail of the quotation are not built here (print / share belong to the print module).
- Budgets are not imported from Tally XML (BUDGET objects are still skipped by the importer).
- Ledger Vouchers, outstanding, GST reports and the Day Book always show the books (no scenario); the
  scenario and budget chosen on a report are not remembered after the screen closes.
