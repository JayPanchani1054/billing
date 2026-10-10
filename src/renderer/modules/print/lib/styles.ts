/**
 * Stylesheets for printed documents. One stylesheet serves the in-app preview and the printed HTML,
 * scoped under `.bp-docs` so it never touches the app. Colours are system colours (Canvas /
 * CanvasText with `color-scheme: light`) mixed with color-mix — paper is always white with black
 * ink, prints well on black-and-white printers, and no raw colour values are used.
 */
import type { PrintPageSize } from '../../../../shared/types/print.ts';

const INK = 'CanvasText';
const PAPER = 'Canvas';
const mix = (pct: number): string => `color-mix(in srgb, ${INK} ${pct}%, ${PAPER})`;

/** Document styles (preview + print). */
export const DOCUMENT_CSS = `
.bp-docs { color-scheme: light; color: ${INK}; background: ${PAPER}; font: 9pt/1.35 "Segoe UI", "Noto Sans", system-ui, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; text-align: left; }
.bp-docs *, .bp-docs *::before, .bp-docs *::after { box-sizing: border-box; }
.bp-docs p, .bp-docs h1, .bp-docs h2, .bp-docs h3 { margin: 0; }
.bp-docs img { display: block; max-width: 100%; }
.bp-doc { position: relative; }
.bp-doc + .bp-doc { break-before: page; }
.bp-doc table { width: 100%; border-collapse: collapse; }
.bp-doc thead { display: table-header-group; }
.bp-doc tfoot { display: table-row-group; }
.bp-doc tr, .bp-avoid { break-inside: avoid; }
.bp-doc th, .bp-doc td { padding: 2.5pt 4pt; vertical-align: top; text-align: left; font-weight: normal; }
.bp-num { text-align: right !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bp-center { text-align: center !important; }
.bp-strong { font-weight: 700 !important; }
.bp-muted { color: ${mix(62)}; }
.bp-small { font-size: .86em; }
.bp-sub { display: block; font-size: .86em; color: ${mix(62)}; }
.bp-cap { font-size: .78em; text-transform: uppercase; letter-spacing: .06em; color: ${mix(62)}; margin-bottom: 1.5pt; }
.bp-pre { white-space: pre-line; }
.bp-gap { height: 6pt; }

/* Status stamp (CANCELLED / OPTIONAL / SAMPLE) */
.bp-stamp { position: absolute; top: 38%; left: 0; right: 0; text-align: center; transform: rotate(-24deg);
  font-size: 46pt; font-weight: 800; letter-spacing: .12em; color: ${mix(14)}; pointer-events: none; z-index: 0; }

/* ── Header ── */
.bp-head { display: flex; gap: 10pt; align-items: flex-start; justify-content: space-between; padding-bottom: 6pt; border-bottom: 1.5pt solid ${INK}; }
.bp-brand { display: flex; gap: 8pt; align-items: flex-start; min-width: 0; }
.bp-logo { max-height: 18mm; max-width: 34mm; object-fit: contain; }
.bp-co-name { font-size: 14pt; font-weight: 700; line-height: 1.15; }
.bp-co-lines { font-size: .9em; margin-top: 2pt; }
.bp-titlebox { text-align: right; flex: none; max-width: 48%; }
.bp-title { font-size: 15pt; font-weight: 700; letter-spacing: .02em; line-height: 1.1; }
.bp-copy { display: inline-block; margin-top: 3pt; padding: 1pt 5pt; border: .75pt solid ${INK}; font-size: .8em; text-transform: uppercase; letter-spacing: .05em; }
.bp-endorse { margin-top: 3pt; font-size: .86em; font-weight: 700; }
.bp-notes { margin-top: 3pt; font-size: .86em; }

/* ── Reference grid and parties ── */
.bp-refs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; border-bottom: .75pt solid ${mix(30)}; }
.bp-ref { padding: 3pt 4pt 3pt 0; min-width: 0; }
.bp-ref .bp-v { font-weight: 600; overflow-wrap: anywhere; }
.bp-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; padding: 6pt 0; }
.bp-party-name { font-weight: 700; font-size: 1.05em; }
.bp-ids { margin-top: 2pt; }
.bp-ids span { margin-right: 8pt; white-space: nowrap; }

/* ── Items table (modern) ── */
.bp-items { margin-top: 2pt; }
.bp-items thead th { background: ${mix(8)}; border-top: .75pt solid ${INK}; border-bottom: .75pt solid ${INK}; font-weight: 600; font-size: .9em; }
.bp-items tbody td { border-bottom: .5pt solid ${mix(22)}; }
.bp-items tbody tr.bp-absorbed td { color: ${mix(62)}; font-style: italic; }
.bp-items tfoot td { border-top: .75pt solid ${INK}; border-bottom: .75pt solid ${INK}; font-weight: 700; }
.bp-sl { width: 1%; white-space: nowrap; }

/* ── Summary row: words / bank / QR left, totals right ── */
.bp-summary { display: flex; gap: 12pt; align-items: flex-start; margin-top: 6pt; }
.bp-summary-left { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6pt; }
.bp-totals { flex: 0 0 42%; }
.bp-totals td { padding: 2pt 4pt; }
.bp-totals tr.bp-total td { border-top: 1pt solid ${INK}; border-bottom: 2.25pt double ${INK}; font-weight: 700; font-size: 1.1em; }
.bp-words { font-weight: 600; }
.bp-pay { display: flex; gap: 8pt; align-items: flex-start; }
.bp-qr { width: 24mm; height: 24mm; image-rendering: pixelated; flex: none; }
.bp-qr-lg { width: 30mm; height: 30mm; image-rendering: pixelated; flex: none; }
.bp-bank td { padding: 0 6pt 0 0; }

/* ── Tax / HSN summary ── */
.bp-taxsum { margin-top: 6pt; font-size: .88em; }
.bp-taxsum th { border-top: .75pt solid ${INK}; border-bottom: .75pt solid ${INK}; background: ${mix(6)}; font-weight: 600; }
.bp-taxsum td { border-bottom: .5pt solid ${mix(22)}; }
.bp-taxsum tfoot td { font-weight: 700; border-top: .75pt solid ${INK}; }

/* ── Footer ── */
.bp-foot { display: flex; gap: 12pt; justify-content: space-between; align-items: flex-end; margin-top: 10pt; break-inside: avoid; }
.bp-foot-left { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 5pt; }
.bp-sign { flex: 0 0 38%; text-align: right; }
.bp-sign-space { height: 16mm; }
.bp-sign-for { font-weight: 700; }
.bp-einv { display: flex; gap: 8pt; align-items: flex-start; margin-top: 6pt; padding: 4pt; border: .75pt solid ${mix(40)}; break-inside: avoid; }
.bp-irn { font-family: Consolas, "Courier New", monospace; font-size: .82em; overflow-wrap: anywhere; }
.bp-generated { margin-top: 8pt; text-align: center; font-size: .8em; color: ${mix(62)}; }
.bp-sigs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12pt; margin-top: 18mm; text-align: center; }
.bp-sigs div { border-top: .75pt solid ${INK}; padding-top: 2pt; font-size: .9em; }

/* ── Classic (boxed) ── */
.bp-classic .bp-title-c { text-align: center; font-size: 13pt; font-weight: 700; margin-bottom: 3pt; }
.bp-classic .bp-topline { display: flex; justify-content: space-between; font-size: .86em; margin-bottom: 2pt; }
.bp-box, .bp-box th, .bp-box td { border: .75pt solid ${INK}; }
.bp-box th { font-weight: 600; text-align: center; background: ${mix(6)}; }
.bp-box .bp-noline-v td { border-top: 0; border-bottom: 0; }
.bp-box td.bp-cell { padding: 3pt 4pt; }
.bp-classic .bp-items-c tbody td { border-top: 0; border-bottom: 0; }
.bp-classic .bp-items-c tbody tr.bp-fill td { height: 100%; }
.bp-classic .bp-items-c tr.bp-taxrow td { font-style: normal; }
.bp-classic .bp-items-c tfoot td { font-weight: 700; border-top: .75pt solid ${INK}; }
.bp-classic .bp-eoe { display: flex; justify-content: space-between; }
.bp-classic .bp-decl { display: grid; grid-template-columns: 1fr 1fr; }
.bp-w50 { width: 50%; }
.bp-p0 { padding: 0 !important; }
.bp-row { display: flex; gap: 6pt; align-items: flex-start; }
.bp-sep-top { border-top: .75pt solid ${INK}; }
.bp-box.bp-inner, .bp-box.bp-inner > tbody > tr:first-child > td { border-top: 0; }
.bp-box.bp-inner { border: 0; }
.bp-box.bp-inner td { border-left: 0; }
.bp-box.bp-inner tr > td:last-child { border-right: 0; }
.bp-box.bp-inner tr:last-child > td { border-bottom: 0; }
.bp-normal { font-weight: normal !important; }
.bp-pad-v { padding: 3pt 0; }
.bp-sign-c { flex: none; margin-top: 6pt; }

/* ── Compact (80 mm receipt) ── */
.bp-compact { font-size: 8pt; line-height: 1.3; }
.bp-compact .bp-c-center { text-align: center; }
.bp-compact .bp-c-name { font-size: 11pt; font-weight: 700; }
.bp-compact .bp-c-title { font-weight: 700; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .04em; margin-top: 3pt; }
.bp-compact .bp-c-rule { border-top: .75pt dashed ${INK}; margin: 3pt 0; }
.bp-compact td, .bp-compact th { padding: 1pt 0; }
.bp-compact .bp-c-item td { padding-top: 2pt; }
.bp-compact .bp-c-total td { font-weight: 700; font-size: 10pt; border-top: .75pt dashed ${INK}; padding-top: 2pt; }
.bp-compact .bp-qr { width: 30mm; height: 30mm; margin: 3pt auto; }
.bp-compact .bp-c-sign { margin-top: 6pt; text-align: right; }
.bp-compact .bp-c-sign-space { height: 8mm; }
.bp-compact .bp-c-saved td { font-weight: 700; padding-top: 2pt; }

/* ── Smaller paper ── */
.bp-size-a5 { font-size: 7.6pt; }
.bp-size-a5 .bp-co-name { font-size: 11.5pt; }
.bp-size-a5 .bp-title { font-size: 12pt; }
.bp-size-a5 .bp-refs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.bp-size-a5 .bp-sign-space { height: 11mm; }
.bp-size-a5-landscape { font-size: 8pt; }
.bp-size-a5-landscape .bp-co-name { font-size: 12pt; }
.bp-size-a5-landscape .bp-title { font-size: 12.5pt; }
.bp-size-a5-landscape .bp-sign-space { height: 11mm; }
.bp-size-80mm { font-size: 8pt; }
.bp-size-58mm { font-size: 7pt; }
.bp-size-58mm .bp-compact { font-size: 7pt; }
.bp-size-58mm .bp-compact .bp-c-name { font-size: 9.5pt; }
.bp-size-58mm .bp-compact .bp-c-title { font-size: 8pt; }
.bp-size-58mm .bp-compact .bp-qr { width: 26mm; height: 26mm; }
`;

