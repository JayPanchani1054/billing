# POS renderer module (`pos`)

Counter billing screens over the core `pos` module (`src/core/modules/pos/README.md`). Everything
needs F11 › POS invoicing (`feature: 'pos'`). Pure logic lives in `lib/*.ts` with node tests.

| Screen | Id | Access | Menu |
|---|---|---|---|
| POS Counter | `pos.counter` `{ voucherTypeId?, id?, exchange? }` | vouchers.create | Transactions, Go To |
| POS Return / Exchange | `pos.return` `{ billId? }` | vouchers.create | Transactions, Go To |
| POS Day-end Summary | `pos.summary` | reports.view | Reports, Go To |
| POS Settings | `pos.settings` | vouchers.view (save: company.manage) | Masters, Go To |

`vouchers.entry` hands POS voucher types over to `pos.counter` (F10 / Go To / Alt+A on a POS bill), as
it hands mfg journal types to `mfg.journal.entry`. Voucher view panel (`VoucherPanel.tsx`): tenders,
change, on account, counter; **Alt+T** return / exchange. Print templates render `PrintBlock.tsx`
("Paid by" / "Refunded by", cash tendered, change, on account, counter and cashier).

## Counter keys

| Key | Action |
|---|---|
| (scan box) Enter | Add the scanned / typed code (`3*code` = three); an empty box → Payment |
| (scan box) ↑ ↓ | Select a line; **+ / −** change its quantity (a line at 0 is removed) |
| Ctrl+A | Payment (in the payment dialog: save the bill) |
| Alt+U | Customer by mobile (find / create with name + state; Walk-in clears) |
| Alt+Q / Enter on a line | Quantity, rate, discount, batch of the line |
| Ctrl+D | Remove the line |
| Alt+F | Find item by name / alias / part no. / barcode |
| Alt+M | Item master of the line |
| Alt+O / Alt+L | Hold the bill / bills on hold (Enter recalls, Alt+D discards) |
| Alt+Z | Clear the bill (confirmed) |
| Alt+P / Alt+V | Reprint / view the last bill |
| Alt+T | Return / exchange (from the last bill) |
| Alt+B | Day-end summary |
| Alt+S | POS settings (company.manage) |

Payment dialog: one row per active tender mode; the cash row takes the balance until the cashier types
into it ("Rest here" puts the remainder on a row); card / UPI references; exchange credit of an earlier
return; "Cash handed over" with quick amounts (exact, next ₹10 / 50 / 100 / 500 / 2,000) and the change.
For a walk-in cash sale the cursor starts in "Cash handed over": type it, Enter saves. A walk-in bill
must be paid in full; a customer's may leave the rest on account.

## Design notes

- The big total is the posting engine's own `vouchers.preview` of exactly the bill (debounced 120 ms),
  so GST, round-off and price-level rates are what will be saved; it greys out while recomputing and
  Payment waits for it. The preview carries an empty POS block (`posBill: { tenders: [] }`), so the
  bill's own pos checks show at once (`lib/tender.ts › billBlockers`: everything blocking except what
  the payment settles — e.g. an altered bill selling less than came back, a return above what is left
  on the bill) and the Rule 46(e) reminder shows as a notice; an alteration must send the block, or the
  engine re-attaches the saved tenders.
- Recalling a held bill restores its customer and the place of supply it was held with
  (`lib/cart.ts › deliveryFromDraft`).
- Day-end summary: Enter on a tender / cashier / counter row lists just those bills
  (`lib/summary.ts › drillTender / drillUser / drillCounter` → `pos.register` filters); choosing a view
  (Ctrl+1…4) clears it. The bill list shows at most 1,000 rows (the footer says so when there are more).
- Prices: price-level slab for the line's quantity (POS Settings › price level) else the item's selling
  price; a hand-set rate / discount is kept and marked "price set" (the next scan of that item adds a
  new line instead of re-pricing it).
- Receipt printing (`ReceiptPrinter.tsx`): the bill is rendered off screen with the print module's
  template and paper (Compact on the 80 / 58 mm roll set under Invoice Printing, voucher-type overrides)
  and printed with the roll printer chosen on this computer (Print Preview › Printer) — silently when
  chosen, else through the print dialog. One copy.
- The counter name ("Till 1") is remembered per computer (`lib/counter.ts`, localStorage) and stored on
  each bill for the day-end summary.
- Place of supply: the company's state (over the counter); a customer from another state can be marked
  "goods delivered to the customer" (IGST).

| File | What |
|---|---|
| `lib/cart.ts` | scan parsing, add / increment, quantity slabs, line values, MRP, bill input, held drafts |
| `lib/tender.ts` | tender rows, balance row, exchange row, change, problems, posBill |
| `lib/returns.ts` | returnable quantities, credit note input |
| `lib/summary.ts` | KPI tiles, cash drawer count, export tables |
| `lib/print.ts` | printed "Paid by" rows |
| `lib/counter.ts` | counter name (per computer) |
