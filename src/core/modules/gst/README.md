# GST module: returns, registers, e-invoice, e-way bill

This module turns the GST rows written by the posting engine into returns and compliance files:
GSTR-1 (summary, drill-down, JSON), GSTR-3B (summary, manual entries, JSON), GSTR-9 (annual summary),
GST registers, HSN summary, ITC and exceptions, and e-invoice / e-way bill bulk files. The "GST plus"
part (§11–§17) adds what a voucher's GST details carry and what is posted from returns: advances
(Table 11), bills of entry, stat adjustments (ITC reversal / reclaim, reverse charge), GST set-off with
challans and the electronic cash / credit ledgers, return filing status with the GSTR-1 amendments log,
and the composition returns CMP-08 / GSTR-4.

**Single source of truth.** Every figure comes from `gst_lines` (values and tax as on the document) and
the `vouchers` header (nature, place of supply, party snapshot, numbers, IRN / e-way bill fields).
Nothing here recomputes tax from items or rates.

DTO types: `src/shared/types/gst-returns.ts`. Money is integer **paise** in DTOs; JSON files are in
rupees. Dates are `YYYY-MM-DD`.

| File | Purpose |
|---|---|
| `routes.ts` | Route table, input schemas, `gstCompany(ctx)` guard |
| `period.ts` | Return-period keys, ranges, `gst.periods` |
| `docs.ts` | `loadDocs()`: vouchers + gst_lines → `GstDoc` (direction, sign, nature, inter-state) and tax helpers |
| `checks.ts` | Uncertain-transaction checks (outward + inward) |
| `gstr1.ts` / `gstr1-json.ts` | GSTR-1 placement, summary, drill-down / GSTN JSON |
| `setoff.ts` | ITC set-off (s.49(5), Rule 88A) |
| `gstr3b.ts` | GSTR-3B computation, manual entries, JSON |
| `reports.ts` | HSN summary, GST registers, ITC report, exceptions |
| `einvoice.ts` / `address.ts` | IRP schema 1.1 payload, validation, bulk JSON, response import, IRN cancel |
| `ewaybill.ts` | e-way bill pending list, bulk JSON, recording the EWB number |
| `gstr9.ts` | Annual summary |
| `hook.ts` | Voucher hook (vouchers/hooks.ts): validates / posts / derives `VoucherInput.gstDetails`; amendments of filed GSTR-1 documents; refuses deleting a filed document |
| `advances.ts` | Tax on advances, pending advances, Table 11A / 11B (`gst_advance_lines`) |
| `bookAdjustments.ts` | Advances, stat journals and bills of entry as they reach GSTR-3B (3.1(a), 3.1(d), 4(A)(1)/(3)/(5), 4(B)(1)/(2), 4(D)(1)) |
| `filings.ts` | Return filing status, document snapshots, amendments log (9A / 9C / 10 / added), corrections of filed periods |
| `setoffPost.ts` | Set-off for a period (GSTR-3B 6.1 or CMP-08) posted as a journal; GST challans (PMT-06) |
| `eledgers.ts` | Electronic cash ledger (major × minor head) and electronic credit ledger from the books |
| `boeRecon.ts` | Bills of entry register and reconciliation with GSTR-2B IMPG / IMPGSEZ |
| `composition.ts` | Composition rate master, CMP-08, GSTR-4, their CSV / JSON (Bahi format) |
| `statLedgers.ts` | GST plus system ledgers (created on demand, `reserved_code`) and the duty ledger map |
| `schemas.ts` | Input schema of `VoucherInput.gstDetails` |
| `testkit.ts` | Test helpers: direct SQL inserts + the April-2026 dataset (tests only) |
| `gstr1.golden.json` | Reviewed GSTR-1 JSON of the dataset (snapshot test) |

Migration `090_gst.ts` adds:
- `gst_adjustments (form, return_period, data JSON, updated_at, updated_by)`: manual GSTR-3B entries;
- `gst_doc_events (voucher_id, kind einvoice|ewaybill, action, ref_no, detail JSON, ts, user)`: the e-invoice / e-way bill trail (the voucher row keeps the current state);
- an index on `gst_lines(date, affects_books, voucher_id)`.

