# Inventory masters UI (`src/renderer/modules/inventory`)

Screens for stock items, stock groups, stock categories, units, godowns and price lists, and the
pickers other modules (vouchers, stock reports) use to choose items, godowns, units and batches.
Everything is hidden when the company's **Inventory** feature (F11) is off; godowns also need
**Multiple godowns** and price lists need **Price levels**.

Core API: `src/core/modules/inventory/README.md`, DTOs: `src/shared/types/inventory.ts`.

## Screens

| id | params | what |
|---|---|---|
| `inventory.item.list` | `{ groupId?, categoryId? }` | Stock Items: server search (name, alias, part no., barcode), group filter, category filter (only when a category exists or `categoryId` is given), stock as on the working date (in the column header), virtualised table that hides columns blank on every row (exports keep them). Title row: the count · **Create stock item** (Alt+C, the one button) · More ▾: Create several (Alt+M, **Alt+B** alias), Delete (Alt+D / Ctrl+D), Print (Alt+P), Export (Alt+E). Enter alters |
| `inventory.item.form` | `{ id? \| initialName?, forResult?, groupId? }` | Stock Item Creation / Alteration — one flat column (below). Ctrl+A = the title row's one filled button (`lib/itemEssentials.ts › itemFormActions`): create — **Save & create next** (the same label, and so accessible name, as the ledger form), the form stays for the next item, keeping group, unit and GST; alter — **Save**, saves and goes back; `forResult` — **Save & return** → `pop({ id, name })`. More ▾: Save & close (Alt+S, create only), More details (**Ctrl+I**, **Alt+F1**), Price lists (Alt+L), Edit history (Alt+H), Delete (Alt+D); Alt+F attachments. Context run: alteration = the stock group (or Primary) · "Inactive" |
| `inventory.item.bulk` | `{ groupId? }` | Multiple Stock Items grid of goods (name, alias, group, unit, HSN, GST %, selling price, opening qty/rate/value). Enter on an empty name finishes; all rows are created or none. Opening cells are read-only (with a note) while the books are locked from the books beginning |
| `inventory.group.list` / `inventory.group.form` (dialog) | form: `{ id? \| initialName?, forResult?, parentId? }` | Stock groups as a tree; GST details with dated history (a wrong row can be removed) |
| `inventory.category.list` / `inventory.category.form` (dialog) | same | Stock categories (tree) |
| `inventory.unit.list` / `inventory.unit.form` (dialog) | form: `{ id? \| initialName?, forResult?, kind?: 'simple' \| 'compound' }` | Simple units (symbol, formal name, UQC suggested from the symbol, decimals) and compound units ("1 Box = 12 Nos") |
| `inventory.godown.list` / `inventory.godown.form` (dialog) | form: `{ id? \| initialName?, forResult?, parentId? }` | Godowns (tree); Main Location cannot be deleted or marked third-party. With Job work on (F11), "Whose stock" (own / our stock with third party / third-party stock with us) and the job worker or principal replace the third-party switch (mfg module) |
| `inventory.priceList` | `{ priceLevelId?, itemId?, date? }` | Price level + applicable-from date → per-item quantity slabs (from / up to / rate / discount) with live overlap check; Alt+C create level, Alt+R rename |

### 2.1 layout ("calm", SPEC-21 §1.7–1.8)

- **Lists** (`ItemList.tsx`, `TreeMasterList.tsx` for groups / categories / godowns, `Units.tsx`): the
  title row's context run is the count ("4 items", "12 stock groups"); the one visible action is
  "Create …" (`prominent`, Alt+C — secondary, never filled); Print and Export are demoted to More ▾
  (`ReportScreen outputInMore`, keys kept), as are Create several (Alt+M / Alt+B), Create under selected
  (Alt+Shift+C), Create compound unit (Alt+U), Items in group / category (Alt+I) and Delete. The
  actions come from `lib/listActions.ts`. Type columns are plain words ("Compound", "Main location",
  "Third party"; "Simple" / "Own" muted); "inactive" and "service" are muted words after an item's name.
  Empty states are one line with a link-style action.
