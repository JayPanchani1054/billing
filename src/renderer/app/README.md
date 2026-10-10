# Pevqori shell (`src/renderer/app`) — API for feature modules

The shell is everything around your screens: app state and routing, the company workspace (top
bar, screen bar with breadcrumbs and the command bar, screen stack, optional shortcut bar, status bar),
Home, navigation, global hotkeys, Go To, the
working date and period, the API client and cache, confirmations, export/print and error handling.
Feature modules plug in through a `ModuleDef` and build screens with the hooks below.

**Import everything from the barrel:**

```ts
import { Screen, ReportScreen, useNav, useApiQuery, useApiMutation, usePeriod } from '../../app/index.ts';
import { Button, DataTable, Field, TextInput } from '../../ui/index.ts';
```

Read `src/renderer/ui/README.md` for components. Never write raw colours; screens rarely need CSS at all.

---

## 1. Registering a module

`src/renderer/modules/<module>/index.ts` exports a `ModuleDef` (already listed in `modules/index.ts`):

```ts
import type { ModuleDef } from '../../app/index.ts';
import { LedgerForm } from './LedgerForm.tsx';
import { LedgerList } from './LedgerList.tsx';

export const accountsModule: ModuleDef = {
  id: 'accounts',
  screens: [
    { id: 'accounts.ledger.list', title: 'Ledgers', component: LedgerList, access: 'masters.view', goto: true },
    { id: 'accounts.ledger.form', title: 'Ledger', component: LedgerForm, access: 'masters.create' },
  ],
  menu: [
    { section: 'masters', label: 'Ledgers', screen: 'accounts.ledger.list', order: 20, keywords: ['accounts', 'party'], description: 'Customers, suppliers, banks, expenses' },
    { section: 'masters', label: 'Create Ledger', screen: 'accounts.ledger.form', order: 21 },
  ],
};
```

**ScreenDef**: `id` (`'<module>.<entity>[.<view>]'`, globally unique), `title` (Title Case), `component`
(receives `{ params }`), `access?: Permission`, `presentation?: 'full' | 'dialog'`, and (additive)
`goto?: true` (offer in Go To although no menu item points at it — only for screens that work without
params), `keywords?`, `feature?: keyof CompanyFeatures` (e.g. `'inventory'`), `gstOnly?`.
A screen the user may not open is refused with a toast; one whose feature is off says how to turn it on.

**MenuItem**: `section`, `label` (Title Case, short — it gets an accelerator letter), `screen`,
`params?`, `hotkey?` (display only — global keys belong to the shell, see §9), `keywords?`, `access?`,
`order?` (lower first), `gstOnly?`, and (additive) `feature?`, `description?` (tooltip on the
Gateway, second line in Go To), `voucherBaseType?` (a voucher-entry item for that predefined type:
hidden when the company deactivated it — `MenuContext.inactiveBaseTypes`, from
`hooks/useVoucherChoices.ts useInactiveBaseTypes`). Items inherit their screen's `access/feature/gstOnly`.

Busy company: a request refused only because another long task holds the company (`CONFLICT` with
`details.reason === 'busy'`, core `api/jobs.ts BUSY_DETAILS`) is recognised by `lib/apiErrors.ts
isBusyConflict`; screens offer "Wait and retry", which repeats the call with `retryWhileBusy` (every 2 s,
up to 2 minutes; Excel import and XML data import do).

