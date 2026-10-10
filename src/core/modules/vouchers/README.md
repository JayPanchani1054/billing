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
| `direction.ts` | SQL fragment other modules use to recognise the item lines of a Debit Note to a customer (`outwardDebitNoteLineSql`) |
| `masters.ts` | Per-call master cache: ledgers with group chain, items + unit/UQC, godowns |
| `queries.ts` | get / list / entryContext / partyContext / trackingRefs |
| `testkit.ts` | Test helpers (used by `*.test.ts` only) |
| `e2e-month.test.ts` | One month of a Maharashtra trader posted end to end; asserts trial balance Σ = 0, every ledger's closing balance, tax ledgers = `gst_lines` per head, pending bills = party balances, stock per item, and that these invariants survive alters, a delete and a cancel |

---

## 1. Routes

All routes are company scope. Types are in `shared/types/vouchers.ts`.

| Route | Access | Input | Output |
|---|---|---|---|
| `vouchers.entryContext` | vouchers.view | `{ voucherTypeId, date }` | `VoucherEntryContext`: voucher type (numbering, config), `nextNumber`, `allowedModes`/`defaultMode`, company essentials + FY, all features, config subset (`roundOff`, `guards`, `lockedUpTo`, `gst`, `printAfterSave` = the voucher type's own switch, or Invoice Printing (print settings) for `INVOICE_PRINT_TYPES` sales / credit_note / debit_note / delivery_note only), reserved ledger ids (cash, sales, purchase, roundOff, output/input/rcm × IGST/CGST/SGST/CESS), `defaultLedgerId`, `mainGodownId`, `permissions {canCreate, canAlter, canBackdate, canDelete}` |
| `vouchers.partyContext` | vouchers.view | `{ ledgerId, date, excludeVoucherId? }` | `PartyContext`: mailing/GST details, `country`, `kind` (debtor/creditor/cash/bank/other), `gstDirection` (outward for customers, inward for suppliers, null otherwise — a Debit Note to a customer is outward, see §3), bill-wise flag, credit days/limit, `balance` as of date (books filter), `pendingBills` |
| `vouchers.pendingBills` | vouchers.view | `{ ledgerId, asOf, excludeVoucherId? }` | `PendingBill[]` (see §5) |
| `vouchers.preview` | vouchers.view | `VoucherInput` | `VoucherPreview`. No writes. Never throws for rule violations or guards: they come back in `warnings` with `blocking: true` (also `period_locked` and `backdate_not_allowed`, path `date`). Hard errors (unknown master, wrong mode, missing party…) still throw. |
| `vouchers.save` | route: vouchers.view; the service then requires vouchers.create (new) or vouchers.alter (`id` given), + vouchers.backdate when the new date **or** (alter) the saved date is before today | `VoucherInput` (+ 2.0 `numberOverride`, §7) | `VoucherSaveResult { id, number, warnings, totals, updatedAt }` |
| `vouchers.get` | vouchers.view | `{ id }` | `VoucherDetail`: header incl. snapshots and parsed JSON blobs, `voucherType {id,name,baseType}`, `mode`, `input` (the voucher as entered — edit it and send it back to `vouchers.save`; carries `id`, `number`, `expectedUpdatedAt`), `entries` (names, instrument, bank date, bill & cost allocations), `inventory` (item/unit/godown names), `gstLines`, `cancellation`, `createdBy`/`updatedBy` `{id,name}`, `updatedAt` |
| `vouchers.list` | vouchers.view | `VoucherListInput { from, to, voucherTypeIds?, baseTypes?, partyLedgerId?, ledgerId?, search?, includeOptional? (true), includeCancelled? (true), onlyPostDated?, sort? ('date_asc'), limit? (≤1000, default 200), offset? }` | `{ rows: VoucherListRow[], total, sums: { amount } }`. `search` matches number, reference no., narration, party name (case-insensitive, literal) or an exact amount ('1,180.00' = `total_amount`). |
| `vouchers.delete` | vouchers.delete (+ vouchers.backdate when dated before today) | `{ id, reason?, expectedUpdatedAt? }` | `{ id, number }` |
| `vouchers.cancel` | vouchers.alter (+ vouchers.backdate when dated before today) | `{ id, reason, expectedUpdatedAt? }` | `{ id, number, updatedAt }` |
| `vouchers.duplicate` | vouchers.view | `{ id }` | `VoucherInput` with no id or number, dated today. Bill allocations, tracking/order refs, the original invoice no./date of a note and (purchase) supplier invoice no./date are removed; of the GST details only an advance's rate and a stat-adjustment nature are kept (a challan, set-off, bill of entry and advances used belong to the source); a POS bill's `posBill` (tenders, cash tendered, the bill a return came from) is dropped — the copy is paid again. |
| `vouchers.nextNumber` | vouchers.view | `{ voucherTypeId, date }` | `string` (`''` for manual / none) |
| `vouchers.numberCheck` (2.0) | vouchers.view | `{ voucherTypeId, date, number, excludeId?, partyLedgerId?, mode? }` | `VoucherNumberCheckResult { ok, taken, problems, seq, scopeLabel }` — the format rule of a typed number (`voucherNumberProblems`) and the uniqueness rule the save applies to an override (`numbering.ts › numberClash`: `FY 2026-27` for an outward GST document, else the numbering period: `Apr 2026`, `All years`); `excludeId` = the voucher being altered. A debit note is outward only to a customer: its party / mode come from the input, else from `excludeId`; unknown → both rules (the stricter answer) With `excludeId`, a different number for a voucher other vouchers cite adds that refusal message to `problems` (`ok: false`). |
| `vouchers.renumber` (2.0) | vouchers.alter; the service also requires **vouchers.renumber** | `{ id, number, reason?, continueSeries?, expectedUpdatedAt, acknowledgeWarnings? }` | `VoucherSaveResult`. The normal alter (`saveVoucher`) with the stored `meta.input` + `numberOverride`: every guard applies (lock, freshness, IRN, cancelled, back-dating, GST filed-period confirm + amendment) and entries / stock / GST rows are rebuilt from the same input, so only the number changes — checked: a rebuilt posting whose totals, ledger entries, stock rows or GST rows differ from the saved ones (a physical stock count or a manufacturing journal re-derived from today's books) is refused with `BUSINESS_RULE` "… Alter the voucher (Alt+A), check the figures and change the number there" (`assertSameFigures`). No `meta.input` (very old imports) → `BUSINESS_RULE` "Alter the voucher (Alt+A) and change the number there". Refused (`BUSINESS_RULE`, `assertNumberNotCited`) — like any alter that changes a number — while other vouchers cite the old number: a credit / debit note's original invoice no. (same party; its original date, when given, is the invoice's), the fulfilling notes / invoices of an order (`order_ref`), the invoices billing a delivery / receipt note or rejection (`tracking_ref`); cancelled vouchers do not count. The message names them: "Credit Note 3 and Sales 7 refer to this number — change those references first." |
| `vouchers.setOptional` | vouchers.alter | `{ id, optional, acknowledgeWarnings?, expectedUpdatedAt? }` | `VoucherSaveResult` (a full alter: guards run when becoming regular) |
| `vouchers.trackingRefs` | vouchers.view | `{ partyLedgerId, kind: 'delivery' \| 'receipt' \| 'sales_order' \| 'purchase_order', excludeVoucherId? }` | `TrackingDoc[]`: open notes/orders with lines and `pendingQty` |

### Save errors
Every warning has a `level` (§8): `info` never stops a save, `confirm` needs `acknowledgeWarnings`, `block` can never be saved (`blocking` is true exactly for `block`).
- **Unconfirmed material warnings:** `BUSINESS_RULE` with `details: { needsConfirmation: true, warnings }` when at least one `confirm` warning exists and `acknowledgeWarnings` is not set. Resubmit with `acknowledgeWarnings: true` after the user confirms. `warnings` lists every warning (info ones too, for display); the message names the `confirm` ones.
- **Blocking rule or `block` guard:** `BUSINESS_RULE` with `details: { warnings }` and no `needsConfirmation`. The message is the first blocking warning.
- **Field-specific hard errors:** `VALIDATION` with `details: FieldIssue[]` (`{ path, message }`, path in `VoucherInput` notation such as `items[2].batchName`, `ledgers[1].ledgerId`, `partyLedgerId`, `mode`, `date`, `number`), exactly like schema errors, so the entry screen highlights the field. See §8 › Hard errors.
- **Others:**
  - `LOCKED` (period lock: old **and** new date on alter, plus delete and cancel; also, without `period.lock`, a delete, cancel or alter that would clear a bank date in the locked period — `assertLockedBankDatesKept`, see banking README › Period lock)
  - `FORBIDDEN` (create, alter, delete; back-dated work: entering, altering, cancelling or deleting a voucher dated before today needs vouchers.backdate — an alter checks the saved date as well as the new one, so moving yesterday's voucher to today still needs it)
  - `CONFLICT` (stale `expectedUpdatedAt` on save, delete, cancel, setOptional or renumber; duplicate number — `details: [{ path: 'number', message }]`, for an outward GST document "already used in FY 2026-27"; number taken in the period (GST: the financial year) of a new date — `path: 'date'`)
  - `FORBIDDEN` also for a `numberOverride` / `vouchers.renumber` without **vouchers.renumber**
  - `BUSINESS_RULE` without warnings: alter would orphan a dependent document (§4 › Alter safety), cancelled voucher, generated IRN
  - `NOT_FOUND` (the voucher itself)

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
- **Credit Note:** mirrors Sales (party Cr; sales Dr; Output tax Dr). Stock comes **in** (a sales return).
  - A credit note for a price reduction / discount on goods kept by the customer moves no stock: enter it in **accounting_invoice** mode (Sales ledger line with the GST rate), not with item lines.
  - With a **supplier** (Sundry Creditors) party in invoice modes it is refused (`VALIDATION` on `partyLedgerId`): a Credit Note credits the party, so it would post Output tax against a supplier and report a credit note we never issued. A credit note received from a supplier, or a purchase return, is a Debit Note; a supplier's debit note (higher price) is a Purchase. Ledger mode is unaffected.
- **Debit Note:** mirrors Purchase (party Dr; purchase Cr; Input tax Cr). Stock goes **out**.
  - With a **customer** (Sundry Debtors) party it is an outward supplementary invoice / upward price revision (CGST s.34(3)): party Dr; **Sales** ledger Cr (the reserved Sales ledger when the type's default is a purchase ledger); **Output** tax Cr; `gst_nature` outward (b2b, b2cs, …; reported in GSTR-1 as a debit note); e-invoice `irn_status = 'pending'` like a sales invoice. Its item lines are **value-only**: the goods left with the original invoice, so they keep qty / value / HSN for the documents and `gst_lines` (HSN summary) but `affects_stock = 0`, no `tracking_ref` and no tracking check — closing stock and gross profit are not reduced a second time. Item profitability and the dashboard's top items add their value to sales (no quantity, no cost; `direction.ts`), so they agree with the P&L. Goods actually supplied go on a Sales invoice.
  - The party sign always follows the base type; the tax ledgers and `gst_nature` follow this GST direction (`PartyContext.gstDirection`).
- **Inward reverse charge** (voucher `reverseCharge`, ledger `is_reverse_charge`, import of services, RCM from an unregistered supplier):
  - The party gets taxable + charges only.
  - Post Dr Input tax / Cr `RCM_*` liability (the "… Payable (Reverse Charge)" ledgers).
- **Outward reverse charge:** no tax posted. `gst_lines.is_reverse_charge = 1`.
- **Tax not claimable** (a composition company buying from a registered supplier, or a line whose ITC eligibility is `ineligible`):
  - The supplier's tax (or the RCM input side) is added to that line's purchase/expense ledger debit. No input tax lines.
  - For item lines the tax is also added to the `inventory_entries.amount` (stock is carried at cost).
- **Unregistered company:** the engine computes no tax at all. Enter purchases at their tax-inclusive amount.
- **Import of goods** — and **goods from an SEZ unit** (supplier registration `sez`, nature `inward_sez`; SEZ Act s.30 / SEZ Rules r.47–48: SEZ goods cleared into the DTA are imports):
  - IGST is computed and stored in `gst_lines` (nature `import_goods` / `inward_sez`, supply type goods) but **not posted**: it is paid at customs on the bill of entry, which is entered on the purchase itself as its GST details (Alt+J › bill of entry: the gst voucher hook posts Dr Input IGST / Cr "IGST Payable on Imports (Customs)" — gst/README.md §11). GSTR-3B reports it in 4(A)(1) IMPG, GSTR-9 in 6E; GSTR-2B shows it under IMPG / IMPGSEZ (GST › Bills of Entry reconciles them), so the GST reconciliation does not expect it in B2B.
  - The party gets the taxable value only. A tax-inclusive rate is ignored (warning).
  - **Services from an SEZ unit** are an ordinary inter-state B2B supply: IGST charged on the invoice and payable to the supplier (Dr Input IGST), 3B 4(A)(5).
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

1. A GST duty ledger is refused: tax is automatic. So are Cash/Bank ledgers (record money in a Receipt/Payment, or use Cash as the party) and customer/supplier ledgers (another party's account is not part of this invoice's value). The same applies to the sales/purchase ledger of an item line.
2. `include_in_assessable = 'goods'`: apportioned into the goods lines' taxable value by `appropriate_by` (`value`, the default, or `quantity`). It still posts its own amount to its own ledger.
3. Taken into the GST computation as its own line, when either:
   - it has a `gst` override, or the ledger is GST-applicable (columns or history); or
   - it is under Sales/Purchase Accounts; or
   - it is an income/expense/fixed-asset ledger in **accounting_invoice** mode with a positive amount. A negative one (a discount or deduction that is neither GST-applicable nor a sales/purchase account) is treated as in item mode: a non-GST deduction after tax (rule 4), not a negative non-GST supply.

   Its profile comes from §6. A not-applicable ledger becomes a `non_gst` line.
4. Otherwise it is a **non-GST charge outside the computation**: added after tax, with no gst_line. Examples are TCS and a non-GST discount.

Round-off (F12 › roundOff) applies to the whole invoice value including such charges. B2CL vs B2CS uses that final value against the B2CL threshold: `config.gst.b2clThresholdPaise` when it was changed from the default ₹1,00,000, otherwise the statutory threshold for the invoice date (₹2,50,000 before 1-Aug-2024, ₹1,00,000 from then on).

`VoucherPreview.computation.totals.{invoiceValueBeforeRound, roundOff, grandTotal, payableToParty}` are the voucher's figures.

### Stock direction (inventory_entries.qty, base unit)

| Direction | Base types |
|---|---|
| out (−) | sales, debit_note (to a supplier — a debit note to a customer is value-only, `affects_stock = 0`), delivery_note, rejection_out, sales_order (`affects_stock = 0`) |
| in (+) | purchase, credit_note, receipt_note, rejection_in, purchase_order (`affects_stock = 0`) |
| per line | stock_journal: `isConsumption` → out, else in |
| per line | physical_stock: qty = **counted − book qty** at that date / godown / batch. Lines counting the same item / godown / batch are added up: the first carries counted − book, later ones their counted qty (net = Σ counted − book). The counted qty stays in `input` (meta). |

**`affects_stock = 0`** when any of these holds:
- the voucher is optional;
- the inventory feature is off;
- it is an order;
- the item is a service;
- an invoice line carries a `trackingRef` (the note already moved the stock);
- it is a line of a Debit Note to a customer (value-only price revision, §3).

**Other line fields:**
- `amount`: unsigned. Taxable value for invoices (+ capitalised tax); qty × rate × (1 − disc%) otherwise.
- `rate`: exclusive of tax. An inclusive rate is converted.
- `godown_id`: defaults to Main Location.
- `batch_name`: only when the Batches feature is on and the item maintains batches (then required).

**Tracking:**
- Delivery notes, receipt notes and rejections store their **own number** in `tracking_ref`. Orders store theirs in `order_ref`.
- An invoice line with `trackingRef = <note number>` bills that note. A line with `orderRef` fulfils that order.
- Pairing: sales ↔ delivery_note, purchase ↔ receipt_note, credit_note ↔ rejection_in, debit_note ↔ rejection_out.
- `tracking_ref` warning (confirm) when the line's stock would never move: no such note of this party with the item; the note is optional (it moved no stock); or the line bills more than the note has left (note qty − qty billed by other regular invoices − earlier lines of this voucher with the same reference).
- A billed note cannot be deleted or cancelled, and an alter must keep its number, party, billed items, regular status and at least the quantity of each item its regular invoices bill (§4).

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
- **`irn_status = 'pending'`:** when the e-invoice feature is on and a sales invoice, credit note or debit note to a customer with nature b2b / export / sez / deemed_export is in the books. A `generated` IRN blocks alter and delete (cancel is allowed).
- **JSON columns:** `consignee`, `dispatch`, `order_details` and `export_details` hold the input objects. `export_details` also gets `lut: !withPayment`.
- **`meta`:** `{ v: 1, input: <normalised VoucherInput>, createdByName, updatedByName, cancelled?: { reason, at, by, byName, snapshot } }`.

**Child rows**
- **Tables:** `ledger_entries`, `bill_allocations`, `cost_allocations`, `inventory_entries`, `gst_lines`.
- **Rewritten on every save:** delete + insert inside the save transaction. The voucher id and guid are kept.
- **Denormalised from the voucher:** `date`, `affects_books` (or `affects_stock`) and `is_post_dated`.
- **Bank reconciliation:** an alter keeps `ledger_entries.bank_date` and `bank_statement_lines.matched_entry_id` for entries whose ledger and amount are unchanged; other matches become `unmatched`. An alter that takes the voucher out of the books (made optional) keeps bank dates but unmatches its statement lines. Delete and cancel unmatch.

**Alter safety** (`BUSINESS_RULE`, nothing written):
- A bill this voucher created (`new`/`advance`) that another voucher settles (`against`) must still be created with the same name, on the same ledger, by a voucher that stays in the books (no party change, no rename, not optional).
- A delivery/receipt note or rejection already billed by an invoice must keep its number, party and the billed items, and stay regular. Its quantity of each billed item may change but not drop below what the regular invoices bill (they move no stock themselves). Other lines may change.

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

**Both** are refused when another voucher settles ('against') a bill this voucher created, or when this note has been billed. Both are audited, and so is every create/alter, with compact before/after snapshots: `{type, number, date, party, partyLedgerId, reference, gstNature, amount, taxable, tax, narration, optional, postDated, cancelled, entries: [[ledgerId, amount]], items: [[itemId, qty, amount]]}`.

---

## 5. Bill-wise and cost centres

**Bill-wise** applies when the `billWise` feature is on **and** the ledger has `maintain_bill_wise`.

**Allocations given:** `partyBillAllocations` (invoice modes) or `ledgers[i].billAllocations` (ledger mode). Their magnitudes must sum to |entry amount|, otherwise `bill_mismatch` (blocking). They are stored with the entry's sign.

**Defaults when none are given:**
- **Party of sales / purchase / credit note / debit note** (also in ledger mode):
  - a `new` reference named after the voucher number (purchase: `referenceNo`, else the number). When another voucher or an opening bill of the same ledger already uses that name (Sales 1 vs Credit Note 1, the same number in the next year of a yearly series, a supplier reusing an invoice number next year), the financial year is appended — `1/2026-27` (then `1/2026-27-2`, …) — so two documents are never netted into one bill. An altered voucher keeps the name it already has;
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
- **Tokens and dated prefix / suffix (dataplus, `src/shared/numbering.ts` › `formatSchemeNumber`):** the prefix / suffix in force on the VOUCHER DATE (the type's own, or the latest `voucher_type_numbering_rows` row applicable on or before the date) has {FY} {FYYYYY} {YY} {MM} {MMM} expanded with that date — `INV/{FY}/` + 7 → `INV/26-27/7`. The counter is unchanged (per FY / month / all), so a yearly series restarts at 1 on 1 April and the FY in the prefix keeps numbers unique across years. A number, once allocated, is stored and never re-expanded (changing the prefix later never renumbers). For GST documents the voucher type check refuses schemes whose longest expansion exceeds 16 characters or uses characters other than letters, digits, `/` and `-` (CGST Rule 46(b)). Without tokens or rows the format is exactly the old one.
- **automatic:** the next free sequence. Numbers already used in the period are skipped. The number is allocated inside the save transaction, so a rollback leaves no gap. `decideNumber` finds it free and the save advances the counter to it (`commitNumber`) without probing again.
- **Uniqueness probe** (`NUMBER_TAKEN_SQL`): looks the number up through `idx_vouchers_number` (`INDEXED BY`), so a save costs the same with 50 or 50,000 vouchers of its type in the year (without statistics SQLite otherwise scanned the type's year through `idx_vouchers_type_date`, which made imports quadratic). The importers use the same lookup.
- **automatic_override:** the user may type any number. A typed number does not advance the counter, unless it equals the next number.
- **manual:** a number is required. When `prevent_duplicates` is set it must be unique within the period (`CONFLICT`).
- **none:** the number is NULL.
- **Alter** keeps the number unless the method is manual/override and the user typed a new one, or a `numberOverride` is given.
  - Moving into another period where that number is taken is a `CONFLICT`.
  - The voucher type cannot change.
- **Deletion does not renumber** (GST invoice numbers must not change).
- **2.0 — GST financial-year rule (D27, CGST Rule 46(b)):** an OUTWARD GST document (`isGstOutwardDocument`: sales and credit notes of a GST company; a debit note only in an invoice mode to a Sundry Debtors party) is unique within its financial year on every `saveVoucher` path, whatever `prevent_duplicates` and the restart say (CONFLICT on `number`, or on `date` when a move into another FY meets a taken number). Automatic allocation of such a document skips numbers used anywhere in the FY (`nextFree(…, gstFy)` — this only changes anything for a monthly series without {MM} / {MMM}, which the scheme check refuses for new schemes). Other types (purchases, payments, a debit note to a supplier, …) keep the type's own rule. The Excel import saves through `saveVoucher`, so a duplicate GST number fails on its row with that message; the XML data import writes vouchers itself and keeps its own duplicate handling.
- **2.0 — Override (`VoucherInput.numberOverride { number, reason?, continueSeries? }`, permission `vouchers.renumber`):** an explicit field (never inferred from `number`; imports, recurring and POS are unchanged), on create or alter, any method but `none` (VALIDATION). Taken out of the input before compose / posting, so it is never stored in `meta.input` and a later alter does not apply it again. Checks (`decideNumber` › `decideOverride`, pure): permission (FORBIDDEN), format (`voucherNumberProblems`: GST documents 1–16 of `[A-Za-z0-9/-]`, others 1–60 characters without control characters; VALIDATION on `number`), uniqueness (FY for outward GST documents, else the numbering period — always, even with `prevent_duplicates` off). Create: the counter is not consumed unless the override equals the next number; `continueSeries` with a number in the type's format advances the counter to its sequence (`commitNumber`, never lowers). An override equal to the current number on an alter records nothing about the number and runs the plain alter (so moving the voucher into a period / FY where its number is taken is still a `CONFLICT` on `date`). Renumbering an invoice whose party bill (named after the old number) is already settled by another voucher keeps the bill's name: the party's current bill-wise split is carried into the input and an `info` warning `numbering` says so (invoice modes, input without its own `partyBillAllocations`).
- **2.0 — Edit log:** an alter that changes the number adds `numberChange { from, to, reason }` to the after-image (reason null for a manual / override-method typed change), a create with an override adds `numberOverride { to, next, reason }` (`next` = the number the series would have given).
- **2.0 — Series routes** (accounts module, `accounts/numbering.ts`): `accounts.voucherType.numberingStatus` (masters.view: counter, highest used, next, vouchers of the period), `accounts.voucherType.setNextNumber` (vouchers.renumber: `last_number = next − 1`, may lower the counter; confirm warnings `numbering` for lowering to or below a used number and for raising past the number the series would give next (counted from that number, so free numbers behind a typed one are reported too); audited on the voucher type as `{ counter: { periodKey, lastNumber, from, to }, nextNumber }`), `accounts.voucherType.numberGaps` (vouchers.view: first / last, issued, cancelled, missing ≤ 200 + exact count, per numbering period). A voucher-type save that changes the restart seeds the new period's counter from the highest sequence used in its scope, read from the numbers in today's format (`seedRestartCounter`: last year's `INV/25-26/0900` does not make an `INV/{FY}/` series jump). Next-number previews (`vouchers.nextNumber`, `vouchers.preview`, `numberingStatus`) skip FY-taken numbers of sales / credit-note series like the allocation does.

---

## 8. Warnings (`VoucherWarning { code, message, blocking, level, path? }`)

`level`: **info** — shown (preview, save result, error details) but never stops or delays a save; **confirm** — material: save fails with `needsConfirmation` until resubmitted with `acknowledgeWarnings: true`; **block** — cannot be saved (`blocking: true`). `path` points at the input (`items[2]`, `items[0].trackingRef`, `ledgers[1].ledgerId`, `partyLedgerId`, `referenceNo`, `number`, `exportDetails.withPayment`, …) when known.

| Code | Level | When |
|---|---|---|
| `negative_stock` | per F12 guard (warn → confirm, block → block) | item + godown (+ batch for a batch line) closing qty as of the voucher date < 0; path `items[i]` |
| `negative_cash` | per guard | a Cash-in-Hand ledger's balance as of the date < 0; path of the cash line (`ledgers[i].ledgerId` / `partyLedgerId`) |
| `credit_limit` | per guard | party balance after the voucher > `credit_limit` (only when the voucher increases the Dr balance) |
| `duplicate_reference` | per guard | purchase: same party + reference no. (case-insensitive) in the same FY |
| `gst_missing_gstin` | confirm | registered party (regular / composition / sez / uin / deemed export) without a GSTIN |
| `gst_missing_hsn` | Notification 78/2020: **confirm** on B2B / export / SEZ / deemed-export lines, and on every outward line when F12 › GST › HSN digits is 6 or more (turnover above ₹5 crore); otherwise **info** on outward lines (needed for the GSTR-1 HSN summary; non-GST lines skipped). Inward documents are not checked. | line without HSN/SAC, or with fewer digits than F12 › GST › HSN digits (4 up to ₹5 crore turnover, 6 above) |
| `gst_missing_rate` | confirm | no GST rate found (taxed at 0%) |
| `gst` | confirm, or info for presentation notes | any other GST engine warning. A line-level one gets the line's path (`items[i]` / `ledgers[i]`) and a ledger line is named by its ledger (the engine numbers lines across items and ledgers; the label is matched on the line's own name, so names with brackets or colons such as `Rice (25 kg)` keep their path). **info:** non-standard rate, slab merged on 22-Sep-2025, unit not a GST UQC, tax-inclusive rate ignored, apportionment notes, supply type defaulted, amount rounded to paise. **confirm:** everything else (invalid GSTIN, GSTIN registered in another state, GSTIN on an unregistered party, unknown state / place of supply, composition inter-state goods, 0% on a taxable line, negative taxable value, invalid numbers or rates, …) |
| `gst_lut` | confirm | export / SEZ supply under LUT (`withPayment` not set) with tax-bearing lines and no LUT in F12 › GST valid on the date (`lutNumber`, `lutValidFrom` ≤ date ≤ `lutValidTo`) |
| `numbering` | info / confirm | 2.0: a renumbered invoice's bill keeps its name because another voucher settles it (info, in the save result); setting a series' next number below a used number or past unused ones (confirm, `accounts.voucherType.setNextNumber`) |
| `gst_invoice_number` | confirm | outward GST document (sales, credit note, debit note to a customer) whose number is over 16 characters or has characters other than letters, digits, `-` and `/` (CGST Rule 46; e-invoices are rejected) |
| `gst_ledger_lines` | confirm | GST ledgers used in a ledger-mode sales/purchase/note (tax in the books that the returns will not show) |
| `supplier_invoice_required` | block | purchase from a registered supplier without `referenceNo` |
| `unbalanced` | block | ledger mode Σ ≠ 0: "Voucher is not balanced: Dr ₹ X ≠ Cr ₹ Y (difference ₹ Z Dr/Cr)" |
| `cash_bank_required` | block | Payment without a Cr to cash/bank, or Receipt without a Dr to cash/bank |
| `contra_ledger` | block | Contra line not Cash/Bank/Bank OD |
| `journal_cash_bank` | block | Journal touching Cash/Bank (the conventional default) |
| `zero_value` | block | no non-zero entries (unless the type allows zero value) |
| `negative_value` | block | invoice modes: the invoice value G is below zero (discount/deduction lines exceed the goods/services) |
| `bill_mismatch` / `bill_name_required` / `bill_not_found` | block | bill-wise rules (§5) |
| `bill_over_settled` / `duplicate_bill_ref` | confirm | bill-wise rules (§5) |
| `cost_mismatch` | block | cost-centre rules (§5) |
| `tracking_ref` | confirm | an invoice line's stock would never move (§3 › Tracking) |
| `period_locked` | block | preview only (save throws `LOCKED`) |
| `backdate_not_allowed` | block | preview only: the date (or, on alter, the saved date) is before today and the user lacks vouchers.backdate (save throws `FORBIDDEN`); path `date` |

Guards are skipped for optional vouchers. The voucher being altered is always excluded from balances, stock and pending bills.

**Hard errors (thrown, never warnings)** — `VALIDATION` with the field path:
- inactive voucher type (`voucherTypeId`) on create; inactive ledger (`partyLedgerId`, `ledgers[i].ledgerId`, `items[i].ledgerId`) or item (`items[i].itemId`), except — on alter — one the saved voucher already uses;
- a quantity with more decimals than the item's unit allows (`items[i].qty`, `items[i].billedQty`; Nos: whole numbers);
- a master that no longer exists: party, ledger, stock item, godown (`items[i].godownId`), cost centre (`ledgers[i].costAllocations[j].costCentreId`), price level (`priceLevelId`);
- wrong mode, or inventory turned off (`mode`); stock items in a ledger/accounting voucher (`items`); ledger lines in an inventory voucher (`ledgers`);
- missing party, or a Credit Note to a supplier (`partyLedgerId`);
- date before books beginning (`date`);
- no item lines / no income-expense line (`items` / `ledgers`); no sales/purchase ledger for an item line (`items[i].ledgerId`);
- GST ledger, Cash/Bank ledger, a customer/supplier ledger, or the party itself, used as an invoice line (`ledgers[i].ledgerId`) or as an item line's sales/purchase ledger (`items[i].ledgerId`);
- missing batch (`items[i].batchName`);
- manual number missing (`number`); changing the voucher type of a saved voucher (`voucherTypeId`).

---

## 9. Known gaps

- Ledger-mode GST entries produce no `gst_lines` (the `gst_ledger_lines` warning needs confirmation). GST must be entered in invoice mode to reach the returns.
- Import of goods: IGST is posted from the bill of entry entered as the purchase's GST details (Alt+J), not from the invoice lines (gst/README.md §11).
- GST details (`VoucherInput.gstDetails`: advance / its adjustment or refund, bill of entry, GST challan, stat adjustment, set-off) are validated, posted and derived by the gst module through the same voucher hook (`gst/hook.ts`, derived `gst_advance_lines`, `gst_bill_of_entry`, `gst_stat_lines`, `gst_challans`); a document of a filed GSTR-1 period is logged as an amendment when altered and cannot be deleted or cancelled — see src/core/modules/gst/README.md §11, §16.
- TDS/TCS is computed and posted by the tds module through the voucher hook (`hooks.ts`, `VoucherInput.tds`, derived `tds_lines` / `tds_challans`) when F11 › TDS / TCS is on — see src/core/modules/tds/README.md. With them off, a TCS/TDS ledger can still be added as a non-GST line.
- Multi-currency is handled by the forex module through the voucher hook (`forex/hook.ts`, `VoucherInput.forex`, line `forexAmount` / `exchangeRate`, item `forexRate` / `forexAmount`, bill `forexAmount`) when F11 › Multiple currencies is on: lines of a ledger kept in a foreign currency are converted to rupees (books stay in INR, Σ = 0 in paise), settled bills booked at another rate post the realised exchange difference in the same voucher, and currency / foreign amount / rate are stored on `ledger_entries`, `bill_allocations` and `vouchers` — see src/core/modules/forex/README.md. The export dialog's Currency / rate are filled from the voucher currency.
- POS / counter billing is handled by the pos module through the voucher hook (`pos/hook.ts`, `VoucherInput.posBill`) when F11 › POS invoicing is on: on a Sales voucher of a POS type (`config.posInvoice`) — or a Credit Note returning goods from one — each tender debits (refund: credits) its ledger in the SAME voucher and the party entry is reduced by the same total, so only an unpaid part stays on the customer (with the usual bill-wise reference); a walk-in cash party must be paid in full. Derived `pos_bills` / `pos_payments`; tender entries on a bank ledger carry instrument `card` / `upi` (hooks.ts › `addEntry` takes an optional `instrument`, extend-only). A POS bill is altered on the POS counter (`vouchers.entry` hands POS types over); an alteration sent without `posBill` (API, a POS return altered as a Credit Note) gets the saved block back through the pos hook's `compose` and is re-checked, so tenders and the return link are never dropped — see src/core/modules/pos/README.md.
- Attachments (dataplus): the attachments module's voucher hook (`attachments/hook.ts`, `beforeRemove`) refuses to DELETE a voucher that still has attached files — remove them first (each removal is in the edit log); cancelling keeps the voucher and its files. See src/core/modules/attachments/README.md.
- Negative-stock checks are only as of the voucher date (per item + godown, and per batch for batch lines). Later-dated vouchers are not re-checked.
- Bill names typed by the user are taken as given: a `new` reference reusing a pending bill's name is netted with it (`duplicate_bill_ref`, confirm).
- `vouchers.trackingRefs` matches by party + number. With yearly restart, two notes of the same party with the same number in different years share a reference.
- `ledgers.gst_nature_override` (set in the ledger master) is not applied by the engine: the nature always comes from the computation.
- Cost-centre allocation is only possible on ledger lines, not on the sales/purchase ledger of item lines.
- Stock valuation (closing stock) is the stock/reports modules' job. `inventory_entries.amount` is the input to it.
- Physical stock stores **counted − book** as at its save. A voucher entered later but dated before it changes the book quantity, so the count no longer equals the closing quantity (conventional software resets to the count). Re-save the physical stock voucher after such entries.
- `include_in_assessable = 'services'` is not apportioned (only `'goods'`); such a ledger is treated by rules 3–4.
- Optional vouchers take the next number of their type's series (as accountants expect). GSTR-1 Table 13 leaves such a number out of the range (neither issued nor cancelled) and raises `optional_in_series` so it is regularised or deleted before filing; a separate voucher type for optional / pro-forma documents avoids the question. For quotations and proforma invoices use the **Quotation** / **Proforma Invoice** voucher types (documents module, base types `quotation` / `proforma`): their own series, no books, conversion into an order or invoice.
- An item-mode Credit Note always brings the goods back (a sales return); a price reduction on goods the customer keeps is entered in accounting_invoice mode (§3).
- Debit Notes to customers saved before value-only lines were introduced keep their stock movement until re-saved.
- GST reconciliation (`gst_portal_docs.match_status`) is not reset when a matched voucher is deleted or cancelled (the FK clears `matched_voucher_id`); the gstrecon module re-matches.

---

## 10. Performance with every voucher hook on (final wave)

`perf-hooks.test.ts` builds a company with every F11 feature on (bill-wise, cost centres, multiple
currencies, cheque printing, integrated inventory, godowns, orders, tracking, manufacturing, job work,
POS, GST, TDS, TCS), 2,000 ledgers, 1,000 items and 60,000 vouchers (`dashboard/testkit.ts ›
bulkBusiness`) plus a few hundred real TDS journals, cheque payments, USD export invoices and Material
Out challans, then saves / alters / cancels / deletes one voucher of each kind (sales / purchase
invoice, receipt, cheque payment, TDS journal, TCS sale, export invoice, Material Out, Manufacturing
Journal, POS bill, GST advance receipt, quotation) and five more hook paths built fresh per save (a
debit note reversing a bill's TDS, a receipt settling a USD bill, an invoice converted from a
quotation, a reverse-charge purchase, an import with a bill of entry). What it checks — deterministic,
because the app never runs ANALYZE and SQLite's plans then depend on the schema only
(`src/core/testing/sqlPlans.ts`):

- **Plans.** Every statement of those saves (SELECT / UPDATE / DELETE / INSERT; a DELETE's plan also
  lists its foreign-key look-ups, so a CASCADE / SET NULL child without an index shows) is EXPLAINed:
  no scan of a table that grows with the books (vouchers, entries, bills, gst_lines, tds_lines,
  derived hook tables, the edit log …; a `LIMIT 1` existence probe without WHERE is allowed), a
  statement keyed by `voucher_id = :x` must look that voucher up, a bank's cheque leaves come from
  `idx_le_cheques`, the TDS duty-ledger look-up from `idx_tds_ledger_payable`.
- **Budgets.** ≤ 120 statements per save and ≤ 160 per alter (measured 23–56 / 59–91); stock is valued
  only by a Manufacturing Journal / Material Out (one replay of its own items, for the cost estimate);
  report routes and drill-downs (voucher, group summary, monthly summary, group vouchers, a party's
  bills, an item's vouchers, the Sales ledger) run a bounded number of statements (ITC-04 no longer
  grows with its lines).
- **Times** are logged and bounded generously for CI (1 s per drill-down, 4 s per report, 250 ms save
  p95). Measured on a developer machine: saves 1–7 ms p95; Day Book of a week 2 ms, ledger of a party
  5–9 ms, Go To 2–75 ms, other drill-downs 1–105 ms, the Sales ledger (30,000 lines) 110–145 ms; Trial
  Balance 0.14–0.17 s, Balance Sheet / P&L ≈ 0.2 s cold, GSTR-1 month 0.08–0.11 s, GSTR-3B month
  0.6–0.85 s cold — its credit is chained from the books beginning and memoised per period afterwards,
  so this cost grows with the years of history — TDS / forex / ITC-04 / pending job work under 10 ms,
  bills pending 0.03 s, budget variance 0.1 s.
- **Known, under target, not optimised:** the GSTR-3B chain above; Go To's voucher search counts the
  matches over every voucher on each keystroke (≈ 60 ms); budget variance reads the ledger totals twice
  (snapshot + nominal movement, ≈ 100 ms); deleting a ledger / item / godown / currency master scans
  the derived tables that reference it without an index (≈ 20 ms for a ledger on 60,000 vouchers —
  rare, and an index would cost every voucher save).

Fixed in this pass (each one covered by the test): the default bill name of an altered voucher read
every bill of the party (`posting.ts › defaultBillName`, now `INDEXED BY idx_bills_voucher`); the
cheque hook read every entry of the bank ledger twice per save (partial index `idx_le_cheques`,
migration 241); the TDS hook read every TDS line of a section to find one bill's line; deleting a
voucher scanned `gstrecon_decisions` (CASCADE look-up, index in 241); the TDS reports read all lines of
a kind since the books began; the forex revaluation report scanned every voucher; ITC-04 ran two GST
look-ups per challan line; the e-way bill number check scanned every voucher (now `idx_vouchers_eway`,
checked on the real `gst/ewaybill.ts › updateEwayBill` statement).