Migration `200_gstplus.ts` (global version 200; the gstplus block is 200–209) adds the derived tables
`gst_advance_lines`, `gst_bill_of_entry`, `gst_stat_lines`, `gst_challans` (rebuilt by the voucher hook
inside the voucher's transaction, carrying date / affects_books / is_post_dated, cascading on delete) and
the masters / logs `gst_return_filings`, `gst_amendments`, `gst_composition_rates` (seeded) and
`gst_settings`. Additive only.

---

## 1. Routes

All routes are company scope. Reads need **gst.view**; anything that produces a return or bulk file, or
changes GST state, needs **gst.file**. Read routes are `transactional: false`; JSON exports write their
audit entry in their own small transaction. Every route refuses a company with GST turned off (F11) or
not registered (BUSINESS_RULE, with the fix in the message).

**Period input** (`GstPeriodInput`): `{ period }` or `{ from, to }`. A period key is a month `MMYYYY`
(`'042026'`) or a GST-year quarter `YYYY-YY-Qn` (`'2026-27-Q1'` = Apr–Jun 2026, `fp` `'062026'`).
JSON exports need a month or a quarter (not a range).

| Route | Access | Input | Output |
|---|---|---|---|
| `gst.periods` | view | – | `GstPeriodsResult { filingFrequency, periods: ReturnPeriod[] (newest first; quarters too for quarterly filers; outward/inward counts, isCurrent), current, suggested }` |
| `gst.gstr1.summary` | view | `GstPeriodInput` | `Gstr1Summary` (sections in table order, b2cs, nil, hsnB2b, hsnB2c, docs, totals, issues, notes, excluded) |
| `gst.gstr1.section` | view | `GstPeriodInput & { section: Gstr1SectionId }` | `Gstr1SectionResult` (voucher rows with signed amounts + aggregate rows for b2cs/nil/hsn/doc) |
| `gst.gstr1.json` | **file** | `{ period }` | `GstJsonFile { fileName, json, warnings }` — audited (`export`, `gst_return`) |
| `gst.gstr3b.summary` | view | `GstPeriodInput` | `Gstr3bSummary` (3.1, 3.1.1, 3.2, 4, 5, 5.1, 6.1, adjustments, notes, issueCount) |
| `gst.gstr3b.saveAdjustments` | **file** | `Gstr3bAdjustmentsInput { period, values }` (partial; merged) | `Gstr3bSummary` recomputed — audited; refused (LOCKED) when the period's last day is locked |
| `gst.gstr3b.json` | **file** | `{ period }` | `GstJsonFile` — audited |
| `gst.hsnSummary` | view | `{ from, to, direction: 'outward' \| 'inward' }` | `GstHsnSummaryResult` |
| `gst.register` | view | `{ from, to, kind: 'sales' \| 'purchase' }` | `GstRegisterResult` (signed rows, totals, rate totals) |
| `gst.itc` | view | `{ from, to }` | `GstItcResult` (by supplier and by eligibility) |
| `gst.exceptions` | view | `{ from, to }` | `GstExceptionsResult { issues, counts }` |
| `gst.einvoice.pending` | view | `{ from, to }` | `EinvoicePendingResult { enabled, rows: EinvoicePendingRow[] (ready, errors, warnings) }` |
| `gst.einvoice.generated` | view | `{ from, to }` | `EinvoiceGeneratedResult { rows: EinvoiceGeneratedRow[] }` — documents whose IRN is active (in the books or cancelled), ack date, `cancellableUntil` (ack + 24 h, IST) and `cancelWindowOpen` |
| `gst.einvoice.json` | **file** | `{ voucherIds }` (1–1000) | `GstBulkJsonFile { fileName, json (array of IRP documents), documents, rejected[], warnings }` — logged per voucher + audited |
| `gst.einvoice.importResponse` | **file** | `EinvoiceImportInput { fileName, bytes }` (JSON or .xlsx) | `EinvoiceImportResult { records, updated, unchanged, skipped, failed, warnings }` — each voucher change audited |
| `gst.einvoice.markCancelled` | **file** | `{ voucherId, reason }` | `GstDocStatusResult` — audited (`cancel`, `einvoice`) |
| `gst.ewaybill.pending` | view | `{ from, to }` | `EwayPendingResult { enabled, thresholdPaise, rows: EwayPendingRow[] }` |
| `gst.ewaybill.json` | **file** | `{ voucherIds }` | `GstBulkJsonFile` (`{ version, billLists }`) — logged + audited |
| `gst.ewaybill.update` | **file** | `EwayUpdateInput { voucherId, ewayBillNo (12 digits), date, validUpto? }` | `GstDocStatusResult` — audited |
| `gst.docEvents` | view | `{ voucherId }` | `GstDocEvent[]` (e-invoice / e-way bill trail) |
| `gst.gstr9.summary` | view | `{ fy: '2026-27' }` | `Gstr9Summary` (caption "Prepared from books — verify before filing") |
| `gst.advances.pending` | view | `{ asOf?, partyLedgerId? }` | `PendingAdvance[]` — advances not yet adjusted / refunded |
| `gst.advances.register` | view | `{ from, to }` | `Gstr1AdvancesSummary` (11A received, 11B adjusted / refunded, vouchers, net) |
| `gst.filing.list` | view | `{ form? }` | `GstFiling[]` |
| `gst.filing.mark` | **file** | `{ form, period, filedOn, arn? }` | `GstFiling` — snapshot of the summary as filed; audited. GSTR-1 / 3B for regular, CMP-08 / GSTR-4 for composition only |
| `gst.filing.unmark` | **file** | `{ form, period }` | refused while amendments point at a filed GSTR-1; audited |
| `gst.amendments.list` | view | `{ period?, voucherId? }` | `GstAmendmentRow[]` |
| `gst.gstr3b.changes` | view | `{ period?, voucherId? }` | `Gstr3bChangeRow[]` — vouchers changed after their period's GSTR-3B was filed (§18) |
| `gst.rule37.report` | view | `{ asOf, partyLedgerId? }` | `Rule37Result` — purchases unpaid after 180 days (§19) |
| `gst.rule37.post` | **file** | `{ asOf, date, kind: 'reversal' \| 'reclaim', voucherIds?, narration? }` | `VoucherSaveResult` — the Rule 37 journal (§19) |
| `gst.setoff.compute` | view | `{ period, penalty?, others? }` | `GstSetoffResult` (credit utilisation, cash per major × minor head, available in the cash ledger, to deposit, challans, posted journal) |
| `gst.setoff.post` | **file** | `{ period, date, penalty?, others?, narration? }` | `VoucherSaveResult` — one Journal (CONFLICT when already posted for the period) |
| `gst.challan.post` | **file** | `{ date, bankLedgerId, cpin, cin?, brn?, challanDate?, bankName?, mode?, period?, heads[], narration? }` | `VoucherSaveResult` — one Payment voucher |
| `gst.challan.list` | view | `{ from, to }` | `GstChallanRow[]` |
| `gst.ledger.cash` / `gst.ledger.credit` | view | `{ from, to }` | `ElectronicCashLedger` / `ElectronicCreditLedger` |
| `gst.boe.list` | view | `{ from, to }` | `BoeRow[]` |
| `gst.boe.reconcile` | view | `{ from, to, fileName, bytes }` (GSTR-2B JSON / ZIP) | `BoeReconResult` (read-only; nothing stored) |
| `gst.cmp08.summary` | view | `{ period: '2026-27-Q1' }` | `Cmp08Summary` |
| `gst.cmp08.saveInterest` | **file** | `{ period, interest }` | `Cmp08Summary` — audited, period-lock aware |
| `gst.cmp08.export` / `gst.gstr4.export` | **file** | `{ period \| fy, format: 'json' \| 'csv' }` | `GstTextFile` (Bahi's documented format) — audited as an export |
| `gst.gstr4.summary` | view | `{ fy }` | `Gstr4Summary` |
| `gst.composition.settings` | view | – | `CompositionSettings` (category + rate master) |
| `gst.composition.saveCategory` / `saveRate` / `deleteRate` | **file** | category / rate row / `{ id }` | `CompositionSettings` — audited |

Errors: `VALIDATION` (bad period / dates / fields), `BUSINESS_RULE` (GST off, nothing exportable — the
rejected vouchers with reasons are in `details.rejected`), `FORBIDDEN`, `LOCKED` (3B entries of a locked
period), `NOT_FOUND`.

---

## 2. Documents (`docs.ts`)

`loadDocs()` reads sales, purchases, credit notes and debit notes in a date range with the **books
filter** (`affects_books = 1 AND (is_post_dated = 0 OR date <= today)`). Optional and cancelled vouchers
never count; cancelled (non-optional) vouchers are added only for Table 13 (`inBooks = false`).

- **Nature** = `vouchers.gst_nature` (engine). When NULL it is derived with `classifySupply` (B2CL
  threshold from F12).
- **Direction**: outward natures → outward, inward/import natures → inward (sales are always outward and
  purchases always inward). The engine makes credit notes outward and debit notes inward.
- **Sign**: sales +1, credit note −1, outward debit note +1; purchase +1, inward debit note
  (purchase return) −1, inward credit note −1. gst_lines amounts are "as on the document"; every report
  multiplies by the sign.
- **Inter-state**: outward: place of supply ≠ company state (exports and SEZ always inter-state);
  inward: supplier state (party state, else GSTIN) ≠ company state (imports inter-state). Without a state
  the IGST on the lines decides.
- **Party**: the voucher snapshot (`party_*`), falling back to the ledger.

---

## 3. GSTR-1 mapping (`gstr1.ts`)

Document nature → table (lines with taxability `taxable`):

| Nature | Invoice | Credit / debit note |
|---|---|---|
| `b2b` (regular, composition, UIN buyer) | **4A** (`inv_typ R`); **4B** when reverse charge (`rchrg Y`) | **9B CDNR** (`R`, `rchrg` as the note) |
| `sez_wpay` / `sez_lut` | **6B** `SEWP` / `SEWOP` (JSON: `b2b`) | **9B CDNR** `SEWP` / `SEWOP` |
| `deemed_export` | **6C** `DE` (JSON: `b2b`) | **9B CDNR** `DE` |
| `b2cl` | **5** (by POS) | **9B CDNUR** `B2CL` |
| `export_wpay` / `export_lut` | **6A** `WPAY` / `WOPAY` | **9B CDNUR** `EXPWP` / `EXPWOP` |
| `b2cs` | **7** aggregated by POS + rate + INTRA/INTER, `typ OE` | netted into **7** — unless the original invoice was B2CL / export (then CDNUR) |
| `nil_exempt` | **8** | netted into **8** |
| `composition_outward`, `no_gst` | not reported (GSTR-1 not filed) | – |

- **Unregistered-party notes**: the original invoice (number + date on the note) is looked up; its
  nature decides CDNUR B2CL / EXP vs B2CS netting. Without a reference the note's own nature decides
  (and an uncertain-transaction warning is raised).
- **Table 8**: every exempt / nil-rated / non-GST line, whatever the document's table, split
  INTRB2B / INTRAB2B / INTRB2C / INTRAB2C (registered = party with a GSTIN/UIN; overseas = unregistered).
- **Table 12 (HSN)**: every reported line (incl. table 8 lines and 4B), signed. Split per the
  2025 format: **B2B** = lines of 4A/4B/6B/6C/CDNR + nil lines to registered parties; **B2C** = 5, 6A, 7,
  CDNUR + nil lines to unregistered parties. Rows by HSN (truncated to `config.gst.hsnDigits`) + UQC +
  rate; services → UQC `NA`, qty 0; description = first line description (JSON: ≤ 30 characters).
- **Table 13**: per voucher type and number pattern (last digit run = sequence): from / to, total
  = to − from + 1 for numeric series **less the numbers held by vouchers that are not outward documents
  of the period** (optional vouchers; debit notes to suppliers sharing the Debit Note series),
  cancelled = cancelled vouchers **+ numbers missing in the range** (deleted vouchers; flagged
  `doc_series_gap`), net = total − cancelled. An optional voucher holding a number of a reported series
  is flagged `optional_in_series` (regularise or delete it before filing: regularising it after filing
  would contradict the filed Table 13). doc_num 1 sales, 4 debit notes, 5 credit notes. Repeating
  numbers (monthly restart) are split per month.
- **Table 11 (advances)**: not derived (receipts carry no rate / POS) — empty with a note.
- **Amendments (9A, 9C, 10, 11B(2)) are out of scope**: amend on the portal.
- **Totals** (`Gstr1Summary.totals`): net tax of all sections except 4B (recipient pays) → compare with
  GSTR-3B 3.1(a) + 3.1(b).

### Uncertain transactions (`checks.ts`; also in `gst.exceptions`)

Every issue also carries fix-link ids for the UI: `partyLedgerId` (the document's party ledger; null on
period-level issues) and, for HSN / rate issues, `itemId` (stock item of the first offending line) or
`lineLedgerId` (its ledger when the line is in accounting mode).

| Code | Severity | When | Fix hint |
|---|---|---|---|
| `gstin_missing` / `gstin_invalid` | error | registered-party table (4A/4B/6B/6C/CDNR) without / with an invalid GSTIN | correct the party ledger, re-save |
| `b2c_with_gstin` | warning | B2C table but the party has a valid GSTIN | set registration Regular |
| `hsn_missing` / `hsn_short` | error | a valued line without HSN/SAC, or shorter than `hsnDigits` | set HSN in the item / ledger |
| `hsn_invalid` | warning | non-digits, not 4/6/8 digits, service without 99 | |
| `pos_missing` | error | no place of supply (not exports) | |
| `note_without_original` | warning | note without original invoice no., or not found in the books | |
| `doc_no_missing` / `doc_no_invalid` | error | > 16 characters, characters other than A–Z 0–9 / -, or no letter/non-zero digit | |
| `doc_series_gap` | warning | numbers missing in a series (Table 13: reported as cancelled) | |
| `optional_in_series` | warning | an optional (draft) voucher holds a number of a reported outward series (left out of Table 13) | make it regular or delete it before filing |
| `rate_not_slab` | error (outward) / warning (inward) | rate not in `GST_RATES` | |
| `tax_head_mismatch` | error | IGST on an intra-state supply or CGST/SGST on an inter-state one | |
| `no_gst_lines` | error | outward voucher with value but no gst_lines | re-save in invoice mode |
| `negative_value` | error / warning | negative taxable value at a rate (document) / negative B2CS row | |
| `export_shipping_bill_missing` | warning | export without SB no., date, port | |
| `nature_mismatch` | warning | B2CS/B2CL classification contradicts the threshold rule | re-save |
| `supplier_invoice_missing` | error (no number, tax claimed) / warning | purchase without supplier invoice no. / date | |
| `supplier_gstin_invalid` | error | supplier GSTIN fails validation | |
| `itc_without_gstin` | error | ITC claimed from a domestic supplier without GSTIN (not RCM) | |
| `rcm_without_liability` | error | RCM purchase with no tax, or with tax but no posting to a "Payable (Reverse Charge)" ledger | |
| `itc_time_limit` | warning | ITC booked after 30 November following the invoice's financial year (s.16(4)) | |

---

## 4. GSTR-1 JSON (`gstr1-json.ts`)

```
{ gstin, fp: 'MMYYYY', version: 'GST3.2.1', hash: 'hash',
  b2b:   [{ ctin, inv: [{ inum, idt, val, pos, rchrg, inv_typ, itms: [{ num, itm_det: { txval, rt, iamt|camt+samt, csamt } }] }] }],
  b2cl:  [{ pos, inv: [{ inum, idt, val, itms: [{ num, itm_det: { txval, rt, iamt, csamt } }] }] }],
  b2cs:  [{ sply_ty, pos, typ: 'OE', rt, txval, iamt (INTER) | camt + samt (INTRA), csamt }],
  exp:   [{ exp_typ: 'WPAY'|'WOPAY', inv: [{ inum, idt, val, sbpcode?, sbnum?, sbdt?, itms: [{ txval, rt, iamt, csamt }] }] }],
  cdnr:  [{ ctin, nt: [{ ntty, nt_num, nt_dt, val, pos, rchrg, inv_typ, itms }] }],
  cdnur: [{ typ: 'B2CL'|'EXPWP'|'EXPWOP', ntty, nt_num, nt_dt, val, pos (B2CL only), itms }],
  nil:   { inv: [{ sply_ty, expt_amt, nil_amt, ngsup_amt }] },
  hsn:   { hsn_b2b: [{ num, hsn_sc, desc?, uqc, qty, rt, txval, iamt, camt, samt, csamt }], hsn_b2c: [...] },
  doc_issue: { doc_det: [{ doc_num, docs: [{ num, from, to, totnum, cancel, net_issue }] }] } }
```

- Amounts: rupees as numbers = paise / 100 (exact, ≤ 2 decimals). Notes carry positive values (`ntty`
  gives the direction). `val` = `vouchers.total_amount` (invoice value as on the document).
- Dates `dd-mm-yyyy`; `pos` two digits (missing → company state, flagged as an issue).
- Items are grouped **per rate** within each document (`num` 1, 2, … in rate order); cess summed per rate.
- Inter-state documents carry `iamt`; intra-state ones `camt` + `samt` (keys only when relevant).
- Empty sections are omitted; ordering is deterministic (ctin / pos, then date, then number).
- File name `GSTR1_<gstin>_<fp>.json`.

**Verify against the portal's latest JSON spec** (things that change between offline-tool versions):
the `version` string (`GSTR1_JSON_VERSION`); the HSN split keys `hsn_b2b` / `hsn_b2c` (2025 format) and
whether `desc` / `user_desc` is expected; `pos` on CDNUR for export notes (omitted here); the rate on
WOPAY / SEWOP items (we send the nominal rate with zero tax); whether table-8 lines of export invoices
should rather be in 6A at rate 0 (we report them in table 8, INTRB2C).

---

## 5. GSTR-3B (`gstr3b.ts`)

| Row | Source |
|---|---|
| 3.1(a) `osup_det` | outward taxable lines of B2B (non-RCM), B2CL, B2CS, deemed exports ± notes |
| 3.1(b) `osup_zero` | exports and SEZ (WPAY/WOPAY/SEWP/SEWOP) ± notes: txval, IGST, cess |
| 3.1(c) `osup_nil_exmp` | nil-rated + exempt outward lines |
| 3.1(d) `isup_rev` | inward lines under reverse charge (line flag, `inward_rcm`, `import_services`) ± returns |
| 3.1(e) `osup_nongst` | non-GST outward lines |
| 3.1.1 | e-commerce operator supplies: always 0 (not recorded) |
| 3.2 | inter-state taxable supplies (excl. zero-rated) to unregistered/consumer, composition, UIN parties, by POS |
| 4(A)(1) IMPG | `import_goods` + the **goods** lines of `inward_sez` (goods from an SEZ unit are imports: IGST paid on the bill of entry) |
| 4(A)(2) IMPS | `import_services` |
| 4(A)(3) ISRC | other reverse-charge inward lines |
| 4(A)(4) ISD | manual `itcIsd` |
| 4(A)(5) OTH | all other inward taxable lines (incl. **services** from an SEZ unit, IGST charged on its invoice) (+ manual `itcReclaimed`), **net of purchase returns** |
| 4(B)(1) RUL | ITC on lines marked `ineligible` (s.17(5), from the books) + manual `itcReversalRules` (rules 38/42/43) |
| 4(B)(2) OTH | manual `itcReversalOthers` |
| 4(C) | 4(A) − 4(B) |
| 4(D)(1) | manual `itcReclaimed` (information; the amount is also in 4(A)(5)) |
| 4(D)(2) | manual `itcIneligibleOthers` (s.16(4), PoS) |
| 5 | inward exempt + nil + composition-supplier supplies (`GST`), non-GST (`NONGST`), inter / intra |
| 5.1 | manual `interest` (all heads), `lateFee` (CGST, SGST) |
| 6.1 | forward-charge liability = tax of 3.1(a) + 3.1(b) (never below 0; a negative 4(C) is added) set off against 4(C) (never below 0) + **credit brought forward** (`payment.broughtForward`, below) + manual `creditLedgerBalance` (credit the books do not hold, e.g. the portal balance when the books began); reverse-charge tax (3.1(d)) paid in **cash** |

**Electronic credit ledger brought forward** (`creditBroughtForward`): unused credit is carried from
one return period to the next, as the portal's electronic credit ledger does. For a month it is the
`setOff.creditBalance` of the previous month, which itself started with the month before's — chained
from the first period of the books (books beginning, or the first GST document if earlier; nothing is
carried into it) with each period's own manual entries. A quarter chains quarters the same way; a date
range is a review and carries nothing (note in `notes`). The 3B screen, the dashboard GST card and
GSTR-9 table 9 (which walks the year's months in order) all use the same chain. Reverse-charge tax
never uses credit. When a period has both credit brought forward and a manual `creditLedgerBalance`,
a note warns that the manual entry is added on top (it is credit the books do not hold, not the whole
portal balance — entered as the whole balance, as before the chain existed, the credit would count twice).

*Cost.* Each period's closing credit is memoised per connection with a fingerprint of its data (its
`gst_lines` — amounts, rate, flags, position-weighted —, its GST vouchers' count / ids / totals / status /
last change of every voucher, the party ledger's GSTIN / state / registration for vouchers whose own party
snapshot is incomplete (classification falls back to the ledger), and its manual entries). While nothing is written (`total_changes()`, `PRAGMA
data_version`) a repeat costs nothing; after a write the fingerprints are re-read (≈0.1 s on 35,000
GST lines) and only the periods from the first changed one are recomputed — a save in the current
month recomputes nothing of the history (≈0.2 s for a changed last month vs ≈1.1 s for 18 months /
35,000 documents cold). The history is read with `loadDocs({ lean: true })`: only the columns that
classify a document and its lines (nature, direction, sign, inter-state, registration; line amounts,
rate, supply type, taxability, reverse charge, ITC eligibility), tested to give the same GSTR-3B as the
full load (≈1.8 s cold before). A change of the working date, the chain start, or the company's GST registration / state /
GSTIN starts afresh.

**Deliberate deviation from the old form:** since July 2022 (Notification 14/2022-CT, Circular
170/02/2022) ITC blocked under s.17(5) is reported in 4(A) and reversed in 4(B)(1); 4(D)(1) is "ITC
reclaimed" and 4(D)(2) "ineligible under s.16(4) / PoS". The computation follows the current form; the
s.17(5) amount is also returned separately (`itc.blocked`). Outward supplies on which the recipient
pays tax (GSTR-1 4B) are not in 3.1 (note in `notes`).

### ITC set-off (`setoff.ts`)

1. IGST credit → IGST.
2. Remaining IGST credit **must** be used next (Rule 88A), against CGST and SGST "in any order and
   proportion": first on the part of each liability that its own credit cannot cover (CGST before
   SGST), then on the rest (CGST before SGST). With no own-head credit this is "IGST → IGST → CGST →
   SGST".
3. CGST credit → CGST, then IGST (never SGST).
4. SGST/UTGST credit → SGST, then IGST (never CGST).
5. Cess credit → cess only.

Example (liability I 0 / C 500 / S 500; credit I 600 / C 500 / S 0): SGST shortfall 500 → IGST credit
pays SGST 500, the remaining 100 pays CGST; CGST credit pays CGST 400 → cash 0, CGST credit 100 carried
forward. A plain "IGST → CGST → SGST" would pay CGST 500 + SGST 100 from IGST and leave SGST 400 in cash.

### GSTR-3B JSON

```
{ gstin, ret_period,
  sup_details: { osup_det {txval,iamt,camt,samt,csamt}, osup_zero {txval,iamt,csamt}, osup_nil_exmp {txval},
                 isup_rev {txval,iamt,camt,samt,csamt}, osup_nongst {txval} },
  eco_dtls: { eco_sup {txval,iamt,camt,samt,csamt}, eco_reg_sup {txval} },
  inter_sup: { unreg_details [{pos,txval,iamt}], comp_details [...], uin_details [...] },
  itc_elg: { itc_avl [{ty: IMPG|IMPS|ISRC|ISD|OTH, iamt,camt,samt,csamt}], itc_rev [{ty: RUL|OTH, …}],
             itc_net {…}, itc_inelg [{ty: RUL|OTH, …}] },
  inward_sup: { isup_details [{ty: GST|NONGST, inter, intra}] },
  intr_ltfee: { intr_details {iamt,camt,samt,csamt}, ltfee_details {camt,samt} } }
```
Negative values are written as 0 with a warning (the portal rejects negatives). File
`GSTR3B_<gstin>_<fp>.json`. Verify `eco_dtls` and `ltfee_details` keys against the current offline
utility.

---

## 6. Registers and reports (`reports.ts`)

- **HSN summary**: like Table 12 (all lines, B2B + B2C together) for outward or inward documents.
- **Register**: one row per document, every amount signed (credit notes / purchase returns negative):
  taxable lines' value and tax, rate split, non-taxable value, invoice value, supplier invoice no./date
  for purchases.
- **ITC**: per supplier (party ledger, else GSTIN, else name) taxable lines: eligible (eligibility ≠
  `ineligible`; NULL counts as inputs / input services), ineligible, part under reverse charge, part on
  imports; and totals by eligibility. Eligible total = GSTR-3B 4(C) before manual entries.
- **Exceptions**: GSTR-1 checks on outward documents + purchase-side checks, errors first.

---

## 7. e-Invoice (IRP schema 1.1, `einvoice.ts`)

**Pending**: outward documents in the books with nature b2b / sez / export / deemed export, no IRN and
`irn_status` NULL or `pending` (the engine sets `pending` when the e-Invoice feature is on), with
readiness errors / warnings per voucher.

**Payload** (per voucher):
- `TranDtls { TaxSch 'GST', SupTyp B2B|SEZWP|SEZWOP|EXPWP|EXPWOP|DEXP, RegRev Y|N, IgstOnIntra 'N' }`
- `DocDtls { Typ INV|CRN|DBN, No, Dt dd/mm/yyyy }`
- `SellerDtls` from the company profile (`TrdNm` when the mailing name differs; `Ph`/`Em` when valid);
  `BuyerDtls` from the party snapshot (exports: `Gstin 'URP'`, `Pos`/`Stcd '96'`, `Pin 999999`);
  `ShipDtls` from the consignee when it differs and is complete (else a warning). Addresses are split
  into Addr1 / Addr2 / Loc (`address.ts`).
- `ItemList`: one item per gst_line. Goods: `Qty` (3 decimals) + `Unit` (UQC); services omit them.
  `UnitPrice`/`TotAmt`/`Discount` come from the inventory line with the same item and value when
  qty × rate explains the value (discount); otherwise `UnitPrice = value / qty`, `TotAmt = AssAmt`.
  `GstRt` (0 for non-taxable lines), tax amounts, `CesRt`, `CesAmt`, `CesNonAdvlAmt 0`, `TotItemVal`.
- `ValDtls { AssVal, CgstVal, SgstVal, IgstVal, CesVal, Discount, OthChrg, RndOffAmt, TotInvVal }`:
  sums of the items; `RndOffAmt` = voucher round-off; the rest of the invoice value (charges outside
  GST) → `OthChrg` (or `Discount` when negative). For reverse charge `TotInvVal` includes the tax.
- `RefDtls.PrecDocDtls` for notes with an original invoice; `ExpDtls` (ShipBNo, ShipBDt, Port,
  RefClm Y for WPAY, ForCur); `EwbDtls` when dispatch has a vehicle or transporter and a distance.

**Validation** (blocking errors, written for the user): document number (1–16, not starting with 0 / '/'
/ '-'), future date, seller GSTIN / address / PIN / state, buyer GSTIN (≠ seller), name ≥ 3, address,
6-digit PIN, state, POS, ≤ 1000 items, HSN (≥ 4, or ≥ `hsnDigits` when 6/8), SAC on goods lines, rate
slab, negative values, tax heads (no IGST intra-state, no CGST/SGST inter-state, no tax on SEZWOP /
EXPWOP), round-off within ±₹99.99, voucher totals vs gst_lines within ₹1, invoice total consistency
within ₹1. Warning: documents older than 30 days (refused by the IRP for AATO ≥ ₹10 crore).

**Bulk JSON**: array of payloads; vouchers with errors are left out and listed in `rejected`. File
`EINV_<gstin>_<yyyymmdd>_<n>.json`. Each exported voucher gets an `exported` event.

**Response import**: JSON (array, `{ data: [...] }` or a single object; the API shape `{ AckNo, AckDt,
Irn, SignedInvoice, SignedQRCode, EwbNo, EwbDt, EwbValidTill }` works because the document number /
date are read from the signed QR code's JWT payload) or the IRP Excel (a sheet with an "IRN" column;
headers like "Doc No", "Doc Date", "Ack No", "Ack Date", "Signed QR Code", "EWB No", "EWB Valid Till").
Matched by document number (case-insensitive) + date (+ type when given) among sales / credit / debit
notes. Updates `irn`, `irn_ack_no`, `irn_ack_date` (`YYYY-MM-DD HH:mm:ss`), `irn_signed_qr`,
`irn_status = 'generated'` and the e-way bill fields; bumps `updated_at`. Same IRN → unchanged; a
different IRN on a voucher that already has one → skipped; IRP error rows → failed; an IRN for a voucher
cancelled in the books → applied + warning (cancel the IRN within 24 hours).

`cancelRequired` (in the pending result) lists vouchers cancelled in the books whose IRN is still
active — cancel those IRNs on the IRP (within 24 hours of generation), then mark them here.

**Generated**: `gst.einvoice.generated` lists sales / credit / debit notes in the range with `irn_status = 'generated'`
(whether or not they count in the books), so an IRN cancelled on the IRP can be recorded here for any voucher. The
IRP accepts cancellation within 24 hours of the acknowledgement: `cancellableUntil` = ack date-time (Indian time)
+ 24 h as an ISO UTC instant, `cancelWindowOpen` compares it with the clock.

**Cancel**: `markCancelled` records an IRN cancelled on the IRP (`irn_status = 'cancelled'`) with the
reason in the trail. The voucher then no longer appears as pending (a new IRN needs a new document
number).

---

## 8. e-Way bill (`ewaybill.ts`)

**Pending**: sales and credit notes (sales returns) in the books without an e-way bill whose
consignment value — taxable value + tax of the **taxable goods** lines — **exceeds**
`config.gst.ewayThresholdPaise` (Rule 138: "exceeding ₹50,000"; exactly ₹50,000 is not pending).

**Bulk JSON** `{ version: '1.0.0621', billLists: [...] }`:
- sales: `supplyType O`, `subSupplyType 1` (3 for exports), `docType INV` (BIL for a bill of supply);
  credit note: `supplyType I`, `subSupplyType 7` (sales return), `docType CNT`, from the customer to us.
- From = company; To = party: `toGstin` (URP when unregistered / overseas), bill-to `toStateCode`
  (96 for exports), ship-to address / PIN / `actToStateCode` from the consignee when present
  (exports: the consignee must be the port / ICD). `transactionType` 2 when the consignee differs from
  the buyer, else 1.
- Values: `totalValue` and taxes of the goods lines; `otherValue` = invoice value − those (services,
  round-off, charges); `totInvValue` = invoice value.
- Transport from the voucher's dispatch details: transporter ID / name, LR no./date, mode (road / rail /
  air / ship → 1–4), distance (string), vehicle no. (spaces removed), vehicle type R.
