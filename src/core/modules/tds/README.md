# tds — TDS / TCS (core)

Tax deducted at source on what the business pays (Income-tax Act 1961 Chapter XVII-B) and tax
collected at source on what it sells (s.206C), from the voucher to the quarterly statement.
Everything is gated by F11: **TDS** (`features.tds`) and **TCS** (`features.tcs`). With both off the
voucher hook is a no-op and every `tds.*` route (except `tds.voucher`, which answers empty) refuses
with "turn it on in F11".

Renderer: `src/renderer/modules/tds` (README there). Shared: `src/shared/types/tds.ts` (DTOs),
`src/shared/tds/rules.ts` (PAN/TAN, income-tax year, due dates, interest, s.234E).

## Files

| File | What |
|---|---|
| `src/core/db/migrations/160_tds.ts` | Schema + seed (version 160, block 160–169) and the new permissions for existing companies' system roles |
| `src/core/db/migrations/161_tds_advances.ts` | `tds_lines.advance_adjusted` (advance set-off) and the 2% timber / forest produce TCS row from 1-Oct-2024 |
| `store.ts` | Rows, `TdsStore` (per-call cache: natures, dated rates, ledger details, deductee facts), settings (`settings` key `tds`), duty ledgers created on demand |
| `engine.ts` | Pure computation for one deductee + nature on one voucher (`computeTds`, `rateFor`) |
| `hook.ts` | Voucher hook (vouchers/hooks.ts extension point): computes, posts the auto-lines, rebuilds `tds_lines` / `tds_challans` |
| `masters.ts` | Natures (dated rates), ledger TDS details, setup, statement filing status — all audited |
| `filed.ts` | Statements marked filed protect their quarter: a save that changes what was reported needs confirmation; delete / cancel refused (hook `adjust` / `beforeRemove`) |
| `challan.ts` | Challan helper: builds and saves the Payment voucher through `saveVoucher` |
| `reports.ts` | Computation, lines, outstanding (+ interest, statements, s.234E), challan register, return data, exceptions, one voucher |
| `returnCsv.ts` | 26Q / 27Q / 27EQ deductee + challan CSV files |
| `receivable.ts` | Form 26AS / AIS CSV import and the TDS-receivable reconciliation |
| `routes.ts` / `schemas.ts` | Routes and input schemas (`VoucherInput.tds` is validated by vouchers/routes.ts with `VoucherTdsInputSchema`) |
| `*.test.ts`, `testkit.ts` | Engine, hook, reports and an end-to-end flow through `runtime.dispatch` |

## Tables (migration 160)

| Table | Kind | Notes |
|---|---|---|
| `tds_natures` | master | Nature of payment (TDS) / nature of goods (TCS): name, 1961-Act section, Income-tax Act 2025 reference, non-resident flag, system/active |
| `tds_nature_rates` | master | Effective-dated rows: rates for individual/HUF, company, others, no-PAN; single and aggregate thresholds; aggregate per FY or per month; tax on whole vs excess; base incl. GST |
| `tds_ledger_details` | master | Per ledger: applicable + nature (expense / sales), deductee type, non-resident, s.197 certificate (no., rate, validity, limit, nature), deductor TAN (customer), and the marks of the duty / receivable ledgers the module created. PAN stays in `ledgers.pan` |
| `tds_lines` | derived | One row per nature computed on a voucher — rebuilt on save/alter, removed on cancel/delete (hook `clear`); carries `date`, `affects_books`, `is_post_dated` like `gst_lines`; `advance_adjusted` (161) = part of a bill set off against an earlier taxed advance |
| `tds_challans` | derived | Challan details of a Payment voucher (`VoucherInput.tds.challan`), rebuilt with the voucher |
| `tds_statements` | master | Filing date + token of each quarterly statement (stops the s.234E fee) |
| `tds_26as` | import | Form 26AS / AIS rows of a year (replaced on re-import) |

The ledger master's own `tds_applicable` / `tds_section` columns (Ledger form › Other settings) are
kept in step when TDS details are saved; the computation reads only `tds_ledger_details`.

Indexes that keep saves and reports to the rows they need (final wave, migration 241 and
vouchers/perf-hooks.test.ts): the reports read a period of `tds_lines` through
`idx_tds_lines_kind_date (kind, date)` — with no kind given the loader asks for `kind IN ('tds',
'tcs')`, still one index range — instead of every line of the kind since the books began; the hook
reads a bill's own TDS line by `idx_tds_lines_voucher` (it used to walk every line of the section);
the duty-ledger look-up names `payable_kind IN ('tds', 'tcs')` so the partial unique index
`idx_tds_ledger_payable` answers it.

## Posting (hook.ts)

