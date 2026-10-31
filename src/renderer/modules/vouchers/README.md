# Vouchers UI (`src/renderer/modules/vouchers`)

Voucher entry, Day Book, voucher view and the generic voucher list. Core API: `src/core/modules/vouchers/README.md`.

## Screens

| id | params | what |
|---|---|---|
| `vouchers.entry` | `{ baseType? \| voucherTypeId?, id?, duplicateOf?, date?, partyId? }` | Create (by base type or voucher type), alter (`id`), or create pre-filled from another voucher (`duplicateOf`). A cancelled voucher, one whose e-invoice (IRN) is generated, or a user without `vouchers.alter`, is redirected to `vouchers.view`; a user without `vouchers.create` gets an explanation instead of an empty form. A stock journal type with a class (`config.stockJournalClass`: Manufacturing Journal, Material In / Out) is handed over to `mfg.journal.entry` with the same params when the user may open it (mfg module). A sales type used as POS invoice (`config.posInvoice`) is handed over to `pos.counter` (`{ voucherTypeId, id? }`; not for `duplicateOf`) when F11 › POS invoicing is on (pos module). |
| `vouchers.daybook` | `{ from?, to? }` | Day Book. Defaults to the working date and follows F2 until a range is picked. Keys (also `vouchers.list`): Enter / Alt+A alter, Alt+Enter view, **Ctrl+P print the highlighted voucher** (Alt+P prints the Day Book itself), Alt+2 duplicate, Alt+D delete; Day Book: Alt+T today, Alt+F2 period. 2.1.2: graph "Amount by voucher type" above the table (`lib/charts.ts` `dayBookChart`, lazy-loaded: the Day Book is eager; the voucher view and list screens load on first open); Enter on a bar = only that type (a menu entry the screen hides selects nothing), then focus moves to the list (`VoucherTable` `gridRef`). |
| `vouchers.view` | `{ id }` | Read-only voucher: header, party, items, Dr/Cr entries with bills / cost centres / bank details, GST by rate, e-invoice / e-way bill, cancellation, audit stamps. **Ctrl+R** Change number (2.0; `vouchers.renumber` + `vouchers.alter`; disabled with the reason for a cancelled or e-invoiced voucher) opens `ChangeNumberDialog` and calls `vouchers.renumber { id, number, reason?, continueSeries?, expectedUpdatedAt }` through the "Please check before saving" protocol (a filed GSTR-1 period asks first); toast "Sales INV/26-27/0042 renumbered to INV/26-27/0141". 2.2: each line's own description shows as typed (line breaks kept, long words wrap) on a muted line under its name — item lines from `PreviewInventoryLine.description` (never the item master's description) in normal and Detailed views (invoices, orders / notes, both sides of a stock journal, physical stock); Dr / Cr lines from `VoucherDetailEntry.narration` (also the TDS / TCS, GST advance, forex and POS hook narrations), on its own line before the ' · ' details line (bills, cost centres, instrument, bank date). A row with a line under its name keeps its cells on the name's line (`bx-vch-view__row--multiline`); names ellipsize on their own line (`bx-vch-view__name`). 2.2: a voucher that posts no ledger entries (a sales / purchase order, a quotation, a proforma, a note or rejection entered with charges) shows its ledger lines as entered (`input.ledgers`, the lines the print uses) as its Particulars — columns Particulars (the ledger, named through `pickers/hooks.ts › useLedgerDetails`, '…' until the name loads, with the line's description on a muted line under it like an entry's) · Amount (as entered: + adds to the document's value, − deducts; no total row). They take the entries' place and follow the same rule: shown by default without item lines (an accounting quotation's lines, which then take the focus), only in Detailed beside item lines, under *Charges & discounts*; never for a cancelled voucher, never a line whose amount is 0. Its Items, Accounting entries and Particulars tables are not windowed (`virtualize={false}`): they are as tall as their rows, and a described line is taller than the others, which DataTable's one-row-height windowing cannot place. The view's model is `lib/voucherView.ts` (state words, sections, totals, entry and Particulars rows — `viewEntryRows`, `viewLineRows`, `viewLineLedgerIds`, `viewSections().lines`), which only this lazily loaded screen imports. |
| `vouchers.list` | `{ from?, to?, voucherTypeIds?, baseTypes?, partyLedgerId?, ledgerId?, search?, includeOptional?, includeCancelled?, onlyPostDated?, title? }` | Generic register for drill-downs (party, ledger, type, period). Defaults to the global period. |

