# accounts — accounting masters UI

Screens for groups, ledgers, opening balances, cost centres, currencies and voucher types, the
Go To `ledgers` provider, and **reusable pickers other modules may use**. Core API:
`src/core/modules/accounts/README.md`; DTOs: `src/shared/types/accounts.ts`.

## Reusable exports (stable API)

Import from the module barrel:

```ts
import { LedgerPicker, useLedgerPicker, GroupPicker, useGroups, groupTrail } from '../accounts/index.ts';
```

### `<LedgerPicker>`

Type-ahead ledger picker (ui `Picker`) over `accounts.ledger.picker`, grouped by ledger group, with
the closing balance (Dr/Cr) on the right and "+ Create" / **Alt+C** (opens `accounts.ledger.form`
with the typed name via `pushForResult` and selects the new ledger). When `classes` point to one
group (`lib/groupClass.ts › groupCodeForClasses`), the form opens under it (`groupCode` param) with
that group's defaults — the voucher screen's own ledger picker does the same per slot
(`vouchers/lib/masters.ts › createGroupCode`).

| Prop | Type | Notes |
|---|---|---|
| `value` | `number \| null` | Selected ledger id |
| `onChange` | `(id: number \| null, row: LedgerPickerRow \| null) => void` | `row` is null for a just-created ledger until the list refreshes |
| `onCommit?` | same signature | Enter on a selection; the key is consumed — move focus yourself. Omit to let Enter advance the form |
| `classes?` | `LedgerClassName[]` | Any of: `party debtor creditor cash bank cash_bank sales purchase duty_tax income expense asset liability` |
| `groupIds?` | `number[]` | Only these groups (and sub-groups) |
| `asOf?` | `'YYYY-MM-DD'` | Balance date (default today) — pass the voucher date |
| `showBalance?` | `boolean` (true) | Balance column |
| `allowCreate?` | `boolean` (true) | Offered only when the user has `masters.create`. With one unambiguous class (`['debtor']`, `['creditor']`, `['bank']`, `['cash']`, `['sales']`, `['purchase']`, `['duty_tax']`) the ledger form opens under that group |
| `includeInactive?` | `boolean` (false) | Inactive ledgers cannot be used in new vouchers |
| `excludeIds?` | `number[]` | e.g. the other side of a contra |
| `groupByGroup?` | `boolean` (true) | Section headers by group |
| `placeholder`, `disabled`, `readOnly`, `invalid`, `required`, `autoFocus`, `size`, `emptyText`, `id`, `aria-label`, `ref` | | passed to the Picker |

### `useLedgerPicker(options)`

`{ classes?, groupIds?, asOf?, includeInactive?, enabled? }` → `{ rows: LedgerPickerRow[], byId: Map, loading, error, refetch }`.
Cached (`useApiQuery`) and refreshed automatically after any `accounts.*` mutation.

### `<GroupPicker>` / `useGroups()`

`<GroupPicker value={groupId} onChange={(id, row) => …} />` — groups in tree order with their
parent trail on the right; Alt+C opens `accounts.group.form` for a result. Props: `value`,
`onChange`, `onCommit?`, `allowCreate?` (true), `excludeSubtreeOf?` (a group cannot move under
itself), `filter?(row)`, plus the usual input props. `useGroups({ includeCounts? })` →
`{ rows: GroupRow[], byId, loading, error, refetch }`. `groupTrail(row)` → `"Current Assets › Sundry Debtors"`.

## Screens

