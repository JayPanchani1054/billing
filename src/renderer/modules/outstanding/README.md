# outstanding (renderer) — receivables, payables, ageing, statements, interest, reminders

Screens for Tally's **Statements of Accounts › Outstandings**, built on the core routes in
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
| `components.tsx` | `OverdueBadge`, `UtilisationBar`, `AgeingBar`/`AgeingLegend`, `KpiStrip`, `PartyPicker`/`usePartyOptions`, `GroupSelect`/`useGroupOptions`, `useDocumentOutput` (print / PDF / clipboard with toasts) |
| `lib/model.ts` | Labels, tones, ageing-period parsing, bill keys, party tree rows, export tables, KPIs |
| `lib/ageingBars.ts` | Stacked-bar segments (percentages add to exactly 100) and severity levels |
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

Gateway menu (section `reports`, orders 60–66): Receivables, Payables, Ageing Analysis
(`{ view: 'ageing' }`), Overdue Bills (`{ view: 'bills', overdueOnly: true }`), Statement of
Account, Interest Calculation, Payment Reminders. Go To keywords include receivables, debtors,
payables, creditors, ageing, overdue, interest, statement, reminder.

### Receivables / Payables
* **Parties** (Ctrl+1): KPI strip — total, overdue (click → overdue bills), not yet due, advances &
  on account, over-credit-limit count (click → only parties over their limit); table with
  outstanding / overdue / not due / unadjusted, oldest overdue badge and a credit-limit bar. With
  "Only parties over their credit limit" on, the export's totals are recomputed over the parties
  shown (`partiesInView`), not the server's all-party totals.
* **Bills** (Ctrl+2): every pending bill; Overdue only (Alt+O), "overdue by at least N days",
  search (Ctrl+F, party or bill), group filter. Enter opens the bill's voucher (On Account / opening
  lines open the party).
* **Ageing** (Ctrl+3): editable periods (Alt+B, e.g. `30, 60, 90, 180`, validated like the server),
  due-date / bill-date basis (Alt+U), a bar chart of totals, a colour key and a small stacked
  "Age profile" bar per party (text alternative lists every bucket).
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
`partyEmptyBody`). Totals: bills pending, advances, on account,
balance. KPIs: balance, overdue, unadjusted, credit terms/limit used. Alt+H settled bills, Alt+N
FIFO ↔ On Account for non-bill-wise ledgers. Actions: Statement (Alt+S), Interest (Alt+I), Reminder
letter (Alt+R, receivable side), Ledger (Alt+L).

### Statement of account
Party card, period summary, transactions with running balance (Ctrl+1) and pending bills with
ageing (Ctrl+2). Opened with `{ from, to }` it keeps that period until the global period is changed
(Alt+F2) while it is open, which then applies (`statementPeriod`). Print (Alt+P) and PDF (Alt+E → P)
use `buildStatementHtml` (A4, letterhead, ageing
table, balance-confirmation note); Excel/CSV export the transactions.

### Interest
Rate: in party scope the ledger's own interest rate is pre-filled (from `outstanding.ledgerBills`);
clearing the field means "each party's own rate". Basis due/bill date (Alt+U), grace days; Enter
on the chosen party moves to the rate, then rate → basis → grace days → the bill list. The calculation runs only once typed values have
settled (300 ms) and, in party scope, once the party's rate is known — never at a half-typed rate. KPIs
split interest to charge (customers) and payable (suppliers); parties without a rate are listed in a
warning. Enter on a bill opens a **drawer** with the balance segments; per-segment interest is
allocated from the bill's once-rounded interest with the largest-remainder method, so the lines add
up to the paisa (`interestSegmentLines`; even if the server's figure differs from the exact split,
the difference is spread so the lines still add up, never below zero). Export/print (`interestExport`) never adds interest to
charge and interest payable together: with both sides present the rows are grouped by side, each
with its own total line.

### Payment reminders
Left: customers with bills overdue by at least N days (Alt+F) whose overdue amount is not already
covered by unadjusted receipts; tone badge (gentle / second / firm). Customers **not maintained
bill-wise are aged FIFO** (`remindersQuery` sends `nonBillWise: 'fifo'`) — with the route's default
they would be one never-overdue On Account line and never be reminded. Opened for one customer
(`{ ledgerId }`) the tag shows that customer's name even when nothing is due; Alt+W (or the tag's ×)
widens to every customer. Space includes/skips a customer
for batch output, Alt+A toggles everyone. Right: the letter preview, rendered as React text (no
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
