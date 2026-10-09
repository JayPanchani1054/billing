# GST screens (`src/renderer/modules/gst`)

UI for the GST returns core (`src/core/modules/gst`, DTOs in `src/shared/types/gst-returns.ts`).
Every screen is `gstOnly`, needs `gst.view`; file exports and manual 3B entries need `gst.file`
(the actions are disabled with a hint otherwise).

| Screen id | Params | What |
|---|---|---|
| `gst.gstr1` | `{ period? }` | Return-period selector (`gst.periods`), tiles 4A 4B 5 6A 6B 6C 7 8 9B 11 12 13, uncertain transactions with fix links, Alt+J JSON (asks first when there are errors), Alt+E summary export |
| `gst.gstr1.section` | `{ period, tile, section? }` | One table: aggregate rows (B2CS / nil / HSN / documents issued) + vouchers (signed: credit notes negative, invoice value too, so columns add up to the totals); tabs for multi-part tables (Alt+←/→); Enter → `vouchers.view`; export with totals |
| `gst.gstr3b` | `{ period? }` | Portal-style form 3.1, 3.1.1, 3.2, 4, 5, 5.1, “Your entries” (Ctrl+A saves only changed cells), 6.1 payment as on the portal — (A) other than reverse charge: payable, paid through each ITC head, cash, interest, late fee; (B) reverse charge in cash — with the cash total highlighted, ITC set-off explanation, Alt+J JSON (asks first when the period has GST errors), Alt+P print |
| `gst.gstr9` | `{ fy? }` | Annual summary (tables 4, 5, 6, 9, months, 17/18) with the “Prepared from books — verify before filing” banner; Enter on a month → its GSTR-3B |
| `gst.hsn` | `{ direction? }` | HSN/SAC summary, outward / inward (Ctrl+1/2) |
| `gst.register` | `{ kind?, from?, to? }` | Sales / purchase register (Ctrl+1/2; purchases show the supplier invoice no. and date); Enter → voucher |
| `gst.itc` | `{ from?, to? }` | ITC by supplier and by type; Enter → `reports.ledger` |
| `gst.exceptions` | `{ from?, to? }` | All uncertain transactions, filters (Ctrl+1/2/3, problem type), Enter → `vouchers.view`, Alt+A alter voucher, Alt+M open the master to fix; period-level gaps link to GSTR-1 table 13 |
| `gst.einvoice` | `{ from?, to?, view?: 'pending' \| 'generated' }` (feature `einvoice`) | Ctrl+1 **Pending IRN**: readiness errors, Space select / Alt+S select all ready, Alt+A alter voucher, Alt+J bulk JSON (rejected list with links), Alt+I import IRP response (JSON/XLSX), vouchers cancelled in the books with an active IRN. Ctrl+2 **IRN generated** (`gst.einvoice.generated`): ack no./date, 24-hour IRP cancellation window, Alt+K mark IRN cancelled (IRP reason codes 1–4 + remarks). Alt+H history in both |
| `gst.ewaybill` | `{ from?, to? }` (feature `ewayBill`) | Pending e-way bills (threshold shown), Space select / Alt+S select all ready, Alt+A alter voucher, Alt+J bulk JSON (rejected list with links), Alt+N record EWB no./date/validity, Alt+H history |

Range screens use the global period (Alt+F2); a caller may pass `{ from, to }` (e.g. GSTR-1 → exceptions)
which holds until the user changes the period.

Pure logic lives in `lib/*.ts` with tests: `node --test "src/renderer/modules/gst/**/*.test.ts"`.
- `periods.ts` period options / defaults · `gstr1.ts` tile mapping and exports · `gstr3b.ts` manual-entry
  draft + dirty diff, 3.2 table, set-off explanation, print table · `issues.ts` fix links ·
  `compliance.ts` bulk selection, e-way bill entry, IRP import summary, IRN cancellation window / reasons ·
  `reports.ts` export tables. `gstr1.ts` also builds the section export (`sectionExport`), `gstr3b.ts` the
  portal 6.1 layout (`paymentSections`), `periods.ts` maps a date range back to a return period.

GST tables show credit notes / purchase returns as negative amounts (as the portal does) rather than Dr/Cr.
