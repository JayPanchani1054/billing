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
| `gst.setoff` | `{ period? }` | GST set-off for the return period (GSTR-3B 6.1, or CMP-08 for composition): credit used per Rule 88A, cash per major × minor head with the cash ledger balance and what is still to deposit (penalty / others typed in), challans of the period (Enter → voucher). Alt+C create challan (PMT-06: CPIN, CIN, BRN, date, bank, mode, head grid prefilled), Ctrl+A post the set-off journal, Alt+V open it, Alt+L cash ledger, Alt+R the return |
| `gst.ledger.cash` | `{ from?, to? }` | Electronic Cash Ledger (books): KPIs, closing by major × minor head, transactions (Enter → voucher). Alt+S set-off, Alt+L credit ledger |
| `gst.ledger.credit` | `{ from?, to? }` | Electronic Credit Ledger (books): opening / accrued / reversed / utilised / closing per head, transactions in Dr / Cr (as on the Input ledgers: Dr = credit booked, Cr = reversed / used; the column totals are closing − opening). Alt+S set-off, Alt+L cash ledger, Alt+I Input Tax Credit |
| `gst.cmp08` | `{ period? }` (quarter) | CMP-08 table 3 / 4, turnover KPIs, notes. Alt+I interest, Alt+F mark filed, Alt+J / Alt+K save JSON / CSV (Pevqori format, FileResultDialog), Alt+S set-off, Alt+R GSTR-4. Explains itself for a regular taxpayer |
| `gst.gstr4` | `{ fy? }` | GSTR-4 tables 5 (Enter → that quarter's CMP-08), 4A–4D, 6, 8; Alt+J / Alt+K files, Alt+F mark filed |
| `gst.composition` | — | Composition category + effective-dated rate master: Alt+C create, Enter / Alt+A alter, Alt+D delete (dialog with Enter-advance, Ctrl+A) |
| `gst.advances` | `{ from?, to?, view? }` | Ctrl+1 Table 11 (11A / 11B by POS and rate, vouchers; KPIs incl. the net in 3.1(a)); Ctrl+2 pending advances as on the period end. Alt+C create an advance receipt, Alt+R GSTR-1. GSTR-1's table 11 tile opens this screen |
| `gst.boe` | `{ from?, to? }` | Bills of entry register; Alt+O reconcile with a GSTR-2B JSON / ZIP (IMPG / IMPGSEZ: matched, mismatch, not in books, not in 2B); Ctrl+1 back to the register; Alt+C create an import purchase |
| `gst.amendments` | `{ period?, all? }` | GSTR-1 amendments reported in a period (Ctrl+1) or all (Ctrl+2): table (9A B2BA …, 9C, 10, Added), original / amended value, Δ taxable / tax; Enter → voucher |
| `gst.gstr3b.changes` | `{ period?, all? }` | Vouchers changed (altered / added late / deleted) after their period's GSTR-3B was filed, reported in a period (Ctrl+1) or all (Ctrl+2): Δ tax payable, Δ net ITC; Enter → voucher (`GapsScreens.tsx`, helpers `lib/gaps.ts`) |
| `gst.rule37` | `{ asOf? }` | Rule 37: purchases unpaid after 180 days as on a date — unpaid, reversed, reverse now / reclaim now; Alt+R post reversal, Alt+L post reclaim (gst.file, confirm dialog with date + narration); Enter → purchase |
| `gst.filings` | — | Returns marked filed (form, period, date, ARN); Enter opens the return; Alt+U unmark (confirm), Alt+M amendments |

Range screens use the global period (Alt+F2); a caller may pass `{ from, to }` (e.g. GSTR-1 → exceptions)
which holds until the user changes the period.

Pure logic lives in `lib/*.ts` with tests: `node --test "src/renderer/modules/gst/**/*.test.ts"`.
- `periods.ts` period options / defaults · `gstr1.ts` tile mapping and exports · `gstr3b.ts` manual-entry
  draft + dirty diff, 3.2 table, set-off explanation, print table · `issues.ts` fix links ·
  `compliance.ts` bulk selection, e-way bill entry, IRP import summary, IRN cancellation window / reasons ·
  `reports.ts` export tables. `gstr1.ts` also builds the section export (`sectionExport`), `gstr3b.ts` the
  portal 6.1 layout (`paymentSections`), `periods.ts` maps a date range back to a return period.

GST tables show credit notes / purchase returns as negative amounts (as the portal does) rather than Dr/Cr.

**GST plus wiring.** GSTR-1 gets Alt+F mark filed (filed banner; later changes become amendments), Alt+M
amendments (count shown) and its table 11 tile opens `gst.advances`; GSTR-3B gets Alt+S set-off, Alt+F
mark filed and a line listing what the books added (advances, stat journals, bills of entry). Both show
a composition banner. Menu items carry `gstRegistrations` (shell filter, `app/lib/menu.ts`): GSTR-1,
GSTR-3B, GSTR-9, ITC, e-Invoice, Electronic Credit Ledger, Advances and Amendments for regular
taxpayers; CMP-08, GSTR-4 and Composition Rates for composition taxpayers. Extension points used:
`dashboardCards` (`CompositionCard`: CMP-08 / GSTR-4 due dates, `compositionDues`) and `voucherPanels`
(`VoucherGstPanel`: the voucher's GST details and its amendment log). Voucher entry opens
`GstDetailsDialog.tsx` with Alt+J (see vouchers/README.md). Pure helpers: `lib/gstplus.ts` (challan
defaults / grid, field checks for CPIN / CIN / bill of entry / composition rate / typed return period (`periodKeyError`: the dialog's stat-adjustment and challan period fields), `gstDetailsKinds`,
`gstDetailsForBase`, summaries, quarters, due dates, exports) — tests in `lib/gstplus.test.ts`.
