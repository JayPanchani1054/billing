# outstanding — bills receivable / payable, ageing, interest, statements, reminders

**Statements of Accounts › Outstandings** for Pevqori: bills receivable and payable, group
(party) outstandings, ledger outstandings with each bill's history, ageing analysis, interest on overdue
bills, statement of account, payment reminder letters, and the dashboard's "due soon" list.

DTOs: `src/shared/types/outstanding.ts` · Routes: `routes.ts` · No migration (080 stays empty; existing
indexes `idx_bills_ledger`, `idx_bills_ledger_date`, `idx_le_books` cover the queries).

| File | What |
|---|---|
| `engine.ts` | Scope (which ledgers), bill aggregation, On Account remainder, FIFO slicing/settlement, party figures |
| `ageing.ts` | Bucket construction and bucket lookup (pure) |
| `reports.ts` | `outstanding.bills`, `.partySummary`, `.ageing`, `.dueSoon` |
| `ledger.ts` | `outstanding.ledgerBills`, `.statement` |
| `interest.ts` | `outstanding.interest` (`billInterest` is pure) |
| `reminders.ts` | `outstanding.reminders` (`buildReminderLetter` is pure) |
| `testkit.ts` | Test helpers that write voucher rows like the posting engine |

---

## 1. Semantics

### Data and the books filter
Everything is read from `opening_bills`, `bill_allocations`, `ledger_entries` and `ledgers`, with the
books filter from `accounts/books.ts`:

    affects_books = 1 AND (is_post_dated = 0 OR date <= :today)      -- today = ctx.clock.today()

and `date <= asOf`. Optional, cancelled, memorandum and order vouchers never count. A **post-dated**
voucher counts only once the working date reaches its date — even in a report "as of" a later date.
Opening bills (as at books beginning) always count.

### Bills
A bill is identified by **(ledger_id, bill_name)** (exact, case-sensitive, like the posting engine).

    pending  = opening_bills.amount + Σ bill_allocations.amount      (allocations other than 'on_account')
    original = Σ amounts of the originating references (opening / new / advance)

Allocations are signed like their ledger entry (Dr +, Cr −), so a sales bill is positive, a receipt
'against' it negative. Bills with pending 0 are settled and omitted (except `includeSettled`).

| Field | Rule |
|---|---|
| `refType` | `opening` if there is an opening bill, else `new`, else `advance`, else `against` (a reference whose 'new' is missing) |
| `billDate` | earliest date of an originating reference (else the earliest line) |
| `dueDate` | stored due date of the originating reference (the posting engine stores voucher date + credit days for 'new' refs); else bill date + allocation credit days; else + the ledger's default credit days; else the bill date. **Advances have no due date.** |
| `overdueDays` | `asOf − dueDate` when positive, else 0; always 0 for advances and On Account lines |

### Advances and On Account
* An **advance** ('advance' ref) is a named bill in the party's favour (negative on its side). It is
  reported separately (`advance` totals / ageing column) and never ages, falls due or bears interest.
  When a later invoice allocates 'against' it, it nets to 0 and disappears.
* **On Account** is everything not allocated to a named bill:

      onAccount = ledger closing balance − Σ pending of all named bills (incl. advances)

  It covers 'on_account' allocations, entries posted without allocations (e.g. a journal, or vouchers
  entered before bill-wise was switched on) and an opening balance not broken into opening bills.
  So **Σ bills + On Account = the ledger balance**, always. `ledgerBills` lists the On Account
  remainder line by line (`opening` / `on_account` / `unallocated`).

