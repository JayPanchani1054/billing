/**
 * (2.2) Line descriptions on paper, read from the template sources (the templates are React, so — like
 * partsCoverage.test.ts — their markup is checked from source):
 *
 *   - every template prints the description typed on a line right under the line's name: Modern (parts.tsx
 *     ItemsTable), Classic, the stock documents and the Compact receipt (thermal rolls and the 'compact'
 *     template), which before 2.2 printed none;
 *   - an accounting voucher's entries print their narration (VoucherDoc, and the Compact receipt);
 *   - a charge's description prints under the charge: Modern TotalsTable and the receipt's totals through
 *     totalRows, Classic's charge rows through chargeText;
 *   - the typed text is always text content (escaped by React and by the serialiser), never an attribute value,
 *     so assertPrintableMarkup only ever sees it as words; and long words break (styles.ts).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPrintableMarkup, buildPrintHtml } from './document.ts';
import { DOCUMENT_CSS } from './styles.ts';

const printDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Source without comments (a pattern named in a comment proves nothing). */
const code = (rel: string): string =>
  fs
    .readFileSync(path.resolve(printDir, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const TEMPLATES = fs.readdirSync(path.resolve(printDir, 'templates')).filter((f) => f.endsWith('.tsx'));
/** The line's name (bold span or plain text), then its description as a small sub-line. */
const LINE_DESCRIPTION = /\{l\.name\}(?:<\/span>)?\s*\{l\.description \? <span className="bp-sub bp-pre">\{l\.description\}<\/span> : null\}/;

describe('(2.2) line descriptions print under the line, on every template', () => {
  test('item and ledger lines: Modern, Classic, stock documents and the Compact receipt', () => {
    for (const f of ['templates/parts.tsx', 'templates/ClassicInvoice.tsx', 'templates/InventoryDoc.tsx', 'templates/CompactDoc.tsx']) {
      assert.match(code(f), LINE_DESCRIPTION, f);
    }
    // The receipt: under the name, before the HSN · GST line and qty × rate (compactLineInfo is unchanged).
    const compact = code('templates/CompactDoc.tsx');
    const at = (s: string): number => compact.indexOf(s);
    assert.ok(at('{l.description ?') > at('{l.name}') && at('{l.description ?') < at('{info ?'), 'description, then HSN · GST');
    assert.ok(at('{info ?') < at('data-part="col.qty"'), 'then qty × rate');
  });

  test('entry narrations: the voucher layout and the Compact receipt', () => {
    for (const f of ['templates/VoucherDoc.tsx', 'templates/CompactDoc.tsx']) {
      assert.match(code(f), /\{e\.narration \? <span className="bp-sub bp-pre">\{e\.narration\}<\/span> : null\}/, f);
    }
  });

  test('charges: under the charge in the Modern totals, the receipt totals (totalRows) and Classic (chargeText)', () => {
    const rowText = /\{r\.kind === 'total' \? [^}]+\}\s*\{r\.description \? <span className="bp-sub bp-pre">\{r\.description\}<\/span> : null\}/;
    const parts = code('templates/parts.tsx');
    const totals = parts.slice(parts.indexOf('export function TotalsTable'), parts.indexOf('export function MrpRows'));
    assert.match(totals, /totalRows\(doc\)\.map/);
    assert.match(totals, rowText, 'Modern TotalsTable');
    const compact = code('templates/CompactDoc.tsx');
    assert.match(compact.slice(compact.indexOf('totalRows(doc).map')), rowText, 'Compact totals');
    // Classic draws its charge rows itself (bold, right-aligned): the description in normal weight under the name.
    assert.match(code('templates/ClassicInvoice.tsx'), /\{c\.name\}\s*\{chargeText\(c\) \? <span className="bp-sub bp-pre bp-normal">\{chargeText\(c\)\}<\/span> : null\}/);
    assert.match(code('templates/ClassicInvoice.tsx'), /charges\.map\(\(c, i\) => \(\s*<tr key=\{`\$\{i\}-\$\{c\.name\}`\}/, 'a ledger charged twice keeps a key per row');
  });

  test('typed texts are text content only: never an attribute, never HTML', () => {
    for (const f of TEMPLATES) {
      const src = code(`templates/${f}`);
      assert.doesNotMatch(src, /=\{\s*(?:l\.description|e\.narration|r\.description|c\.description|chargeText\()/, `${f}: an attribute takes a typed text`);
      assert.doesNotMatch(src, /dangerouslySetInnerHTML/, f);
    }
  });

  test('serialised, a description with links, markup-like words or "on…=" is printable text', () => {
    // What the serialiser writes for <span className="bp-sub bp-pre">{text}</span>: '<', '>' and '&' escaped.
    const text = 'SN-8842-XL · see https://example.com/w?id=1&x=2\nonload= url(https://x.example) <b>bold</b>';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = `<div class="bp-docs"><td data-part="col.description"><span class="bp-strong">Rice Bag</span><span class="bp-sub bp-pre">${escaped}</span></td></div>`;
    assert.doesNotThrow(() => assertPrintableMarkup(body));
    assert.match(buildPrintHtml({ title: 't', body, pageSize: '80mm', documents: 1 }), /SN-8842-XL · see https:\/\/example\.com\/w\?id=1&amp;x=2/);
  });

  test('long words in a description break instead of widening a narrow column', () => {
    assert.match(DOCUMENT_CSS, /\.bp-pre \{ white-space: pre-line; \}/, 'its newlines kept');
    assert.match(DOCUMENT_CSS, /\.bp-sub\.bp-pre \{ overflow-wrap: anywhere; \}/);
  });
});