Menu (section `transactions`): Day Book, every voucher type from `PREDEFINED_VOUCHER_TYPES` (hotkeys shown; orders / rejections / stock documents need their F11 feature, from the shell's `VOUCHER_FEATURE`), Post-dated Vouchers. Each entry item carries `voucherBaseType`, so a predefined voucher type the company deactivated (Masters › Voucher Types) is left out of the Gateway menu and Go To (`MenuContext.inactiveBaseTypes`, from `accounts.voucherType.list`; unknown → shown). Go To provider `vouchers` (replaces the shell's): number, party, reference, narration or exact amount → alteration (cancelled → view).

## Voucher entry layout (2.1 "calm", design/SPEC-21 §1.4, D13–D20)

- **Title row**: h1 *Sales Creation* / *Sales Alteration*; context run = the entry-mode menu button *Item invoice ▾*
  (accessible name "Entry mode: Item invoice", `menuitemradio` entries for every allowed mode, the one Alt+I
  reaches marked "Alt+I"; new vouchers of a type with more than one mode) and state words joined by " · "
  (*Optional* — the one warning-tone word —, *Post-dated*, *GST: …*, *In USD @ ₹83.10*, *Converts a quotation*,
  *Recurring · Oct-26*, *e-Invoice: generated*; *Not saved* comes from the title row). Actions: **Save** (the only
  primary, Ctrl+A) and **More ▾**; after a save Print (Alt+P) takes a slot unless the Saved bar offers Print. No
  footer bar (Back = Esc / `‹`); the voucher number is not repeated in the context.
- **Moved out of sight, keys kept** (`demoted` / no `prominent`, never `hidden`): Ctrl+I More details (its visible home
  is the header link *More details  Ctrl+I ›*, `aria-haspopup="dialog"`), Alt+B Bill-wise, Alt+W Share, and Alt+P
  Print while the Saved bar shows it.
