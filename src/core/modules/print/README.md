# Print module

Everything needed to put a voucher on paper. The core builds a **print DTO** (`PrintVoucherData`,
`src/shared/types/print.ts`); the renderer (`src/renderer/modules/print`) renders it with React
templates and sends the serialised HTML to `bahi.native('print.print' | 'print.savePdf')`.
Templates never call the API and never compute money.

## Routes

| Route | Access | Input | Output |
|---|---|---|---|
| `print.voucherData` | vouchers.view | `{ id, overrides? }` | `PrintVoucherData` |
| `print.batchData` | vouchers.view | `{ ids }` (1–500) | `{ documents: PrintVoucherData[], notFound: number[] }` (order kept, duplicates dropped) |
| `print.sample` | company.view | `{ overrides? }` | `PrintVoucherData` of a sample invoice (`sample: true`, `id: 0`) for the settings preview |
| `print.bankLedgers` | company.view | `{}` | `PrintBank[]` — active ledgers under Bank Accounts / Bank OD **and their sub-groups**, with account details (the Invoice Printing bank select and the F12 › Invoices summary) |
| `print.share.context` | data.export | `{ voucherId }` or `{ statement: { ledgerId, from, to } }` | `ShareContext`: party e-mail / mobile, subject, body and WhatsApp text from F12 › Sharing, PDF file name (print group) |
| `print.share.log` | data.export | `ShareLogInput` (`channel`, `to?`, `fileName`) | `{ ok: true }` — the `export` edit-log entry, written before main renders the PDF (print group) |

All are read-only and `transactional: false`. `overrides` is a partial `CompanyConfig['invoice']`
applied for this call only (live preview of the print settings); it is validated like the config
(`upiId` must be a valid VPA or empty).

## Layouts

| Layout | When | Lines from |
|---|---|---|
| `invoice` | sales / purchase / credit / debit notes in item or accounting invoice mode; orders, notes and rejections entered with prices (item_invoice) | the posting engine, checked against the books (below) |
| `inventory` | challans / orders / notes / rejections entered as quantities, stock journal (source / destination), physical stock | the stock lines as entered |
| `voucher` | payment, receipt, contra, journal, memorandum, any ledger-mode voucher | the stored ledger entries (bills, instruments, cost centres) |

### Invoice lines — engine first, books always win

`fromEngine` re-runs `buildPosting` on the voucher as entered (`vouchers.meta.input`) with the party
snapshot and place of supply **pinned** to what was saved, to get per-line gross, discount,
absorbed charges and per-line tax. The result must equal the books:

- header `taxable_amount` and `tax_amount`, and every `gst_lines` row (taxable, IGST, CGST, SGST, cess, rate);
- if only the round-off differs (F12 round-off changed since), the voucher's own round-off is used.

When it does not tie (masters changed after saving), or the voucher has no entry detail (imported),
or the engine throws, `fromBooks` builds the lines from `gst_lines` + `inventory_entries` +
`ledger_entries` and `warnings` explains it. Cancelled vouchers are recomputed from their stored
input (the books are zeroed) and marked.

Line amounts: `amount` is the line's own value after discount; a charge absorbed into the goods'
taxable value (freight with *include in assessable value*) is listed as its own line with
`absorbed: true`, `taxableValue: 0` and its amount, so **Σ amount = Σ taxableValue = totals.taxable**.
In `fromBooks` the absorbed amount is taken back out of the goods lines by value (largest remainder).

### Totals (asserted in tests for every kind)

```
totals.taxable + totals.tax + totals.charges + totals.roundOff = totals.grandTotal = vouchers.total_amount
```

`tax` counts only tax payable with the invoice; reverse-charge tax (and IGST on imported goods) is
in `reverseChargeTax` and printed as a note. `charges` are non-GST lines outside the computation
(TCS, a non-GST discount — negative). `taxByRate` / `taxByHsn` are built from the lines and tie to
`taxable` and `tax + reverseChargeTax`.

## Titles (titles.ts)

| Document | Title / endorsement |
|---|---|
| Sales, regular dealer, all lines taxed | Tax Invoice (voucher-type *Print title* may replace it) |
| Sales, only exempt / nil / non-GST lines | Bill of Supply (Rule 49) |
| Sales, taxed + untaxed lines | Invoice-cum-Bill of Supply (Rule 46A) |
| Sales, composition dealer | Bill of Supply + "Composition taxable person, not eligible to collect tax on supplies" |
| Sales, company not registered / GST off | Invoice |
| Export (LUT / with payment) | Export Invoice + "Supply meant for export under LUT without payment of IGST" / "… with payment of IGST" |
| SEZ (LUT / with payment) | Tax Invoice + SEZ endorsement |
| Purchase | Purchase Voucher; reverse charge from an unregistered supplier → Self Invoice |
| Credit / Debit Note | Credit Note / Debit Note (+ original invoice no., date, reason) |
| Delivery note | Delivery Challan (Rule 55) |
| Others | Sales Order, Purchase Order, Receipt Note, Rejections In/Out, Payment / Receipt / Journal / Contra Voucher, Memorandum Voucher, Reversing Journal, Stock Journal, Physical Stock Verification |

