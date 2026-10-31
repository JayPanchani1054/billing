# mfg (renderer) — BOM, Manufacturing Journal, job work, ITC-04

Core side, costing rule, legal assumptions: `src/core/modules/mfg/README.md`.

## Screens

| Id | Params | Access / feature | What |
|---|---|---|---|
| `mfg.bom.list` | `{ itemId? }` | masters.view · manufacturing | Bills of Materials (a master list: Print / Export in More). Enter alter · Alt+C create · Alt+A alter · Alt+D / Ctrl+D delete · Ctrl+1 active / Ctrl+2 all (ticked More items) · Ctrl+F search · Alt+E export |
| `mfg.bom.form` | `{ id? \| itemId?, forResult? }` | masters.view · manufacturing | BOM creation / alteration: item, name, "components are for" quantity, default, active, lines (kind, item, quantity, default godown, by-product value basis), notes, cost estimate at the working date vs the item's standard cost. Ctrl+A save · Ctrl+D remove line · Alt+N insert line · Alt+H revision history (drawer with each revision's lines) · Alt+D delete |
| `mfg.journal.entry` | `{ voucherTypeId? \| cls?, id?, duplicateOf?, date?, jobWorkOrderId?, partyId? }` | vouchers.view · manufacturing or jobWork | Manufacturing Journal / Material Out / Material In (see below) |
| `mfg.jobWorkOrder.list` | `{ direction? }` | vouchers.view · jobWork | Job Work Out / In Orders (Out / In tabs; Print / Export in More). Ctrl+1 out · Ctrl+2 in · Ctrl+3 open · Ctrl+4 all (ticked More items) · Enter / Alt+A alter · Alt+C create · Alt+O Material Out / Alt+I Material In against the order · Alt+D delete · Alt+E export |
| `mfg.jobWorkOrder.form` | `{ id? \| direction, partyId? }` | vouchers.view · jobWork | Order: party, job work godown (auto from the party), product, quantity, BOM, process, job charges, due date, status, material lines (goods type for s.143), progress (sent / back), vouchers against it (Enter opens). Alt+B fill material from the BOM · Alt+O / Alt+I challans |
| `mfg.production` | `{ itemId?, bomId? }` | reports.view · manufacturing or jobWork | Production Register for the period (Alt+F2): engine values, rate, BOM estimate today; graph *Cost of production by month* (`lib/charts.ts › productionChart`); the valuation note in More › About this report. Enter view · Alt+A alter · Ctrl+1/2/3 all / manufacturing / from job workers · Alt+C create journal |
| `mfg.jobWork.pending` | `{ direction?, partyLedgerId? }` | reports.view · jobWork | Pending job work as on the period end: challan lines with sent / back / pending, value, return-by date, status (overdue / due in n days / no time limit), one-line s.143 banner with the overdue value, stat *Overdue n · Due within 30 days m* (*Overdue* left out while the banner says it), graph *Pending job work by return date* (`jobWorkChart`; none with Ctrl+3); the law in More › About this report. Enter view challan · Alt+I receive back (or send back) · Ctrl+1/2 direction · Ctrl+3 alerts only (ticked More item) |
| `mfg.itc04` | — | gst.view · jobWork · GST | ITC-04 (a statutory form: no graph): Table 4 / Tables 5A–5C tabs (Ctrl+1 / Ctrl+2) and the period list (this and last FY; half-yearly / annual by More › Turnover above ₹5 crore, Ctrl+3), stat *Table 4 n lines · Tables 5A–5C m lines*, due date in the context run, warnings, the export note in More › About this return, Alt+E export (CSV / Excel / PDF / Print through the shared export path) |

Menu: Masters › Bills of Materials, Create BOM · Transactions › Manufacturing Journal, Material Out,
Material In, Job Work Orders · Inventory reports › Production Register, Pending Job Work · GST › ITC-04.
Go To: every screen above, plus providers `mfg.boms` (BOMs by item / BOM name) and
`mfg.jobWorkOrders` (orders by number / party / item).