- **TDS** (purchase in any invoice mode, journal and payment in ledger mode). Assessable lines are
  those posted to ledgers whose TDS details are *applicable*; invoice modes take the line's taxable
  value — GST excluded (CBDT Circular 23/2017) unless the rate row says the base includes GST. The
  nature is the ledger's, else the party's default nature, else `input.tds.natureId`. With no
  applicable line, `input.tds.natureId` deducts on the party's amount (payment = advance: the party is
  debited gross; journal: the party's credit).
- The **deductee** is the invoice party; in ledger mode the single party line on the credited side
  (payment: debited side) — a debtor / creditor, or any other ledger given a deductee type (a
  partner's capital account for 194T, an unsecured loan for 194A). Two parties → no guess (confirm
  warning, nothing deducted). A party's own details (default nature) never make it an expense line: a
  transfer between two parties is not taxed.
- **Exempt party**: a party whose details say "TDS / TCS does not apply" (s.196, a transporter's
  s.194C(6) declaration, …) gets nothing computed (info warning). A party without details is a
  deductee by default.
- Entries: `Cr TDS Payable – <section>` (Duties & Taxes, created on save — preview says it will be);
  purchase/journal → the party credit is reduced; payment → the bank credit is reduced. Bill-wise and
  cost allocations typed for the gross are rescaled to the net (vouchers' `adjustEntry`).
- **TCS** (sales invoices): lines on sales ledgers with a TCS nature; `Dr party += TCS`,
  `Cr TCS Payable`, and the invoice value includes it (`addToInvoiceValue`).
- **Overrides** (`input.tds.overrides`: nature, amount, reason) replace the computed amount; the
  computed amount is kept on the line (`computed`) so exceptions can show what changed.
- **Typed by hand**: a credit the user typed to the nature's duty ledger (e.g. a journal Dr expense /
  Cr party net / Cr TDS Payable – 194C) *is* the deduction — it is not posted again; the line records
  that amount (as a change, reason "Entered by hand", when it differs from the computed one). A typed
  credit with nothing TDS-applicable on the voucher asks for confirmation (it would be missing from
  the reports).
- **Advances**: a Payment with a nature (`input.tds.natureId`) is an advance. A later bill / journal
  credit of the party under the same nature is set off against advances *on which tax was deducted*
  (any earlier date; each advance once): the set-off part (`advance_adjusted`) is left out of the base
  and of the aggregate (it was counted when paid), while the single-transaction limit is still tested
  on the whole bill (194C: ₹80,000 bill after a ₹50,000 taxed advance → tax on ₹30,000).
- **Debit / credit notes** (final wave): a debit note to a supplier (TDS) or a credit note to a customer
  (TCS), in an invoice mode, against a bill whose tax was deducted / collected reverses that tax **in
  proportion** — the note's taxable value ÷ the bill's, per nature, never more than what is left of the
  bill's tax after earlier notes (rounded to the rupee when the setting says so). The bill is the one the
  note's bill-wise "Against" names, else the original invoice number (purchase: the supplier's invoice
  number). Posting: `Dr <duty ledger>`; the supplier is debited that much less (TDS) / the customer
  credited that much more (TCS, and the note's value includes it). A reversal typed by hand (Dr the duty
  ledger) is taken as it is. The note's `tds_lines` row is negative and carries the bill
  (`bill_voucher_id`, migration 240); the outstanding report and the quarterly statement **net** it into
  the bill's deduction (`netReversals`; a reversal whose bill is in an earlier, already reported quarter
  is not netted there — the excess deposit stays on the challan, as on TRACES).
- **TDS journal on a bill booked gross** (final wave): a Journal `Dr <party> / Cr TDS Payable – <section>`
  with nothing TDS-applicable on it is the deduction on that bill: the party is the one party debited,
  the bill the one its bill-wise "Against" names. The line takes the nature of the party's default
  nature of that section, else the bill's line of that section, else the first active nature of the
  section; its base is the bill's TDS line (whose assessable was already counted — the journal adds
  nothing to the thresholds and clears a below-threshold amount through `catch_up`), else the bill's
  taxable value, else the tax grossed up at the rate in force. It is in every TDS report and the
  statement (info warning, no confirmation).
- **194T** is deducted only when the deductor category (TDS/TCS › Setup) is **firm** (partnership firm
  or LLP paying its partners); any other deductor gets an info warning and nothing under 194T.
- **s.195 on a foreign-currency bill** (with the forex module): the tax is computed in rupees on the
  bill's rupee value at the voucher's rate; the supplier's foreign amount follows its rupees (forex
  hook), and bill-wise amounts typed in the currency for the gross are reduced in the same proportion,
  so the bill holds the net in both currencies and a later payment of that net settles it exactly (any
  difference of rate is the realised exchange gain / loss) — tested in `gaps.test.ts`.
- **Feature turned off**: altering a voucher that carries TDS / TCS while the feature is now off asks
  for confirmation before the tax is dropped.
