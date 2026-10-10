# Print module (renderer)

Invoice / voucher documents drawn from the print DTO (`src/shared/types/print.ts`, built by
`src/core/modules/print`), previewed, printed, saved as PDF and shared. Templates never call the API:
everything a document needs is in `PrintVoucherData`.

| Screen | Id | What it does |
|---|---|---|
| Print Preview | `print.voucher` `{id, copies?, template?, pageSize?, autoPrint?, share?}` | one voucher: template, paper, printer, copies, Print (Alt+P), PDF (Alt+E), Share (Alt+W), PgUp/PgDn, open voucher (Alt+V), **customize what prints (Alt+L)** |
| Print Vouchers | `print.batch` `{ids?}` | pick vouchers, combined preview, print all / one PDF |
| Invoice Printing | `print.settings` | the only editor of `config.invoice` (and the share texts), live preview, **Customize layout… (Alt+L)** |

Files: `templates/` (Modern, Classic, Compact receipt, inventory and voucher layouts, shared `parts.tsx`,
`PrintDocuments.tsx` — the root that gets printed), `components.tsx` (preview pane, controls, warnings),
`usePrinting.ts` (QR images, Print / PDF of the rendered `.bp-docs`), `ShareDialog.tsx`,
`VoucherSharePanel.tsx`, `LayoutEditor.tsx`, `lib/` (pure, unit-tested: `layout.ts` columns / totals /
references, `document.ts` printable HTML, `styles.ts`, `screenState.ts`, `layoutParts.ts`).

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
- **The editor** (`LayoutEditor.tsx`): Show / Texts tabs, locks, GST rule badges, the source of every
  value, "nothing to print on this document", click-to-select (`data-part` + one click handler on the
  preview container; outlines under `.bp-editing`, never printed), Esc back to the preview. Save for the
  voucher type (Alter masters) or for all documents (Change company settings) — option-owned parts and
  texts are written to their keys (`voucherTypePatch` / `companyPatch`); Reset ▾ per level (with confirm).
  The per-print edit is kept per voucher type while the preview is open and remembered for the session
  (`sessionStorage`, try/catch): reopening that kind of document **offers** it again ("Apply them").
- **Warnings.** `layoutWarnings` lines (hidden Rule 46/48/49/53/55 particulars) join the "Before you print"
  banner of the preview and of batch printing, and the panel. Printing is never blocked.

Keys: Alt+L toggles the panel on Print Preview (new screen key, USER_GUIDE §15.4) and in Invoice
Printing. Inside the panel: Tab / Shift+Tab between switches and boxes, Space toggles, Esc returns to the
preview; a second Esc leaves the screen as before.
