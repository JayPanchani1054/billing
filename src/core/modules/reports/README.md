# reports — Tally "Display" reports (core)

Trial Balance, Profit & Loss, Balance Sheet, Group Summary / Group Vouchers, Ledger, Monthly Summary,
Cash/Bank books, voucher registers, Cash Flow, Funds Flow, Ratio Analysis, Exception reports, Cost
Centres and Statistics — each with the figures a drill-down needs.

DTOs: `src/shared/types/reports.ts` · Routes: `routes.ts` · No migration (060 is empty: the covering
index `idx_le_books` from accounts serves every aggregate here).

| File | Contents |
|---|---|
| `engine.ts` | Report environment (masters, group tree, features), the one aggregate over `ledger_entries`, the Trial-Balance snapshot with the year-end treatment, P&L movements, stock values |
| `trialBalance.ts` | Trial Balance, Group Summary, Cash/Bank books |
| `financials.ts` | Profit & Loss (horizontal + Schedule III vertical), Balance Sheet, comparative periods |
| `ledger.ts` | Ledger Vouchers, Group Vouchers, Monthly Summary, particulars rule |
| `registers.ts` | Voucher registers, Exception reports, Statistics |
| `flows.ts` | Cash Flow, Funds Flow |
| `ratios.ts` | Ratio Analysis (pure `computeRatios` + `ratiosReport`) |
| `costCentres.ts` | Cost category / centre summary and ledger breakup |
| `testkit.ts` | Test books posted through the vouchers service (every figure hand-computed in its header) |

Conventions: money is integer **paise**. Ledger-style figures (opening, closing, running balance) are
signed **Dr + / Cr −**; `debit` / `credit` are unsigned period totals (`closing = opening + debit −
credit`). Two-sided statements use **side-natural** amounts: positive = the normal balance of the side
the line sits on (expense Dr, income Cr, liability Cr, asset Dr); negative = the opposite balance.
Every query applies the books filter (`BOOKS_FILTER`): optional, cancelled, memorandum and order
vouchers never count; post-dated vouchers count once their date is on or before the working date
(`ctx.clock.today()`).

---

## 1. The balance engine (`engine.ts`)

`loadReportEnv(db, today)` reads the company (books beginning, FY start month), F11 features, the group
tree (`loadGroupTree`) and every ledger once. **Integrated inventory** = F11 *Maintain stock* **and**
*Integrate accounts with inventory*; only then do opening/closing stock come from the stock valuation
(`openingStockValue` / `closingStockValue`, inventory README). Without it, stock values are 0 and
Stock-in-Hand ledgers are ordinary asset ledgers.

`ledgerSums(env, {cf, from, to})` is the single aggregate (`GROUP BY ledger_id`, covering index):
`pre` = entries before `cf`, `before` = entries in `[cf, from)`, `dr` / `cr` = debits / credits in
`[from, to]`.

### Year-end treatment (Tally semantics) — `buildSnapshot`

Notation: `ob` = a ledger's opening balance (at the books beginning), `L` = Σ `ob` of all ledgers,
`S0` = opening stock at the books beginning (as entered in the items), `Y` = **year start** = start of
the financial year containing `from` (never before the books beginning).

- **Real** ledgers (assets / liabilities): `opening = ob + pre + before`.
- **Nominal** ledgers (income / expenses) start afresh every year:
  `opening = (Y is the first year ? ob : 0) + before`.
- Everything nominal ledgers accumulated before `Y`, less the stock movement over those years, is the
  **profit brought forward** (credit-signed: negative = profit):
  `retained = Σ nominal (ob + pre) − (stock at Y − S0)`; it is added to the opening and closing of the
  reserved **Profit & Loss A/c** ledger. In the first year `retained = 0`.
