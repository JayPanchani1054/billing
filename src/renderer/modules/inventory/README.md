# Inventory masters UI (`src/renderer/modules/inventory`)

Screens for stock items, stock groups, stock categories, units, godowns and price lists, and the
pickers other modules (vouchers, stock reports) use to choose items, godowns, units and batches.
Everything is hidden when the company's **Inventory** feature (F11) is off; godowns also need
**Multiple godowns** and price lists need **Price levels**.

Core API: `src/core/modules/inventory/README.md`, DTOs: `src/shared/types/inventory.ts`.

## Screens

| id | params | what |
|---|---|---|
| `inventory.item.list` | `{ groupId?, categoryId? }` | Stock Items: server search (name, alias, part no., barcode), group / category filters, stock as on the working date, virtualised table. Enter alter · Alt+C create · Alt+M multiple · Ctrl+D/Alt+D delete · Alt+E export · Alt+P print |
| `inventory.item.form` | `{ id? \| initialName?, forResult?, groupId? }` | Stock Item Creation / Alteration (one Tally-style page: Basic, GST, Prices, Stock, Opening stock). Ctrl+A = **Save & next** (create: the form stays for the next item, keeping group, unit and GST), **Save** (alter) or **Save & return** (`forResult` → `pop({ id, name })`); Alt+S Save & close; Alt+D/Ctrl+D delete; Alt+L price lists |
| `inventory.item.bulk` | `{ groupId? }` | Multiple Stock Items grid (name, alias, group, unit, HSN/SAC, GST %, selling price, opening qty/rate/value). Enter on an empty name finishes; all rows are created or none |
| `inventory.group.list` / `inventory.group.form` (dialog) | form: `{ id? \| initialName?, forResult?, parentId? }` | Stock groups as a tree; GST details with dated history (a wrong row can be removed) |
| `inventory.category.list` / `inventory.category.form` (dialog) | same | Stock categories (tree) |
| `inventory.unit.list` / `inventory.unit.form` (dialog) | form: `{ id? \| initialName?, forResult?, kind?: 'simple' \| 'compound' }` | Simple units (symbol, formal name, UQC suggested from the symbol, decimals) and compound units ("1 Box = 12 Nos") |
| `inventory.godown.list` / `inventory.godown.form` (dialog) | form: `{ id? \| initialName?, forResult?, parentId? }` | Godowns (tree); Main Location cannot be deleted or marked third-party |
| `inventory.priceList` | `{ priceLevelId?, itemId?, date? }` | Price level + applicable-from date → per-item quantity slabs (from / up to / rate / discount) with live overlap check; Alt+C create level, Alt+R rename |

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

- **Opening stock value** = round(qty × rate × 100) paise until the user types a value (override,
  as in Tally); the rate then shows value ÷ qty and only the value is sent. Typing a rate again
  recalculates. The grid is sent only when it changed (so a locked period never blocks an
  unrelated edit), and is read-only with a note when the books are locked on/after books beginning.
  The godown column shows when Multiple godowns is on (or rows already sit outside Main Location);
  batch / mfg / expiry columns when the item keeps batches and the features are on (or rows already
  carry them, so turning a feature off never silently drops data).
- **GST** ("Set GST here"): off = inherit from the group chain / ledger (the form shows today's
  effective rate and where it comes from). Rate select lists the post-22-Sep-2025 slabs first, then
  other notified rates, then "Another rate…" (sent with `allowNonStandardRate`). HSN/SAC is checked
  with `validateHsnSac` (services must use SAC 99…); fewer digits than F12 › GST › HSN digits is a
  warning. Once a master has dated history, changing its details (HSN included) requires
  "Applicable from"; an unchanged GST block is not sent, so renames never need a date.
- **Price lists** are read-only on the item form (summary per level) and edited on
  `inventory.priceList`; only items whose slabs changed are saved; removing all slabs clears the
  list only when it is dated on the chosen date. Gaps between slabs are a note, overlaps an error.
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
| `lib/bulk.ts` | multiple-items grid validation, inputs, server error → cell mapping |
| `lib/tree.ts` | tree order for groups / categories / godowns, descendants, path text |
| `lib/goto.ts` | Go To results and target screen |