- Items: goods lines only: `hsnCode` (number), quantity, UQC, taxable amount, CGST/SGST or IGST rates
  (0 when no tax is charged), cess rate.

Validation: goods lines present, document number, company GSTIN / PIN / address, party GSTIN, ship-to
address and PIN, distance 0–4000 (0 → warning: the portal computes it), transporter ID 15 characters,
HSN not a SAC; warnings for an odd vehicle number and for a missing Part-B.

`cancelRequired` (in the pending result) lists vouchers cancelled in the books that still carry an
e-way bill — cancel it on the EWB portal (within 24 hours).

**Update**: `{ voucherId, ewayBillNo (12 digits; spaces ignored), date (≥ voucher date), validUpto? }`,
unique across vouchers; audited and logged.

Verify against the EWB portal's current bulk schema: the `version`; the names `actFromStateCode` /
`actToStateCode` (some bulk-tool versions use `actualFromStateCode` / `actualToStateCode` — the names
are defined once, in the `KEYS` constant of `ewaybill.ts`); `hsnCode` as a number (HSN codes starting with 0 lose the leading
zero); state code 96 for "other country".

---

## 9. GSTR-9 (`gstr9.ts`)

The year (April–March) is loaded once. Tables 4 / 5 come from the GSTR-1 placement of the whole year;
table 6 from the inward lines; table 9 is the **sum of the monthly GSTR-3B computations** (with the
manual entries saved for each month, each month starting with the credit the previous one left); tables 17 / 18 are the HSN summaries; `months` lists each month's
outward taxable value and tax, net ITC and cash. Labelled "Prepared from books — verify before filing".