- `closing = opening + dr − cr`; groups roll up over all sub-groups. The reserved **Profit & Loss A/c**
  ledger never rolls into the group it is stored under (Capital Account): as in Tally it is a primary
  line of its own, so Capital Account's Trial Balance / Group Summary figure equals its Balance Sheet line
  (`ledgersByGroup` and `ledgerIdsUnder` leave it out too — Group Vouchers and Monthly Summary of
  Capital Account do not include it).
- **Opening Stock** of the Trial Balance = stock value at the start of `Y`.
- **Difference in opening balances** `D = −(L + S0)` (0 when the openings agree). It never changes
  after the books begin, because every voucher balances.

Proof that the Trial Balance balances: Σ snapshot closings = `L − (stock at Y − S0)` (vouchers net to 0,
nominal history moves into the P&L A/c minus the stock movement), + opening stock at `Y` + `D` = 0.

`nominalMovement(env, from, to)` — the P&L value (Dr-signed) of each nominal ledger:
movement in `[from, to]` **plus `ob` when the period contains the books beginning**
(`from ≤ booksFrom ≤ to`; a company that starts its books mid-year enters year-to-date income/expenses
as opening balances; they belong to the first P&L). A comparative period wholly before the books (e.g.
"same period last year" in the first year) therefore shows no income or expenses, never the openings
a second time.

## 2. Trial Balance — `reports.trialBalance`

Input `{ from, to, mode?: 'groups' | 'ledgers' | 'detailed' (default groups), showOpening?, showZero? }`.

- `groups`: the group tree (primary groups at level 0, sub-groups below), no ledgers.
- `detailed`: groups with their sub-groups first, then their ledgers (pre-order, `level`, `parentKey`).
- `ledgers`: every ledger at level 0, in group order then name.
- With integrated inventory a top row **Opening Stock** (`kind 'stock'`, key `stock:opening`) shows the
  stock value at the year start (closing stock is not a ledger balance, as in Tally).
- **Profit & Loss A/c** (the reserved ledger, `kind 'ledger'`, key `l:<id>`) is a level-0 row of its own
  in every mode, after the groups (opening = profit brought forward + its opening balance; Dr/Cr =
  entries posted to it, e.g. a transfer to capital). Shown when non-zero (or `showZero`).
- When `D ≠ 0` a last row **Difference in opening balances** (`kind 'difference'`, key `diff`), signed.
- `showZero: false` (default) hides ledgers whose opening, debit, credit and closing are all 0, and groups
  that are all 0 with nothing shown below them. `showOpening` is a UI hint only.
- `totals` are over the level-0 rows: opening / transactions / closing, each as Dr and Cr columns
  (closing Dr column = Σ positive closings, Cr = Σ |negative|). Group mode nets each group (Tally
  condensed); ledger mode sums ledgers, so the column totals differ between modes but always agree Dr = Cr.
- `unbalancedBy` = closing Dr − Cr; `balanced` = it is 0 (only stored-data corruption breaks it).
- `yearStart`, `openingStock`, `openingDifference` are returned for headers and notes.

## 3. Group Summary — `reports.groupSummary`

`{ groupId, from, to, showZero?, basis? }` → the group's direct sub-groups and ledgers at level 0 with
their own sub-trees below (expandable).

- `basis: 'trialBalance'` (default): Trial-Balance figures (income/expense ledgers open with the year to
  date before `from`).
- `basis: 'profitLoss'` (the P&L screen drills with it): for an income/expense group the ledgers restart
  at `from` (opening = their opening balance only when the period contains the books beginning — exactly
  `nominalMovement`), so the closing equals the P&L line. Asset/liability groups ignore it; the result's
  `basis` says which was used. With integrated inventory, a summary that contains
