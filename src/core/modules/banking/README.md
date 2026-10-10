# Banking module: BRS, statement import, matching, cheque registers

Bank reconciliation the Tally way (bank dates on bank-ledger entries) plus what Tally lacks: importing the
bank's own statement, matching it automatically and creating vouchers for the lines the books do not have.
DTOs: `src/shared/types/banking.ts`. Money is integer **paise**; dates `'YYYY-MM-DD'`.

| File | Purpose |
|---|---|
| `routes.ts` | Route table + input schemas |
| `brs.ts` | BRS report, `setBankDates`, per-bank summary |
| `statements.ts` | Statement preview / import (dedupe, saved mapping), line listing, batches, batch delete |
| `parse.ts` | Bytes → table (CSV/TSV/XLSX) → header + mapping → lines, issues, balance check, hashes (pure) |
| `presets.ts` | Header normalisation, fuzzy captions, bank presets, header-row location (pure) |
| `values.ts` | Statement dates, amounts with Cr/Dr, references, tokens (pure) |
| `matcher.ts` | Deterministic scoring + one-to-one assignment (pure) |
| `matching.ts` | Auto-match, suggestions, manual match / unmatch / ignore |
| `create.ts` | Vouchers from statement lines through the vouchers service |
| `registers.ts` | Cheque register, post-dated cheques, deposit slip |
| `common.ts` | Bank ledgers, entry/line queries, link/unlink, permission helper |
| `testkit.ts` | Test helpers (company with HDFC + SBI OD, vouchers via `saveVoucher`) |

## 1. Routes

| Route | Access | Tx | Input → Output |
|---|---|---|---|
| `banking.brs` | reports.view | no | `BrsInput { ledgerId, asOf, show?, from? }` → `BrsResult` |
| `banking.setBankDates` | banking.reconcile | yes | `{ entries: [{ ledgerEntryId, bankDate \| null }] }` → `{ updated, unchanged, unmatchedLines }` |
| `banking.summary` | reports.view | no | `{ asOf }` → `BankSummaryRow[]` |
| `banking.statement.presets` | reports.view | no | – → `BankPresetInfo[]` |
| `banking.statement.preview` | banking.reconcile | no | `{ ledgerId, fileName, bytes, mapping?, sheet? }` → `StatementPreview` (no writes; `sheet` = auto-detect within that XLSX worksheet) |
| `banking.statement.import` | banking.reconcile | own | `{ ledgerId, fileName, bytes, mapping }` → `StatementImportResult` |
| `banking.statement.lines` | reports.view | no | `StatementLinesInput` → `{ rows, total, counts, totals }` |
| `banking.statement.batches` | reports.view | no | `{ ledgerId? }` → `StatementBatch[]` |
| `banking.statement.deleteBatch` | banking.reconcile | yes | `{ batchId, unmatch? }` → `DeleteBatchResult` |
| `banking.autoMatch` | banking.reconcile | yes | `{ ledgerId, batchId?, dateWindowDays? (7), threshold? (70), apply? (true) }` → `AutoMatchResult` |
| `banking.suggestions` | banking.reconcile | no | `{ lineId, dateWindowDays? (30) }` → `MatchCandidate[]` (≤ 10) |
| `banking.match` / `banking.unmatch` | banking.reconcile | yes | `{ lineId, ledgerEntryId }` / `{ lineId }` → `StatementLineView` |
| `banking.ignoreLine` | banking.reconcile | yes | `{ lineId, ignore }` → `StatementLineView` |
| `banking.createVoucher` | banking.reconcile + vouchers.create | yes | `CreateFromLineInput` → `CreateFromLineResult` |
| `banking.createVouchers` | banking.reconcile + vouchers.create | yes | `{ items, acknowledgeWarnings? }` → `CreateFromLineResult[]` (all or nothing) |
| `banking.chequeRegister` | reports.view | no | `{ ledgerId?, from, to, status?, direction? }` → `ChequeRegisterResult` |
| `banking.pdc` | reports.view | no | `{ asOf, ledgerId?, includeMatured? }` → `PdcResult` |
| `banking.depositSlip` | reports.view | no | `{ ledgerId, date }` → `DepositSlip` |