- 4A B2C (B2CL + B2CS, B2C notes netted), 4B B2B (non-RCM), 4C exports WPAY, 4D SEZ WP, 4E deemed
  exports, 4F advances 0, 4G inward RCM, 4I / 4J notes on B–E (positive), 4N = 4H + 4J − 4I.
- 5A exports WOPAY, 5B SEZ WOP, 5C outward RCM (4B of GSTR-1), 5D exempt, 5E nil, 5F non-GST,
  5H / 5I notes on A–C, 5M, 5N = 4N + 5M − 4G.
- 6A = Σ 4(A) of the months; 6B inputs / capital goods / input services (blocked lines by supply kind);
  6C RCM from unregistered; 6D RCM from registered; 6E import of goods; 6F import of services; 6G ISD;
  6I; 6J = 6I − 6A; 7E s.17(5) for reference.

---

## 10. Known limitations

- E-commerce operator supplies (3.1.1, GSTR-1 table 14/15), ISD, amendments of advances (11A(2) /
  11B(2)) and of B2C small supplies by POS (table 10 is listed, but enter it on the portal by POS and
  rate) are not derived. Advances (GSTR-1 11, GSTR-9 4F), amendments 9A / 9C, bills of entry, stat
  adjustments and set-off are derived (§11–§16).
