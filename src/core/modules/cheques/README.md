# Cheques module (`cheques`) — payee bank details, cheque books, cheque printing, e-payment files

Print group. Core: this folder; DTOs `src/shared/types/cheques.ts`; renderer
`src/renderer/modules/cheques`; schema `src/core/db/migrations/170_cheques.ts` (block 170–179).

Payee bank details and e-payment files always work. Cheque books, the leaf register, layouts and
cheque printing need **F11 › Cheque printing** (`features.chequePrinting`); their routes refuse with
a BUSINESS_RULE naming F11 otherwise.

## Tables (migration 170, additive)

| Table | What |
|---|---|
| `payee_bank_details` | one row per ledger: beneficiary name, A/c no., IFSC, bank, branch, account type, name on cheque, preferred mode (NEFT / RTGS / IMPS / cheque). Removed with the ledger (trigger), never blocks a ledger delete. |
| `cheque_books` | leaf ranges per bank ledger (`from_no`–`to_no`, `digits` for zero padding, active flag). Ranges of one bank never overlap. |
| `cheque_leaf_marks` | leaves cancelled by the user (reason, date) or cancelled with their voucher. Cancelling / re-opening a leaf dated in the locked period (F12) is refused (`LOCKED`, `lock.test.ts`). |
| `cheque_prints` | every cheque printed (voucher, line, leaf, payee, amount, layout, user, time). |
| `cheque_layouts` | named layouts: positions in mm as JSON (`ChequeLayoutSpec`), optional preset code. |
| `cheque_bank_settings` | per bank ledger: layout, 'A/c Payee' by default, signatory text. |
| `epayment_batches` / `epayment_batch_items` | every bulk payment file made (re-export warning). |

**Issued leaves are not stored**: a leaf is issued when a Payment / Contra credits the bank with
instrument type `cheque` and that number (`ledger_entries.instrument_*`). The books stay the single
source; the register derives everything.

## Posting integration (`hook.ts`, vouchers/hooks.ts extension point)

No posting logic is duplicated. The hook is a no-op unless the feature is on and the voucher is a
Payment or Contra.

- **compose** — a bank credit line paid by cheque **without a number** gets the next unused leaf of
  the bank's active books (lowest number, book order), inside the save transaction (two vouchers can
  never get the same leaf); numbers typed on other lines of the same voucher are skipped. The voucher
  preview shows the number it would get.
- **adjust** — confirm-level warnings: leaf already issued on another voucher, used twice in the
  voucher, cancelled, or spoilt; info when the number is in no book or every leaf is used.
- Cost per save: allocation and checks read the bank's cheque numbers once (`issuedLeaves`) plus its
  marks and prints. Since migration 241 the bank's cheque lines come from the partial covering index
  `idx_le_cheques (ledger_id, instrument_no, voucher_id, amount) WHERE instrument_type = 'cheque'`
  (pinned with `INDEXED BY` in `issuedLeaves` / `issuedCheques`), so the cost follows the cheques
  issued, not every receipt / NEFT on the bank: a cheque payment on a 60,000-voucher company went from
  ≈ 10 ms (two reads of ≈ 18,000 bank entries) to ≈ 2 ms (vouchers/perf-hooks.test.ts).
- **beforeRemove** — cancelling a voucher marks its leaves cancelled (a written leaf cannot be
  reused); deleting a voucher frees its leaves unless they were printed (then they are *spoilt*).

## Register (`register.ts`)

Per bank, as on a date (`asOf`, default today): every leaf of its books plus cheques issued outside
any book, each **unused**, **issued** (post-dated flagged when the cheque date is after `asOf`),
**cleared** (BRS bank date on or before `asOf` — `banking.brs`; a cheque the bank cleared later is
still issued on that date), **stale** or **cancelled** (by the user, with the voucher, or spoilt by a
print). Totals: leaves by status, issued amount (every leaf written, optional and post-dated vouchers
included) and the **uncleared amount, which ties to the BRS's "cheques issued but not presented"**:
cheques in the books (not optional), dated on or before `asOf`, without a bank date by then. The
payee of every cheque comes from one windowed query (no per-voucher look-up).

**Stale**: not cleared and the cheque date is more than 3 months before `asOf` (RBI circular of
4 November 2011: cheques, drafts, pay orders and banker's cheques are payable for three months from
their date, instead of six, from 1 April 2012). A cheque dated 15-05-2026 is still
valid on 15-08-2026 and stale from 16-08-2026 (`CHEQUE_VALIDITY_MONTHS` in banking/registers.ts,
shared with the banking cheque register).

## Layouts (`layouts.ts`)

`ChequeLayoutSpec`: leaf `widthMm × heightMm`, `fontPt`, positions `{ x, y, w? }` in mm from the
leaf's top-left corner for the date (eight boxes D D M M Y Y Y Y, `pitch` mm apart), payee, amount in
words (two lines), amount in figures, 'A/c Payee' crossing and signatory; calibration shift
`offsetX / offsetY`; `placement` (`leaf` = a page the size of the leaf; `a4_left` / `a4_center` = the
leaf held on an A4 sheet); `figuresPaise`.

Validation (`layoutIssues`): leaf 150–230 × 70–110 mm, font 7–16 pt, shift ±30 mm, date pitch 3–8 mm,
every field inside the leaf and **above the MICR band** (the bottom 16 mm, 5/8 inch, of a CTS-2010
leaf must stay clear for the MICR code line). The check uses the bottom of what prints, not the top
edge (`fieldBottomMm`): one line of text is one font size tall, the crossing adds its rules, and the
signatory's "Authorised Signatory" line prints `CHEQUE_SIGN_LINE_GAP_MM` (10 mm) below "For <company>"
(shared/types/cheques.ts, used by the renderer too). A layout stored under an older rule keeps its
calibrated positions (only a damaged one falls back to the preset) and the print data warns.