Gateway sections, in display order: `masters`, `transactions`, `banking`, `utilities`, `reports`,
`inventory_reports`, `gst`, `data`, `security`, `company`. Accelerator letters (one per item, unique
across the whole Gateway, preferring each label's first letter) are assigned to the everyday screens
first (`GATEWAY_PRIORITY` in `lib/menu.ts`: Balance Sheet, P&L, Trial Balance, Day Book, Ledger, Stock
Summary, Receivables, Payables, GSTR-1/3B, BRS, Cash/Bank Books, Ledgers, Stock Items, Backup), then
to the rest in display order; a digit is the last resort (GSTR-3B → 3). Items with a `hotkey` (voucher
entry F4–F9…, F11, F12) get no letter — they already have a key. Labels must be unique across the
Gateway (Go To lists them side by side; `lib/gatewayLabels.test.ts` scans every module).

### Well-known screen ids (please register these exact ids)

| id | params | used by |
|---|---|---|
| `dashboard.home` | `{ embedded: true }` when shown inside the Gateway | Gateway right panel |
| `vouchers.entry` | `{ baseType: VoucherBaseType, voucherTypeId?: number, id?: number }` | F4–F9, Ctrl+F8/F9, Alt+F5/F6/F7/F8/F9, F10 picker (custom types pass `voucherTypeId`), Go To vouchers |
| `accounts.ledger.form` | `{ id?, initialName?, forResult? }` | Gateway quick action, dashboard "Get started", Go To ledgers (when the Ledger report is not allowed) |
| `accounts.ledger.list` | — | |
| `inventory.item.form` | `{ id?, initialName?, forResult? }` | Gateway quick action, Go To items |
| `reports.ledger` | `{ ledgerId }` | Go To ledgers (preferred when registered) |
| `vouchers.daybook`, `reports.balanceSheet`, `reports.profitLoss`, `reports.trialBalance` | — | Gateway quick actions (`WELL_KNOWN_SCREENS`) |

Until a screen is registered, opening it shows "This screen isn't available yet" — nothing crashes.
The company module owns `company.profile`, `company.features` (F11), `company.config` (F12, params
`{ tab?: 'invoice' | 'gst' | 'guards' | 'display' | 'backup' }`), `company.periodLock` (dialog),
`company.changePassword` (dialog), `company.about`, `company.shortcuts`. Invoice printing options
(`config.invoice`) have one editor, `print.settings`; F12 › Invoices shows a summary and links there.

**Onboarding** lives in one place: the dashboard's "Get started" card (`modules/dashboard/lib/model.ts`
`startSteps`: company details, features, invoice printing, ledgers, items, first sale, backups — each
done from the books via `dashboard.summary` `setup`, or ticked by the user; never by clicking it). Users
who may not open the dashboard see a one-line greeting on Home instead (2.0 removed the welcome panel).

**Home and Essentials (2.0).** Home (`app.gateway`, `Gateway.tsx`) shows *Essentials* or *All menus*
(Ctrl+1 / Ctrl+2, remembered in `lib/uiPrefs.ts`). Essentials is one central list in `lib/essentials.ts`
matched by **menu label** (or `vouchers.entry` base type): keep the labels it names stable, and when a new
everyday screen should be there, add it to that list — never a flag on the menu item. An item hidden from
All menus (F11, permission, registration, deactivated type) is hidden from Essentials too.

---

## 2. Screens

A screen is a component `({ params }: ScreenProps<P>) => ReactNode`. The shell wraps it in a hotkey
scope (active only while it is on top), an error boundary, and handles Esc / focus / breadcrumbs.

### `<Screen>` — forms, lists, settings

```tsx
<Screen
  title="Ledger Creation"            // h1 + breadcrumb + window title
  subtitle="Under Sundry Debtors"
  icon="ledger"
  width="form"                      // 'full' (default) | 'form' (≈960px column) | 'narrow'
  dirty={dirty}                     // Esc / switch company / window close ask before discarding
  hint="Enter Next field · Ctrl+A Save · Alt+C Create group"   // status bar line
  actions={[                        // command bar / shortcut bar; keys become screen hotkeys while on top
    { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: save, disabled: !dirty },
    { key: 'Alt+R', label: 'Make recurring', icon: 'refresh', onClick: recur, prominent: true }, // a button, not under More
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: remove, hidden: !id, group: 'danger' },
  ]}
  toolbar={<Button …/>}             // header buttons (optional)
  loading={q.loading} error={q.error} onRetry={q.refetch}   // skeleton / friendly error + Retry
  footer={<><Button onClick={() => void nav.back()}>Cancel</Button><Button variant="primary" shortcut="Ctrl+A" onClick={save}>Save</Button></>}
>
  …
</Screen>
```

### `<ReportScreen>` — reports with period, Export (Alt+E) and Print (Alt+P)

```tsx
<ReportScreen
  title="Trial Balance"
  periodMode="range"               // 'range' (Alt+F2 period chip) | 'asOn' ("As on <to>") | 'none'
  exportDef={() => ({ columns, rows, totals })}   // built on demand; omit to hide Export/Print
  filters={<SegmentedControl …/>}
  actions={[{ key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', onClick: toggle }]}
  loading={q.loading} refreshing={q.refreshing} error={q.error} onRetry={q.refetch}
>
  <DataTable autoFocus … />
</ReportScreen>
```

It shows company + title + period (click or Alt+F2 to change), the Export dialog (Excel / CSV /
PDF — press X, C or P) and Print, toasts "Saved … · Show in folder". Pass `period={…}` to show a
drilled-down range instead of the global period. Export and Print need the `data.export`
permission: without it both are disabled with a hint (`EXPORT_DENIED_HINT`), and the core refuses
and logs every format anyway (§8).

### Dialog screens

Register with `presentation: 'dialog'` and render `<DialogScreen title footer size>`; it is a Modal
wired to the stack (Esc/× → `nav.back()`, which asks if dirty). Close after success with
`nav.pop(result)`. Put dialog-only hotkeys (e.g. `Ctrl+A`) in a child component **inside**
`DialogScreen` so they bind to the dialog's own scope. A dialog screen is remounted (state lost) if a
full screen is pushed over it — prefer full screens for anything long.

