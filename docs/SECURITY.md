# Bahi ERP — Security

This document describes what Bahi ERP protects, against whom, and how. It complements
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-security). Code references are given so every control can be
audited.

## 1. Assets

| Asset | Where it lives |
|---|---|
| Company books (vouchers, ledgers, inventory, GST data) | `<data folder>\companies\<id>\company.db` (SQLite, WAL) |
| Attachments | `<data folder>\companies\<id>\attachments\` (content-addressed); copies opened in other programs under `%TEMP%\bahi-attachments\` |
| Shared documents | `<data folder>\companies\<id>\exports\shared\` (PDF + draft `.eml` written by main for e-mail / WhatsApp sharing) |
| User accounts, password hashes, roles | inside each `company.db` |
| Edit log (audit trail) | `audit_log` table in each `company.db` (append-only, hash-chained) |
| Backups | files the user saves via **Data → Backup** (optionally encrypted) |
| App settings & logs | `%APPDATA%\Bahi ERP\` (`config.json`, `window-state.json`, `logs\bahi.log*`) |
| Edit-log check-points | `%APPDATA%\Bahi ERP\audit-anchors.json` (HMAC-signed) and `audit-anchor.key` (sealed with Windows DPAPI via Electron `safeStorage`) — never in the data folder or a backup |

## 2. Threat model

Bahi ERP is a single-user-at-a-time desktop application with **no server and no network features**.
We consider:

| # | Threat actor / scenario | In scope | Notes |
|---|---|---|---|
| T1 | **Another local user / person with file access** (shared office PC, stolen laptop, copied data folder) | Yes | Mitigated by Windows account isolation, optional company security, encrypted backups and *disk encryption you enable* (BitLocker). The app cannot protect files from someone who is already logged in as you or who has administrator rights. |
| T2 | **Malicious import files** (CSV/Excel/JSON/XML imports, GSTR-2B JSON, bank statements, backup files from untrusted sources) | Yes | Parsed by size-limited, schema-validated parsers in `src/core`; never executed; never rendered as HTML. Backups are integrity-checked (and authenticated when encrypted) before restore. |
| T3 | **Renderer compromise** (a bug that lets crafted data inject script into the UI, a malicious dependency in the renderer bundle) | Yes | The renderer is treated as untrusted: sandboxed, no Node.js, no network, minimal IPC with origin checks and re-validation in main (§3, §4). |
| T4 | **Tampering with the books** after the fact (backdating, silent edits/deletes) | Yes | Period lock, permissions, an append-only hash-chained edit log, and check-points of that log kept **outside** the company file (§4.1). Every change made through the app — including Excel/CSV and Tally imports — has its own edit-log entry. What is and is not detected when someone edits the file directly is listed in §4.1. |
| T5 | Malware running as the same Windows user | No | Such malware can read the user's files, keystrokes and memory. Use endpoint protection. |
| T6 | Network attackers | Minimal surface | The app makes no network requests; the session blocks all outbound requests (§3.4). Links open in the user's browser only after confirmation. |
| T7 | Supply chain (npm packages, build pipeline) | Partially | Runtime dependencies are limited to React/react-dom/qrcode (bundled); core has zero dependencies. Builds run on GitHub-hosted runners; releases publish SHA-256 checksums. See §7 for remaining work. |

## 3. Electron hardening (src/main)

### 3.1 Renderer isolation — `src/main/window.ts`

Every app window is created with:

```ts
webPreferences: {
  preload,                       // out/preload/index.cjs
  sandbox: true,                 // OS-level sandbox; preload limited to require('electron')
  contextIsolation: true,        // page JS cannot touch preload/Electron objects
  nodeIntegration: false,        // no require/process/Buffer in the page
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,             // same-origin policy enforced
  allowRunningInsecureContent: false,
  webviewTag: false,             // <webview> disabled
  spellcheck: false,             // no dictionary downloads
  navigateOnDragDrop: false,     // dropping a file cannot navigate the window
  devTools: !app.isPackaged,     // DevTools unavailable in installed builds
}
```

Additionally `app.enableSandbox()` forces the sandbox for *every* renderer, including print windows.
The `remote` module no longer exists in Electron and `@electron/remote` is not used.

### 3.2 No file:// — a private `app://bahi` origin — `src/main/protocol.ts`

