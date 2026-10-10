/**
 * The self-contained printable HTML document sent to pevqori.native('print.print' | 'print.savePdf').
 *
 * The body is the serialised markup of the rendered templates (`element.outerHTML` of the preview:
 * React escapes every value when rendering and the browser serialiser escapes text and attributes
 * again on output). `assertPrintableMarkup` is a defence-in-depth check that the markup carries no
 * script, event handler, external resource or embedded frame before it leaves the renderer.
 */
import { escapeHtml } from '../../../app/lib/exportFormat.ts';
import type { PrintPageSize } from '../../../../shared/types/print.ts';
import { DOCUMENT_CSS, pageCss } from './styles.ts';

export interface PrintHtmlInput {
  /** Document title (window title / PDF metadata). Escaped. */
  title: string;
  /** Serialised `.bp-docs` element. */
  body: string;
  pageSize: PrintPageSize;
  /** Number of physical documents (copies × vouchers); "Page x of y" only makes sense for one. */
  documents: number;
  /** Rolls: length of the receipt page in mm (layout.ts rollHeightMm); ignored for sheets. */
  rollHeightMm?: number | null;
}

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/<\s*script/i, 'a script'],
  [/<\s*(iframe|frame|object|embed|link|meta|base|form)\b/i, 'an embedded or external element'],
  // Inside tags only: serialised text content cannot contain a raw '<' or '>'.
  [/<[^>]*\son[a-z]+\s*=/i, 'an event handler'],
  [/<[^>]*\b(?:href|src|srcset|action|formaction|xlink:href)\s*=\s*["']?\s*(?:javascript|vbscript|https?|file|ftp):/i, 'an external or script link'],
  [/<[^>]*url\(\s*["']?\s*(?:https?|file|ftp|javascript):/i, 'an external stylesheet resource'],
];

/** Throws when the markup contains anything a printed document must never carry. */
export function assertPrintableMarkup(markup: string): void {
  for (const [re, what] of FORBIDDEN) {
    if (re.test(markup)) throw new Error(`The document could not be printed: it contains ${what}.`);
  }
}

/** Full HTML document: doctype, charset, escaped title, inline CSS, the body markup. */
export function buildPrintHtml(input: PrintHtmlInput): string {
  assertPrintableMarkup(input.body);
  const css = DOCUMENT_CSS + pageCss(input.pageSize, { pageNumbers: input.documents > 1 ? 'plain' : 'of', rollHeightMm: input.rollHeightMm });
  if (/<\/style/i.test(css)) throw new Error('Invalid print stylesheet');
  return [
    '<!doctype html>',
    '<html lang="en-IN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${css}</style>`,
    '</head>',
    `<body>${input.body}</body>`,
    '</html>',
  ].join('\n');
}
