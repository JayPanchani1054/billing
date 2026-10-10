# Pevqori — Architecture & Engineering Contract

Pevqori is an offline-first, keyboard-first accounting, GST invoicing and inventory system for Indian
businesses, delivered as a Windows desktop app (Electron). Functionally it follows the model of
conventional Indian accounting software (Gateway → masters → vouchers → reports with drill-down) with a
modern, calmer UI.

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
*2.0 amendment:* the main process may bundle **`electron-updater`** (in-app updates, `src/main/updates/`) — only
into its own lazily loaded entry `out/main/updater.cjs` (`src/main/updates/entry.ts`, loaded by a computed-path
require on the first update check; never part of `out/main/index.cjs`, checked by `build.mjs` and
`build-scripts.test.ts`). The renderer dependency allowlist is unchanged.

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

`types/offline/*.d.ts` are faithful subsets of `@types/react` 19, `react-dom`, `qrcode`, Electron's and
(2.0, main process only) `electron-updater`'s types.
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
  preload/             contextBridge exposing window.pevqori (typed, minimal)
  renderer/            React app
    app/               Shell, navigation stack, keyboard, registry.ts (ModuleDef contract), API client
    ui/                Design-system components
    styles/            tokens.css, base.css, components.css
    modules/<module>/  index.ts (ModuleDef) + screens/components for that module
