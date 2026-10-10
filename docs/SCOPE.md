# Pevqori 1.0 — scope: what is deliberately left out or partial

Pevqori covers the day-to-day books, GST, TDS / TCS, inventory, manufacturing, banking and reporting of
an Indian small or medium business, offline, on one Windows computer. This page lists, honestly, what it
does **not** do, what it does only in part, and the legal assumptions to check — so you can decide what
to keep doing elsewhere (on the government portals, in your CA's software, by hand).

It is collected from the "known gaps" of every module README (`src/core/modules/*/README.md`,
`src/renderer/modules/*/README.md`) and from [SECURITY.md](SECURITY.md); those files have the technical
detail. How to use what *is* built is in the [User Guide](USER_GUIDE.md).

Three principles explain most of the list:

- **Offline first.** Pevqori makes no network calls. Anything that needs a government or bank API (with
  credentials, a whitelisted IP and a live connection) is done by a file round trip instead, or not at all.
- **One company, one place, one user at a time.** A company is a folder with one database, opened by one
  copy of Pevqori at a time. There is no server.
- **Never guess a legal format.** Where an official file layout (FVU, portal offline-tool JSON, a bank's
  upload format) could not be reproduced with certainty, Pevqori writes a documented CSV / JSON of the same
  fields rather than a file that might be rejected or, worse, accepted wrongly.

## 1. Deliberately out of scope

| Not in 1.0 | Why | What to do instead |
|---|---|---|
| **Payroll** (salary, PF / ESI, payslips) and **salary TDS** — section 192, Form 24Q, Form 16 | A payroll module is a product of its own (attendance, structures, statutory slabs) | Use payroll software; post the salary journal and the TDS payable in Pevqori |
| **Direct e-invoice (IRP), e-way bill and GSP APIs**; uploading returns to the GST portal | Needs GSP / API credentials and a live connection; Pevqori is offline | JSON round trip: save the JSON in Pevqori, upload it on the portal, import the IRP response / record the EWB number (User Guide §6.3); upload GSTR-1 / 3B JSON in the portal's offline utility |
| **Invoice Management System (IMS)** accept / reject / pending actions | Portal-side workflow; no offline file to exchange | Act on the portal; reconcile GSTR-2B in Pevqori (User Guide §6.6) |
| **Multi-company consolidation**, group accounts, inter-company eliminations | Each company is a separate folder and database, opened one at a time | Export each company's Trial Balance (Alt+E) and consolidate in a spreadsheet |
| **Several users working at the same time** / client–server use | Single-writer design (one lock per company) keeps the books consistent without a server | Take turns; keep one Owner per company; use users and roles for who may do what |
| **TDS FVU file**, **Form 16A / 27D** certificates, TRACES integration, correction statements | The RPU / FVU formats change between versions and could not be reproduced with certainty; certificates must come from TRACES | Pevqori saves two CSV files with every RPU field (User Guide §7, step 7); validate with the current FVU; download certificates from TRACES |
| **Portal offline-tool files** for ITC-04 and GSTR-4 (and CMP-08, which has no upload at all) | Schemas not reproduced with certainty | Pevqori's documented CSV / Excel / JSON of the same tables to key into the offline tool or portal |
| **Downloading exchange rates**; FCMITDA (AS 11 para 46A), hedge accounting; automatic reversal of a revaluation | Offline; these are judgements for your CA | Type the rates (bank's or CBIC's); pass journals; duplicate and reverse the revaluation journal yourself |
| **Bank integrations** — host-to-host payments, bank-specific bulk-upload formats, automatic statement download; bank-specific cheque layouts | Each bank's format differs and changes; no network access | Generic documented e-payment CSV (map its columns once in net banking); import downloaded statements (CSV / Excel); calibrate a cheque layout once per bank |
| **Tally job work vouchers** (Material In / Out) and **budgets** in the Tally XML import | Not mapped; budgets are skipped as unsupported objects | Re-enter them in Pevqori after migrating |
| **Multi-level BOM explosion** | One level per BOM keeps costing traceable | Make sub-assemblies with their own Manufacturing Journal first |
| **Other GST returns and forms**: GSTR-9C (reconciliation statement), GSTR-6 (ISD), GSTR-7 / GSTR-8 (GST TDS deductors, e-commerce operators), ITC-03, GSTR-10 | Outside a regular or composition supplier's monthly cycle; GSTR-9 is a summary from the books only | Prepare them on the portal or with your CA; the GSTR-9 summary, registers and Trial Balance give the figures |
| **Fixed-asset register and automatic depreciation** (Companies Act Schedule II, Income-tax block of assets) | Not built | Keep the asset register outside Pevqori and pass the depreciation journal (F7) |
| **B2C dynamic QR code** (Notification 14/2020-CT, aggregate turnover above ₹500 crore) | Out of the target market | The printed UPI "Scan to pay" QR is a payment QR only |
| **Automatic updates**, cloud sync, uploading backups | Offline by design; nothing to verify an update against | Install new versions yourself (INSTALL.md); point the backup folder at a cloud-synchronised folder if you want |
| **macOS, Linux, 32-bit or ARM Windows** installers | One supported platform is tested end to end | Windows 10 / 11, 64-bit |
| **Unattended recurring postings** | Pevqori has no background process; posting without review would bypass warnings | Review the due list and post with one key (User Guide §4.6) |
| **Sending e-mail or WhatsApp messages itself** | No network access | Pevqori prepares the PDF and the draft; your mail program or WhatsApp sends it |
| Interface and letters in languages other than English | Not built | Ledgers and items can carry local-language aliases |

## 2. Built, but partial

### GST
- **Not derived:** e-commerce operator supplies (GSTR-3B 3.1.1, GSTR-1 tables 14 / 15), ISD distribution,
  amendments of advances (11A(2) / 11B(2)); amendments of small B2C sales (table 10) are listed but must
  be entered on the portal by place of supply and rate.
- GST must be entered in **invoice mode** (item or accounting invoice); tax typed on a plain journal is not
  in the returns (Pevqori warns). A ledger's "GST nature override" is stored but not applied.
- The **electronic credit and cash ledgers** are rebuilt from your books, not read from the portal; a
  **set-off already posted** is not recomputed when the period's vouchers change (alter or repost it).
- **Rule 37**: interest u/s 50 is not worked out; suppliers kept without bill-wise details cannot be
  traced automatically.
- **Composition:** GSTR-4 table 7 (TDS / TCS credit) is not kept; GST on advances is not computed for a
  composition dealer.
- **e-Way bills** for inward supplies from unregistered suppliers and purchase returns are not listed as
  pending; the IRP's PIN ↔ state check is not repeated locally; the 30-day IRN reporting limit and the
  24-hour cancellation window are shown, not enforced.
- **Bills of entry:** the GSTR-2B Excel download is not read for IMPG (use the JSON or ZIP).
- Quarterly GSTR-1 files contain the whole quarter: do not upload invoices already sent through IFF again.
- The **dashboard GST card** is monthly (quarterly filers see the month's estimate) and does not know which
  returns are filed.

### Vouchers and numbering
- Numbering codes cover the financial year, calendar year and month — no day code and no quarterly
  restart. A voucher keeps its number when its date is moved to another month or year (as in Tally);
  renumber it by hand if the old label must not stay.
- A GST invoice number typed by hand that breaks CGST Rule 46(b) (16 characters; letters, digits, `/`,
  `-`) is a warning you confirm, not a block.
- The negative-stock check looks at the voucher's own date: a back-dated entry entered later does not
  re-check the vouchers after it (the Negative Stock report shows the result).
- Order numbers that repeat across years for the same party share their fulfilment (delivery / receipt
  notes and invoices are linked by party and order number).

### TDS / TCS
- Surcharge and cess are entered on challans only; non-resident (195) rates are a placeholder to set per
  remittance.
- Interest on short deduction is an estimate (Exceptions report only).
- Debit / credit notes reverse TDS / TCS in proportion only in the invoice modes and only when they name
  the bill (bill-wise *Against* or original invoice number); the reversal assumes every nature of the bill
  is returned in the same proportion.
- An advance below the threshold (nothing deducted) is not set off against the later bill.
- After a statement is recorded as filed, a correction statement is flagged but not tracked further.

### Inventory and manufacturing
- **Physical stock** stores the difference counted − books at its save; a back-dated voucher entered later
  is not re-absorbed (re-save the count). Tally re-bases on the counted quantity.
- No lower-of-cost-or-market valuation (market value is stored, not used). Value-only inward lines are
  ignored by valuation. Average cost with negative stock restarts the average at the next inward rate.
- Batch Summary is not split by godown and shows no values; orders have no per-line due date; Movement
  Analysis values notes at their own rate; Stock Ageing treats LIFO items like FIFO.
- Manufacturing additional costs never post to their expense ledgers (as in Tally) — book the expense
  separately. The ITC-04 "turnover above ₹5 crore" switch is remembered per computer, not per company.
  The Material Out print lists both sides of the stock journal.
- A stock item switched from "inherit GST from the group" to its own GST details with a later
  "applies from" date uses its own details for earlier dates too — keep the first row at the books
  beginning.
- An item line's sales / purchase ledger is the voucher type's default (no per-line ledger column).
  Cost centres can be allocated on ledger lines only, not on the sales / purchase ledger of item lines.

### Multiple currencies
- Books, inventory and GST are in rupees; stock bought in a currency is valued at the converted rate.
- The Compact (thermal) print template does not print the foreign-currency block.
- A realised difference on settling an advance by an invoice is booked like any other bill (Tally's way);
  Ind AS 21 Appendix B would record the invoice at the advance's rate.
- TDS u/s 195 uses the voucher's rate (type the SBI TT buying rate of the deduction date when it differs).
- Foreign-currency quotations are not supported. Voucher entry shows the GST under a foreign-currency
  invoice line with a ₹ sign although it is in the currency (the preview and print are correct).

### Tally migration and Export to Tally
- Import: foreign-currency amounts come in as rupees; Tally's stat-adjustment journals arrive as plain
  journals; a debit note to a customer is imported for value only (Tally moves stock for it — listed in
  the import log); the original invoice of a note is read from Tally's *Reference* fields only.
- Export: tested by re-importing into Pevqori, **not** against a live TallyPrime — import into a copy of the
  Tally company first. Not exported: foreign-currency amounts, e-invoice / e-way bill details, shipping
  bill details, per-line GST overrides, price lists, BOMs, budgets, scenarios, attachments, quotations,
  proforma invoices, physical stock vouchers. SEZ / deemed export / UIN parties go as Regular and overseas
  parties as Unregistered. Some tag names (assessable-value charges, alternate units, part numbers) follow
  Tally files we have seen and are unverified.

### Outstanding, reports and dashboard
- Interest is simple interest on a 365-day year only (no compounding, slabs or rate changes inside a
  period); interest on a bill-wise ledger's On Account remainder is not calculated. Reminder letters are
  in English.
- Cash Flow is month-wise; it does not split operating / investing / financing activities. Group "net
  Dr / Cr" flags are not applied.
- Without *Stock value in accounts* there is no automatic closing stock (record it by journal).
- The scenario and budget chosen on a report are not remembered after the screen closes.
- Dashboard receivables / payables drill-downs show the period end while the tiles show the working
  date when the period runs past it.

### Printing, sharing, cheques and POS
- MRP is read from the item when printing, so reprinting an old invoice after an MRP change prints the
  new MRP. Several copies in one print job show "Page n" without "of m".
- Drivers that ignore a custom page length cut thermal receipts at their own page size.
- POS exchange credit is tied to the return that issued it (no gift-card store credit); held bills keep
  their prices; a return uses the item's current GST rate; bills are attributed to the user who created
  them; POS bills go to Tally as ordinary sales vouchers.
- Cheque layouts are generic CTS-2010 positions (calibrate per bank).

### Data, attachments and security
- Attachments open in their Windows program (no preview) and are not part of Excel or Tally exports. A
  CSV attachment opened in Excel is not checked for formulas.
- Automatic backups are not password-protected (make an encrypted backup by hand when a copy leaves your
  control). Recurring vouchers post only from the reviewed due list.
- Role and permission changes apply from the user's next login. The edit-log search does not look inside
  the before / after values; an edit-log export holds at most 100,000 entries per file.
- What the edit-log hash chain and its external check-point do and do not detect is set out in
  [SECURITY.md §4.1](SECURITY.md#41-edit-log-integrity-what-is-detected-and-the-limits). The installer is
  **not code-signed** yet ([SECURITY.md §7](SECURITY.md#7-known-gaps-and-planned-hardening)).

### Performance
- GSTR-3B carries the electronic credit ledger forward from the books' beginning, so its first
  calculation grows with the years of history (about 0.6–0.85 s for a 60,000-voucher company on a
  developer machine; later calls are memoised). The dashboard's first load on a very large company takes
  under a second for the same reason.

## 3. Legal assumptions to check

Pevqori follows the law as understood on 10 October 2026. These points are assumptions or depend on
notifications — confirm them with your adviser:

- **TDS / TCS rates and thresholds** are seeded for FY 2025-26 and assumed unchanged under the Income-tax
  Act 2025 from 1 April 2026; returns keep the 1961 section codes. Add dated rate rows if the Finance Act
  or the rules changed them. 206C(1F) is computed on the value including GST, per invoice. 206C(1H) and
  206AB / 206CCA (omitted from 1 April 2025) are not modelled.
- **ITC-04**: moulds, dies, jigs, fixtures and tools are listed as inputs in table 4; due dates are often
  extended by notification. **CMP-08 / GSTR-4 / GSTR-3B** due dates shown are the statutory ones.
- **POS**: goods handed over at the counter take your state as the place of supply (IGST only when you
  mark them delivered to the customer's state); services sold at the counter follow the same choice.
  The ₹2,00,000 cash limit is checked per bill, not per person per day.
- **Credit notes** after 30 November following the year of supply (CGST s.34(2)) are reminded, not
  blocked.
- **Export invoices**: shipping bill details are optional at invoicing; LUT validity is yours to keep
  current (F12 › GST).

Every figure that goes to a government portal is prepared from your books and must be checked against
the portal before filing — the portal is the legal record.