The UI is served from `out/renderer` over a privileged custom scheme (`standard`, `secure`,
`supportFetchAPI`) instead of `file://`. Requests are confined to the renderer folder: percent-decoding,
`..` segments, backslashes, drive letters, NTFS alternate data streams and NUL bytes are rejected
(`resolveAppPath`, unit-tested in `protocol.test.ts`). Only GET/HEAD are served, with explicit MIME
types and `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.

### 3.3 Content-Security-Policy — `src/main/policy.ts`

Sent as a response header for app documents (header, not `<meta>`, so it cannot be removed by the page):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

No `unsafe-eval`, no inline scripts. In **development only** (`npm run dev`) the Vite server origin is
added to `connect-src` and `'unsafe-inline'` to `script-src` (React Fast Refresh preamble).
`BAHI_DEV_SERVER_URL` is ignored in packaged builds and must be a loopback `http://` URL.

### 3.4 Session policy — `src/main/security.ts`

- **Permissions:** every permission request and check is denied except `clipboard-sanitized-write`
  (copy buttons). No camera, microphone, geolocation, notifications, HID/USB/serial, etc.
- **Network kill-switch:** `webRequest.onBeforeRequest` cancels every request that is not `app://bahi`,
  `data:`, `blob:`, `about:` or `devtools:` (plus the loopback dev server in development). Even a
  CSP bypass could not exfiltrate data over the network.
- **Navigation:** `will-navigate` and `will-redirect` away from the app origin are blocked;
  `window.open` is always denied; `<webview>` attachment is always prevented. Links to `https:` are
  offered to the user's browser **after a confirmation dialog that shows the host**; `mailto:` opens
  directly; every other scheme (`file:`, `javascript:`, `smb:`, `ms-*`, …) is refused.
- Pinch/visual zoom is disabled; zoom is clamped to 70–150 %.

### 3.5 IPC — `src/main/ipc.ts`, `src/preload/index.ts`

- The preload exposes exactly `window.bahi = { api, native, on, setDirty, platform }` — never
  `ipcRenderer` itself. Event listeners receive only the payload (never the `IpcRendererEvent`).
- Three channels only: `bahi:api` and `bahi:native` (invoke) and `bahi:dirty` (send).
- Every message must come from a WebContents created by the window manager, from its **top-level
  frame**, whose URL is on the app origin. Anything else gets `FORBIDDEN`.
- Route names must match `<module>.<entity>.<action>` (≤ 127 chars, at least one dot — which also
  makes prototype names such as `constructor` impossible). The core dispatcher then validates the input
  against the route's schema and enforces the route's permission.
- Handlers never throw across IPC; internal errors return a generic message (details go to the log).
- Native actions (`src/main/native.ts`) re-validate every payload: string lengths, enums, integer
  ranges, file filters. Files are read/written only through dialogs the user operates; opened files are
  capped at 100 MB; saves are atomic (temp file + fsync + rename). `shell.showItem` only reveals paths
  inside the data folder or paths the user picked in a dialog during this session. Nothing ever calls
  `shell.openPath` with a renderer-supplied path: it opens only a draft `.eml` main itself wrote into
  the company's `exports\shared` folder (`share.email`) and an attachment copy main wrote into a fresh
  temp folder after re-checking the file's kind **and content** (`attachment.openCopy`).