scripts/               build.mjs, dev.mjs
build/                 Installer resources (icon, NSIS include)
e2e/                   Playwright Electron specs (smoke, first day, every-screen sweep, parity flows; CI, docs/BUILD.md §5.1)
```

Feature modules (same name on both sides): `company security accounts inventory vouchers reports stock
outstanding gst gstrecon banking data dashboard print documents tds mfg forex cheques pos attachments`
(the parity-wave modules have their own sections below; the cheques module's renderer lives in
`src/renderer/modules/cheques`, its core in `src/core/modules/cheques`).

**Ownership rule:** a module's agent edits only its own `src/core/modules/<m>/`, `src/renderer/modules/<m>/`,
`src/shared/types/<m>.ts`, and its pre-assigned migration file `src/core/db/migrations/<NNN>_<m>.ts`.
Shared contract files (`route.ts`, `context.ts`, `db.ts`, `validate.ts`, `constants.ts`, `settings.ts`,
`registry.ts`, aggregators) are **extend-only**; if you need a contract change, make the smallest additive
change and call it out in your final report.

**Naming rule:** the product is called Pevqori everywhere (window title, `window.pevqori`, `pevqori:*` IPC
channels, `PEVQORI_*` environment variables, `.pvqbak` backups, `pevqori.log`). Names and formats written by
builds before the rename are spelled in exactly two modules and only read, never written:
`src/core/lib/legacyNames.ts` (core: backup extension, container and envelope magic, audit-anchor prefix) and
`src/main/legacyUserData.ts` (shell: the earlier settings folder, migrated once on the first launch). Element
names fixed by the XML interchange format live as named constants in `src/core/modules/data/xmlFormat.ts`
(with the values earlier builds stored in `vouchers.meta` of imported vouchers, re-exported by
`legacyNames.ts`) and are used through those constants everywhere else, tests included. Code, UI text and docs never name
other accounting products — describe the behaviour instead ("keyboard-first", "your previous accounting
program"). `src/core/testing/brand.test.ts` enforces this rule on every file git knows about (file names
included, and spelled-around variants such as split strings, escapes or base64).

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
  (the whole suite) and in development (`PEVQORI_STRICT_INPUT=1`, scripts/dev.mjs) it is a `VALIDATION`
  error ("Unknown field …", with a did-you-mean hint), so a misspelt key fails in tests instead of being
  silently ignored. Filter inputs whose typo would widen the result (e.g. the edit-log list/export) use
  `v.strictObject` and reject unknown keys in production too. Send only declared keys from the renderer.
- Route names: `'<module>.<entity>.<action>'`; actions: `list`, `get`, `save` (create/alter by presence of `id`),
  `delete`, plus domain verbs (`vouchers.cancel`, `gst.gstr1.json`).
- Handlers return plain JSON-safe data (objects, arrays, strings, numbers, booleans, null, `Uint8Array`).
- Services take `(ctx: CompanyCtx, …)` or `(db: Db, …)` and are directly unit-testable.
- Throw `AppError` (`errors.ts`) with a user-readable message: `rule('Voucher is not balanced: Dr ≠ Cr')`.
  Messages are shown to end users — write them for an accountant, not a developer.
- **Audit:** every create/alter/delete/cancel of a master, voucher, user or setting calls
  `ctx.audit({ action, entityType, entityId, entityGuid, entityLabel, before, after })` inside the same transaction.
- **Period lock:** voucher create/alter/delete must reject dates `<= config.lockedUpTo` with `LOCKED`.
  Bank dates too (banking `common.ts assertBankDateChangeAllowed`): setting, moving or clearing a bank
  date whose old or new value is in the locked period needs `period.lock` (Owners always), else `LOCKED`
  — including a voucher delete / cancel / alter that would clear one (`vouchers/service.ts`).
- **Busy company:** a `CONFLICT` that only means "another long task holds the company" (an exclusive
  import job, or another async task in flight) carries `details { reason: 'busy', retryable: true }`
  (`api/jobs.ts BUSY_DETAILS`); the renderer offers "Wait and retry" (`app/lib/apiErrors.ts`
  `isBusyConflict` / `retryWhileBusy`).
- Lists accept `{ search?, limit?, offset? }` where relevant and return `{ rows, total }` for paging.
- Graph data (2.1) is read-only and additive: `reports.profitTrend` (`{ from, to, scenarioId? }`,
  reports.financial) gives the P&L's figures month by month, Σ months = the P&L exactly (README §5a of
  core/modules/reports); `reports.monthlySummary` gained `subject.isNominal`. Every other graph reads
  data its screen already fetches.

### Contexts (`core/api/context.ts`)
`ctx.db` (Db), `ctx.session` (user, permissions), `ctx.company` (open company info), `ctx.clock`
(`now()`, `today()`), `ctx.audit(entry)`, `ctx.app` (dataDir, version, log).

### Db (`core/db/db.ts`)
`db.get/all/run/value(sql, params)`, `db.iterate(sql, params)` (one row at a time, for large exports),
`db.transaction(fn)` (nestable, synchronous), `db.exec(ddl)`, `db.dataRevision()` (cache key that changes
on any write or another connection's commit; null inside a transaction — read-model memos key on it).
Rows are ordinary plain objects (built from SQLite array rows, no per-row copy).
Optional filters are separate constant statements, never `(:flag = 0 OR col IN …)` (that hides the
index from the planner); migrations are driven by `PRAGMA user_version`, so a follow-up migration is
numbered above the highest version already shipped (see `migrations/index.ts`).
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
  A debit note to a customer (price revision, CGST s.34(3)) is value-only: its item lines never move stock
  — also when brought in by the XML data import (the import log lists each such note, because the source
  program may have moved stock for it).
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

- **Navigation stack**: every screen is pushed on a stack; `Esc` pops (confirming if the form is dirty);
  breadcrumbs show the stack. `nav.push(screenId, params)`, `nav.replace`, `nav.pop`.
- **Home** (screen `app.gateway`; nav landmark still named "Gateway menu", h1 and breadcrumb root "Home")
  lists what the user may open in two views — **Essentials** (`app/lib/essentials.ts`: one central list of
  ≈23 everyday entries in five groups, matched against All menus by menu label or `vouchers.entry`
  base type, never gating anything itself, letters assigned over the subset) and **All menus** (the menu
  sections contributed by modules, `ModuleDef.menu`, exactly the 1.0 Gateway) — switched with
  **Ctrl+1 / Ctrl+2**, plus notices and the dashboard panel (a greeting for users without it).
- **Per-user layout preferences** (`app/lib/uiPrefs.ts`, `localStorage['pevqori.ui'] = { v: 1, homeView,
  shortcutBar, upgraded, tryHomeDismissed }`): decided once per profile from the first `app.state` — a
  profile that already lists companies is an upgraded 1.0 profile (All menus + shortcut bar, a one-time
  "Try the simpler Home" card), otherwise a new user (Essentials, no shortcut bar). Storage failures fall
  back to those defaults for the session.
- **Screen bar and command bar**: the breadcrumb row hosts the top screen's **command bar**
  (`ui/CommandBar.tsx`, rule in `app/lib/commandBar.ts`): the `primary` action, up to 3 / 2 / 1 buttons by
  width (first actions with `prominent: true`, then Alter, Print, Share, Export, More details, Create), and
  **More ▾** with every other action and its key, then the globals F11 / F12 (when the user may open them) / F1. It never registers
  keys — `useScreenActions` does — so showing or hiding a button never changes a key. The 1.0 right rail
  is the optional **shortcut bar** (`aria-label="Shortcut bar"`, preference `shortcutBar`).
  `ActionRailItem.prominent` (and any later action field) is written **after `onClick`** in object
  literals, never straight after `label` (`keyConventions.test.ts` reads `key, label, onClick…`;
  `commandBar.test.ts` guards that scan).
- **Top bar**: company button (Switch company F3, Company details), date / period chips, the Go To search
  box, **Create ▾** (`app/lib/createMenu.ts`: the everyday vouchers with their keys, each shown only when
  its F-key would open it — the same check —, Customer, Supplier, Item, Other voucher… F10; what the user
  may not create is not listed; no new key), ⚙ Settings (`company.settings`, when registered), ?
  (F1) and the user menu (theme, density, Home view, shortcut bar, *Appearance…* = `app/AppearancePanel.tsx`,
  About, Lock, Log out). **Status bar**: hint · save state (data folder in its tooltip) · version.
- **Go To** (`Ctrl+G` / `Alt+G` / `Ctrl+K`) — fuzzy palette over screens, reports, masters and voucher numbers.
- Global hotkeys (`GLOBAL_SHORTCUTS` in `app/lib/shortcuts.ts`, the single source for the F1 overlay and
  the User Guide's keyboard reference, which `app/lib/userGuide.test.ts` checks): `F2` working date,
  `Alt+F2` period, `F3` company, `F4` Contra, `F5` Payment, `F6` Receipt, `F7` Journal, `F8` Sales, `F9`
  Purchase, `Ctrl+F8` Credit Note, `Ctrl+F9` Debit Note, the other predefined voucher keys (`Alt+F5` …,
  `Ctrl+F10` Memorandum), `F10` other vouchers, `F11` features, `F12` configure, `F1`/`Ctrl+H` keyboard
  help, `Ctrl+Q` quit; `Esc` back. Conventions every screen follows (not global): `Alt+C` create master
  from a picker, `Ctrl+A` accept/save, `Alt+P` print, `Alt+E` export. **`Ctrl+S` is an alias of `Ctrl+A`**
  (2.0), implemented once in the hotkey layer (`ui/lib/hotkeyRegistry.ts`): when no eligible binding
  has Ctrl+S of its own, the key goes to the Ctrl+A bindings with the same layering (a dialog's Ctrl+A
  while a dialog is open); where nothing binds Ctrl+A it does nothing. Screens never bind Ctrl+S. A Yes/No
  confirmation (`ui/ConfirmDialog.tsx`, keys in `ui/lib/confirmKeys.ts`) takes Ctrl+S and does nothing: a
  save reflex must never answer "Discard unsaved changes?" or "Delete …?" (Ctrl+A / Y still confirm).
- Forms: `Enter` advances to the next field (the convention accountants expect), `Shift+Enter`/`Shift+Tab` goes back,
  `Ctrl+A` saves. Validation errors appear inline next to the field and focus the first invalid field.
  On push the shell focuses `[data-autofocus]` (else the first field / grid) — also after the screen
  finishes loading, unless the user already moved.
- Screen conventions — one meaning per key in every module (`CONVENTION_SHORTCUTS`, F1): `Alt+C` create,
  `Alt+A` alter, `Alt+D` delete (`Ctrl+D` also in master lists), `Ctrl+D` remove line (grids), `Alt+H` edit history, `Alt+N`/`Ctrl+N` insert line, `Alt+2` duplicate,
  `Alt+X` cancel voucher, `Alt+Enter` view, `Alt+M` open the report subject's master, `Alt+F1`
  detailed/condensed, `Ctrl+1…9` switch view/tab, `Ctrl+F` search box, `Alt+E` export, `Alt+P` print (`Ctrl+P` the highlighted voucher in the Day Book).
  Screens never bind the global keys (`reservedGlobalKeys()`), e.g. `Alt+F5` = Sales Order. Labels use
  the familiar accounting verbs ("Create …", "Alter", "Delete").
  A screen with nothing of a convention's kind (no voucher to cancel, nothing to share) may give that
  key a meaning of its own; every such use of `Alt+W` / `Alt+X` is named in USER_GUIDE §15.2, and
  `app/lib/userGuide.test.ts` fails on an undocumented one.
  A screen that other modules extend (voucher view + `voucherPanels`, voucher entry + its TDS / forex
  panels, ledger / item forms + attachments Alt+F) is one key space: no key twice (checked from source).
- Permissions in the UI: an action the role forbids is hidden; a view-only form keeps Save disabled with
  the reason (the permission's Users & Roles label) or leaves it out, and shows a "view only" notice; Export / Print stay visible, disabled with the permission they
  need. The core refuses regardless. F11 off ⇒ no menu item, Go To entry, voucher-panel key or Gateway
  notice of that feature.
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

## 7a. Visual language (2.0)

One calm visual language for every screen, defined once in `src/renderer/styles/tokens.css` and
`components.css` (details and the full token table: `src/renderer/ui/README.md` §2).

- **Themes.** Exactly one light block (`:root, [data-theme="light"]`) and one dark block
  (`[data-theme="dark"]`); tokens identical in both are declared once in `:root`. The user's
  `system` preference is resolved in JS (`ui/theme.ts` `applyTheme`, pure rule `resolveTheme(pref,
  osDark)`): `<html data-theme>` always holds `light` or `dark`, `data-theme-pref` the choice, and a
  `matchMedia` listener follows OS changes live. There is no `prefers-color-scheme` block in CSS.
  `index.html` keeps `data-theme="system"` only as a pre-bootstrap placeholder (base.css then lets
  the theme-matched native window colour show, so there is no flash).
- **Colour.** One interactive colour, `--brand` (indigo-600 light / indigo-400 dark, with
  `--on-brand` white / near-black): primary buttons, focus ring, selected-row bar, checked controls,
  the selected segmented item and links (`--text-link` is the brand indigo in both themes). Saffron
  (`--accent*`) only for the brand mark, the "not today" date flag and Get-started progress. Canvas `--surface-0`, cards and tables
  `--surface-1`. Status tones only on badges, banners and inline validation; money is never red
  for "negative" (Dr/Cr rule, §7).
- **Type** (Segoe UI Variable → Segoe UI → system): caption/small 12 · base 13 (tables) · body 14
  (forms) · subtitle 16/600 (section, panel, card titles) · title 20/600 (one h1 per screen) ·
  heading 24 (greeting, KPI figures). `--fs-11` is for key chips (and chart axis text, laid out
  for 11px) only; `--text-display` is retired (aliases 24). Numeric and right-aligned table cells use
  tabular figures. Classed lists lose markers through a zero-specificity reset; prose lists set
  their own `list-style`.
- **Shape and depth.** Radius: controls 6, cards/panels/tables 8, dialogs/drawers/menus/popovers
  12, chips full. Resting elevation only through roles: `--elev-card` (none; cards are flat with a
  1px `--border-subtle`), `--elev-popover` (menus, popovers, listboxes, tooltips, toasts),
  `--elev-dialog` (modals, drawers); interactive tiles may lift with `--shadow-1` on hover.
- **Spacing.** 4px base; new CSS uses 4/8/12/16/24/32. Density (comfortable/compact) only changes
  the density tokens.
- **Weight gates** (unit tests, no extra CI step): `styles/cssUsage.test.ts` fails on any class a
  stylesheet defines that renderer code never renders (runtime-built names need a declared prefix
  plus the code that builds it); `styles/cssBudget.test.ts` caps renderer CSS source (bytes as
  committed) at 180 KB in total, `components.css` at 67.5 KB and `tokens.css` at 16 KB (1.0: 206 /
  76 / 24 KB; 2.0 measured 179.75 / 65.8 / 15.6 KB — the file ceilings are that + 2 %, the total stays
  at the 180 KB gate). Raising a ceiling is a reviewed decision, never a fix for a heavier stylesheet.
  2.1 splits the global stylesheets by owner (rules moved unchanged): `styles/index.css` imports
  tokens, base, components, charts (`.bx-chart*`, `.bx-sparkline*`, `.bx-kpi*`), shell (frame, page
  header, screen layout), report (`.bx-report*`) and gateway (Home menu, Go To, F1 overlay,
  `--gateway-menu-w`); the vouchers module loads `vouchers-entry.css` + `vouchers-view.css`, the GST
  module `gst-returns.css` + `gst.css`. Every file counts toward the same 180 KB total.
  `ui/lib/contrast.test.ts` keeps every text pair ≥ 4.5:1 and every control/focus/icon pair ≥ 3:1
  in both themes and asserts the system block stays gone.

## 8. Security

- Renderer is untrusted: it reaches main only through `window.pevqori.api(route, input)` and
  `window.pevqori.native(action, payload)`; main validates everything again.
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
  CSP `default-src 'self'`, deny `window.open`/navigation to external origins (open https links in the OS
  browser after confirmation), no `remote`, no `webview`.
- File system access only via main-process dialogs; renderer never supplies arbitrary paths to read/write
  without a user-chosen dialog result token. Core routes that take a path authorise it with
  `core/lib/paths.ts` (data folder, configured backup folder, or a dialog choice; UNC refused otherwise).
  The configured (F12) backup folder counts — for writing, listing and as a trusted root — only when it
  is approved for that company on this installation (`AppRuntime.backupFolders`, `<userData>`
  `backup-folders.json`) or lies in the data folder; otherwise backups use the default folder until the
  user confirms it in the folder dialog (`data.backup.approveFolder`).
- Passwords: `scrypt` (N=2^15, r=8, p=1, 16-byte salt) with constant-time compare; lockout after 5 failures
  for 5 minutes; optional session idle timeout.
- Edit log: append-only (`audit_log` triggers) and SHA-256 hash-chained; verifiable from the UI. Its latest
  head is check-pointed outside the company file (HMAC-signed, userData + backup manifests) so a rewritten or
  truncated log is detected — see docs/SECURITY.md §4.1 for what is and is not detected. Imports audit every record.
- Backups: AES-256-GCM with scrypt-derived key when a password is given; integrity-checked on restore.
- Logs never contain passwords, full GSTIN/PAN lists or voucher payloads.
- **Network (2.0 updates):** the app session still cancels every non-app request. The only code that may reach
  the network is the in-app updater, in the main process, from its own session partition whose requests
  (redirects included) must pass `src/main/updates/policy.ts` `isAllowedUpdateUrl` (https, the project's
  GitHub Releases hosts only), and only when the user checks / downloads or weekly checks are on and due.
  Updates are off for test runs, unpackaged builds, a broken or `off` machine policy file
  (`%ProgramData%\Pevqori\policy.json`) and `PEVQORI_UPDATES=off`. The renderer can never pass a URL, path or
  version (NativeActions `updates.*`). docs/SECURITY.md §3.11.
- **CSV / Excel formula injection** (OWASP): one rule for every export, `src/shared/csvSafe.ts` — a text
  cell starting with `= + - @ TAB CR` is prefixed with `'` unless it is exactly a plain number
  ("-1250.50", "-1,23,456.00" stay numbers). Core `lib/csv.ts` `toCsv` applies it by default (TDS return
  CSVs, ITC-04 / CMP-08 / GSTR-4 files, e-payment files, edit log, reconciliation, data exports), as do
  `data.export.table` and the renderer's `exportFormat.ts`; in `.xlsx` (`lib/xlsx.ts`) text is never a
  formula and such cells also get the `quotePrefix` style. Never hand-build CSV text.
- **New routes** declare a real permission (`authenticated` only where the service checks the owner's
  view permission, e.g. attachment reads); report / list filters with optional narrowing keys use
  `v.strictObject`; anything main opens with the OS (`shell.openPath`) is a file main wrote itself into
  a folder it chose, reached without following links, after re-checking it (docs/SECURITY.md §4.0,
  `core/api/parity-security.test.ts`).

## 9. Testing

- Tests live next to code: `src/core/modules/<m>/<thing>.test.ts`, `src/shared/**/<thing>.test.ts`.
- Use `src/core/testing/fixtures.ts` to create an in-memory company with seeded masters.
- Every service with business rules gets tests for the happy path **and** the rules it enforces.
- GST and posting tests use hand-verified numbers (write the arithmetic in a comment).
- Performance regressions are tested by the SQL a path runs rather than by wall time: the app never runs
  ANALYZE, so SQLite's plans depend on the schema alone and a plan checked on a test company is the plan
  of a 60,000-voucher one. `src/core/testing/sqlPlans.ts` records a Db's statements (`recordSql`) and
  checks each plan (`planProblems`: no scan of a table that grows with the books — including the
  foreign-key look-ups a DELETE's plan lists — and a `voucher_id = :x` statement looks that voucher
  up). `vouchers/perf-hooks.test.ts` runs every voucher hook on a 60,000-voucher company with every
  feature on (statements and plans per save / alter / cancel / delete, stock replays, report and
  drill-down statement counts; wall times logged with generous bounds — targets: save ≤ 50 ms p95,
  reports ≤ 1 s cold, drill-downs ≤ 150 ms). A voucher hook must touch only the rows of its voucher
  and of the party / bank / item / period it needs (indexes for that in migration 241).
