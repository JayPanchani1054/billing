/**
 * Pure rules for cheque printing (tested in cheque.test.ts): where each field goes on the page, how
 * the amount in words wraps onto the leaf's two lines, how long text is fitted, the calibration sheet,
 * and the self-contained printable HTML document.
 *
 * Positions are millimetres from the top-left corner of the leaf (the top edge of the text). The page
 * is either the leaf itself (cheque printers / custom paper) or an A4 sheet with the leaf at its top-left
 * or top-centre; the layout's calibration offsets shift everything.
 */
import { CHEQUE_PT_MM, CHEQUE_SIGN_LINE_GAP_MM, type ChequeLayoutSpec, type ChequePoint, type ChequePrintItem } from '../../../../shared/types/cheques.ts';
import type { CustomPageMm, NativePageSize } from '../../../../shared/bridge.ts';
import { escapeHtml } from '../../../app/lib/exportFormat.ts';
import { assertPrintableMarkup } from '../../print/lib/document.ts';

export const PT_MM = CHEQUE_PT_MM;
/** Average glyph width of the print font as a share of the font size (Segoe UI / Arial, mixed case). */
const AVG_GLYPH = 0.5;

export const A4_MM = { width: 210, height: 297 } as const;

/** Page of a cheque print job and where the leaf sits on it. */
export interface ChequePage {
  native: { pageSize: NativePageSize; customPageMm?: CustomPageMm; margins: 'none' };
  widthMm: number;
  heightMm: number;
  leftMm: number;
  topMm: number;
}

