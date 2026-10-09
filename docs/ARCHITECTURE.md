# Bahi ERP — Architecture & Engineering Contract

Bahi ERP is an offline-first, keyboard-first accounting, GST invoicing and inventory system for Indian
businesses, delivered as a Windows desktop app (Electron). Functionally it follows the Tally model
(Gateway → masters → vouchers → reports with drill-down) with a modern, calmer UI.

This document is the **contract** for everyone working on the codebase. Read it fully before writing code.

---

## 1. Stack

| Layer | Technology | Notes |
|---|---|---|
| Desktop shell | Electron (≥ 44) | Hardened: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP |
| Database | SQLite via **`node:sqlite`** (built into Node/Electron) | No native modules → nothing to rebuild; WAL; one DB file per company |
| Core logic | TypeScript, **zero runtime dependencies** | Runs in Node directly (type stripping) → testable everywhere |
| UI | React 19 + plain CSS design system | Bundled by Vite; no CSS framework |
| Main/preload bundling | esbuild (scripts/build.mjs) | CJS output in `out/` (main, core worker, preload) |
| Core host | `node:worker_threads` worker in the main process | `src/main/core-worker.ts`; main talks to it through `core-proxy.ts` (same `Runtime` interface) |
| Tests | `node:test` + `node:assert/strict` | `npm test` |
| Installer | electron-builder → NSIS (choose install dir) | Built on GitHub Actions `windows-latest` |

**Hard rule: `src/core/**` and `src/shared/**` import only `node:*` builtins and each other.** No npm packages.
The renderer may import `react`, `react-dom`, `qrcode` and nothing else. Do not add dependencies.

### Dev-container constraints (important for agents)
npm is not reachable in the development container, so `node_modules` only has `@types/node`.
What you **can** run locally:

```bash
tsc -p tsconfig.core.json            # typecheck src/core + src/shared (global tsc 6)
tsc -p tsconfig.web.offline.json     # typecheck renderer against types/offline React shims
tsc -p tsconfig.node.offline.json    # typecheck main/preload against types/offline Electron shim
node --test "src/**/*.test.ts"       # run all tests (Node 22 strips types natively)
node --test "src/core/modules/gst/**/*.test.ts"   # one module's tests (folder paths do not work; use a glob)
```

`types/offline/*.d.ts` are faithful subsets of `@types/react` 19, `react-dom`, `qrcode` and Electron's types.
They exist only so renderer/main code can be typechecked without npm; CI uses the real packages
(`npm run typecheck && npm run build`). Only use React/Electron APIs that exist in the real libraries; if a
real API is missing from a shim, add it to the shim with its exact upstream signature (never loosen to `any`).
Rendering/bundling cannot be run locally — write UI code with extra care.

TypeScript rules forced by native type stripping (`erasableSyntaxOnly`, `verbatimModuleSyntax`):
- **Relative imports include the `.ts` / `.tsx` extension**: `import { x } from './money.ts'`.
- Type-only imports use `import type { … }`.
- No `enum`, no `namespace`, no constructor parameter properties (`constructor(private x)`), no `<T>` casts in .ts files — use `as T`.

---

## 2. Repository layout & ownership

