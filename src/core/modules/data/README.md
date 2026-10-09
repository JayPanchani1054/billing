# data — backup & restore, export, Excel/CSV import, Tally migration, data check

DTOs and the route table: `src/shared/types/data.ts`. Routes: `routes.ts` (registered in `src/core/api/routes.ts`).
Renderer screens: `src/renderer/modules/data/`.

| File | What |
|---|---|
| `container.ts` | `.bahibak` container: streaming writer/reader, checksums, AES-GCM envelope |
| `backup.ts` | create / list / verify / auto / restore |
| `exportTable.ts` | `data.export.table` — the shell's generic table export (reports, lists) |
| `exportData.ts` | `data.export.masters`, `data.export.vouchers` |
| `importSpecs.ts` | column specs of every import kind (templates, header mapping, help) |
| `importer.ts` | read xlsx/csv → header mapping → typed rows → records; preview / commit |
| `importApply.ts` | one applier per kind, through the accounts / inventory / vouchers services |
| `tallyParse.ts` | Tally XML → typed model (`TallyFile`) |
| `tallyImport.ts` | `data.tally.preview` / `data.tally.import` / `data.tally.progress` |
| `verify.ts` | `data.verify` integrity report |
| `common.ts` | permission helper, file-name helpers, `assertNoCompanyOpen` |
| `tallyFixture.ts` | (tests only) hand-written UTF-16LE Tally export with hand-verified figures |

Migration `120_data.ts` adds `backup_history` (one row per backup written from the company; drives
"last backup" and the 24-hour rule). The snapshot is taken before the row is written, so a backup never
contains its own history row.

## Routes

| Route | Input → Output | Access | Notes |
|---|---|---|---|
| `data.backup.create` | `BackupCreateInput` → `BackupCreateResult` | `data.backup` | async, `transactional:false` |
| `data.backup.list` | `BackupListInput` → `BackupListResult` | `data.backup` | newest first; flags unreadable files |
| `data.backup.verify` | `BackupVerifyInput` → `BackupVerifyResult` | `data.backup` | async |
| `data.backup.auto` | `BackupAutoInput` → `BackupAutoResult` | authenticated | async; never throws (reason `failed`); `trigger` open/close |
| `data.backup.restore` | `BackupRestoreInput` → `BackupRestoreResult` | `data.restore` | async; cannot replace the open company |
| `data.backup.restoreFromFile` | `BackupRestoreInput` → `BackupRestoreResult` | app scope, public | only while NO company is open |
| `data.backup.inspectFile` | `{path}` → `BackupFileInfo` | app scope, public | only while NO company is open |
| `data.backup.verifyFile` | `BackupVerifyInput` → `BackupVerifyResult` | app scope, public | only while NO company is open |
| `data.export.table` | `ExportTableInput` → `ExportFileResult` | authenticated + `data.export` (service) | audited `export` |
| `data.export.audit` | `ExportAuditInput` → `{ok:true}` | authenticated + `data.export` (service) | print / PDF of a report: audited `export` |
| `data.export.masters` | `ExportMastersInput` → `ExportFileResult` | `data.export` | |
| `data.export.vouchers` | `ExportVouchersInput` → `ExportFileResult` | `data.export` | async, streamed; audited `export` |
| `data.import.kinds` | none → `ImportKindInfo[]` | `data.import` | column help for the wizard |
| `data.import.template` | `{kind}` → `ExportFileResult` | `data.import` | |
| `data.import.preview` | `ImportPreviewInput` → `ImportPreviewResult` | `data.import` | no writes |
| `data.import.commit` | `ImportCommitInput` → `ImportCommitResult` | `data.import` | own transaction; audited `import` |
| `data.tally.preview` | `TallyPreviewInput` → `TallyPreviewResult` | `data.import` | no writes |
| `data.tally.import` | `TallyImportInput` → `TallyImportResult` | `data.import` | async, chunked; audited `import` |
| `data.tally.progress` | none → `TallyProgress` | `data.import` | poll while importing |
| `data.verify` | none → `DataVerifyResult` | `data.backup` | read-only |