---

## 3. Navigation

```ts
const nav = useNav();                       // stable identity; safe in deps
nav.push('accounts.ledger.form', { id: 7 });  // false + toast when refused (missing / no permission / feature off)
nav.replace('vouchers.entry', { baseType: 'sales' });   // swap the top screen (after save → fresh voucher)
nav.pop(result?);                            // close the top screen (programmatic: NO dirty prompt)
await nav.back();                            // what Esc does: asks when dirty; true when popped
await nav.popTo(index);                      // breadcrumbs; asks if any closed screen is dirty
await nav.reset();                           // back to the Gateway
nav.canOpen(id); nav.isRegistered(id); nav.screenDef(id); nav.getStack();
```

### Create-and-return (Alt+C from a picker)

```tsx
// In a voucher, the party Picker:
<Picker … onCreate={async (typed) => {
  const created = await nav.pushForResult<{ id: number; name: string }>('accounts.ledger.form', { initialName: typed });
  if (created) setParty(created);          // undefined when the user pressed Esc
}} />
```

**Convention for master forms:** accept params `{ id?: number; initialName?: string; forResult?: boolean }`.
When opened for a result (`params.forResult` / `useScreenResult().forResult`), label the save action
"Save & return" and, on successful create, call `nav.pop({ id, name })` (or
`useScreenResult().returnResult({ id, name })`). The value reaches only the `pushForResult` that
opened that exact stack entry; Esc, breadcrumbs, `reset`, `replace` or closing the company resolve
it with `undefined`.

```ts
const { forResult, returnResult, cancel } = useScreenResult<{ id: number; name: string }>();
```

### Per-screen hooks

| Hook | Purpose |
|---|---|
| `useScreenTitle(title)` | runtime title (breadcrumb, window title) — `<Screen>` does this |
| `useDirty(isDirty)` | unsaved work → Esc/F3/Ctrl+Q/window close ask first; also `pevqori.setDirty` |
| `useScreenActions(items)` | contribute actions (command bar, shortcut bar, F1 list) + register their keys (several components may contribute) |
| `useStatusHint(text)` | status bar hint while on top |
| `useScreen()` | `{ entry, index, isTop, visible, def }` |
| `useScreenResult()` | see above |

**Stack behaviour:** Home (`app.gateway`) is always at the bottom. Lower screens stay mounted and hidden
(state kept, so you return to where you were) — the 8 most recent; deeper ones unmount and remount when you return.
Hidden screens keep their queries subscribed but do **not** refetch while hidden: an invalidation
(e.g. after a voucher save) only marks their data stale, and they refetch once when shown again
(`screenVisibility.ts`, `lib/queryVisibility.ts`) — so a save never recomputes the Gateway dashboard
or drilled-down reports nobody is looking at.