- Cross-module tie-outs run through `runtime.dispatch` only (`src/core/testing/e2e/`): `business-year.test.ts`
  (a trading year) and `all-features-year.test.ts` (a year with every F11 feature on — `allFeatures.ts`:
  GST with advances / RCM / set-off + challans, TDS / TCS with challans and note reversals, forex export +
  realisation + revaluation, BOM manufacturing + job work, POS split tender / returns / credit, quotation →
  invoice, recurring rent, cheques + statement + BRS, scenario, budget, attachment — plus a composition
  dealer). They assert that the trial balance, every ledger's own report, cash / bank books, P&L, Balance
  Sheet, stock summary / valuation / godowns, GSTR-1 / 3B (+ their JSON files) / 9, ITC register, electronic
  ledgers ↔ Output / Input tax ledgers, TDS / TCS reports and statements, outstanding (INR and currency),
  cheque register ↔ BRS, dashboard, POS day-end and production register agree; that an XML data export
  imported into an empty company reproduces the trial balance, stock summary and GSTR-1 / 3B of every month
  (Table 11 included); and that a backup restored as a new company reproduces the books, stock, GST, TDS /
  TCS, outstanding, forex, BRS, cheque, POS, production and dashboard figures and the attachment. A
  disagreement is fixed where it arises, never in the test.

## 9a. Performance budget

Weight and speed are measured on a finished build (`npm run build` → `out/`), never by building in a test.

- **Marks** (`src/renderer/app/lib/perfMarks.ts`, User Timing API, each set once per renderer load):
  `pevqori:boot` in `main.tsx` once the entry bundle has been evaluated, just before React renders;
  `pevqori:first-screen` in `App.tsx` once the first start screen the user can act on (normally the company
  list; never the splash) has been committed; `pevqori:shell-ready` in `App.tsx` the first time the workspace
  mounts (later company switches and locks never move it); the measure `pevqori:startup` from boot to
  shell-ready. `App.tsx` sets them through `markPhase(app.phase)`. Nothing in the app reads them.
- **Size report** — `node scripts/size-report.mjs [--out file] [--json] [--dir out] [--budget]` (node:* only)
  lists `out/renderer/assets/*` (no source maps), `out/main/*.cjs` and `out/preload/*.cjs` with raw and gzip
  (level 9) bytes and totals: **initial JS** = the entry `<script type="module">` plus every
  `<link rel="modulepreload">` of the built `index.html` (what must be fetched and evaluated before the first
  screen; lazy chunks count only in the JS total), initial CSS, renderer JS / CSS totals, main, preload.
  `--out` writes the JSON; `--budget` compares the sizes with the budget (exit 1 only when it is enforced).
- **Timings** — `e2e/perf.spec.ts` (runs with the other Playwright specs in CI, Ubuntu and Windows): launches the
  app twice on the same folders (`launchApp(…, { reuse, trace: false })`, `closeApp(…, { keepFolders: true })`
  in `e2e/support.ts`; no trace — tracing slows the app). The first run creates the company; the second is timed.
  Every number is taken inside the page (the app's marks, the key event's `timeStamp`, a `MutationObserver` for
  the result), so the Playwright round trip is not in it:
  - `startupMs` = (boot → first-screen) + (Enter on the company list → shell-ready): the driver's own wait at the
    list is left out (`bootToShellReadyRawMs` keeps the raw mark difference); `launchMs` adds navigation start →
    boot (HTML, bundle download, parse and evaluation — what lazy screens reduce);
  - screen open = key press → visible `h1` of the screen for F8 (Sales), Day Book, Balance Sheet, Receivables
    and GSTR-1 (the last four by Go To and Enter on the item, once its search has settled): `screenOpenMs` (first
    open per screen), `screenOpenP95Ms` (nearest-rank p95 of those first opens) and warm re-opens
    (`screenOpenWarm`, p50 / p95). The `h1` is drawn while the screen still loads its data, so the spec also
    reports `screenReadyMs`: key press → the screen with no skeleton or `aria-busy` region left (first opens; a
    screen that has not settled within 15 s is left out) — what a lazy screen's loading fallback must not hide.
  The spec attaches `perf-report.json` to the Playwright report and prints it as one `[perf] report {…}` line
  in the job log (the HTML report is uploaded only when a job fails), next to the size table and the budget verdict.
- **Budget** — `build/perf-budget.json` `{ enforce, baseline, ceilings }`, checked by `budgetProblems()` in
  `src/main/size-report.test.ts`. `ceilings`: `initialJsRatio` (initial JS ≤ ratio × baseline), `startupRatio`
  (`startupMs` and `launchMs` ≤ ratio × baseline of the **same platform**), `screenOpenSlackMs` (each first open
  and the p95 ≤ baseline + slack; warn-only while `screenOpenWarnOnly`, CI runners are noisy; `screenReadyMs`
  per screen ≤ baseline + the same slack, always warn-only — it includes the API call),
  `rendererJsMaxBytes` / `rendererCssMaxBytes` (absolute, null = off). With `enforce: false` the spec only
  reports; with `enforce: true` a failed ceiling fails it (warn-only ones become Playwright annotations).
  Timing ceilings are compared only against the baseline of the platform the run is on.
