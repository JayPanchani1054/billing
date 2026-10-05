# GST module: returns, registers, e-invoice, e-way bill

This module turns the GST rows written by the posting engine into returns and compliance files:
GSTR-1 (summary, drill-down, JSON), GSTR-3B (summary, manual entries, JSON), GSTR-9 (annual summary),
GST registers, HSN summary, ITC and exceptions, and e-invoice / e-way bill bulk files.

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
| `testkit.ts` | Test helpers: direct SQL inserts + the April-2026 dataset (tests only) |
| `gstr1.golden.json` | Reviewed GSTR-1 JSON of the dataset (snapshot test) |

Migration `090_gst.ts` adds:
- `gst_adjustments (form, return_period, data JSON, updated_at, updated_by)`: manual GSTR-3B entries;
- `gst_doc_events (voucher_id, kind einvoice|ewaybill, action, ref_no, detail JSON, ts, user)`: the e-invoice / e-way bill trail (the voucher row keeps the current state);
- an index on `gst_lines(date, affects_books, voucher_id)`.

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
| `gst.einvoice.json` | **file** | `{ voucherIds }` (1–1000) | `GstBulkJsonFile { fileName, json (array of IRP documents), documents, rejected[], warnings }` — logged per voucher + audited |
| `gst.einvoice.importResponse` | **file** | `EinvoiceImportInput { fileName, bytes }` (JSON or .xlsx) | `EinvoiceImportResult { records, updated, unchanged, skipped, failed, warnings }` — each voucher change audited |
| `gst.einvoice.markCancelled` | **file** | `{ voucherId, reason }` | `GstDocStatusResult` — audited (`cancel`, `einvoice`) |
| `gst.ewaybill.pending` | view | `{ from, to }` | `EwayPendingResult { enabled, thresholdPaise, rows: EwayPendingRow[] }` |
| `gst.ewaybill.json` | **file** | `{ voucherIds }` | `GstBulkJsonFile` (`{ version, billLists }`) — logged + audited |
| `gst.ewaybill.update` | **file** | `EwayUpdateInput { voucherId, ewayBillNo (12 digits), date, validUpto? }` | `GstDocStatusResult` — audited |
| `gst.docEvents` | view | `{ voucherId }` | `GstDocEvent[]` (e-invoice / e-way bill trail) |
| `gst.gstr9.summary` | view | `{ fy: '2026-27' }` | `Gstr9Summary` (caption "Prepared from books — verify before filing") |

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
  = to − from + 1 for numeric series, cancelled = cancelled vouchers **+ numbers missing in the range**
  (deleted vouchers; also flagged), net = total − cancelled. doc_num 1 sales, 4 debit notes, 5 credit
  notes. Repeating numbers (monthly restart) are split per month.
- **Table 11 (advances)**: not derived (receipts carry no rate / POS) — empty with a note.
- **Amendments (9A, 9C, 10, 11B(2)) are out of scope**: amend on the portal.
- **Totals** (`Gstr1Summary.totals`): net tax of all sections except 4B (recipient pays) → compare with
  GSTR-3B 3.1(a) + 3.1(b).

### Uncertain transactions (`checks.ts`; also in `gst.exceptions`)

| Code | Severity | When | Fix hint |
|---|---|---|---|
| `gstin_missing` / `gstin_invalid` | error | registered-party table (4A/4B/6B/6C/CDNR) without / with an invalid GSTIN | correct the party ledger, re-save |
| `b2c_with_gstin` | warning | B2C table but the party has a valid GSTIN | set registration Regular |
| `hsn_missing` / `hsn_short` | error | a valued line without HSN/SAC, or shorter than `hsnDigits` | set HSN in the item / ledger |
| `hsn_invalid` | warning | non-digits, not 4/6/8 digits, service without 99 | |
| `pos_missing` | error | no place of supply (not exports) | |
| `note_without_original` | warning | note without original invoice no., or not found in the books | |
| `doc_no_missing` / `doc_no_invalid` | error | > 16 characters, characters other than A–Z 0–9 / -, or no letter/non-zero digit | |
| `doc_series_gap` | warning | numbers missing in a series (Table 13) | |
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
| 4(A)(1) IMPG | `import_goods` (+ goods from SEZ) |
| 4(A)(2) IMPS | `import_services` |
| 4(A)(3) ISRC | other reverse-charge inward lines |
| 4(A)(4) ISD | manual `itcIsd` |
| 4(A)(5) OTH | all other inward taxable lines (+ manual `itcReclaimed`), **net of purchase returns** |
| 4(B)(1) RUL | ITC on lines marked `ineligible` (s.17(5), from the books) + manual `itcReversalRules` (rules 38/42/43) |
| 4(B)(2) OTH | manual `itcReversalOthers` |
| 4(C) | 4(A) − 4(B) |
| 4(D)(1) | manual `itcReclaimed` (information; the amount is also in 4(A)(5)) |
| 4(D)(2) | manual `itcIneligibleOthers` (s.16(4), PoS) |
| 5 | inward exempt + nil + composition-supplier supplies (`GST`), non-GST (`NONGST`), inter / intra |
| 5.1 | manual `interest` (all heads), `lateFee` (CGST, SGST) |
| 6.1 | forward-charge liability = tax of 3.1(a) + 3.1(b) (never below 0; a negative 4(C) is added) set off against 4(C) (never below 0) + manual `creditLedgerBalance`; reverse-charge tax (3.1(d)) paid in **cash** |

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
manual entries saved for each month); tables 17 / 18 are the HSN summaries; `months` lists each month's
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

- Amendment tables, advances (table 11 / 4F), e-commerce operator supplies (3.1.1, GSTR-1 table 14/15)
  and ISD are not derived from the books (manual entries / portal).
- Outward debit notes (supplementary invoices to customers) are supported when a debit note carries an
  outward nature, but the posting engine currently books every debit note as a purchase return.
- Quarterly filers: the quarterly GSTR-1 file contains the whole quarter; invoices already uploaded
  through IFF must not be uploaded again.
- The electronic credit ledger is not tracked: enter the balance brought forward as a manual 3B entry.
- e-Invoice signing / IRP API calls and e-way bill API calls are not made (offline JSON only); the PIN ↔
  state consistency the IRP checks is not validated locally.
- Purchases: e-way bills for inward supplies from unregistered suppliers and purchase returns are not
  listed as pending.
- Performance: the year's documents are read once for GSTR-9 (≈3 s for 24,000 vouchers / 72,000 GST
  lines in the dev container); monthly reports take a fraction of a second.
