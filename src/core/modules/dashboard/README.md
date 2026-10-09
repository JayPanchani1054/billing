# dashboard — the business at a glance

One read-only route, `dashboard.summary`, returns everything the Gateway dashboard shows. The screen
`dashboard.home` (`src/renderer/modules/dashboard`) renders it inline in the Gateway (`{ embedded: true }`,
compact) or as a full page.

DTOs: `src/shared/types/dashboard.ts` · Route: `routes.ts` · Service: `summary.ts` · Test books:
`testkit.ts` · No migration (130 stays empty: every query runs on an existing covering index).

## Route

| Route | Access | Input | Output |
|---|---|---|---|
| `dashboard.summary` | `reports.view`, `transactional: false` | `DashboardSummaryInput { asOf, from, to }` (dates; `from ≤ to`, else VALIDATION on `to`) | `DashboardSummary` |

Parts that need more than `reports.view` come back `null` instead of failing: `grossProfit` needs
**reports.financial**; `gst` and the e-invoice / e-way bill counts need **gst.view**.

## Figures and rules

Money is integer paise. All queries apply the books filter (`BOOKS_FILTER`, working date =
`ctx.clock.today()`): optional, cancelled, memorandum and order vouchers never count; post-dated vouchers
count once their date is reached.

| Figure | Rule |
|---|---|
| Ranges | `today` = asOf; `mtd` = 1st of asOf's month → asOf; `ytd` = start of asOf's financial year (the books beginning in the first year) → asOf; `period` = from → to. `lastYear.*` = the same ranges a year earlier (`comparePeriod(…, 'previous_year')`: a month end stays a month end, 29-Feb → 28-Feb). |
| Sales / purchases | Net movement of ledgers under **Sales Accounts** (credits − debits, so credit notes reduce it) / **Purchase Accounts** (debits − credits), i.e. the P&L's sales and purchases, before GST. Nominal opening balances (books begun mid-year) count in every range that contains the books beginning, as `nominalMovement` does — so `period` always equals the P&L (tested for three periods and for a mid-year start). ONE aggregate over `ledger_entries` (`idx_le_books`) for all eight ranges. |
| Gross profit | `sales + direct incomes − (opening stock + purchases + direct expenses − closing stock)` for the period — exactly the P&L's gross profit (tested against `reports.profitLoss`). With integrated inventory (F11 inventory + integrate) the stock values come from ONE `computeStockValuation(from, to)` replay (`method: 'stock_valuation'`); otherwise stock is 0 (`method: 'purchases'`: sales − purchases). Nominal opening balances are included when the period contains the books beginning (as `nominalMovement` does). `marginPercent` = GP ÷ sales × 100, 2 decimals, null when sales are 0. |
| Receivables / payables | The outstanding engine (`outstanding/reports.ts sideParties`, **FIFO for ledgers not maintained bill-wise**, like the Receivables / Payables screens' default): `total` = Σ party balances on the side; due-date ageing with the default buckets (Not due · 1–30 · 31–60 · 61–90 · 91–180 · > 180); `overdue` / `notDue` from the bills; advances and on-account amounts separately (not aged); `dueSoon` = bills with pending > 0 due from asOf to asOf + 7 days (due today included). Tested equal to `outstanding.ageing` and `outstanding.dueSoon`. |
| Cash & bank | `closingBalances` as at asOf for ledgers under Cash-in-Hand / Bank Accounts / Bank OD (signed Dr + / Cr −; banks: normal accounts first, then OD; `accountTail` = last 4 digits of the account number). |
| GST due | `gstDue`: the **previous** month's return (same figures) while asOf is on or before its due date — on 8-Oct, September's GSTR-3B due 20-Oct, the payment to make next. Null after the due date, before the books begin, and wherever `gst` is null. |
| GST | GST on and **regular** registration only (composition / unregistered → null). `computeGstr3b` for the calendar month of asOf (the GSTR-3B screen's figures incl. its manual entries): `outputTax` = 3.1(a) + 3.1(b), `reverseChargeTax` = 3.1(d), `inputTax` = net ITC 4(C), `netPayable` = cash after the s.49 / Rule 88A set-off — against the month's ITC **plus the credit brought forward from the previous month** (electronic credit ledger, chained from the books beginning) — + reverse charge (before interest / late fee), `creditCarriedForward`. `dueDate`: monthly filers GSTR-3B on the 20th of the next month; quarterly (QRMP) filers PMT-06 on the 25th for the first two months of a quarter and GSTR-3B on the 22nd (category-1 states, `QRMP_22ND_STATES`: Chhattisgarh, MP, Gujarat, Daman & Diu, DNH&DD, Maharashtra, Karnataka, Goa, Lakshadweep, Kerala, TN, Puducherry, A&N, Telangana, AP) / 24th (everyone else, incl. Ladakh 38) after the quarter end. |
| Top customers | Period net sales (Sales Accounts entries) per voucher party, cash / bank "parties" (cash sales) excluded; top 5; `invoiceCount` = sales vouchers; `sharePercent` of period sales. |
| Top items | Period sales − sales returns (credit notes with items) + debit notes to customers (upward price revisions: value only, no quantity) per item: taxable value and quantity (`billed_qty`, else the stock quantity); top 5. Empty when inventory is off. |
| Trend | 12 calendar months ending with the month of `to`: sales and purchases per month (Σ Apr–Oct of the testkit = the YTD flows). |
| Low stock | Active goods items with `reorder_level > 0` whose quantity on hand at asOf (`stockByItem`) is below it; least cover (on hand ÷ reorder level) first; at most 10 listed, `count` = all. |
| Compliance | Counts from the start of asOf's financial year to asOf, always equal to the lists of `gst.einvoice.pending` / `gst.ewaybill.pending` (tested). **e-invoice** (feature on): outward documents (sales / credit / debit notes) in the books with an e-invoice nature (B2B, SEZ, export, deemed export), no IRN, `irn_status` NULL / '' / pending. Vouchers with a stored e-invoice nature are counted in SQL; the few whose nature `gst/docs.ts` would derive (none stored, an unknown value, a sale stored with an inward nature) go through `loadDocs` + `einvoiceSupplyType`. **e-way bill** (feature on): sales and credit notes (outward unless a credit note stores an inward nature) without an EWB number whose goods consignment (taxable + tax of lines not 'services' and not exempt / nil / non-GST — `consignmentValue`) exceeds `config.gst.ewayThresholdPaise` (₹50,000). |
| Recent vouchers | The last 8 vouchers entered (highest id), any status, flagged cancelled / optional / post-dated; a cancelled voucher shows amount 0. |
| Post-dated | Vouchers marked post-dated, dated after the working date, not cancelled / optional, whose net cash/bank movement is non-zero: `direction` in (receipt) / out (payment), `inflow` / `outflow` totals, the main bank ledger and cheque number; earliest first (10 listed, `count` = all). |
| Backup | `data/backup.ts lastBackupAt` (backup history, else the edit log) and whole days since then on the clock. |

## Performance

Measured in the dev container (`perf.test.ts`): 50,000 vouchers (25,000 sales, 10,000 purchases, 10,000
receipts, 5,000 payments; 1,000 customers, 200 suppliers, 50 items, integrated inventory, bill-wise):

| Call | Time |
|---|---|
| Cold (first call after a change) | ≈ 0.75–0.85 s |
| Repeat with unchanged books (memo) | < 1 ms |
| Period change (Alt+F2), same asOf | ≈ 0.3 s (receivables / payables and the GST months reused) |

Breakdown of a cold call: the outstanding bill aggregate (receivables ≈ 0.22–0.25 s, payables ≈ 0.09 s;
`outstanding/engine.ts loadBillAggregates` — GROUP BY over a UNION of opening bills and allocations)
and the stock valuation replay for the gross profit (≈ 0.3 s; `inventory/valuation.ts`). Everything the
dashboard queries itself (flows, trend, tops, the two GST months, compliance, low stock, recent, PDC) is ≈ 150 ms.
The 200 ms target is therefore met for repeat calls on large books and for cold calls on typical books
(a few thousand vouchers); a period change at 50,000 vouchers pays the valuation replay again (≈ 0.3 s), and a **cold call at
50,000 vouchers does not meet it**: that needs the two shared engines to get faster (see Known gaps).

**Memo.** Results are kept per open database (most recent 6, per kind) and reused while the books are
unchanged. The change key is SQLite's own counters: `total_changes()` (every row changed through the
app's connection — saves, cancels, deletes, imports, settings) and `PRAGMA data_version` (commits by
any other connection). Any change, even one rolled back, simply invalidates. The working date and the
caller's permission flags are part of the key; the backup age is recomputed on every call. The DTO
says whether it was served from the memo (`cached`) and how long the call took (`elapsedMs`).

## Screen (`src/renderer/modules/dashboard`)

- Request: `summaryInput(workingDate, period)` → `asOf` = the working date, or the period end when the
  period ends earlier. The screens the balances drill into (Receivables / Payables, Reorder Status)
  report as on the period end and Cash/Bank Books / Ledger are opened with `to = asOf`, so a tile and
  its drill-down show the same figure; KPI captions say "On 30-Sep-2026 … · Sep 2026 to date" instead
  of "Today · This month" when asOf is not the working date.
- The summary is fetched again whenever the screen becomes visible (the Gateway stays mounted under
  every screen and a backup / new ledger / F11 change does not invalidate `dashboard.*`); the memo makes
  that free while the books are unchanged.
- Negative figures never show a bare minus: tiles are relabelled (Sales returns (net), Advances from
  customers / to suppliers, Cash & bank (overdrawn), Gross loss), captions use words (`compactSigned`).
- GST card: last month's return (when `gstDue`) above this month so far; the GST alert prefers it.
- A company without vouchers gets numbered first steps by permission (Features F11, ledgers, items,
  first sale F8, Migrate from Tally).

## Tests

`summary.test.ts` (hand-built books in `testkit.ts`, every figure computed in its header): flows for all
ranges and last year, gross profit (integrated = P&L; not integrated = sales − purchases), receivables /
payables (= outstanding engine), cash & bank, GST credit and payable months, due dates (monthly,
QRMP 22nd / 24th, year rollover), top customers / items, trend, low stock, recent vouchers and PDCs, a
post-dated receipt counting once its date arrives, backup age, permission gating, e-invoice / e-way bill
counts, an empty company, inventory off, memo invalidation, range edge cases (29-Feb, first year);
tie-outs: sales / purchases / GP = `profitLoss` for three periods, cash + bank = `reports.cashBank`
closing, receivables / payables = `outstanding.ageing` / `dueSoon`, compliance counts =
`pendingEinvoices` / `pendingEwayBills` (incl. vouchers without a stored nature), nominal openings
(books begun mid-year), last month's GST return until its due date, QRMP due dates by state.
`routes.test.ts`: dispatcher access (FORBIDDEN), VALIDATION, JSON safety. `perf.test.ts`: 50,000
vouchers.

```bash
node --test "src/core/modules/dashboard/**/*.test.ts" "src/renderer/modules/dashboard/**/*.test.ts"
```

## Known gaps

- Cold call at 50,000 vouchers ≈ 0.8 s (target 200 ms), dominated by code other modules own: the
  outstanding bill aggregate (≈ 0.25 s receivables + 0.09 s payables; most of it is materialising
  ~15,000 open-bill rows into JS — a covering index on `bill_allocations` was measured and gains
  < 10 %, so migration 130 stays empty) and the stock valuation replay for the gross profit (≈ 0.25–0.33 s,
  the same cost the P&L pays). Getting under 200 ms needs an aggregate-only outstanding entry point
  (buckets in SQL) and a valuation cache keyed by the books' change counter in those modules. The core
  runs on Electron's main process, so a cold call blocks other API calls for that long (the renderer
  keeps the previous figures on screen meanwhile).
- The Receivables / Payables screens take no `asOf` parameter (they use the period end): when the
  period runs past the working date (e.g. the whole year), the dashboard shows balances as on the
  working date while the drill-down shows them as on the period end.
- The Sales / Purchases tiles drill into the voucher register (invoice values incl. GST, credit notes
  separate); the tile is the P&L figure (net of returns, before GST).
- GST card is monthly: quarterly filers see the month's estimate (PMT-06 / 3B due date), not the quarter.
  There is no record of returns already filed, so last month's card shows until its due date even if
  it was paid early.
- Receivables ageing uses the default buckets and the due-date basis only.