- **Capturing the baseline** — from the CI run of the commit to measure, save the log of each e2e job (`ubuntu-latest`, `windows-latest`) — the whole log, the copied
  `[perf] report {…}` line, or a downloaded `perf-report.json` all work (in a log, the last report wins) — then
  `node scripts/size-report.mjs --baseline linux.log win32.log [--from "CI run <id> @ <sha>"]` prints the
  `baseline` block (sizes from the Linux report — the gate is a ratio and the platforms' bundles differ by a
  few bytes at most — and timings per platform) to paste into `build/perf-budget.json` as a data-only commit. Raising a ceiling or the baseline is a
  reviewed decision, never a fix for a slower build. **The 1.0 baseline** cannot be read from any 2.0 commit (the
  harness was merged together with the lazy screens and the CSS diet): run CI once on 1.0 (`0ddf9b6`) with only
  the harness added — `scripts/size-report.mjs`, `build/perf-budget.json`, `app/lib/perfMarks.ts` (+ test),
  `src/main/size-report.test.ts`, the `markBoot()` call in `main.tsx` and the `markPhase(app.phase)` effect in
  `App.tsx`, `e2e/perf.spec.ts` and the additive `e2e/support.ts` options (1.0's own `e2e/flows.ts`) — and capture
  from that run's e2e logs.
- **Status — the 2.0.0 baseline is captured; the 1.0 one never was.** `build/perf-budget.json` `baseline` holds the
  2.0.0 numbers from the e2e logs of CI run 38078497623 (commit `87b0166`, both runners), captured with
  `scripts/size-report.mjs --baseline`: initial JS 1,504,563 B raw (453,609 gzip), start-up 112 ms (Linux) / 213 ms
  (Windows). 2.1 is measured against it (initial JS raw ≤ 1.02 × 2.0, start-up and screen open no slower);
  `enforce` is switched on by the 2.1 integration step. The 2.0 target "initial JS ≤ 0.55 × 1.0" stays
  **unverified** — no 1.0 baseline exists (a source-level estimate put 2.0 near 0.65–0.70 × 1.0). Never fill a
  baseline with estimated or invented numbers. The 2.0 look is recorded by the **UI snapshots** workflow run
  38093517573 (commit `6777482`, all 27 shots of `e2e/snapshots.spec.ts`) — the reference the 2.1 screens are
  compared with.
- **Lazy screens** (2.0) — the screens of `attachments`¹, `banking`, `cheques`, `data`, `documents`, `forex`, `gst`,
  `gstrecon`, `inventory`, `mfg`, `outstanding`, `pos`, `reports`, `security`, `stock` and `tds` are fetched the first
  time they open, so their code is not in the initial JS. A module's `index.ts` declares them with
  `lazyScreen()` (`src/renderer/app/lazyScreen.tsx`) instead of a static import, and registers them unchanged:
  `const BrsScreen = lazyScreen(() => import('./BrsScreen.tsx').then((m) => m.BrsScreen));` — the const keeps the
  export's name. `lazyScreen` returns a plain function component with `preload()`: the first render suspends on
  one cached import (React `use`), later renders are synchronous. `ScreenStack` (`app/nav.tsx`) wraps every
  full screen in `<Suspense>` inside its error boundary; the fallback is the screen skeleton, so a loading chunk
  looks like a first data load (`.bx-screen-skeleton`, `aria-busy="true"`). The fallback re-renders its
  `ScreenHost` as soon as the chunk has arrived, so the screen shows at once (left to Suspense's own retry, React
  would hold it back until 300 ms after the skeleton appeared). Esc works meanwhile; focus left on the hidden
  screen that opened this one (e.g. the Home button) is released so no key reaches it, and the initial focus is
  picked once the screen has rendered, exactly as for an eager screen (unless the user has moved focus to something
  else that is visible while it loaded — focus still where it was when the screen opened, such as the topbar search
  button Go To hands it back to, is taken as an eager screen takes it). Other keys typed during a cold load are not delivered to the screen. A chunk that fails
  to load shows the screen's error boundary; its "Try again" re-arms every failed load (`retryLazyScreens`) and
  imports the chunk again — if the engine keeps refusing that chunk (a damaged installation), only reinstalling
  helps. After `pevqori:shell-ready` the shell prefetches the lazy targets of Home ›
  Essentials (`PREFETCH_SCREENS`), one chunk per idle slot (`requestIdleCallback`, 2 s timeout), skipping
  screens the user cannot open. **Stay eager**: menus, Go To providers, dashboard cards, voucher panels, Home
  notices, print blocks and module CSS (still imported by `index.ts`); dialog screens (`presentation: 'dialog'`,
  which open over a live screen in the same frame as their key) and the screens sharing their file;
  `inventory.item.form`; the `accounts`, `company`, `dashboard`, `print` and `vouchers` modules; and any file
  other eager code imports statically (the bundler would keep it in the entry anyway — e.g. `data/RestoreFlow.tsx`,
  used by the company list). ¹`attachments` has no lazy screen for that reason (its screens share a file with
  its voucher panel, which the ledger and item forms import). **Adding a lazy screen**: give it its own file (or
  one only screens use), declare it with `lazyScreen` in the module's `index.ts`, and add its id to
  `PREFETCH_SCREENS` if it is an Essentials target. `src/renderer/app/lazyScreen.test.ts` enforces all of this,
  including that no lazily loaded file is reachable from `main.tsx` through static imports.
- Core paths are budgeted separately by the SQL they run (§9, `sqlPlans.ts`, `perf-hooks.test.ts`).

## 10. Definition of done for any module

1. `tsc -p tsconfig.core.json` passes with zero errors in your files.
2. `node --test` passes for your module.
3. Routes are registered in your module's `routes.ts`; screens/menu in your module's `index.ts`.
4. Mutations are audited, permission-guarded, period-lock aware.
5. UI follows §7 and uses the design system; every screen reachable from the Gateway or Go To.

## Documents module — quotations, recurring vouchers, bills pending, pre-close, scenarios, budgets

Owner: `src/core/modules/documents`, `src/renderer/modules/documents`, `src/shared/types/documents.ts`,
migrations **190–193** (block 190–199). Details: `src/core/modules/documents/README.md`.

- **Voucher base types** `quotation` and `proforma` (extend-only in `constants.ts`; also in
  `NON_ACCOUNTING_BASE_TYPES`). `base_type` has no CHECK in `001_init`, so no table rebuild. They are
  priced like invoices but post **no ledger entries, no stock, no gst_lines**, have their own number
  series (never the GST invoice series) and are never in GST returns. Print titles "Quotation" /
  "Proforma Invoice" (+ "This is not a tax invoice").
- **Voucher fields** (`VoucherInput`, extend-only): `validUntil` (quotation / proforma), `applicableUpto`
  (reversing journal), `convertedFromId` and `recurring {templateId, periodKey}` (create only). Checked and
  stored by the documents **voucher hook** (`vouchers/hooks.ts` extension point, `documents/hook.ts`)
  inside the voucher's own save transaction; links are made on create only and disappear with either
  voucher (CASCADE).
- **Idempotent recurring posting**: `recurring_runs` UNIQUE `(template_id, period_key)` + the hook's check
  in the save transaction; period key `YYYY-MM` (month-based) or `YYYY-MM-DD` (every N days). Each
  posting is an ordinary audited `saveVoucher`. Nothing posts without the user reviewing the due list.
  A template alter that moves the occurrences onto other dates (frequency / interval, an every-N-days
  start off the N-day grid, a quarterly / half-yearly / yearly start in another phase —
  `schedule.ts › scheduleShifts`) must start on or after the old schedule's next date, so a period already
  posted or skipped never falls due again under a new key.
- **Order closures** (`order_closures`) are subtracted by every pending-order reader (`stock/orders.ts`
  `orderPositions`, `vouchers/queries.ts` `trackingRefs`) through `documents/closures.ts`, dated as-of.
- **Scenarios**: reports routes TB / P&L / BS / Group Summary take `scenarioId`; `reports/scenario.ts`
  adds per-ledger deltas to `ledgerSums` (provisional vouchers of included types: memorandum, optional,
  reversing journals while `to ≤ applicable_upto`; minus regular vouchers of excluded types; or replaces
  the books when actuals are not included). The books filter itself is unchanged; ledger vouchers,
  outstanding, GST and the Day Book always show the books.
- **Budgets**: lines per group / ledger / cost centre, `net_transactions` (pro-rated by days to the report
  period) or `closing_balance`; signed paise Dr + / Cr −. `documents.budget.columns` gives the budget per
  report row key (`g:<id>`, `l:<id>`) and its basis (`basisByKey`) for the TB / P&L / BS budget column
  (`reports/overlay.tsx`); the TB variance compares a nett budget with Debit − Credit of the period and a
  closing-balance budget with the closing balance. Variance-report totals count each amount once (lines
  under a budgeted group, and cost-centre lines beside account lines, are `inTotal: false`).
- **Renderer extension points** (additive in `app/registry.ts`): `gatewayNotices` (recurring due on
  company open), `dashboardCards`, `voucherPanels` (links + Alt+V / Alt+O convert, Alt+S status, Alt+R make
  recurring, Alt+L pre-close on `vouchers.view`). Reports screens: Alt+S scenario, Alt+B budget column.
- **Permissions**: no new permission — quotations / recurring use `vouchers.*`, pre-close
  `vouchers.alter` (+ `vouchers.backdate`, period lock), scenarios / budgets `masters.*`, bills pending
  `reports.view`, budget variance `reports.financial`. Every mutation is audited.
- **Final wave**: an alteration is re-checked against its conversion link (a converted voucher never
  dated before its quotation / proforma, nor the quotation after it); budget-variance cost-centre
  actuals follow the scenario (`reports/scenario.ts › scenarioCostCentreAdjust`) — memorandum vouchers
  and reversing journals therefore store their cost-centre split (`affects_books = 0`).

## TDS / TCS module (`tds`) — deduction, payables, challans, quarterly return data

Core `src/core/modules/tds` (README there: tables, posting, legal assumptions), renderer
`src/renderer/modules/tds`, DTOs `src/shared/types/tds.ts`, pure statutory rules
`src/shared/tds/rules.ts`. Migrations **160** and **161** (block 160–169; 161 adds
`tds_lines.advance_adjusted` and a dated seed row).

- **Gating**: F11 `features.tds` (purchase / journal / payment) and `features.tcs` (sales). Off → the
  voucher hook is a no-op, screens/menus are hidden (`anyFeature`), routes refuse (BUSINESS_RULE).
- **Masters**: `tds_natures` + effective-dated `tds_nature_rates` (rates by deductee type, no-PAN rate,
  single / aggregate thresholds per FY or month, whole vs excess, base incl. GST); `tds_ledger_details`
  (applicable + nature on expense / sales ledgers; deductee type, non-resident, s.197 certificate,
  deductor TAN on parties). PAN stays in `ledgers.pan`. Duty ledgers `TDS Payable – <section>` /
  `TCS Payable` (Duties & Taxes) and `TDS Receivable` are created on demand and audited.
- **Posting**: only through the vouchers hook extension point (`vouchers/hooks.ts`, `tdsVoucherHook`):
  `prepare` creates duty ledgers, `adjust` computes and posts (Cr payable; party credit / bank credit
  reduced; TCS adds to the party debit and the invoice value), `write` rebuilds the derived
  `tds_lines` / `tds_challans` in the voucher's transaction with `date`, `affects_books`,
  `is_post_dated`; `clear` on alter / cancel / delete. `VoucherInput.tds` = `{ natureId?, overrides?:
  [{ natureId, amount, reason }], challan? }`; `VoucherPreview.tds` returns the computed lines. A credit
  typed by hand to the duty ledger is taken as the deduction (never posted twice); a later bill is set
  off against advances already taxed (`advance_adjusted`); a party whose details say "does not apply"
  is exempt; parties are debtors / creditors or ledgers given a deductee type (partners, loans).
- **Rules as data/functions**: deposit due dates (7th; TDS of March 30-Apr), interest s.201(1A) /
  s.206C(7) (per month or part, calendar months), statement due dates (Rule 31A / 31AA), s.234E fee —
  `shared/tds/rules.ts`, unit-tested. Rates / thresholds are seeded rows the user edits by adding dated
  rows (Income-tax Act 2025 references stored as a hint only).
- **Routes** `tds.*`: settings, natures, ledgers, computation, lines, outstanding, challans, exceptions,
  voucher, challan.suggest/get/save, return.data/export, statement.save, receivable, 26as.import.
- **Filed statements** (`tds/filed.ts`): once a quarter's 26Q / 27Q / 27EQ is marked filed, a voucher
  save that changes what it reported (deductee rows with tax / certificate, challans) is a `confirm`
  warning (correction statement), and deleting / cancelling such a voucher is refused (hook
  `beforeRemove`) — the TDS counterpart of the filed GSTR-1 rule.
  Reports are `transactional: false`. Permissions `tds.view` / `tds.manage` / `tds.file`
  (Accountant all three, Auditor `tds.view`; migration 160 grants them to existing companies' roles).
- **UI**: Gateway section "TDS / TCS"; voucher entry side panel + Alt+U dialog (override with reason,
  nature for advances); voucher view panel; Gateway notice for overdue deposits / statements.
- **Statement files**: CSV with every RPU deductee / challan field under plain headings — not the FVU
  file, not the RPU column order (documented in the module README).
- **Final wave** (migration 240 `tds_lines.bill_voucher_id`): a debit note (TDS) / credit note (TCS) in
  an invoice mode against a bill with tax reverses it in proportion (negative line carrying the bill,
  netted into the bill's deduction by the outstanding report, the statement and the challan suggestion
  — `netReversals`); a
  Journal `Dr party / Cr TDS Payable` with nothing applicable is the deduction on the bill its
  bill-wise "Against" names (in every report); 194T only for a `firm` deductor category; s.195 on a
  foreign-currency bill nets the supplier's bill in both currencies (forex hook rescales bill-wise
  amounts typed for the gross).

## Manufacturing & job work module (`mfg`) — BOM, Manufacturing Journal, Material In / Out, ITC-04

Core `src/core/modules/mfg` (README there: schema, costing, job work, legal assumptions), renderer
`src/renderer/modules/mfg`, DTOs `src/shared/types/mfg.ts`, pure rules `src/shared/mfg/` (costing,
BOM explosion, s.143 / rule 45 as effective-dated data). Migration **210** (block 210–219).

- **Gating**: F11 `features.manufacturing` (BOM, Manufacturing Journal) and `features.jobWork` (needs
  Multiple godowns: godown kinds, Material In / Out, orders, pending job work, ITC-04). Turning one on
  creates the classed voucher types once (`mfg/voucherTypes.ts`); journal routes refuse when off.
- **Godown ownership**: `godowns.third_party_kind` = `none` | `ours_with_party` (our stock at a job worker —
  valued, in the Balance Sheet) | `party_with_us` (a principal's stock with us — quantities only, never in
  valuation or closing stock); `party_ledger_id`. Legacy `is_third_party` godowns migrated to
  `ours_with_party` (unchanged values).
- **Voucher types**: stock journal types carry `config.stockJournalClass` = `manufacturing` |
  `material_out` | `material_in` (Masters › Voucher Types › Use as; fixed once used). They are not new
  base types — they post as stock journals (no ledger entries; additional costs only add to the value of
  the finished goods — the usual convention).
- **Posting**: only through the vouchers hook (`vouchers/hooks.ts`, `mfgVoucherHook`): `compose` turns the
  `VoucherInput.stockJournal` block into ordinary stock journal item lines (consumption / production),
  `adjust` adds confirm-level warnings, `write` rebuilds `stock_journal_details` / `_lines` / `_costs` in
  the voucher transaction (with `date`, `affects_stock`, `is_post_dated`), `clear` on alter / cancel /
  delete. `VoucherPreview.stockJournal` returns the costing estimate.
- **Valuation**: `inventory/valuation.ts` reads the per-line costing basis and applies
  `shared/mfg/costing.ts` while replaying (finished goods = consumption at the costing method as of the
  voucher date + additional costs − by-products / scrap, split by quantity; transfers keep their cost),
  so every stock report, the Balance Sheet / P&L closing stock and the Production Register agree, and
  back-dated vouchers re-value production. `party_with_us` godowns never touch cost states or totals.
- **Routes** `mfg.*`: bom list/get/revisions/save/delete/cost, journal types/context/get/duplicate,
  production.register, jobWorkOrder list/get/nextNumber/save/delete, jobWork pending/alerts, itc04
  periods/report. Reports are `transactional: false`. Existing permissions only (masters.* for BOMs,
  vouchers.* for orders and journals, reports.view, gst.view); mutations audited (`bom`,
  `job_work_order`, vouchers as usual).
- **UI**: `vouchers.entry` hands classed types to `mfg.journal.entry` (BOM explosion, live costing,
  job work sections by godown kind); Masters › Bills of Materials; Transactions › Manufacturing Journal,
  Material Out / In, Job Work Orders; Inventory reports › Production Register, Pending Job Work; GST ›
  ITC-04; Gateway notice + dashboard card for s.143 deadlines; voucher view panel; godown form "Whose
  stock"; voucher type form "Use as".
- **ITC-04 output**: CSV / Excel of the form's tables 4 and 5A–5C via the shared export path — not the
  portal's JSON schema (documented in the module README).
- **Job work invariants** (review): the job worker / principal of a movement in a third-party godown is
  the godown's party (a purchase delivered to a job worker, a sale from his premises), else the Material
  In / Out's party; goods moved on from one job worker to another keep the original challan and date for
  s.143 (FIFO lots inherit them; ITC-04 5B, not table 4); 5A / 5B carry the voucher's `referenceNo` (the
  job worker's challan) when entered. A Manufacturing Journal consuming a principal's goods puts its
  outputs in that principal's godown (own godown refused); other vouchers touching a `party_with_us`
  godown get a confirm-level `mfg` warning.
- **Final wave**: without a godown filter, `inventory/stock.ts` (`stockByItem`, `stockOnHand`,
  `batchesFor`) gives our stock — `party_with_us` godowns left out (item list, reorder status,
  dashboard low stock, order positions); altering a classed journal without its `stockJournal` block
  (plain Stock Journal screen) is refused with directions instead of dropping its details.

## GST plus (`gst` module) — composition returns, set-off & challans, electronic ledgers, advances, bills of entry, amendments

Owner: `src/core/modules/gst` (hook.ts, advances.ts, bookAdjustments.ts, filings.ts, setoffPost.ts,
eledgers.ts, boeRecon.ts, composition.ts, statLedgers.ts, schemas.ts), `src/renderer/modules/gst`,
`src/shared/types/gst-plus.ts`, migration **200** (block 200–209; the final wave's `gst_3b_changes` and
`gst_rule37_links` are in migration **240**). Details:
`src/core/modules/gst/README.md` §11–§17.

- **Voucher field** `VoucherInput.gstDetails` (extend-only; `VoucherGstDetailsInput`): `advance`
  (receipt), `advanceAdjustments` (sales / outward debit note; default from bill-wise "Against" on an
  advance bill), `advanceRefund` / `challan` (payment), `billOfEntry` (purchase of imported goods),
  `adjustment` (journal: ITC reversal Rules 37 / 37A / 38 / 42 / 43 / s.17(5), reclaim, reverse-charge
  liability), `setoff` (journal posted by GST Set-off). Validated and posted by the gst **voucher hook**
  (`vouchers/hooks.ts` STATIC_HOOKS); derived rows `gst_advance_lines`, `gst_bill_of_entry`,
  `gst_stat_lines`, `gst_challans` are rebuilt in the voucher's own transaction with date /
  affects_books / is_post_dated (books filter as for `gst_lines`), cascading on delete.
  `vouchers.duplicate` keeps only an advance's rate and an adjustment nature. A receipt whose advance
  other vouchers use cannot be altered out from under them (optional / advance removed / amount below
  what was used / rate or POS changed). Extension used (additive): `HookInvoiceLine.itcEligibility`
  (vouchers/hooks.ts) so a bill of entry on blocked goods is posted as cost, not credit.
- **System ledgers** created on demand with a `reserved_code` (`GST_PLUS_LEDGERS`): GST on Advances
  Received, GST Electronic Cash Ledger, IGST Payable on Imports (Customs), Interest on GST, Late Fee on
  GST Returns, GST Penalty and Other Dues, Composition Tax (GST), ITC Reversed (GST) — their creation is audited.
- **Set-off** (`gst.setoff.*`): GSTR-3B 6.1 utilisation (s.49(5) / Rule 88A) or CMP-08 cash, cash per
  major × minor head (PMT-06 heads); posted as **one Journal** per period (Dr Output / RCM payable /
  interest / late fee / penalty / composition tax, Cr Input, Cr GST Electronic Cash Ledger) and **GST
  challans** as Payment vouchers (Dr Electronic Cash Ledger / Cr bank) — both through `saveVoucher`
  (numbered, audited, period-lock aware). Electronic cash / credit ledgers are reports over those rows
  and the Input tax ledgers.
- **Filing status & amendments**: `gst_return_filings` (form + period, ARN, snapshot). Altering an
  outward document of a filed GSTR-1 period logs `gst_amendments` (original vs amended snapshot) reported
  in the next unfiled period — never a filed one (9A / 9C / 10, JSON `b2ba` / `cdnra`); the filed period keeps its figures in
  GSTR-1 totals and GSTR-3B; deleting / cancelling such a document is refused (`beforeRemove`).
- **Filed GSTR-3B** (final wave, `filed3b.ts`, migration 240 `gst_3b_changes`): altering / adding /
  deleting a voucher with a GSTR-3B effect in a period whose 3B is marked filed asks to confirm (alter /
  add) and is logged (before / after effect, `accumulate` + `bookAdjustments(…, voucherId)`); the
  change is reported in the first later unfiled 3B (3.1, more credit in 4(A), less credit in 4(B)(2)),
  the filed period keeps its figures (`gstr3bChangeCorrections` in `computeGstr3b`); outward documents of
  a filed GSTR-1 period stay with the GSTR-1 amendments. Route `gst.gstr3b.changes`, screen
  `gst.gstr3b.changes`.
- **Rule 37** (final wave, `rule37.ts`, migration 240 `gst_rule37_links`): `gst.rule37.report` (purchases unpaid after
  180 days, from their own bill's bill-wise balance; credit due / reversed / to reverse / to reclaim)
  and `gst.rule37.post` (gst.file: one stat-adjustment Journal `itc_reversal_r37` / `itc_reclaim` with
  `adjustment.rule37[]`); screen `gst.rule37`.
- **Set-off and "credit not in the books"** (final wave): the set-off journal credits the Input tax
  ledgers only with what they hold (`bookInputCredit`); the rest of the credit utilised goes to the
  system ledger `GST_CREDIT_OUTSIDE` "GST Credit Not in Books".
- **Composition**: effective-dated, editable rate master `gst_composition_rates` (seeded Rule 7 rates);
  CMP-08 (quarter) and GSTR-4 (FY) from the books; their files are Pevqori's documented JSON / CSV (the
  portal offers no CMP-08 upload; the GSTR-4 offline-tool schema is not reproduced).
- **Renderer**: screens `gst.setoff`, `gst.ledger.cash`, `gst.ledger.credit`, `gst.cmp08`, `gst.gstr4`,
  `gst.composition`, `gst.advances`, `gst.boe`, `gst.amendments`, `gst.filings` (menu + Go To); voucher
  entry **Alt+J** GST details (`gst/GstDetailsDialog.tsx`, form field `VoucherForm.gstDetails`, kept on
  alteration). Shell extension (additive): `MenuItem.gstRegistrations` filters menu / Go To items by the
  company's registration (`OpenCompanySummary.gstRegistration`, `MenuContext.gstRegistration`) so a
  composition company sees CMP-08 / GSTR-4 instead of GSTR-1 / 3B. Extension points used:
  `dashboardCards` (composition due dates), `voucherPanels` (GST details + amendment log on
  `vouchers.view`).
- **Permissions**: no new permission — reads `gst.view`; filing marks, set-off / challan posting,
  CMP-08 interest, composition masters and return files `gst.file`; every mutation audited.
- **IRP / e-way bill APIs** are not called (no GSP credentials offline): JSON out → portal → response in
  (README §17).

## Multi-currency module (`forex`) — foreign-currency vouchers, bills, exchange gain / loss, revaluation, export invoices

Core `src/core/modules/forex` (README there: model, posting, legal assumptions), renderer
`src/renderer/modules/forex`, DTOs `src/shared/types/forex.ts`, pure money / rate helpers
`src/shared/forex.ts`. Migration **230** (block 230–239), additive only.

- **Gating**: F11 `features.multiCurrency` ("Multiple currencies"). Off → menus / Go To hide the screens
  (`feature`), routes refuse (BUSINESS_RULE) except `forex.context`, and any forex field on a voucher
  is a field error. Switching it on creates the system ledger **Forex Gain/Loss** (Indirect Expenses,
  `reserved_code FOREX_GAIN_LOSS`, audited).
- **Data**: books stay in INR paise (Σ = 0 per voucher). Entries of a ledger whose `currency_id` is
  foreign also store `currency_id`, signed `forex_amount` (major unit, currency decimals) and
  `exchange_rate` (₹ per unit, ≤ 6 dp); same on `bill_allocations` (bill in both currencies),
  `opening_bills.forex_amount`, `ledgers.opening_forex_amount`, and on `vouchers` the document
  currency / rate / value. `forex_revaluations` marks the revaluation journals.
- **Posting**: only through the vouchers hook extension point (`forexVoucherHook`): `compose`
  converts foreign amounts to rupees (invoice: `VoucherInput.forex` = party's currency; ledger mode:
  line `forexAmount` + `exchangeRate`, default rate from the exchange-rate master — buying for
  sales / receipts / credit notes, selling for purchases / payments / debit notes); `adjust` carries
  settled bills at their booked rupees and posts the **realised** difference to the configured ledger
  in the same voucher; `write` stores the currency columns in the voucher's transaction (they share the
  entries' `affects_books` / `is_post_dated`). GST is computed on the rupee values only.
- **Period end**: `forex.revaluation.report/post` — closing rate (master or typed) → INR-only
  adjustment lines per ledger / pending bill against the unrealised ledger, posted via `saveVoucher`
  (repeat for the same date needs confirmation). Monetary items only (Balance Sheet ledgers outside
  Fixed Assets / Investments / Stock-in-Hand / Capital / Misc. Expenses); every currency with a balance
  needs a closing rate; the journal date may not precede the as-of date.
- **Ledger master** (accounts, additive): re-saving opening bills keeps their `forex_amount` (same
  name and side); the currency cannot change while the opening is entered in the currency.
- **Routes** `forex.*`: context, settings.get/save, rate.suggest, pendingBills, voucher, outstanding,
  ledger, revaluation.report/post, opening.get/save. Existing permissions only (vouchers.view /
  reports.view / masters.view / masters.alter / company.manage / vouchers.create); mutations audited.
- **UI**: voucher entry Alt+Y (invoice currency & rate, or a line's foreign amount, rate and bill-wise
  split in the currency), side panel with the realised difference; screens Forex Outstanding,
  Ledger in Foreign Currency, Forex Revaluation (Ctrl+A posts the journal), Opening Balance in
  Currency, Multi-currency Settings (Masters / Reports menus + Go To); voucher view panel (Alt+Y);
  links from Ledger Vouchers (Alt+R) and Party Outstanding (Alt+Y).
- **Entry decimals** (final wave): in a foreign-currency invoice the form's amount fields hold the foreign
  amount in 10^-d units, d = the currency's decimal places (0 / 2 / 3 / 4; `VoucherForm.forexDecimals`,
  `AmountInput decimals`, the 'forexUnit' rescale; loaded invoices start at 4 decimals).
