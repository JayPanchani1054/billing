# Bahi ERP

**Offline-first GST accounting, invoicing and inventory for Indian businesses** — a fast,
keyboard-first Windows desktop app in the spirit of Tally, with a calmer, modern interface.

Your books live on your own computer, in a folder you choose. No cloud account, no subscription
server, no internet connection required.

> Status: pre-release (v0.x). Interfaces and data formats may still change between versions;
> always keep backups.

---

## Highlights

- **Tally-style workflow** — Gateway → masters → vouchers → reports, with drill-down from any report
  to the voucher, a navigation stack (`Esc` goes back) and a Go To palette (`Ctrl+G` / `Ctrl+K`).
- **Keyboard-complete** — `F4`–`F9` vouchers (Contra, Payment, Receipt, Journal, Sales, Purchase),
  `Ctrl+F8`/`Ctrl+F9` credit/debit notes, `Alt+C` create a master from any picker, `Ctrl+A` accept,
  `Alt+P` print, `Alt+E` export, `F11` features, `F12` configuration.
- **GST built in** — CGST/SGST/UTGST/IGST and cess, place-of-supply rules, reverse charge,
  composition dealers, B2B/B2CL/B2CS/exports/SEZ classification, GSTR-1 and GSTR-3B reports,
  GSTR-2B reconciliation.
- **Accounting** — groups and ledgers, bill-wise outstanding, cost centres, bank reconciliation,
  cheque printing, period locking, Trial Balance, P&L, Balance Sheet, Day Book, ledger statements.
- **Inventory** — stock items, groups, units (UQC), godowns, batches and expiry, order processing,
  delivery/receipt notes, valuation (weighted average by default) integrated into the books.
- **Printing & export** — GST invoices with QR codes, PDF, Excel/CSV export of every report.
- **Security** — optional per-company users and roles, scrypt-hashed passwords with lockout,
  tamper-evident (hash-chained) edit log, encrypted backups. See [docs/SECURITY.md](docs/SECURITY.md).
- **Multi-company** — each company is a self-contained folder; open one at a time, switch with `F3`.

## Screenshots

_Screenshots will be added before the first public release._

| Gateway | Sales invoice | Balance Sheet |
|---|---|---|
| _(coming soon)_ | _(coming soon)_ | _(coming soon)_ |

---

## Install on Windows

Requirements: Windows 10 or 11, 64-bit.

**From a release (recommended).** Open the repository's **Releases** page, download
`Bahi-ERP-Setup-<version>.exe` (and optionally `SHA256SUMS.txt` to verify the download), and run it.

**From a CI build (latest development version).** Open **Actions → CI**, pick a green run, and download
the **Bahi-ERP-Windows-Installer** artifact (a zip containing the `.exe`).

Installing:

1. Run `Bahi-ERP-Setup-<version>.exe`.
2. Windows SmartScreen may say *"Windows protected your PC"* because the installer is not yet
   code-signed. Click **More info → Run anyway** (see [docs/BUILD.md](docs/BUILD.md#7-code-signing)).
3. Choose *Only for me* (no administrator rights needed) or *Anyone who uses this computer*, pick the
   installation folder, and finish. Shortcuts are created on the desktop and in the Start menu.

Uninstalling (Settings → Apps) removes the program only. **Company data and settings are never
deleted by the uninstaller.**

## Choose where your data lives

On first launch Bahi ERP asks for a **data folder** (default: `Documents\Bahi ERP`). Pick any folder
you control — a local drive, a BitLocker-encrypted drive, or a folder that your backup software
already protects. You can change it later in **Settings → Data folder**, where you can *use* an
existing folder as-is, *copy* your data there, or *move* it (every copied company is integrity-checked
before anything is removed from the old location).

Inside the data folder:

```
<data folder>\
  companies\
    <company-id>\
      company.db        the company's books (one SQLite database, WAL mode)
      attachments\      files attached to vouchers and masters
  trash\                companies you deleted (kept, never hard-deleted by the app)
```

- **A company is just a folder.** Copy it to another PC's data folder and it appears in the company list.
  Only one copy of Bahi ERP can have a company open at a time (a lock file prevents two writers).
- **Backups.** Use **Data → Backup** to create a single backup file, optionally encrypted with a
  password (AES-256-GCM). Restore verifies integrity before replacing anything. Keep backups on a
  different disk or in your cloud drive — the app itself never uploads anything.
- **App settings** (window size, theme, last data folder) live in `%APPDATA%\Bahi ERP`; logs in
  `%APPDATA%\Bahi ERP\logs` (Help → Open Logs Folder). Logs never contain passwords or voucher data.

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
npm run typecheck      # TypeScript, all three projects
npm run build          # production bundles in out/
npm run dist:win       # Windows installer in release\Bahi-ERP-Setup-<version>.exe
npm run e2e            # Playwright smoke tests against out/ (run npm run build first)
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
    modules/   One folder per feature (accounts, vouchers, gst, inventory, reports, …)
  main/        Electron main process: hardened window, app:// protocol, IPC, dialogs, print/PDF, menu
  preload/     contextBridge exposing window.bahi (the only renderer → main channel)
  renderer/    React 19 UI: shell, design system, feature screens
scripts/       build.mjs, dev.mjs, make-icon.mjs, after-pack.cjs (Electron fuses)
build/         Installer resources (icon.ico, icon.png, installer.nsh)
e2e/           Playwright Electron smoke tests
docs/          ARCHITECTURE.md (engineering contract), SECURITY.md, BUILD.md
```

Contributors: read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — it is the contract for data
conventions (integer paise, Dr/Cr signs), API routes, posting and GST rules, and UI behaviour.

## Security summary

- The UI runs in a **sandboxed, context-isolated renderer** with no Node.js access, a strict
  Content-Security-Policy, no remote content and **no network access at all**.
- The renderer can only call `window.bahi.api(route, input)` and a short list of native actions;
  the main process checks the caller's origin and validates every input again.
- Files are read or written only through native dialogs the user operates.
- Passwords use scrypt with lockout; the edit log is append-only and hash-chained; backups can be
  encrypted. Protect the data folder itself with Windows account security and BitLocker.

Full threat model and controls: [docs/SECURITY.md](docs/SECURITY.md). Please report vulnerabilities
privately to the maintainers rather than in public issues.

## License

Proprietary — all rights reserved (`"license": "UNLICENSED"` in package.json). No permission is
granted to use, copy, modify or distribute this software without a written agreement with the authors.
Third-party components (Electron, React, and others) are used under their own open-source licenses.
