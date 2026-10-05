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
| `ledgerBalance` | `(db, ledgerId, { from?, to, today }) => LedgerBalance` | `{ opening, debit, credit, closing }`. `opening = ledgers.opening_balance + entries before from` (books filter). Without `from` the period starts at the books beginning. |
| `closingBalances` | `(db, { asOf, today, ledgerIds? }) => Map<ledgerId, Paise>` | Opening + entries up to `asOf`, for the given ledgers or all. One query. |
| `groupBalances` | `(db, { from?, to, today, tree? }) => GroupBalances` | One aggregate query over `ledger_entries` grouped by ledger (covering index `idx_le_books`) + roll-up in JS. Returns `ledgers: Map<id, {ledgerId, groupId, opening, debit, credit, closing}>` (every ledger, also those without entries), `groups: Map<id, {opening, debit, credit, closing, closingDebit, closingCredit, ledgerCount}>` (every group, rolled up over all sub-groups), `total` (all ledgers; `total.closing` is the opening difference, 0 when the books balance), and the `tree` it used. **Trial Balance = this.** Closing stock is not included (reports add it). |

Performance (10,000 ledgers, 200,000 entries, in-memory): picker ≈ 60 ms, `groupBalances` ≈ 85 ms.

## 2. Ledger services (`ledgers.ts`)

| Export | Signature | Notes |
|---|---|---|
| `isLedgerUsable` | `(db, ledgerId) => boolean` | **Vouchers team:** only active, existing ledgers may be used in NEW vouchers (and when adding a ledger to an altered voucher). |
| `assertLedgerUsable` | `(db, ledgerId) => void` | NOT_FOUND, or BUSINESS_RULE "Ledger 'X' is inactive and cannot be used in new vouchers. Alter the ledger and set Active to Yes …". |
| `ledgerInfo` | `(db, id) => LedgerInfo` | All master fields + `cls` + `classes`, no balances (2 queries). For posting validation. |
| `ledgerGstRateOn` | `(db, ledgerId, date) => LedgerGstRate \| null` | GST details in force on a date (latest `gst_rate_history` row ≤ date, else the master values). `null` when GST is not applicable or no rate is defined (rate then comes from items / line overrides). |
| `getLedger` | `(db, id, today, tree?) => LedgerDetail` | Full detail incl. opening bills, GST history, closing balance (today), voucher count. |
| `saveLedger` | `(ctx, LedgerSaveInput) => LedgerDetail` | Create / alter (patch). Permission + audit inside. |
| `bulkCreateLedgers` | `(ctx, { rows }) => { created, ids }` | All-or-nothing; VALIDATION details `rows[i].<field>`. |
| `deleteLedger` | `(ctx, id) => DeleteResult` | Refuses with counts (see rules). |
| `ledgerUsage` | `(db, id) => LedgerUsage` | Vouchers/entries/bills/etc. referring to a ledger. |
| `listLedgers` / `ledgerPicker` | `(db, input, today)` | See routes. `resolveGroupFilter(tree, {groupIds, includeSubgroups, classes})` is exported too. |
| `getLedgerBalance` | `(db, {ledgerId, from?, to?}, today)` | VALIDATION when from > to. |
| `openingBalanceSummary` | `(db) => { totalDebit, totalCredit, difference, ledgerCount }` | Ledger openings only; reports add opening stock. |