/** In-app preview chrome: each copy drawn as a sheet of paper (or a strip of roll) at its real width. */
export function previewCss(size: PrintPageSize): string {
  const page = PAGE[size];
  return `
.bp-preview { padding: var(--space-4); }
.bp-preview .bp-doc { width: ${page.width}; min-height: ${page.minHeight}; padding: ${page.margin}; margin: 0 auto var(--space-5);
  background: Canvas; box-shadow: var(--shadow-2); overflow: hidden; }
.bp-preview .bp-doc + .bp-doc { break-before: auto; }
`;
}

/**
 * (2.0) Preview-only chrome of the layout editor (Alt+L): printable parts outlined on hover and the selected
 * part marked. Scoped under `.bp-editing`, a class of the preview container OUTSIDE `.bp-docs`, so neither
 * the class nor these rules ever reach the printed / PDF / shared HTML. `selected` is a catalogue part id
 * (checked by the caller); anything else is ignored.
 */
export function editingCss(selected: string | null): string {
  const sel = selected && /^[a-z][A-Za-z.]*$/.test(selected) ? selected : null;
  return `
.bp-editing [data-part] { cursor: pointer; }
.bp-editing [data-part]:hover { outline: 1px dashed var(--brand); outline-offset: 1px; }
${sel ? `.bp-editing [data-part="${sel}"] { outline: 2px solid var(--brand); outline-offset: 1px; }` : ''}
`;
}