- **Print**: `PrintVoucherData.forex` (core `forex/print.ts`); Modern / Classic / Voucher templates
  print lines, charges, GST and total in the currency next to the rupees, the rate and the total in
  words in the currency (`ForexPrintBlock`).

## Print group — paper sizes, MRP, sharing, cheque printing, payee bank details, e-payment files

Core `src/core/modules/print` (README: paper, MRP, sharing) and `src/core/modules/cheques` (README:
tables, hook, register, layouts, e-payments, legal notes); renderer `src/renderer/modules/print`
and `src/renderer/modules/cheques`; Electron main `src/main/printPage.ts` (paper geometry) and
`src/main/share.ts` (exports folder, .eml, wa.me); DTOs `shared/types/print.ts`,
`shared/types/cheques.ts`, `shared/shareText.ts`. Migration **170** (block 170–179).

- **Paper**: `NativePageSize` = A4 | A5 | Letter | Legal | 80mm | 58mm | custom (+ `landscape`,
  `rollHeightMm`, `customPageMm`) on `print.toPdf` / `print.savePdf` / `print.print` and `share.*`.
  Main validates strictly and converts: printToPDF `{width,height}` in inches, print in microns;
  rolls are continuous (receipt height measured by the renderer, clamped 40 mm–3 m), edge to edge;
  `custom` 50–400 mm per side (cheque leaves). `config.invoice.paperSize` / `rollWidth` / `showMrp`;
  voucher-type `config.printTemplate` / `showMrp` win. Compact template = thermal receipt (item,
  qty × rate, amount; tax by rate; MRP and "You saved").