**Focus rules:** on push the shell focuses `[data-autofocus]`, else the first editable field, else
the first grid (give a report's main `DataTable` `autoFocus` anyway), else the first tabbable, else
the heading. When the screen is still loading (skeleton) that first pick is provisional: the shell
watches the screen and moves focus to `[data-autofocus]` / the first field / the first grid as soon
as it renders, unless the user (any key or click) or the screen itself moved focus first (10 s at
most; `lib/initialFocus.ts`). So a master form that loads its pickers first still opens with the
cursor in Name. On pop, focus returns to the element that opened the screen. Don't steal focus later.

**Esc:** registered by the shell *outside* your screen's scope, so your handlers run first. Return
`false` from an `Escape` handler to let the shell go back; consume it to close something local.
Open pickers/menus/dialogs consume Esc themselves.

---

## 4. Data

```ts
const profile = await api('company.profile.get');             // typed from core routes (import type only)
await api('accounts.ledger.save', input);                     // rejects with ApiError(code, message, details)
const maybe = await apiOptional('x.y.z', input);              // untyped; for routes another module may not have shipped
if (isMissingRoute(err)) …                                    // code 'UNKNOWN_ROUTE'
```

`ApiError.code`: `VALIDATION` (details = `FieldIssue[]` → `fieldErrorsOf(err)` gives `{ path: message }`),
`BUSINESS_RULE`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, `UNAUTHENTICATED`, `LOCKED`, `NO_COMPANY`,
`UNKNOWN_ROUTE`, `INTERNAL`, plus client-only `BRIDGE_UNAVAILABLE`, `IPC_FAILED`. Show
`userMessage(err)` — never `String(err)`. UNAUTHENTICATED/NO_COMPANY from company routes refresh the
app state automatically (session expired → login screen).

### Queries

```ts
const q = useApiQuery('accounts.ledger.list', { search, limit: 50, offset }, { keepPrevious: true });
// q.data, q.loading (first load), q.refreshing (refetch with data shown), q.error, q.refetch(), q.isPrevious
useApiQuery('company.profile.get', {});            // routes without input take {}
useApiQuery('reports.ledger', { id }, { enabled: id !== null, staleTime: 60_000 });
```

Cached by route + input (key order doesn't matter), de-duplicated, stale-while-revalidate (default
staleTime 30 s). The cache is cleared when the company or user changes.

### Mutations

```ts
const save = useApiMutation('accounts.ledger.save');          // invalidates 'accounts.*' on success
const del = useApiMutation('vouchers.delete', { invalidates: ['reports', 'gst', 'outstanding'] });
try { const out = await save.mutate(input); } catch { /* save.error, save.fieldErrors */ }
invalidate('inventory');   // manual: prefix on '.' boundaries; invalidate() = everything
```

Mutations of one module often change others' reports — list them in `invalidates`.

### Business-rule warnings (needs confirmation)

A route that may proceed after the user accepts warnings fails with `BUSINESS_RULE` and details
`{ needsConfirmation: true, warnings: string[] }`, and accepts `acknowledgeWarnings: true` on retry:

```ts
const saved = await withConfirmation((ack) => save.mutate({ ...input, acknowledgeWarnings: ack || undefined }));
if (saved === undefined) return;   // user chose "Go back"
```

### Confirmations

```ts
const confirm = useConfirm();
if (!(await confirm({ title: 'Delete voucher Sales/42?', message: '…', confirmLabel: 'Delete', tone: 'danger' }))) return;
```

### Native

`native('dialog.openFile', {...})`, `useNative('dialog.chooseFolder')` — typed by `NativeActions`.
Never use `window.print`/`window.open`; use the export helpers or `native('print.*')`.

---

## 5. App state, permissions, company

```ts
const app = useAppState();     // { phase, state, company, session, can, refresh, applyState }
const company = useCompany();  // OpenCompanySummary (id, name, gstin, stateCode, booksFrom, fyStartMonth, gstEnabled, features)
const features = useFeatures();
const config = useCompanyConfig();   // CompanyConfig (F12) or undefined while loading
const canPost = useCan('vouchers.create');
```

After changing company-level data that `app.state` reports (profile name, features), call
`await app.refresh()`.

**Idle lock (secured companies).** `session.idleTimeoutMs` (0 = never) comes from the core. After
that long without keyboard/mouse input the shell calls `app.session.lock`; the server-side check
(UNAUTHENTICATED with reason `idle`) leads to the same place. The phase becomes `'locked'`
(`app.locked`): the workspace stays mounted but hidden and inert behind `LockScreen.tsx`, which covers
dialogs and toasts and fences every hotkey. While locked, `app.company`/`app.session` keep the locked
workspace's values (the server has no session). The same user logging in again resumes exactly
where they left off (unsaved entries included; visible queries refetch); anyone else gets a fresh
workspace; "Close the company" discards it. An explicit logout never locks (`lib/sessionLock.ts`).

---

## 6. Working date (F2) and period (Alt+F2)

```ts
const { date, setDate, openDialog, isToday } = useWorkingDate();   // default date for new vouchers
const { period, from, to, label, setPeriod, openDialog } = usePeriod();   // reporting range
const { booksFrom, fyStartMonth } = useBooks();
```

Per company: the working date defaults to today (never before the books begin) and is remembered for
the rest of the day; the period defaults to the current FY to date and is remembered until changed.
Pass `referenceDate={date}` to `DateInput` so shorthand ("5", "5-10") resolves against it.

---

## 7. Shell services

```ts
const shell = useShell();
shell.openVoucher('sales', { partyId });   // permission + feature checks, then push('vouchers.entry', { baseType, … })
shell.openVoucher('sales', { voucherTypeId: 40 });   // a company-defined type ("Sales - Export")
shell.voucherAvailability('sales_order');  // { ok, reason }
shell.openGoto('hdfc'); shell.openShortcuts(); shell.openVoucherPicker();
await shell.closeCompany(); await shell.logout(); await shell.quit();
```

### F10 and Go To voucher types

F10 lists the predefined types (with their F-keys) and then the company's own active types from
Masters › Voucher Types under their base type (`useVoucherChoices`, needs `masters.view`; falls back
to the predefined list). Go To offers the company's own types too; predefined ones come from the
vouchers module's Transactions menu (the shell's own voucher commands are only added when no module
registers `vouchers.entry`, so nothing is listed twice). Deactivated types are never offered.

### Automatic backup (F12 › Backup)