Presets (starting points, not bank-certified positions): `cts2010` (202 × 92 mm, CTS-2010 standard
leaf dimensions), `cts2010_wide_date` (5.3 mm date boxes), `cts2010_a4` (on A4, centred). The exact
positions of printed boxes differ between banks' personalised leaves, so users calibrate: print the
calibration grid (renderer, Alt+K) on plain paper, hold it against a leaf, and adjust positions or
the shift. A bank with no layout prints with `cts2010`.

## Printing (`printData.ts`)

`cheques.print.data` → one `ChequePrintItem` per bank credit with instrument `cheque` (bulk: up to
200 vouchers):

- payee: the instrument's *favouring* when typed; a Contra is a **self** cheque ('Self', never
  crossed); a Payment pays its largest non cash / bank debit — the payee's *name on cheque*, else the
  beneficiary name, else the ledger's mailing name, else its name;
- date boxes `DDMMYYYY` from the instrument date (else the voucher date);
- amount in words in the Indian system (lakh, crore) with paise and "Only", without a leading
  "Rupees" (printed on the leaf): ₹1,23,456.78 → *One Lakh Twenty Three Thousand Four Hundred Fifty
  Six and Seventy Eight Paise Only*;
- figures with guards against alteration: `**1,23,456.78/-` (`**1,23,456/-` when the layout drops
  paise and there are none);
- 'A/c Payee' from the bank setting (the user can switch it per cheque; never on self cheques);
- warnings (never blocking): post-dated, stale, already printed, cheque without a number, a layout
  that breaks the placement rules.

`cheques.print.record` writes `cheque_prints` and the edit log (`export`) **before** the renderer
sends the page to the printer; it needs `data.export` (printing a cheque is an export of the books).

## E-payments (`epayment.ts`)

`cheques.epayment.list` lists Payments of a period (regular vouchers: cancelled and optional ones never
go into a payment file) whose bank line is NEFT / RTGS / IMPS or has no
instrument (cheque, DD, UPI, card and cash never go in a file). Mode: the voucher's instrument, else
the payee's preferred mode, else RTGS from ₹2,00,000 and NEFT below. Each row names its problem, if
any: no payee, several payees (one row = one beneficiary), no A/c no. or IFSC, RTGS below ₹2 lakh
(RBI minimum), IMPS above ₹5 lakh (RBI per-transaction limit since October 2021), zero amount.

`cheques.epayment.export` builds Pevqori's **generic CSV** — not any bank's proprietary template:

```
Sl No, Payment Mode, Amount, Value Date, Beneficiary Name, Beneficiary Account No, Beneficiary IFSC,
Beneficiary Bank, Beneficiary Account Type, Debit Account No, Debit Bank Ledger, Remarks, Voucher No,
Voucher Date, Beneficiary E-mail, Beneficiary Mobile
```

Amount in rupees with two decimals, dates `DD/MM/YYYY`, value date = the given one, else the voucher
date, never before today. Names and remarks are reduced to letters, digits and `.,/&()-` (bank
upload validators reject other characters). Banks' corporate portals each have their own upload
layout; most let you map columns of a CSV on upload, or the columns are rearranged once in a
spreadsheet. Every file is recorded (`epayment_batches`) and in the edit log; rows already in a file
show when, and the renderer asks before putting them in another (paying twice). The batch is recorded
when the file is built; if the save dialog is cancelled or the write fails, the renderer calls
`cheques.epayment.discard { batchId }` (same user, same day only) so the payments are not flagged as
"already in a file" — the export and its discard both stay in the edit log. Payee details are read
once per payee ledger. Account numbers with leading zeros are kept as text in the CSV; opening and
re-saving the file in Excel can drop them — upload the file as Pevqori wrote it.

## Routes

See the header of `src/shared/types/cheques.ts` (route → DTO → permission). Reads are
`transactional: false`; every write is audited (`ctx.audit`). Permissions: payee details
`masters.view` / `masters.alter`; books `masters.view` at the route plus `masters.create` / `alter` in
the service (like ledgers), `masters.delete`; leaf cancel / restore
`vouchers.alter`; register `reports.view`; layouts and bank settings `masters.alter`; print data
`vouchers.view`; print record, e-payment export and discard `data.export`.

## IFSC

`validateIfsc` (shared/validators.ts): 11 characters — 4 letters (bank), `0` (reserved), 6 letters
or digits (branch), stored upper case.

## Tests

`books.test.ts`, `payees.test.ts`, `print.test.ts`, `epayment.test.ts` (services against a real
in-memory company), `review.test.ts` (regressions from the adversarial review: optional payments,
discarded batches, register as on a date and its BRS tie-out, query count, MICR text height, stored
layouts, bank contacts never used as share recipients), `e2e.test.ts` (route dispatcher, permissions), `runtime.e2e.test.ts` (the whole
flow through `runtime.dispatch`, with sharing and the Trial Balance).

## Known gaps

- Presets are generic CTS-2010 positions; no bank-specific presets are shipped (positions of the
  printed boxes are not standardised beyond the leaf size and the MICR band) — calibrate once per bank.
- The e-payment file is a generic CSV; bank-specific formats (fixed-width / H2H) are not produced.
- Some printer drivers ignore a custom paper size; print on A4 (`a4_left` / `a4_center`) with the leaf
  held in place, or set the paper size in the printer dialog.