Extension points: `gatewayNotices` → `JobWorkAlertNotice` (s.143 overdue / due soon, dismissible per
working day), `dashboardCards` → `MfgCard` (alerts, open orders), `voucherPanels` → `MfgVoucherPanel`
(BOM, order, process and additional costs on `vouchers.view` of a classed journal).

## Manufacturing Journal / Material In / Out entry

`vouchers.entry` hands classed stock journal types over to `mfg.journal.entry` (F10, Go To, Alt+A /
Alt+2 from the Day Book or voucher view) when the user may open it; otherwise the generic stock journal
grid is used (the core accepts plain lines for a classed type too).

- Header: voucher no. (blank = automatic, next number shown), date; job work: party (job worker /
  principal), job work godown (its kind decides the sections), order (open orders of the party and
  direction), nature of job work.
- Sections by class × godown kind (`lib/journalForm.ts › sectionsFor`): finished goods (item, BOM, qty,
  into godown, batch), components consumed, by-products and scrap (value basis), material sent / returned
  / received (goods type, challan rate, return-date extension for Material Out), additional costs
  (expense ledger, description, amount or % of consumption). One trailing blank row per section.
- BOM explosion: choosing the item picks its default BOM; BOM + quantity fill components and by-products
  scaled from the BOM's output quantity; editing those rows by hand stops the automatic refill (typing a
  line's description does not); Alt+B refills. A refill keeps the description of each rebuilt line whose
  item the BOM still has (`lib/journalForm.ts › carryDescriptions`: same item, same section — components, or
  by-products / scrap — in order); a line whose item the BOM no longer has goes with its text.
- Live costing from `vouchers.preview` (debounced 350 ms): value per line and each section's total in
  its table footer; under the tables one StatLine *Cost of finished goods · Rate per unit* (its tooltip
  spells out consumption + additional − by-products); plus the core's warnings. The additional-costs rule
  ("no ledger entry is posted") is the costs table's tooltip.
- Save: `vouchers.save` with the `stockJournal` block; confirm-level warnings go through
  `withConfirmation`; server field errors map back to the row / cost row / header field
  (`mapErrors`). After a new voucher the screen starts a fresh one of the same type and date; Alt+P prints
  the last saved one ("Delivery Challan (Job Work)" for Material Out).
