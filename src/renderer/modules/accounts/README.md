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
with the typed name via `pushForResult` and selects the new ledger).

| Prop | Type | Notes |
|---|---|---|
| `value` | `number \| null` | Selected ledger id |
| `onChange` | `(id: number \| null, row: LedgerPickerRow \| null) => void` | `row` is null for a just-created ledger until the list refreshes |
| `onCommit?` | same signature | Enter on a selection; the key is consumed — move focus yourself. Omit to let Enter advance the form |
| `classes?` | `LedgerClassName[]` | Any of: `party debtor creditor cash bank cash_bank sales purchase duty_tax income expense asset liability` |
| `groupIds?` | `number[]` | Only these groups (and sub-groups) |
| `asOf?` | `'YYYY-MM-DD'` | Balance date (default today) — pass the voucher date |
| `showBalance?` | `boolean` (true) | Balance column |
| `allowCreate?` | `boolean` (true) | Offered only when the user has `masters.create` |
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
| `accounts.chart` | — | Chart of Accounts tree with closing balances as on the period end (Alt+F2), search, expand/collapse all, Alt+F5 detailed/condensed, Enter opens group/ledger form, Alt+C ledger / Alt+U group under the highlighted group, Alt+E/Alt+P |
| `accounts.ledger.list` | `{ chip?, search? }` | Virtualised ledger list, chips All/Parties/Cash & Bank/Sales/Purchase/Duties & Taxes/Income/Expense, closing balance, Enter alter, Alt+C create, Alt+B multiple, Ctrl+D delete (server explains; offers Deactivate), Alt+E/Alt+P |
| `accounts.ledger.form` | `{ id? \| initialName?, groupId?, forResult? }` | Single-page ledger form; sections by group class (below). Create = **Save & create next** (Ctrl+A, keeps the group) or Save & close (Alt+S); `forResult` = **Save & return** → `nav.pop({ id, name })`; alter: Save, Alt+D delete, Alt+L ledger report |
| `accounts.ledger.bulk` | — | Multiple ledger creation grid (name, under, opening Dr/Cr, GSTIN → state, state), per-row errors, all-or-nothing |
| `accounts.group.list` | — | Group tree with ledger counts; Enter alter, Alt+C create under highlighted, Ctrl+D delete |
| `accounts.group.form` | `{ id? \| initialName?, parentId?, forResult? }` | Group creation/alteration (nature only for primary groups, gross profit only for primary income/expense) |
| `accounts.costCentres` | — (feature `costCentres`) | Categories + centre tree, dialogs for create/alter, Ctrl+D delete |
| `accounts.currencies` | — (feature `multiCurrency`) | Currencies + exchange rates by date (upsert by date) |
| `accounts.voucherTypes` | — | Voucher types with numbering summary; Alt+C create based on highlighted |
| `accounts.voucherType.form` | `{ id? \| parentId? \| baseType? }` | Numbering with live preview + GST invoice-number checks, behaviour switches, defaults, printing |
| `accounts.openingBalances` | — | Dr/Cr totals, difference explained, ledgers with openings (Enter alters) |

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
the server applies, shown up front. Alter sends only changed fields (patch semantics); hidden
sections are cleared.

## Go To

`goto.ts` registers provider `ledgers` (replaces the shell built-in) over `accounts.ledger.list`
`{ search, limit: 8, withBalance }`: results open `reports.ledger { ledgerId }` when that screen is
registered, else `accounts.ledger.form { id }`.

## Pure logic (tested: `node --test "src/renderer/modules/accounts/**/*.test.ts"`)

`lib/groupClass.ts` (client classification = core `classFromChain`), `lib/ledgerSections.ts`,
`lib/ledgerDraft.ts` (draft ↔ DTO, defaults, validation, patch input), `lib/gstin.ts` (live GSTIN
autofill + registration rules), `lib/openingBills.ts` (sum check, row validation, index remap),
`lib/numbering.ts` (preview + GST number checks = core `checkNumbering`), `lib/chartTree.ts`,
`lib/ledgerFilters.ts` (chips, opening explanation), `lib/bulkRows.ts`, `lib/gotoItems.ts`.