- Invoice Management System (IMS: accept / reject / pending per inward document) actions are not
  imported or exported (gstrecon matches GSTR-2A / 2B only).
- Quarterly filers: the quarterly GSTR-1 file contains the whole quarter; invoices already uploaded
  through IFF must not be uploaded again.
- The electronic credit ledger is reconstructed from the books (credit brought forward, above; §14 for
  the per-head report); the 3B manual top-up stays ≥ 0. If the portal shows less credit than the books,
  pass a reversal journal (§13) rather than a negative manual entry.
- e-Invoice signing / IRP API calls and e-way bill API calls are not made (offline JSON only — §17);
  the PIN ↔ state consistency the IRP checks is not validated locally.
- Composition: Table 7 of GSTR-4 (TDS / TCS credit) is not kept; GSTR-4 / CMP-08 files are Bahi's own
  documented JSON / CSV, not the portal's offline-tool schema (§15).
- Purchases: e-way bills for inward supplies from unregistered suppliers and purchase returns are not
  listed as pending.
- A filed GSTR-1 freezes its period (amendments, §16) and a filed **GSTR-3B** freezes its period too
  (changes after filing, §18). A set-off already posted is not recomputed when the period's vouchers
  change later (alter or delete it and post again).
- Composition taxpayers: advances are refused (no Table 11); tax on an advance for a composition
  supplier is not computed — include it in the quarter's CMP-08 turnover yourself where it applies.
