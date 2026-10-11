# Print module (renderer)

Invoice / voucher documents drawn from the print DTO (`src/shared/types/print.ts`, built by
`src/core/modules/print`), previewed, printed, saved as PDF and shared. Templates never call the API:
everything a document needs is in `PrintVoucherData`.

| Screen | Id | What it does |
|---|---|---|
| Print Preview | `print.voucher` `{id, copies?, template?, pageSize?, autoPrint?, share?}` | one voucher: template, paper, copies, Print (Alt+P), PDF (Alt+E), Share (Alt+W), PgUp/PgDn, open voucher (Alt+V), **customize what prints (Alt+L)**, printer (More) |
| Print Vouchers | `print.batch` `{ids?}` | pick vouchers, combined preview, print all / one PDF, printer (More) |
| Invoice Printing | `print.settings` | the only editor of `config.invoice` (and the share texts), live preview, **Customize layout… (Alt+L)** |

Files: `templates/` (Modern, Classic, Compact receipt, inventory and voucher layouts, shared `parts.tsx`,
`PrintDocuments.tsx` — the root that gets printed), `components.tsx` (preview pane, controls, warnings),
`usePrinting.ts` (QR images, Print / PDF of the rendered `.bp-docs`), `ShareDialog.tsx`,
`VoucherSharePanel.tsx`, `LayoutEditor.tsx`, `lib/` (pure, unit-tested: `layout.ts` columns / totals /
references, `document.ts` printable HTML, `styles.ts`, `screenState.ts`, `layoutParts.ts`, `calm.ts` the
2.1 words of the screens).

WYSIWYG: Print, Save PDF and Share serialise the rendered `.bp-docs` element (`buildPrintHtml`), so what is
printed is exactly the preview. `assertPrintableMarkup` refuses scripts, handlers and external resources.

## Customize what prints (2.0, R5)

Model, storage and statutory warnings are shared (`src/shared/printLayout.ts`; docs/ARCHITECTURE.md
"Print layouts (2.0)"). This module adds:

- **One choke point.** `PrintDocuments` draws each document as `layoutDoc(doc, layers)` — saved company ‹
  saved voucher type ‹ this print — for the preview, Print, PDF, Share, batch printing, print after saving
  (saved layers only) and the Invoice Printing sample (whose draft company layer replaces the saved one).
- **Templates honour every part they list.** `lib/layoutParts.ts TEMPLATE_PARTS` (each template re-exports
  its list as `SUPPORTED_PARTS`): gates `isPartShown(doc, id)`, columns via `itemColumns()`, totals rows via
  `totalRows()`, DTO parts cleared by `applyPrintLayout`, option-owned parts through their Invoice Printing
  option, page numbers via `buildPrintHtml({ pageNumbers })`. Texts print as
  `printText(doc, id, templateText(kind, id, doc))`; with no layout every template prints its 1.0 output, the
  only difference being `data-part="<id>"` attributes. `lib/partsCoverage.test.ts` checks it.
- **The editor** (`LayoutEditor.tsx`): Show / Texts tabs, the "Always printed" line (2.0: locks), GST rule badges, the source of every
  value, "nothing to print on this document", click-to-select (`data-part` + one click handler on the
  preview container; outlines under `.bp-editing`, never printed), Esc back to the preview. Save for the
  voucher type (Alter masters) or for all documents (Change company settings) — option-owned parts and
  texts are written to their keys (`voucherTypePatch` / `companyPatch`); Reset ▾ per level (with confirm).
  The per-print edit is kept per voucher type while the preview is open and remembered for the session
  (`sessionStorage`, try/catch): reopening that kind of document **offers** it again ("Apply them").
  In Invoice Printing (company level) the declaration / terms / signatory boxes are those options: blank
  prints none and ↺ restores the built-in wording; elsewhere an empty box inherits the grey placeholder.
  Hiding the GSTIN also hides the PAN (`applyPrintLayout`); the PAN switch then reads "Hidden with your
  GSTIN" and turning it on writes an explicit `show`.
- **Warnings.** `layoutWarnings` lines (hidden Rule 46/48/49/53/55 particulars) join the "Before you print"
  banner of the preview and of batch printing, and the panel. Printing is never blocked.

