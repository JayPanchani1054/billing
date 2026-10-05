# Vouchers module: the posting engine

This module turns a `VoucherInput` into books, stock and GST rows. Preview and save share **one** code path, `buildPosting()` in `posting.ts`.

Other modules (reports, GST returns, outstanding, banking, stock, print, UI) read the rows this module writes. This file is their contract.

DTO types live in `src/shared/types/vouchers.ts`. Money is integer **paise**. Ledger amounts are **signed: Dr +, Cr −**, and every voucher's `ledger_entries` sum to **exactly 0** (asserted before writing).

| File | Purpose |
|---|---|
| `routes.ts` | Route table + input schemas (`VoucherInputSchema`) |
| `service.ts` | preview / save (create + alter) / delete / cancel / setOptional / duplicate / nextNumber |
| `posting.ts` | The engine: input → `PostingPlan` (entries, inventory, bills, cost centres, gst_lines, header, warnings) |
| `taxprofile.ts` | GST rate resolution (precedence below), reusable via `dbTaxLookup(db)` |
| `numbering.ts` | Voucher types, number series, counters |
| `bills.ts` | Pending bills (opening bills + allocations, netted per bill name) |
| `guards.ts` | Negative stock / cash, credit limit, duplicate supplier invoice; `stockQtyAsOf`, `ledgerBalanceAsOf` |
| `masters.ts` | Per-call master cache: ledgers with group chain, items + unit/UQC, godowns |
| `queries.ts` | get / list / entryContext / partyContext / trackingRefs |
| `testkit.ts` | Test helpers (used by `*.test.ts` only) |

---

## 1. Routes

All routes are company scope. Types are in `shared/types/vouchers.ts`.

| Route | Access | Input | Output |
|---|---|---|---|
| `vouchers.entryContext` | vouchers.view | `{ voucherTypeId, date }` | `VoucherEntryContext`: voucher type (numbering, config), `nextNumber`, `allowedModes`/`defaultMode`, company essentials + FY, all features, config subset (`roundOff`, `guards`, `lockedUpTo`, `gst`, `printAfterSave`), reserved ledger ids (cash, sales, purchase, roundOff, output/input/rcm × IGST/CGST/SGST/CESS), `defaultLedgerId`, `mainGodownId`, `permissions {canAlter, canBackdate, canDelete}` |
| `vouchers.partyContext` | vouchers.view | `{ ledgerId, date, excludeVoucherId? }` | `PartyContext`: mailing/GST details, `kind` (debtor/creditor/cash/bank/other), bill-wise flag, credit days/limit, `balance` as of date (books filter), `pendingBills` |
| `vouchers.pendingBills` | vouchers.view | `{ ledgerId, asOf, excludeVoucherId? }` | `PendingBill[]` (see §5) |
| `vouchers.preview` | vouchers.view | `VoucherInput` | `VoucherPreview`. No writes. Never throws for rule violations or guards: they come back in `warnings` with `blocking: true`. Hard errors (unknown master, wrong mode, missing party…) still throw. |
| `vouchers.save` | vouchers.create (+ vouchers.alter when `id` is given; + vouchers.backdate when `date < today`) | `VoucherInput` | `VoucherSaveResult { id, number, warnings, totals, updatedAt }` |
| `vouchers.get` | vouchers.view | `{ id }` | `VoucherDetail`: header incl. snapshots and parsed JSON blobs, `voucherType {id,name,baseType}`, `mode`, `input` (the voucher as entered — edit it and send it back to `vouchers.save`; carries `id`, `number`, `expectedUpdatedAt`), `entries` (names, instrument, bank date, bill & cost allocations), `inventory` (item/unit/godown names), `gstLines`, `cancellation`, `createdBy`/`updatedBy` `{id,name}`, `updatedAt` |
| `vouchers.list` | vouchers.view | `VoucherListInput { from, to, voucherTypeIds?, baseTypes?, partyLedgerId?, ledgerId?, search?, includeOptional? (true), includeCancelled? (true), onlyPostDated?, sort? ('date_asc'), limit? (≤1000, default 200), offset? }` | `{ rows: VoucherListRow[], total, sums: { amount } }`. `search` matches number, reference no., narration, party name (case-insensitive, literal) or an exact amount ('1,180.00' = `total_amount`). |
| `vouchers.delete` | vouchers.delete | `{ id, reason? }` | `{ id, number }` |
| `vouchers.cancel` | vouchers.alter | `{ id, reason }` | `{ id, number, updatedAt }` |
| `vouchers.duplicate` | vouchers.view | `{ id }` | `VoucherInput` with no id or number, dated today. Bill allocations, tracking/order refs and (purchase) supplier invoice no./date are removed. |
| `vouchers.nextNumber` | vouchers.view | `{ voucherTypeId, date }` | `string` (`''` for manual / none) |
| `vouchers.setOptional` | vouchers.alter | `{ id, optional, acknowledgeWarnings? }` | `VoucherSaveResult` (a full alter: guards run when becoming regular) |
| `vouchers.trackingRefs` | vouchers.view | `{ partyLedgerId, kind: 'delivery' \| 'receipt' \| 'sales_order' \| 'purchase_order', excludeVoucherId? }` | `TrackingDoc[]`: open notes/orders with lines and `pendingQty` |