- Paths that the renderer passes to **core routes** (backup folder to write or list, backup file to
  check or restore, the F12 backup folder) are authorised by the core (`core/lib/paths.ts`
  `authorizeUserPath`): allowed only inside the data folder, inside the company's configured backup
  folder (itself authorised when it was saved), or when main confirms the user picked that file/folder
  in a native dialog this session (`authorizePath` → `user-choices.ts`). UNC (`\\server\share`) and
  device (`\\?\`, `\\.\`) paths are refused unless picked — a remote share would leak the user's NTLM
  hash and ship the books off the machine. Anything else gets `FORBIDDEN`.
- The F12 backup folder stored **inside a restored backup** is untrusted too (a crafted backup could
  name `\\attacker\share`, and automatic backups would then copy the books there after every login).
  A restore keeps it only when it lies in the data folder, was picked in a dialog this session, is the
  folder the backup file itself was chosen from (local folders only), or is the folder of the company
  being replaced; otherwise it is cleared and the restore's edit-log entry names the folder dropped
  (`backupFolderNotKept`).
- Beyond restores, the F12 backup folder is written to (and trusted as a root) only when it is
  **approved for that company on this installation** (`<userData>/backup-folders.json`, kept outside the
  data folder, company files and backups; `core/app/backupFolders.ts`) or lies in the data folder. A
  company folder copied from another PC or a shared data folder therefore cannot make automatic backups
  copy the books to a share nobody picked here: backups go to the default folder and the user is asked
  to confirm the folder by picking it in the folder dialog (`data.backup.approveFolder`, company.manage).

- **Sharing** (`src/main/share.ts`): the shared-documents folder is chosen by main from the open
  company; `exports` and `shared` are created without following links (a link, junction or file in
  their place is refused, so a junction planted in a shared data folder cannot redirect the PDF to a
  network share). The draft e-mail's headers are built by main: recipients must be plain addresses
  (no display names, no control characters, ≤ 20, `To:` folded one per line), the subject is a single
  line (RFC 2047-encoded), the body and PDF are base64 — CR/LF header injection is impossible. The
  WhatsApp link is built by main as `https://wa.me/91<validated mobile>?text=<encoded>` and opened only
  after the user confirms the host.
- **Attachment copies** (`src/main/attachments.ts`): the copies' parent `<temp>\bahi-attachments` is
  refused when it is a link / junction or (POSIX) not a private folder of this account; the day-old
  sweep removes links as links and never follows them; device names (`CON.pdf`) are renamed.

### 3.6 Printing and PDF — `src/main/print.ts`

Print HTML is rendered in a hidden window that is sandboxed, has **JavaScript disabled**, lives in a
separate **in-memory session** that cancels every request except its own document and `data:`/`blob:`
resources, and is served with `default-src 'none'; script-src 'none'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:`. A crafted invoice therefore cannot run script, load remote
images (tracking pixels) or read local files into a PDF. At most two print jobs run at once, each with
a timeout; the window is always destroyed afterwards.

### 3.7 Packaged binary — `scripts/after-pack.cjs`, `scripts/fuses.cjs`

electron-builder flips Electron **fuses** on `Bahi ERP.exe`: `RunAsNode` off (`ELECTRON_RUN_AS_NODE`
cannot turn the signed exe into a Node runtime), `NODE_OPTIONS` ignored, `--inspect` ignored, app code
only from `app.asar`, cookie encryption on, no extra `file://` privileges. The installer runs
`asInvoker` (no elevation unless the user chooses a per-machine install).

The hook **fails closed**: `@electron/fuses` is a declared devDependency, and the build fails if it
cannot be loaded, if a wanted fuse is unknown to it, if flipping fails, or if the fuses read back
differently (`BAHI_ALLOW_UNFUSED=1` downgrades this to a warning for a throw-away local build only;
CI never sets it). CI and the release workflow then read the fuses back from the packaged
`release/win-unpacked/Bahi ERP.exe` with `scripts/check-fuses.cjs` and fail on any difference, and
install + launch the installer (`scripts/smoke-installed.ps1`) to prove the hardened binary boots.

The core worker script (`resources/app.asar.unpacked/out/main/core-worker.cjs`, §3.9) lives outside
the archive because worker threads cannot load scripts from `app.asar`; like every installed file it is
protected by the install folder's NTFS permissions, and it requires only `node:*` builtins (the build
fails otherwise).

### 3.8 Crash and error handling — `src/main/index.ts`, `src/main/window.ts`, `src/main/quit.ts`

Uncaught exceptions and unhandled rejections are logged and a generic message box is shown (no stack
traces in the UI, rate-limited); the same applies to faults reported by the core worker. A crashed
renderer is logged and the user is offered *Reload*; a hung renderer offers *Keep waiting / Reload*.
If the renderer reports unsaved work, closing asks for confirmation (the flag is reset whenever the
window navigates or reloads). Quitting is a bounded state machine (`quit.ts`): once every window has
closed, the core runs the automatic backup and closes the open company (WAL checkpoint, lock release),
the worker is terminated, and the process exits with `app.exit` — at the latest 40 s after the last
window closed, whatever happens.