```
src/
  shared/              Pure TS used by BOTH main and renderer (no node:*, no DOM)
    constants.ts       Voucher types, predefined groups/ledgers, permissions, roles
    settings.ts        CompanyFeatures (F11) / CompanyConfig (F12) + defaults
    api.ts             IPC wire types (ApiResult, ErrorCode, IPC channel names)
    money.ts format.ts words.ts dates.ts   Money/number/date helpers
    gst/               GST domain: states, UQC, GSTIN, place of supply, invoice tax engine
    types/             DTO types per module (<module>.ts)
  core/                Node-only business logic (node:sqlite, node:crypto, node:zlib, node:fs)
    db/                Db wrapper, migrations (index.ts + one file per module range), seed
    lib/               validate.ts (schemas), errors.ts, crypto, csv, xml, zip helpers
    api/               route.ts (contract), context.ts, dispatch.ts, routes.ts (aggregator)
    app/               App runtime: config/data dir, company registry, sessions, app routes
    modules/<module>/  routes.ts + services + tests — one folder per feature module
    testing/           Test fixtures (temp company, sample masters, voucher builders)
  main/                Electron main: windows, IPC bridge → core dispatch, dialogs, print/PDF, menu.
                       The core itself runs on a worker thread (core-worker.ts ↔ core-proxy.ts), never
                       on the main thread; it may import node:* only (no 'electron').
  preload/             contextBridge exposing window.bahi (typed, minimal)
  renderer/            React app
    app/               Shell, navigation stack, keyboard, registry.ts (ModuleDef contract), API client
    ui/                Design-system components
    styles/            tokens.css, base.css, components.css
    modules/<module>/  index.ts (ModuleDef) + screens/components for that module
scripts/               build.mjs, dev.mjs
build/                 Installer resources (icon, NSIS include)
e2e/                   Playwright Electron specs (smoke + first-day flow; CI, docs/BUILD.md §5.1)
```

Feature modules (same name on both sides): `company security accounts inventory vouchers reports stock
outstanding gst gstrecon banking data dashboard print`.

**Ownership rule:** a module's agent edits only its own `src/core/modules/<m>/`, `src/renderer/modules/<m>/`,
`src/shared/types/<m>.ts`, and its pre-assigned migration file `src/core/db/migrations/<NNN>_<m>.ts`.
Shared contract files (`route.ts`, `context.ts`, `db.ts`, `validate.ts`, `constants.ts`, `settings.ts`,
`registry.ts`, aggregators) are **extend-only**; if you need a contract change, make the smallest additive
change and call it out in your final report.

---

## 3. Data conventions (non-negotiable)

| Concept | Representation |
|---|---|
| Money | **integer paise** everywhere in DB and core (`number`, safe-integer). `₹1,234.50` → `123450` |
| Debit/Credit | Signed amounts: **Debit = positive, Credit = negative**. Every voucher's ledger entries sum to **exactly 0** |
| Quantity | `REAL` in the item's base unit; inward `+`, outward `-` in `inventory_entries.qty` |
| Rate | `REAL` rupees per base unit, exclusive of tax |
| Line amount | `round(qty × rate × (1 − disc%/100) × 100)` paise — use `shared/money.ts` helpers, never ad-hoc math |
| Dates | `'YYYY-MM-DD'` strings; financial year April→March (`shared/dates.ts`) |
| Timestamps | ISO-8601 UTC strings (`new Date().toISOString()`) |
| IDs | INTEGER PK + `guid` (crypto.randomUUID) on every master and voucher |
| DB naming | snake_case tables/columns. DTOs crossing IPC are camelCase objects (map rows in services) |
| Percentages | REAL percent (18 means 18%) |
| Booleans | INTEGER 0/1 in DB, `boolean` in DTOs |

Rounding: `Math.round` half-away-from-zero for paise via `roundPaise()` in `shared/money.ts`.
Never store floating rupees. Never use `toFixed` for arithmetic.

**Denormalisation:** `ledger_entries`, `inventory_entries`, `bill_allocations`, `cost_allocations`, `gst_lines`
carry the voucher `date` and `affects_books`/`affects_stock` so reports never join back to `vouchers`.
They are rewritten (delete + insert) every time a voucher is saved.

**Books filter** — a voucher counts in the books when
`affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`. Optional, cancelled, memorandum and order-type
vouchers have `affects_books = 0`.

**Opening balances** live on `ledgers.opening_balance` (as at `company.books_from`) plus `opening_bills`
for bill-wise detail, and `stock_openings` for inventory.

---

## 4. Backend: API routes

Every capability is a route (`src/core/api/route.ts`):

