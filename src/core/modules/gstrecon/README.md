# gstrecon — GST reconciliation (GSTR-2B / GSTR-2A vs purchases, GSTR-1 vs sales)

Imports the GST portal's files, pairs every portal document with the voucher it belongs to, explains
each difference field by field, and keeps the accountant's manual decisions (links, accepts, ignores)
across re-runs and re-imports. DTOs: `src/shared/types/gstrecon.ts`. UI: `gstrecon.home`.

| File | What |
|---|---|
| `parsers.ts` | entry point: sniffs JSON / ZIP / XLSX, refuses the wrong return, merges multi-part ZIPs |
| `portal-json.ts` | GSTR-2B, GSTR-2A and GSTR-1 JSON → `ParsedPortalDoc[]` (pure) |
| `portal-xlsx.ts` | GSTR-2B / 2A Excel (multi-row headers found by fuzzy heading match, rows per rate aggregated) |
| `portal-common.ts`, `values.ts` | parsed-document type, grouped warnings, amounts/dates/states/periods parsing |
| `docno.ts` | document-number normalisation + Levenshtein |
| `books.ts` | books side from `vouchers` + `gst_lines` (never recomputed), books filter |
| `matcher.ts` | the pure, deterministic reconciliation engine |
| `store.ts`, `service.ts`, `queries.ts`, `export.ts` | persistence, import/run/decisions, read models, Excel/CSV and follow-up e-mail |
| `routes.ts` | route registrations |
| `testkit.ts` | test fixtures (portal-file builders, direct voucher writer, matcher records) |

Migration `100_gstrecon.ts` adds `section, doc_key, supplier_period, filing_date, meta` to
`gst_portal_docs` and the tables `gstrecon_decisions`, `gstrecon_books_only`, `gstrecon_runs`.

## File formats

All amounts arrive in rupees and are stored as integer **paise**; dates become ISO; places of supply
become 2-digit state codes ('27', '27-Maharashtra', 'Maharashtra', 'MH' → '27'); document types are
normalised to `invoice | credit_note | debit_note` (2B `typ` C/D, 2A `ntty`, Excel "Credit Note").
A file is read with a UTF-8 BOM or without; `.xls` (Excel 97-2003), HTML error pages, empty and
truncated files are refused with a `FileFormatError` that says what to do.

| Source | Accepted | Reconciled sections | Counted as "not reconciled" |
|---|---|---|---|
| GSTR-2B JSON | `{ data: { gstin, rtnprd, gendt, docdata } }` or `docdata` at the root; multi-part ZIP of JSONs | `b2b`, `b2ba`, `cdnr`, `cdnra` (`inum`/`ntnum`, `dt` dd-mm-yyyy, `val`, `pos`, `rev`, `itcavl`, `rsn`, `diffprcnt`, `srctyp`, `irn`, `irngendate`, `items[{rt, txval, igst, cgst, sgst, cess}]`; supplier `ctin`, `trdnm`, `supprd`, `supfildt`) | `isd`, `impg`, `impgsez`, … |
| GSTR-2A JSON | `{ gstin, fp, b2b:[{ ctin, cfs, inv:[{ inum, idt, val, pos, rchrg, inv_typ, itms:[{ itm_det:{ rt, txval, iamt, camt, samt, csamt } }] }] }], cdn \| cdnr, b2ba, cdna }` | `b2b`, `b2ba`, `cdn`/`cdnr`, `cdna`/`cdnra` | `tds`, `tcs`, `isd`, `impg`, … |
| GSTR-2B / 2A Excel | sheets `B2B`, `B2BA`, `B2B-CDNR`, `B2B-CDNRA`; title rows + two-row header with merged groups ("Invoice Details" › "Invoice number"…, "Tax Amount" › "Integrated Tax(₹)"…); one row per rate | rows of one document (type + GSTIN + number + date) are summed, value taken once; period/GSTIN from the "Read me" sheet (`Financial Year` + `Tax Period`) | `ISD`, `IMPG`, … sheets |
| GSTR-1 JSON | portal download or Pevqori's own export | `b2b`, `b2ba`, `b2cl`, `b2cla`, `cdnr`, `cdnra`, `cdnur`, `cdnura`, `exp`, `expa` | `b2cs`, `hsn`, `nil`, `doc_issue`, … |

The file kind is detected (2B has `docdata`/`rtnprd`; 2A has `cfs`/`cdn`/`tds`…; GSTR-1 has
`b2cs`/`hsn`/`exp`…); choosing the wrong source is a VALIDATION error on `source`. A file of another
GSTIN is refused; a ZIP mixing periods or GSTINs is refused. Documents without a GSTIN, number or a
valid date are skipped with one grouped warning per problem ("… (and 41 more like it)").

## Books side