Every route is `transactional: false`: async handlers must be, the read-only ones are heavy, and the
writing ones (`import.commit`, `tally.import`) open their own transactions.

## Backup (`.bahibak`)

```
offset 0    'BAHIBAK1'           magic (8 bytes)
offset 8    uint32 LE M          manifest area length
offset 12   M bytes              UTF-8 JSON BackupManifest, space padded (reserved 16 KiB)
offset 12+M payload              gzip(SQLite db)  — or, with a password, the BAHIENC1 envelope
                                 (scrypt → AES-256-GCM: 'BAHIENC1' | salt 16 | iv 12 | tag 16 | ciphertext)
```

Manifest: `format 'bahi-backup'`, `formatVersion 1`, `appVersion`, `schemaVersion` (PRAGMA user_version),
`companyId`, `companyGuid`, `companyName`, `gstin`, `booksFrom`, `createdAt`, `createdBy`, `note`,
`kind manual|auto`, `encrypted`, `compression 'gzip'`, `payloadSha256` (stored payload), `payloadBytes`,
`dbSha256`, `dbBytes` (uncompressed database).

- **Create**: snapshot through SQLite's online backup API on a separate read-only connection (one read
  transaction → consistent; in-memory test databases use `VACUUM INTO`), streamed through gzip (and
  AES-GCM) in 64 KiB chunks into `<folder>/.<name>.tmp`, manifest filled in place, fsync, atomic rename.
  File name `<Company Name>_<YYYYMMDD-HHmmss>.bahibak` (local time; name made file-system safe).
  Folder: input `folder` (must be absolute) → F12 `backup.folder` → `<dataDir>/backups/<companyId>`.
  Password: at least 8 characters. The new file is then read back (header + payload checksum); only if it
  is intact does "keep last N" (F12 `backup.keepLast`) delete this company's oldest backups (same company
  id and guid) in that folder — a backup that did not land intact fails with BUSINESS_RULE and every older
  backup is kept. Then a `backup_history` row and a `backup` audit entry.
- **Verify** (`checks` in this order): `container` (magic, manifest, format version) → `checksum`
  (payloadSha256) → `password` (encrypted only; `ok:null` + `needsPassword` when none given) →
  `decompress` → `database_checksum` (dbSha256) → `integrity` (PRAGMA integrity_check on a temporary copy)
  → `schema` (not newer than this app: `supported`) → `company` (name, counts). AES-GCM catches
  deliberate tampering of encrypted backups even when the checksum is forged; an unencrypted backup can be
  rewritten consistently by anyone with write access (say so to users who need tamper evidence).
- **Auto** (`data.backup.auto {trigger?: 'open'|'close'}`): runs when F12 `backup.auto` is on and the last
  backup is older than 24 hours. Callers: the shell a few seconds after the company opens / a user logs
  in (`open` — a company created less than 24 hours ago that was never backed up is skipped with reason
  `new`), the shell before F3 / Ctrl+Q close the company (`close`, waited for at most 15 s; the core
  finishes it before the database closes), and the core runtime itself on shutdown
  (`DEFAULT_SHUTDOWN_ROUTES`, bounded at 20 s) — so closing the window or quitting from Windows backs up
  too. Access `authenticated`: it is a company-wide policy, not tied to the user's `data.backup`
  permission. Failures come back as `{reason:'failed', error}` (never thrown); the shell shows them with
  an "Open Backup" action. Single-flight per open company: a call made while an automatic backup is
  still being written (e.g. F3 right after the `open` catch-up, or the shutdown step after the shell
  stopped waiting) shares that run and its result — never two copies side by side.