The shell calls `data.backup.auto` a few seconds after the workspace opens (`trigger: 'open'`) and
before F3 / Ctrl+Q close the company (`trigger: 'close'`, waited for at most 15 s with a
"Backing up…" toast); closing the window or quitting from Windows is covered by the core runtime's
shutdown. The core writes at most one per 24 hours. A written backup shows "Backed up
automatically"; a failure shows a warning with "Open Backup" (`lib/autoBackup.ts`).

### Go To providers

Add searchable masters/documents (results are merged and fuzzy-ranked with menu items):

```ts
registerGotoProvider({
  id: 'ledgers',            // replaces the shell's built-in provider with the same id
  label: 'Ledgers',
  minQuery: 2,
  screens: ['reports.ledger', 'accounts.ledger.form'],   // runs only for users who may open one of them
  search: async (q, signal) => (await api('accounts.ledger.list', { search: q, limit: 8 })).rows.map((l) => ({
    id: `ledger:${l.id}`, label: l.name, group: 'Ledgers', description: l.groupName,
    screen: 'reports.ledger', params: { ledgerId: l.id },
    fallback: { screen: 'accounts.ledger.form', params: { id: l.id } },   // when reports are not allowed
  })),
});
```

Register at module import time (top level of your `index.ts`) or in an effect. Failures are silent.

The palette drops results the user cannot open (`nav.canOpen(screen)`, else `fallback`), and skips a
provider whose `screens` are all forbidden (no API call). Recents are stored per company, not per user,
so they too are shown only when the current user can open them now (`usableRecents`: screen allowed,
voucher type enterable and still active). Built-ins (`ledgers`, `items`, `vouchers`)
call `accounts.ledger.list`, `inventory.item.picker` and `vouchers.list` with `{ search, limit }` and
are replaced by the accounts, inventory and vouchers modules' own providers.

### Go To catalogue for the end-to-end sweep

`e2e/screens.spec.ts` opens every item Go To offers instead of keeping its own list of screens. While
the palette is open it answers a `pevqori:goto-catalog` CustomEvent dispatched on `window`
(`lib/gotoCatalog.ts`): the listener writes `detail.catalog = { items, screens }` — the palette's own
static items (menu items, `goto: true` screens, voucher types, shell commands — already filtered by
permission, F11 features and GST registration) and every registered screen id / title / presentation.
It is read-only, adds nothing to `window` and calls no route. Each option also carries
`data-goto-id="<item id>"` so the spec can click exactly that item after typing its label. A new
screen is in the sweep as soon as Go To offers it; one that takes an id is reached by Enter on the
first row of its list, or is logged as not reached.

---

## 8. Export and print

```ts
const def: TableExportDef = {
  title: 'Day Book', subtitle: 'All vouchers', company: company.name, period: { from, to },
  columns: [{ header: 'Date', kind: 'date' }, { header: 'Particulars' }, { header: 'Debit', kind: 'amount' }, { header: 'Balance', kind: 'drcr' }],
  rows: [['2026-10-05', 'Sharma & Sons', 1180000, -1180000]],   // amounts in PAISE, dates ISO
  totals: ['', 'Total', 1180000, null],
  levels: [0],            // optional tree indent per row
  landscape: false,
};
await exportTable(def, 'xlsx' | 'csv');   // 'data.export.table' builds the file (permission + edit log)
await printReport(def);                    // 'data.export.audit' first, then the OS print dialog
await savePdf(def);                        // 'data.export.audit' first, then an A4 PDF via save dialog
```

Column kinds: `text | amount | drcr | qty | number | date | percent` (`decimals?`, `width?`). Every
value is HTML-escaped (`escapeHtml`); the print document is self-contained (no scripts, no external
resources) with company header, period, repeating table header, totals and "Page x of y".
`ReportScreen` does all of this for you from `exportDef`.

The data module implements `data.export.table`: input `{ title, subtitle?, company?, period?,
columns: { header, kind, width?, decimals? }[], rows, totals?, levels?, notes?, format: 'xlsx' | 'csv' }` →
`{ bytes: Uint8Array, fileName }`, and `data.export.audit` `{ title, subtitle?, period?, rows, format:
'pdf' | 'print' }` → `{ ok: true }`. **Excel, CSV, PDF and Print are all "export":** each needs the
`data.export` permission (checked by the core — a user without it gets FORBIDDEN) and writes an
`export` edit-log entry. CSV is never built in the renderer. Screens that print their own HTML
(e.g. a Statement of Account) call `data.export.audit` before printing.

---

## 9. Keyboard

### Global keys (reserved — don't bind these in screens)

