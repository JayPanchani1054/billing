# Bahi ERP

**Offline-first GST accounting, invoicing and inventory for Indian businesses** — a fast,
keyboard-first Windows desktop app in the spirit of Tally, with a calmer, modern interface.

Your books live on your own computer, in a folder you choose. No cloud account, no subscription
server, no internet connection required.

> **Status: 1.0.0 release candidate** — see [CHANGELOG.md](CHANGELOG.md). Builds report the version in
> `package.json` until it is bumped and tagged for the release. Always keep backups.

## Documentation

| Document | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Downloading and installing, SmartScreen, the data folder, upgrading, uninstalling |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Using Bahi: company setup, masters, vouchers, GST, TDS, banking, reports, data, security, the keyboard reference |
| [docs/SCOPE.md](docs/SCOPE.md) | What is deliberately out of scope or partial, and the legal assumptions to check |
| [CHANGELOG.md](CHANGELOG.md) | What each release contains |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and security controls |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Engineering contract for contributors (data conventions, routes, posting and GST rules, UI rules) |
| [docs/BUILD.md](docs/BUILD.md) | Building, testing, packaging and releasing |

## Compared with Tally

**Built** = available and covered by tests. **Partial** = available with the limits noted (details in
[docs/SCOPE.md](docs/SCOPE.md)). **Out of scope** = not in 1.0, deliberately.