Keys: Alt+L toggles the panel on Print Preview (new screen key, USER_GUIDE §15.4) and in Invoice
Printing. Inside the panel: Tab / Shift+Tab between switches and boxes, Space toggles, Esc returns to the
preview; a second Esc leaves the screen as before.

## Calm (2.1, SPEC-21 §1.11)

The print screens follow the 2.1 template (one title row, one filled button, keys learned not printed);
no capability and no key changed. The module has no stylesheet (its CSS budget is 0) and imports no graph
code (`app/lib/chartImports.test.ts`: invoices never carry graphs).

- **Print Preview.** Title row: `Print Preview  Sales 33 · Asha Retail · <state>  ‹ ›` — the context run
  (`lib/calm.ts previewContext`), the state words with at most one coloured (`previewStateWords`: the
  Cancelled badge stays, legal; else Optional; "e-Invoice", "Customized for this print" plain), and the
  PgUp / PgDn icon buttons (`aria-keyshortcuts`, native tooltip "Previous voucher · PgUp"). The run clips
  whatever leaves its box (`overflow: hidden` in ui/PageHeader), so the screen lays it out itself (inline
  styles — the module has no stylesheet): only the words ellipsize, the state words and ‹ › keep their size,
  ‹ › draw their focus ring inside (`outline-offset: -2px`, as the period token) and use `title` tooltips
  (a tooltip box would be cut off). Command bar: **Print** (filled) · Save as PDF · Share · More — Save as
  PDF and Share are `prominent` for that order (the convention order puts Share first; `calm21.test.ts` runs
  the real `layoutCommandBar` on the screen's actions); *Customize layout* (Alt+L) is no longer `prominent`; template,
  paper, copies, Open voucher and **"Printer: Ask every time…"** (a `NO_KEY` More item opening
  `PrinterDialog`, `printerItemLabel`) are under More. The 11-key hint line is F1's "This screen" line.
- **Controls line** (`PrintControls`): `Template [Modern ▾] · Paper [A4 ▾] · ☑ Original ☐ Duplicate ☐
  Triplicate` with inline labels; the paper select keeps the accessible name "Paper size" (parity.spec),
  the copies keep `group "Copies to print"`; hints and keys (Alt+T, Alt+S, Ctrl+1/2/3) are tooltips and
  `aria-keyshortcuts`. The printer select left this line (both print screens).
- **Before you print**: one amber line, the title verbatim, the warnings joined by " · " (`warningsLine`);
  never blocks printing. Print Vouchers names each warning text once with its documents ("Sales 33, Sales
  34: …", `mergeDocWarnings`) instead of once per document. The panel keeps its own "Hidden details GST rules require" note (both carry the
  Rule 46 text — print-layout.spec).
- **Layout editor**: title kept (`aside "Customize what prints"`); the description is read to screen readers
  only (`aria-describedby`); group captions lose "(n of m shown)" — "Header · 2 hidden" only when something
  is hidden (`groupCaption`); one part's notes show — the part last reached by keyboard or click-to-select,
  or last clicked (`activeNoteRow`; visually hidden otherwise, still its `aria-describedby`; all shown when
  read-only). A mouse press never changes it: collapsing a row above the pressed one would slide another
  control under the pointer before the release and lose the click. Locked parts collapse to one line per group, *Always printed: …*, each name
  keeping the `<switch id>-row` focus target of click-to-select, its tooltip "Always printed · <rule> · …". "Earlier changes in this session" is one
  line with *Apply them* / *Not now*. *Save for Sales* is secondary (the title row's Print is the screen's
  one filled button).
- **Print Vouchers**: the picker's period is the context run's token (click / Alt+F2) instead of a second
  title-row button; the preview has the same controls line and More › Printer. The printer dialog's title
  names the choice ("Printer" / "Receipt printer"); the select's label is for screen readers only.
- **Invoice Printing**: one Save (the title row, Ctrl+A) — the layout panel keeps *Reset layout* and
  *Done*; no subtitle; the groups' descriptions became the hints of their first field (shown on focus).

Tests: `lib/calm.test.ts` (the words, the notes row, the merged warnings), `lib/calm21.test.ts` (screen
structure and keys from source, the command bar through the real rule),
`lib/editorA11y.test.ts` (focus and the Always-printed line); e2e `print-layout.spec.ts` (More › Printer).