Inward (2A/2B): purchases, purchase returns (debit notes = the supplier's credit notes) and purchases
booked against an original invoice (= supplier debit notes) from suppliers with a GSTIN; imports,
unregistered/composition suppliers and nil/exempt-only documents are left out. A purchase from an
SEZ unit is matched on its **services** lines only: SEZ goods are an import on a bill of entry
(GSTR-2B `impgsez`, not `b2b`; IGST paid at customs — see vouchers README §3), so they are neither
expected in 2B B2B nor reported `missing_in_portal`. Document no. =
supplier invoice no. (`reference_no`, else the voucher number); date = `reference_date`, else the
voucher date (noted on the row). Outward (GSTR-1): sales, credit and debit notes reported
invoice-wise (B2B, SEZ, deemed export, B2CL, exports). Only vouchers in the books count:
`affects_books = 1 AND (is_post_dated = 0 OR date <= today)` — optional, cancelled and future
post-dated vouchers never match. Values are sums of `gst_lines`; ITC excludes lines marked ineligible.

## Document-number normalisation

| Level | Rule | Examples |
|---|---|---|
| exact (`fuzzyDocNo: false`) | upper-case, whitespace removed | `inv 77` ≡ `INV77` |
| 1 (default) | upper-case; split on spaces `/ \ - _ .` and dashes; strip leading zeros of every digit run **per part**; join | `INV/001/25-26` ≡ `inv-1-2526` → `INV12526`; `INV/1/02` (`INV12`) ≠ `INV/10/2` (`INV102`) |
| 2 (only when it makes the pair unique) | level 1 after removing stand-alone financial-year parts: `2025-26`, `25-26`, `25/26`, `2025-2026`, `2526`, `20252026`, `FY2526`, `FY 25-26` (consecutive years 2017–2060); never removes the only number | `INV/001/25-26` ≡ `inv-1-2526` ≡ `INV1` |

Level 2 is used only when exactly one portal document and one voucher of the supplier share the
year-free key, so `INV/1/25-26` and `INV/1/26-27` never collapse onto a bare `INV1`.
An invoice/debit note and a credit note never pair (`class` inc/dec is part of the key).

## Matching passes and statuses

1. **Manual links** always win (survive re-runs and re-imports; keyed by GSTIN | class | normalised number).
2. **Exact key** against vouchers of the period, one-to-one (closest amounts first).
3. **Year-free key**, only when unique on both sides.
3b. **Amendments** (B2BA / CDNRA) whose number changed: the voucher still carries the original number
   (`oinum` / `ontnum`, Excel "Original … number"); exact, then year-free key, in the period or within
   the other-period window, only when exactly one voucher qualifies (method `original_no`, with a note).
4. **Other periods**: unpaired portal documents pair with vouchers dated within 183 days outside
   the period (supplier filed late / booked in another month) — info difference "Booked in period".
   A voucher that the last run of another month (±6) already paired is **not** taken again — the
   supplier reported the document in two returns: the row is `duplicate` with `otherPeriod` and
   `duplicateOfDocId` (the other month's document), no voucher, and is not counted as ITC not booked.
   Amendments (B2BA, CDNRA …) may take such a voucher. A voucher of the period that another month also
   took is matched with a warning note.
5. Leftovers: portal → `missing_in_books`; books of the period → `missing_in_portal`; if another
   imported batch of the same source ±2 months has the document, the row carries `otherPeriod`
   ("Reported on the portal in May 2026"; results filter `other_period`).

| Status | Meaning |
|---|---|
| `matched` | paired; every head within tolerance, no mismatch |
| `partial` | paired; at least one **mismatch**: taxable/IGST/CGST/SGST/cess beyond tolerance, date beyond `dateDays`, place of supply, rate, reverse charge, ITC not available (2B `itcavl = N`, with the reason) or GSTIN (manual links); document type for GSTR-1, and always when a credit note faces an invoice/debit note |
| `missing_in_books` / `missing_in_portal` | one side only |
| `duplicate` | two or more vouchers carry the supplier + number (the portal row pairs with the closest, `duplicateVoucherIds` lists the rest), the portal lists the document twice (`duplicateOfDocId`), or another month's return already took the voucher (`otherPeriod` + `duplicateOfDocId`) |
| `accepted` | the user accepted the difference (`baseStatus` keeps the computed status; accepting a matched row changes nothing) |
| `ignored` | excluded from follow-up |
| `pending` | imported, not reconciled yet |

Info differences (spelling of the number, invoice value, books period, amounts within tolerance)
are shown but do not change the status.

**Probable matches** (`gstrecon.suggestions`, `suggestionCount`) are never linked automatically:
same GSTIN and class, `taxable + tax` within the amount tolerance, and document numbers within
2 edits (Levenshtein on level 1) **or** the same date. Score = 100 − 15 × edits − |days| (max 30) −
10 × amount difference / tolerance, clamped 1–100; best first, top 10.

## Tolerance

`{ amountPaise = 100, dateDays = 0, fuzzyDocNo = true }`. `|portal − books| ≤ amountPaise` per head
is a match: with the default ₹1.00 a difference of exactly ₹1.00 is **matched** (info), ₹1.01 is
**partial**. `dateDays` is the allowed date difference in days. The run stores its tolerance;
decisions re-run with the last run's tolerance.

## Summary figures

Portal amounts are signed (invoices/debit notes +, credit notes −), books likewise (purchases +,
purchase returns −); differences are `portal − books`.
- `portalItc` — 2B documents with ITC available; `booksItc` — eligible tax of the period's vouchers.
- `itcAtRisk` — `missingInPortal` (books ITC of missing-in-portal invoices) + `excessInBooks` (head-wise
  books ITC > portal on partial/duplicate invoice pairs; for credit-note pairs, the note reduces more
  than the purchase return) + `itcNotAvailable` (books ITC on pairs the 2B marks "not available") +
  `creditNotesNotBooked` (supplier credit notes with ITC available that have no purchase return in the
  books — ITC to reverse).
- `itcNotBooked` — `missingInBooks` (portal tax of missing-in-books invoices with ITC available) +
  `shortInBooks` (head-wise portal > **tax booked** on partial/duplicate pairs — measured on the tax
  booked, so credit blocked under s.17(5) is not reported as "not booked"; for credit-note pairs, the
  return reduces more than the note).
- The ITC figures follow the **computed** status (`baseStatus`): accepting or ignoring a row records the
  decision but does not put the document on the portal, so its ITC stays at risk / not booked.
- `stale` — a newer import; a voucher entered/altered after the last run whose document or voucher date
  lies in the run's window (period ± 183 days) or that is on one of the rows; a paired or
  missing-in-portal voucher deleted after the run. Vouchers of unrelated months do not make the result stale.

## Routes

Reads and the follow-up e-mail need `gst.view`; the export needs `gst.view` + `data.export` (so read-only
roles such as Auditor can export); imports, runs and decisions need `gst.file`. Import, run,
compare, exports and reads are `transactional: false` (import/run open their own transaction).
Every mutation is audited (`import`/`delete` on `gst_import_batch`, `alter` on `gst_portal_doc` or
`voucher`, `export` on `gst_reconciliation`).

| Route | Input → output |
|---|---|
| `gstrecon.import` | `{ source: 'gstr2b'\|'gstr2a'\|'gstr1', period?: MMYYYY (GSTR-1 also 'YYYY-YY-Qn', stored under the quarter's last month as GSTN files it), fileName, bytes, replace? }` → `ReconImportResult`. Period auto-detected; a different chosen period → VALIDATION; same source + period again without `replace` → CONFLICT with `ReconImportConflict` (both counts); `replace` drops the old batch and its results, keeps decisions |
| `gstrecon.batches` | `{ period?, source? }` → `ImportBatchView[]` |
| `gstrecon.batch.delete` | `{ id }` → `{ id, deletedDocs }` |
| `gstrecon.run` | `{ period, source, tolerance?: { amountPaise?, dateDays?, fuzzyDocNo? } }` → `ReconSummary` |
| `gstrecon.gstr1.compare` | `{ period (MMYYYY or 'YYYY-YY-Qn'), tolerance? }` → `ReconSummary` (GSTR-1 vs sales books) |
| `gstrecon.runs` | `{ period, source }` → `ReconRunView[]` (last 20) |
| `gstrecon.summary` | `{ period, source }` → `ReconSummary` |
| `gstrecon.results` | `{ period, source, status?: ReconStatusFilter, supplierGstin?, search?, limit?, offset? }` → `ReconResultsPage` (`counts` ignore status/search) |
| `gstrecon.supplierSummary` | `{ period, source }` → `SupplierReconRow[]` (open rows first) |
| `gstrecon.suggestions` | `{ portalDocId }` or `{ voucherId, period, source }` → `ReconSuggestion[]` |
| `gstrecon.link` | `{ portalDocId, voucherId }` → `ReconRow` (re-runs; CONFLICT if the voucher is linked to another document; BUSINESS_RULE for cancelled/optional/non-GST vouchers and for a credit note against a purchase/sale or the reverse) |
| `gstrecon.unlink` | `{ portalDocId }` or `{ voucherId, period, source }` → `ReconRow \| null` (removes link/accept/ignore) |
| `gstrecon.accept`, `gstrecon.ignore` | `{ portalDocIds?, voucherIds?, period?, source?, remarks? }` → `ReconDecisionResult` |
| `gstrecon.export` | `{ period, source, format: 'xlsx'\|'csv' }` → `{ fileName, bytes }` — Excel sheets Summary, Matched, Partial, Missing in Books, Missing in Portal, Duplicates, Accepted & Ignored, Supplier-wise; amounts in **rupees** |
| `gstrecon.supplierFollowUp` | `{ period, supplierGstin, source?: 'gstr2b'\|'gstr2a' }` → `SupplierFollowUp` (plain-text e-mail: documents to report, documents reported in another month (information only), differences the supplier can correct — not our own duplicate entries — and documents we could not find; GSTR-1 → VALIDATION) |

## Tests

`node --test "src/core/modules/gstrecon/**/*.test.ts"` — parsers on hand-written JSON/XLSX/ZIP
fixtures, values, normalisation, the pure matcher (statuses, tolerance boundaries, duplicates,
other periods, suggestions, decisions, determinism), routes end-to-end (dedupe/replace, summary
figures verified by hand, decisions surviving re-runs and re-imports, exports read back with
`readXlsx`, permissions) and purchases/returns/sales posted through the vouchers service.