### 3.9 The core off the UI thread — `src/main/core-proxy.ts`, `src/main/core-worker.ts`

The accounting core (node:sqlite connections, company lock, session, every route handler) runs on a
`node:worker_threads` thread inside the main process; the main thread keeps only windows, dialogs and
IPC. Security properties:

- The renderer still reaches the core only through `ipc.ts` (sender + frame checks, route-name check),
  which forwards to the worker; the worker cannot be messaged by anything else.
- Path authorisation stays with the user's dialog choices (§3.5): every file/folder picked in a native
  dialog is mirrored into the worker (`user-choices.ts` → `authorizeChoice`) **before** the dialog
  result reaches the renderer, and the worker answers `authorizeDataDir` / `authorizePath` from that
  mirror with the same pure rule (`isUserChosenPath`). Message order between the two threads is FIFO,
  so a route naming the path can never overtake its authorisation.
- Results cross as structured clones; byte arrays are copied into fresh buffers before they are
  transferred, so a view into a larger (pooled) buffer never carries unrelated memory to the window.
- Log lines from main are redacted (`password|secret|token` keys) before they are posted to the
  worker, which owns the log file.
- A crashed or out-of-memory worker takes only the core down: in-flight calls get a clear error, the
  worker is restarted with no company open (at most 3 times in 10 minutes), and the window is told
  (`core.restarted`). A terminated worker's SQLite connections are closed, rolling back any open
  transaction.

### 3.10 Build and release pipeline — `.github/workflows/`

- Every third-party action is pinned to a full commit SHA; Dependabot proposes updates.
- Dependencies install with `npm ci` from the committed lockfile (generated by the Lockfile workflow,
  which resolves metadata only with `--ignore-scripts`, so no package code runs while it holds a write
  token). A release refuses to build unless the tagged commit's lockfile matches `package.json`
  (`scripts/lockfile-sync.mjs`), so caret ranges never float into a signed installer.