export function chequePage(spec: ChequeLayoutSpec): ChequePage {
  if (spec.placement === 'leaf') {
    return {
      native: { pageSize: 'custom', customPageMm: { width: spec.widthMm, height: spec.heightMm }, margins: 'none' },
      widthMm: spec.widthMm,
      heightMm: spec.heightMm,
      leftMm: 0,
      topMm: 0,
    };
  }
  const left = spec.placement === 'a4_center' ? Math.max(0, (A4_MM.width - spec.widthMm) / 2) : 0;
  return { native: { pageSize: 'A4', margins: 'none' }, widthMm: A4_MM.width, heightMm: A4_MM.height, leftMm: round1(left), topMm: 0 };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Characters of the print font that fit in `widthMm` at `fontPt`. */
export function charsThatFit(widthMm: number, fontPt: number): number {
  return Math.max(1, Math.floor(widthMm / (fontPt * PT_MM * AVG_GLYPH)));
}

/** Font size (pt) that fits `text` into `widthMm`: the layout's size, shrunk down to 7 pt at most. */
export function fitFontPt(text: string, widthMm: number | undefined, fontPt: number): number {
  if (!widthMm || text.length === 0) return fontPt;
  const need = text.length * fontPt * PT_MM * AVG_GLYPH;
  if (need <= widthMm) return fontPt;
  return Math.max(7, Math.floor(((fontPt * widthMm) / need) * 10) / 10);
}

/**
 * Amount in words on the leaf's two lines: as many whole words on line 1 as fit, the rest on line 2.
 * `overflow` when even the second line is too short (the caller warns; text is never cut).
 */
export function splitWords(words: string, w1Mm: number, w2Mm: number, fontPt: number): { line1: string; line2: string; overflow: boolean } {
  const max1 = charsThatFit(w1Mm, fontPt);
  const max2 = charsThatFit(w2Mm, fontPt);
  const parts = words.split(/\s+/).filter(Boolean);
  let line1 = '';
  let i = 0;
  for (; i < parts.length; i++) {
    const next = line1 ? `${line1} ${parts[i]}` : parts[i];
    if (next.length > max1 && line1) break;
    line1 = next;
  }
  const line2 = parts.slice(i).join(' ');
  return { line1, line2, overflow: line2.length > max2 };
}

/** One positioned piece of text / mark on the page (mm). */
export interface ChequeMark {
  key: string;
  kind: 'text' | 'digit' | 'crossing' | 'box' | 'rule';
  text: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  fontPt: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

function at(spec: ChequeLayoutSpec, page: ChequePage, p: ChequePoint): { x: number; y: number } {
  return { x: round1(page.leftMm + spec.offsetX + p.x), y: round1(page.topMm + spec.offsetY + p.y) };
}

/** Everything printed for one cheque, positioned on the page. */
export function chequeMarks(item: Pick<ChequePrintItem, 'dateDigits' | 'payee' | 'amountWords' | 'amountFigures' | 'acPayee' | 'companyName' | 'signatory'>, spec: ChequeLayoutSpec): { marks: ChequeMark[]; warnings: string[] } {
  const page = chequePage(spec);
  const f = spec.fontPt;
  const marks: ChequeMark[] = [];
  const warnings: string[] = [];
  // Date: eight boxes D D M M Y Y Y Y.
  const d = at(spec, page, spec.date);
  [...item.dateDigits].slice(0, 8).forEach((ch, i) => {
    marks.push({ key: `date${i}`, kind: 'digit', text: ch, x: round1(d.x + i * spec.date.pitch), y: d.y, w: spec.date.pitch, fontPt: f, bold: true, align: 'center' });
  });
  const payee = at(spec, page, spec.payee);
  const payeeText = `${item.payee}`;
  const payeePt = fitFontPt(payeeText, spec.payee.w, f);
  if (payeePt < f) warnings.push(`The payee name is long: printed at ${payeePt} pt to fit the line.`);
  marks.push({ key: 'payee', kind: 'text', text: payeeText, x: payee.x, y: payee.y, w: spec.payee.w, fontPt: payeePt, bold: true });
  const w = splitWords(item.amountWords, spec.words.w ?? 120, spec.words2.w ?? 140, f);
  if (w.overflow) warnings.push('The amount in words does not fit the two lines: reduce the font size or widen the lines in the layout.');
  const w1 = at(spec, page, spec.words);
  marks.push({ key: 'words1', kind: 'text', text: w.line1, x: w1.x, y: w1.y, w: spec.words.w, fontPt: f });
  if (w.line2) {
    const w2 = at(spec, page, spec.words2);
    marks.push({ key: 'words2', kind: 'text', text: w.line2, x: w2.x, y: w2.y, w: spec.words2.w, fontPt: f });
  }
  const fig = at(spec, page, spec.figures);
  marks.push({ key: 'figures', kind: 'text', text: item.amountFigures, x: fig.x, y: fig.y, w: spec.figures.w, fontPt: fitFontPt(item.amountFigures, spec.figures.w, f + 1), bold: true });
  if (item.acPayee) {
    const c = at(spec, page, spec.acPayee);
    marks.push({ key: 'crossing', kind: 'crossing', text: 'A/c Payee', x: c.x, y: c.y, w: spec.acPayee.w ?? 30, fontPt: Math.max(7, f - 2), bold: true });
  }
  const s = at(spec, page, spec.signatory);
  marks.push({ key: 'for', kind: 'text', text: `For ${item.companyName}`, x: s.x, y: s.y, w: spec.signatory.w, fontPt: fitFontPt(`For ${item.companyName}`, spec.signatory.w, Math.max(7, f - 2)), bold: true, align: 'center' });
  marks.push({ key: 'sign', kind: 'text', text: item.signatory, x: s.x, y: round1(s.y + CHEQUE_SIGN_LINE_GAP_MM), w: spec.signatory.w, fontPt: Math.max(7, f - 3), align: 'center' });
  return { marks, warnings };
}

/** Calibration sheet: a 10 mm grid over the leaf, the leaf's outline, and a labelled box at each field. */
export function calibrationMarks(spec: ChequeLayoutSpec): ChequeMark[] {
  const page = chequePage(spec);
  const marks: ChequeMark[] = [];
  const ox = page.leftMm + spec.offsetX;
  const oy = page.topMm + spec.offsetY;
  for (let x = 0; x <= spec.widthMm; x += 10) {
    marks.push({ key: `vx${x}`, kind: 'rule', text: x % 50 === 0 ? String(x) : '', x: round1(ox + x), y: round1(oy), w: 0, h: spec.heightMm, fontPt: 6 });
  }
  for (let y = 0; y <= spec.heightMm; y += 10) {
    marks.push({ key: `hy${y}`, kind: 'rule', text: y % 20 === 0 ? String(y) : '', x: round1(ox), y: round1(oy + y), w: spec.widthMm, h: 0, fontPt: 6 });
  }
  marks.push({ key: 'leaf', kind: 'box', text: '', x: round1(ox), y: round1(oy), w: spec.widthMm, h: spec.heightMm, fontPt: 6 });
  const box = (key: string, label: string, p: ChequePoint, w: number): void => {
    const q = at(spec, page, p);
    marks.push({ key, kind: 'box', text: label, x: q.x, y: q.y, w, h: spec.fontPt * PT_MM * 1.3, fontPt: 7 });
  };
  for (let i = 0; i < 8; i++) box(`d${i}`, 'DDMMYYYY'[i], { x: spec.date.x + i * spec.date.pitch, y: spec.date.y }, spec.date.pitch);
  box('payee', 'PAYEE', spec.payee, spec.payee.w ?? 120);
  box('words', 'AMOUNT IN WORDS — LINE 1', spec.words, spec.words.w ?? 120);
  box('words2', 'LINE 2', spec.words2, spec.words2.w ?? 120);
  box('figures', '**AMOUNT/-', spec.figures, spec.figures.w ?? 36);
  box('crossing', 'A/C PAYEE', spec.acPayee, spec.acPayee.w ?? 30);
  box('signatory', 'SIGNATORY', spec.signatory, spec.signatory.w ?? 50);
  return marks;
}

// ───────────────────────────── Printable document ─────────────────────────────

const INK = 'CanvasText';
const PAPER = 'Canvas';

/**
 * Stylesheet of the cheque pages. `print`: with the @page rule and the body reset of the printed
 * document; without, the class rules alone (the in-app preview must not restyle the app's own page).
 */
export function chequeCss(spec: ChequeLayoutSpec, print = true): string {
  const page = chequePage(spec);
  const pageRules = print ? `@page { size: ${page.widthMm}mm ${page.heightMm}mm; margin: 0; }\nhtml, body { margin: 0; padding: 0; background: ${PAPER}; }\n` : '';
  return `
${pageRules}.cq-docs { color-scheme: light; color: ${INK}; background: ${PAPER}; font-family: "Segoe UI", Arial, "Noto Sans", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cq-page { position: relative; width: ${page.widthMm}mm; height: ${page.heightMm}mm; overflow: hidden; break-after: page; }
.cq-page:last-child { break-after: auto; }
.cq-m { position: absolute; white-space: nowrap; line-height: 1; }
.cq-b { font-weight: 700; }
.cq-c { text-align: center; }
.cq-cross { border-top: 0.35mm solid ${INK}; border-bottom: 0.35mm solid ${INK}; padding: 0.8mm 0; text-align: center; transform: rotate(-20deg); transform-origin: left top; letter-spacing: 0.04em; }
.cq-box { border: 0.25mm dashed ${INK}; font-size: 6pt; overflow: hidden; color: color-mix(in srgb, ${INK} 70%, ${PAPER}); }
.cq-rule { border-left: 0.1mm solid color-mix(in srgb, ${INK} 25%, ${PAPER}); border-top: 0.1mm solid color-mix(in srgb, ${INK} 25%, ${PAPER}); font-size: 5pt; color: color-mix(in srgb, ${INK} 60%, ${PAPER}); }
`;
}

/** The serialised preview (`.cq-docs`) as a self-contained printable HTML document. */
export function buildChequeHtml(input: { title: string; body: string; spec: ChequeLayoutSpec }): string {
  assertPrintableMarkup(input.body);
  const css = chequeCss(input.spec);
  if (/<\/style/i.test(css)) throw new Error('Invalid print stylesheet');
  return ['<!doctype html>', '<html lang="en-IN">', '<head>', '<meta charset="utf-8">', `<title>${escapeHtml(input.title)}</title>`, `<style>${css}</style>`, '</head>', `<body>${input.body}</body>`, '</html>'].join('\n');
}

// ───────────────────────────── Selection ─────────────────────────────

/** Cheques that will print: all, minus the ones the user left out. */
export function selectedCheques<T extends { key: string }>(items: readonly T[], excluded: ReadonlySet<string>): T[] {
  return items.filter((i) => !excluded.has(i.key));
}

/** One layout per print job (the page size comes from it): the cheques whose layout differs are listed. */
export function mixedLayouts(items: ReadonlyArray<{ layoutName: string; spec: ChequeLayoutSpec }>): string[] {
  const names = [...new Set(items.map((i) => `${i.layoutName}|${JSON.stringify(i.spec)}`))];
  return names.length > 1 ? names.map((n) => n.split('|')[0]) : [];
}

// ───────────────────────────── Markup without the DOM ─────────────────────────────

/** Inline style of one mark: the same box the preview (components.tsx › MarkView) draws. */
export function markStyle(m: ChequeMark): string {
  const parts = [`left:${m.x}mm`, `top:${m.y}mm`, `font-size:${m.fontPt}pt`];
  if (m.kind === 'rule') {
    if (m.w === 0) parts.push(`height:${m.h ?? 0}mm`);
    else parts.push(`width:${m.w ?? 0}mm`);
  } else if (m.kind === 'box') {
    if (m.w !== undefined) parts.push(`width:${m.w}mm`);
    parts.push(`height:${m.h ?? 4}mm`);
  } else if (m.kind === 'crossing') {
    parts.push(`width:${m.w ?? 30}mm`);
  } else if (m.w !== undefined) {
    parts.push(`width:${m.w}mm`);
  }
  return parts.join(';');
}

/** Class list of one mark. */
export function markClass(m: ChequeMark): string {
  if (m.kind === 'rule') return 'cq-m cq-rule';
  if (m.kind === 'box') return 'cq-m cq-box';
  if (m.kind === 'crossing') return 'cq-m cq-cross cq-b';
  return ['cq-m', m.bold ? 'cq-b' : '', m.align === 'center' ? 'cq-c' : ''].filter(Boolean).join(' ');
}

/**
 * The `.cq-docs` markup of some pages, every text HTML-escaped — for printing a page the screen does
 * not show (the calibration sheet from the layout form). Same structure as <ChequeSheets>.
 */
export function chequePagesMarkup(pages: ReadonlyArray<{ marks: readonly ChequeMark[] }>, spec: ChequeLayoutSpec): string {
  const page = chequePage(spec);
  const body = pages
    .map((p) => `<div class="cq-page" style="width:${page.widthMm}mm;height:${page.heightMm}mm">${p.marks.map((m) => `<div class="${markClass(m)}" style="${markStyle(m)}">${escapeHtml(m.text)}</div>`).join('')}</div>`)
    .join('');
  return `<div class="cq-docs">${body}</div>`;
}