| Area | Capability | Bahi ERP 1.0 | Notes |
|---|---|---|---|
| Accounting | Groups, ledgers (several aliases), multiple ledger creation, opening balances, chart of accounts | Built | |
| | Contra, payment, receipt, journal, sales, purchase, credit / debit note; item and accounting invoices | Built | Tally keys F4–F9, Ctrl+F8 / F9 |
| | Optional, post-dated, memorandum vouchers; reversing journals; scenarios | Built | |
| | Voucher numbering: prefix / suffix with date codes, dated rows, yearly / monthly restart | Built | GST 16-character rule checked |
| | Bill-wise details, credit periods, ageing, overdue, statements, reminder letters | Built | |
| | Interest calculation | Partial | Simple interest, 365-day year |
| | Cost centres and categories | Built | Not on the sales / purchase ledger of item lines |
| | Budgets and budget variance | Built | |
| | Multiple currencies, realised gain / loss, revaluation | Built | Rates typed, not downloaded |
| | Bank reconciliation | Built | Plus bank statement import (9 bank layouts + generic) and auto-matching |
| | Cheque printing, cheque books, leaf register | Built | Generic CTS-2010 layout, calibrated per bank |
| | Bulk bank payment file (NEFT / RTGS / IMPS) | Partial | Generic documented CSV; no bank-specific or host-to-host format |
| | Period lock, edit log (Tally's "edit log") with hash-chain verification | Built | |
| | Fixed-asset register, automatic depreciation | Out of scope | Pass the depreciation journal yourself |
| Inventory | Stock items, groups, categories, units (compound), godowns, batches and expiry, price levels | Built | |
| | Orders, delivery / receipt notes, rejections, pending bills, pre-closing orders | Built | |
| | Stock journal, physical stock | Built | A back-dated entry before a count needs the count re-saved |
| | Costing: average, FIFO, LIFO, last purchase, standard | Built | No lower of cost or market |
| | Bill of materials, Manufacturing Journal, by-products and scrap | Built | Single-level BOM |
| | Job work out / in, s.143 time limits, ITC-04 | Partial | ITC-04 as CSV / Excel, not the portal JSON |
| | POS counter billing: scan, split tender, hold / recall, returns, day-end | Built | |
| GST | Invoicing, place of supply, reverse charge, exports / SEZ (LUT or IGST), composition bills of supply | Built | |
| | GSTR-1 and GSTR-3B with portal JSON; HSN summary; registers; exceptions | Built | Verify against the portal before filing |
| | GSTR-9 | Partial | Summary from the books |
| | GSTR-2A / 2B and GSTR-1 reconciliation | Built | IMS actions out of scope |
| | e-Invoice and e-way bill | Partial | JSON out / response in; no direct IRP / EWB API |
| | Advances (Table 11), amendments (9A / 9C), set-off (Rule 88A), challans, electronic ledgers, ITC reversals, Rule 37, bills of entry, protection of filed periods | Built | |
| | CMP-08 and GSTR-4 | Partial | Bahi's CSV / JSON, not the portal tool files; GSTR-4 table 7 not kept |
| | E-commerce operator supplies (3.1.1, tables 14 / 15), ISD | Out of scope | |
| | GSTR-9C, GSTR-6 / 7 / 8, ITC-03, GSTR-10 | Out of scope | Prepare on the portal or with your CA |
| TDS / TCS | Natures with dated rates, automatic deduction / collection, challans, interest, late fee, exceptions, 26AS check | Built | Rates assumed unchanged for 2026-27 — check |
| | 26Q / 27Q / 27EQ statements | Partial | CSV with every RPU field; not the FVU file |
| | Form 16A / 27D; salary TDS (192, 24Q) and payroll | Out of scope | |
| Reports | Balance Sheet, P&L (Schedule III view), Trial Balance, ledgers, group summaries, registers, Day Book, cash / funds flow, ratios, exceptions, dashboard; drill-down to the voucher; Excel / CSV / PDF export | Built | Cash flow is month-wise, not by activity |
| Printing | GST invoice templates, A4 / A5 / Letter / Legal, 80 / 58 mm thermal receipts, MRP, UPI QR, IRN QR, batch printing | Built | |
| | Share by e-mail / WhatsApp | Built | Via your mail program / WhatsApp; Bahi sends nothing itself |
| Data | Backup and restore (optionally encrypted), automatic backups, integrity check | Built | |
| | Excel / CSV import and export of masters and vouchers | Built | |
| | Migration from Tally XML | Built | Job work vouchers and budgets not imported |
| | Export to Tally XML | Partial | Verified by re-import into Bahi, not yet against TallyPrime |
| | Attachments on vouchers and masters | Built | No in-app preview |
| Company | Several companies, users, roles and passwords | Built | One company open at a time |
| | Several users at once, remote access, consolidation | Out of scope | Single-user desktop design |

## Highlights

- **Tally-style workflow** — Gateway → masters → vouchers → reports, with drill-down from any report
  to the voucher, a navigation stack (`Esc` goes back) and a Go To palette (`Ctrl+G` / `Ctrl+K`).
- **Keyboard-complete** — `F4`–`F9` vouchers (Contra, Payment, Receipt, Journal, Sales, Purchase),
  `Ctrl+F8`/`Ctrl+F9` credit/debit notes, `Alt+C` create a master from any picker, `Ctrl+A` accept,
  `Alt+P` print, `Alt+E` export, `F11` features, `F12` configuration.
- **GST built in** — CGST/SGST/UTGST/IGST and cess, place-of-supply rules, reverse charge,
  composition dealers, B2B/B2CL/B2CS/exports/SEZ classification, GSTR-1 and GSTR-3B reports,
  GSTR-2B reconciliation.
- **GST compliance beyond the returns** — GST set-off in the order the law requires (Rule 88A) posted
  as a journal, GST challans (CPIN / CIN / BRN) and electronic cash / credit ledgers kept from the
  books; ITC reversal (Rules 37 / 37A / 42 / 43, s.17(5)), reclaim and reverse-charge stat journals
  flowing into GSTR-3B; tax on advances for services (GSTR-1 Table 11, refunds); bills of entry for
  imported goods with a GSTR-2B (IMPG) check; return filing status with GSTR-1 amendments (9A / 9C)
  instead of silently changing a filed period; CMP-08 and GSTR-4 for composition dealers (our own
  CSV / JSON — the portal has no CMP-08 upload). e-Invoice and e-way bills work by JSON upload /
  download on the portal (no direct IRP API). See [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
- **TDS / TCS** (F11) — natures of payment / goods with dated rates and thresholds (seeded for
  194C/H/I/J/A/Q/R/T, 195, 206C(1) and 206C(1F); editable), deductee details with PAN checks and
  lower-deduction certificates, automatic deduction on purchases / journals / payments and TCS on
  sales (override with a reason), challans, outstanding with due dates, interest and s.234E late fee,
  26Q / 27Q / 27EQ data as CSV (not the FVU file), exceptions, and TDS receivable vs a Form 26AS CSV.
- **Multiple currencies** (F11) — parties and bank accounts kept in a foreign currency are entered in
  that currency with a rate of exchange (default from your rates master: standard / selling / buying);
  the books stay in rupees. Bill-wise outstanding in both currencies, realised exchange gain / loss
  posted automatically when a bill is settled at another rate, period-end revaluation at the closing
  rate with a one-key "Forex adjustment" journal, ledger statements in both currencies, and export
  invoices (LUT or with IGST) printed in the foreign currency with rupee equivalents (GST and GSTR-1 in
  rupees). Exchange rates are typed by you — nothing is downloaded.
- **Accounting** — groups and ledgers, bill-wise outstanding, cost centres, bank reconciliation,
  cheque printing, period locking, Trial Balance, P&L, Balance Sheet, Day Book, ledger statements.
- **Inventory** — stock items, groups, units (UQC), godowns, batches and expiry, order processing,
  delivery/receipt notes, valuation (weighted average by default) integrated into the books.
- **Manufacturing & job work** (F11) — bills of materials (several per item, by-products and scrap,
  revision history, cost estimate), a Manufacturing Journal that fills components from the BOM and
  works out the cost of the finished goods (consumption at your valuation method + labour / overheads −
  by-products), godowns marked "our stock with a job worker" or "a principal's stock with us" (kept out
  of your closing stock), Material Out / In challans, job work orders, pending job work with the
  one-year / three-year return dates of CGST s.143, and ITC-04 tables as CSV / Excel (not the portal JSON).
- **POS / counter billing** (F11 › POS invoicing) — a counter screen built for speed: barcode / item
  code / alias scan-to-add (`3*code` for three; the same item again adds to its line), price-level
  rates by quantity, line discount, MRP and the "You save" amount, a large live total; walk-in by default
  or a customer found / created by mobile number; split payment across cash, card, UPI and other modes
  with cash handed over and change, posted as **one** sales voucher (an unpaid part stays on the
  customer's account); hold / recall bills; receipt printing to the roll printer (silently once one is
  chosen on the computer); returns and exchanges (never more back, in quantity or value, than was sold)
  as credit notes (refund, exchange credit for the next bill, or credit to the account); a day-end summary
  by tender, cashier and counter with a cash tally.
- **Sales documents & planning** — quotations and proforma invoices (own numbering, validity, status,
  one-key conversion to a sales order or invoice), recurring vouchers (rent, retainers, EMIs) reviewed
  and posted from a due list, Sales / Purchase Bills Pending for unbilled challans, order pre-close,
  reversing journals with scenarios on the Trial Balance / P&L / Balance Sheet, and budgets with a
  budget-vs-actual report. See [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
- **Printing & export** — GST invoices with QR codes, PDF, Excel/CSV export of every report. Paper:
  A4, A5 (portrait / landscape), Letter, Legal, and 80 mm / 58 mm thermal receipt rolls (a compact
  receipt as long as its contents); an MRP column with "You saved" for items with an MRP, and a
  warning when a price is above MRP.
- **Share by e-mail or WhatsApp** (`Alt+W`) — invoices, vouchers and statements as PDF: an editable
  e-mail draft with the PDF attached opens in your mail program (Outlook / Windows Mail), or a
  WhatsApp chat opens with the party's number and your message while the PDF is shown in its folder to
  attach (WhatsApp cannot attach a file from a link). Texts are editable templates; every share is in
  the edit log.
- **Cheques & bank payments** (F11 › Cheque printing) — payee bank details (beneficiary, A/c, IFSC,
  name on cheque), cheque books per bank with the next leaf filled in on Payment / Contra, a cheque
  leaf register (issued, cleared from the BRS, stale after 3 months, cancelled, unused), cheque
  printing one by one or in bulk on CTS-2010 leaves (date boxes, amount in words in lakh / crore,
  `**…/-` guards, A/c Payee crossing) with per-bank layouts in millimetres, presets and a calibration
  print, and a bulk NEFT / RTGS / IMPS payment file (a documented generic CSV — banks' upload formats
  differ, map the columns once).
- **Tally both ways** — migrate from Tally XML, and **Export to Tally**: masters (groups, ledgers with
  GST / party / bank / bill-wise openings, units, godowns, stock groups and items, cost centres, voucher
  types, aliases) and the vouchers of a period (bill-wise, cost centres, bank details, stock lines, GST
  facts — exactly as recorded) as a TallyPrime "Import Data" XML for your CA; for a later period the
  masters carry the balances, pending bills and stock on its first day. Tested by importing the export
  back into an empty company with the same trial balance, stock summary and GST totals; not yet tried
  against TallyPrime itself, so test on a copy of the Tally company first.
- **Attachments** — attach scanned bills, challans, agreements and payment proofs (PDF, images,
  Office files, CSV / TXT / JSON / XML; up to 25 MB, no programs or macros) to vouchers, ledgers and
  stock items (`Alt+F`); open, save a copy or remove them; an Attachment Register; files are kept in the
  company folder, travel in backups (encrypted with the backup) and are checked by Check Books.
- **Voucher numbering like Tally** — prefix / suffix tokens `{FY}` (26-27), `{FYYYYY}` (2026-27), `{YY}`,
  `{MM}`, `{MMM}`, prefix / suffix rows with an "applicable from" date, restart yearly / monthly / never,
  width and zero-fill; GST invoice numbers are checked for 16 characters and the allowed characters.
- **Several aliases per ledger and item** — local-language names, supplier codes, old codes: every alias
  is searched in pickers and Go To, and kept by Excel and Tally import / export.
- **Security** — optional per-company users and roles, scrypt-hashed passwords with lockout,
  tamper-evident (hash-chained) edit log, encrypted backups. See [docs/SECURITY.md](docs/SECURITY.md).
- **Multi-company** — each company is a self-contained folder; open one at a time, switch with `F3`.

## Screenshots

No screenshots are included in the repository yet.

## Install on Windows

Windows 10 or 11, 64-bit. Download `Bahi-ERP-Setup-<version>.exe` from the repository's **Releases**
page (or the **Bahi-ERP-Windows-Installer** artifact of a green **Actions › CI** run), run it and choose
*Only for me* (no administrator rights needed). The installer is not yet code-signed, so Windows
SmartScreen may ask you to confirm (*More info › Run anyway*). Uninstalling removes the program only —
**company data and settings are never deleted by the uninstaller.** Step by step, with checksums,
upgrading and moving to a new computer: [docs/INSTALL.md](docs/INSTALL.md).

## Where your data lives

On first launch Bahi ERP asks for a **data folder** (default: `Documents\Bahi ERP`). Pick any folder
you control — a local drive, a BitLocker-encrypted drive, or a folder that your backup software
already protects. You can change it later from the company list (**Select a Company › Change…** next
to the folder name), where you can *use* an existing folder as-is, *copy* your data there, or *move* it
(every copied company is integrity-checked before anything is removed from the old location).

```
<data folder>\
  companies\
    <company-id>\
      company.db        the company's books (one SQLite database, WAL mode)
      attachments\      files attached to vouchers and masters
  backups\<company-id>\ default backup folder (and safety copies made before an upgrade)
  trash\                companies you deleted or replaced (kept, never hard-deleted by the app)
```

- **A company is just a folder.** Copy it to another PC's data folder and it appears in the company list.
  Only one copy of Bahi ERP can have a company open at a time (a lock file prevents two writers).
- **Backups.** Use **Data › Backup** to create a single backup file, optionally encrypted with a
  password (AES-256-GCM); automatic backups run daily on opening / closing the company. Restore
  verifies integrity before replacing anything. Keep backups on a different disk or in your cloud
  drive — the app itself never uploads anything.
- **App settings** (data folder, theme, confirmed backup folders) live in `%APPDATA%\Bahi ERP`; logs in
  `%APPDATA%\Bahi ERP\logs` (Utilities › About Bahi ERP shows the folder). Logs never contain passwords
  or voucher data.

---

## Build from source (Windows)

Prerequisites: **Node.js 22.18 or newer** (LTS recommended) and Git. No Visual Studio or Python is
needed — there are no native modules.

```powershell
git clone <this repository>
cd billing
npm install            # installs Electron, Vite, TypeScript, electron-builder, Playwright
npm run dev            # Vite + Electron with hot reload (uses a separate "Bahi ERP Dev" profile)
npm test               # unit tests (node:test)
npm run typecheck      # TypeScript: core, main/preload, renderer, e2e specs
npm run build          # production bundles in out/
npm run dist:win       # Windows installer in release\Bahi-ERP-Setup-<version>.exe
npm run e2e            # Playwright end-to-end suite against out/ (run npm run build first)
```

Details — build pipeline, release process, code signing — are in [docs/BUILD.md](docs/BUILD.md).

## Project structure

```
src/
  shared/      Pure TypeScript shared by main and renderer: money, dates, GST engine, DTO types, IPC contract
  core/        Business logic on node:sqlite — zero runtime dependencies, fully unit-tested
    app/       Runtime: data folder, company registry, sessions, logging
    api/       Route contract and dispatcher
    db/        SQLite wrapper and migrations
    modules/   One folder per feature (accounts, vouchers, gst, tds, inventory, mfg, pos, forex, reports, …)
  main/        Electron main process: hardened window, app:// protocol, IPC, dialogs, print/PDF, sharing,
               menu; the core runs on a worker thread behind it (core-worker.ts ↔ core-proxy.ts)
  preload/     contextBridge exposing window.bahi (the only renderer → main channel)
  renderer/    React 19 UI: shell, design system, feature screens
scripts/       build.mjs, dev.mjs, make-icon.mjs, after-pack.cjs + fuses.cjs + check-fuses.cjs (Electron
               fuses), smoke-installed.ps1 (packaged-app smoke test)
build/         Installer resources (icon.ico, icon.png, installer.nsh)
e2e/           Playwright Electron specs (smoke, first day, every-screen sweep, parity flows)
docs/          USER_GUIDE.md, INSTALL.md, SCOPE.md (users); ARCHITECTURE.md, SECURITY.md, BUILD.md (contributors)
```

Contributors: read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — it is the contract for data
conventions (integer paise, Dr/Cr signs), API routes, posting and GST rules, and UI behaviour. Each module
has a README next to its code with its rules, tests and known gaps.

## Security summary

- The UI runs in a **sandboxed, context-isolated renderer** with no Node.js access, a strict
  Content-Security-Policy, no remote content and **no network access at all**.
- The renderer can only call `window.bahi.api(route, input)` and a short list of native actions;
  the main process checks the caller's origin and validates every input again.
- The renderer cannot point the app at an arbitrary file: a path it passes must lie inside the data
  folder or the confirmed backup folder, or be one the user picked in a native dialog.
- Passwords use scrypt with lockout; the edit log is append-only and hash-chained; backups can be
  encrypted. Protect the data folder itself with Windows account security and BitLocker.

Full threat model and controls: [docs/SECURITY.md](docs/SECURITY.md). Please report vulnerabilities
privately to the maintainers rather than in public issues.

## License

Proprietary — all rights reserved (`"license": "UNLICENSED"` in package.json). No permission is
granted to use, copy, modify or distribute this software without a written agreement with the authors.
Third-party components (Electron, React, and others) are used under their own open-source licenses.
