# outstanding (renderer) — receivables, payables, ageing, statements, interest, reminders

Screens for **Statements of Accounts › Outstandings**, built on the core routes in
`src/core/modules/outstanding` (semantics, sign conventions and worked examples: its README).
All routes are read-only (`reports.view`). Amounts arrive **side-signed** from side reports and are
shown **ledger-signed with Dr/Cr** (`ledgerSign(side)`: receivable ×1, payable ×−1), so a supplier
balance prints "Cr" and an advance from a customer prints "Cr" — never a bare minus.

| File | What |
|---|---|
| `index.ts` | `outstandingModule` (screens + Gateway menu), re-exports `DueSoonWidget`, imports `outstanding.css` |
| `OutstandingReport.tsx` | `outstanding.receivables` / `outstanding.payables` (parties · bills · ageing views) |
| `PartyScreen.tsx` | `outstanding.party` — one party's bills with history, on-account entries |
| `StatementScreen.tsx` | `outstanding.statement` — statement of account (print/PDF via `lib/printHtml.ts`) |
| `InterestScreen.tsx` | `outstanding.interest` — interest on overdue bills, segment drawer |
| `RemindersScreen.tsx` | `outstanding.reminders` — reminder letters, preview, print/PDF/copy, batch |
| `DueSoon.tsx` | `DueSoonWidget` for the dashboard |
| `components.tsx` | `OverdueDays` ("190 d"), `LimitUsed`, `DangerWord`, `PartyPicker`/`usePartyOptions`, `GroupSelect`/`useGroupOptions`, `useDocumentOutput` (print / PDF / clipboard with toasts) |
| `lib/model.ts` | Labels, tones, ageing-period parsing, bill keys, party tree rows, the lists as shown (`partiesInView`, `billsInView`), export tables |
| `lib/charts.ts` | 2.1 graphs and stat (pure): `receivablesStat`, `ageingChart` (+ `ageingColumns`), `partyChart` (meter), `statementChart` (line), `daysText`/`isLate` — tested in `charts.test.ts` (graph / stat = table) |
| `lib/interest.ts` | Interest input builder (with plain-English reasons) and segment split (adds up to the paisa) |
| `lib/reminders.ts` | Reminders route input (`remindersQuery`, FIFO), tone labels, batch selection, reminders list export, letter numeric columns, "due in" text, input clamps |
| `lib/printHtml.ts` | Self-contained A4 HTML for the statement and letters (every value `escapeHtml`'d) |
| `outstanding.css` | `bx-os-*` classes — semantic tokens only |

Tests: `node --test "src/renderer/modules/outstanding/**/*.test.ts"`.

## Screens

| id | params | Notes |
|---|---|---|
| `outstanding.receivables` | `{ view?: 'parties'\|'bills'\|'ageing', groupId?, overdueOnly? }` | As on = period end (Alt+F2) |
| `outstanding.payables` | same | |
| `outstanding.party` | `{ ledgerId }` | |
| `outstanding.statement` | `{ ledgerId?, from?, to? }` | without `ledgerId` the party picker is focused; without `from`+`to` the global period is used |
| `outstanding.interest` | `{ ledgerId?, groupId? }` | scope one party / group / all debtors & creditors |
| `outstanding.reminders` | `{ ledgerId?, groupId? }` | receivables only |

Gateway menu (section `reports`, orders 60–66): Receivables, Payables, Receivables Ageing and
Payables Ageing (`{ view: 'ageing' }` on each side — labels are unique across the Gateway, so
Go To never shows two "Ageing Analysis"), Overdue Bills (`{ view: 'bills', overdueOnly: true }`), Statement of
Account, Interest Calculation, Payment Reminders. Go To keywords include receivables, debtors,
payables, creditors, ageing, overdue, interest, statement, reminder.

### Receivables / Payables
2.1 (SPEC-21 §1.9, D25). Title row: *Receivables* · "As on 10-Oct-26" (Alt+F2) · in the Ageing view "aged by
due date" · **"N over credit limit"** as the one danger word when N > 0; Print and Export are the only
buttons (Alt+W *Payables* is `demoted` to More, its key unchanged). Toolbar row: the view tabs, the
search (Ctrl+F), the group filter, the view's own control (Bills: *Filters*; Ageing: *Periods*) and, on
the right, the **stat** in all three views — `receivablesStat` over the totals shown:
*To collect* (`totals.pending`; *To pay* on Payables; *Received / Paid in advance* when advances outweigh
the bills) · *Overdue* (`totals.overdue`, opens the Ageing view) · *₹z not matched to bills ›*
(`advance + onAccount`, without a sign; the one link — opens the Bills view with "Only advances and on
account"). Zero items are dropped. "To collect" restates the Net outstanding total in the owner's words —
allow-listed in `app/lib/chartCatalogue.ts` `STAT_TOTAL_ALLOWED`.
* **Parties** (Ctrl+1): no ageing request. 2.1.2: the graph "Who owes me the most?" / "Whom do I owe the
  most?" (`lib/charts.ts` `partiesChart`) — inline bars in Net outstanding with ≤ 7 parties (`inlineBars`), else
  a Top 6 + Other strip; Σ = `totals.pending` of the rows shown; Enter on a bar opens the party. Columns: party,
  Overdue, Not due, Advances & on account, Net outstanding, Oldest ("190 d" — plain, `bx-os-danger`
  only beyond the last ageing period). Columns blank on every row hide (`hideEmptyColumns`); Group and
  Credit limit used are hidden until More › *Columns…*; exports keep every column. More › *Only parties
  over their credit limit* (keyless, checkable) filters the list; its export's totals are recomputed over
  the parties shown (`partiesInView`), not the server's all-party totals.
* **Bills** (Ctrl+2): every pending bill; Overdue only (Alt+O, checkable), and in the *Filters* popover
  "overdue by at least N days" and "Only advances and on account" (`billsInView`, totals recomputed for
  the export). The filters are one `BillFilter` changed only through `withOverdueOnly` / `withMinDays` /
  `withUnmatchedOnly` / `ageColumnFilter` (lib/model.ts): "only advances and on account" never combines
  with the overdue filters (that list would always be empty), whichever way either is set; search (Ctrl+F, party or bill), group filter. The ref type follows the bill number as a
  muted word (no badges). Enter opens the bill's voucher (On Account / opening lines open the party).
* **Ageing** (Ctrl+3): the graph `ageingChart` — unpaid bills by age (advances and on account are not
  age: they stay in their table columns), ordinal colour (Not due `--chart-other`, the age ranges on the
  `--chart-o1…o5` ramp; beyond five ranges the oldest fold into one "> N days" column, Σ kept), direct
  label on the largest, takeaway "Of ₹4.74 L in unpaid bills, ₹1.91 L is over 90 days" (the largest
  limit ≤ 90 days, else the first). Its total = Σ of the table's age-range columns. Enter on a column
  opens the Bills view: a due-date column sets "overdue by at least" its first day (Not due: no filter);
  on the bill-date basis it opens the bills unfiltered (the bills list filters by days past due). Ctrl+J
  folds it to the takeaway (report class). *Periods* (Alt+B opens the popover and focuses the field, e.g.
  `30, 60, 90, 180`, validated like the server; Enter or leaving applies, Esc cancels the edit, an invalid
  entry is forgotten on leaving); due-date / bill-date basis is Alt+U (More). The 2.0 colour key and per-party "Age profile"
  bars are gone (the graph and the bucket columns carry it).
* Enter on a party → `outstanding.party`; in the bills / ageing views Alt+V opens the highlighted
  row's party. Alt+S statement, Alt+L ledger, Alt+I interest and Alt+R reminder letter (receivables)
  — both for the highlighted party, else the group / everyone — Alt+W switch side. These party actions follow the
  highlighted row of the table on screen only — switching views or filtering clears them. Parties
  not maintained bill-wise are aged **FIFO** by default (Alt+N switches to one On Account line).
* The group filter lists Sundry Debtors / Creditors and their sub-groups; it needs `masters.view`
  (without it the filter is hidden and no request is made).

### Party outstanding
Bills as a tree (→ / + expands the history: new ref, against ref, advance…); Enter on a history line
opens the voucher. Ctrl+2 lists on-account entries (bill-wise ledgers only; a ledger not maintained
bill-wise shows its balance FIFO or as one On Account amount — Alt+N — and the empty list says so,
`partyEmptyBody`; why, in More › About this report). Footer lines: bills pending, of which overdue,
advances, on account, balance (2.1: they replace the KPI tiles). Context run: group · "not bill-wise" ·
"30 days credit" · "limit ₹x"; "Over credit limit" is its danger word. Graph (`partyChart`, detail class —
shown by default since 2.1.1, Ctrl+J folds it): a meter "balance against the credit limit", only with a limit and a balance on the
party's side. Alt+F1 *Show settled bills* (checkable; Alt+H stays edit history), Alt+N FIFO ↔ On Account
for non-bill-wise ledgers. Actions: Statement (Alt+S, the one extra title-row button — no filled button on
a report), Interest (Alt+I), Reminder letter (Alt+R, receivable side), Ledger (Alt+L).

### Statement of account
Transactions with running balance (Ctrl+1; footer: opening, period totals, closing) and pending bills
(Ctrl+2; footer: one line per non-empty ageing period, advances, on account, total). The running balance
is also a line graph (`statementChart`, detail class — shown by default since 2.1.1, Ctrl+J folds it; on the party's side, Dr/Cr
words, ≤ 480 points, ending on the closing balance) — on screen only: the printed statement never has a
graph. The party's address, GSTIN, contact and credit terms are in More › *Party details*. Opened with `{ from, to }` it keeps that period until the global period is changed
(Alt+F2) while it is open, which then applies (`statementPeriod`). Print (Alt+P) and PDF (Alt+E → P)
use `buildStatementHtml` (A4, letterhead, ageing
table, balance-confirmation note); Excel/CSV export the transactions.

### Interest
Rate: in party scope the ledger's own interest rate is pre-filled (from `outstanding.ledgerBills`);
clearing the field means "each party's own rate". Basis due/bill date (Alt+U), grace days; Enter
on the chosen party moves to the rate, then rate → basis → grace days → the bill list. The calculation runs only once typed values have
settled (300 ms) and, in party scope, once the party's rate is known — never at a half-typed rate. The table's
total lines split interest to charge (customers) and payable (suppliers) — no tiles, no graph; the bill
count is on the toolbar row; parties without a rate are listed in a one-line warning. Enter on a bill opens a **drawer** with the balance segments; per-segment interest is
allocated from the bill's once-rounded interest with the largest-remainder method, so the lines add
up to the paisa (`interestSegmentLines`; even if the server's figure differs from the exact split,
the difference is spread so the lines still add up, never below zero). Export/print (`interestExport`) never adds interest to
charge and interest payable together: with both sides present the rows are grouped by side, each
with its own total line.

### Payment reminders
Left: customers with bills overdue by at least N days (Alt+F) whose overdue amount is not already
covered by unadjusted receipts; letter tone (gentle / second / firm, its meaning in the tooltip). Customers **not maintained
bill-wise are aged FIFO** (`remindersQuery` sends `nonBillWise: 'fifo'`) — with the route's default
they would be one never-overdue On Account line and never be reminded. Opened for one customer
(`{ ledgerId }`) the tag shows that customer's name even when nothing is due; Alt+W (or the tag's ×)
widens to every customer. Space includes/skips a customer
for batch output, Alt+A toggles everyone; the stat says "Selected M of N" (the amount asked for in its
tooltip; the amount due is the table's total). Print / PDF / Copy text are title-row actions only. Right: the letter preview, rendered as React text (no
HTML). Alt+P print, Alt+S PDF, Alt+T copy the plain-text letter (`navigator.clipboard`), Alt+B print
every included letter (one page each; asks first above 10), Alt+M all included letters as one PDF,
Alt+E export the follow-up list (Excel / CSV / PDF). Enter opens the customer's outstanding. In
the letter table the bill-number column stays left-aligned even when bill numbers are numeric
(`letterNumericColumns`, shared by the preview and the printed letter).

## DueSoonWidget (for the dashboard)

```tsx
import { DueSoonWidget } from '../outstanding/index.ts';

<DueSoonWidget side="receivable" days={7} />          // collections due in the next 7 days
<DueSoonWidget side="payable" days={7} limit={5} height={200} />
```

| Prop | Type | Default | |
|---|---|---|---|
| `side` | `'receivable' \| 'payable'` | — | |
| `days` | `number` | — | look-ahead from the **working date** (F2), clamped to 0–366; due today included |
| `limit` | `number` | 8 | bills listed |
| `height` | `number` | 260 | table height (px) |
| `className` | `string` | | |

A `Card` with two clickable figures (due by <date> → bills view; already overdue → overdue bills)
and a compact table (party, bill, "Due today / tomorrow / In N days", amount). Enter on a row opens
`outstanding.party`; "View all" opens Receivables/Payables. Non-bill-wise parties are included FIFO.
Renders nothing for users without `reports.view`; errors show a small retry state. The title reads
"due today" / "today or tomorrow" / "in the next N days". Note: the widget counts from the working
date, while the Receivables/Payables screen it opens is "as on" the period end (Alt+F2) — the two
agree whenever the period ends on the working date (the default: financial year to date). `days` is
clamped to 0–366 (non-numbers → 7) and `limit` to 1–1000, so a bad prop never reaches the route as
a validation error.
