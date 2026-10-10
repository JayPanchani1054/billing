# Changelog

All notable changes to Pevqori are recorded here. Versions follow [Semantic Versioning](https://semver.org/);
a release is published by tagging `v<version>` (see [docs/BUILD.md](docs/BUILD.md#6-releasing)).

## 1.0.0 — 2026-10-10

The first complete release: offline-first GST accounting, invoicing and inventory for Indian businesses,
as a Windows desktop app. What it deliberately does not do is listed in [docs/SCOPE.md](docs/SCOPE.md);
how to install it is in [docs/INSTALL.md](docs/INSTALL.md) and how to use it in
[docs/USER_GUIDE.md](docs/USER_GUIDE.md).

> Release note for maintainers: `package.json` still says `0.1.0`. Bump `"version"` to `1.0.0` and tag
> `v1.0.0` to publish this release (the release workflow refuses a tag that does not match).

### Renamed
- The product is now called **Pevqori** (program, installer `Pevqori-Setup-<version>.exe`, settings folder
  `%APPDATA%\Pevqori`, backups `.pvqbak`). Upgrading keeps your data: the settings of the earlier build
  are copied once on the first launch, and backups made by earlier builds (with the earlier backup
  extension) are still listed, verified and restored — see [docs/INSTALL.md](docs/INSTALL.md#4-upgrading).

### Foundation
- Windows 10 / 11 (x64) installer: per-user by default, no administrator rights, data and settings kept on
  uninstall; hardened Electron (sandboxed, context-isolated renderer with no network access, strict CSP,
  Electron fuses); the accounting core runs on a worker thread so long tasks never freeze the window.
- Each company is a folder with one SQLite database (`node:sqlite`) in a data folder you choose; several
  companies, one open at a time, protected by a lock file. Money is held in integer paise; every voucher
  balances to the paisa.
- Keyboard-first navigation: Gateway, Go To (Ctrl+G / Alt+G / Ctrl+K), F2 working date, Alt+F2 period,
  voucher keys F4–F10, F11 features, F12 configuration, drill-down from every report to the voucher;
  shared key conventions across screens (F1 lists them; the User Guide lists each screen's own keys).
  Light and dark themes.

### Accounting
- Groups, ledgers (several aliases), bulk ledger creation, opening balances with bill-wise detail.
- Contra, payment, receipt, journal, sales, purchase, credit and debit notes in item or accounting
  invoice mode; optional, post-dated, memorandum and reversing vouchers; cancel keeps the number.
- Voucher numbering with `{FY}` / `{MM}` … codes, dated prefix / suffix rows and yearly / monthly
  restart, checked against the GST 16-character rule.
- Bill-wise outstanding, credit periods, ageing, overdue bills, statements of account, interest and
  reminder letters; cost centres; period lock; configurable checks (negative stock / cash, credit
  limit, duplicate supplier bill).
- Quotations and proforma invoices with their own series and one-key conversion; recurring vouchers
  posted from a reviewed due list; scenarios; budgets and budget variance.
- Multiple currencies: foreign-currency parties and banks, realised exchange gain / loss in the same
  voucher, period-end revaluation, ledgers and outstanding in both currencies, export invoices printed in
  the currency.

### Inventory and manufacturing
- Stock items, groups, categories, compound units, godowns, batches and expiry, price levels;
  orders, delivery / receipt notes, rejections, sales / purchase bills pending, order pre-closing;
  stock journal and physical stock; average, FIFO, LIFO, last purchase and standard cost, integrated into
  the books; stock summary, item, godown, batch, ageing, movement, reorder, negative stock and
  profitability reports.
- Bills of materials with by-products, scrap and revisions; Manufacturing Journal with live costing;
  job work (Material Out / In, job work orders, CGST s.143 return dates, principal's goods kept out of
  your stock); Production Register; ITC-04 tables as CSV / Excel.
- POS counter billing: barcode / code scan, split tender (cash, card, UPI, credit) in one sales voucher,
  change, hold / recall, thermal receipts with MRP, returns and exchanges as credit notes, day-end
  summary with a counted-cash check.

### GST
- GST engine: CGST / SGST / UTGST / IGST and cess, place of supply, reverse charge, exports and SEZ (LUT
  or IGST), composition bills of supply, rate history by date.
- GSTR-1 and GSTR-3B with the portal JSON, GSTR-9 summary, HSN summary, registers, ITC report, GST
  exceptions; GSTR-2A / 2B and GSTR-1 reconciliation with kept decisions.
- e-Invoice and e-way bill by JSON round trip (export, upload on the portal, import the IRP response /
  record the EWB number); IRN and signed QR printed on the invoice.
- GST details on vouchers (Alt+J): advances (Table 11) and their adjustment / refund, bills of entry for
  imports, GST challans, ITC reversals and reclaims (Rules 37 / 37A / 38 / 42 / 43, s.17(5)),
  reverse-charge liability; GST set-off in the Rule 88A order posted as one journal; electronic cash and
  credit ledgers; filing status with GSTR-1 amendments (9A / 9C / 10) and protection of periods whose
  GSTR-1 or GSTR-3B is filed; Rule 37 180-day report.
- Composition dealers: rate master, CMP-08 and GSTR-4 from the books (Pevqori's CSV / JSON).

### TDS / TCS
- Natures of payment / goods with dated rates and thresholds (seeded for 194C/H/I/J/A/Q/R/T, 195,
  206C(1), 206C(1F)); deductee details with PAN checks and lower-deduction certificates.
- Automatic deduction on purchases, journals and payments and collection on sales, with overrides
  (reason recorded), advances, proportional reversal by debit / credit notes; challans with interest;
  outstanding with due dates and s.234E late fee; exceptions; 26Q / 27Q / 27EQ data as CSV; filed
  quarters protected; TDS receivable against a Form 26AS CSV.

### Banking, printing and sharing
- Bank reconciliation, bank statement import (SBI, HDFC, ICICI, Axis, Kotak, Yes Bank, PNB, Bank of
  Baroda, Canara and generic layouts), auto-matching and vouchers from statement lines; cheque and
  post-dated cheque registers; deposit slip.
- Payee bank details, cheque books with automatic leaf numbers, cheque printing on CTS-2010 leaves with
  calibration, cheque leaf register tied to the BRS, bulk NEFT / RTGS / IMPS payment file (generic CSV).
- Invoice templates on A4, A5, Letter, Legal and 80 / 58 mm thermal rolls; MRP column and "You saved";
  UPI QR; batch printing; PDF; sharing by e-mail (draft with the PDF attached) or WhatsApp.

### Data and security
- Backups in one file, optionally encrypted (AES-256-GCM), automatic backups (when the last one is over a
  day old, on opening and closing the company), verified restore as
  a new company or over a closed one; Check Books integrity report.
- Excel / CSV import with templates and a row-by-row preview; export of masters and vouchers; XML data
  import from another accounting program; XML data export for another accounting program (masters with
  openings at the period start, and vouchers).
- Attachments (PDF, images, Office files without macros, CSV / TXT / JSON / XML) on vouchers, ledgers and
  items, carried in backups and checked by Check Books.
- Optional password protection with users and roles (Owner, Accountant, Data Entry, Auditor and your
  own), scrypt-hashed passwords, lockout, idle lock; an append-only, hash-chained edit log of every
  change, import, export, print and share, with a check-point kept outside the company file.

### Quality
- Unit and cross-module tests on real in-memory companies (a full trading year and a year with every
  feature on must tie out across the trial balance, P&L, Balance Sheet, stock, GST, TDS, outstanding,
  forex, BRS, POS and dashboard, and survive a backup / restore and an XML export / re-import);
  performance checked on a 60,000-voucher company; Playwright end-to-end tests on Windows and Ubuntu;
  an install-and-launch smoke test of the packaged installer on Windows.