- **Restore**: verify → extract to a temporary database → append a `restore` audit entry to the restored
  database's own edit log → `controllerFor(app).installCompanyDatabase(...)` as a new company (`mode:'new'`)
  or over a CLOSED company (`mode:'replace'`, `replaceId`; its folder is moved to the trash first;
  owner credentials required when that company has security on, 5 wrong tries → 5 minute lock). Replacing
  the open company is refused ("Close the company first"); a backup of another company (different guid)
  cannot replace a company — checked against the manifest first and again against the company inside the
  extracted data (the manifest is plain JSON, so a forged manifest cannot smuggle another company's data
  over this one). `restoreFromFile` / `verifyFile` / `inspectFile` are for the Company Select
  screen and refuse to run while a company is open. The F12 backup folder inside the backup is not
  trusted: it is kept only when it lies in the data folder, was picked in a dialog this session, contains
  the backup file being restored (local folders only) or is the replaced company's own folder; otherwise
  it is cleared (automatic backups go to the default folder until a folder is picked again in F12) and the
  `restore` entry records it as `backupFolderNotKept` (docs/SECURITY.md §3.5).

## Export

- `data.export.table` — shell contract (`src/renderer/app/export.ts`). `amount` cells are PAISE → rupees
  (Excel: real numbers with the Indian `##,##,##0.00` format); `drcr` = signed paise → magnitude + a `Dr/Cr`
  column in Excel, one signed column in CSV; `percent` 18 = 18 %; `date` ISO → Excel dates. CSV: UTF-8
  with BOM, CRLF, and any text starting with `= + - @ TAB CR` is prefixed with `'` (formula injection).
  Audited as `export`. The shell sends Excel AND CSV through this route (no renderer-built CSV), so a
  user without `data.export` (e.g. the built-in Data Entry role) cannot export either.
- `data.export.audit {title, subtitle?, period?, rows, format:'pdf'|'print'}` — the shell builds the
  printable HTML itself; before printing or saving a report as PDF it calls this route, which checks
  `data.export` and writes the same `export` edit-log entry. Excel, CSV, PDF and Print are one permission
  and one trail.
- `data.export.masters {kinds, format}` — one sheet per kind with exactly the import template columns, so
  an exported workbook imports back (tested round trip). CSV with several kinds → `.zip`.
- `data.export.vouchers {from, to, baseTypes?, includeOptional?=true, includeCancelled?=false, format}` —
  sheets Vouchers / Ledger Entries (layout of the `vouchers_ledger` import) / Inventory Entries.
  **Streamed** (asynchronous, `transactional: false`): rows are read one at a time (`Db.iterate`), month
  by month, from ONE read snapshot (a separate read-only connection with an open read transaction, so
  changes committed meanwhile are not mixed in) and written straight into a temporary ZIP in the company
  folder (`.export-*.tmp`: `XlsxStreamWriter` with inline strings, or one CSV per sheet, deflated in
  256 KiB blocks by `ZipFileWriter`), which is read back once and deleted (also on failure; start-up
  sweeps leftovers). Memory ≈ the finished file: a five-year export (≈ 520 k rows) peaks at ≈ 0.2 GB RSS
  instead of ≈ 2 GB and no longer runs out of memory under a 1 GB heap; the longest event-loop block is
  ≈ 0.2 s (it yields every 5,000 rows and between months). An `.xlsx` whose largest sheet would exceed
  Excel's 1,048,575 data rows is refused with VALIDATION ("Export as CSV, or choose a shorter period").

## Import (Excel / CSV)

Kinds: `groups, ledgers, stock_groups, units, godowns, cost_centres, stock_items, opening_balances,
stock_openings, sales_invoices, purchase_invoices, vouchers_ledger` (columns, aliases and help:
`importSpecs.ts`, served by `data.import.kinds`). Templates are xlsx: data sheet with the header and two
example rows, plus an Instructions sheet (column, required, type, help, allowed values).