| id | params | What |
|---|---|---|
| `accounts.chart` | — | Chart of Accounts tree with closing balances as on the period end (Alt+F2), search, expand/collapse all, Alt+F1 detailed/condensed, Enter opens group/ledger form, Alt+C ledger / Alt+U group under the highlighted group, Alt+E/Alt+P |
| `accounts.ledger.list` | `{ chip?, search? }` | Virtualised ledger list, chips All/Parties/Cash & Bank/Sales/Purchase/Duties & Taxes/Income/Expense, closing balance, Enter alter, Alt+C create, Alt+B multiple, Alt+D delete (Ctrl+D also works; server explains; offers Deactivate), Alt+H edit history, Alt+T chart of accounts, Alt+E/Alt+P |
| `accounts.ledger.form` | `{ id? \| initialName?, groupId? \| groupCode?, forResult? }` | Single-page ledger form; `groupCode` is a reserved group code (`SUNDRY_DEBTORS`, `BANK_ACCOUNTS`, …) for callers without group ids (voucher pickers, Banking) — the form opens under that group with its defaults; sections by group class (below). Create = **Save & create next** (Ctrl+A, keeps the group) or Save & close (Alt+S); `forResult` = **Save & return** → `nav.pop({ id, name })`; alter: Save, Alt+D delete, Alt+L ledger report, Alt+H edit history |
| `accounts.ledger.bulk` | — | Multiple ledger creation grid (name, under, opening Dr/Cr, GSTIN → state, state), per-row errors, all-or-nothing |
| `accounts.group.list` | — | Group tree with ledger counts; Enter alter, Alt+C create under highlighted, Alt+D (or Ctrl+D) delete, Alt+H edit history, Alt+T chart of accounts |
| `accounts.group.form` | `{ id? \| initialName?, parentId?, forResult? }` | Group creation/alteration (nature only for primary groups, gross profit only for primary income/expense); alter: Alt+D delete, Alt+H edit history |
| `accounts.costCentres` | — (feature `costCentres`) | Categories + centre tree, dialogs for create/alter, Alt+D (or Ctrl+D) delete |
| `accounts.currencies` | — (feature `multiCurrency`) | Currencies + exchange rates by date (upsert by date); Alt+D (or Ctrl+D) delete |
| `accounts.voucherTypes` | — | Voucher types with numbering summary; Alt+C create based on highlighted, Alt+D (or Ctrl+D) delete |
| `accounts.voucherType.form` | `{ id? \| parentId? \| baseType? }` | Numbering with live preview + GST invoice-number checks (alter: Alt+D delete, Alt+H edit history), behaviour switches, defaults, printing. A new type starts its own series (parent's method/padding/restart, no prefix, from 1 — as the core does) and the form warns when another active type of the same GST document kind issues identical numbers. The Numbering group links to Invoice Numbering |
| `accounts.numbering` | — | **Invoice Numbering** (2.0; Company menu, Home Essentials, Settings hub, Go To): every number series on one screen — see below |
| `accounts.openingBalances` | — | Dr/Cr totals, difference explained, ledgers with openings (Enter alters). With integrated inventory the opening stock is read from `reports.trialBalance` (as on the books beginning) when the user may view reports, and included in the difference |

### Invoice Numbering (`NumberingScreen.tsx`, 2.0 — docs/ARCHITECTURE.md "Invoice numbering and renumbering (2.0)")

A focused facade over the voucher types' numbering; the Voucher Type form keeps every option.

- **List** (treegrid "Number series"): group rows *Invoices & notes* (GST-numbered base types:
  sales, credit / debit notes) then *Other vouchers* (collapsed; →/← or Enter on the group row);
  columns Series · Example (today) · Restarts · Next no. · Vouchers this period. Data:
  `accounts.voucherType.list` + one `accounts.voucherType.numberingStatus { date }` (staleTime 0 —
  vouchers saved elsewhere move the next numbers). Enter / **Alt+A** edit · **Alt+C** Create series
  (based on the highlighted row; the predefined Sales type when a group row is highlighted) · **Alt+H**
  edit history (`security.audit`, voucher_type) · toolbar button *Voucher Types* (`accounts.voucherTypes`).
- **Editor** (`SeriesDrawer`, modal drawer, md): prefix / suffix with token chips inserted at the caret
  the field had when it lost focus (`insertToken`; refused past 16 characters as typed; each chip's
  accessible name starts with its visible text, e.g. "FY 26-27 (insert {FY})"), Digits (0–9), Start at, the switch
  "Start again from the first number every financial year" (on ⇒ `yearly`, off ⇒ `never`), Advanced:
  "Start again every month" (`monthly`) with the one-click month fix (`monthFix`), the method radio,
  "More options…" → `accounts.voucherType.form { id }` (asks to discard unsaved changes first). Next number (alteration of an automatic series;
  read-only without `vouchers.renumber`, with the reason) + **Set** (`setNextNumber` alone, when the
  scheme is unchanged). Preview = `describeScheme` (today, first number of the next FY, longest
  length) with the next sequence of `previewNextSeq` — the number the core gives after the save (a typed
  next number; a changed starting number lifts or releases it); after a restart change the counter of
  the new period is seeded from the numbers already used on save, so the preview says "the next number
  is worked out when you save" and the saved toast reads the real one (`numberingStatus { ids }`); checks = `checkNumberingScheme` + `seriesClashes`; the FY-uniqueness note for a GST series
  that never restarts; Gaps of the financial year (`accounts.voucherType.numberGaps`, vouchers.view;
  **Show** lists ≤ 200). An alteration opens once the series' status is current (not mid-refetch).
- **Save** (Ctrl+A / Ctrl+S; masters.alter, else view only): `accounts.voucherType.save { id,
  numbering }` with only the changed keys (`numberingPatch`; dated rows never sent), asking first when
  the type already has vouchers; then `accounts.voucherType.setNextNumber` when the next number was
  changed — its confirm warnings (skipped numbers, lowering below a used number) are listed in a
  "Set the next number?" dialog and resent with `acknowledgeWarnings`. Create series =
  `accounts.voucherType.save { parentId, name, numbering }` (the parent's method / digits / restart,
  never its prefix or dated rows); the new type is entered with F10.
- **Esc** closes the drawer, asking "Discard the changes to this series?" when something changed (the
  screen is marked dirty meanwhile).

### Ledger form sections (`lib/ledgerSections.ts`, mirrors the core placement rules)

| Section | Shown when |
|---|---|
| Basic (name, alias, under, active, currency*, notes) | always (*F11 multi-currency) |
| Opening balance (AmountInput Dr/Cr) | always; replaced by a note for Stock-in-Hand with integrated inventory |
| Bill-wise switch + opening bills grid (live "bills total vs opening") | F11 bill-wise and a party (or the ledger already keeps bills) |
| Party details + GST registration (live GSTIN checksum, fills state/PAN/type) | Sundry Debtors / Creditors |
| Bank details (IFSC/UPI/account validation) | Bank Accounts / Bank OD A/c |
| Tax ledger (type, duty head, direction) | Duties & Taxes (locked for built-in tax ledgers) |
| GST details (applicable, taxability, slab rate / notified rate, cess, HSN/SAC, goods/services; ITC + reverse charge for inward; assessable value for charges; "applies from" date + history table) | company GST on and income / expense / fixed-asset ledgers |
| Other settings (cost centres, inventory values affected, TDS) | by F11 feature and class |

Defaults for new ledgers (`applyGroupDefaults`): parties keep bills (F11) and start in the company
state; Sales/Purchase ledgers are GST-applicable, taxable, inventory-affecting — the same defaults
the server applies, shown up front. They are applied whenever the chosen group's class becomes
known, also for a group just created with Alt+C. The opening balance (and each bulk row) starts on
the usual side of the group: Cr for suppliers, capital, loans and income.

Alter sends only changed fields (patch semantics: omitted keeps, `null` clears). Hidden is not
cleared: bank/tax/GST-rate fields are cleared only when the group does not allow them; party
details only on create; nothing hidden merely because an F11 feature or company GST is off.

Form behaviour worth knowing:
- GSTIN can be typed for an Unregistered/Consumer party too — a valid GSTIN fills state and PAN and
  makes the party Regular (UIN → UIN holder); clearing a Regular party's GSTIN makes it Unregistered.
- "These GST details apply from" appears only when an existing rate is replaced (`gstHistoryEffect`
  = `'dated'`). Clearing the rate or turning GST off removes the dated history on the server; the form
  warns and suggests a dated taxability change instead.
- Opening bills must add up to the opening balance (checked live and before saving); Enter on the
  blank last row's bill number leaves the grid.
- A failed save focuses the first invalid field (client or server error).

## Go To

`goto.ts` registers provider `ledgers` (replaces the shell built-in) over `accounts.ledger.list`
`{ search, limit: 8, withBalance }`: results open `reports.ledger { ledgerId }` when that screen is
registered, else `accounts.ledger.form { id }`.

## Pure logic (tested: `node --test "src/renderer/modules/accounts/**/*.test.ts"`)

`lib/groupClass.ts` (client classification = core `classFromChain`), `lib/ledgerSections.ts`,
`lib/ledgerDraft.ts` (draft ↔ DTO, defaults, validation, patch input), `lib/gstin.ts` (live GSTIN
autofill + registration rules), `lib/openingBills.ts` (sum check, row validation, index remap),
`lib/numbering.ts` (preview + GST number checks = core `checkNumbering`; the GST constants come
from `shared/numbering.ts`; 2.0: the Invoice Numbering list rows, token chips and caret insert,
restart switches, month fix, FY-uniqueness note, draft ↔ key-level patch, next-number checks, preview,
confirm warnings, gaps summary), `lib/chartTree.ts`,
`lib/ledgerFilters.ts` (chips, opening explanation), `lib/bulkRows.ts`, `lib/gotoItems.ts`.

`lib/coreContract.test.ts` drives the ledger form model and the numbering mirror against the real
accounts core on an in-memory company (untouched forms send nothing; created/altered ledgers
round-trip; client and server refuse the same inputs). It is the only file here that imports core
at runtime, and it is a test — screens use `import type` only.

## Known gaps

- Nothing is rendered locally (bundling/rendering runs in CI): layout and focus order need a visual check.
- Go To opens `reports.ledger` when registered even for a user without `reports.view` (the shell then
  refuses with a toast); the provider has no access to the session's permissions.
- Cost centre, cost category, currency and exchange-rate forms are dialogs (no dirty prompt on Esc).
- The GST nature override is not editable (its stored value is kept).
- The ledger list loads up to 10,000 ledgers per query; groups are not paged.