```ts
export const accountsRoutes = {
  'accounts.ledger.save': companyRoute({
    access: 'masters.create',               // Permission | 'authenticated' | 'public' (app scope only)
    input: LedgerSaveInput,                  // v.object({...}) from core/lib/validate.ts
    handler: (ctx, input) => saveLedger(ctx, input),
  }),
} satisfies RouteMap;
```

- The dispatcher validates input, enforces access, opens a **transaction for company-scope routes** (unless
  `transactional: false` for heavy read-only reports), maps thrown `AppError`s to `{ ok: false, error }`.
- **Unknown input keys**: in production a key the schema does not declare is dropped; under `node --test`
  (the whole suite) and in development (`BAHI_STRICT_INPUT=1`, scripts/dev.mjs) it is a `VALIDATION`
  error ("Unknown field …", with a did-you-mean hint), so a misspelt key fails in tests instead of being
  silently ignored. Filter inputs whose typo would widen the result (e.g. the edit-log list/export) use
  `v.strictObject` and reject unknown keys in production too. Send only declared keys from the renderer.
- Route names: `'<module>.<entity>.<action>'`; actions: `list`, `get`, `save` (create/alter by presence of `id`),
  `delete`, plus domain verbs (`vouchers.cancel`, `gst.gstr1.export`).
- Handlers return plain JSON-safe data (objects, arrays, strings, numbers, booleans, null, `Uint8Array`).
- Services take `(ctx: CompanyCtx, …)` or `(db: Db, …)` and are directly unit-testable.
- Throw `AppError` (`errors.ts`) with a user-readable message: `rule('Voucher is not balanced: Dr ≠ Cr')`.
  Messages are shown to end users — write them for an accountant, not a developer.
- **Audit:** every create/alter/delete/cancel of a master, voucher, user or setting calls
  `ctx.audit({ action, entityType, entityId, entityGuid, entityLabel, before, after })` inside the same transaction.
- **Period lock:** voucher create/alter/delete must reject dates `<= config.lockedUpTo` with `LOCKED`.
- Lists accept `{ search?, limit?, offset? }` where relevant and return `{ rows, total }` for paging.

### Contexts (`core/api/context.ts`)
`ctx.db` (Db), `ctx.session` (user, permissions), `ctx.company` (open company info), `ctx.clock`
(`now()`, `today()`), `ctx.audit(entry)`, `ctx.app` (dataDir, version, log).

### Db (`core/db/db.ts`)
`db.get/all/run/value(sql, params)`, `db.iterate(sql, params)` (one row at a time, for large exports),
`db.transaction(fn)` (nestable, synchronous), `db.exec(ddl)`.
Use `:name` placeholders with an object. Always parameterise — **never interpolate user input into SQL**.

---

## 5. Accounting & posting rules

- Voucher save is atomic: header + all child rows + numbering + audit in one transaction.
- `Σ ledger_entries.amount = 0` per voucher, enforced in the posting service; zero-value vouchers are rejected
  unless the voucher type allows it.
- Payment: at least one Cr to Cash/Bank. Receipt: at least one Dr to Cash/Bank. Contra: only Cash/Bank
  ledgers (incl. Bank OD). Sales/Purchase/Credit/Debit Note: party (or cash) + sales/purchase ledger lines.
- Sales invoice posting (item or accounting mode):
  `Dr Party (grand total) ; Cr Sales ledger(s) (taxable) ; Cr Output CGST/SGST or IGST (+cess) ; ±Round Off`.
  Purchase is the mirror (`Input` tax ledgers). Credit Note mirrors Sales; Debit Note mirrors Purchase.
  Reverse-charge purchases: tax is **not** payable to the supplier — Dr Input tax / Cr RCM liability.
- Bill-wise: for ledgers with `maintain_bill_wise`, each ledger entry's bill allocations must sum to the entry amount.
  Sales/Purchase create a `new` reference named after the voucher number (purchase: supplier invoice no.).