- Alteration: Alt+D delete · Alt+X cancel (reason) · Alt+2 duplicate · Alt+H edit history · Alt+Enter view.
- Ctrl+L optional / regular and Ctrl+T post-dated (as in the main voucher entry; the state words in the
  title row's context run).
  The flags are read back on alteration and `isOptional` is always sent then — leaving it out would
  apply the type's default and silently make an optional journal regular.
- Job work header: "Job worker's / Principal's challan no." → `referenceNo` (ITC-04 table 5A document
  number); not copied by Alt+2.
- 2.2 line descriptions: a line's own description on the voucher (`stockJournal.lines[].description` →
  `inventory_entries.description`, never the stock item master's; shown by the voucher view and the print)
  is kept in `JournalRow.description` — read back on alteration and Alt+2 (`fromDetail`) and sent again
  trimmed at its ends, line breaks inside kept, only when it has text (`toBlock`) — so altering or
  duplicating a journal keeps the texts it got elsewhere too (an import, the plain stock journal grid, the API).
  - On screen (`lib/journalDescription.ts`; the rule, the opened-set helpers, the 1,000-character limit and
    the close after a press are imported from vouchers `lib/lineDescription.ts`): a quiet one-line field
    (`bx-mfg-desc`, voucher entry's `bx-vch-desc` look, growing to four lines, placeholder *Description*,
    labelled with the item, e.g. *Description of Steel Sheet*) under the item of the finished goods (inside its *Item* field), every
    component, by-product / scrap and material line. It shows while the line has an item and text, or once the
    user opens it on this voucher: **Ctrl+E** — one rail action *Line description* (group details, under More
    ▾, hidden for a view-only role) — on the line the cursor is on, or from More ▾ / the shortcut bar on the
    line the cursor was last on (`lastLineRef`, set by the form's focus events through `data-row-key`, which the
    finished goods section carries too); the row tool *Description* (a trailing tools column of the item tables,
    `LinesTable tools`, shown on row hover / focus, mouse-only); or the finished goods' *Description* link
    beside *Item*. Elsewhere (header, narration, an additional cost — those keep their own Description column —
    an empty line) Ctrl+E says *Move to an item line first*.
  - Keyboard: in the Enter chain it follows the item (DOM order, useEnterAdvance); Enter / Shift+Enter move on
    from it like any field — no typed new lines, pasted ones stay — and so does Ctrl+Enter. Left empty it closes
    again: at once for keys, after the press when a click moved the cursor (so the click lands); not when a
    dialog or another window took the cursor.
  - The opened lines are this screen's state (`descOpen` + a ref), never the form's: no "unsaved changes",
    never sent; the next voucher after a save starts with none (and no last line).
  - Not here: the voucher type's *Description on every line* (`mfg.journal.context` does not carry the flag).
  Tests: `lib/journalDescription.test.ts` (rule, Ctrl+E, Enter, BOM refill, the screen's wiring and look, read
  from source), `lib/forms.test.ts` (the form) and `lib/coreContract.test.ts` (typed, kept through Alt+B, saved,
  emptied; alteration, duplicate and an imported journal — the screen's model against the real engine).
- ITC-04: Ctrl+4 toggles between the previous and the current financial year; table rows are keyed by
  the core's unique `key` (two identical challan lines stay two rows).

## 2.1 calm (SPEC-21, WP-L1)

Every screen is title row + content: no icon tiles; one Save — the title-row primary (Ctrl+A) — on the
BOM, job work order and journal forms (the in-page Save / Cancel buttons are gone; Esc goes back; on the
BOM and the order Enter — Ctrl+Enter in Notes / Narration — on the last field saves; on a journal it asks
"Accept this voucher?" with the cost of finished goods, as voucher entry does, and Ctrl+A saves at once);
field hints show on focus; master lists keep *Create …* as the one secondary
button with Print / Export under More; the view switches that were segmented controls are ticked More
items with their old keys (Ctrl+1/2 on the BOM list, Ctrl+3/4 on job work orders, Ctrl+3 on Pending Job
Work and ITC-04); status badges became plain words. Legal notes moved to More › About this report (this
return), banners are one line with their 2.0 titles (the Pending Job Work banner names the overdue value;
the stat then counts only what is due within 30 days, so the overdue count is said once). The dashboard
card and the Home notice are calm too (link-style *Review*; no badges — overdue value and next return
date are rows of their own). The Production Register graph stops at the working date's month ("so far")
when the period runs past it, unless a later (post-dated) voucher exists. Graph builders: `lib/charts.ts` (tested in
`lib/charts.test.ts`: graph total = table total, gates, colours, takeaways, stats).

## Pure logic (tested)

`lib/journalForm.ts` (form ⇄ VoucherInput, BOM application with the descriptions it keeps, sections, trailing
rows, type choice, error mapping), `lib/journalDescription.ts` (2.2: when a line's description shows, Ctrl+E's
choice, the Enter neighbour), `lib/bomForm.ts`, `lib/orderForm.ts`, `lib/model.ts` (status texts, alert text,
export layouts of every report incl. ITC-04 tables), `lib/charts.ts` (graphs and stats). Tests:
`lib/forms.test.ts`, `lib/screens.test.ts`, `lib/charts.test.ts`, `lib/keys21.test.ts` (every screen file still registers each key it had in 2.0),
`lib/journalDescription.test.ts` (2.2 line descriptions on the journal screen),
`lib/coreContract.test.ts` (2.2: the journal form against the real engine; test-only core imports).