- **Stock Item form** (`ItemForm.tsx`, `lib/itemEssentials.ts`): "Label : value" rows. Essentials —
  Name, Unit, Under, *Set GST details here* (*No — inherit*) with the GST rate and HSN/SAC
  ("Applicable from" only while you change the GST details — `lib/gstDraft.ts › showApplicableFrom`), Selling price, Barcode when POS is on — then the
  opening stock grid (goods), then the **More details** line (`ui/Disclosure.tsx`, Ctrl+I, Alt+F1 alias)
  over the rest: aliases, part no., barcode, description, category, service switch, alternate unit,
  Active, taxability / cess / rate history (`GstFields part="details"`), prices include GST, MRP,
  purchase price, costing method (Standard cost only for that method or while it holds a figure),
  reorder, batches, the price-level summary. The section opens by itself when a field inside holds a
  value other than its default or has an error (`itemDetailsForced`, over `ui/lib/disclosure.ts`), so
  an alteration never hides data; otherwise its state is remembered in `pevqori.ui` `moreDetails.stockItem`
  (`setMoreDetailsOpen`); while it is held open Ctrl+I jumps between the line and its first field
  instead (`detailsToggle`). The collapsed region is `hidden`, so Enter and Tab skip its fields. Field
  hints show on focus (facts that apply — "Cannot change: the item is used in vouchers", where an
  inherited rate comes from — stay visible). No footer: Cancel = Esc / ‹.
- **Multiple Stock Items** and **Price Lists**: one filled Save in the title row (Ctrl+A), no footer.

The stock group, category, unit and godown dialog forms share the master-form keys: Ctrl+A save, Alt+D delete, and in alteration **Alt+H edit history** — the record's history in the Edit Log (`security.audit` `{ entityType: 'stock_group' | 'stock_category' | 'unit' | 'godown', entityId, entityGuid, label }`, `common.tsx › useMasterHistory`, `lib/history.ts`; needs the Edit Log permission).

All master forms follow the shell convention for create-and-return: opened with
`nav.pushForResult('<form id>', { initialName, forResult: true })` they save with "Save & return"
and resolve `{ id, name }` (units: `name` is the symbol).