- **MRP**: `stock_items.mrp` → `PrintLine.mrp`; `PrintVoucherData.mrpSummary` (Σ MRP × qty, savings
  vs value charged incl. GST); outward sales documents only; price above MRP is a non-blocking
  print warning (Legal Metrology (Packaged Commodities) Rules, 2011).
- **Sharing** (Alt+W: voucher view, print preview, Statement of Account — on Receivables / Payables
  Alt+W switches side instead): core
  `print.share.context` (recipient from party ledger e-mail / mobile, texts from `config.share`
  templates) and `print.share.log` (data.export, edit log `export`) **before** the native action.
  `share.email`: main renders the PDF, saves it under `<data>/companies/<id>/exports/shared` (path
  chosen by main from the open company, never the renderer), writes an RFC 5322 MIME draft (.eml,
  base64 PDF, RFC 2047 headers, `X-Unsent: 1`, header-injection checks) and opens it with the OS
  handler (`shell.openPath`, path checked inside the folder); fallback `mailto:` + show the PDF.
  `share.whatsapp`: Indian mobile validated → `https://wa.me/91…?text=…` (user confirms the
  external link), PDF shown in its folder.
- **Cheques** (F11 `features.chequePrinting`; payee details / e-payments always): payee bank details
  per ledger (IFSC `^[A-Z]{4}0[A-Z0-9]{6}$`, account typed twice in the UI); cheque books per bank
  ledger; **issued leaves are derived from the books** (bank credit lines with instrument `cheque`) —
  only books, user marks, prints, layouts, bank settings and payment-file batches are stored.
  Posting integration only via the vouchers hook (`cheques/hook.ts`): `compose` fills the next free
  leaf inside the save transaction, `adjust` warns on reused / cancelled / spoilt leaves,
  `beforeRemove` cancels the leaves of a cancelled voucher. Register (as on a date): unused / issued
  (PDC flagged) / cleared (BRS bank date on or before the date) / stale (> 3 months from the cheque
  date) / cancelled; its uncleared total ties to the BRS "cheques issued but not presented" (in the
  books, dated ≤ as-on date). Layouts in mm with CTS-2010 presets (202 × 92 mm; nothing printed — text
  height and the signatory's second line included — may reach the bottom 16 mm MICR band), calibration
  shift and a calibration grid print. Printing a cheque is an export (`cheques.print.record`, data.export, edit
  log) recorded before the page goes to the printer.
- **E-payments**: generic documented CSV (not a bank-proprietary format) of Payments by NEFT / RTGS /
  IMPS with beneficiary A/c + IFSC (regular vouchers only: never optional / cancelled); RTGS ≥ ₹2 lakh,
  IMPS ≤ ₹5 lakh checks; batches recorded, re-export warned, a batch whose file was not saved is
  discarded (`cheques.epayment.discard`, same user / day); data.export + edit log.
- **Routes** `cheques.*` (22, listed in shared/types/cheques.ts) and `print.share.*`; reads
  `transactional: false`; every write audited.
- **UI**: Masters › Payee Bank Details / Cheque Books / Cheque Layouts / Cheque Printing Settings;
  Banking › Print Cheques / Cheque Leaf Register / E-payment File; all in Go To (plus a payee
  provider: "Bank details: <party>"). Voucher view **Alt+K** Print cheque (Payment / Contra),
  **Alt+W** Share. Print Cheques: Space leave out, Alt+X A/c Payee on/off, Alt+P print, Alt+L
  layouts. Layout editor: Ctrl+1 sample / Ctrl+2 grid, Alt+K calibration sheet, Alt+T test print.
  Leaf register: Ctrl+1…6 views, Alt+X cancel leaf, Alt+U re-open, Alt+R BRS. E-payment File:
  Space tick, Alt+A tick all ready, Ctrl+A save file, Alt+M payee bank details.

## Print layouts (2.0)

What prints on a document and with which words, changeable in print preview for this print or saved as a
default (R5). Model and functions: `src/shared/printLayout.ts` (pure, node-only — used by core and the
renderer); DTO fields `PrintVoucherData.savedLayout` / `applied` (`shared/types/print.ts`). No migration:
both layers live in JSON that backup, restore and the XML export already carry.

- **Catalogue.** `PRINT_PARTS` (≈ 60 parts: logo, company / party blocks, title, copy label, references,
  place of supply, each item column, totals rows, words, HSN and tax summaries, bank, UPI QR, e-invoice,
  declaration, terms, notes, signature, footer, page numbers, ledger entries …) and `PRINT_TEXTS` (title,
  copy labels, party labels, column headings, declaration, terms, notes, signatory, "For …" line, footer,
  "computer-generated" line, with a maximum length each). **Ids are persisted: never rename or remove one.**
  Each part says how it disappears (`kind`: DTO field nulled, template gate, item column, totals row, page
  counter, or an existing option key), which layouts it belongs to, and whether it is **locked** (the
  CANCELLED / OPTIONAL stamp, document number and date, grand total, item description, ledger entries).
- **Layers** (`PrintLayoutSpec = { hide: id[], show: id[], text: { id, value }[] }` — arrays only, so
  `mergeDefaults` keeps it on read and save): company `config.invoice.layout` (default empty in
  `DEFAULT_CONFIG`; saved by `company.config.save { invoice: { layout } }`, Company › Manage) ‹ voucher type
  `voucher_types.config.printLayout` (`accounts.voucherType.save { id, config: { printLayout } }`, Masters ›
  Alter; key-level patch, `null` removes it) ‹ this print (renderer state, remembered for the session).
  A layer replaces its stored value whole. `resolvePrintLayout(company, voucherType, print)`: a layer's
  `show` undoes a lower `hide`, `hide` wins inside one layer, locked parts are never hidden; for texts the
  highest layer that names one wins, `''` prints nothing and an absent id inherits.
- **Option keys stay the owners (D22).** HSN summary, bank details, UPI QR, item-wise tax and the MRP column
  keep their Invoice Printing keys, and voucher types gain the four nullable flags `showHsnSummary`,
  `showBankDetails`, `showUpiQr`, `itemwiseTax` (same rule as `showMrp`: `null` = as in Invoice Printing;
  `print/data.ts resolveOptions`: Invoice Printing ‹ voucher type ‹ preview overrides). Declaration and
  terms (both levels), the signatory label (company) and the voucher-type Print title keep theirs too. A
  layer never holds an id owned by a key at its level (`legacyKeyAt`; the per-print level is owned by the
  preview overrides, i.e. the company keys); `shadowedByLegacy` drops a lower layer's text that a higher
  level's key decides (company `title` text under a voucher-type Print title; voucher-type `signatoryLabel`
  text under a preview signatory override).
- **Validation.** `validatePrintLayout(x, level)` cleans untrusted input: unknown, locked and option-owned
  ids dropped, ≤ 200 entries per list, texts clipped to their maximum, control characters removed (newlines
  kept only in multi-line texts), duplicates collapsed. The save routes refuse any issue with `VALIDATION`
  at `invoice.layout.…` / `config.printLayout.…` (`print/layoutSchema.ts`) — nothing is silently dropped on
  save. `company.config.get` / `.save` return `invoice.layout` already cleaned (`withValidCompanyLayout`), so
  a stored layer that is no longer valid never blocks Invoice Printing, which sends its whole draft back.
  Tabs in texts become spaces. Texts are plain text: templates render them as text nodes, never HTML.