### Ledgers that are not maintained bill-wise
(`ledgers.maintain_bill_wise = 0`, or the company's bill-wise feature is off — then every ledger.)
Option `nonBillWise`:

* `on_account` (default for side reports): the whole balance is one **On Account** line — not aged, never overdue.
* `fifo` (default for `ledgerBills` and `statement`): the balance is aged **first-in-first-out**: it is
  made of the most recent debits (Dr balance) / credits (Cr balance), newest first, the oldest one
  partly. Each such voucher becomes a pseudo-bill (`refType 'fifo'`, bill name = voucher number,
  due date = voucher date + the ledger's credit days); the opening balance is an item dated on the
  books beginning. `ledgerBills` and `interest` replay the ledger oldest first (each credit settles the
  oldest open debits) to get each pseudo-bill's settlement history — the items left open are exactly the
  FIFO slices (tested on random histories).

### Scope and sides
`side` decides the sign convention and the default scope:

| | Default scope (no `groupId` / `ledgerId`) | Positive amount means |
|---|---|---|
| `receivable` | ledgers under **Sundry Debtors** (any depth) + bill-wise ledgers outside Debtors/Creditors whose balance is **Dr** (staff advances, deposits paid, …) | receivable from the party |
| `payable` | ledgers under **Sundry Creditors** + bill-wise ledgers outside Debtors/Creditors whose balance is **Cr** (deposits received, …) | payable to the party |

A debtor with a Cr balance (advance received) stays in receivables as a negative amount, like the conventional
Group Outstandings; likewise a creditor we have overpaid stays in payables, negative. With `groupId`,
every ledger in that group's subtree is listed whatever its sign; `ledgerId` picks one ledger (and must
be inside `groupId` when both are given).

Single-ledger documents (`ledgerBills`, `statement`) use ledger signs (Dr +, Cr −) instead.

### Ageing
Default limits `[30, 60, 90, 180]` → buckets `Not due · 1–30 · 31–60 · 61–90 · 91–180 · > 180` days.

* `basis: 'due_date'` (default): age = asOf − due date; age ≤ 0 → **Not due**; exactly 30 → 1–30; 31 → 31–60.
* `basis: 'bill_date'`: age = asOf − bill date; age 0…30 → **0–30** (the Not due bucket stays at
  index 0 so the shape is stable, and is always 0).
* Advances and On Account amounts are separate columns; `total = Σ buckets + advance + onAccount =
  net outstanding`. Bills in the party's favour (e.g. a credit note entered as a new reference) are
  aged like any bill, as negative amounts.

### Party figures (`partySummary`)
`pending` (net) = `billsPending + advance + onAccount` = closing balance on the side;
`billsPending = overdue + notDue` (bills excluding advances); `oldestDueDays` = overdue days of the
most overdue bill; `utilisationPercent = pending ÷ creditLimit × 100` (2 decimals, null without a
limit; a 0 limit counts as none); `overLimit = pending > creditLimit`.

---

## 2. Routes

All: scope `company`, access **`reports.view`**, `transactional: false`. Names follow the brief
(`outstanding.<report>`).

| Route | Input | Output |
|---|---|---|
| `outstanding.bills` | `{ side, asOf, groupId?, ledgerId?, overdueOnly?, minOverdueDays?, search?, sort?: 'bill_date'\|'due_date'\|'party'\|'amount'\|'overdue', limit? (≤ 10000, default 1000), offset?, nonBillWise?, includeOnAccount? (default true) }` | `{ side, asOf, rows: OutstandingBillRow[], total, totals: { pending, overdue, notDue, advance, onAccount, billCount, overdueCount } }` — row: `{ ledgerId, ledgerName, groupId, groupName, billWise, billName, billDate, dueDate, creditDays, originalAmount, pendingAmount, overdueDays, refType, voucherId }`. Totals cover all matching rows, not just the page. On Account lines (one per party) are left out by the overdue filters. `search` matches party name/alias or bill name. |
| `outstanding.partySummary` | `{ side, asOf, groupId?, search?, nonBillWise?, includeZero? }` | `{ rows: PartyOutstandingRow[], totals }` — row: `{ ledgerId, ledgerName, groupId, groupName, billWise, pending, billsPending, overdue, notDue, advance, onAccount, billCount, overdueBillCount, oldestDueDays, creditLimit, creditDays, utilisationPercent, overLimit, mobile, email }` |
| `outstanding.ledgerBills` | `{ ledgerId, asOf, includeSettled?, nonBillWise? (default 'fifo') }` | `{ ledger: { id, name, groupId, groupName, billWise, side, creditDays, creditLimit, interestRate }, asOf, method: 'bill_wise'\|'fifo'\|'on_account', balance, bills: [{ billName, billDate, dueDate, creditDays, refType, originalAmount, pendingAmount, overdueDays, voucherId, history: [{ kind, voucherId, voucherNumber, voucherType, baseType, date, amount, runningPending, narration }] }], onAccount: { total, lines: [{ kind: 'opening'\|'on_account'\|'unallocated', date, voucherId, voucherNumber, voucherType, baseType, amount, narration }] }, totals: { billsPending, advance, onAccount, overdue, balance } }` (ledger signs) |
| `outstanding.ageing` | `{ side, asOf, buckets? (1–12 increasing limits), basis? ('due_date'), groupId?, ledgerId?, search?, nonBillWise? }` | `{ side, asOf, basis, buckets: [{ index, label, minDays, maxDays }], rows: [{ ledgerId, ledgerName, groupId, groupName, billWise, amounts[], advance, onAccount, total }], totals: { amounts[], advance, onAccount, total } }` |
| `outstanding.interest` | `{ ledgerId?, groupId?, from, to, ratePercent? (0.01–100; default each ledger's rate), basis? ('due_date'), graceDays? (0), method? ('simple_365') }` | `{ from, to, basis, graceDays, method, rows: [{ ledgerId, ledgerName, side, billName, billDate, dueDate, refType, interestFrom, ratePercent, principal, pendingAtEnd, days, interest, segments: [{ from, to, days, balance }] }], totals: { receivable, payable, billCount }, skipped: [{ ledgerId, ledgerName, reason }] }`. Default scope: Sundry Debtors + Sundry Creditors. |
| `outstanding.statement` | `{ ledgerId, from, to, nonBillWise? (default 'fifo'), buckets? }` | `{ company: {name, mailingName, address, stateCode, stateName, pincode, phone, mobile, email, gstin, pan}, party: {ledgerId, name, mailingName, address, stateCode, stateName, pincode, gstin, pan, contactPerson, phone, mobile, email, groupName, billWise, creditDays, creditLimit}, from, to, generatedOn, openingBalance, transactions: [{ date, voucherId, voucherType, baseType, voucherNumber, referenceNo, particulars, narration, debit, credit, balance }], totals: { debit, credit }, closingBalance, pendingBills: { asOf: to, method, buckets, rows: [{ billName, billDate, dueDate, refType, pendingAmount, overdueDays, ageDays, bucketIndex }], bucketTotals, advance, onAccount, total } }` (ledger signs; `particulars` = the largest opposite-side ledger of the voucher, as accountants expect) |
| `outstanding.reminders` | `{ asOf, minOverdueDays? (≥ 1, default 1), side?: 'receivable', groupId?, ledgerId?, nonBillWise? }` | `{ asOf, minOverdueDays, parties: [{ ledgerId, ledgerName, email, mobile, tone, overdueBills: [{ billName, billDate, dueDate, pendingAmount, overdueDays }], totalOverdue, unadjustedCredits, amountDue, netOutstanding, oldestOverdueDays, letter: { date, from[], to[], subject, salutation, opening[], table: { columns, rows, total }, closing[], signOff[], text } }], totals: { partyCount, amountDue } }` |
| `outstanding.dueSoon` | `{ side, asOf, days (0–366), groupId?, limit? (≤ 1000, default 50), nonBillWise? }` | `{ side, asOf, days, until, rows: (OutstandingBillRow & { daysToDue })[], total, amount, overdue: { amount, count } }` — bills with pending > 0 and `asOf ≤ dueDate ≤ asOf + days` (due today included), ordered by due date. |

Errors: VALIDATION for bad input ("The end date must be on or after the start date", "Ageing periods
must be in increasing order (e.g. 30, 60, 90, 180)", …), NOT_FOUND for an unknown ledger/group.

---

## 3. Worked examples

### 3.1 Bills, advance, on account (as of 30-Sep-2026, Acme Traders, 30 credit days)

| Date | Voucher | Allocation | INV-001 | ADV-1 | On Account |
|---|---|---|---|---|---|
| 10-Apr | Sales INV-001 ₹1,18,000 | new INV-001, due 10-May | 1,18,000 | | |
| 20-May | Receipt ₹50,000 | against INV-001 | 68,000 | | |
| 01-Jun | Receipt ₹20,000 | advance ADV-1 | | −20,000 | |
| 01-Jul | Sales INV-7 ₹50,000 | against ADV-1 ₹20,000 + new INV-7 ₹30,000 | | 0 (settled) | |
| 20-Aug | Receipt ₹40,000 | on account | | | −40,000 |

Receivable on 30-Sep: INV-001 ₹68,000 overdue **143 days** (10-May → 30-Sep: 21 + 30 + 31 + 31 + 30),
INV-7 ₹30,000 (due 31-Jul, 61 days), On Account −₹40,000; party pending ₹58,000 = the ledger's Dr balance.

### 3.2 Ageing boundaries (due-date basis, default buckets, as of 30-Sep)
Due 30-Sep → Not due · due 31-Aug (30 days) → 1–30 · due 30-Aug (31 days) → 31–60 ·
due 03-Apr (180 days) → 91–180 · due 02-Apr (181 days) → > 180.

### 3.3 Interest — simple, 365-day year, rounded once per bill

    interest = round( Σ_segments balance × days × rate ÷ 100 ÷ 365 )

Interest accrues on each day `d` with `interestFrom < d ≤ to` and `d ≥ from`, where
`interestFrom = due date (or bill date) + graceDays`. The balance for day `d` comprises the bill's lines
dated **before** `d`, so a payment dated `d` still bears interest for day `d` ("interest up to the date
of payment"). Only days with a positive side-signed balance accrue: debtors' Dr bills (receivable),
creditors' Cr bills (payable — e.g. MSME delayed-payment interest), other ledgers in the direction of the
bill's origin. Advances, On Account amounts and bills in the party's favour never bear interest. A
365-day year is used in leap years too. Ledgers without a rate (interest not enabled on the ledger and no
`ratePercent`) are listed in `skipped`.

**Example 1.** ₹1,00,000 due 30-Apr, unpaid on 14-Jun, 18% p.a.: days 1-May…14-Jun = 31 + 14 = **45**

    1,00,000 × 18% × 45 / 365 = ₹2,219.18
    (paise: 1,00,00,000 × 18 × 45 ÷ 36,500 = 2,21,917.8 → 2,21,918)

**Example 2.** Same bill, ₹40,000 received on 31-May:

    segment (30-Apr, 31-May]: 31 days × ₹1,00,000
    segment (31-May, 14-Jun]: 14 days × ₹60,000
    interest = (1,00,00,000 × 31 + 60,00,000 × 14) × 18 ÷ 36,500 paise
             = 39,40,00,000 × 18 ÷ 36,500 = 1,94,301.4 → ₹1,943.01

With `graceDays: 15` interest runs from 15-May (30 days → ₹1,479.45); on the bill-date basis from
1-Apr (74 days → ₹3,649.32). A window `from: 1-Jun` charges only 1-Jun…14-Jun (14 days → ₹690.41).

### 3.4 FIFO for a non-bill-wise customer (credit days 15, as of 30-Sep)
Opening ₹3,000 Dr; 01-Jul INV-1 ₹4,000; 01-Aug INV-2 ₹6,000; 20-Aug receipt ₹9,000; 10-Sep INV-3 ₹2,500.
Balance ₹6,500 Dr = INV-3 ₹2,500 (due 25-Sep, 5 days overdue) + ₹4,000 of INV-2 (due 16-Aug, 45 days).

### 3.5 Reminders
A debtor is included when it has bills with pending > 0 overdue by ≥ `minOverdueDays` and

    amountDue = Σ those bills + unadjustedCredits > 0
    unadjustedCredits = Σ bills in the party's favour (advances, credit references) + On Account if Cr  (≤ 0)

so a customer whose unadjusted payments already cover the overdue bills is not chased. Example:
C-1 ₹1,23,456.78 overdue 100 days and ₹23,456.78 received on account → amountDue ₹1,00,000.00; the
letter lists C-1, explains the unadjusted ₹23,456.78 and asks for the net ₹1,00,000.00.
Tone from the oldest overdue bill: ≤ 30 days **gentle**, 31–60 **second**, > 60 **firm** (still polite;
asks for payment within 7 days). The letter is structured data (`from`, `to`, `subject`,
`salutation`, `opening`, `table`, `closing`, `signOff`) plus `text`, a ready plain-text rendering with a
fixed-width table; amounts in Indian format (`₹ 1,23,456.78`). Company contact details (phone/e-mail)
are quoted when present; the contact person is used in the salutation, else "Dear Sir/Madam,".

---

## 4. Performance
One query each for scope (ledgers + group tree), balances (`closingBalances`), bill aggregates
(GROUP BY ledger, bill with `HAVING SUM <> 0`) and, for FIFO, per-voucher entries. Measured in-memory
with 1,000 debtors, 40,000 invoices and 27,000 receipts: `bills` ≈ 400 ms, `partySummary` ≈ 250 ms,
`ageing` ≈ 270 ms, `interest` (full year, all bills incl. settled) ≈ 800 ms, `ledgerBills` / `statement`
≈ 5 ms.

## 5. Limitations
* Amounts here are base-currency paise. Bills of parties kept in a foreign currency are shown in both
  currencies (booked and closing rate, unrealised difference) by the forex module (`forex.outstanding`,
  `forex.ledger`; the party screen links to it with Alt+Y) — see src/core/modules/forex/README.md.
* Interest is `simple_365` only (no compounding, no 360-day year, no rate slabs or rate changes inside a
  period); interest on a bill-wise ledger's On Account remainder is not calculated.
* Bill names are matched exactly (case-sensitive), as stored by the posting engine.
* Reminder letters are English only.