- File reading: `.xlsx` (sheet = `options.sheet` → the kind's sheet name → first non-Instructions sheet)
  or CSV/TXT (encoding sniffed, delimiter sniffed). The header row is the row (among the first 15) that best
  maps the columns, required ones first; headers match case-, space- and punctuation-insensitively, including aliases.
  Amounts are rupees in files (→ paise), dates `DD-MM-YYYY`, ISO or Excel date cells.
- Rows sharing the kind's group column (invoice no, voucher key, ledger, item) form one record.
- **Preview**: every record is applied through the real services inside a transaction that is always
  rolled back (each record in its own SAVEPOINT, so later rows see earlier ones). Result: one row per
  record with `status ok|warning|error|duplicate`, `action create|update|skip|none` and messages.
- **Commit**: one transaction. Default all-or-nothing: any error → `VALIDATION` naming every bad row,
  nothing written. `skipInvalid` → good records kept, bad ones rolled back individually and reported.
  `updateExisting` alters existing masters (default: duplicates skipped). `acknowledgeWarnings` saves
  vouchers with non-blocking warnings. One `import_batches` row and one `import` audit entry.
- **Job** (preview and commit, `api/jobs.ts`): asynchronous, in chunks of `IMPORT_CHUNK` with progress
  (`data.import.progress`), inside ONE transaction held open across the chunks. While it runs, every
  other company request is refused with `CONFLICT` (it would join — and be rolled back with — that
  transaction), and a job only starts when no other asynchronous request (an export, a backup, a Tally
  import) is still in flight on the company. App-level writes that bypass the dispatcher follow the same
  rule: login / password change are refused with `CONFLICT` until the job ends, and a logout or idle lock
  ends the session at once but writes its `logout` edit-log entry after the job.
- Permissions: besides `data.import`, masters kinds need `masters.create` (+ `masters.alter` with
  `updateExisting`), opening balances / opening stock need `masters.alter`, voucher kinds need
  `vouchers.create` (the masters services leave permission checks to their routes, so the importer asks).
- The template's example rows left in a file are refused as errors ("This is example row 1 from the
  template…") when every mapped column holds the example value and at least three are filled.
- Masters go through the accounts / inventory services; invoices through `saveVoucher` (GST, round-off and
  stock computed exactly as in manual entry). Typed numbers are kept only when the voucher type allows
  typed numbers (warning otherwise).

## Tally migration

`data.tally.preview {fileName, bytes}` → counts per object type, unsupported objects (BUDGET, …), vouchers
per type (with the mapped base type), date range, samples, how many masters already exist, and issues.
Nothing is written.

`data.tally.import {fileName, bytes, options:{masters?=true, vouchers, from?, to?, onDuplicate skip|update}}`:

- Decoding: `decodeText` (Tally writes UTF-16LE without a BOM; UTF-8 also works), then
  `ENVELOPE > BODY > IMPORTDATA|DATA > REQUESTDATA > TALLYMESSAGE*` (also bare `TALLYMESSAGE` lists).
  `&#4;` markers (Tally's reserved prefix) are stripped.
- Masters in dependency order: groups → units → godowns → stock groups → stock categories → cost
  categories → cost centres → ledgers → stock items → voucher types. Predefined groups map by name or
  `RESERVEDNAME`; Tally `Cash` and `Profit & Loss A/c` map to the reserved `CASH` / `PROFIT_LOSS` ledgers
  (opening balances taken over). A master failing validation is retried without the offending optional
  field (e.g. an invalid GSTIN → warning); otherwise error + skipped. Features used by the data (cost
  centres, multiple godowns, …) are switched on and reported.
- Mapping highlights: `OPENINGBALANCE` negative = Dr (sign flipped to Dr +); `ISBILLWISEON`,
  `BILLALLOCATIONS.LIST` → opening bills; `PARTYGSTIN` or `LEDGSTREGDETAILS.LIST/GSTIN`, `LEDSTATENAME`,
  `ADDRESS.LIST`, `PINCODE`, `INCOMETAXNUMBER`, phone / mobile / email / contact; bank details
  (`BANKDETAILS`, `IFSCODE`, `BRANCHNAME`, …); `TAXTYPE` / `GSTDUTYHEAD` → duty ledgers; GST rate
  details → ledger/item GST. Stock items: `BASEUNITS`, `OPENINGBALANCE '10 Nos'`, `OPENINGRATE '100/Nos'`,
  `OPENINGVALUE`, batch/godown openings, `GSTDETAILS.LIST` HSN + rate.
- Vouchers are written **as recorded** — amounts, tax, round-off and numbers are never recomputed:
  `vouchers` + `ledger_entries` + bill / cost allocations + bank instrument details + `inventory_entries`
  (`ACTUALQTY`, `BILLEDQTY`, `RATE`, `DISCOUNT`, batch and accounting allocations) + `gst_lines` derived
  from the GST duty-ledger postings, allocated over the taxable lines by HSN/rate. `ISOPTIONAL` → optional
  (not in the books); `ISCANCELLED` → cancelled with no entries. Unbalanced vouchers, unknown
  ledgers/items/types, dates before the books beginning or in a locked period are issues (skipped).
  `meta = {v:1, source:'tally', importBatchId, tally:{guid, remoteId, voucherType, isInvoice}, input}`.
  Duplicates: same Tally GUID, or the same voucher type + number in its numbering period — except that a
  number match against a voucher imported from Tally with a *different* GUID is not a duplicate (Tally
  allows repeated numbers, e.g. manual numbering). `onDuplicate: 'skip'` skips (a number clash with a
  voucher entered in Bahi ERP is reported as a `number_exists` warning); `'update'` rewrites only vouchers
  that came from Tally (`meta.source = 'tally'`) and not inside the locked period — a voucher entered here
  is never overwritten. Imported numbers in the voucher type's own format advance `voucher_counters`.
- Permissions: `data.import`, plus `masters.create` (masters), `vouchers.create` and `vouchers.backdate`
  (vouchers are dated in the past), and `masters.alter` / `vouchers.alter` for `onDuplicate: 'update'`.
- Masters whose parent comes later in the file (Tally lists masters alphabetically) are created
  parents-first.
- Masters: one transaction. Vouchers: chunks of 250, each its own transaction, yielding to the event
  loop between chunks (`data.tally.progress`). ONE `import` audit entry + an `import_batches` row
  (`kind 'tally_xml'`).

## Data check (`data.verify`)

Read-only; each check reports a count and up to 50 plain-English details:
`integrity` (PRAGMA integrity_check) · `foreign_keys` (PRAGMA foreign_key_check) · `voucher_balance`
(Σ entries = 0) · `voucher_children` (child rows carry their voucher's date / books / post-dated flags;
cancelled vouchers have no entries; optional / non-accounting vouchers are out of the books; base type
matches the voucher type) · `bill_allocations` (bills add up to their entry, same ledger) ·
`cost_allocations` · `inventory_direction` (stock out for sales-side, in for purchase-side) ·
`gst_tax_postings` (gst_lines tax per head = duty-ledger postings; skipped for reverse charge, imports,
non-claimable tax, ledger-mode vouchers) · `orphans` (vouchers in the books without entries, masters under
missing parents) · `group_tree` (no cycles) · `opening_difference` (Σ openings + opening stock = 0) ·
`audit_chain` (hash chain) · `duplicate_numbers` (per voucher type and numbering period, for types with "Prevent duplicates" on).

## Tests

`backup.test.ts`, `export.test.ts`, `import.test.ts`, `tally.test.ts`, `verify.test.ts` (105 tests):
backup round trip plain / encrypted / wrong password / tampered / truncated / newer schema, retention,
auto 24 h, restore (new, replace closed, refuse open, wrong password), table export xlsx/csv (paise →
rupees, formula injection), masters export → import round trip, import preview per-row errors, commit
all-or-nothing vs skip invalid, invoices through the vouchers service, the full Tally fixture (TB balances,
pending bills, stock, GST as recorded, optional/cancelled, duplicates, date range), and verify on clean and
corrupted data; review regressions: backup read back before retention, forged-manifest replace refused,
owner password for a secured company, template example rows refused, import permissions, repeated Tally
numbers, update never overwriting vouchers entered here, locked period, numbering counters, parents later
in the file (UTF-16 with BOM, entities).