- GSTR-2B import reconciliation (`gst.boe.reconcile`) reads the JSON or the portal's ZIP of JSON parts;
  the Excel download is not read for IMPG.
- Performance: the year's documents are read once for GSTR-9 (≈3 s for 24,000 vouchers / 72,000 GST
  lines in the dev container); monthly reports take a fraction of a second.

---

## 11. GST details on vouchers (`hook.ts`, `schemas.ts`)

`VoucherInput.gstDetails` (`VoucherGstDetailsInput`, `src/shared/types/gst-plus.ts`) carries the GST side
of a voucher that is not an invoice line; voucher entry edits it with **Alt+J** (renderer
`gst/GstDetailsDialog.tsx`). The gst voucher hook (registered in `vouchers/hooks.ts` STATIC_HOOKS)
validates it (`warn` with levels info / confirm / block and a field path), adds its ledger entries to the
posting plan, and rewrites the derived rows in the voucher's own transaction (clear + write, with the
voucher date / affects_books / is_post_dated — the books filter applies exactly as for `gst_lines`).
Optional, cancelled and memorandum vouchers keep their rows with `affects_books = 0`, so nothing counts.

| Voucher | Detail | Posting added by the hook | Derived rows → returns |
|---|---|---|---|
| Receipt | `advance { supplyType, rate, cessRate?, placeOfSupply?, amount? }` | services: Dr GST on Advances Received / Cr Output tax (amount treated as tax-inclusive) — goods: none (N/N 66/2017-CT) | `gst_advance_lines` 'received' → GSTR-1 11A, 3B 3.1(a) |
| Sales / debit note to a customer | `advanceAdjustments [{ receiptVoucherId, amount }]` — default: every bill-wise "Against" allocation on an advance bill created by a receipt with GST | Dr Output tax / Cr GST on Advances (proportionate share of the advance's tax) | 'adjusted' → 11B, 3B 3.1(a) net |
| Payment | `advanceRefund { receiptVoucherId, amount }` (refund voucher, Rule 51) | as above | 'refunded' → 11B |
| Payment | `challan { cpin, cin?, brn?, challanDate?, bankName?, mode?, period?, heads[] }` | none — the user debits "GST Electronic Cash Ledger" (or `gst.challan.post` builds the voucher) | `gst_challans` + `gst_stat_lines` 'cash_deposit' |
| Purchase from an overseas supplier / SEZ unit (goods) | `billOfEntry { number, date, portCode?, assessableValue, customsDuty?, igst, cess? }` | regular: Dr Input IGST (+cess) / Cr IGST Payable on Imports (Customs); composition, or goods whose ITC is blocked (lines marked ineligible): the IGST is a cost (Dr the ledger of the goods / asset), `itc_claimed` 0. One bill of entry cannot mix blocked and eligible lines (refused: enter them as separate purchases) | `gst_bill_of_entry` → 3B 4(A)(1) (the BOE figure replaces the tax computed on the invoice; blocked goods are also reversed in 4(B)(1)), GSTR-9 6E (blocked: 7E), `gst.boe.*` |
| Journal | `adjustment { nature, period?, taxableValue? }` | the lines as entered (validated per nature) | `gst_stat_lines` → 3B 4(B)(1) / 4(B)(2) / 4(A)(5)+4(D)(1) / 3.1(d)+4(A)(3) |
| Journal | `setoff { period, cash[], credit[] }` | built by `gst.setoff.post` only | 'itc_utilised' / 'cash_utilised' → electronic ledgers, CMP-08 table 4 |

A receipt whose advance is adjusted or refunded cannot be deleted / cancelled while those vouchers
stand, nor altered so that they no longer fit: made optional, the advance removed (or turned into goods),
its amount lowered below what they used, or its rate / cess rate / place of supply changed (raising the
amount or changing the narration is fine). An advance (`amount`) larger than the cash / bank received on
the receipt is refused. The system ledgers created on demand (GST on Advances Received, IGST Payable on
Imports, GST Electronic Cash Ledger, Interest / Late Fee / Penalty, Composition Tax) are audited. `vouchers.duplicate` keeps only an advance's rate and a stat-adjustment nature (a challan, a
set-off, a bill of entry and the advances used belong to the source).

## 12. Advances (`advances.ts`)