### Save errors
- **Unconfirmed warnings:** `BUSINESS_RULE` with `details: { needsConfirmation: true, warnings }`. Resubmit with `acknowledgeWarnings: true` after the user confirms.
- **Blocking rule or `block` guard:** `BUSINESS_RULE` with `details: { warnings }` and no `needsConfirmation`. The message is the first blocking warning.
- **Others:**
  - `LOCKED` (period lock: old **and** new date on alter, plus delete and cancel)
  - `FORBIDDEN` (alter, backdate, delete)
  - `CONFLICT` (stale `expectedUpdatedAt`, duplicate number)
  - `NOT_FOUND`
  - `VALIDATION` (schema)

---

## 2. Modes and allowed base types

| Base type | Modes (first = default) | Books | Stock |
|---|---|---|---|
| sales, purchase, credit_note, debit_note | item_invoice, accounting_invoice, ledger | yes | invoice item lines |
| payment, receipt, contra, journal | ledger | yes | – |
| memorandum, reversing_journal | ledger | **no** (`affects_books = 0`, must still balance) | – |
| sales_order, purchase_order | item_invoice, inventory | no | **no** (`affects_stock = 0`) |
| delivery_note, receipt_note, rejection_in, rejection_out | item_invoice, inventory | no | yes |
| stock_journal, physical_stock | inventory | no | yes |

- **item_invoice on a non-accounting type** (order or note): GST and totals are computed for printing. No ledger entries and no `gst_lines` are written.
- **Party required:** invoice modes, orders, notes and rejections. A sales invoice may use the Cash ledger as party (cash sale).
- **Inventory feature off:** item_invoice / inventory modes are refused.

---

## 3. Posting tables

`G` is the invoice value, `grandTotal`: taxable + tax payable to the party + non-GST charges + round off.
`s` is the **party sign**: +1 for sales and debit_note (party Dr), −1 for purchase and credit_note (party Cr).

| Entry | role | amount |
|---|---|---|
| Party | `party` | `s × G` |
| Sales/purchase ledger per item group (lines grouped by ledger) | `sales` / `purchase` | `−s × Σ postingAmount` |
| Each additional / invoice ledger line (one entry per input line) | `sales`/`purchase` if under Sales/Purchase Accounts, else `charge` | `−s × postingAmount` (apportioned or computed lines) or `−s × amount` (non-GST charge outside the computation) |
| Output (outward) / Input (inward) tax per duty head (IGST, CGST, SGST/UTGST, CESS) | `tax` + `gst_duty_head` | `−s × head` |
| RCM liability per head (inward reverse charge only) | `tax` + head | `+s × head` |
| Round Off (reserved ledger) | `round_off` | `−s × roundOff` |

### Per-base-type summary

- **Sales:**
  - Dr Party G
  - Cr Sales (taxable, own share)
  - Cr freight / charges
  - Cr Output IGST / CGST / SGST / Cess
  - ± Round Off (Cr when rounded up)
  - A discount line (negative amount) becomes a Dr.
