# Vouchers UI (`src/renderer/modules/vouchers`)

Voucher entry, Day Book, voucher view and the generic voucher list. Core API: `src/core/modules/vouchers/README.md`.

## Screens

| id | params | what |
|---|---|---|
| `vouchers.entry` | `{ baseType? \| voucherTypeId?, id?, duplicateOf?, date?, partyId? }` | Create (by base type or voucher type), alter (`id`), or create pre-filled from another voucher (`duplicateOf`). A cancelled voucher, or a user without `vouchers.alter`, is redirected to `vouchers.view`. |
| `vouchers.daybook` | `{ from?, to? }` | Day Book. Defaults to the working date and follows F2 until a range is picked. |
| `vouchers.view` | `{ id }` | Read-only voucher: header, party, items, Dr/Cr entries with bills / cost centres / bank details, GST by rate, e-invoice / e-way bill, cancellation, audit stamps. |
| `vouchers.list` | `{ from?, to?, voucherTypeIds?, baseTypes?, partyLedgerId?, ledgerId?, search?, includeOptional?, includeCancelled?, onlyPostDated?, title? }` | Generic register for drill-downs (party, ledger, type, period). Defaults to the global period. |

Menu (section `transactions`): Day Book, every voucher type from `PREDEFINED_VOUCHER_TYPES` (hotkeys shown; orders / rejections / stock documents need their F11 feature, from the shell's `VOUCHER_FEATURE`), Post-dated Vouchers. Go To provider `vouchers` (replaces the shell's): number, party, reference, narration or exact amount → alteration (cancelled → view).

## Voucher entry keys

| Key | Action |
|---|---|
| Enter / Shift+Enter | Next / previous field or cell; Enter on an empty grid row moves to the next section (items → additional ledgers → narration); Enter in the narration asks "Accept?" |
| ↑ / ↓ | Same column, previous / next row (not inside an open picker) |
| Ctrl+A | Accept (save) |
| Esc | Back (asks when something was entered) |
| F2 | Voucher date |
| F10 / F4–F9, Ctrl+F8 … | Change voucher type (new vouchers; the date is kept) |
| Alt+I | Item invoice ↔ accounting invoice (orders / notes: item ↔ stock only) |
| Ctrl+H | Single entry ↔ Dr/Cr layout (payment, receipt, contra) |
| Ctrl+I | More details: buyer snapshot, consignee, dispatch & e-way bill, order, export, effective date |
| Alt+T | Fill lines from open delivery / receipt notes or orders (`vouchers.trackingRefs`) |
| Alt+B | Bill-wise details (the focused ledger line, else the invoice party) |
| Alt+O / Alt+K | Cost centres / bank instrument of the focused line (Alt+K on the Account in single entry) |
| Ctrl+B | Balance it (puts the Dr/Cr difference on the last line) |
| Ctrl+D / Alt+N, Ctrl+N | Delete line / insert line above |
| Alt+C | In a picker: create the ledger / item with the typed name and select it |
| Ctrl+L / Ctrl+T | Optional / post-dated |
| F12 | Voucher type settings and the F12 options that affect it |
| Alt+D, Alt+X, Alt+2, Alt+P, Alt+H | (alteration) delete, cancel with reason, duplicate, print, edit history |

## Behaviour

- **Totals** are computed live with the shared GST engine (`lib/totals.ts` → `computeInvoice`), using the same line treatment as the posting engine (apportioned charges, computed lines, non-GST charges after tax, round-off on the whole value). While the user pauses (0.9 s) and the voucher looks complete, `vouchers.preview` re-checks on the server: its warnings appear in the **Checks** panel and on the rows; if its grand total differs, the panel says what the books will record.
- **Saving** goes through the shell's `withConfirmation`: only `confirm`-level warnings are asked about (`lib/errorPaths.ts › confirmationRequest`); `info` ones stay inline. `VALIDATION` paths (`items[2].qty`, `ledgers[0].ledgerId`, `partyLedgerId`, …) are mapped to cells through the row keys of the input that was sent (`buildVoucherInput` → `itemKeys` / `ledgerKeys`) and the first one is focused. Blocking warnings show in a banner and on their rows.
- **After creating**: toast with the number (View action), the screen resets for the next voucher of the same type keeping the date (Tally), and opens `print.voucher` when F12 or the voucher type says print after saving. **After altering**: toast and back.
- **Pickers** (`pickers/`): one cached `accounts.ledger.picker { asOf }` / `inventory.item.picker { asOf, priceLevelId? }` list per screen, narrowed per place (`lib/masters.ts › ledgerAllowed`: parties, sales/purchase ledgers, invoice lines without cash/bank or parties, contra cash/bank only, journal without cash/bank, no credit note to a supplier). Empty grid rows do not open the list on focus, so Enter on them leaves the grid.
- **Item defaults**: rate from the price level slab (sales side) or the item's selling / purchase price; godown from the voucher type's default godown.
- **Performance**: rows are memoised and get only their own data; shared masters/callbacks come from a stable context; totals use `useDeferredValue`, so typing re-renders one row.

## Pure logic (tested: `node --test "src/renderer/modules/vouchers/**/*.test.ts"`)

`lib/formState.ts` reducer · `lib/buildInput.ts` form ⇄ VoucherInput · `lib/errorPaths.ts` server paths ⇄ cells, warnings protocol · `lib/bills.ts` FIFO allocation · `lib/totals.ts` client totals (parity with `computeInvoice`) · `lib/gridNav.ts` keyboard model and section order · `lib/validate.ts` pre-save checks · `lib/masters.ts` picker slots, ledger GST profile, item defaults, tracking rows, tax breakup · `lib/menu.ts` menu and Go To items · `lib/daybook.ts` Day Book rows and export · `lib/kinds.ts` per-base-type layout.

## Known gaps

- The sales/purchase ledger of an item line is the voucher type's default (no per-line ledger column).
- Price-level quantity slabs: the rate is taken for quantity 1 when the item is chosen; changing the quantity does not re-read the slab (the server does not re-price either).
- Multi-currency and TDS/TCS computation are not offered (the engine does not support them).