- Voucher numbering: per voucher type, restart yearly by default; `prefix + zero-padded number + suffix`.
  Numbers are allocated inside the save transaction (no gaps on rollback).
- Cancelling keeps the voucher (number preserved, amounts zeroed in books via `affects_books = 0`); deleting
  removes it. Both are audited.
- Stock: sales/delivery note/rejection out/debit note(with items, to a supplier) = outward; purchase/receipt note/rejection in/
  credit note(with items) = inward. An invoice line tracked against a delivery/receipt note does not move stock again.
  A debit note to a customer (price revision, CGST s.34(3)) is value-only: its item lines never move stock.
- Closing stock (integrated inventory): valued by item costing method (default weighted average) and shown in
  P&L and Balance Sheet (Current Assets › Stock-in-Hand).

## 6. GST rules (implemented in `src/shared/gst/`)

- Intra-state (supplier state = place of supply) → CGST + SGST (UTGST for UTs without legislature: 04, 26, 31, 35, 38).
  Inter-state, exports (POS 96), SEZ (always) → IGST.
- Inward from an SEZ unit: **goods** are imports (bill of entry; IGST paid at customs, not to the supplier;
  GSTR-3B 4(A)(1), GSTR-9 6E, GSTR-2B IMPGSEZ); **services** are B2B with IGST on the invoice (4(A)(5)).
- GSTR-3B 6.1 sets off against the period's ITC plus the credit brought forward from the previous return
  period (electronic credit ledger, chained from the books beginning).
- Place of supply defaults: consignee/ship-to state for goods, buyer state otherwise; overseas → 96.
- Rate resolution precedence: voucher-line override → stock item (effective-dated history) → stock group → sales/purchase ledger.
- Tax per invoice is computed per rate bucket and allocated back to lines (largest remainder) so line taxes sum exactly.
- Supply classification (`GstNature`) drives GSTR-1/3B tables: B2B, B2CL (inter-state B2C > ₹1,00,000), B2CS,
  EXPWP/EXPWOP, SEZWP/SEZWOP, DE, CDNR/CDNUR, nil/exempt/non-GST, RCM inward, imports.
- Composition dealers issue Bills of Supply (no tax). Unregistered companies charge no GST.
- `gst_lines` is the single source for every GST report. Reports never recompute tax from items.

## 7. Renderer (UI/UX contract)

Design goals: **fast for experts, obvious for beginners.** Keyboard-complete, mouse-friendly, dense but calm.

- **Navigation stack** like Tally: every screen is pushed on a stack; `Esc` pops (confirming if the form is dirty);
  breadcrumbs show the stack. `nav.push(screenId, params)`, `nav.replace`, `nav.pop`.
- **Gateway** (home) lists menu sections contributed by modules (`ModuleDef.menu`) + a dashboard panel.
- **Go To** (`Ctrl+G` / `Alt+G` / `Ctrl+K`) — fuzzy palette over screens, reports, masters and voucher numbers.
- Global hotkeys: `F2` working date, `Alt+F2` period, `F3` company, `F4` Contra, `F5` Payment, `F6` Receipt,
  `F7` Journal, `F8` Sales, `F9` Purchase, `Ctrl+F8` Credit Note, `Ctrl+F9` Debit Note, `Alt+C` create master
  from a picker, `Ctrl+A`/`Ctrl+S` accept/save, `Esc` back, `Alt+P` print, `Alt+E` export, `F11` features, `F12` configure.
- Forms: `Enter` advances to the next field (Tally behaviour), `Shift+Enter`/`Shift+Tab` goes back,
  `Ctrl+A` saves. Validation errors appear inline next to the field and focus the first invalid field.
  On push the shell focuses `[data-autofocus]` (else the first field / grid) — also after the screen
  finishes loading, unless the user already moved.