- **Purchase:** exact mirror with **Input** tax ledgers. Party Cr.
- **Credit Note:** mirrors Sales (party Cr; sales Dr; Output tax Dr). Stock comes **in**.
- **Debit Note:** mirrors Purchase (party Dr; purchase Cr; Input tax Cr). Stock goes **out**.
- **Inward reverse charge** (voucher `reverseCharge`, ledger `is_reverse_charge`, import of services, RCM from an unregistered supplier):
  - The party gets taxable + charges only.
  - Post Dr Input tax / Cr `RCM_*` liability (the "… Payable (Reverse Charge)" ledgers).
- **Outward reverse charge:** no tax posted. `gst_lines.is_reverse_charge = 1`.
- **Tax not claimable** (a composition company buying from a registered supplier, or a line whose ITC eligibility is `ineligible`):
  - The supplier's tax (or the RCM input side) is added to that line's purchase/expense ledger debit. No input tax lines.
  - For item lines the tax is also added to the `inventory_entries.amount` (stock is carried at cost).
- **Unregistered company:** the engine computes no tax at all. Enter purchases at their tax-inclusive amount.
- **Import of goods:**
  - IGST is computed and stored in `gst_lines` (nature `import_goods`) but **not posted**: it is paid at customs (bill of entry, entered separately).
  - The party gets the taxable value only.
- **Exports / SEZ:**
  - LUT/bond: tax not charged (`gst_lines` keep the rate, tax 0).
  - `exportDetails.withPayment`: IGST is charged and payable by the buyer.
- **Ledger mode** (payment, receipt, contra, journal, memorandum, reversing journal, and notes/invoices entered as plain lines):
  - Lines are posted exactly as entered (signed).
  - role: `cash_bank` (Cash-in-Hand, Bank Accounts, Bank OD), `party`, `tax` (duty ledgers), `sales`, `purchase`, else `other`.
  - No `gst_lines` are written.
  - A sales/purchase/note voucher in ledger mode that touches GST ledgers gets a `gst_ledger_lines` warning.
- **Inventory mode:** no ledger entries.

### How each additional ledger is treated on an invoice

1. A GST duty ledger is refused: tax is automatic.
2. `include_in_assessable = 'goods'`: apportioned into the goods lines' taxable value by `appropriate_by` (`value`, the default, or `quantity`). It still posts its own amount to its own ledger.
3. Taken into the GST computation as its own line, when either:
   - it has a `gst` override, or the ledger is GST-applicable (columns or history); or
   - it is under Sales/Purchase Accounts; or
   - it is an income/expense/fixed-asset ledger in **accounting_invoice** mode.

   Its profile comes from §6. A not-applicable ledger becomes a `non_gst` line.
4. Otherwise it is a **non-GST charge outside the computation**: added after tax, with no gst_line. Examples are TCS and a non-GST discount.

Round-off (F12 › roundOff) applies to the whole invoice value including such charges. B2CL vs B2CS uses that final value against `config.gst.b2clThresholdPaise`.

`VoucherPreview.computation.totals.{invoiceValueBeforeRound, roundOff, grandTotal, payableToParty}` are the voucher's figures.

### Stock direction (inventory_entries.qty, base unit)

| Direction | Base types |
|---|---|
| out (−) | sales, debit_note, delivery_note, rejection_out, sales_order (`affects_stock = 0`) |
| in (+) | purchase, credit_note, receipt_note, rejection_in, purchase_order (`affects_stock = 0`) |
| per line | stock_journal: `isConsumption` → out, else in |
| per line | physical_stock: qty = **counted − book qty** at that date / godown / batch. The counted qty stays in `input` (meta). |

**`affects_stock = 0`** when any of these holds:
- the voucher is optional;
- the inventory feature is off;
- it is an order;
- the item is a service;
- an invoice line carries a `trackingRef` (the note already moved the stock).