- **Core pass-through (D20).** `print/data.ts buildPrintData` copies both stored layers through
  `validatePrintLayout` into `doc.savedLayout` (cached per request: a corrupt stored value becomes the empty
  layer plus **one** `warn` log line with issue paths only, never a crash); batch documents carry their own
  voucher type's layer; `print.sample` carries the company layer and an empty voucher-type layer;
  `options.layout` is the validated company layer. Core never removes data because of a layout — a
  per-print `show` must be able to undo a saved `hide`. Preview `overrides` accept and ignore `layout`
  (Invoice Printing sends its whole draft).
- **Application (renderer).** `applyPrintLayout(doc, resolved)` returns a new document: DTO parts nulled /
  emptied (hiding the company GSTIN also hides its PAN unless a layer explicitly shows `company.pan`; hiding
  the party GSTIN clears GSTIN, PAN and registration type, also on a ship-to that is the party), DTO-backed
  texts written into their fields, and `applied { hidden, texts }` set for the template gates
  (`isPartShown`, `printText`). The input is never mutated and every money field (lines, totals, charges,
  tax and HSN rows, entries, UPI, MRP summary) is passed through by reference.
- **Statutory guard (D23).** `layoutWarnings(doc, resolved)` — hiding a particular the document needs adds a
  plain-language line ("Hidden on this print: the buyer's GSTIN — required on a B2B tax invoice (Rule
  46(d)).") and never blocks printing. Tax / export / SEZ / self invoices cite CGST Rule 46 by clause
  (supplier (a), recipient (d)/(e) — B2C below ₹50,000 exempt, HSN (g) when the column and the HSN summary
  (its option, or the Tax summary part that prints it) are both off, quantity and unit of goods (i), taxable value (k), rate and amount of tax (l)/(m), place of
  supply on inter-State supplies (n), delivery address when different (o), reverse-charge note (p),
  signature (q)), copy marking on goods invoices Rule 48(1), an e-invoice's IRN and QR Rule 48(4); bills of
  supply Rule 49, credit / debit notes Rule 53 (with the original invoice), delivery challans Rule 55. A
  title text that no longer names the document ("Invoice", "Bill of Supply", "Credit Note", "Challan") is
  warned about. On a self invoice the party is the supplier (46(a), whatever the value) and the company the
  recipient (46(d)); no copy marking. Purchases, a debit note to a supplier and accounting vouchers get
  none. A particular the document does not carry is never warned about. Pass the document as core built it,
  not the result of `applyPrintLayout` (which has already removed the values the checks look at).
- **Templates and the one choke point (renderer, WP-06).** `templates/PrintDocuments.tsx` draws every
  document as `layoutDoc(doc, layers)` = `applyPrintLayout(doc, resolve(saved company ‹ saved voucher type ‹
  this print))` (`modules/print/lib/layoutParts.ts`, memoised on the document and the layers). The preview,
  Print, Save PDF and Share (all three serialise the rendered `.bp-docs`), batch printing, print after
  saving and the Invoice Printing sample go through it; batch printing and print-after-save pass no
  per-print layer. Each template exports `SUPPORTED_PARTS` (`TEMPLATE_PARTS[kind]`; the editor lists
  catalogue ∩ template ∩ layout) and honours them: gates `isPartShown(doc, id)`, item columns through
  `itemColumns()` (ANDed with "not hidden"; a column never prints without data), totals rows through
  `totalRows()` (filtered; the grand total is locked), wording through
  `printText(doc, id, templateText(kind, id, doc))` — `templateText` is the template's own 1.0 wording, so
  an empty layout prints today's document; the only markup difference is the added `data-part="<id>"`
  attributes. Page numbers hidden → `buildPrintHtml({ pageNumbers: false })` → `pageCss(…, 'none')`. The
  Compact receipt has no logo, CIN, S.No., batch, per-line tax, HSN summary, bank block or page numbers;
  Classic keeps its Amount column (it carries the tax rows and the total). `lib/partsCoverage.test.ts`
  scans each template (and the blocks it draws through) for a click target and the mechanism of every
  supported part, and checks every printed `data-part` is a catalogue id.
- **Editor (`modules/print/LayoutEditor.tsx`, Alt+L on Print Preview, "Customize layout…" in Invoice
  Printing).** A 360 px panel beside the preview: Show (switches per group, locks, the rule of a statutory
  particular, where a value comes from, "nothing to print on this document") and Texts (placeholder = the
  inherited wording, ↺ per field). Click-to-select: `data-part` attributes plus one delegated click handler
  on the preview container (outside `.bp-docs`); the outline styles (`editingCss`) are scoped under
  `.bp-editing` on that container and are never serialised. Option-owned parts and texts change this print
  through the preview overrides (`print.voucherData { overrides }`, debounced); everything else is the
  per-print layer applied in the renderer. **Save for {voucher type}** → `accounts.voucherType.save { id,
  config }` (`voucherTypePatch`: the layer merged into the type's, the four flags and MRP, declaration and
  terms into their keys — `''` hides the part and clears the key — the title into Print title, the
  signatory label as a layer text); **Save for all documents** → `company.config.save { invoice }`
  (`companyPatch`). After a save only what the saved layers do not already give stays on this print
  (`remainingPerPrint`). Reset: this print · saved for the voucher type (layer + show / hide flags; its
  texts stay) · saved for all documents (layer only). The per-print edit is remembered per company and
  voucher type in `sessionStorage['pevqori.printLayout.<companyId>.<voucherTypeId>']` (try/catch, cleaned
  on read) and offered — never applied unasked — when that kind of document is opened again; print after
  saving ignores it. In Invoice Printing the same panel edits the draft (`invoice.layout` and the options),
  saved with the form (Ctrl+A); there an option text emptied prints none (as in the form) and ↺ restores
  its `DEFAULT_CONFIG` wording, while everywhere else an empty box inherits. The PAN follows the GSTIN
  (`applyPrintLayout`): while a layer hides the GSTIN the editor shows the PAN switch off ("Hidden with your
  GSTIN") and turning it on writes an explicit `show` (`setPartShown`; `mergeIntoLayer` applies hides
  before shows so saving keeps it).

## Data plus (`dataplus`) — XML data export, attachments, numbering tokens, multiple aliases

Migrations **220–222** (block 220–229), additive only: `220_aliases` (`ledger_aliases`,
`stock_item_aliases`), `221_numbering_rows` (`voucher_type_numbering_rows`), `222_attachments`
(`attachments`, transport-only `attachment_blobs`, grants for the system roles).

- **XML data export** — `data.xmlExport.create` (`data.export`, async, `transactional:false`) in
  `src/core/modules/data/xmlExport.ts`; screen `data.xmlExport` "XML Data Export" (Gateway › Data,
  Go To; Ctrl+A export, Alt+B Trial Balance). The interchange format's "Import Data" envelope (element names in
  `src/core/modules/data/xmlFormat.ts`), UTF-16LE + BOM;
  masters only → `.xml`, with vouchers → `.zip` (`1-Masters.xml`, `2-Vouchers.xml`) streamed through
  `ZipFileWriter` from one read snapshot (`openSnapshot`, yields every 5 000 vouchers). Vouchers are
  written as recorded (no recomputation): entries, bill-wise, cost centres, bank instruments,
  inventory with godown / batch and accounting allocations, GST header facts. Contract test: export →
  OUR importer into an empty company reproduces the trial balance, stock summary, GST lines, GSTR-3B /
  GSTR-1, pending bills, every voucher's postings and aliases (`xmlExport.test.ts`). A credit / debit
  note's original invoice travels as `REFERENCE` / `REFERENCEDATE` both ways (documented assumption).
  With the vouchers of a period after the books beginning, the masters carry the openings ON the
  period's first day (`openingsAsOf`: Trial Balance openings with that day as carry-forward date, pending
  bills + an "On Account" bill for the unallocated rest, stock per godown / batch at its value) so the
  receiving company can begin its books there. Item lines carry their share of their sales / purchase
  ledger's posting (assessable-value charges such as freight stay on their own ledger), so every
  voucher in the file balances. Children are read per batch of 2 000 vouchers (one query per table).
  The importer recovers reverse charge (RCM-liability duty ledgers), overseas parties (country),
  assessable-value charges and GST on advances (receipt → `gst_advance_lines` 'received', invoice → 'adjusted'
  and refund payment → 'refunded' via its bill-wise "Agst Ref"; the gst module's system ledgers are adopted
  by name + group). Final wave:
  the stock lines of manufacturing / job work journals are written at the valuation engine's current
  value (`journalCosts`), not the estimate stored when they were saved, so a back-dated cost change
  reaches the receiving company too. Not exported: quotations / proforma / physical stock (reported as skipped),
  forex amounts (rupees only), e-invoice / e-way bill and shipping bill details, attachments.
- **Attachments** — core `src/core/modules/attachments` (README), routes `attachments.list / counts /
  add / read / remove / register`, permissions `attachments.add` / `attachments.remove` (view follows
  the owner: `vouchers.view` / `masters.view`). The renderer sends bytes from the native Open dialog,
  never a path; files are checked (allowlist in `src/shared/attachments.ts`, content sniffing, no
  programs / macros, 25 MB, 50 per owner) and stored content-addressed as
  `<company>/attachments/<sha256>.<ext>`; opening goes through main (`attachment.openCopy`: re-check,
  copy to a fresh temp folder, open with the OS handler). Add / remove are audited as `alter` of the
  owner; removal is refused for vouchers in the locked period; a file is deleted only after commit and
  when unused. A voucher with attached files cannot be deleted (voucher hook `beforeRemove` in
  `attachments/hook.ts`, appended to `STATIC_HOOKS`) — remove the files first; cancelling keeps them.
  XML that is really a web page / Office document is refused. Backups embed the files in the snapshot (`attachment_blobs`) so the `.pvqbak` checksums
  and encryption cover them; restore unpacks them; `data.verify` › `attachments` checks presence + hash.
  UI: `attachments.manage`, `attachments.register` (Reports menu, Go To), Alt+F from the voucher view
  (voucher panel) and the ledger / stock item forms. `attachments.unused` / `attachments.sweep`
  (attachments.remove; one edit-log entry) remove stored files nothing refers to (register › Alt+U).
- **Numbering tokens** — `src/shared/numbering.ts` (shared by core and the voucher-type form):
  {FY} {FYYYYY} {YY} {MM} {MMM} in prefix / suffix, expanded with the voucher date at allocation;
  dated prefix / suffix rows ("Applicable from"); GST documents (sales, credit / debit note of a GST
  company) are checked at their longest expansion: ≤ 16 characters, letters / digits / `/` / `-`
  (CGST Rule 46(b)); monthly restart only with {MM} / {MMM} in every variant. Counters and existing
  numbers are unchanged; no tokens and no rows = the old behaviour.