- **Header** (flat): *No.* — an input, plain text when read-only (it shows the automatic next number), followed by
  the muted word *changed* after Ctrl+R —, Date (its locked-books / future-date hints show when they apply), the
  party with **one muted line** under it (`lib/strip.ts › partyLine`: *Cur bal … · Overdue … (190 d) · Limit
  exceeded · Unregistered*; the balance opens the party's ledger; always one line high), place of supply as plain
  text (`lib/disclosure.ts`: *Maharashtra* / *Gujarat · inter-state*; the full text with the state code is the
  accessible name — it starts with the words shown —, the tooltip adds the party GSTIN). The party picker rows show GSTIN · balance.
- **Grids**: flat; GST % is muted text that becomes an input on hover / focus (outside the Enter chain); row tools
  show on row hover / focus (a pressed one stays); a note / order reference is muted text (*· note DN-1*). The
  additional ledgers of an item invoice are **Charges & discounts** (`DisclosureLine`, table name still
  "Additional ledgers"): closed while empty, open by itself when a charge exists (and then open for the rest of that voucher, so removing the last charge never hides the cursor's row); Enter on an empty item row (or
  Shift+Enter from the narration) opens it and puts the cursor on its row — the 2.0 stop (`lib/gridNav.ts ›
  chargesCollapsible / opensBeforeFocus`). The *Items* value row shows only beside a charge.
- **Line descriptions** (2.2, `lib/lineDescription.ts`): every item line and every ledger line (*Particulars*, the
  charges of an item invoice included) may carry a description of its own, typed on this voucher only — an item
  line's `ItemRow.description` (→ `inventory_entries.description`, never the stock item master's description), a
  ledger line's `LedgerRow.narration` (→ `ledger_entries.narration`). The field (`ui/TextArea`, id
  `cellId(section, rowKey, 'desc')`, *Description, line N*, one line growing to four, 1,000 characters, quiet like
  the GST % input: no border or fill until hover / focus) sits under the item / ledger name inside
  `.bx-vch-cell-item`, with its own error text. It shows on a filled line when the line has text, when the user
  opened it — **Ctrl+E** on the line, or the row tool *Description* (shown only while the field is hidden) — or on
  every filled line when the voucher type says *Description on every line* (`narrationPerEntry`, 2.1's "Narration
  for each entry", which its hint still names; the 2.1 *Line narration* column of ledger vouchers is gone). Moving
  into it keeps it open while edited; leaving it empty closes it again — unless the cursor only went into a dialog
  opened from it (Alt+B, Ctrl+I, a confirmation) or out of the window, which give it back there. A key (Enter, Tab)
  closes it at once; a click below it (*Remove line 2*, *Charges & discounts*, a label) moves the cursor at
  mousedown, so the field closes once that press is over — after the click, which still lands on what was pressed
  (`lib/lineDescription.ts › afterPointerRelease`: the first of pointerup / pointercancel / a tap's click, then a
  timeout of 0) — and stays when the cursor is back by then. The opened lines are the screen's state (`descOpen` + a ref for the key
  handlers; never in `VoucherForm`, so no "Not saved" and nothing sent; dropped with the next voucher, whose row
  keys start again); the grids pass each memoised row one `descShown` boolean. The same rule (`descriptionShown`)
  makes it a stop of the Enter chain or not: item → description → godown / batch / quantity …; an invoice's ledger
  line → description → amount; a ledger-mode line (payment, receipt, contra, journal …) → amount → description,
  so the forex and bill-wise stops still continue from the amount. Enter / Shift+Enter (and Ctrl+Enter) move on —
  a new line cannot be typed, pasted ones are kept (trimmed at the ends when sent); ↑ / ↓ move its caret; the
  height follows the text and the column's width (`ui/TextArea` refits when the width changes, e.g. when the side
  column appears). Lines filled with Alt+T bring the note's / order's descriptions along (`TrackingDocLine.description`),
  and the Alt+T list names each pending line with its description (*Mixer — SN-222: 1.000 Nos pending of 1.000
  Nos*, one line, at most 40 characters of it; `lib/masters.ts › trackingLineText`). The single-entry
  layout's Account field has no description: a cash / bank line with one keeps the voucher in Dr/Cr, and Ctrl+H
  says so (`formState.ts › singleEntryBlock`). The row tools column is 136 px (five small tools: bills, cost
  centres, bank, description, remove); in the stock journal's two side-by-side item grids it is 64 px (an item line
  has at most Description and Remove), which leaves the item name its room.
- **Totals strip** (invoice modes, rupees): at the bottom of the window (sticky once the form scrolls) — Taxable · CGST · SGST / UTGST (or IGST) · Cess ·
  Other charges · Round off · **Total ₹** (`lib/strip.ts › totalsStrip`; the items add up to the Total, which is
  `invoice.grandTotal`; reverse-charge tax is one muted item outside it). The Total's tooltip: *Intra-state ·
  GSTR-1: B2C small* and the amount in words; engine notes and the server figure (when it differs) as a second
  muted line; *Invoice has no lines* only after a save attempt. Ledger vouchers show their total as the grid foot
  (Dr · Cr, the difference and *Balance it*), stock documents as the grid's Total row; a foreign-currency invoice
  keeps the forex panel's totals.