**Other line fields:**
- `amount`: unsigned. Taxable value for invoices (+ capitalised tax); qty × rate × (1 − disc%) otherwise.
- `rate`: exclusive of tax. An inclusive rate is converted.
- `godown_id`: defaults to Main Location.
- `batch_name`: only when the Batches feature is on and the item maintains batches (then required).

**Tracking:**
- Delivery notes, receipt notes and rejections store their **own number** in `tracking_ref`. Orders store theirs in `order_ref`.
- An invoice line with `trackingRef = <note number>` bills that note. A line with `orderRef` fulfils that order.
- Pairing: sales ↔ delivery_note, purchase ↔ receipt_note, credit_note ↔ rejection_in, debit_note ↔ rejection_out.
- An unknown tracking reference raises a `tracking_ref` warning.
- A billed note cannot be deleted or cancelled.

---

## 4. Header and child rows

**`vouchers`**
- **Snapshots:** party snapshot (`party_name / address / state_code / gstin / registration_type / party_pincode`) from the party ledger, overridden by `input.party`. `place_of_supply` comes from the engine.
- **`invoice_mode`:** `item` / `accounting` / NULL.
- **`affects_books`:** 1 only for accounting base types that are neither optional nor cancelled.
- **`affects_stock`:** 1 when any line moves stock.
- **`is_post_dated`:** set **only when `input.isPostDated` is true**.
- **`total_amount`:**
  - Invoices: the invoice value G (amount payable by/to the party). This deliberately departs from the brief's Σ debits, so that an invoice rounded down or with a discount still shows its invoice value.
  - Ledger mode: Σ debits.
  - Inventory: Σ line values (stock journal: the production side).
- **`taxable_amount` / `tax_amount`:** from the computation (tax includes reverse-charge tax). `round_off`.
- **`gst_nature`:** GST documents in a GST company only.
- **`irn_status = 'pending'`:** when the e-invoice feature is on and a sales/credit note with nature b2b / export / sez / deemed_export is in the books. A `generated` IRN blocks alter and delete (cancel is allowed).
- **JSON columns:** `consignee`, `dispatch`, `order_details` and `export_details` hold the input objects. `export_details` also gets `lut: !withPayment`.
- **`meta`:** `{ v: 1, input: <normalised VoucherInput>, createdByName, updatedByName, cancelled?: { reason, at, by, byName, snapshot } }`.

**Child rows**
- **Tables:** `ledger_entries`, `bill_allocations`, `cost_allocations`, `inventory_entries`, `gst_lines`.
- **Rewritten on every save:** delete + insert inside the save transaction. The voucher id and guid are kept.
- **Denormalised from the voucher:** `date`, `affects_books` (or `affects_stock`) and `is_post_dated`.
- **Bank reconciliation:** an alter keeps `ledger_entries.bank_date` and `bank_statement_lines.matched_entry_id` for entries whose ledger and amount are unchanged; other matches become `unmatched`. Delete and cancel unmatch.

**Books filter** for every child table: `affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`. For stock: `affects_stock = 1 AND (is_post_dated = 0 OR date <= :today)`.

**`gst_lines`**
- Written for sales/purchase/credit/debit notes in invoice modes, in GST companies.
- One row per computed line with a taxable value or tax. Apportioned (absorbed) charges get no row.
- **Values:**
  - `taxable_value` is as on the document: negative for a discount line, and never negated for credit notes (use `vouchers.base_type`).
  - Line taxes sum exactly to the voucher's tax.
  - `qty` is NULL on ledger lines. `uqc` is NA for services.
- **`itc_eligibility`** (inward only), first match:
  - `ineligible` when the company is not regular;
  - the ledger's own `itc_eligibility`;
  - `capital_goods` when the ledger is under Fixed Assets;
  - `input_services` for services;
  - `inputs` otherwise.

**Cancel**
- Keeps the header and number.
- Sets `is_cancelled = 1`, `affects_books = affects_stock = 0` and the totals to 0.
- Removes the child rows and stores the pre-cancel snapshot in `meta.cancelled`.
- A `pending` IRN status becomes NULL.

**Delete** removes the voucher; children cascade.

