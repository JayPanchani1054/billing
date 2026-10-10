# POS module (`pos`) — counter billing

Point-of-sale billing on top of the ordinary vouchers engine. A **POS bill is a Sales voucher** of a
voucher type of the *POS invoice* class (`voucher_types.config.posInvoice = true`); a **POS return is a
Credit Note**. Posting, GST, numbering, stock, bill-wise, audit and the period lock are the vouchers
module's; this module adds the tender split through the documented voucher hook
(`vouchers/hooks.ts`), derived tender rows, the counter's services and the day-end summary.

DTOs: `src/shared/types/pos.ts`. Renderer: `src/renderer/modules/pos` (README there).
Migration **180** (`180_pos.ts`, block 180–189). Feature: F11 › **POS invoicing** (`features.pos`,
needs Maintain stock).

| File | Purpose |
|---|---|
| `store.ts` | Settings (`settings` key `pos`), tender modes, the system exchange-credit ledger + mode, POS types created on F11, `pos.context` |
| `hook.ts` | The voucher hook: tenders → entries of the same voucher, checks, `pos_bills` / `pos_payments`, remove guards, statutory reminders |
| `lookup.ts` | Scan lookup (barcode / part no. / alias / exact name), item with price-level slabs / MRP / stock, customers by mobile (find / create) |
| `held.ts` | Held (parked) bills: hold, list, recall, discard |
| `returns.ts` | Return context of a bill (returnable quantities), open exchange credit, the POS side of a voucher |
| `reports.ts` | Day-end summary (by tender / cashier / counter, cash, credit, exchange, MRP saving) and the POS register |
| `print.ts` | `PrintVoucherData.pos` ("Paid by", cash tendered, change, counter, cashier); drops the "Scan to pay" QR of a paid bill |
| `routes.ts`, `schemas.ts` | Routes and input schemas (`VoucherPosSchema` is also used by `vouchers/routes.ts`) |
| `testkit.ts` | Test helpers |

## 1. Turning it on

F11 › POS invoicing (company `applyFeatures` → `ensurePosSetup`, also at company creation): creates,
once, and audits

- **POS Sales** — Sales type, `config = { posInvoice: true, invoiceMode: 'item', printTemplate: 'compact', showMrp: true, defaultPartyLedgerId: Cash, defaultLedgerId: Sales }`, own series `POS/1` (yearly);
- **POS Return** — Credit Note type, series `PR/1`, Compact receipt (stored as POS settings › returns type);
- the **Cash** tender mode on the reserved Cash ledger;
- the system ledger **POS Exchange Credit** (Current Liabilities, `reserved_code POS_EXCHANGE`) and the
  **Exchange credit** tender mode (kind `exchange`, one only, system).

More POS types (one series per counter, e.g.) are made under Masters › Voucher Types › *Use as: POS
invoice* (sales types only; fixed once the type has vouchers, like the mfg classes). Turning Maintain
stock off turns POS invoicing off. Card / UPI modes are created by the user (POS Settings) on a ledger
of their choice: Cash → a Cash-in-Hand ledger; card / UPI / wallet / other → a cash or bank ledger or a
current-asset clearing ledger (never a party, stock, tax, income or expense ledger, nor the exchange
ledger). A mode used on a bill keeps its kind and ledger and cannot be deleted (deactivate it).

## 2. Posting — `VoucherInput.posBill`

```ts
posBill: {
  tenders: [{ modeId, amount /* paise > 0 */, reference?, exchangeVoucherId? }],
  cashTendered?, // cash handed over (≥ the cash tenders); change = cashTendered − Σ cash tenders
  returnOfId?,   // return: the POS bill the goods come from
  counter?,      // till name (free text)
}
```

The engine builds the invoice as for any sale (party Dr G; Cr Sales, Output GST, ± round off; TCS of
the tds hook included). The pos hook (`adjust`, last of the static hooks) then, **in the same voucher**:

| Bill (Sales, party sign +) | Return (Credit Note, party sign −) |
|---|---|
| Dr each tender's ledger with its amount (role `cash_bank` for cash / bank ledgers, else `other`; card / UPI on a bank ledger carry instrument `card` / `upi` + the reference) | Cr each tender's ledger (refund); the exchange mode Cr *POS Exchange Credit* (credit issued) |
| Party entry reduced by Σ tenders → what is left is **credit** (on account) | Party entry reduced by Σ refunds → the rest is **credited to the customer** |

