# accounts — accounting masters core

Groups, ledgers, cost categories/centres, currencies/exchange rates, voucher types, the chart of
accounts, and the **books helpers** every report module uses.

DTOs: `src/shared/types/accounts.ts` · Routes: `routes.ts` · Migration: `src/core/db/migrations/030_accounts.ts`
(additive indexes only).

Conventions: money is integer paise, signed **Dr + / Cr −**. Period `debit` / `credit` totals are unsigned
magnitudes, so `closing = opening + debit − credit`. Dates are `'YYYY-MM-DD'`. Always pass
`today = ctx.clock.today()`.

---

## 1. `books.ts` — for reports, outstanding, banking, dashboard, GST, vouchers

```ts
import {
  BOOKS_FILTER, groupChain, primaryGroup, groupDescendantIds, groupCodeSet, loadGroupTree,
  ledgerClass, classFromChain, ledgerClassNames, ledgerBalance, closingBalances, groupBalances,
} from '../accounts/books.ts';
```

| Helper | Signature | Notes |
|---|---|---|
| `BOOKS_FILTER` | `(alias?: string) => string` | `"<a>.affects_books = 1 AND (<a>.is_post_dated = 0 OR <a>.date <= :today)"`. Works on `ledger_entries` (and any table with the same denormalised columns). **Bind `today`.** Throws on a non-identifier alias. |
| `groupChain` | `(db, groupId) => GroupNode[]` | Primary group → … → `groupId` (inclusive). NOT_FOUND for an unknown group. |
| `primaryGroup` | `(db, groupId) => GroupNode` | First element of the chain. |
| `groupDescendantIds` | `(db, groupId) => number[]` | The group **and** all sub-groups (recursive CTE). `[]` for an unknown id. |
| `groupCodeSet` | `(db, groupId) => Set<GroupCode>` | Reserved codes in the chain, e.g. `{CURRENT_ASSETS, SUNDRY_DEBTORS}`. |
| `loadGroupTree` | `(db) => GroupTree` | All groups in memory: `byId` (depth, `chainIds`, `path`, `codes`, `primaryCode`, `childIds`, `cls`, `classNames`), `rootIds`, `order` (depth-first display order, parents first). Use it when you need many classifications. |
| `ledgerClass` | `(db, ledgerId) => LedgerClass` | `{ isCash, isBank, isBankOd, isCashOrBank, isDebtor, isCreditor, isParty, isDutyTax, isSales, isPurchase, isIncome, isExpense, nature, affectsGrossProfit, primaryCode }`. `isBank` covers Bank Accounts **and** Bank OD A/c; `isBankOd` only the latter. `isIncome`/`isExpense` follow the group nature (Sales/Purchase Accounts included). |
| `classFromChain` | `(chain) => LedgerClass` | Pure version of the above. |
| `ledgerClassNames` | `(cls) => LedgerClassName[]` | `'cash' 'bank' 'cash_bank' 'party' 'debtor' 'creditor' 'sales' 'purchase' 'duty_tax' 'income' 'expense' 'asset' 'liability'` (LEDGER_CLASSES order). |
| `ledgerBalance` | `(db, ledgerId, { from?, to, today }) => LedgerBalance` | `{ opening, debit, credit, closing }`. `opening = ledgers.opening_balance + entries before from` (books filter). Without `from` the period starts at the books beginning. VALIDATION when `from > to`. |
| `closingBalances` | `(db, { asOf, today, ledgerIds? }) => Map<ledgerId, Paise>` | Opening + entries up to `asOf`, for the given ledgers or all. One query. |
| `groupBalances` | `(db, { from?, to, today, tree? }) => GroupBalances` | One aggregate query over `ledger_entries` grouped by ledger (covering index `idx_le_books`) + roll-up in JS. Returns `ledgers: Map<id, {ledgerId, groupId, opening, debit, credit, closing}>` (every ledger, also those without entries), `groups: Map<id, {opening, debit, credit, closing, closingDebit, closingCredit, ledgerCount}>` (every group, rolled up over all sub-groups), `total` (all ledgers; `total.closing` is the opening difference, 0 when the books balance), and the `tree` it used. **Trial Balance = this.** Closing stock is not included (reports add it). VALIDATION when `from > to`. |

Performance (10,000 ledgers, 200,000 entries, in-memory): picker ≈ 60 ms, `groupBalances` ≈ 85 ms.

## 2. Ledger services (`ledgers.ts`)