**Both** are refused when another voucher settles ('against') a bill this voucher created, or when this note has been billed. Both are audited, and so is every create/alter, with compact before/after snapshots: `{type, number, date, party, amount, taxable, tax, narration, optional, postDated, cancelled, entries: [[ledgerId, amount]], items: [[itemId, qty, amount]]}`.

---

## 5. Bill-wise and cost centres

**Bill-wise** applies when the `billWise` feature is on **and** the ledger has `maintain_bill_wise`.

**Allocations given:** `partyBillAllocations` (invoice modes) or `ledgers[i].billAllocations` (ledger mode). Their magnitudes must sum to |entry amount|, otherwise `bill_mismatch` (blocking). They are stored with the entry's sign.

**Defaults when none are given:**
- **Party of sales / purchase / credit note / debit note** (also in ledger mode):
  - a `new` reference named after the voucher number (purchase: `referenceNo`, else the number);
  - `credit_days` = the ledger's `default_credit_days`, due date = date + days.
- **Credit/debit note whose `originalInvoiceNo` is a pending bill of opposite sign:** `against` that bill for min(amount, pending). Any remainder becomes a `new` reference named after the note's number.
- **Voucher without a number:** `on_account`.
- **Every other bill-wise entry** (payments, receipts, journals): `on_account`.

**Checks:**
- `against` must name a bill pending as of the voucher date (excluding this voucher), otherwise `bill_not_found` (blocking).
- Settling more than is pending raises `bill_over_settled` (warning).
- A `new` reference reusing the name of a still-pending originating bill raises `duplicate_bill_ref` (warning).
- `new` / `against` / `advance` need a bill name (`bill_name_required`).
- Bills found on a ledger without bill-wise are ignored.

**Pending bills** (`bills.ts › pendingBills`):
- Sources: `opening_bills` ∪ `bill_allocations` (books filter, `date ≤ asOf`, not `on_account`, excluding a voucher).
- Grouped by bill name, keeping only non-zero nets.
- `billDate` is the originating date (opening / new / advance). `dueDate` is the max due date.
- `originalAmount` is the sum of originating refs. `source` is `opening` or `voucher`; `voucherId` is the creating voucher.

**Cost centres** apply when the `costCentres` feature is on **and** the ledger has `cost_centres_applicable`. Allocations are optional. When given they must sum to |entry amount|, otherwise `cost_mismatch` (blocking). The input line amount is also accepted, in which case they are rescaled when non-claimable tax was capitalised into the line. They are stored signed like the entry.

---

## 6. GST rate resolution (`taxprofile.ts`)

**Item line**, first match wins:
1. `gstRateOverride` (taxable at that rate; HSN and cess still come from the masters).
2. The latest `gst_rate_history` row of the stock item with `applicable_from ≤ date`.
3. `stock_items` columns, when `gst_applicable = 'applicable'` and the details are complete.
4. The stock group chain, nearest first: each group's history row, then its columns.
5. The line's sales/purchase ledger: history row, then columns.
6. Taxable at 0% with a `gst_missing_rate` warning.

"Complete" means a rate is set, or the taxability is exempt / nil_rated / non_gst.

**Ledger line**, first match wins: `gst` override (merged over the rest) → ledger history → ledger columns (applicable without a rate gives 0% + `gst_missing_rate`) → `non_gst`.

**Supply kind:** item `is_service` → services. A ledger's `gst_supply_type` decides, else an HSN starting with 99 means services.

**HSN:** from the level that resolved the rate, else the first HSN found along the same chain.

---

## 7. Numbering (`numbering.ts`)

- **Counters:** `voucher_counters (voucher_type_id, period_key)`. The key is the FY label (`2026-27`) when the type restarts yearly, `YYYY-MM` when monthly, `all` when never.
- **Format:** `prefix + zero-pad(seq, width) + suffix`. `number_seq` holds the numeric part, used for ordering. A typed number gets its sequence parsed when it matches the type's format.
- **automatic:** the next free sequence. Numbers already used in the period are skipped. The number is allocated inside the save transaction, so a rollback leaves no gap.
- **automatic_override:** the user may type any number. A typed number does not advance the counter, unless it equals the next number.
- **manual:** a number is required. When `prevent_duplicates` is set it must be unique within the period (`CONFLICT`).
- **none:** the number is NULL.
- **Alter** keeps the number unless the method is manual/override and the user typed a new one.
  - Moving into another period where that number is taken is a `CONFLICT`.
  - The voucher type cannot change.