- Every derived row honours `affects_books` and `is_post_dated`; optional / cancelled vouchers never
  count in thresholds or reports.

## Computation (engine.ts)

- Rate: by deductee type (individual/HUF, company, others = firm/LLP/AOP/…); without a valid PAN the
  higher of that rate and the nature's no-PAN rate (s.206AA / s.206CC). Deductee type defaults from
  the PAN's 4th letter when not set on the ledger.
- Threshold: liable when the single amount exceeds `thresholdSingle`, or the party's aggregate under
  the nature in the FY (calendar month for rent from 1-Apr-2025) exceeds `thresholdAggregate`; on
  crossing, earlier credits below the threshold are taken in (`catch_up`). 194Q taxes only the excess
  over ₹50 lakh and only when Setup › "buyer above ₹10 crore" is on.
- Lower / nil certificate (s.197 / s.206C(9)) valid on the date: its rate up to its unused limit.
- Rounded to the nearest rupee (common practice; statements carry whole rupees) unless Setup turns it
  off. (s.288B's rounding to ₹10 is read as applying to tax payable on assessment, not to each
  deduction — check with your adviser if you read it otherwise.)

## Deposits, interest and statements (reports.ts, shared/tds/rules.ts)

- A challan pays the deductions of its kind + section + month, oldest first (no stored links, so
  alters and deletions never leave stale ones). Reports of a period load only from the start of its
  first month (the clearing pools are per month), the outstanding report only the taxed lines. The same
  challan (BSR code + deposit date + serial = CIN) recorded on a second voucher asks for confirmation. Due: 7th of the next month; TDS of March by 30 April
  (Rule 30); TCS by the 7th, March included (Rule 37CA).
- The challan suggestion (`tds.challan.suggest`) nets a debit / credit note reversal into its bill exactly
  as the outstanding report and the statement do (`netReversals`), counting notes dated up to the
  deposit date — so the challan never over-deposits the reversed part and TDS Payable squares off
  (final wave, found by the cross-feature tie-out; `challanNet.test.ts`).
- Interest: s.201(1A)(ii) 1.5% / s.206C(7) 1% per month or part from deduction to payment when paid
  late; s.201(1A)(i) 1% from the date deductible to the date deducted (exceptions). Months are counted
  as calendar months, both ends included; interest rounded to the rupee.
- Statements: 26Q / 27Q due 31 Jul, 31 Oct, 31 Jan, 31 May (Rule 31A); 27EQ 15 Jul, 15 Oct, 15 Jan,
  15 May (Rule 31AA). s.234E: ₹200 per day, capped at the tax of the statement.
- Filed statements (`filed.ts`, security review): once `tds.statement.save` records a filing date, a
  voucher save that changes what the quarter's Form 26Q / 27Q / 27EQ reported — a deductee row (section,
  party, amount, base, status, date; lines with tax or a certificate) or a challan (identification and
  amounts) — raises a `confirm` warning ("file a correction statement"); a new deduction dated in the
  filed quarter asks too. Deleting / cancelling a voucher that the filed statement reported is refused
  (`beforeRemove`) until the filing record is removed (`filedOn: null`, audited). A TDS challan counts
  for both 26Q and 27Q of its month's quarter. Nothing is looked at while no statement is marked filed.

## Routes

| Route | Access | Notes |
|---|---|---|
| `tds.settings.get` / `.save` | tds.view / tds.manage | TAN (blank → company TAN), deductor category, person responsible, 194Q buyer, rounding |
| `tds.natures.list` | vouchers.view | Voucher entry offers natures for advances |
| `tds.natures.get` / `.save` / `.delete` | tds.view / tds.manage | System natures cannot be deleted; a nature used on vouchers keeps its section |
| `tds.ledgers.list` / `.get` / `.save` | tds.view / tds.manage | PAN validated; nature kind must match the ledger role |
| `tds.receivableLedger.ensure` | tds.manage | Creates/adopts 'TDS Receivable' (Loans & Advances (Asset)) |
| `tds.computation`, `tds.lines`, `tds.outstanding`, `tds.challans`, `tds.exceptions` | tds.view | Read-only (`transactional: false`) |
| `tds.voucher` | vouchers.view | Lines / challan of one voucher (voucher view panel) |
| `tds.challan.suggest` / `.get` | tds.view | Unpaid tax + interest to the deposit date |
| `tds.challan.save` | tds.view + voucher create/alter (checked by `saveVoucher`) | Payment voucher with `tds.challan` |
| `tds.return.data` | tds.view | 26Q / 27Q / 27EQ rows of a quarter |
| `tds.return.export` | tds.file | CSV (audited `export`) |
| `tds.statement.save` | tds.file | Filing date + token (audited) |
| `tds.receivable`, `tds.26as.import` | tds.view / tds.manage | 26AS CSV import is audited |

