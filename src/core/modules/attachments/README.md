# attachments — files attached to vouchers, ledgers and stock items (dataplus)

Scanned purchase bills, signed delivery challans, bank advices, agreements and payment proofs kept with
the voucher or master they support — audit and GST input-tax-credit evidence. Migration
`222_attachments.ts`; DTOs `src/shared/types/attachments.ts`; kinds and limits
`src/shared/attachments.ts`; renderer `src/renderer/modules/attachments/`.

| File | What |
|---|---|
| `store.ts` | the company's `attachments/` folder: content-addressed files `<sha256>.<ext>`, atomic writes (temp file + rename), verification, content sniffing (`contentProblem`) |
| `service.ts` | list / counts / add / read / remove / register, permissions, audit |
| `backup.ts` | files into a backup snapshot (`attachment_blobs`), back out on restore, the data-check pass |
| `hook.ts` | voucher hook (vouchers/hooks.ts › `beforeRemove`): a voucher with attached files cannot be deleted |
| `routes.ts` | the routes below |

## Routes

| Route | Input → Output | Access |
|---|---|---|
| `attachments.list` | `{ entityType, entityId }` → `AttachmentRow[]` | authenticated + the owner's view right (`vouchers.view` / `masters.view`) |
| `attachments.counts` | `{ entityType, ids[] }` → counts per id (list badges) | as above |
| `attachments.add` | `{ entityType, entityId, fileName, bytes, note? }` → `AttachmentRow` | `attachments.add` (+ view right); own transaction |
| `attachments.read` | `{ id }` → `AttachmentFile` (bytes, name, mime) | view right |
| `attachments.remove` | `{ id }` → `{ id }` | `attachments.remove`; own transaction |
| `attachments.register` | `{ entityType?, search?, from?, to?, limit?, offset? }` → every attachment with its owner | the view rights the user has |
| `attachments.unused` | `{}` → `AttachmentUnusedResult` (stored files no attachment refers to, with sizes) | `attachments.remove` |
| `attachments.sweep` | `{}` → `AttachmentSweepResult` (`removed`, `bytes`) — deletes them (each re-checked first); one edit-log entry (`delete`, entity type `attachment_files`, count, size, SHA-256 prefixes) when anything was removed | `attachments.remove`; no transaction around the file deletes |

`entityType`: `voucher` · `ledger` · `stock_item`. New permissions `attachments.add` (Accountant, Data
Entry) and `attachments.remove` (Accountant); the Owner has every right. Migration 222 grants them to
the system roles of existing companies.

## Rules

- **No paths from the renderer.** The renderer sends the bytes of a file the user picked in the native
  Open dialog (`dialog.openFile`); opening sends the bytes read through `attachments.read` to main
  (`attachment.openCopy`), which checks the kind **and the content** again (the renderer is untrusted:
  `main/attachments.ts` runs the same `contentProblem` check as the core), writes a copy into a fresh
  temporary folder and opens it with the program Windows uses for that kind. The copies' parent folder
  (`<temp>/pevqori-attachments`) is created private and refused when it is a link / junction or (POSIX) not
  a private folder of this account; the day-old sweep never follows a link.
- **Allowed kinds:** PDF; JPG / PNG / GIF / WebP / TIFF / BMP; XLSX / DOCX / ODT / ODS; XLS / DOC; CSV,
  TXT, JSON, XML (UTF-8). The extension must be allowed AND the first bytes must match it: a renamed
  program (`MZ`, ELF, Mach-O, scripts) is refused, as are Office files that run code (`vbaProject.bin`,
  `macrosheets/`, `activeX/` parts; OpenDocument `Basic/` and `Scripts/`; `_VBA_PROJECT` in the binary
  formats) and non-UTF-8 text. Never programs, scripts, shortcuts, HTML or archives. An XML file
  that is really a web page or an Office document (XHTML / SVG namespace — also when written with
  character references such as `&#104;ttp:` — `<script>`, an `<?xml-stylesheet?>` or
  `<?mso-application?>` instruction, `<!ENTITY>` / `<!ATTLIST>` declarations, Office namespaces) is
  refused too — Windows opens `.xml` in a browser or Office, where it could run. Excel 4.0 macros in an
  old binary `.xls` and embedded OLE packages are not detected (SECURITY.md §4.0 residual risks).