| Key | Action |
|---|---|
| `F2` / `Alt+F2` | Working date / period |
| `F3` | Switch company (close it, back to the list) |
| `Ctrl+G`, `Alt+G`, `Ctrl+K` | Go To |
| `F4` `F5` `F6` `F7` `F8` `F9` | Contra, Payment, Receipt, Journal, Sales, Purchase |
| `Ctrl+F8` / `Ctrl+F9` | Credit Note / Debit Note |
| `Alt+F5` / `Alt+F6` | Sales Order / Purchase Order (need Order processing). Alt+F4 stays Windows' "close window". |
| `Alt+F8` / `Alt+F9` | Delivery Note / Receipt Note |
| `Alt+F7`, `Ctrl+F7` | Stock Journal, Physical Stock |
| `Ctrl+F6` / `Ctrl+F5` | Rejections In / Out (need Rejection notes) |
| `Ctrl+F10` | Memorandum |
| `F10` | Other vouchers (picker) |
| `F11` / `F12` | Features / Configuration |
| `F1`, `Ctrl+H` | Keyboard shortcuts |
| `Ctrl+Q` | Quit |

Global keys live on the root hotkey layer: they are fenced while any dialog/popover is open, and a
**screen-level binding of the same key wins** while the screen is on top (e.g. the voucher screen
may handle `F8` itself to switch the voucher type). The full list renders in the shortcuts overlay
(`GLOBAL_SHORTCUTS`, `reservedGlobalKeys()`).

### Command bar and shortcut bar (2.0)

Every screen's actions show in the screen bar's **command bar** (`lib/commandBar.ts` → `ui/CommandBar.tsx`):
the `primary` action as the filled button; up to 3 / 2 / 1 more buttons by width — first the actions you
mark `prominent: true` (declaration order), then Alter (Alt+A), Print (Alt+P), Share (Alt+W), Export
(Alt+E), More details (Ctrl+I), Create (Alt+C); everything else, then F11 / F12 (for users who may open them) / F1, under **More ▾**
with its key. Hidden actions never show; disabled ones show their `hint` in More. The command bar never
registers keys, so `prominent` changes only what is visible. Write `prominent` (and any new action field)
**after `onClick`** — never straight after `label` — or `lib/keyConventions.test.ts` cannot see the action.
The 1.0 right rail survives as the optional **shortcut bar** (user menu › *Show shortcut bar*).

**Ctrl+S** is an alias of **Ctrl+A** in the hotkey layer (`ui/lib/hotkeyRegistry.ts`): never bind Ctrl+S
in a screen; binding Ctrl+A is enough. The one exception is the kit's Yes/No `ConfirmDialog`, which takes
Ctrl+S and does nothing (`ui/lib/confirmKeys.ts`): a save reflex must never confirm "Discard changes".

### Screen conventions

One meaning per key in every module (`CONVENTION_SHORTCUTS` in `lib/shortcuts.ts`, shown by F1):