Every mutation is audited: `bank_reconciliation` (bank dates, auto-match; one entry per bank ledger),
`bank_statement` (import / delete), `bank_statement_line` (match, unmatch, ignore, voucher created), plus the
voucher's own audit from the vouchers service.

## 2. BRS semantics

An entry on a bank ledger is **reflected in the bank as of D** when `bank_date ≤ D`. With the books filter
(`affects_books = 1 AND (is_post_dated = 0 OR date <= today)`):

```
balanceAsPerBooks          = opening + Σ entries dated ≤ asOf
chequesIssuedNotPresented  = Σ |credits| dated ≤ asOf with bank_date NULL or > asOf      (add)
chequesDepositedNotCleared = Σ debits    dated ≤ asOf with bank_date NULL or > asOf      (subtract)
clearedBeforeVoucherDate   = Σ entries dated > asOf with bank_date ≤ asOf (signed)        (add)
balanceAsPerBank           = books + issued − deposited + clearedEarly
                           = opening + Σ entries with bank_date ≤ asOf
```

`statementBalance` is the running balance of the latest imported line dated ≤ asOf. The statement is compared
**on its own last date**: `balanceAsPerBankOnStatementDate = opening + Σ entries with bank_date ≤ statementDate`
(= `balanceAsPerBank` when the statement runs to asOf) and `difference = statementBalance −
balanceAsPerBankOnStatementDate` — bank dates entered for days after the statement do not show up as a
difference. `amountsNotInBooks` totals statement lines dated ≤ statementDate without a voucher (unmatched or
ignored) and `unexplainedDifference = difference − (deposits − withdrawals)` — 0 when the statement is fully
explained. `banking.summary` gives the same comparison per bank in `lastStatement.difference`.

**Worked example** (`brs.test.ts`): HDFC opening ₹1,00,000 Dr. Receipt 2-Apr ₹25,000 (bank 3-Apr), payment
3-Apr cheque 000501 ₹40,000 (bank 6-Apr), payment 20-Apr cheque 000502 ₹15,000 (not presented), receipt
28-Apr cheque ₹12,000 (not cleared), payment 27-Apr cheque dated 22-Apr ₹3,000 (bank 24-Apr). As of 30-Apr:
books 79,000; + 15,000 − 12,000 = **82,000** as per bank. Statement closing 81,410 → difference −590, the SMS
charges line without a voucher → unexplained 0. As of 25-Apr: books 70,000 + 15,000 − 3,000 (cleared before
its voucher date) = 82,000.

**Bank date rules** (`setBankDates`): bank ledger entries only; the voucher must be in the books today
(not optional/cancelled, post-dated only once due); `bankDate ≥` the voucher date, or the cheque date when it
is earlier; `bankDate ≤ today`; each entry once per call. Rows sent back unchanged are not re-validated (an
auto-match may legitimately sit up to 2 days before the voucher date). A statement line stays linked only while
the entry's bank date is the line's date: clearing the date, or moving it to another day, unmatches the line
(`unmatchedLines`). Voucher alteration keeps bank dates/matches for entries whose ledger and amount are unchanged
(vouchers service); delete/cancel unmatch.