Stock-in-Hand gets a **Closing Stock (stock summary)** row (`kind 'stock'`: opening = stock at `from`,
closing = stock at `to`, the change in Dr/Cr) and it rolls into Stock-in-Hand / Current Assets.
`totals` = Σ level-0 rows (equals the group's Trial-Balance line, plus stock where applicable).

## 4. Cash/Bank books — `reports.cashBank`

`{ from, to }` → Cash-in-Hand, Bank Accounts and Bank OD A/c with every ledger (zero-balance ledgers
kept so a new account shows; a group with no ledger anywhere below it is hidden, and so is a parent
left with nothing below it), Trial-Balance figures, `totals` (Σ groups).

## 5. Profit & Loss — `reports.profitLoss` (reports.financial)

`{ from, to, mode?: 'condensed' | 'detailed', compareWith?: 'previous_period' | 'previous_year' }`.

Primary income/expense groups are split by *affects gross profit* (Sales Accounts, Purchase Accounts,
Direct Incomes/Expenses = trading; Indirect = P&L). Values are `nominalMovement(from, to)` rolled up;
opening stock = stock at the start of `from`; closing stock = stock at the end of `to`.

```
Trading:   Expenses (left)                          | Income (right)
           Opening Stock                            | Sales Accounts …
           Purchase Accounts, Direct Expenses …     | Direct Incomes …
           Gross Profit c/o (if GP > 0)             | Closing Stock
                                                    | Gross Loss c/o (if GP < 0)
P&L:       Gross Loss b/f (if any)                  | Gross Profit b/f (if any)
           Indirect Expenses …                      | Indirect Incomes …
           Net Profit (if NP > 0)                   | Net Loss (if NP < 0)
```

- `GP = Sales + Direct incomes + Closing stock − Opening stock − Purchases − Direct expenses`
  (Direct incomes/expenses = all trading primary groups other than Sales/Purchase Accounts).
- `NP = GP + Indirect incomes − Indirect expenses`.
- Group lines carry their sub-groups and ledgers below them (`level`, `parentKey`, `hasChildren`).
  The **full tree is always returned**; `mode` only tells the screen how far to expand by default.
  Lines that are 0 in both columns are left out.
- `block.total` = left total = right total.
- Comparison: `previous_year` = same dates a year earlier (a month-end `to` stays a month end;
  29-Feb → 28-Feb); `previous_period` = the period of the same length just before `from` (whole months
  shift by months: Jul–Sep → Apr–Jun; otherwise by days). Every line has `compare`; lines present in
  only one period still appear (0 in the other).
- `vertical` (Schedule III style): I Revenue from operations (Sales + Direct incomes), II Other income
  (Indirect incomes), III Total income, IV Expenses (Purchases of stock-in-trade, Changes in inventories
  = opening − closing, Direct expenses, Other expenses = Indirect expenses), V Profit before tax = III −
  IV = NP.

## 6. Balance Sheet — `reports.balanceSheet` (reports.financial)

`{ asOf, mode?, compareAsOf? }`. `Y` = year start of `asOf`. Real ledgers: closing at `asOf`.

- Liabilities: primary groups of nature *liabilities* (tree order) with their sub-trees, then
  **Profit & Loss A/c** (`kind 'profit_loss'`, key `pl`) with parts *Opening Balance* (the reserved
  ledger's balance at `Y`, which includes `retained`), *Transferred during the year* (entries posted to
  that ledger since `Y`, if any) and *Current Period* (= `NP(Y, asOf)`). The reserved ledger is shown only
  here, not inside Capital Account. A debit total (accumulated loss) moves the line to the assets side.
- Assets: primary groups of nature *assets*; **Closing Stock** (key `stock:closing`) sits under
  Stock-in-Hand and rolls into Current Assets.
- **Difference in opening balances** `D`: a debit `D` is shown with the assets, a credit `D` with the
  liabilities.
- `asOf` before the books begin: the opening position (nominal opening balances as the current result).

Why it balances: assets − liabilities = Σ real closings + closing stock − (−PL ledger + current profit)
= `L − (stock at Y − S0) − Σ nominal closings + closing stock − current profit` = `L + S0` (current
profit = −Σ nominal closings + closing stock − stock at Y), and `D = −(L + S0)` sits on the other side.
`difference` = assets − liabilities must be 0 (`balanced`), asserted in `financials.test.ts` on books
posted through the vouchers service, in the first and the second year, with a loss, with a comparative
date, with an opening difference and with mid-year opening balances.

## 7. Ledger Vouchers — `reports.ledger`

`{ ledgerId, from, to, limit? (20,000) }` → `opening` (Trial-Balance rule, so nominal ledgers restart at
the year start), one row per voucher (date, type, number, reference, narration, **gross** debit and
credit of this ledger in the voucher, running `balance`), `totals`, `closing`, `count`, `truncated`
(rows are cut at `limit`; totals and closing are always complete).

**Particulars**: the single ledger on the opposite side; when several ledgers are opposite and some are
sales/purchase ledgers (an invoice), the largest of those — the customer's ledger shows "Sales" as in
Tally; otherwise `(as per details)`. `details` lists every other ledger with its signed amount.

## 8. Group Vouchers — `reports.groupVouchers`

`{ groupId, from, to, limit? }`: every voucher touching a ledger of the group (or its sub-groups), with
the group's gross debit/credit in it (a contra inside Current Assets shows on both sides), particulars =
the group ledgers touched (more than 3 → `(as per details)`), running balance from the group's opening.

## 9. Monthly Summary — `reports.monthlySummary`

`{ ledgerId | groupId (exactly one), from, to }` → opening, one row per calendar month clipped to the
period (`month`, `from`, `to`, debit, credit, closing, voucher `count`), totals, closing.

## 10. Registers — `reports.register`

`{ baseType | voucherTypeId, from, to, includeVouchers?, limit? }`. A voucher type includes the types
based on it (recursive `parent_id`); a base type includes every type of that base. Months: `count`,
`amount` (Σ `total_amount`: invoice value for invoices, Σ debits for ledger vouchers), `taxable`, `tax` of
**counted** vouchers (not optional, not cancelled, post-dated only once due) and `cancelled`. With
`includeVouchers` the period's vouchers are listed (cancelled ones flagged, amount 0; optional ones
excluded — see Exceptions).