| Export | Signature | Notes |
|---|---|---|
| `isLedgerUsable` | `(db, ledgerId) => boolean` | **Vouchers team:** only active, existing ledgers may be used in NEW vouchers (and when adding a ledger to an altered voucher). |
| `assertLedgerUsable` | `(db, ledgerId) => void` | NOT_FOUND, or BUSINESS_RULE "Ledger 'X' is inactive and cannot be used in new vouchers. Alter the ledger and set Active to Yes …". |
| `ledgerInfo` | `(db, id) => LedgerInfo` | All master fields + `cls` + `classes`, no balances (2 queries). For posting validation. |
| `ledgerGstRateOn` | `(db, ledgerId, date) => LedgerGstRate \| null` | GST details in force on a date (latest `gst_rate_history` row ≤ date, else the master values — the same precedence as the posting engine's tax profile). `null` when GST is not applicable or no rate is defined (rate then comes from items / line overrides). The history never outlives the master's rate: turning GST off or clearing the rate removes it. |
| `getLedger` | `(db, id, today, tree?) => LedgerDetail` | Full detail incl. opening bills, GST history, closing balance (today), voucher count. |
| `saveLedger` | `(ctx, LedgerSaveInput) => LedgerDetail` | Create / alter (patch). Permission + audit inside. |
| `bulkCreateLedgers` | `(ctx, { rows }) => { created, ids }` | All-or-nothing; VALIDATION details `rows[i].<field>`. |
| `deleteLedger` | `(ctx, id) => DeleteResult` | Refuses with counts (see rules). |
| `ledgerUsage` | `(db, id) => LedgerUsage` | Vouchers/entries/bills/etc. referring to a ledger. |
| `otherLedgerReferences` | `(db, id) => {table, column, count}[]` | Rows in tables added by other modules that refer to the ledger through a foreign key (found from the schema). |
| `definesRate` | `(fields) => boolean` | GST applicable and a rate (or a non-taxable taxability) is set. |
| `listLedgers` / `ledgerPicker` | `(db, input, today)` | See routes. `resolveGroupFilter(tree, {groupIds, includeSubgroups, classes})` is exported too. |
| `getLedgerBalance` | `(db, {ledgerId, from?, to?}, today)` | VALIDATION when from > to. |
| `openingBalanceSummary` | `(db) => { totalDebit, totalCredit, difference, ledgerCount }` | Ledger openings only; reports add opening stock. |

Other services: `groups.ts` (`listGroups`, `getGroup`, `saveGroup`, `deleteGroup`), `costCentres.ts`
(`list/get/save/deleteCostCategory`, `list/get/save/deleteCostCentre`), `currencies.ts` (`listCurrencies`,
`getCurrency`, `saveCurrency`, `deleteCurrency`, `listExchangeRates`, `saveExchangeRate`, `deleteExchangeRate`,
`exchangeRateOn(db, currencyId, date)`, `EXCHANGE_RATE_LIST_MAX_LIMIT`), `voucherTypes.ts` (`listVoucherTypes`, `getVoucherType`,
`saveVoucherType`, `deleteVoucherType`, `checkNumbering(baseType, numbering, gstEnabled)`,
`parseVoucherTypeConfig(json)`), `chart.ts` (`chartOfAccounts(db, input, today)`).

Mutating services take a `CompanyCtx`, check permissions themselves (masters.create / masters.alter /
masters.delete; Owner holds all), run in `db.transaction` (nestable) and write `ctx.audit` with before/after
snapshots (`entityType`: `group`, `ledger`, `cost_category`, `cost_centre`, `currency`, `exchange_rate`,
`voucher_type`).

## 3. Routes

| Route | Input | Output | Access |
|---|---|---|---|
| `accounts.group.list` | `GroupListInput {includeCounts?, search?}` | `ListResult<GroupRow>` (tree order) | masters.view |
| `accounts.group.get` | `{id}` | `GroupDetail` | masters.view |
| `accounts.group.save` | `GroupSaveInput` | `GroupDetail` | create/alter* |
| `accounts.group.delete` | `{id}` | `DeleteResult` | masters.delete |
| `accounts.ledger.list` | `LedgerListInput` | `ListResult<LedgerListRow>` | masters.view |
| `accounts.ledger.picker` | `LedgerPickerInput` | `LedgerPickerRow[]` (all matches) | masters.view |
| `accounts.ledger.get` | `{id}` | `LedgerDetail` | masters.view |
| `accounts.ledger.save` | `LedgerSaveInput` | `LedgerDetail` | create/alter* |
| `accounts.ledger.delete` | `{id}` | `DeleteResult` | masters.delete |
| `accounts.ledger.bulkCreate` | `LedgerBulkCreateInput` | `LedgerBulkCreateResult` | masters.create |
| `accounts.ledger.balance` | `LedgerBalanceInput {ledgerId, from?, to?}` | `LedgerBalance` | masters.view |
| `accounts.openingBalances.summary` | none | `OpeningBalanceSummary` | masters.view |
| `accounts.costCategory.list/get/save/delete` | `{search?}` / `{id}` / `CostCategorySaveInput` / `{id}` | `ListResult<CostCategoryRow>` / `CostCategoryRow` / … | view / view / create-alter* / delete |
| `accounts.costCentre.list/get/save/delete` | `CostCentreListInput` / `{id}` / `CostCentreSaveInput` / `{id}` | `ListResult<CostCentreRow>` (tree order) / `CostCentreRow` / … | same |
| `accounts.currency.list/get/save/delete` | none / `{id}` / `CurrencySaveInput` / `{id}` | `ListResult<CurrencyRow>` / `CurrencyRow` / `CurrencyRow` / `DeleteResult` | view / view / create-alter* / delete |
| `accounts.exchangeRate.list/save/delete` | `ExchangeRateListInput {currencyId, from?, to?, limit?, offset?}` / `ExchangeRateSaveInput` (upsert by date) / `{id}` | `ListResult<ExchangeRateRow>` (newest first, paged) / `ExchangeRateRow` / `DeleteResult` | same (saving an existing date is an alter) |
| `accounts.voucherType.list/get/save/delete` | `{search?, activeOnly?}` / `{id}` / `VoucherTypeSaveInput` / `{id}` | `ListResult<VoucherTypeRow>` / `VoucherTypeDetail` / … | same |
| `accounts.chart` | `ChartInput {asOf?, includeLedgers?, activeOnly?}` | `ChartOfAccounts` (`activeOnly` keeps an inactive ledger that still has a balance, so group totals add up) | masters.view |

\* Save routes are declared with `masters.view` because one route both creates and alters; the service then
requires `masters.create` (no id) or `masters.alter` (id) and answers FORBIDDEN. List/picker/balance/chart run
with `transactional: false` (read-only).

**Save semantics.** No `id` = create (omitted fields take defaults). With `id` = alter: an omitted field keeps
its value, `null` clears it. Validation problems come back as one VALIDATION error whose `details` lists every
`{ path, message }` (e.g. `gstin`, `openingBills[1].billName`, `numbering.prefix`, `config.bankLedgerId`).

## 4. Rules enforced

**Groups.** Sub-groups take nature and "affects gross profit" from the parent (moving a group or changing a
primary group's nature updates the whole sub-tree). A new primary group needs a nature; only income/expense
primary groups may affect gross profit. Predefined groups: only alias, sort order and display flags change. No
cycles. Names/aliases unique across groups **and ledgers** (one name space, as in Tally; case-insensitive). A move
or nature change is refused when ledgers below would hold details their new group does not allow. Every sub-group
whose nature changes with a move gets its own audit row. Delete: not predefined, no sub-groups, no ledgers.

**Ledgers.**
- Name required; name and alias unique among ledgers, and neither may equal another ledger's name/alias **or a
  group's name/alias** (checked for new/changed values, so an old clash never blocks unrelated edits).
- Defaults on create (fields not given): parties keep bills when F11 bill-wise is on; ledgers under Sales/Purchase
  Accounts get "inventory values are affected" (inventory on) and GST applicable, taxable, rate from items (GST on),
  like the predefined Sales/Purchase ledgers. (Without this, accounting invoices with a new sales ledger were
  posted as non-GST.)
- Group must exist. Reserved ledgers (Cash, P&L, GST tax ledgers, …) keep their group and reserved code, stay
  active, keep their tax settings; they may be renamed.
- GSTIN: `validateGstin` (format, state, check character); state and PAN are filled from it when missing (also
  when a GSTIN is added later and state/PAN were not entered with it). A different state → error naming both;
  a PAN different from the PAN inside the GSTIN → error.
- Registration type: regular/composition/sez/uin/deemed export need a GSTIN; consumer/unregistered must not have one;
  overseas → state 96 (or blank → 96) and no GSTIN; state 96 only for overseas; UIN ↔ UIN-format number.
  Parties default to 'unregistered' (or 'regular' with a GSTIN); new parties default to the company's state.
  Removing the GSTIN of a 'regular' party (without choosing a type) makes it 'unregistered' again.
- PAN, IFSC, PIN (India only, not for overseas parties), e-mail, mobile (stored normalised), UPI, account number validated.
- Bank fields only under Bank Accounts / Bank OD A/c; tax fields (tax type, duty head, direction) only under
  Duties & Taxes (GST tax ledgers need a duty head); GST rate details only for income/expense (incl. sales/
  purchase) and fixed-asset ledgers. A value the caller enters in the wrong place is an error; a value merely
  carried over from the stored ledger (e.g. after moving a bank ledger) is cleared.
- GST details: rate must be a GST slab (`GST_RATES`) unless `allowNonStandardRate`; non-taxable → no rate/cess;
  HSN/SAC validated against the supply type (inferred from the code when missing); ITC eligibility and reverse
  charge only on the inward side; GST not applicable → rate details dropped.
- GST history (the posting engine reads it before the master columns, so it must agree with the master):
  - With `applicableFrom`: the GST fields given in the save are applied over the details **in force on that
    date** (or the earliest row) and written as a row from that date; later rows are kept. A back-dated HSN
    correction therefore keeps the rate that applied then. Nothing is written when the result is already in
    force on that date. Exempt → taxable without a rate takes the ledger's rate.
  - Without it: a change corrects the latest row (the first row starts at the books beginning).
  - GST turned off, rate cleared, or the ledger moved to a group without GST details: the history is removed
    (with `applicableFrom` this is refused — set the taxability from that date instead).
  - The master columns always mirror the latest row.
- Bill-wise: opening bills only with bill-wise on; Σ bills must equal the opening balance (message shows both
  amounts and the difference); bill dates on/before the books beginning; due ≥ bill date; references unique.
  An opening balance without bills is allowed (treated as on-account by outstanding).
- Opening stock: with inventory integrated (F11 inventory + integrate), a Stock-in-Hand ledger takes no opening
  balance — opening stock is the stock items' opening value (as in Tally); entering one is refused.
- Period lock: when the books are locked up to a date on/after the books beginning, entering or changing an
  opening balance or opening bills fails with LOCKED (they belong to the locked period).
- Credit limit ≥ 0, credit days 0–3650, interest rate 0–100 (required when interest is on); currency exists.
- Delete refused (BUSINESS_RULE, `details = LedgerUsage + otherReferences`) for predefined ledgers, ledgers used
  in vouchers (count in the message, suggests deactivating), bank statement lines, voucher-type defaults, the F12
  invoice bank, opening bills, a non-zero opening balance, or rows of any other module's table that refer to it
  by foreign key (found from the schema, named in the message).

**Voucher types.** Custom types are based on any type (`parentId`) or a base type (`baseType` → its predefined
type) and inherit base type, flags and config. Predefined: numbering/flags/config may change; not name, parent,
base type, active flag; never deleted. A custom type changes base type only while no vouchers use it (or types
based on it). Numbering: method automatic | automatic_override | manual | none; prefix/suffix ≤ 16; start ≥ 1;
width 0–9; restart yearly | monthly | never. For sales / credit note / debit note of a GST company the number
(prefix + digits + suffix) must fit 16 characters and use only A–Z a–z 0–9 / -, numbering cannot be 'none', and
automatic numbering cannot restart monthly (the prefix is fixed text, so numbers would repeat within the
financial year — GSTR-1 rejects duplicates); otherwise these are `numberingWarnings` (also: headroom < 6 digits,
manual numbering). When a custom type changes base type, the types based on it follow, each with an audit row.
Changing numbering never renumbers existing vouchers and does not touch `voucher_counters`. Config is a
key-level patch (null removes a key, unknown keys written by other modules are kept); changed keys are
validated: `defaultLedgerId` under Sales Accounts (sales-side types) / Purchase Accounts (purchase-side), not
allowed for other types; `defaultPartyLedgerId` a party or cash/bank ledger; `bankLedgerId` a bank ledger;
`invoiceMode` only for invoices; `defaultGodownId` exists; referenced ledgers must be active.
`stockJournalClass` (mfg module: `manufacturing` / `material_out` / `material_in`) only on stock journal
types, and fixed once vouchers of the type exist (renderer: Voucher Type form › Use as).

**Cost centres.** Parent in the same category (a new centre under a parent takes the parent's category when
none is given); no cycles; changing category moves the sub-tree (an audit row per moved sub-centre); delete only
without sub-centres and cost allocations. Categories: predefined one cannot be deleted; none with centres.

**Currencies.** Unique symbol / ISO code; base currency: ISO code fixed, cannot be deleted, no exchange rates.
Rates > 0, at least one of standard/selling/buying; saving the same date updates the row (needs masters.alter).
The list returns each currency's latest rate from one query.

## 5. Known gaps

- Dates before a ledger's first GST history row use the master (latest) values, the same precedence as the
  posting engine; keep the first row at the books beginning (the default) to avoid surprises.
- Party ledgers cannot hold bank details (spec: bank fields only under Bank Accounts / Bank OD A/c), so supplier
  e-payment details need a later addition.
- GST registration rules (GSTIN ↔ type ↔ state) also apply when the company's GST feature is off.
- Ledger delete finds other modules' references only through foreign keys; ids kept inside JSON settings of
  other modules (other than voucher-type config and the F12 invoice bank) are not seen.
- Voucher-number prefixes are fixed text (no month/year tokens), hence the monthly-restart rule for GST documents.