Statutory titles (bill of supply, invoice-cum-bill, export, SEZ, self invoice, notes, challan) are
never replaced by a custom print title.

Copy labels: goods invoices *Original for Recipient / Duplicate for Transporter / Triplicate for
Supplier*; services *Original for Recipient / Duplicate for Supplier*; challans *Original for
Consignee / Duplicate for Transporter / Triplicate for Consigner*; everything else plain.

## Statutory checks (compliance.ts)

`warnings` also lists missing statutory particulars of documents the company issues (never for
purchases from suppliers, cancelled / optional vouchers, or a company not under GST). They never block
printing; the preview shows them under "Before you print".

| Check | Rule |
|---|---|
| Serial number present, ≤ 16 characters, only letters / digits / `-` / `/` (invoices, notes, challans) | CGST 46(b), 55(1)(a) |
| Registered buyer has a GSTIN and an address; unregistered buyer with taxable value ≥ ₹50,000 has name, address and state | 46(d), 46(e) |
| Export invoice names the country of destination | proviso to 46 |
| Place of supply present (taxed documents) | 46(n) |
| HSN/SAC: ≥ 4 digits on B2B / export / SEZ lines; ≥ F12 › GST › HSN digits (6/8) on every line above ₹5 crore | 46(g), N/N 78/2020-CT |
| Credit / debit note names the invoice it adjusts | 53(1)(g) |
| E-invoicing on (F11): B2B / export / SEZ invoice or note has an IRN | 48(4), 48(5) |
| Taxable line with no GST rate on a regular dealer's invoice (other than export / SEZ) | master data |

## Presentation rules

- A Bill of Supply has `gst.showTax = false` (no tax columns, rate summary or reverse-charge line;
  HSN stays on the lines) — Rule 49.
- Inward documents (purchases, notes from suppliers) have no ship-to box (`consignee = null`); a
  purchase order ships to the company.
- A delivery challan without a separate ship-to labels the party *Consignee (Ship to)*; its place of
  supply is the consignee's (else the party's) state when the voucher has none — Rule 55(1)(d), (g).
- Terms & conditions print on what the company sells (invoices, outward debit notes, sales orders),
  not on credit notes or challans.
- Bank details only ever come from a ledger under Bank Accounts / Bank OD (a party ledger id in the
  configuration or a preview override prints nothing).
- An imported accounting invoice of a company not under GST (no `gst_lines`) prints its sales /
  purchase ledger entries as the lines.

## Options

`options` = config.invoice (edited only on Invoice Printing, `print.settings`; F12 › Invoices summarises it), then the voucher type's `config` (`printTemplate`,
`bankLedgerId`, `declaration`, `terms`), then `overrides`. `defaultTemplate` is `options.template`.

- Bank details: outward invoices / debit notes / sales orders when `showBankDetails` and a bank
  ledger is chosen.