- **Side column** only when it holds the work (D16): the pending bills (top 5 + "N more") of the bill-wise party of
  a receipt / payment, the Checks list when something must be fixed or confirmed (info notes stay on their rows),
  the TDS / TCS and forex panels when they apply. Otherwise the grid takes the full width.
- **Accept?** reads the amount back (`lib/strip.ts › acceptMessage`): *Sales for ₹ 27,140.00 (Rupees Twenty Seven
  Thousand One Hundred Forty Only) to Asha Retail.*
- **Saved bar** (D20): one neutral line, the ✓ green — *✓ Saved Sales 33 · ₹ 27,140.00 · Asha Retail   Print ·
  Share · Record payment   ×* (`status` "Voucher saved"; the voucher reference opens the voucher, as the 2.0 toast's
  View did). While it shows there is no "… saved" toast (`lib/savedBar.ts › barToast`: only the save's notes get a
  toast). A converted document / recurring occurrence returns to its list with the 2.0 toast.
- No teaching text: no side key-hint line, no narration hint, no picker placeholder, no picker key footer. The
  screen's hint line ("Enter Next · Shift+Enter Back · Ctrl+A Save · … · Ctrl+E Description · Esc Back") is the
  first line of F1 › This screen. The *Description* placeholder of an empty line description is not teaching
  text: that field only shows empty because the user opened it (or the voucher type asks for one on every line),
  and with no label above it the placeholder is its visible name — gone as soon as something is typed.

## Voucher entry keys