- Screen conventions — one meaning per key in every module (`CONVENTION_SHORTCUTS`, F1): `Alt+C` create,
  `Alt+A` alter, `Alt+D` delete (`Ctrl+D` also in master lists), `Ctrl+D` remove line (grids), `Alt+H` edit history, `Alt+N`/`Ctrl+N` insert line, `Alt+2` duplicate,
  `Alt+X` cancel voucher, `Alt+Enter` view, `Alt+M` open the report subject's master, `Alt+F1`
  detailed/condensed, `Ctrl+1…9` switch view/tab, `Ctrl+F` search box, `Alt+E` export, `Alt+P` print (`Ctrl+P` the highlighted voucher in the Day Book).
  Screens never bind the global keys (`reservedGlobalKeys()`), e.g. `Alt+F5` = Sales Order. Labels use
  Tally verbs ("Create …", "Alter", "Delete").
- Pickers (ledger/item/group selection) are type-ahead lists that show balances/stock and offer "+ Create"
  (`Alt+C`) inline.
- Amounts: right-aligned, tabular numerals, Indian grouping (`12,34,567.00`), Dr/Cr suffix in reports;
  negative values never shown with a bare minus in accounting reports — use Dr/Cr.
- Reports: period selector (`Alt+F2`), drill-down with `Enter`/double-click down to the voucher, `Esc` back up,
  export (`Alt+E`) to Excel/CSV/PDF, print (`Alt+P`). Excel, CSV, PDF and Print all need the `data.export`
  permission and are recorded in the edit log — enforced by the core (`data.export.table`,
  `data.export.audit`), never only in the UI.
- Hidden stacked screens do not refetch on invalidation; they refetch when shown again.
- Secured companies lock after the idle timeout: the workspace stays mounted, hidden behind a lock
  screen, and resumes (unsaved work included) when the same user logs in again.
- Use only components from `src/renderer/ui/` and tokens from `styles/tokens.css`; no inline colours.
  Light & dark themes; WCAG AA contrast; visible focus rings; every icon button has `aria-label`.
- Never render user data as HTML (`dangerouslySetInnerHTML` is banned).

## 8. Security

- Renderer is untrusted: it reaches main only through `window.bahi.api(route, input)` and
  `window.bahi.native(action, payload)`; main validates everything again.
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
  CSP `default-src 'self'`, deny `window.open`/navigation to external origins (open https links in the OS
  browser after confirmation), no `remote`, no `webview`.
- File system access only via main-process dialogs; renderer never supplies arbitrary paths to read/write
  without a user-chosen dialog result token. Core routes that take a path authorise it with
  `core/lib/paths.ts` (data folder, configured backup folder, or a dialog choice; UNC refused otherwise).
- Passwords: `scrypt` (N=2^15, r=8, p=1, 16-byte salt) with constant-time compare; lockout after 5 failures
  for 5 minutes; optional session idle timeout.
- Edit log: append-only (`audit_log` triggers) and SHA-256 hash-chained; verifiable from the UI. Its latest
  head is check-pointed outside the company file (HMAC-signed, userData + backup manifests) so a rewritten or
  truncated log is detected — see docs/SECURITY.md §4.1 for what is and is not detected. Imports audit every record.
- Backups: AES-256-GCM with scrypt-derived key when a password is given; integrity-checked on restore.
- Logs never contain passwords, full GSTIN/PAN lists or voucher payloads.

## 9. Testing

- Tests live next to code: `src/core/modules/<m>/<thing>.test.ts`, `src/shared/**/<thing>.test.ts`.
- Use `src/core/testing/fixtures.ts` to create an in-memory company with seeded masters.
- Every service with business rules gets tests for the happy path **and** the rules it enforces.
- GST and posting tests use hand-verified numbers (write the arithmetic in a comment).

## 10. Definition of done for any module

1. `tsc -p tsconfig.core.json` passes with zero errors in your files.
2. `node --test` passes for your module.
3. Routes are registered in your module's `routes.ts`; screens/menu in your module's `index.ts`.
4. Mutations are audited, permission-guarded, period-lock aware.
5. UI follows §7 and uses the design system; every screen reachable from the Gateway or Go To.