Go To: the module registers the `items` provider (replacing the shell's built-in). Results open
`stock.item { itemId }` when the stock module registered that screen, otherwise the item form, and
show the group and stock in hand.

## Reusable exports (`./pickers.tsx`)

```tsx
import { ItemPicker, useItemPicker, GodownPicker, UnitPicker, BatchPicker, StockGroupPicker,
         StockCategoryPicker, usePriceFor } from '../inventory/pickers.tsx';
```

All pickers are kit `Picker`s (type-ahead, ↑/↓, Enter/Tab select, Alt+C create, Esc) and accept
`placeholder, disabled, readOnly, required, invalid, autoFocus, size, id, aria-label, ref` and
`allowCreate` (default true; also needs the `masters.create` permission). Inside a kit `Field` they
take its label/id automatically.

### `<ItemPicker>`

```tsx
<ItemPicker
  value={line.item}                 // ItemPickerRow | { id, name } | null (a saved line needs only id + name)
  onChange={(row) => setItem(row)}  // ItemPickerRow | null — unit, decimals, alt unit, GST, prices, stock, batches flag
  onCommit={(row) => focusQty()}    // optional; Enter is then consumed (move focus yourself)
  asOf={voucherDate}                // GST / price level / stock date (default: server working date)
  godownId={godownId}               // stock of this godown only
  priceLevelId={party.priceLevelId} // adds the level rate (qty 1) to the right-hand meta
  showStock                         // default true: "12 Nos" / "Service" on the right
  allowCreate                       // default true: "+ Create stock item" opens the item form and selects the new item
  goodsOnly                         // optional: hide services (stock journals)
/>
```

Searches `inventory.item.picker` on the server (`limit` 50 per query) — fast on 20,000+ items.

### `useItemPicker(options)`

Same options as `ItemPicker` (`asOf, godownId, priceLevelId, limit, goodsOnly`). Returns the
building blocks for a custom item cell: `loadItems(query, signal)`, `getKey`, `getLabel`, `getAlias`,
`getKeywords`, `stockText(row)`, `createItem(typed) → Promise<ItemPickerRow | null>` (opens the form
for a result) and `fetchRow(id, name?) → Promise<ItemPickerRow | null>` (fill a line from a saved id).

### `<GodownPicker value onChange onCommit? exclude? />`

`value: number | null`, `onChange(id, godown: GodownDto | null)`. Tree order, Main Location first.
`exclude: Set<number>` hides ids (e.g. a godown and its children when choosing its parent).

### `<UnitPicker value onChange onCommit? kind? exclude? />`

`value: number | null`, `onChange(id, unit: UnitDto | null)`. `kind: 'simple' | 'compound'` limits
the list (compound parts must be simple). Create opens the unit form with that kind.

### `<BatchPicker itemId godownId? asOf value onChange onCommit? allowNew? showEmpty? excludeVoucherId? />`

Batches of one item (and godown) as on `asOf`, First-Expiry-First-Out, showing balance and expiry
("Expired …" for past dates). `value: string | null` (batch name), `onChange(name, balance | null)`.
Outward entries: leave `allowNew` off (only batches with stock are offered). Inward entries
(purchase, receipt, production): `allowNew` lets Alt+C / "+ New batch" take the typed name.
Pass `excludeVoucherId` when altering a voucher so its own quantities are not counted.

### `<StockGroupPicker>` / `<StockCategoryPicker>`

`value: number | null` (empty = Primary / none), `onChange(id, row | null)`, `exclude?`.

### `usePriceFor(itemId, priceLevelId, date, qty, side = 'sales')`

`useApiQuery` over `inventory.item.priceFor`: `data: { rate (₹ per base unit, before tax),
discountPct, source: 'price_list' | 'item_default', applicableFrom? }`. Disabled until `itemId` is a
positive number and `qty ≥ 0`. Cached 30 s; refetches when any argument changes.

## Behaviour decisions

- **Opening stock value** = round(qty × rate × 100) paise until the user types a value (override);
  the rate then shows value ÷ qty and only the value is sent. Typing a rate again
  recalculates. The grid is sent only when it changed (so a locked period never blocks an
  unrelated edit), and is read-only with a note when the books are locked on/after books beginning.
  The godown column shows when Multiple godowns is on (or rows already sit outside Main Location);
  batch / mfg / expiry columns when the item keeps batches and the features are on (or rows already
  carry them, so turning a feature off never silently drops data). Server messages about opening
  rows (numbered as sent, blank rows left out) are put back on the grid row they belong to.
- **Moving through a number field is not an edit.** Rate and conversion fields show 4 decimals; the
  core may store more (a rate worked out as value ÷ qty is kept to 6). A commit that only re-formats
  the stored number (`isShownValue`) is ignored, so pressing Enter through a saved opening row never
  turns ₹1,000.00 (3,000 × 0.333333) into ₹999.90 (3,000 × 0.3333).
- A **service** keeps no stock: its alternate unit, batches and opening stock are hidden and saved
  as none.
- **GST** ("Set GST here"): off = inherit from the group chain / ledger (the form shows today's
  effective rate and where it comes from). Rate select lists the post-22-Sep-2025 slabs first, then
  other notified rates, then "Another rate…" (sent with `allowNonStandardRate`). HSN/SAC is checked
  with `validateHsnSac` (services must use SAC 99…); fewer digits than F12 › GST › HSN digits is a
  warning. Once a master has dated history, changing its details (HSN included) requires
  "Applicable from"; an unchanged GST block is not sent, so renames never need a date.
- **Price lists** are read-only on the item form (summary per level) and edited on
  `inventory.priceList`; only items whose slabs changed are saved; removing all slabs clears the
  list only when it is dated on the chosen date. Gaps between slabs are a note, overlaps an error.
- A dated GST history row can be removed with its trash button or, in the history grid, Delete.
- Delete is refused up-front with the reason when the record is in use (items with vouchers,
  groups with children/items, units with items, Main Location); the core enforces the same.
- Rates are entered with up to 4 decimals (₹ per base unit), amounts in paise via `AmountInput`.

## Pure logic (tested: `node --test "src/renderer/modules/inventory/**/*.test.ts"`)

| File | What |
|---|---|
| `lib/units.ts` | "1 Box = 12 Nos" text, compound symbol preview, alt→base qty, UQC suggestion + select options, unit draft checks |
| `lib/opening.ts` | opening grid: value auto-calc / override, totals, per-cell validation, save rows, change detection |
| `lib/slabs.ts` | price-list slabs: overlap / gap checks, next slab, changes to save, net rate |
| `lib/gstDraft.ts` | GST block of groups and items: change detection, validation, save fields, rate select |
| `lib/itemForm.ts` | item draft ↔ DTO, validation, save input, warnings, costing / taxability texts |
| `lib/itemEssentials.ts` | 2.1 item form: Essentials vs More details per kind, auto-reveal on value/error, Standard cost rule, the More details action (Ctrl+I, Alt+F1) and what the key does (`detailsToggle`), the title-row actions and commit label (`itemFormActions`, `itemSaveLabel`), the alteration context run |
| `lib/listActions.ts` | 2.1 list title-row actions (Create … button; Create several Alt+M/Alt+B, Create under selected, Delete in More), counts and plurals — keys pinned in `keys21.test.ts` |
| `lib/bulk.ts` | multiple-items grid validation, inputs, server error → cell mapping |
| `lib/tree.ts` | tree order for groups / categories / godowns, descendants, path text |
| `lib/goto.ts` | Go To results and target screen |
