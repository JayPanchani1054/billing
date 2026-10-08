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
| Sales / purchases | Net movement of ledgers under **Sales Accounts** (credits − debits, so credit notes reduce it) / **Purchase Accounts** (debits − credits), i.e. the P&L's sales and purchases, before GST. ONE aggregate over `ledger_entries` (`idx_le_books`) for all eight ranges. |
| Gross profit | `sales + direct incomes − (opening stock + purchases + direct expenses − closing stock)` for the period — exactly the P&L's gross profit (tested against `reports.profitLoss`). With integrated inventory (F11 inventory + integrate) the stock values come from ONE `computeStockValuation(from, to)` replay (`method: 'stock_valuation'`); otherwise stock is 0 (`method: 'purchases'`: sales − purchases). Nominal opening balances are included when the period contains the books beginning (as `nominalMovement` does). `marginPercent` = GP ÷ sales × 100, 2 decimals, null when sales are 0. |
| Receivables / payables | The outstanding engine (`outstanding/reports.ts sideParties`, **FIFO for ledgers not maintained bill-wise**, like the Receivables / Payables screens' default): `total` = Σ party balances on the side; due-date ageing with the default buckets (Not due · 1–30 · 31–60 · 61–90 · 91–180 · > 180); `overdue` / `notDue` from the bills; advances and on-account amounts separately (not aged); `dueSoon` = bills with pending > 0 due from asOf to asOf + 7 days (due today included). Tested equal to `outstanding.ageing` and `outstanding.dueSoon`. |
| Cash & bank | `closingBalances` as at asOf for ledgers under Cash-in-Hand / Bank Accounts / Bank OD (signed Dr + / Cr −; banks: normal accounts first, then OD; `accountTail` = last 4 digits of the account number). |
| GST | GST on and **regular** registration only (composition / unregistered → null). `computeGstr3b` for the calendar month of asOf (the GSTR-3B screen's figures incl. its manual entries): `outputTax` = 3.1(a) + 3.1(b), `reverseChargeTax` = 3.1(d), `inputTax` = net ITC 4(C), `netPayable` = cash after the s.49 / Rule 88A set-off + reverse charge (before interest / late fee), `creditCarriedForward`. `dueDate`: monthly filers GSTR-3B on the 20th of the next month; quarterly (QRMP) filers PMT-06 on the 25th for the first two months of a quarter and GSTR-3B on the 22nd (category-1 states) / 24th after the quarter end. |
| Top customers | Period net sales (Sales Accounts entries) per voucher party, cash / bank "parties" (cash sales) excluded; top 5; `invoiceCount` = sales vouchers; `sharePercent` of period sales. |
| Top items | Period sales − sales returns (credit notes with items) per item: taxable value and quantity (`billed_qty`, else the stock quantity); top 5. Empty when inventory is off. |
| Trend | 12 calendar months ending with the month of `to`: sales and purchases per month (Σ Apr–Oct of the testkit = the YTD flows). |
| Low stock | Active goods items with `reorder_level > 0` whose quantity on hand at asOf (`stockByItem`) is below it; least cover (on hand ÷ reorder level) first; at most 10 listed, `count` = all. |
| Compliance | Counts from the start of asOf's financial year to asOf. **e-invoice** (feature on): outward documents (sales / credit / debit notes) in the books with an e-invoice nature (B2B, SEZ, export, deemed export), no IRN, `irn_status` NULL / '' / pending — the rule of `gst.einvoice.pending`. **e-way bill** (feature on): sales and credit notes in the books without an EWB number whose taxable goods value + tax exceeds `config.gst.ewayThresholdPaise` (₹50,000) — the rule of `gst.ewaybill.pending`. |
| Recent vouchers | The last 8 vouchers entered (highest id), any status, flagged cancelled / optional / post-dated; a cancelled voucher shows amount 0. |
| Post-dated | Vouchers marked post-dated, dated after the working date, not cancelled / optional, whose net cash/bank movement is non-zero: `direction` in (receipt) / out (payment), `inflow` / `outflow` totals, the main bank ledger and cheque number; earliest first (10 listed, `count` = all). |
| Backup | `data/backup.ts lastBackupAt` (backup history, else the edit log) and whole days since then on the clock. |

## Performance

Measured in the dev container (`perf.test.ts`): 50,000 vouchers (25,000 sales, 10,000 purchases, 10,000
receipts, 5,000 payments; 1,000 customers, 200 suppliers, 50 items, integrated inventory, bill-wise):

| Call | Time |
|---|---|
| Cold (first call after a change) | ≈ 0.75–0.9 s |
| Repeat with unchanged books (memo) | < 1 ms |
| Period change (Alt+F2), same asOf | ≈ 0.33 s (receivables / payables reused) |

Breakdown of a cold call: the outstanding bill aggregate (receivables ≈ 0.3–0.4 s, payables ≈ 0.1 s;
`outstanding/engine.ts loadBillAggregates` — GROUP BY over a UNION of opening bills and allocations)
and the stock valuation replay for the gross profit (≈ 0.3 s; `inventory/valuation.ts`). Everything the
dashboard queries itself (flows, trend, tops, GST month, compliance, low stock, recent, PDC) is ≈ 90 ms.
The 200 ms target is therefore met for repeat and period-change calls on large books, and for cold calls
on typical books (a few thousand vouchers), but **not for a cold call at 50,000 vouchers**: that needs
the two shared engines to get faster (see Known gaps).

**Memo.** Results are kept per open database (most recent 6, per kind) and reused while the books are
unchanged. The change key is SQLite's own counters: `total_changes()` (every row changed through the
app's connection — saves, cancels, deletes, imports, settings) and `PRAGMA data_version` (commits by
any other connection). Any change, even one rolled back, simply invalidates. The working date and the
caller's permission flags are part of the key; the backup age is recomputed on every call. The DTO
says whether it was served from the memo (`cached`) and how long the call took (`elapsedMs`).

## Tests

`summary.test.ts` (hand-built books in `testkit.ts`, every figure computed in its header): flows for all
ranges and last year, gross profit (integrated = P&L; not integrated = sales − purchases), receivables /
payables (= outstanding engine), cash & bank, GST credit and payable months, due dates (monthly,
QRMP 22nd / 24th, year rollover), top customers / items, trend, low stock, recent vouchers and PDCs, a
post-dated receipt counting once its date arrives, backup age, permission gating, e-invoice / e-way bill
counts, an empty company, inventory off, memo invalidation, range edge cases (29-Feb, first year).
`routes.test.ts`: dispatcher access (FORBIDDEN), VALIDATION, JSON safety. `perf.test.ts`: 50,000
vouchers.

```bash
node --test "src/core/modules/dashboard/**/*.test.ts" "src/renderer/modules/dashboard/**/*.test.ts"
```

## Known gaps

- Cold call at 50,000 vouchers ≈ 0.8 s (target 200 ms), dominated by the outstanding bill aggregate and
  the stock valuation replay owned by those modules (a covering index on `bill_allocations(ledger_id,
  bill_name, date, …)` or an aggregate without the UNION, and a valuation cache keyed by the books'
  change counter, would bring it down).
- e-invoice pending counts rely on `vouchers.gst_nature` as stored by the posting engine; a voucher saved
  without a nature (legacy imports) is not counted (the GST screen derives one).
- GST card is monthly: quarterly filers see the month's estimate (PMT-06 / 3B due date), not the quarter.
- Receivables ageing uses the default buckets and the due-date basis only.
