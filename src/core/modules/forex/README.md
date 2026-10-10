# Forex module (`forex`) — multi-currency vouchers, bills, exchange gain / loss, revaluation, export invoices

Owner: forex group. Renderer: `src/renderer/modules/forex` (screens, voucher-entry dialogs, voucher
view panel, print block). Shared: `src/shared/forex.ts` (rounding, conversion, formatting, rate-type
rules — pure, tested in `forex.test.ts`) and `src/shared/types/forex.ts` (DTOs). Migration
`230_forex.ts` (block 230–239). Everything needs **F11 › Multiple currencies** (`features.multiCurrency`);
with the feature off every route except `forex.context` refuses, and a voucher carrying any forex field
is refused with a field error that says how to turn it on.

## 1. Model

* **Books stay in rupees.** Every `ledger_entries.amount` is INR paise, Dr + / Cr −, Σ = 0 per voucher
  (unchanged contract). A ledger whose master has a foreign `currency_id` is *also* tracked in that
  currency: each of its entries stores `currency_id`, `forex_amount` (signed like `amount`, major unit,
  rounded to the currency's decimal places) and `exchange_rate` (rupees per unit, ≤ 6 decimals).
* `amount = round(forex × rate)` to the paisa (`forexToPaise`, exact decimal arithmetic) — except when
  the entry settles bills booked at another rate (realised difference, §3).
* A foreign-ledger entry with `forex_amount = 0` is an **INR-only exchange adjustment** (revaluation,
  correction); its rupees are taken as typed.
* Bills: `bill_allocations.forex_amount / currency_id` carry each bill in both currencies; the opening
  balance in the currency is `ledgers.opening_forex_amount` and `opening_bills.forex_amount`.
* Document currency of an invoice: `vouchers.currency_id / exchange_rate / forex_amount` (unsigned
  document value in the currency, what the party owes).
* `forex_revaluations` records each "Forex adjustment" journal posted by the revaluation helper (as-of
  date, rate type, rates JSON); CASCADE with the voucher.
* The currency of a ledger cannot be changed once vouchers record it in that currency
  (`accounts/ledgerRules.ts`); create a new ledger instead (Tally behaves the same way).

## 2. Voucher integration (vouchers/hooks.ts extension point — `hook.ts`)

Posting stays in the vouchers module; the forex hook only transforms the input and the plan, inside the
same transaction, so every derived row honours `affects_books` / `is_post_dated` like `gst_lines`.

| Stage | What it does |
|---|---|
| `compose` (preview + save) | **Invoice modes** with `VoucherInput.forex {currencyId, rate, rateType?}`: required when the party is kept in a foreign currency and must be that currency; refused for a rupee party. Item `forexRate` (default: the typed `rate`, then in the currency) × qty → amount in the currency → INR at the rate; ledger lines' `forexAmount` → INR. Rates are exclusive of GST (`rateInclusiveOfTax` cleared). INR round-off is not applied to a foreign-currency invoice. `exportDetails.currency / exchangeRate` are filled from the voucher. **Ledger mode**: every line of a foreign ledger must carry `forexAmount` (0 = INR-only adjustment); rate = line `exchangeRate`, else `VoucherInput.forex.rate` of the same currency, else the master rate of the voucher date (§4). |
| `prepare` (save) | Creates the system ledger **Forex Gain/Loss** (Indirect Expenses, `reserved_code FOREX_GAIN_LOSS`) when needed. It is also created when F11 › Multiple currencies is switched on. |
| `adjust` (preview + save) | Puts the foreign side on each foreign entry (invoice party: Σ lines in the currency + the INR remainder — GST / TCS payable by the party — converted at the rate). For bill-wise entries settling bills (`against`) that carry a foreign amount, the bill is settled at the INR it is **carried at** (`bookedPaise`, pro rata for part settlement); the difference to the voucher's rate is the **realised exchange gain / loss**, posted in the same voucher to the configured ledger (Dr = loss, Cr = gain). Σ = 0 holds. If TDS changed a line's rupees, its foreign amount follows in proportion (info warning). |
| `write` | Stores currency / forex amount / rate on `ledger_entries`, `bill_allocations` and `vouchers`. |
| `clear` | Clears the voucher header columns on alter / delete (child rows are rewritten by the vouchers module). |

Bill-wise amounts may be typed in the currency (`billAllocations[].forexAmount`, magnitude); if not,
they are taken in proportion to the rupees (info warning). A mismatch between bill-wise foreign
amounts and the line is a blocking warning.

## 3. Realised and unrealised differences (AS 11 / Ind AS 21)

* **Realised** (settlement at another rate than booked): posted automatically by the voucher that
  settles the bill (§2). Settings › realised ledger (default the system ledger).
* **Unrealised** (period end): `forex.revaluation.report {asOf, rateType?, rates?}` restates every
  foreign-currency balance (per pending bill for bill-wise ledgers, plus any remainder; one line per
  ledger otherwise) at the **closing rate** of the exchange-rate master (rate column from settings,
  default standard) or a rate typed for the run (`rates`, e.g. the RBI reference / FEDAI rate).
  `forex.revaluation.post` posts the **Forex adjustment** journal: each ledger Dr / Cr its adjustment as
  an INR-only line (`forexAmount 0`) against the unrealised ledger (settings; default the realised
  one), through `saveVoucher` (so back-dated / locked-period rules, numbering and audit apply). A second
  revaluation as of the same date is refused with `needsConfirmation` (`allowRepeat` to post anyway);
  nothing to revalue, a currency with a balance but no closing rate (typing the rate of another
  currency does not excuse it — every monetary item is restated) or a journal date before the as-of
  date is refused with a clear message. The report also returns the master rate of each currency
  (`masterRate` / `masterDate`) when a typed rate overrides it.
  Reversal on the first day of the next period is left to the user (duplicate the journal, swap sides)
  — many accountants prefer it, AS 11 does not require it.
* Accounting assumption: monetary items (receivables, payables, foreign bank balances, loans) are
  restated at the closing rate; differences go to P&L (AS 11 para 13 / Ind AS 21 para 23, 28).
  **Only monetary items are revalued**: ledgers of an income / expense group and ledgers under Fixed
  Assets, Investments, Stock-in-Hand, Capital Account or Misc. Expenses (Asset) are left at the
  historical rate even when kept in a foreign currency (AS 11 para 11 / Ind AS 21 para 23(b)).
  Advances paid / received for goods or services sit in party ledgers and ARE restated (the module
  cannot tell them apart; under Ind AS 21 Appendix B they are non-monetary — post a reversing journal
  if your framework requires it). The module does not treat long-term monetary items under AS 11 para
  46/46A (FCMITDA option) or hedge accounting — record those by journal.

## 4. Rates of exchange

The exchange-rate master is the accounts module's (`accounts.exchangeRate.*`: per date, standard /
selling / buying). `forex.rate.suggest {currencyId, date, rateType? | baseType?}` returns the latest row
on or before the date. Default rate type by voucher (banking convention, as TallyPrime's voucher rate):
sales / receipt / credit note → **buying**; purchase / payment / debit note → **selling**; others →
standard (`defaultRateType`). The rate typed on the voucher is what posts.

Legal note (GST valuation): for exports of goods, the value is converted at the rate notified by CBIC
under s.14 of the Customs Act for the date of the shipping bill; Rule 34 of the CGST Rules says the rate
for the taxable value is the one "as applicable" on the date of supply (customs notified rate for
goods). The app does not download or seed those rates — enter the notified rate in the master or on the
voucher. Bahi does not decide which rate is legally right for your case; it records the one you use.

## 5. GST and export invoices

* GST is always computed on the **INR** values (the engine sees rupees only); GSTR-1 6A (EXPWP /
  EXPWOP), GSTR-3B 3.1(b) and the e-invoice JSON carry rupees (the e-invoice `ExpDtls.ForCur` / `CntCode`
  come from the export details as before). Export under LUT (without IGST) or with IGST is chosen in
  the export dialog of voucher entry (existing fields: shipping bill no. / date, port code).
* The printed export invoice is the normal rupee GST invoice (Rule 46 endorsement "supply meant for
  export under LUT…" etc. from the print module) **plus** the foreign-currency block: each line / charge
  in the currency with its rate, GST in rupees and in the currency, total in both and in words in the
  currency, and the rate (`print.ts`, `PrintVoucherData.forex`).

## 6. Routes

| Route | Access | Notes |
|---|---|---|
| `forex.context` | vouchers.view | currencies, foreign ledgers, settings (`enabled: false` when off) |
| `forex.settings.get` / `.save` | masters.view / company.manage | gain/loss ledgers (income / expense, not bill-wise), revaluation rate type; audited |
| `forex.rate.suggest` | vouchers.view | §4 |
| `forex.pendingBills` | vouchers.view | pending bills of a foreign ledger in both currencies (bill-wise dialog) |
| `forex.voucher` | vouchers.view | forex side of a saved voucher (view panel / print) |
| `forex.outstanding` | reports.view | per party and bill: forex, INR carried, booked rate, closing rate, revalued, unrealised; per-currency totals; `kind`, `ledgerId`, `currencyId` filters |
| `forex.ledger` | reports.view | ledger vouchers in both currencies with running balances; closing at the closing rate |
| `forex.revaluation.report` / `.post` | reports.view / vouchers.create | §3 |
| `forex.opening.get` / `.save` | masters.view / masters.alter | opening balance and opening bills in the currency (same side as the rupees; bills must add up); audited |

No new permissions: the routes use the existing ones above. Reports are `transactional: false`.
Export / print of every report goes through the shared export path (data.export permission + audit).

## 7. Tests

`hook.test.ts` (conversion, LUT / IGST / item invoices, realised gain / loss on full and part
settlement, master rate defaults, EEFC transfers, INR-only adjustments, rules with the feature off,
alter and delete), `reports.test.ts` (outstanding, ledger, revaluation + post, opening,
settings), `print.test.ts` (export invoice and receipt print data), `e2e.test.ts` (whole flow through
`runtime.dispatch`: F11 on → USD + rates → USD customer → export invoice under LUT → GSTR-1 EXPWOP in INR
→ part receipt with realised gain → outstanding / ledger → revaluation and its journal → TB balanced;
repeat revaluation asks first; a journal dated before the as-of date is refused; deleting the journal
removes its revaluation record), `review.test.ts` (review regressions: opening forex kept on ledger
re-save and currency change refused, non-monetary ledgers not revalued, discount + LUT invoice value
and print, credit note against an invoice at another rate, ledger in both currencies ties to Ledger
Vouchers, cancel restores the bill, journal date guard, preview before the gain/loss ledger exists,
every currency needs a closing rate). Renderer pure logic: `src/renderer/modules/forex/lib/*.test.ts`.

## 8. Known gaps

* Currencies with 3–4 decimals (KWD, BHD…) are stored and converted exactly in the core, but voucher
  entry's grid keeps amounts of a foreign-currency invoice at 2 decimals (amount fields hold
  foreign × 100).
* Item invoices in a foreign currency: stock is valued in rupees at the converted rate (as Tally).
  Inventory reports show rupees only.
* No automatic reversal of the revaluation journal; no FCMITDA / hedge accounting (§3).
* CBIC customs exchange-rate notifications are not downloaded (offline app): type the notified rate.
* The Compact (thermal) print template does not print the foreign-currency block.
* Tally XML import ignores foreign amounts (it takes the rupee part of `… = ₹ …` amounts).
* Opening balances in the currency survive a re-save of the ledger master: opening bills re-entered
  with the same name and side keep their foreign amount, and an opening balance moved to the other side
  (or to zero) drops its foreign amount. The ledger's currency cannot be changed while its opening is
  entered in the currency (clear it in Opening Balance in Currency first) or vouchers record it in the
  currency.
* Realised differences on settling an advance by an invoice are booked like any other bill (Tally's
  behaviour); Ind AS 21 Appendix B would instead record the invoice at the advance's rate.
* The TDS + foreign-currency combination (a TDS line on a payment to a foreign party) scales the foreign
  amount in proportion to the rupees after deduction; it has no dedicated test yet.