## 11. Exceptions — `reports.exceptions`

`{ from, to, includeNoNarration?, limit? (5,000 per list) }`:
- `negativeLedgers`: closing balances unusual for the ledger (`negativeReason`): cash in hand Cr, bank
  account Cr (overdrawn), customer Cr (advance), other asset Cr, expense Cr, overdraft Dr, supplier Dr
  (advance), other liability Dr, income Dr. Duties & Taxes (input credits are normally Dr), Round Off and
  the Profit & Loss A/c are never flagged.
- `optional`, `postDated` (not cancelled), `cancelled`, `memorandum` (memorandum and reversing journal)
  vouchers dated in the period; `noNarration` (accounting vouchers in the books without narration) only
  when asked.

## 12. Statistics — `reports.statistics`

Per voucher type (active ones, or any with vouchers): `regular` (not optional/cancelled/post-dated),
`optional`, `cancelled`, `postDated`, `total`; totals; master counts (groups, ledgers, voucher types,
cost categories/centres, currencies, stock groups/categories/items, units, godowns, price levels).

## 13. Cash Flow — `reports.cashFlow` (reports.financial)

Cash & bank = ledgers under Cash-in-Hand, Bank Accounts and Bank OD A/c. For every voucher in the period
touching them, `C` = Σ its cash/bank entries: `C > 0` inflow, `C < 0` outflow (a contra nets to 0 and is
not a flow). Months: inflow, outflow, net. Group breakup: each counter entry contributes `−amount` to
its **reporting group** (the primary group, or its first sub-group: Sundry Debtors, Duties & Taxes …) as
inflow (> 0) or outflow (< 0). Σ group net = Σ net = closing − opening (cash & bank, signed).

## 14. Funds Flow — `reports.fundsFlow` (reports.financial)