Time of supply for services is the earlier of invoice and receipt of payment (s.13 CGST Act), so tax is
due on an advance; suppliers of goods (other than composition taxpayers) are exempt from tax on
advances by Notification 66/2017-CT (15-11-2017). `advanceTax(amount, rate, cessRate, inter)` treats the
amount as inclusive: base = round(amount × 100 / (100 + rate + cess)), tax split CGST = SGST (or
IGST inter-state) on that base, and taxable = amount − tax so the parts add up to the amount. Place of
supply: the given state, else the party's, else the company's. Adjustment / refund takes the advance's
tax proportionately; the use that exhausts the advance takes exactly what is left, so the advance's tax
is reversed to the paisa. Table 11A / 11B group by POS
and rate (`supplyKind` INTRA / INTER for the portal's `sply_ty`). Following the GSTR-1 instructions (11A:
advance "for which invoice has not been issued in the same tax period"; 11B: advance "received in
earlier tax period" adjusted now), an advance received and adjusted / refunded within the same return
period is in neither table — only its part still unadjusted at the period end is in 11A (the register's
`vouchers` list still shows every line, and the tax effect is the same). GSTR-1 JSON `at` / `txpd` use them,
3B 3.1(a) carries 11A − 11B and GSTR-9 4F the year's 11A − 11B. Composition taxpayers are refused (they pay on turnover via CMP-08).

## 13. Stat adjustments: ITC reversal / reclaim, reverse charge (`hook.ts`, `bookAdjustments.ts`)

Natures (`GST_ADJUSTMENT_NATURES`) and the 3B row each reaches (current GSTR-3B layout):

| Nature | Rule | GSTR-3B | Lines |
|---|---|---|---|
| `itc_reversal_r42` / `r43` | Rules 42 / 43 (common inputs / capital goods) | 4(B)(1) | Cr Input tax, Dr expense / asset |
| `itc_reversal_r38` | Rule 38 (banking company, 50%) | 4(B)(1) | Cr Input tax |
| `itc_reversal_s17_5` | s.17(5) blocked credit | 4(B)(1) | Cr Input tax |
| `itc_reversal_r37` | Rule 37 — supplier not paid within 180 days (reclaimable on payment) | 4(B)(2) | Cr Input tax |
| `itc_reversal_r37a` | Rule 37A — supplier did not file GSTR-3B by 30 Sep following the year | 4(B)(2) | Cr Input tax |
| `itc_reversal_others` | other temporary reversals | 4(B)(2) | Cr Input tax |
| `itc_reclaim` | reclaim of a Rule 37 / 37A / temporary reversal | 4(A)(5) and 4(D)(1) | Dr Input tax |
| `rcm_liability` | reverse charge entered by journal (e.g. import of services) | 3.1(d) (value = `taxableValue`) and 4(A)(3) | Cr "… Payable (Reverse Charge)", Dr Input tax (regular) / an expense (composition) |

The hook refuses Output ledgers in an adjustment, reversals / reclaims for a composition taxpayer and a
reverse-charge journal without the RCM payable lines; it asks to confirm a journal dated outside the
chosen period. Interest (s.50) and late fee are entered in GSTR-3B "Your entries" (or CMP-08 interest)
and paid through the set-off. Rule 37's 180-day test is run by GST › Rule 37 (§19), which posts the
reversal / reclaim journal through this mechanism; `adjustment.rule37` lists the purchase invoices
(stored in `gst_rule37_links`; their per-head sums must equal the journal's Input tax lines; a
duplicate (Alt+2) keeps the nature, never the invoices).

## 14. Set-off, challans and electronic ledgers (`setoff.ts`, `setoffPost.ts`, `eledgers.ts`)

`gst.setoff.compute` takes GSTR-3B 6.1 for a regular taxpayer — liability per head (3.1(a)+(b) incl.
advances and the amendments of filed periods), credit 4(C) plus the balance brought forward, utilised in
the s.49(5) / Rule 88A order (IGST credit first against IGST, then CGST and SGST in any proportion; CGST
credit against CGST then IGST, never SGST, and vice versa; cess only against cess) — and adds the cash
items: reverse-charge tax (always cash, s.49(4)), interest and late fee from the 3B entries, penalty and
others typed on the screen. For a composition taxpayer it takes CMP-08 (everything in cash). Cash is
shown per major head (IGST / CGST / SGST-UTGST / cess) × minor head (tax / interest / penalty / fee /
others), with what the electronic cash ledger already holds and what is still to deposit (once the
period's set-off is posted, the cash it used still counts as available to it, so nothing is asked twice).
The set-off can be posted before the challan (the screen warns; the cash ledger shows a negative balance
until the challan is recorded).

**Credit not in the books** (the GSTR-3B entry `creditLedgerBalance`, e.g. the portal balance when the
books started) is credit the Input tax ledgers do not hold. The set-off journal credits the Input ledgers
only with what they hold for the period (`bookInputCredit`: their balance from vouchers dated up to the
period's end plus the set-off journals posted on or before the set-off date); the rest of the credit
utilised is credited to the system ledger **GST Credit Not in Books** (Loans & Advances (Asset),
`GST_CREDIT_OUTSIDE`, created on demand and audited) — so an Input ledger is never driven into credit.
Give that ledger an opening balance (or a journal) for the credit the portal held; the screen says so.

`gst.challan.post` records a PMT-06 challan: one Payment voucher Dr "GST Electronic Cash Ledger" / Cr
the bank, with CPIN (14 digits), CIN (17 characters, after payment), BRN, date, bank, mode and the
head-wise amounts. `gst.setoff.post` posts one Journal per period (CONFLICT when it already exists — alter
or delete that journal to post again):

```
Dr Output IGST / CGST / SGST / Cess     liability discharged
Cr Input <head>                         credit utilised (a negative 4(C) is a Dr, paid in cash)
Dr <head> Payable (Reverse Charge)      reverse-charge tax
Dr Interest on GST / Late Fee on GST Returns / GST Penalty and Other Dues
Dr Composition Tax (GST)                CMP-08
Cr GST Electronic Cash Ledger           total cash utilised (major × minor in gst_stat_lines)
```

Both go through the vouchers service (numbered, audited, period-lock aware). A journal carrying
`gstDetails.setoff` is refused if a credit row breaks s.49(5) (CGST → SGST, SGST → CGST, cess ↔ other
heads) or its cash rows differ from the credit to "GST Electronic Cash Ledger". **Electronic cash ledger**
(`gst.ledger.cash`): opening / deposited / utilised / closing per major × minor head from challans and
set-off journals, with the books balance of "GST Electronic Cash Ledger" for comparison. **Electronic
credit ledger** (`gst.ledger.credit`): per head from the Input tax ledgers — opening (incl. opening
balances), accrued (debits: purchases, RCM, BOE, reclaims), reversed (credits other than set-off),
utilised (set-off credits), closing — with every movement listed, signed as on the Input ledgers
(accrued Dr, reversed / utilised Cr) so the movements add up to closing − opening; the opening is one
aggregate per ledger. The portal's ledgers are the legal record; the screens say so.

## 15. Composition (`composition.ts`)

The company's registration type (Company › GST details) decides everything: sales are Bills of Supply
with no tax (vouchers / print: "Composition taxable person, not eligible to collect tax on supplies"),
supplier tax is a cost, GSTR-1 / 3B / GSTR-9 / ITC / e-invoice are hidden from the GST menu
(`gstRegistrations` filter) and refuse filing marks; CMP-08 and GSTR-4 are shown instead.

**Rate master** `gst_composition_rates` (effective-dated, editable — GST › Composition Rates), seeded:
manufacturers 2% (1-7-2017) → 1% (1-1-2018, N/N 3/2018-CT); traders 1% of turnover (1-7-2017) → 1% of
*taxable* turnover (1-1-2018); restaurants 5%; s.10(2A) service providers 6% (N/N 2/2019-CT(R),
1-4-2019) — each half CGST, half SGST/UTGST. The turnover basis of the 6% scheme is our reading
(flagged in the seed comment); notified-goods exclusions (e.g. ice-cream, pan masala, tobacco) are the
user's responsibility (such dealers cannot opt in). The rate effective on each document's date applies.

**CMP-08** (quarterly, due the 18th of the month after the quarter — Rule 62): table 3 (1) outward
supplies incl. exempt → composition tax on the tax base; (2) inward supplies attracting reverse charge
incl. import of services → tax at the normal rates (RCM purchases + `rcm_liability` journals); (3) = 1 +
2; (4) interest (typed). Table 4 "paid" = the cash utilised by the quarter's set-off journal. **GSTR-4**
(annual, due 30 April after the year from FY 2021-22): 4A registered non-RCM (by supplier), 4B registered
RCM (by supplier), 4C unregistered (by rate), 4D import of services (by rate); 5 = CMP-08 per quarter; 6
rate-wise outward at the composition rate and inward RCM; 8 tax payable and paid. Table 7 (TDS / TCS
credit) is not kept. **Files:** the portal has no CMP-08 upload and its GSTR-4 offline-tool schema is
not reproduced (we do not guess it): `gst.cmp08.export` / `gst.gstr4.export` save our own documented
format — JSON `{ format: 'bahi-cmp08/1' | 'bahi-gstr4/1', gstin, ret_period / fy, table… }` with rupee
amounts, or CSV with the same rows — to copy into the portal.

## 16. Filing status and GSTR-1 amendments (`filings.ts`)

`gst.filing.mark` records that a return was filed (date not before the period's end nor in the future,
ARN optional) with a snapshot of its summary. A **filed GSTR-1** period is protected:

- altering one of its outward documents asks to confirm, then logs the original (as filed) and amended
  snapshot in `gst_amendments`, reported in the **amendment period** — the first later period not filed
  (normally no later than the working date's period; never a filed one) — as 9A (B2B / B2CL / exports), 9C (CDNR / CDNUR) or 10 (B2C
  small). The JSON carries the registered-buyer amendments (`b2ba`, `cdnra`, with the original number
  and date); B2CL / export / CDNUR / B2C-small amendments are listed on screen (GST › GSTR-1
  Amendments) to enter on the portal;
- a document dated in the filed period but entered later is logged as *added* and reported in the
  amendment period with its original date;
- deleting or cancelling a reported document is refused (issue a credit note, or alter it);
- the filed period's GSTR-1 totals and GSTR-3B 3.1 keep the figures as filed; the difference flows into
  the amendment period's 3B (`amendmentCorrections`);
- `gst.filing.unmark` is refused while amendments point at the period.

## 17. IRP / e-way bill: why there is no direct API call

Generating an IRN or an e-way bill through the NIC / IRP APIs needs API credentials issued to a GSP or
ASP (or the taxpayer's own API access with a whitelisted IP and client secret) and a live internet
connection; Bahi is offline-first and does not hold GSP credentials, so it makes no network calls. The
supported round trip is:

1. **Generate JSON** — e-Invoice (Alt+J) / e-Way Bills (Alt+J): the IRP schema 1.1 bulk file or the
   e-way bill bulk `billLists` file for the selected vouchers (`gst.einvoice.json`, `gst.ewaybill.json`).
2. **Upload** on the IRP (einvoice1.gst.gov.in › Bulk Upload, or the offline tool) / the e-way bill
   portal (ewaybillgst.gov.in › Bulk Generation).
3. **Download** the response: the IRP's signed JSON / Excel with IRN, Ack no., date and signed QR; the
   e-way bill numbers.
4. **Import / record** — e-Invoice › Alt+I imports the IRP response (`gst.einvoice.importResponse`:
   IRN, ack, signed QR stored on each voucher, printed on the invoice); e-Way Bills › Alt+N records the
   EWB number, date and validity (`gst.ewaybill.update`). Every step is in the document trail (Alt+H).

IRN cancellation within 24 hours and the 30-day reporting limit for AATO ≥ ₹10 crore are shown on the
screens; enforcing them is the portal's job. An optional online connector (main process only, opt-in,
credentials in Electron safeStorage) is the documented next step.

## 18. Changes after GSTR-3B is filed (`filed3b.ts`, migration 240)

A period whose **GSTR-3B** is marked filed is protected like a filed GSTR-1 period:

- altering a voucher of that period whose GSTR-3B effect is not nil (purchases and their ITC, ITC
  reversal / reclaim and reverse-charge journals, bills of entry, advances, outward documents whose
  GSTR-1 is not filed) asks to confirm ('gst_amendment' warning); a voucher entered later but dated in
  the filed period, and a deleted / cancelled one, are logged too (`gst_3b_changes`: the voucher's 3B
  effect before and after — `voucherEffect`, computed with the same `accumulate()` / `bookAdjustments`
  as GSTR-3B);
- the change is reported in the **first later period whose GSTR-3B is not filed** (normally at most the
  working date's period); the filed period keeps its filed figures (`gstr3bChangeCorrections`, used by
  `computeGstr3b`; summed over all periods the corrections are zero). In the reporting period, tax
  changes are in 3.1 (a reduction nets against that period's supplies), more credit is in 4(A), less
  credit is a reversal in 4(B)(2) (GSTR-3B takes no negative 4(A)); a reversal undone is a reclaim
  (4(A)(5) + 4(D)(1));
- outward documents of a period whose GSTR-1 is filed are left to the GSTR-1 amendments (§16), which
  already move their 3.1 figures — never counted twice; a voucher already in the log is kept current
  silently on every later save;
- `gst.gstr3b.changes` lists the log by reporting period (screen GST › Changes after GSTR-3B Filing);
  `gst.filing.unmark` is refused for a GSTR-3B period that changes point at.

## 19. Rule 37 — purchases not paid within 180 days (`rule37.ts`)

CGST Act s.16(2) second proviso / Rule 37: credit on an invoice the supplier was not paid (value + tax)
within 180 days of its date is reversed, in proportion to the unpaid part, in GSTR-3B 4(B)(2) for the
period following the one in which the 180 days end, with interest u/s 50; it is re-availed (4(A)(5) +
4(D)(1)) once paid (Rule 37(4)). `gst.rule37.report` (as on a date) lists every purchase in the books —
B2B forward charge (natures `inward_b2b`, and `inward_sez` services), credit not marked ineligible —
whose 180th day has passed, with the unpaid part of **its own bill** (bill-wise: payments, debit notes
and TDS set against it, dated up to the as-on date), credit due to stand reversed
(credit × unpaid ÷ invoice value, per head), already reversed (net of reclaims, `gst_rule37_links`),
**reverse now** and **reclaim now**. Suppliers kept without bill-wise details are listed apart (check by
hand). `gst.rule37.post` (gst.file) posts the reversal (Dr ITC Reversed (GST) / Cr Input tax) or the
reclaim (Dr Input tax / Cr ITC Reversed (GST)) as one Journal with `gstDetails.adjustment`
(`itc_reversal_r37` / `itc_reclaim` + `rule37[]`), through `saveVoucher` (numbered, audited,
period-lock aware). Interest u/s 50 is not computed: enter it under GSTR-3B "Your entries". Screen:
GST › Rule 37 (180 Days) — Alt+R post reversal, Alt+L post reclaim.