**Period lock (follow-up).** A bank date on or before `config.lockedUpTo` belongs to a closed
reconciliation. Every path that changes a bank date — `setBankDates` (set / move / clear), `match`,
`unmatch`, `createVoucher(s)` (the new entry's bank date), `statement.deleteBatch { unmatch: true }`
(clears the dates) — calls `common.ts assertBankDateChangeAllowed(old, new)`: when the old **or** the new
date is in the locked period the user needs `period.lock` (Owners always) — the right to unlock, change
and re-lock — else `LOCKED` ("Books are locked up to …"), nothing changed. A cheque of a locked month
clearing in an open month (old none, new open) is allowed. `autoMatch` for a user without `period.lock`
leaves the statement lines dated in the locked period out (they stay unmatched). The voucher service
applies the same rule (`vouchers/service.ts assertLockedBankDatesKept`) when deleting, cancelling or
altering a voucher of the open period would clear a bank date in the locked period (a cheque dated
before the voucher, cleared before the lock date). Tests: `periodLock.test.ts`.

## 3. Statement import

1. **File**: `.xlsx` (zip signature), CSV/TSV/semicolon/pipe text (delimiter sniffed, alternatives tried when no
   header is found), UTF-8/UTF-16/Windows-1252. HTML or Excel-2003-XML files named `.xls`, old binary `.xls`
   and PDFs are refused with "Save As .xlsx / CSV" instructions. Max 20 MB / 200,000 rows.
2. **Layout**: given mapping → the ledger's saved mapping (columns remembered by caption + occurrence) → the
   most header-like row in the first 80 rows (≥ 3 recognised roles with date + money). A preset is chosen when
   ≥ 70 % of its signature captions are present (bank name of the ledger breaks ties), else captions are matched
   by meaning (`classifyHeader`).
3. **Presets**: SBI, HDFC, ICICI, Axis, Kotak (Amount + Dr/Cr, balance Dr/Cr), Yes Bank, PNB, Bank of Baroda,
   Canara, generic. `banking.statement.presets` lists captions and download hints.
4. **Values**: dates `dd/mm/yyyy`, `dd-mm-yy`, `dd.mm.yyyy`, `dd-MMM-yyyy`, `d MMM yyyy`, `yyyy-mm-dd`,
   `ddmmyyyy`, Excel serials, with times; day/month order detected (a first part > 12 proves dd/mm; Indian
   default dd/mm). Amounts with Indian grouping, `Cr`/`Dr` suffix or prefix, brackets, trailing minus, ₹/INR.
   Two columns (withdrawal/deposit), or one amount with a Dr/Cr column or suffix, or signed (`amountSign`).
5. **Rows**: separator, repeated heading, opening/closing/total rows, narration continuation rows (joined to the
   previous line), footers and unreadable rows are skipped with a reason (`issues`). Newest-first files are
   reversed. The running balance is checked (`balanceCheck.swappedLikely` flags swapped columns).
6. **Dedupe**: `line_hash = SHA-256(date|amount|reference key|description|balance|occurrence)` unique per bank
   ledger (reference key: letters/digits only, leading zeros dropped from all-digit references, so the CSV
   `000501` and the Excel number `501` are the same line); overlapping downloads import only the new lines (`duplicates` counts the rest; a fully duplicate file
   creates no batch). Import saves the mapping for the ledger (`bank_statement_presets`).
7. **Before the books begin**: lines dated before `company.books_from` are already in the bank ledger's opening
   balance — preview and import skip them with the reason "Dated before the books begin …" (summary counts are
   recomputed; the file's opening/closing balance and running-balance check stay as read). A file with only such
   lines is refused. The BRS also leaves any such line out of `amountsNotInBooks`.
8. **Wrong account**: an account number printed above the heading row ("Account Number : …", "A/C No. XXXX5678")
   whose last 4 digits differ from the ledger's account number gives `StatementPreview.accountWarning` (shown
   first on the import screen; the import is not blocked — the ledger may have no or an old number).

Statement amounts are from the **bank's view**: deposit `+`, withdrawal `−` — the same sign as the matching
entry on the bank ledger (a deposit is a debit to the bank in our books). Balances: `+` funds, `−` overdrawn.

## 4. Auto-match

Candidates: open entries of the ledger (in the books, not linked to a line) with the **same signed amount**,
statement date between (voucher or earlier cheque date − 2 days) and (voucher date + `dateWindowDays`); a cheque
whose number is in the statement may be up to 92 days late; an entry with a hand-entered bank date only matches
within ±2 days of it.

```
score = amount 50
      + date 25 − 3/day late (− 8/day early), ≥ 0
      + cheque/UTR/reference found 30 (last digits only 15)
      + party words in the narration up to 15 (share of significant words)
      + instrument kind agrees (NEFT/RTGS/IMPS/UPI/cheque/ATM/card) 5
      + bank date already entered: same day 20 / within 2 days 10            (shown capped at 100)
```

Pairs are taken by descending **uncapped** score (`rawScore`; ties: smaller day gap, earlier statement date,
lower line id, earlier voucher, lower entry id) **one-to-one**. A pair is applied only when `score ≥ threshold`
(70) and its uncapped score leads every competing pair for the same line or entry by ≥ 10 — so a receipt whose
UTR is in the narration (125) beats a same-day receipt from the same party without it (95) although both show
100; other lines become suggestions (`ambiguous` /
`low_score`, ≤ 3 candidates) or are counted in `withoutCandidates`. Applying sets
`ledger_entries.bank_date = txn_date`, line `status = 'matched'`, `match_method = 'auto'`. `apply: false`
is a dry run.

## 5. Vouchers from lines

`createVoucher { lineId, kind, contraLedgerId, narration?, voucherTypeId? }` posts through `saveVoucher`
(numbering, period lock, backdate permission, guards, audit):

| Line | kind | Posting |
|---|---|---|
| deposit | receipt | Dr bank / Cr contra ledger (not cash/bank) |
| deposit | contra | Dr bank / Cr cash or another bank |
| withdrawal | payment | Dr contra ledger / Cr bank |
| withdrawal | contra | Dr cash or another bank / Cr bank |

Date = statement date; narration = the statement description unless given; the bank line's instrument comes
from the narration (NEFT, UPI, cheque …) with the statement reference as its number. The entry gets the
statement date as bank date and the line becomes `created`. `createVouchers` runs all items in one
transaction: any failure rolls everything back ("Item 2 of 3: … Nothing was saved.").

**Duplicate guard.** Before posting, the line is checked against open book entries (in the books, not linked
to any line) with the same signed amount under the auto-match date rules (7-day window; cheques named in the
statement 92 days). If any exist, nothing is saved and the call fails with `BUSINESS_RULE` and details
`{ needsConfirmation: true, warnings: string[], possibleDuplicates: [{ lineId, candidates: MatchCandidate[] }] }`
— one warning per possible voucher (plus the voucher engine's own "confirm" warnings) — so the user matches the
line instead, or retries with `acknowledgeWarnings: true` to create it anyway. `createVouchers` checks every
item first and raises ONE confirmation listing all flagged items ("Item 1 (05-Apr-2026 withdrawal …): Payment 3
dated …"). Typical catch: a line unmatched after "voucher created", then created again.

## 6. Registers

- **Cheque register**: entries with instrument cheque/DD on bank ledgers in a period; `issued` (credit) or
  `received` (debit); status `cleared` (bank date), `post_dated` (not yet due) or `uncleared`; `stale` when
  uncleared more than 3 months after the cheque date.
- **PDC**: post-dated vouchers on bank ledgers dated after `asOf` (or all with `includeMatured`);
  receivable = Dr bank, payable = Cr bank; `daysToMaturity = date − asOf`.
- **Deposit slip**: cheques/DDs debited to the bank on the date + cash deposited (instrument cash, or the
  voucher credits a Cash-in-Hand ledger), totals and amount in words.

## 7. Tests

`node --test "src/core/modules/banking/**/*.test.ts"` — parsing for 9 bank layouts and edge cases
(`parse.test.ts`), the matcher (`matcher.test.ts`), BRS + bank dates (`brs.test.ts`), import / dedupe / batches
(`statements.test.ts`), matching against posted vouchers (`matching.test.ts`), vouchers from lines
(`create.test.ts`), registers (`registers.test.ts`). Vouchers are always posted through the vouchers service.

## 8. Screens (renderer, `src/renderer/modules/banking`)

- **Bank Overview** (`banking.summary`): Enter reconcile, Alt+I import statement, Alt+M match, Alt+Q cheque
  register, Alt+T post-dated cheques, Alt+C create a bank ledger (`accounts.ledger.form { groupCode: 'BANK_ACCOUNTS' }`,
  also from the "No bank accounts yet" empty state).
- **Match Bank Statement** (`banking.match`): Ctrl+1…4 tabs, Alt+M auto-match, Alt+V / Alt+B create vouchers,
  Alt+I ignore, Alt+U unmatch, Alt+C in a line's ledger picker creates a ledger with its group preselected
  (`lib/matchReview.ts newLedgerGroupFor`: contra → Bank Accounts, bank interest credited → Indirect Incomes, other deposit → Sundry Debtors, bank charges /
  fees → Indirect Expenses, other withdrawals → Sundry Creditors), **Alt+D delete the chosen imported statement** (`banking.statement.deleteBatch`):
  the confirmation names the file, its lines and how many are reconciled, and offers "Also unmatch" when some
  are (`lib/batches.ts`). Lines are de-duplicated per bank, so this is how a statement imported into the wrong
  bank or with the wrong columns is imported again.