Between the start of `from` and the end of `to`:
- **Net profit** (`NP(from, to)`) is a source (a loss an application).
- Each non-current primary group (all asset/liability primaries except Current Assets and Current
  Liabilities; the P&L A/c ledger excluded): change `−(closing − opening)` (Dr-signed) — positive (a
  liability grew or an asset shrank, e.g. depreciation) = source, negative = application.
- Entries posted directly to the Profit & Loss A/c ledger: same rule.
- Working capital = Current Assets (incl. stock) − Current Liabilities, at both ends; rows per direct
  sub-group / ledger of Current Assets and Current Liabilities with their effect on working capital.
- `totalSources − totalApplications = workingCapital.change`; `difference` reports any gap (0).

## 15. Ratio Analysis — `reports.ratios` (reports.financial)

Balances at the end of `to` (side-natural); flows for `[from, to]`; `days` = days in the period.

| Item | Formula |
|---|---|
| Working Capital | Current Assets (incl. closing stock) − Current Liabilities |
| Cash-in-Hand / Bank Accounts / Sundry Debtors | closing Dr balance of the group |
| Bank OD A/c / Sundry Creditors | closing Cr balance of the group |
| Sales / Purchase Accounts | P&L figures of the period |
| Stock-in-Hand | closing stock + Stock-in-Hand ledgers |
| Net Profit | P&L net profit |
| Working Capital Turnover | Sales ÷ Working Capital |
| Inventory Turnover | Sales ÷ Closing Stock |
| Current Ratio | Current Assets ÷ Current Liabilities |
| Quick Ratio | (Current Assets − Stock-in-Hand) ÷ Current Liabilities |
| Debt / Equity | Loans (Liability) ÷ (Capital Account + Profit & Loss A/c) |
| Gross Profit % | Gross Profit ÷ Sales × 100 |
| Net Profit % | Net Profit ÷ Sales × 100 |
| Operating Cost % | (Sales − Net Profit) ÷ Sales × 100 |
| Receivables Turnover in Days | Sundry Debtors × days ÷ Sales (rounded to whole days) |
| Return on Investment % | Net Profit ÷ (Capital Account + Profit & Loss A/c) × 100 |
| Return on Working Capital % | Net Profit ÷ Working Capital × 100 |

Ratios and percentages are rounded to 2 decimals; a zero denominator gives `null` ("not computable").
Capital Account excludes the reserved P&L A/c ledger; "Profit & Loss A/c" is the Balance Sheet total.

## 16. Cost Centres — `reports.costCentres`

`{ from, to, categoryId?, costCentreId? }`: rows = each category (level 0) and its centres (pre-order,
rolled up over sub-centres; centres without movement and without shown sub-centres hidden) with debit,
credit and net from `cost_allocations` (signed like the ledger entry, books filter). With
`costCentreId`: `centre.ledgers` = ledger breakup of the centre and its sub-centres, with totals.

## 17. Routes

| Route | Access | Input | Output |
|---|---|---|---|
| `reports.trialBalance` | reports.view | `TrialBalanceInput` | `TrialBalanceResult` |
| `reports.profitLoss` | reports.financial | `ProfitLossInput` | `ProfitLossResult` |
| `reports.balanceSheet` | reports.financial | `BalanceSheetInput` | `BalanceSheetResult` |
| `reports.groupSummary` | reports.view | `GroupSummaryInput` | `GroupSummaryResult` |
| `reports.groupVouchers` | reports.view | `GroupVouchersInput` | `GroupVouchersResult` |
| `reports.ledger` | reports.view | `LedgerReportInput` | `LedgerReportResult` |
| `reports.monthlySummary` | reports.view | `MonthlySummaryInput` | `MonthlySummaryResult` |
| `reports.cashBank` | reports.view | `PeriodInput` | `CashBankResult` |
| `reports.register` | reports.view | `RegisterInput` | `RegisterResult` |
| `reports.cashFlow` | reports.financial | `PeriodInput` | `CashFlowResult` |
| `reports.fundsFlow` | reports.financial | `PeriodInput` | `FundsFlowResult` |
| `reports.ratios` | reports.financial | `PeriodInput` | `RatiosResult` |
| `reports.exceptions` | reports.view | `ExceptionsInput` | `ExceptionsResult` |
| `reports.costCentres` | reports.view | `CostCentresInput` | `CostCentresResult` |
| `reports.statistics` | reports.view | `PeriodInput` | `StatisticsResult` |