interface PageGeometry {
  width: string;
  minHeight: string;
  /** Sheets: @page margin. Rolls: padding inside the receipt (the roll page has no margin). */
  margin: string;
  /** @page size for sheets; rolls get '<width> <measured length>'. */
  css: string;
  roll: boolean;
}

/**
 * Paper geometry. Rolls: 80 mm paper prints 72 mm wide (576 dots at 203 dpi), 58 mm paper 48 mm
 * (384 dots) — the receipt's side padding keeps the text inside the printable width.
 */
const PAGE: Record<PrintPageSize, PageGeometry> = {
  A4: { width: '210mm', minHeight: '297mm', margin: '10mm 10mm 12mm', css: 'A4 portrait', roll: false },
  A5: { width: '148mm', minHeight: '210mm', margin: '7mm 7mm 9mm', css: 'A5 portrait', roll: false },
  'A5-landscape': { width: '210mm', minHeight: '148mm', margin: '7mm 8mm 8mm', css: 'A5 landscape', roll: false },
  Letter: { width: '215.9mm', minHeight: '279.4mm', margin: '10mm 10mm 12mm', css: 'letter portrait', roll: false },
  Legal: { width: '215.9mm', minHeight: '355.6mm', margin: '10mm 10mm 12mm', css: 'legal portrait', roll: false },
  '80mm': { width: '80mm', minHeight: '60mm', margin: '3mm 4mm', css: '80mm', roll: true },
  '58mm': { width: '58mm', minHeight: '50mm', margin: '2mm 5mm', css: '58mm', roll: true },
};