- **Multiple aliases** — `src/core/lib/masterAliases.ts`: the `alias` column is the first alias, the
  extra tables hold the rest in order (≤ 20 per master); unique case-insensitively across names and all
  aliases within the kind (ledgers also against groups); `aliases: string[]` on ledger / item save;
  searched by every ledger / item picker, Go To and lists; Excel import / export (the "Alias" column,
  `;`-separated) and the XML data import (`NAME.LIST`) / export carry them all.

## Invoice numbering and renumbering (2.0)

Owner: `src/core/modules/vouchers/numbering.ts` (decision, allocation), `vouchers/service.ts` (save,
renumber, number check), `src/core/modules/accounts/numbering.ts` (series status, next number, gaps),
`accounts/voucherTypes.ts` (restart seeding), `src/shared/numbering.ts` (`gstDocNumberProblems`,
`voucherNumberProblems`, `describeScheme`), DTOs in `src/shared/types/vouchers.ts`. Migration **250**
(block 250–299). Details: `src/core/modules/vouchers/README.md` §7. Allocation order, posting, GSTR-1 export
and counter period keys are unchanged.

- **Permission** `vouchers.renumber` ("Change voucher numbers and the next number", Vouchers group; role
  editor prerequisite `vouchers.alter`). Owner through `'all'`, Accountant from `SYSTEM_ROLES` (new
  companies) and migration 250 (existing companies, `json_insert`, idempotent); Data Entry, Auditor and
  custom roles do not get it automatically. The core checks it on every path — never only the screen.
- **Override** `VoucherInput.numberOverride { number, reason?, continueSeries? }` — an explicit field, never
  inferred from `number`, taken out of the input before posting (never stored in `vouchers.meta`). Without
  the permission FORBIDDEN; numbering "None" VALIDATION. Format (VALIDATION, path `number`): GST documents
  (sales, credit / debit note of a GST company) 1–16 of `[A-Za-z0-9/-]`, others 1–60 characters without
  control characters. Uniqueness: the financial year for an outward GST document, the numbering period
  otherwise — always, whatever "Prevent duplicates" says. Create: the counter is not consumed unless the
  override equals the next number; `continueSeries` advances it to the typed sequence (`commitNumber`, never
  lower). Cancelled and IRN-generated vouchers are refused by the normal alter guards; a document of a filed
  GSTR-1 period gets the existing confirm warning and amendment record (gst hook).
- **Behaviour change (D27, CGST Rule 46(b))**: an outward GST document (sales, credit note, debit note to a
  customer, GST company) is unique within its financial year on every `saveVoucher` path (entry, Excel
  import — a duplicate row fails with the CONFLICT message, recurring, POS, renumber) even with "Prevent
  duplicates" off or a monthly / never restart; automatic allocation of such a document skips numbers
  already used in the financial year (only matters for a monthly series without the month in its prefix,
  which the voucher-type check refuses for new schemes); moving a document into a financial year where its
  number is taken is a CONFLICT on `date`. Other voucher types keep the type's rule. The XML data import
  writes vouchers through its own path and keeps its own duplicate handling.
- **Edit log**: an alter that changes the number records `numberChange { from, to, reason }`, a create with
  an override `numberOverride { to, next, reason }` (in the voucher's after-image), a next-number change a
  `voucher_type` alter `{ counter: { periodKey, lastNumber, from, to }, nextNumber }`.
- **Routes**

| Route | Access | Input → output |
|---|---|---|
| `vouchers.numberCheck` | `vouchers.view` | `{ voucherTypeId, date, number, excludeId?, partyLedgerId?, mode? }` → `{ ok, taken, problems, seq, scopeLabel }`; the same rule as the save (`numberClash`, indexed `NUMBER_TAKEN_SQL`); a debit note's direction comes from the party / mode, else the altered voucher, else both rules apply With `excludeId`, a different number for a voucher other vouchers cite adds that refusal message to `problems` (`ok: false`). |
| `vouchers.renumber` | `vouchers.alter` + `vouchers.renumber` (service) | `{ id, number, reason?, continueSeries?, expectedUpdatedAt, acknowledgeWarnings? }` → `VoucherSaveResult`; re-runs the alter with the stored `meta.input` + `numberOverride` (entries, stock and GST rows unchanged — a rebuilt posting that differs from the saved one, e.g. a physical stock count re-derived from today's books, → BUSINESS_RULE "Alter the voucher (Alt+A), check the figures and change the number there"); a voucher without `meta.input` → BUSINESS_RULE "Alter the voucher (Alt+A) and change the number there"; a party bill another voucher settles keeps its name (info warning `numbering`); refused (`BUSINESS_RULE`, `assertNumberNotCited`) — like any alter that changes a number — while other vouchers cite the old number: a credit / debit note's original invoice no. (same party; its original date, when given, is the invoice's), the fulfilling notes / invoices of an order (`order_ref`), the invoices billing a delivery / receipt note or rejection (`tracking_ref`); cancelled vouchers do not count. The message names them: "Credit Note 3 and Sales 7 refer to this number — change those references first." |
| `accounts.voucherType.numberingStatus` | `masters.view` | `{ ids?, date }` → `NumberingStatusRow[]` (`periodKey`, `periodLabel`, `counter`, `highestUsed`, `nextSeq`, `next`, `vouchersInPeriod`) |
| `accounts.voucherType.setNextNumber` | `vouchers.renumber` | `{ id, date, next, acknowledgeWarnings? }` → `{ next, warnings }`; 1 ≤ next ≤ 999 999 999, not below the starting number, GST format of the formatted number; `last_number = next − 1` (may lower the counter — used numbers are skipped); confirm warnings for lowering to or below a used number and for raising past the number the series would give next ("report them in GSTR-1 Table 13") |
| `accounts.voucherType.numberGaps` | `vouchers.view` | `{ id, from, to }` → `{ first, last, issued, cancelled, missing (≤ 200), missingCount }`, per numbering period, read-only |

- **Restart seeding**: when a voucher-type save changes the restart, the counter of the new period key for
  today starts at the highest sequence already used in that scope, read from the numbers in today's format
  (never lowered; numbers of another year's `{FY}` format do not make the series jump), so a large series
  switched to "never" allocates at once (perf test: 20 000 vouchers, < 50 ms).

## POS / counter billing (`pos`) — scan, split tender, change, hold / recall, returns, day-end

Core `src/core/modules/pos` (README there: posting, checks, routes, legal notes), renderer
`src/renderer/modules/pos`, DTOs `src/shared/types/pos.ts`. Migration **180** (block 180–189),
additive only: `pos_tender_modes`, derived `pos_bills` / `pos_payments`, `pos_held_bills`, indexes on
`stock_items.barcode` / `part_no`.

- **Gating**: F11 `features.pos` (needs Maintain stock). Off → menus / Go To hide the screens, routes
  refuse (BUSINESS_RULE) except `pos.context`, a `posBill` on a voucher is a VALIDATION error. Turning it
  on creates (audited, once) the voucher types **POS Sales** (Sales, `config.posInvoice`, series `POS/`,
  Compact + MRP) and **POS Return** (Credit Note, `PR/`), the Cash tender and the system ledger **POS
  Exchange Credit** (Current Liabilities, `reserved_code POS_EXCHANGE`) with its exchange-credit mode.
  `VoucherTypeConfig.posInvoice` (extend-only, sales types; fixed once used) marks more POS types.
- **Posting**: a POS bill is an ordinary Sales voucher (a return a Credit Note) saved by
  `vouchers.save` with `VoucherInput.posBill` `{ tenders: [{ modeId, amount, reference?,
  exchangeVoucherId? }], cashTendered?, returnOfId?, counter? }`. The pos voucher hook (`adjust`, last
  static hook) debits (return: credits) each tender's ledger in the SAME voucher and reduces the party
  entry by the same total — Σ = 0, GST / stock / numbering unchanged; the unpaid part stays on the party
  with the usual bill-wise reference; a walk-in cash / bank party must be paid in full. `write` / `clear`
  rebuild `pos_bills` / `pos_payments` (date, affects_books, is_post_dated). Exchange credit issued by a
  return is used on later bills (checked against what is left); `beforeRemove` refuses to remove a bill
  with returns or a return whose credit was used. A return is capped by quantity AND value (per item:
  the bill's taxable value for that quantity; per note: the bill value not yet returned + ₹1 round-off
  slack). Alteration keeps what was built on a voucher true: a bill with returns cannot sell less than
  came back, change customer, move after its return or become optional; a return whose exchange credit
  was used cannot issue less or move after its use. `compose` re-attaches the saved POS block when a
  POS bill / return is altered without one (voucher entry, API), so tenders and the return link are
  re-checked instead of being lost. Post-dated returns / bills count at once for returnable quantity and
  used exchange credit. Confirm-level reminders: CGST Rule 46(e) (unregistered buyer, ≥ ₹50,000 taxable,
  without name / address of delivery), the cash-receipt limit (≥ ₹2,00,000 cash on one bill) and CGST
  s.34(2) (a return after 30 November following the year of the sale). Extension used (additive):
  `PostingAdjustContext.addEntry({ …, instrument? })` (card / UPI instrument on bank lines).
- **Routes** `pos.*`: context, settings get/save, tenderMode list/save/delete, item lookup/get, customer
  find/create, held list/save/recall/discard, return.context, exchange.open, voucher, summary, register.
  Existing permissions only (vouchers.* to bill / hold, masters.create for customers, company.manage
  for settings / tender modes, reports.view for the summary); every write audited.
- **UI**: Transactions › POS Counter / POS Return / Exchange, Reports › POS Day-end Summary, Masters ›
  POS Settings (all in Go To). Counter keys: scan box Enter (add / pay), ↑ ↓ + −, Ctrl+A payment, Alt+U
  customer, Alt+Q line, Ctrl+D remove line, Alt+F find item, Alt+O hold, Alt+L held bills, Alt+Z clear,
  Alt+P reprint, Alt+V view, Alt+T return, Alt+B summary, Alt+S settings. `vouchers.entry` hands POS
  types over to `pos.counter`; day-end summary rows drill (Enter) into the bills of that tender /
  cashier / counter (`pos.register` filters `modeId`, `userId` incl. null = no login, `counter`); voucher
  view panel (tenders, Alt+T return); print `PrintVoucherData.pos`
  ("Paid by", tendered, change) on Compact / Modern / Classic; receipts print off screen to the roll
  printer chosen on the computer (silent when chosen).

