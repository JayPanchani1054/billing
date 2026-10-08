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
| `print.bankLedgers` | company.view | `{}` | `PrintBank[]` — Bank Accounts / Bank OD ledgers with account details |

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

`options` = F12 › Invoice printing, then the voucher type's `config` (`printTemplate`,
`bankLedgerId`, `declaration`, `terms`), then `overrides`. `defaultTemplate` is `options.template`.

- Bank details: outward invoices / debit notes / sales orders when `showBankDetails` and a bank
  ledger is chosen.
- UPI: `showUpiQr` and a UPI id (`options.upiId`, else the bank ledger's) on outward documents with
  a positive total that are not cancelled and not export invoices (UPI collects rupees from Indian
  accounts) → `upi.uri` =
  `upi://pay?pa=<vpa>&pn=<company>&am=<rupees.paise>&cu=INR&tn=<title number>` (percent-encoded).
- Declaration only on sales documents and outward debit notes; terms as above.
- E-invoice (`irn`, `ackNo`, `ackDate`, `signedQr`) and e-way bill come from the voucher.
- `navigation.prevId / nextId`: same voucher type, ordered by date, number sequence, id.

## Known gaps

- `print.print` in the main process (src/main/print.ts) always asks Chromium for A4 paper, and
  `print.savePdf` accepts A4/A5/Letter/Legal only (no `preferCSSPageSize`). A5 prints use an A5
  `@page` rule (honoured when the printer dialog leaves paper to the document); 80 mm receipts keep
  a 72 mm-wide, centred layout on whatever sheet is used (an A4 page in a PDF).
- With several copies or vouchers in one job, pages show "Page n" (Chromium cannot restart the page
  counter per document); a single document shows "Page n of m".
- Multi-currency invoices print in rupees only.