| Key | Meaning |
|---|---|
| `Enter` / `Shift+Enter` | next / previous field (`useEnterAdvance`); in lists: open / drill down |
| `Ctrl+A` | accept / save |
| `Ctrl+Enter` | leave a multi-line box |
| `Esc` | back (shell) |
| `Alt+C` | create (a master from a picker, or the screen's main "Create …") |
| `Alt+A` | alter the selected voucher / master (a tick list with nothing to alter — Print Cheques, E-payment File, Print batch, Reminders — ticks / unticks everything) |
| `Alt+D` | delete the master or voucher on screen (master lists also accept `Ctrl+D`) |
| `Ctrl+D` | remove the line (voucher and grid rows) |
| `Alt+N` / `Ctrl+N` | insert a line above |
| `Alt+2` | duplicate the voucher |
| `Alt+X` | cancel the voucher |
| `Alt+H` | edit history of the voucher / master on screen (`security.audit` record history) |
| `Alt+Enter` | view the voucher (read-only) |
| `Alt+M` | open the master of the report's subject (ledger, item) |
| `Alt+F1` | detailed / condensed |
| `Alt+X` (reports) | expand / collapse all — on vouchers `Alt+X` is cancel (always confirmed) |
| `Alt+C` (Balance Sheet, P&L) | comparison column ("New Column"); everywhere else `Alt+C` creates |
| `Ctrl+1` … `Ctrl+9` | switch view / tab |
| `Ctrl+F` | focus the screen's search box |
| `Alt+E` / `Alt+P` | export / print (need `data.export`); in voucher entry `Alt+P` prints the voucher altered or just saved |
| `Ctrl+P` | print the highlighted voucher (Day Book, voucher lists — `Alt+P` there prints the list) |

Screens must not bind `reservedGlobalKeys()` (the voucher screen's own F-keys and the documented
GST exceptions aside) — e.g. never `Alt+F5` (Sales Order). Action labels use the conventional accounting verbs ("Create
ledger", "Alter", "Delete"); hints read `<Key> <Capitalised action>` ("Alt+C Create Ledger", "Ctrl+A Save", "Enter Next field";
`lib/screenConventions.test.ts` checks every module's status-bar hints, labels and keys). Plain
letter keys are free for screen accelerators (ignored while typing). Put every action in the rail via
`actions` / `useScreenActions` so it is discoverable.

**Screens other modules extend share one key space.** `vouchers.view` and every module's
`voucherPanels` (documents Alt+V/O/S/R/L, attachments Alt+F, cheques Alt+K, POS Alt+T, forex Alt+Y,
TDS Alt+U, sharing Alt+W), voucher entry and the TDS / forex entry panels it renders, and the ledger /
stock item forms with the attachments rail action (Alt+F) never bind the same key twice;
`lib/keyConventions.test.ts` composes them from source (dialogs aside — they have their own scope) and
also checks that within one screen component a key has one meaning. A new panel picks a free key.

**Permissions: hidden, or disabled with the reason.** An action the user's role does not allow is
`hidden` (the core refuses anyway) — as in the voucher view. A form or settings screen the user may
only view keeps **Save** disabled with a `hint` naming the permission and shows `ReadOnlyNotice` (or a
"view only" banner); Export / Print stay visible, disabled with `EXPORT_DENIED_HINT`. Never leave a
permission-disabled action without either — a form's `readOnly` derived from `can…` flags counts
(`keyConventions.test.ts` checks the parity-wave modules). Name the permission exactly as Users & Roles
shows it (`core/modules/security/catalog.ts` labels: "Change company settings", "Prepare GST filings",
"Manage TDS/TCS setup" …; `lib/parityWiring.test.ts` checks every quoted name). Status-bar hints are
static and still name such actions — a known gap.

**F11 off ⇒ no trace.** A screen behind a feature declares `feature` / `anyFeature`; menu items inherit
it, Go To drops it, voucher panels render nothing and register no rail key while the feature is off
(even with cached data: derive the data as `on ? q.data : undefined`), a panel action that opens a
feature screen (e.g. Pre-close order → Order processing) is hidden while that feature is off, and Gateway
notices / dashboard cards check the feature before asking the core.
`lib/featureGating.test.ts` builds the real Gateway and Go To with every feature off (nothing of TDS /
TCS, forex, POS, manufacturing / job work; of cheques only Payee Bank Details and E-payment File) and
with each turned on, and checks both voucher-panel rules on the panels' source.

**Grids, tables and dates.** Every `DataTable` has an `aria-label`; hand-made `<table>`s in screens
too; every `DateInput` gets a `referenceDate` (the working date, or the date the field is about) so
"5" or "5-10" resolve as accountants expect (company settings dates aside); every report offers Export / Print
and focuses its main grid (`lib/screenA11y.test.ts` checks the parity-wave reports). Lists that hold editable cells (e.g. POS return quantities) wrap them in a
`useEnterAdvance` container so Enter moves from cell to cell and on to the next field.

---

## 10. Examples

### List screen

```tsx
export function LedgerList() {
  const nav = useNav();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 200);
  const q = useApiQuery('accounts.ledger.list', { search: debounced, limit: 200 }, { keepPrevious: true });
  const columns = useMemo<Column<LedgerRow>[]>(() => [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'groupName', header: 'Under', width: 200 },
    { key: 'closing', header: 'Closing balance', kind: 'drcr', width: 160 },
  ], []);
  return (
    <Screen title="Ledgers" error={q.error} onRetry={q.refetch}
      actions={[{ key: 'Alt+C', label: 'Create', icon: 'plus', primary: true, onClick: () => nav.push('accounts.ledger.form') }]}>
      <Stack gap={3}>
        <TextInput value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Search ledgers" aria-label="Search ledgers" />
        <DataTable aria-label="Ledgers" columns={columns} rows={q.data?.rows ?? []} getRowKey={(r) => String(r.id)}
          loading={q.loading} onRowActivate={(r) => nav.push('accounts.ledger.form', { id: r.id })}
          empty={<EmptyState title="No ledgers yet" body="Press Alt+C to create one." />} />
      </Stack>
    </Screen>
  );
}
```

### Master form (create / alter / create-and-return)

```tsx
export function LedgerForm({ params }: ScreenProps<{ id?: number; initialName?: string; forResult?: boolean }>) {
  const nav = useNav();
  const toast = useToast();
  const { forResult } = useScreenResult<{ id: number; name: string }>();
  const existing = useApiQuery('accounts.ledger.get', { id: params.id ?? 0 }, { enabled: params.id !== undefined });
  const [name, setName] = useState(params.initialName ?? '');
  const save = useApiMutation('accounts.ledger.save');
  const dirty = name !== (existing.data?.name ?? params.initialName ?? '');
  const submit = async () => {
    try {
      const out = await save.mutate({ id: params.id, name /* … */ });
      toast.success(`Ledger “${out.name}” saved`);
      nav.pop(forResult ? { id: out.id, name: out.name } : undefined);
    } catch { /* save.fieldErrors shown next to fields */ }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  return (
    <Screen title={params.id ? 'Ledger Alteration' : 'Ledger Creation'} width="form" dirty={dirty}
      loading={existing.loading} error={existing.error}
      actions={[{ key: 'Ctrl+A', label: forResult ? 'Save & return' : 'Save', primary: true, onClick: () => void submit() }]}>
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" required error={save.fieldErrors.name}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Screen>
  );
}
```

### Report

```tsx
export function TrialBalance() {
  const { from, to } = usePeriod();
  const nav = useNav();
  const q = useApiQuery('reports.trialBalance', { from, to }, { keepPrevious: true });
  const rows = q.data?.rows ?? [];
  return (
    <ReportScreen title="Trial Balance" loading={q.loading} refreshing={q.refreshing} error={q.error} onRetry={q.refetch}
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }],
        rows: rows.map((r) => [r.name, r.debit, r.credit]), levels: rows.map((r) => r.level),
      })}>
      <DataTable aria-label="Trial Balance" autoFocus columns={columns} rows={rows} getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level} isGroupRow={(r) => r.isGroup} expandable
        onRowActivate={(r) => r.ledgerId && nav.push('reports.ledger', { ledgerId: r.ledgerId })} />
    </ReportScreen>
  );
}
```

---

## 11. Files and tests

| File | What |
|---|---|
| `App.tsx`, `state.tsx`, `lib/appPhase.ts` | providers, top-level routing (no bridge → first run → login → company list → forced password → workspace); `CoreRestartNotice`: on the `core.restarted` command (main restarted a crashed core worker — nothing is open any more) shows an error toast and refreshes the app state |
| `LockScreen.tsx`, `lib/sessionLock.ts` | idle lock (phase `locked`): lock screen over the kept workspace, lock/resume rules |
| `Workspace.tsx`, `shell.tsx`, `lib/autoBackup.ts`, `lib/commandBar.ts`, `lib/createMenu.ts` | layout, top bar (company, Create ▾ — only what the user may create —, search, ⚙, ?, user menu), screen bar + command bar, optional shortcut bar, status bar; global hotkeys, menu commands, session keep-alive + idle timer, Lock, automatic backup |
| `nav.tsx`, `lib/navStack.ts`, `lib/initialFocus.ts`, `screenVisibility.ts` | stack, result delivery, per-screen hooks, initial focus, error boundary, DialogScreen |
| `api.ts`, `bridge.ts`, `queryClient.ts`, `hooks/*`, `lib/queryCache.ts`, `lib/queryVisibility.ts`, `lib/apiErrors.ts` | API client, cache (hidden screens wait), errors |
| `confirm.tsx` | useConfirm, withConfirmation |
| `working.tsx`, `lib/workingContext.ts` | working date & period |
| `Gateway.tsx`, `lib/menu.ts`, `lib/essentials.ts`, `wellKnown.ts` | Home: Essentials / All menus, accelerators, "Try the simpler Home", greeting |
| `lib/uiPrefs.ts`, `AppearancePanel.tsx` | per-user Home view and shortcut bar (`pevqori.ui`, upgrade detection); the Appearance panel (theme, density, Home view, shortcut bar) |
| `lib/emptyStates.test.ts` | every module DataTable has its own `empty` state (ratchet of the 2.0 baseline; the list may only shrink) |
| `GotoPalette.tsx`, `gotoProviders.ts`, `lib/goto.ts`, `lib/gotoItems.ts`, `lib/gotoCatalog.ts` | Go To (+ the catalogue the e2e sweep reads) |
| `ShortcutsOverlay.tsx`, `VoucherPicker.tsx`, `lib/shortcuts.ts`, `lib/voucherTypes.ts`, `hooks/useVoucherChoices.ts` | keyboard map, F1, F10 (predefined + company voucher types) |
| `Screen.tsx`, `export.ts`, `lib/exportFormat.ts`, `display.ts` | layout patterns, export/print, formatting |
| `lib/featureCatalog.ts`, `preferences.ts` | F11 feature texts & rules, theme/density |
| `lib/keyConventions.test.ts`, `lib/screenConventions.test.ts`, `lib/menuPositions.test.ts`, `lib/gatewayLabels.test.ts`, `lib/featureGating.test.ts`, `lib/screenA11y.test.ts`, `lib/parityWiring.test.ts` | conventions checked on the real module sources: keys, hints, menu positions and labels, F11 gating (menus, Go To, voucher panels), grid / table names, date shorthand, report export and focus, permission names, wiring of the parity-wave UX fixes |

Pure logic lives in `lib/*.ts` with `node:test` tests: `node --test "src/renderer/app/**/*.test.ts"`.