Permissions (`src/shared/constants.ts`): `tds.view` (Accountant, Auditor), `tds.manage` and
`tds.file` (Accountant); Owner/Administrator hold all permissions.

## Seed and legal assumptions (verify before relying on them)

Seeded natures (all user-editable; add a dated rate row when the law changes, never overwrite):
194C, 194H, 194I(a), 194I(b), 194J(a), 194J(b), 194A, 194Q, 194R, 194T (from 1-Apr-2025), 195, and
TCS 206C(1) (scrap, liquor, minerals, tendu leaves, timber / forest produce) and 206C(1F) (motor
vehicles above ₹10 lakh), with the Finance (No. 2) Act 2024 and Finance Act 2025 changes dated
(194H 2% from 1-Oct-2024; TCS on timber / other forest produce 2% from 1-Oct-2024, migration 161;
thresholds raised from 1-Apr-2025: 194H ₹20,000, 194I ₹50,000 per month, 194J ₹50,000, 194A ₹10,000
for non-bank payers). Salary (192) is out of scope.

- **195** is a placeholder at 20%: the rate depends on the income, the DTAA, surcharge and cess — set
  it per remittance (override) or keep a certificate.
- **Income-tax Act 2025** (in force 1-Apr-2026, "tax year"): TDS/TCS are consolidated in ss.393/394
  with tables. Only the parent section is stored (`section_2025` = 393 / 394) — the table serial
  numbers are NOT seeded, and returns keep the 1961 section codes. Rates and thresholds for tax year
  2026-27 are assumed unchanged from FY 2025-26 (no new rate rows): check them against the Finance Act
  2026 and the rules notified under the 2025 Act and add dated rows if they differ.
- **206C(1F)**: the seed takes the base including GST (common practice); the ₹10 lakh test is on that
  value — on the invoice's value under the nature, not per vehicle (enter one vehicle per invoice, or
  override), and at the sale (the section speaks of receipt of consideration; conventional software computes on the
  invoice too). Change "Base includes GST" on the nature if your advisor reads it otherwise. Luxury goods
  notified from 22-Apr-2025 need a nature of their own.
- **206C(1H)** (TCS on sale of goods) was omitted from 1-Apr-2025 and is not seeded; 206AB/206CCA
  (non-filers) were omitted from 1-Apr-2025 and are not modelled.
- **194Q**: buyer turnover test (> ₹10 crore in the preceding year) is a Setup switch; tax on
  purchases above ₹50 lakh from a seller in the year, excluding GST (CBDT Circular 13/2021).

## Quarterly statement files — what they are and are not

`tds.return.export` writes two CSV files per statement (deductee / collectee rows and challan rows)
under plain headings carrying every field the return preparation utility (RPU) deductee and challan
sheets ask for: challan serial, BSR code, deposit date, challan serial no., section, deductee code
(01 company / 02 other), PAN (`PANNOTAVBL` when missing), name, payment date, amount, tax, deposited,
deduction date, rate, reason code (A = s.197 certificate, C = higher rate for no PAN), certificate no.

They are **not** the NSDL/Protean FVU text file and do **not** reproduce the RPU sheet column order:
that order has changed between RPU versions and is not reproduced with certainty. Copy the columns
into the RPU (or hand the files to a tax practitioner) and validate with the current FVU.

## Form 26AS / AIS import

TRACES downloads are text / PDF / JSON whose layouts change, so the import takes a CSV the user
prepares from Form 26AS Part I / AIS with a header row naming the columns (accepted names in
`FORM26AS_COLUMNS`): TAN of deductor, Name of deductor, Section, Transaction date, Amount
paid/credited, Tax deducted. Dates `DD-MM-YYYY`, `DD/MM/YYYY`, `DD-Mon-YYYY` or ISO. Rows outside the
year are skipped; a re-import replaces the year. Matching: customer's deductor TAN, else name.

## Known gaps

- No FVU text file generation and no Form 16A / 27D certificates (TRACES issues them).
- No salary TDS (192 / Form 24Q) — there is no payroll.
- Surcharge and cess are only entered on challans (non-resident rates are set per nature / override).
- A statement correction (revised return) is not tracked beyond the filing date and token (the filed-quarter
  confirmation only tells the user one is needed).
- Interest on short deduction is an estimate (to the as-of date), shown in exceptions only.
- Debit / credit notes reverse TDS / TCS in proportion in the invoice modes only; a note in ledger mode,
  or one without a bill-wise "Against" or original invoice number, reverses nothing (alter the bill or
  override its tax with a reason). The reversal assumes the note returns every nature of the bill in
  the same proportion.
- An advance below the threshold (nothing deducted) is not set off against the later bill; both count
  in the year's aggregate.