Other services: `groups.ts` (`listGroups`, `getGroup`, `saveGroup`, `deleteGroup`), `costCentres.ts`
(`list/get/save/deleteCostCategory`, `list/get/save/deleteCostCentre`), `currencies.ts` (`listCurrencies`,
`getCurrency`, `saveCurrency`, `deleteCurrency`, `listExchangeRates`, `saveExchangeRate`, `deleteExchangeRate`,
`exchangeRateOn(db, currencyId, date)`), `voucherTypes.ts` (`listVoucherTypes`, `getVoucherType`,
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
| `accounts.currency.list/save/delete` | none / `CurrencySaveInput` / `{id}` | `ListResult<CurrencyRow>` / `CurrencyRow` / `DeleteResult` | same |
| `accounts.exchangeRate.list/save/delete` | `ExchangeRateListInput` / `ExchangeRateSaveInput` (upsert by date) / `{id}` | `ListResult<ExchangeRateRow>` / `ExchangeRateRow` / `DeleteResult` | same |
| `accounts.voucherType.list/get/save/delete` | `{search?, activeOnly?}` / `{id}` / `VoucherTypeSaveInput` / `{id}` | `ListResult<VoucherTypeRow>` / `VoucherTypeDetail` / … | same |
| `accounts.chart` | `ChartInput {asOf?, includeLedgers?, activeOnly?}` | `ChartOfAccounts` | masters.view |

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
cycles. Names/aliases unique across groups (case-insensitive). A move is refused when ledgers below would hold
details their new group does not allow. Delete: not predefined, no sub-groups, no ledgers.

**Ledgers.**
- Name required; name and alias unique among ledgers, and neither may equal another ledger's name/alias.
- Group must exist. Reserved ledgers (Cash, P&L, GST tax ledgers, …) keep their group and reserved code, stay
  active, keep their tax settings; they may be renamed.
- GSTIN: `validateGstin` (format, state, check character); state and PAN are filled from it when missing (also
  when a GSTIN is added later and state/PAN were not entered with it). A different state → error naming both;
  a PAN different from the PAN inside the GSTIN → error.
- Registration type: regular/composition/sez/uin need a GSTIN; consumer/unregistered must not have one;
  overseas → state 96 (or blank → 96) and no GSTIN; state 96 only for overseas; UIN ↔ UIN-format number.
  Parties default to 'unregistered' (or 'regular' with a GSTIN); new parties default to the company's state.
- PAN, IFSC, PIN (India only), e-mail, mobile (stored normalised), UPI, account number validated.
- Bank fields only under Bank Accounts / Bank OD A/c; tax fields (tax type, duty head, direction) only under
  Duties & Taxes (GST tax ledgers need a duty head); GST rate details only for income/expense (incl. sales/
  purchase) and fixed-asset ledgers. A value the caller enters in the wrong place is an error; a value merely
  carried over from the stored ledger (e.g. after moving a bank ledger) is cleared.
- GST details: rate must be a GST slab (`GST_RATES`) unless `allowNonStandardRate`; non-taxable → no rate/cess;
  HSN/SAC validated against the supply type (inferred from the code when missing); ITC eligibility and reverse
  charge only on the inward side; GST not applicable → rate details dropped.
- GST history: when rate/cess/HSN/taxability change, `applicableFrom` writes an effective-dated
  `gst_rate_history` row (history kept); without it the latest row is corrected (the first row starts at the
  books beginning). The master columns always mirror the latest row.
- Bill-wise: opening bills only with bill-wise on; Σ bills must equal the opening balance (message shows both
  amounts and the difference); bill dates on/before the books beginning; due ≥ bill date; references unique.
  An opening balance without bills is allowed (treated as on-account by outstanding).
- Credit limit ≥ 0, credit days 0–3650, interest rate 0–100 (required when interest is on); currency exists.
- Delete refused (BUSINESS_RULE, `details = LedgerUsage`) for predefined ledgers, ledgers used in vouchers
  (count in the message, suggests deactivating), bank statement lines, voucher-type defaults, the F12 invoice
  bank, opening bills or a non-zero opening balance.

**Voucher types.** Custom types are based on any type (`parentId`) or a base type (`baseType` → its predefined
type) and inherit base type, flags and config. Predefined: numbering/flags/config may change; not name, parent,
base type, active flag; never deleted. A custom type changes base type only while no vouchers use it (or types
based on it). Numbering: method automatic | automatic_override | manual | none; prefix/suffix ≤ 16; start ≥ 1;
width 0–9; restart yearly | monthly | never. For sales / credit note / debit note of a GST company the number
(prefix + digits + suffix) must fit 16 characters and use only A–Z a–z 0–9 / - and numbering cannot be 'none';
otherwise these are `numberingWarnings` (also: headroom < 6 digits, monthly restart, manual numbering).
Changing numbering never renumbers existing vouchers and does not touch `voucher_counters`. Config is a
key-level patch (null removes a key, unknown keys written by other modules are kept); changed keys are
validated: `defaultLedgerId` under Sales Accounts (sales-side types) / Purchase Accounts (purchase-side), not
allowed for other types; `defaultPartyLedgerId` a party or cash/bank ledger; `bankLedgerId` a bank ledger;
`invoiceMode` only for invoices; `defaultGodownId` exists; referenced ledgers must be active.

**Cost centres.** Parent in the same category; no cycles; changing category moves the sub-tree; delete only
without sub-centres and cost allocations. Categories: predefined one cannot be deleted; none with centres.

**Currencies.** Unique symbol / ISO code; base currency: ISO code fixed, cannot be deleted, no exchange rates.
Rates > 0, at least one of standard/selling/buying; saving the same date updates the row.