- UPI: `showUpiQr` and a UPI id (`options.upiId`, else the bank ledger's) on outward documents with
  a positive total that are not cancelled and not export invoices (UPI collects rupees from Indian
  accounts) → `upi.uri` =
  `upi://pay?pa=<vpa>&pn=<company>&am=<rupees.paise>&cu=INR&tn=<title number>` (percent-encoded).
- Declaration only on sales documents and outward debit notes; terms as above.
- e-Invoice (`irn`, `ackNo`, `ackDate`, `signedQr`) and e-Way Bill come from the voucher (printed as "e-Invoice" / "e-Way Bill No.", GSTN's spelling).
- `navigation.prevId / nextId`: same voucher type, ordered by date, number sequence, id.

## Paper sizes and thermal receipts (print group)

`config.invoice.paperSize` (A4, A5, A5 landscape, Letter, Legal) is the paper of the Modern and
Classic templates; `rollWidth` (80 mm / 58 mm) is the roll of the Compact template. A voucher type's
`printTemplate` and every print preview (Alt+T template, Alt+S paper) can change them. The renderer
names the size (`NativePageSize`, shared/bridge.ts) and Electron main (`src/main/printPage.ts`,
pure and unit-tested) turns it into what each API expects: `webContents.printToPDF` takes a named
size or `{ width, height }` in **inches**, `webContents.print` a named size or `{ width, height }` in
**microns**; A5 landscape is A5 + `landscape: true`. Rolls are continuous paper: the page is the roll
width by the receipt's measured height (40 mm – 3 m), edge to edge (the layout carries its own
padding). `custom` (50–400 mm each side) is used by cheque leaves (202 × 92 mm). Sizes and lengths
are validated in main; anything else is refused.

The Compact template is built for rolls: no wide tables — item, `qty × rate`, amount; a tax summary
by rate; totals; MRP and "You saved" when shown.

## MRP (print group)

The item master's MRP (`stock_items.mrp`, paise per unit, inclusive of all taxes) is on each line
(`PrintLine.mrp`). Invoice Printing (print settings) › *Show MRP* (or the voucher type's *MRP column*, which
wins) prints an **MRP** column with "MRP inclusive of all taxes" on outward sales documents (sales
invoices and outward notes, quotations, proforma invoices, sales orders, delivery challans), and on
invoices **"You saved ₹…"** =
Σ max(0, MRP × qty − value charged incl. GST) per line (`mrpSummaryOf`). Selling a pre-packaged
commodity above its MRP is not allowed (Legal Metrology (Packaged Commodities) Rules, 2011): the
preview of an invoice warns when a line's value incl. tax exceeds MRP × qty (`aboveMrpWarning`,
with a paisa-per-unit rounding allowance), never blocking. The MRP is the item master's **current**
MRP when the document is printed — it is not frozen with the voucher, so a reprint after the MRP was
changed shows the new MRP (known gap below).

## Sharing (print group)

Alt+W on a voucher view / print preview, and on the Statement of Account / outstanding screens,
opens the Share dialog. `print.share.context` pre-fills the recipient from the party ledger (e-mail;
*Mobile*, else a *Phone* that is a mobile number) and the texts from F12 › Sharing
(`config.share`, placeholders `{document} {number} {date} {amount} {party} {company} {period}`,
edited on Invoice Printing). A voucher with no party (a Contra, a journal) is addressed to its first
ledger with an e-mail or phone that is **not** a cash or bank ledger — a bank branch's contact is never
offered as the recipient. The renderer calls `print.share.log` (data.export, edit log `export`)
and then the native action, which renders the PDF from the same preview HTML:

- `share.email` — main saves the PDF in the company's own folder `<data>/companies/<id>/exports/shared`
  (chosen by main, never a renderer path; collision-free names), writes a draft **.eml** next to it
  (RFC 5322 / MIME `multipart/mixed`, base64 PDF attachment, RFC 2047 headers, `X-Unsent: 1` so
  Outlook / Windows Mail open it as an editable draft, no `From:`; CR/LF in any header refused) and
  opens it with the default mail program; when none opens .eml files it falls back to a `mailto:`
  link and shows the PDF in its folder.
- `share.whatsapp` — main saves the PDF, validates the number (10-digit Indian mobile starting 6–9 →
  `91…`) and opens `https://wa.me/91XXXXXXXXXX?text=…` (the user confirms the external link), then
  shows the PDF in its folder to attach in WhatsApp (WhatsApp offers no way to attach a file from a
  link).

## Known gaps

- MRP is read from the stock item when printing, not stored per invoice line: reprinting an old
  invoice after the item's MRP changed prints the new MRP. Keep the old MRP until old invoices are
  printed, or note it on the invoice.

- A thermal receipt is one continuous page as long as its contents (measured in the preview, 40 mm
  to 3 m). Drivers that do not support a custom page length print it on their default roll page and
  cut where the driver decides; set the roll's paper size in the printer's own settings if it does.
- With several copies or vouchers in one job, pages show "Page n" (Chromium cannot restart the page
  counter per document); a single document shows "Page n of m".
- An invoice in a foreign currency prints the usual rupee invoice (GST in rupees) plus a block with
  each line / charge in the currency, the rate, GST and the total in both currencies and the total in
  words in the currency (`PrintVoucherData.forex`, built by forex/print.ts; rendered by the Modern,
  Classic and Voucher templates). The Compact (thermal) template does not print it.
- A POS bill / return (pos module) carries `PrintVoucherData.pos` (built by pos/print.ts): the tenders
  with references, on account, cash tendered and change, counter and cashier — the "Paid by" block of
  the Compact, Modern and Classic templates (`renderer/modules/pos/PrintBlock.tsx`). A bill paid in full
  at the counter has no "Scan to pay" UPI QR; one partly on account asks for the balance only.