- These rules are pinned by unit tests (`src/main/ci-workflows.test.ts`, `src/main/lockfile-sync.test.ts`).
- Release (`release.yml`): the build job has a read-only token that checkout does not persist; npm
  install, typecheck and tests run with **no secrets in the environment**, so no dependency lifecycle
  script can read the signing certificate; the certificate (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`)
  exists only in the one packaging step, which runs the already-installed electron-builder. The
  installer is then installed and launched on a clean runner (smoke test), and only the separate
  publish job — no checkout, no npm — holds `contents: write` to create the GitHub Release. Release
  builds restore no caches.
- Release installs run **no dependency install scripts**: `npm ci --ignore-scripts`, then only the
  scripts reviewed in `scripts/install-scripts.mjs` (esbuild's `node install.js`, run by path from the
  lockfile-pinned package; fsevents / electron-winstaller skipped as unused on a Windows NSIS build).
  `--check` runs first and fails the release when the lockfile gains an install script nobody reviewed.
  So no install script can leave code in `node_modules` that later runs in the signing step.
  *Residual risk*: build tools themselves (tsc, esbuild, vite, electron-builder) still run before and
  in the packaging step; a separate signing job that receives only the unsigned output is not
  implemented (electron-builder signs the app exe inside the NSIS package).

## 4. Application controls (src/core)

| Control | Implementation |
|---|---|
| Passwords | `scrypt` (N = 2^15, r = 8, p = 1, 16-byte random salt), constant-time comparison |
| Brute force | account locked for 5 minutes after 5 failed logins |
| Idle timeout | secured companies: after the configured minutes without keyboard/mouse input the screen locks (`app.session.lock`, audited as a logout with reason `idle`); the workspace is hidden and inert behind a re-login screen and resumes only for the same user. The dispatcher also refuses any call made after the timeout |
| Export | Excel, CSV, PDF and Print of every report need the `data.export` permission, checked by the core, and each is recorded as `export` in the edit log |
| Authorisation | every route declares a permission; Owner holds all; checked by the dispatcher |
| SQL injection | all SQL is parameterised (`:name` placeholders); user input is never interpolated |
| XSS | React escaping; `dangerouslySetInnerHTML` is banned; CSP as above |
| CSV / Excel formula injection | every CSV and Excel export (reports, masters / vouchers, TDS return CSVs, CMP-08 / GSTR-4, e-payment files, edit log, reconciliation) goes through `shared/csvSafe.ts`: a text cell starting with `=` `+` `-` `@` TAB or CR gets a leading `'` in CSV, and in Excel stays a string cell with the `quotePrefix` style (its value unchanged, so our importer reads it back exactly); real numbers, and text that is exactly a plain number such as `-1,250.50`, are left as numbers |
| Audit trail | append-only `audit_log` (triggers block UPDATE/DELETE; re-created on open if missing), SHA-256 hash chain over entries, external check-points (§4.1), verifiable from the UI (Security › Edit Log › Verify) |
| Imports | Excel/CSV and Tally imports write one edit-log entry per master and per voucher created or altered (before/after), plus an `import` summary; F11 changes made by a Tally import need `company.manage` |
| Owner confirmations | deleting a company or restoring over it checks an Owner password against **that company's** users table with its login lockout (one shared, persistent budget) and records failures as `login_failed` in its edit log; at most 20 credential checks per company per minute; a locked account adds at most one `locked` entry per lockout |
| Security on/off | only `security.enable` / `security.disable` (Owner + password); F11 (`company.features.save`) refuses any change to `security` |
| Untrusted databases | backups and company files are schema-checked before any query (`core/db/schemaCheck.ts`): no views or virtual tables, only triggers our migrations create, core tables present; `PRAGMA trusted_schema = OFF` on every connection; backup unpacking is capped at the declared size (decompression bombs) and refused when it would not fit on the disk; leftover decrypted temporary copies are swept at start-up |
| Renderer-supplied paths | backup folders/files (and the F12 backup folder) must be inside the data folder, the configured backup folder, or picked in a native dialog this session (`core/lib/paths.ts`, main's `authorizePath`); UNC/device paths are refused unless picked; the no-login backup routes accept nothing else |
| Period lock | vouchers dated on or before the lock date cannot be created, altered or deleted — including every new voucher kind (POS bills / returns, recurring postings, GST set-off and challans, TDS challans, forex revaluation, manufacturing / job work journals), which all save through `saveVoucher`; opening balances **and their foreign-currency amounts** are frozen once the lock covers the books beginning; order pre-closures, cheque-leaf cancel / re-open, composition rate rows (and the composition category) reaching into the locked period, and attachment removal on locked vouchers are refused. Job work orders are memo documents (no books effect) and are not locked |
| Backups | AES-256-GCM with a scrypt-derived key when a password is given; integrity/authenticity verified before restore |
| Logging | JSON lines with rotation; secrets and document payloads are never logged (redaction in `core/app/logger.ts`) |
| Data folder changes | copies are integrity-checked (`PRAGMA quick_check`) before the source is removed; failures roll back |

### 4.0 Parity-wave surfaces (security review, final wave)

| # | Surface | Threat | Control (code / test) |
|---|---|---|---|
| P1 | New routes (`tds`, `documents`, `mfg`, `forex`, `cheques`, `attachments`, `print.share`, `pos`, `data.tally.export`, GST plus) | missing or too-weak access | every route declares a real permission; `authenticated` only on the attachment reads, whose service checks the owner's `vouchers.view` / `masters.view`; save routes declared `*.view` check `create` / `alter` in the service; roles: Auditor `tds.view` only, Data Entry `attachments.add` only (`core/api/parity-security.test.ts`) |
| P2 | Report / list filters | a misspelt optional filter (party, book, status, period, kind) silently widening what is shown or exported | `v.strictObject` on the filters of the cheque register / e-payment list / payees / books, attachment register, production register, pending job work, job work orders, BOMs, job work alerts, due recurring vouchers, GST amendments / 3B changes / Rule 37 / pending advances / filings, TDS lines / return, POS register / summary (same test) |
| P3 | Mutations | change without an edit-log entry | every save / delete / post / import of the new modules audits; voucher types created by F11 Manufacturing / Job work now have their own `create` entries (`mfg/security.test.ts`); ledgers created on demand (TDS, GST plus, forex, POS) are audited |
| P4 | Period lock | back-dated change of locked figures through a non-voucher path | forex opening in the currency refused when the lock covers the books beginning (`forex/security.test.ts`); cheque-leaf cancel / re-open dated in the locked period (`cheques/lock.test.ts`); composition rate rows / category that would change a locked quarter's CMP-08 / GSTR-4 tax (`gst/composition-lock.test.ts`); new voucher kinds go through `saveVoucher` |
| P5 | Filed returns | silent change of a filed GSTR-1 / GSTR-3B / TDS-TCS statement | GST hook on every voucher kind (amendment log, filed-3B change log, delete / cancel of a filed GSTR-1 document refused); TDS hook (`tds/filed.ts`): a save that changes the deductions / collections / challan reported in a quarter whose Form 26Q / 27Q / 27EQ is marked filed needs confirmation (correction statement), and deleting / cancelling such a voucher is refused until the filing record is removed (audited) (`tds/filed.test.ts`) |
| P6 | Attachments | malware opened from the books; path tricks | allowlisted kinds + content sniffing in the core **and again in main** (renderer untrusted); no programs; no VBA, Excel 4.0 macro sheets, ActiveX controls or OpenDocument Basic / script macros; no active XML (style sheets, scripts, XHTML / SVG namespaces — also when written with character references — and no DTD entity / attribute declarations) (`attachments/content-security.test.ts`); 25 MB; content-addressed storage; device names renamed; private temp folder (`main/attachments.test.ts`) |
| P7 | Sharing | header injection in the `.eml`; arbitrary URL / path opened | addresses validated, single-line subject, base64 body; wa.me URL and mobile validated in main; folder chosen by main, links refused; file names never a Windows device (`CON .pdf`, `COM¹`, `CONIN$` — `main/files.ts` sanitizeFileName) (`main/share-security.test.ts`, `main/share.test.ts`, `main/files.test.ts`) |
| P8 | CSV / bank / return files | formula injection; wrong rows exported | `toCsv` neutralises formulas (e-payment, TDS return, CMP-08 / GSTR-4, ITC-04 via the export path); e-payment files take regular Payments only and are recorded (batches, edit log) |
| P9 | SQL | injection through filters / search | parameterised; dynamic SQL only joins constant fragments or table names from fixed maps |
| P10 | Logs | PII in `bahi.log` | new modules log only error objects and reasons — no PAN, GSTIN, mobile, e-mail, account numbers or document payloads |
| P11 | Security off (implicit Owner session) | user-keyed checks | the e-payment "discard" check compares the creating user with the current one (`null` = no login), so a batch made with security off cannot be discarded by a logged-in user and vice versa; `security.disable` still needs an Owner login + password |

**Residual risks (not mitigated by the app):** a PDF may carry JavaScript / launch actions, an Office
file embedded OLE objects (packages), and an old binary `.xls` Excel 4.0 macros (only VBA is detected
in the binary formats) — the PDF reader / Office security prompts apply; an attached CSV opened in
Excel is the original file (formulas are not neutralised). The filed-statement check compares what the
voucher reports (section, party, amounts, status, date, challan details); a change of the deductee's
PAN or name in the ledger master is not tied to a voucher and is not flagged.

### 4.1 Edit-log integrity: what is detected, and the limits

The edit log is a SHA-256 hash chain (`core/lib/audit.ts`): each entry's hash covers its content and
the previous entry's hash. On its own a chain only proves internal consistency — anyone who can write
`company.db` can drop the append-only triggers, edit or delete entries, recompute every hash from the
start and re-create the triggers. Bahi ERP therefore keeps a **check-point** (the id and hash of the
newest entry) outside the company file (`core/lib/auditAnchor.ts`, `core/app/auditAnchors.ts`):

- in `audit-anchors.json` under the app's user-data folder, refreshed after every request that
  changed the log, on close and after a restore; and in every backup's manifest (`auditHead`);
- authenticated with HMAC-SHA256 under a 32-byte per-installation key that is never written to a
  company file or a backup; Electron main seals the key with `safeStorage` (DPAPI on Windows) and hands
  it to the core worker (`src/main/anchor-key.ts`), so a copied key file is useless on another account
  or computer. When the key exists but cannot be used in a run (OS protection unavailable, file
  unreadable) the app neither judges nor writes check-points that run (Verify shows none) — a
  check-point signed with a throw-away key would otherwise read as tampering in the next run.

**Detected** (Verify reports "tampered with", and opening the company logs a warning and freezes the
check-point as evidence until an Owner accepts the current log, which is itself recorded):
modification, insertion or deletion of entries in the middle of the log; removal of the newest
entries up to the check-point (truncation); a rewrite of the whole log with all hashes recomputed;
the company file replaced by another company's file; an edited check-point (bad MAC); a backup whose
edit log was changed after it was made (its signed `auditHead` no longer matches — refused on
restore when it was made on this installation).

**Not detected** (residual risk — combine with backups, access control and disk encryption):
- entries written after the newest check-point, removed while the app was not running to record
  them (the window is at most the work since the last completed request);
- tampering by someone who runs code **as the same Windows user** (T5): they can unseal the key and
  re-sign check-points, or edit the books through the app itself;
- a company used on several computers: each installation only knows its own check-points (a backup
  made elsewhere is verified by its chain only);
- deleting or resetting the user-data folder loses the check-points (Verify then reports only the
  chain; the next request records a new check-point).

## 5. Data at rest — guidance for administrators

Bahi ERP does **not** encrypt `company.db` itself (SQLite has no built-in encryption and the app has no
native modules). Protect data at rest with the operating system:

1. **Enable BitLocker** (Windows 10/11 Pro/Enterprise) or *Device encryption* (Home) on the drive that
   holds the data folder, and keep the recovery key safe.
2. Give every person their **own Windows account**; the data folder inherits the user's NTFS
   permissions (`%USERPROFILE%\Documents` is private to the user by default). For a shared folder,
   grant access only to the accounts that need it.
3. Turn on **company security** (F11 → Security) when several people use the same company, and assign
   roles with the least permissions needed.
4. Use **encrypted backups** (set a backup password) for anything that leaves the machine, and store
   backups on a separate disk or cloud drive. Test restores periodically.
5. Lock the screen when away (`Win+L`); set the idle timeout for secured companies.
6. Keep Windows and Bahi ERP updated.

## 6. Configuration switches

| Variable | Effect | Notes |
|---|---|---|
| `BAHI_USER_DATA` | absolute path used instead of `%APPDATA%\Bahi ERP` | tests, portable setups |
| `BAHI_DATA_DIR` | default data folder on first run | tests |
| `BAHI_DEV_SERVER_URL` | load the UI from a Vite dev server | **ignored in packaged builds**; loopback http only |
| `BAHI_DISABLE_GPU=1` | disable hardware acceleration | for machines with broken GPU drivers |
| `BAHI_E2E=1` | suppress modal dialogs | automated tests only |
| `BAHI_SMOKE_TEST=1` | check `app.state` through the bridge once, log the verdict, quit with exit code 0/1 | packaged-app smoke test in CI; honoured in packaged builds, reads nothing but app state |
| `BAHI_ALLOW_UNFUSED=1` | (build time) let `after-pack.cjs` continue without fuses | throw-away local builds only; never in CI |

Environment variables are not a security boundary: anyone who can set them for your account can
already run code as you.

## 7. Known gaps and planned hardening

- Installers are **not code-signed** yet (SmartScreen warning; integrity relies on the GitHub Release
  page and `SHA256SUMS.txt`). See [BUILD.md → Code signing](BUILD.md#7-code-signing).
- The lockfile is generated by CI (`.github/workflows/lockfile.yml`) rather than on a developer
  machine; review the generated `package-lock.json` diff like any other change. Dependabot proposes
  npm and GitHub Actions updates as pull requests.
- Consider enabling the `EnableEmbeddedAsarIntegrityValidation` fuse once verified with the
  electron-builder version in use, and Trusted Types (`require-trusted-types-for 'script'`) once the
  renderer is confirmed free of string-to-DOM sinks.
- No automatic update mechanism (by design for offline use); users install new versions manually.

## 8. Reporting a vulnerability

Please report security issues privately to the maintainers (do not open a public issue). Include steps
to reproduce and the app version (Help → About).