| Key | Action |
|---|---|
| Enter / Shift+Enter | Next / previous field or cell (a line's description is a stop only while it shows); Enter on an empty grid row moves to the next section (items → Charges & discounts, which opens → narration); Enter in the narration asks "Accept?" (with the amount in words) |
| ↑ / ↓ | Same column, previous / next row (not inside an open picker, nor in a line description — there they move the caret) |
| Ctrl+A (Ctrl+S) | Save — the button reads "Save" ("Save changes" when altering) |
| Esc | Back (asks when something was entered) |
| F2 | Voucher date |
| F10 / F4–F9, Ctrl+F8 … | Change voucher type (new vouchers; the date is kept) |
| Alt+I | Item invoice ↔ accounting invoice (orders / notes: item ↔ stock only) |
| Ctrl+H | Single entry ↔ Dr/Cr layout (payment, receipt, contra) |
| Ctrl+I | More details (also the header link *More details  Ctrl+I ›*; in More ▾): buyer snapshot, consignee, dispatch & e-way bill, order, export, effective date; on sales-side documents its first tab, *Reference*, holds Reference no. / date and (GST documents) Reverse charge |
| Ctrl+R | Change number (2.0, needs `vouchers.renumber`; hidden for numbering "None"): `ChangeNumberDialog` — the number is checked live (`vouchers.numberCheck`, 300 ms debounce: GST format, unique in the FY for outward GST documents, else in the numbering period), an optional reason (edit log) and *Continue the series from here* (only for a number in the series' format at or above the next number). Stored in `VoucherForm.numberOverride` and sent as `VoucherInput.numberOverride` with the normal save (never inferred from a typed number); the No. field shows it followed by the muted word "changed". The dialog's fields are single-line, so Enter goes number → reason → (continue the series) → *Use this number* |
| Alt+T | Fill lines from open delivery / receipt notes or orders (`vouchers.trackingRefs`); each pending line is listed with its own description when it has one (*Mixer — SN-222: 1.000 Nos pending of 1.000 Nos*) |
| Alt+B | Bill-wise details (the focused ledger line, else the invoice party) |
| Alt+J | GST details (gst module `GstDetailsDialog`, GST companies only): receipt — advance against a future supply; payment — refund of an advance / GST challan; sales or debit note to a customer — advances adjusted; purchase — bill of entry; journal — stat adjustment. Kept on alteration (`VoucherForm.gstDetails`, `buildInput.ts`), filtered to what the base type carries (`gstDetailsForBase`); the title row's context says *GST: …* |
| Alt+O / Alt+K | Cost centres / bank instrument of the focused line (Alt+K on the Account in single entry) |
| Ctrl+B | Balance it (puts the Dr/Cr difference on the last line) |
| Ctrl+D / Alt+N, Ctrl+N | Delete line / insert line above |
| Ctrl+E | Line description (2.2): opens the description under the item / ledger the cursor is on and puts the cursor in it (just the cursor when it shows); elsewhere a note "Move to a line first". The action *Line description* is in More ▾ (and on the shortcut bar): chosen there — the menu or the button has the focus — it describes the line the cursor was last on (`lastLineRef`: set when the focus enters a cell or a row tool of a line — `lib/errorPaths.ts › lineOfElement`, the row's `data-row` / `data-section` —, cleared in the header or the narration and for the next voucher). The row tool *Description* does the same for its line. The manufacturing journal screen (`mfg.journal.entry`) binds the same action for its item lines, with the rule and helpers of `lib/lineDescription.ts` (mfg README, `mfg/lib/journalDescription.ts`) |
| Alt+C | In a picker: create the ledger / item with the typed name and select it. In the party field (customer / supplier — `createGroupCode` Sundry Debtors / Creditors) the quick dialog `accounts/QuickPartyDialog.tsx` opens (2.0): name, GSTIN (fills state, PAN, registration type — `accounts/lib/gstin.ts`), state, mobile, e-mail, billing address; saved with `accounts.ledger.save` (bill-wise per F11) and selected like a form result; "Full form…" opens `accounts.ledger.form` as before. Other places: A ledger opens under the group that fits the place (`lib/masters.ts › createGroupCode`: party of a sales-side document → Sundry Debtors, purchase-side → Sundry Creditors, item line → Sales / Purchase Accounts, single-entry Account and contra lines → Bank Accounts); if the user moves it to a group the place refuses, it is explained instead of selected |
| Ctrl+L / Ctrl+T | Optional / post-dated |
| F12 | Voucher type settings and the F12 options that affect it |
| Alt+P | Print: the voucher being altered, or — on a new voucher — the one just saved from this screen ("Print Sales 12", `lib/printing.ts`) |
| Alt+W | Share (e-mail / WhatsApp) the same voucher: `print.voucher { id, share: true }`, as the voucher view's Alt+W (2.0; greyed without Data › Export) |
| Alt+D, Alt+X, Alt+2, Alt+H | (alteration) delete, cancel with reason, duplicate, edit history |

## Behaviour

- **Where the cursor starts** (`lib/gridNav.ts › initialFocusId`, as accountants expect): the number of a manually numbered new voucher, else the supplier's invoice no. of a purchase, else the party, else the single-entry Account, else the first grid line. The shell focuses a screen once when it is pushed — before this form has its data — so the form places the cursor itself on mount and after each save.

- **Totals** are computed live with the shared GST engine (`lib/totals.ts` → `computeInvoice`), using the same line treatment as the posting engine (apportioned charges, computed lines, non-GST charges after tax, round-off on the whole value). While the user pauses (0.9 s) and the voucher looks complete, `vouchers.preview` re-checks on the server: its warnings appear on the rows and (block / confirm) in the **Checks** list; if its grand total differs, the totals strip says what the books will record.
- **Saving** goes through the shell's `withConfirmation`: only `confirm`-level warnings are asked about (`lib/errorPaths.ts › confirmationRequest`); `info` ones stay inline. `VALIDATION` paths (`items[2].qty`, `ledgers[0].ledgerId`, `partyLedgerId`, …) are mapped to cells through the row keys of the input that was sent (`buildVoucherInput` → `itemKeys` / `ledgerKeys`) and the first one is focused. Blocking warnings show in a banner and on their rows.
- **Header disclosure** (2.0, `lib/disclosure.ts`): on sales-side documents (sales, credit note, sales order, delivery note, rejection in, quotation, proforma) Reference no. / date and Reverse charge sit in More details until they hold a value (then they stay inline for that voucher); purchase-side documents keep Supplier invoice no. / date and Reverse charge inline; receipts / payments keep their reference. The derived place of supply is plain text (2.1: "Maharashtra", "Gujarat · inter-state" — a button outside the Enter chain, so Enter goes party → items; ellipsized in its cell); clicking it shows the existing select. The select shows straight away when the place of supply would only be assumed (a chosen party without a state and no consignee state — the engine falls back to the company's state: `placeOfSupplyAssumed`), is outside India, was chosen by hand or has an error. Only the layout moves — `formState` / `buildInput` send exactly what they did (round-trip tests in `lib/disclosure.test.ts`).
- **Saved bar** (2.0, `entry/SavedBar.tsx`, `lib/savedBar.ts`; one line in 2.1): after a create, above the blank form — "✓ Saved Sales INV/26-27/0042 · ₹ 11,800.00 · party" with Print (Alt+P), Share (Alt+W) and Record payment (a sales invoice to a customer → `vouchers.entry { baseType: 'receipt', partyId }`, a purchase from a supplier → `payment`; the party becomes the first particulars line, `formState.withFirstLedger`). It goes on the next save, on × or once the next voucher is touched. 2.1: no "saved" toast while it shows.
- **After creating**: the Saved bar (a converted document / recurring occurrence, which returns to its list: the toast with the number, the amount and "Alt+P to print", View action); the screen resets for the next voucher of the same type keeping the date and Alt+P prints the saved voucher. When the voucher prints after saving — the voucher type's own switch, or Invoice Printing (print settings) for sales, credit / debit notes and delivery notes (`vouchers.entryContext › config.printAfterSave`) — `print.voucher { id, autoPrint: true }` opens and sends it to the printer as soon as the preview is ready. **After altering**: toast and back.
- **Client checks before saving** (`lib/validate.ts`): party, number, supplier invoice no., Account, quantities, amounts, Dr = Cr in the Dr/Cr layout (with the difference and the Ctrl+B hint on the last line), and bill-wise details that no longer add up to their line / to the invoice total. Enter in the narration runs them before asking "Accept?".
- **Bill-wise dialog**: a receipt / payment line whose party has pending bills on the other side opens allocated against the oldest bills first (rest On Account); an invoice party or a ledger with nothing to settle opens with a New Ref named after the voucher (purchase: supplier invoice no.) and the credit period. Alt+F re-runs FIFO, Alt+N adds, Ctrl+D removes the focused line.
- **Alteration round trip**: everything `vouchers.get().input` carries comes back on save — including fields without a column (`altQty`, a ledger line's GST override taxability / cess / supply kind, an item-invoice charge's GST override) and the lines' descriptions. A payment / receipt / contra opens in the single-entry layout only when the cash/bank line has nothing the Account field cannot show (bills, cost centres, a description); Ctrl+H on such a voucher stays in Dr/Cr and names the reason (`formState.ts › SINGLE_ENTRY_REFUSAL`). `lib/coreContract.test.ts` proves it against the real engine.
- **Pickers** (`pickers/`): one cached `accounts.ledger.picker { asOf }` / `inventory.item.picker { asOf, priceLevelId? }` list per screen, narrowed per place (`lib/masters.ts › ledgerAllowed`: parties, sales/purchase ledgers, invoice lines without cash/bank or parties, contra cash/bank only, journal without cash/bank, no credit note to a supplier). Empty grid rows do not open the list on focus, so Enter on them leaves the grid.
- **Item defaults**: rate from the price level slab (sales side) or the item's selling / purchase price; godown from the voucher type's default godown. With a price level, committing the quantity re-reads the slab for that quantity (`inventory.item.priceFor`) — only while the rate is still the one the screen filled in.
- **After a save** the next voucher keeps the date, the layout, the single-entry Account and the voucher type's default party (e.g. Cash for "Cash Sales").
- **Performance**: rows are memoised and get only their own data; shared masters/callbacks come from a context whose value only changes with the masters (`pickers/hooks.ts` memoises its results); per-row tax figures keep their identity while unchanged (`lib/totals.ts › stabilizeLines`); totals use `useDeferredValue`, so typing re-renders one row.

## Pure logic (tested: `node --test "src/renderer/modules/vouchers/**/*.test.ts"`)

`lib/lineDescription.ts` (2.2) when a line's description shows, its place in the Enter chain, the opened set, the close that waits for a press to end (`afterPointerRelease`) · `lib/strip.ts` (2.1) totals strip items, Total tooltip and notes, the party line, the Accept? message · `lib/changeNumber.ts` Change Number dialog view-model (messages, continue-series rule, availability) · `lib/disclosure.ts` header disclosure and the place-of-supply text · `lib/savedBar.ts` Saved bar and Record payment · `lib/quickParty.ts` quick customer / supplier draft and save input · `lib/keySpace.test.ts` Ctrl+R / Alt+W key space · `lib/formState.ts` reducer · `lib/buildInput.ts` form ⇄ VoucherInput · `lib/errorPaths.ts` server paths ⇄ cells, warnings protocol, the line of a focused element (`lineOfElement`) · `lib/bills.ts` FIFO allocation · `lib/totals.ts` client totals (parity with `computeInvoice`) · `lib/gridNav.ts` keyboard model and section order (2.1: Charges & discounts opens in the Enter chain) · `lib/validate.ts` pre-save checks · `lib/masters.ts` picker slots, ledger GST profile, item defaults, tracking rows and the Alt+T line text (`trackingLineText`), tax breakup · `lib/menu.ts` menu and Go To items · `lib/coreContract.test.ts` the form model against the real posting engine (totals parity, alteration round trip, error/warning placement) · `lib/daybook.ts` Day Book rows and export (in the start-up bundle) · `lib/voucherView.ts` the voucher view's document model, loaded with the view only (2.2: `lineDescription`, `entryDetailLine`, `viewEntryRows`; the Particulars of a voucher that posts no ledger entries: `viewLineRows`, `viewLineLedgerIds`, `viewSections().lines`) · `lib/viewLines.test.ts` those lines against the real engine · `lib/kinds.ts` per-base-type layout · `lib/printing.ts` Alt+P / print-after-save targets.

## Known gaps

- The sales/purchase ledger of an item line is the voucher type's default (no per-line ledger column; a saved line's own ledger is kept on alteration).
- Live totals assume rates exclusive of tax unless the line says otherwise: the item picker does not deliver the item master's "rate inclusive of tax" flag. `vouchers.preview` reports the server figure ("The books will record …") when it differs.
- Checks shown from the last `vouchers.preview` stay until the voucher looks complete again (they are not cleared while a line is half-typed).
- Multi-currency (forex module, F11 › Multiple currencies): Alt+Y edits the invoice currency and rate, or a ledger line's foreign amount and rate (see src/core/modules/forex/README.md). TDS/TCS: the side column shows the tds module's panel (`modules/tds/EntryPanel.tsx`) for purchase / journal / payment (TDS) and sales (TCS) when F11 turns them on and it has a figure; Alt+U changes an amount (with a reason) or picks the nature for an advance.
- The totals strip is not drawn for an invoice in a foreign currency (the forex panel shows its totals in both currencies).
- Only *Line description* (Ctrl+E) remembers the line the cursor was last on. *Bill-wise* (Alt+B) and *Foreign amount* (Alt+Y) chosen in More ▾ — where the menu has the focus — still look at the focused cell only, so from the menu they act on the invoice party / the first foreign-currency line, or say there is nothing here; their keys, pressed on the line, act on that line.