- **Limits:** 25 MB a file, 50 files per voucher / master, names cleaned to 200 characters (no folders,
  control or reserved characters; a Windows device name such as `CON.pdf` or `nul .txt` gets a leading
  `_`). The same content twice on one owner is refused (`CONFLICT`).
- **Storage:** `<company folder>/attachments/<sha256>.<ext>`; the same scan attached to several vouchers
  is stored once. The database row keeps the original name, size, SHA-256, note, who and when. The file
  is written first, then the row in its own transaction; if the row cannot be written the file is
  deleted again (unless other rows use the same content).
- **Remove:** needs `attachments.remove`; for a voucher dated in the locked period it is refused
  (`LOCKED` — evidence of locked books cannot be taken away; adding stays possible). The file is deleted
  only after the transaction committed and only when no other row uses the same content.
- **Owners:** a voucher, ledger or stock item with attachments cannot be DELETED until they are removed
  (`BUSINESS_RULE`; for vouchers through the `beforeRemove` voucher hook). Otherwise deleting the
  voucher would take the evidence away silently — also for a user who may delete vouchers but not
  remove attachments. Cancelling a voucher keeps it, and its files. (The `ON DELETE CASCADE` on
  `attachments.voucher_id` is only a last line of defence.)
- **Edit log:** every add / remove is an `alter` audit entry of the OWNER (so it shows in that voucher's or
  master's Alt+H history) with the file's name, size and SHA-256.

## Backups, restore, data check

A backup snapshot is a copy of the database; before it is packed every attached file is copied into the
snapshot's `attachment_blobs` table, so the `.pvqbak` format, its checksums and its password encryption
cover the files with no format change. A file that is missing or changed is left out, logged and counted
in the backup result (`attachments.missing`). Backup verification reports an `attachments` check. A
restore writes the files into the restored company's `attachments/` folder, empties the table and
`VACUUM`s the restored database (so it does not keep the files' size as free pages) — a live company
never carries file contents in its database. `data.verify` › `attachments`: every attached file present
and matching its SHA-256; stored files nothing uses (copied in by hand, an interrupted attach) are
mentioned (they are not in backups); Attachment Register › Alt+U (`attachments.sweep`) deletes them.

## UI

`attachments.manage {entityType, entityId, label?}` and `attachments.register` (Gateway › Reports ›
Attachment Register, Go To). Keys: Alt+C attach (native file dialog), Enter / Alt+O open a copy, Alt+K
save a copy, Alt+D remove, Alt+M open the owner, Alt+E export / Alt+P print the list; on the register,
Alt+U "Remove unused files" (lists them, asks, sweeps; needs `attachments.remove`). Alt+F opens the
files from the voucher view (voucher panel) and from the ledger / stock item forms.

## Tests

`attachments.test.ts`: add / list / read / remove, permissions per role, content checks (renamed
program, macros, size, kind, active XML), duplicate content, the locked period, shared content kept until
the last row goes, audit entries on the owner, a voucher / ledger / item with files cannot be deleted
(also through `vouchers.delete` for a user without `attachments.remove`), cancelling keeps the files, a
failed attach leaves no file behind, unused files reported and swept, backup → restore carrying the files
(plain and encrypted), the data check finding a missing or changed file, the register; `sweep.test.ts`:
the unused-files list and sweep (permission, attached files kept, edit-log entry).

## Known gaps

- No preview inside the app: files open in the program Windows uses for their kind.
- Attachments are not part of the Excel / XML data exports (the XML format has no attachment element).
- A CSV opened in Excel is not checked for formula injection (Excel's own protected view / DDE settings
  apply); attach a PDF of a bank statement where possible.