- **Deletion does not renumber** (GST invoice numbers must not change).

---

## 8. Warnings (`VoucherWarning { code, message, blocking, path? }`)

| Code | Blocking | When |
|---|---|---|
| `negative_stock` | per F12 guard (warn → no, block → yes) | item + godown closing qty as of the voucher date < 0 |
| `negative_cash` | per guard | a Cash-in-Hand ledger's balance as of the date < 0 |
| `credit_limit` | per guard | party balance after the voucher > `credit_limit` (only when the voucher increases the Dr balance) |
| `duplicate_reference` | per guard | purchase: same party + reference no. (case-insensitive) in the same FY |
| `gst_missing_gstin` | no | registered party (regular / composition / sez / uin / deemed export) without a GSTIN |
| `gst_missing_hsn` | no | B2B / export / SEZ / deemed-export line without HSN/SAC |
| `gst_missing_rate` | no | no GST rate found (taxed at 0%) |
| `gst` | no | any other GST engine warning (GSTIN checksum or state mismatch, retired slab, …) |
| `gst_ledger_lines` | no | GST ledgers used in a ledger-mode sales/purchase/note (not reported in returns) |
| `supplier_invoice_required` | **yes** | purchase from a registered supplier without `referenceNo` |
| `unbalanced` | **yes** | ledger mode Σ ≠ 0: "Voucher is not balanced: Dr ₹ X ≠ Cr ₹ Y (difference ₹ Z Dr/Cr)" |
| `cash_bank_required` | **yes** | Payment without a Cr to cash/bank, or Receipt without a Dr to cash/bank |
| `contra_ledger` | **yes** | Contra line not Cash/Bank/Bank OD |
| `journal_cash_bank` | **yes** | Journal touching Cash/Bank (as Tally does by default) |
| `zero_value` | **yes** | no non-zero entries (unless the type allows zero value) |
| `bill_mismatch` / `bill_name_required` / `bill_not_found` | **yes** | bill-wise rules (§5) |
| `bill_over_settled` / `duplicate_bill_ref` | no | bill-wise rules (§5) |
| `cost_mismatch` | **yes** | cost-centre rules (§5) |
| `tracking_ref` | no | an invoice line's trackingRef matches no note of this party with that item |
| `period_locked` | **yes** | preview only (save throws `LOCKED`) |

Guards are skipped for optional vouchers. The voucher being altered is always excluded from balances, stock and pending bills.

**Hard errors (thrown, never warnings):**
- inactive voucher type, ledger or item on create;
- wrong mode;
- missing party;
- date before books beginning;
- GST ledger used on an invoice;
- missing batch;
- unknown master, price level, godown or cost centre.

---

## 9. Known gaps

- Ledger-mode GST entries produce no `gst_lines`. GST must be entered in invoice mode to reach the returns.
- Import of goods: IGST is not posted (no customs/IGST-paid ledger is reserved); record the bill of entry as a journal.
- TDS/TCS computation is not automatic. A TCS/TDS ledger can be added as a non-GST line.
- Multi-currency (`forex_amount`, `exchange_rate`) is not handled.
- Negative-stock checks are per item + godown (not per batch) and only as of the voucher date. Later-dated vouchers are not re-checked.
- Default bill names are voucher numbers. Different series (Sales `1`, Credit Note `1`) or years with a yearly restart can produce the same bill name for a party. Pending bills are then netted together and a `duplicate_bill_ref` warning is raised when the earlier bill is still open. Use prefixes/suffixes (e.g. `INV/`, `CN/`, `/26-27`) to keep bill names unique.
- `vouchers.trackingRefs` matches by party + number. With yearly restart, two notes of the same party with the same number in different years share a reference.
- Stock valuation (closing stock) is the stock/reports modules' job. `inventory_entries.amount` is the input to it.