Σ entries stays 0 (the reduction equals Σ tenders); an entry brought to 0 is dropped by the engine. So a
walk-in bill paid by UPI 100 + cash 123 posts `Dr Bank 100, Dr Cash 123, Cr Sales 200, Cr CGST 11.50,
Cr SGST 11.50`. Exchange credit used on a later bill debits the exchange ledger, which nets to zero.
The unpaid part of a customer's bill stays on the party with the usual bill-wise `new` reference named
after the bill (a POS return of that customer with `originalInvoiceNo` = the bill settles it `against`).
`vouchers.party_ledger_id` / the party snapshot keep the buyer for GST, print and registers even when
the party gets no entry (fully paid).

**Checks** (preview: blocking warnings `pos` with a path; save: `BUSINESS_RULE`):
POS type for a sale; invoice modes only; tender modes exist and are active (an inactive one stays valid
on the bill that used it); Σ tenders ≤ bill; **a walk-in (cash / bank) party must be paid / refunded in
full** (credit needs a customer); cash tendered ≥ the cash tenders, only with a cash tender, never on a
return; exchange credit only from a POS return in the books, dated on or before the bill, at most what
is left on it (Σ over the bill's exchange tenders, other bills excluded); a return refers to a POS sale
in the books (not cancelled / optional), not dated before it, made to the same party, with items of the
bill, quantities still returnable (Σ of other POS returns of the bill with `affects_books = 1` — a
post-dated return counts before its date) and **value** still returnable: per item at most the bill's
taxable value for that quantity (the whole remainder when the rest comes back; 2 paise of rounding per
line), per note at most the bill value not yet returned + ₹1 round-off slack (`RETURN_ROUNDING_SLACK`:
a bill rounded down and returns rounded up). Exchange credit used counts every bill with
`affects_books = 1` (a post-dated bill too), so a credit is never spent twice.

**Alteration** (adjust, `voucherId` set) keeps what was built on the voucher true:
a bill with POS returns cannot sell an item below what came back, change customer, be dated after its
first return, become optional, or fall below the value refunded (± ₹1 per return); a return whose
exchange credit was used cannot issue less (an optional return issues none) nor be dated after the
first bill that used it. `compose`: a POS bill / return altered **without** `posBill` (voucher entry
screen, API) gets its saved block back (`storedPosBill`: tenders, cash tendered, return of, counter) and
is re-checked like on the counter — the tenders and the return link are never silently dropped.
`validate`: a `posBill` with F11 off is a `VALIDATION` error (so POS vouchers cannot be altered while the
feature is off; they can still be cancelled / deleted). `vouchers.duplicate` drops `posBill` (a copy is
paid again).

**Derived rows** (rebuilt by `write` in the voucher's transaction, removed by `clear` on alter /
cancel / delete; carry `date`, `affects_books`, `is_post_dated`, books filter as for `gst_lines`):
`pos_bills (voucher_id, kind, return_of_id, bill_value, paid, credit, cash_tendered, change_due,
counter)` and `pos_payments (voucher_id, line_no, mode_id, mode_name, kind, ledger_id, amount signed
like its entry, reference, exchange_voucher_id)`.

**Remove guards** (`beforeRemove`): a bill with POS returns in the books, or a return whose exchange
credit was used on a bill, cannot be deleted or cancelled (cancel / delete the later document first).

## 3. Routes (`pos.*`)

All company scope; every route except `pos.context` refuses with `BUSINESS_RULE` while F11 › POS
invoicing is off. Reads are `transactional: false`. No new permission.

| Route | Access | Input → output |
|---|---|---|
| `pos.context` | vouchers.view | `{}` → `PosContext` (types, walk-in, tender modes, price level, godown, company state, permissions) |
| `pos.settings.get` / `.save` | vouchers.view / company.manage | `PosSettingsInput` → `PosSettings` (audited `settings` › `pos_settings`) |
| `pos.tenderMode.list` / `.save` / `.delete` | vouchers.view / company.manage | tender modes (audited `pos_tender_mode`) |
| `pos.item.lookup` | vouchers.view | `{ code, date, priceLevelId?, godownId? }` → `{ item, candidates }` |
| `pos.item.get` | vouchers.view | `{ itemId, date, … }` → `PosItem` |
| `pos.customer.find` / `.create` | vouchers.view / masters.create | by mobile; create = name + mobile + state, Sundry Debtors, registration *Consumer* (through `accounts` `saveLedger`, audited) |
| `pos.held.list` / `.save` / `.recall` / `.discard` | vouchers.view / vouchers.create | held bills (≤ 100; audited `pos_held_bill`; recall removes it) |
| `pos.return.context` | vouchers.view | `{ voucherId? \| number + voucherTypeId?, date }` → `PosReturnContext` |
| `pos.exchange.open` | vouchers.view | `{ partyLedgerId? }` → open exchange credit |
| `pos.voucher` | vouchers.view | `{ id }` → `PosBillView \| null` |
| `pos.summary` / `pos.register` | reports.view | period (+ types, user, counter, kind, search, paging) |

Bills and returns themselves are saved by `vouchers.save` / previewed by `vouchers.preview`.

**Scan lookup** matches exactly, most specific first: barcode (`idx_items_barcode`), part number
(case-insensitive, `idx_items_part_no`), alias (first alias or any additional alias), name; active items
only. One match → the item with selling rate, price-level slabs on the date (Price levels feature;
`inventory/prices.ts › applicableSlabs`), MRP (paise, incl. taxes), stock in the counter's godown; several
→ candidates to choose from.

## 4. Day-end summary

`pos.summary` over `pos_bills` / `pos_payments` (books filter; filters: types, `userId` — null for bills
entered without a login —, `counter`, `modeId` = bills with a tender of that mode; the screen's rows
drill into `pos.register` with the same filters): bills, sales (invoice value), taxable,
GST, returns and their value / GST, net, credit sales / returns credited, **net cash** (cash received −
cash refunded = what the drawer should hold over its opening float), change given, exchange credit
issued / used, MRP saving (current item MRP × qty − value charged incl. GST, per line, never negative),
and the breakdowns by tender (received / refunded / net / bills), by cashier (`vouchers.created_by`, name
from the voucher meta) and by counter. MRP saving is one SQL aggregate (not a row per line). A type filter counts a return through the bill it came from.

## 5. Legal notes and assumptions

- A POS bill is a **tax invoice** (CGST s.31, Rule 46) issued from its own series (Rule 46(b): a
  consecutive series unique for the FY — several series are allowed); a return is a **credit note**
  (s.34) quoting the original invoice. **s.34(2)** (as amended w.e.f. 1-Oct-2022): output tax can be
  reduced by a credit note declared not later than **30 November** after the end of the FY of the
  supply (or the annual return, if earlier — not known here). A POS return dated after that 30 November
  raises a confirm reminder (`creditNoteGstDeadline`); it is not blocked (a commercial credit note
  without the GST reduction is a decision for the accountant).
- **Rule 46(e)**: for an *unregistered* buyer the name and address of the recipient, the address of
  delivery and the state are required when the taxable value is **₹50,000 or more** — a bill at or above
  that raises a confirm reminder (`RULE_46E_UNREGISTERED_PAISE`) when the buyer has no GSTIN and either
  is the unnamed walk-in party or a customer with no address (on the bill's party details or the ledger;
  customers created at the counter have none).
- **Place of supply**: the counter sends the company's state for goods handed over at the counter
  (IGST Act s.10(1)(a)/(c): the movement ends, or the goods are delivered, there), and the customer's state only when the cashier marks the
  goods as delivered to them. Services sold at a POS counter follow the same choice (s.12(2) would
  use the recipient's address on record) — assumption documented, change the place of supply if needed.
- **Cash limit**: ₹2,00,000 or more in cash on one bill raises a confirm reminder (Income-tax Act 1961
  s.269ST / penalty s.271DA; the Income-tax Act, 2025, in force from 1-Apr-2026, keeps the restriction —
  its new section number is deliberately not quoted). Per-day aggregation per person is not tracked.
- **MRP** (Legal Metrology (Packaged Commodities) Rules, 2011): printed per line with "You saved" by the
  print module; selling above MRP is a print warning there.
- Card settlements net of MDR are recorded later by the user (e.g. Contra / Journal from the clearing
  ledger to the bank with the MDR as an expense); the POS module does not model acquirer fees.

## 6. Known gaps

- Exchange credit is tied to the return that issued it (not a free-standing gift voucher / store credit
  card); a customer's store credit is their ledger balance.
- Held bills keep the prices they were held with (a line whose price now differs from the price list is
  marked "price set" and is not re-priced by quantity); recall restores the customer and the place of
  supply it was held with.
- B2C dynamic QR code (Notification 14/2020-CT, taxpayers with AATO above ₹500 crore) is not produced;
  the receipt's UPI "Scan to pay" QR is left out of a bill paid in full.
- A return refunds at the GST rate the engine applies on the return date (the item's current rate); a
  rate changed since the sale is not carried from the bill (the value caps above still apply).
- The register / summary attribute bills to the user who *created* them (an alteration by another user
  keeps the creator).
- XML data export writes POS bills as ordinary sales vouchers with their tender entries (no POS class in
  the file).