/**
 * @page rules and body reset for the printed HTML document. A roll is one page per receipt, as long as
 * the tallest receipt (`rollHeightMm`, measured from the preview; 297 mm when unknown), printed edge to
 * edge with the receipt's own padding.
 */
export function pageCss(size: PrintPageSize, opts: { pageNumbers: 'of' | 'plain' | 'none'; rollHeightMm?: number | null }): string {
  const page = PAGE[size];
  if (page.roll) {
    const h = opts.rollHeightMm && opts.rollHeightMm > 0 ? Math.ceil(opts.rollHeightMm) : 297;
    return `
@page { size: ${page.css} ${h}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: ${PAPER}; }
.bp-docs.bp-size-${size} .bp-doc { width: ${page.width}; max-width: 100%; padding: ${page.margin}; margin: 0; }
`;
  }
  const counter =
    opts.pageNumbers === 'none'
      ? ''
      : `@bottom-right { content: "Page " counter(page)${opts.pageNumbers === 'of' ? ' " of " counter(pages)' : ''}; font: 7pt "Segoe UI", system-ui, sans-serif; color: ${mix(55)}; }`;
  return `
@page { size: ${page.css}; margin: ${page.margin}; ${counter} }
html, body { margin: 0; padding: 0; background: ${PAPER}; }
`;
}