All are `transactional: false` (read-only). Errors: `VALIDATION` with a field path for a reversed period
(`to`), an unknown `groupId` / `ledgerId` / `voucherTypeId` / `categoryId` / `costCentreId`, a register
without a type, a monthly summary without (or with both) ledger and group, and `compareAsOf = asOf`.

Performance (`perf.test.ts`, in-memory): 20,000 vouchers / 213 ledgers — Trial Balance (detailed) and a
ledger of the whole year well under 1 s; 20,000 item invoices / 2,000+ ledgers / 51 items with
integrated inventory — Trial Balance < 1 s (≈ 40 ms), Balance Sheet / P&L with comparison, Group
Summary, a 10,000-voucher ledger, Group Vouchers, Cash Flow, Funds Flow and Ratios each < 2 s (≈ 0.1–0.3 s);
8,000 items / 60,000 item invoices over two years — Balance Sheet with comparison ≈ 0.27 s (one stock
replay), then P&L / Trial Balance / Ratios / Funds Flow with no replay at all, Ledger Vouchers ≈ 2 ms.

How the stock part stays cheap (`engine.ts`):
- **One replay per report.** `prepareStock(env, { opening, closing })` gets every stock value a report
  needs (P&L: opening at `from`, closing at `to`, both periods when comparing; Balance Sheet: year
  start and `asOf` for each date; always the books-beginning opening) from ONE valuation pass
  (`inventory.stockValuesAt`); `stockAt` / `stockAtEnd` then read the request's memo.
- **Across requests.** The inventory module keeps those values per open database until anything in
  the books changes (`Db.dataRevision()`), so Balance Sheet → P&L → Balance Sheet replays once.
- **Drill-downs never value stock.** A snapshot's stock-dependent parts (`openingStock`, `retained`,
  `openingDifference` and the P&L A/c ledger's opening / closing) are computed on first read. Ledger
  Vouchers, Monthly Summary, Group Summary / Group Vouchers, Cash/Bank Books and Cash Flow build a
  snapshot of their own ledgers only (`buildSnapshot({ ledgerIds })`: their range of the
  `idx_le_books` covering index) — a ledger of 40 vouchers on a 60,000-voucher company takes ≈ 5 ms
  (was 0.8–1.0 s). The P&L A/c itself always gets the full snapshot (its brought-forward profit needs
  every nominal ledger).
On the auditors' 60,000-voucher file company: Balance Sheet 0.45–0.55 s cold (was 2.1 s), ≈ 80 ms when
the stock values are memoised; with comparison 0.4 s (was 3.1 s); P&L ≈ 80 ms after either (1.5 s
cold before); Trial Balance ≈ 75 ms; Ratios ≈ 0.16 s (was 1.8 s).

## 18. Known gaps

- Without integrated inventory there is no automatic opening/closing stock: Stock-in-Hand ledgers are
  plain asset ledgers (record closing stock by journal).
- Ledger Vouchers opened from a P&L-basis Group Summary show Trial-Balance figures (opening = year to
  date before `from`), as Tally does; the period's Dr/Cr agree with the summary.
- Foreign-currency columns are not shown (forex amounts are not posted by the vouchers engine yet).
- Group "net Dr/Cr balances" flags are not applied: groups always show the net of their ledgers.
- Cash flow does not split operating / investing / financing activities (Tally's monthly view only).
