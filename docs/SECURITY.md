# Bahi ERP — Security

This document describes what Bahi ERP protects, against whom, and how. It complements
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-security). Code references are given so every control can be
audited.

## 1. Assets

| Asset | Where it lives |
|---|---|
| Company books (vouchers, ledgers, inventory, GST data) | `<data folder>\companies\<id>\company.db` (SQLite, WAL) |
| Attachments | `<data folder>\companies\<id>\attachments\` |
| User accounts, password hashes, roles | inside each `company.db` |
| Edit log (audit trail) | `audit_log` table in each `company.db` (append-only, hash-chained) |
| Backups | files the user saves via **Data → Backup** (optionally encrypted) |
| App settings & logs | `%APPDATA%\Bahi ERP\` (`config.json`, `window-state.json`, `logs\bahi.log*`) |

## 2. Threat model

Bahi ERP is a single-user-at-a-time desktop application with **no server and no network features**.
We consider:

| # | Threat actor / scenario | In scope | Notes |
|---|---|---|---|
| T1 | **Another local user / person with file access** (shared office PC, stolen laptop, copied data folder) | Yes | Mitigated by Windows account isolation, optional company security, encrypted backups and *disk encryption you enable* (BitLocker). The app cannot protect files from someone who is already logged in as you or who has administrator rights. |
| T2 | **Malicious import files** (CSV/Excel/JSON/XML imports, GSTR-2B JSON, bank statements, backup files from untrusted sources) | Yes | Parsed by size-limited, schema-validated parsers in `src/core`; never executed; never rendered as HTML. Backups are integrity-checked (and authenticated when encrypted) before restore. |
| T3 | **Renderer compromise** (a bug that lets crafted data inject script into the UI, a malicious dependency in the renderer bundle) | Yes | The renderer is treated as untrusted: sandboxed, no Node.js, no network, minimal IPC with origin checks and re-validation in main (§3, §4). |
| T4 | **Tampering with the books** after the fact (backdating, silent edits/deletes) | Yes | Period lock, permissions, and a hash-chained edit log that detects modification or deletion of log entries. A user with raw file access can still replace the whole database — combine with backups and access control. |
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
  `shell.openPath` with a renderer-supplied path.

### 3.6 Printing and PDF — `src/main/print.ts`

Print HTML is rendered in a hidden window that is sandboxed, has **JavaScript disabled**, lives in a
separate **in-memory session** that cancels every request except its own document and `data:`/`blob:`
resources, and is served with `default-src 'none'; script-src 'none'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:`. A crafted invoice therefore cannot run script, load remote
images (tracking pixels) or read local files into a PDF. At most two print jobs run at once, each with
a timeout; the window is always destroyed afterwards.

### 3.7 Packaged binary — `scripts/after-pack.cjs`

electron-builder flips Electron **fuses** on `Bahi ERP.exe`: `RunAsNode` off (`ELECTRON_RUN_AS_NODE`
cannot turn the signed exe into a Node runtime), `NODE_OPTIONS` ignored, `--inspect` ignored, app code
only from `app.asar`, cookie encryption on, no extra `file://` privileges. The installer runs
`asInvoker` (no elevation unless the user chooses a per-machine install).

### 3.8 Crash and error handling — `src/main/index.ts`, `src/main/window.ts`

Uncaught exceptions and unhandled rejections are logged and a generic message box is shown (no stack
traces in the UI, rate-limited). A crashed renderer is logged and the user is offered *Reload*; a hung
renderer offers *Keep waiting / Reload*. Quitting closes the open company cleanly (WAL checkpoint, lock
release) with a timeout. If the renderer reports unsaved work, closing asks for confirmation.

## 4. Application controls (src/core)

| Control | Implementation |
|---|---|
| Passwords | `scrypt` (N = 2^15, r = 8, p = 1, 16-byte random salt), constant-time comparison |
| Brute force | account locked for 5 minutes after 5 failed logins; optional idle session timeout |
| Authorisation | every route declares a permission; Owner holds all; checked by the dispatcher |
| SQL injection | all SQL is parameterised (`:name` placeholders); user input is never interpolated |
| XSS | React escaping; `dangerouslySetInnerHTML` is banned; CSP as above |
| Audit trail | append-only `audit_log` (triggers block UPDATE/DELETE), SHA-256 hash chain over entries, verifiable from the UI |
| Period lock | vouchers dated on or before the lock date cannot be created, altered or deleted |
| Backups | AES-256-GCM with a scrypt-derived key when a password is given; integrity/authenticity verified before restore |
| Logging | JSON lines with rotation; secrets and document payloads are never logged (redaction in `core/app/logger.ts`) |
| Data folder changes | copies are integrity-checked (`PRAGMA quick_check`) before the source is removed; failures roll back |

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

Environment variables are not a security boundary: anyone who can set them for your account can
already run code as you.

## 7. Known gaps and planned hardening

- Installers are **not code-signed** yet (SmartScreen warning; integrity relies on the GitHub Release
  page and `SHA256SUMS.txt`). See [BUILD.md → Code signing](BUILD.md#7-code-signing).
- No lockfile is committed yet; dependency versions float within semver ranges. Commit
  `package-lock.json` and switch CI to `npm ci` once the dependency set settles.
- Consider enabling the `EnableEmbeddedAsarIntegrityValidation` fuse once verified with the
  electron-builder version in use, and Trusted Types (`require-trusted-types-for 'script'`) once the
  renderer is confirmed free of string-to-DOM sinks.
- No automatic update mechanism (by design for offline use); users install new versions manually.

## 8. Reporting a vulnerability

Please report security issues privately to the maintainers (do not open a public issue). Include steps
to reproduce and the app version (Help → About).
