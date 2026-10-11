/**
 * Money is never cut off in a table (2.1 calm audit: the Receivables ageing showed "1,82,539.00…" in its
 * 130 px age columns at 1366 px). numericFit sizes a numeric column to its longest value; DataTable uses it
 * for every amount / Dr-Cr / quantity / number column, rows and totals alike, and sums the same widths into
 * the table's minimum width so a text column next to them is not squeezed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DRCR_SUFFIX_EM, FIT_SCAN_LIMIT, fitColWidth, fitEm, fitLength, minWidthCalc, textEm } from './numericFit.ts';

test('digits are wider than separators; nothing to show is 0', () => {
  assert.ok(textEm('8') > textEm(','));
  assert.equal(fitEm([]), 0);
  assert.equal(fitEm(['', '']), 0);
  assert.equal(fitColWidth(130, 0), 130, 'no value: the declared width stays');
});

test('the longest value decides, bold-safe, with the Dr/Cr box', () => {
  const lakh = fitEm(['8,449.00', '1,82,539.00'], DRCR_SUFFIX_EM);
  assert.equal(lakh, fitEm(['1,82,539.00'], DRCR_SUFFIX_EM));
  assert.ok(lakh > fitEm(['8,449.00'], DRCR_SUFFIX_EM));
  // At the 13 px table text plus 2 × 12 px padding, ₹1,82,539.00 Dr needs more than the old 130 px…
  assert.ok(lakh * 13 + 26 > 130, `${lakh}em`);
  // …and a nine-column ageing table with lakh totals still fits a 1366 px window (≈ 1318 px of content).
  const col = (texts: string[], declared: number) => Math.max(declared, fitEm(texts, DRCR_SUFFIX_EM) * 13 + 26);
  const widths = [
    col(['8,449.00'], 130), col(['81,717.00'], 130), col(['1,04,145.00'], 130), col(['88,620.00'], 130),
    col(['1,82,539.00'], 130), col(['8,932.00'], 130), col(['3,71,000.00'], 120), col(['1,03,402.00'], 150),
  ];
  assert.ok(widths.reduce((a, b) => a + b, 200) <= 1318, `${widths.reduce((a, b) => a + b, 200)} px`);
});

test('a declared width grows to its longest value, never shrinks; the minimum width sums the same terms', () => {
  assert.equal(fitColWidth(130, 9.05), `max(130px, ${fitLength(9.05)})`);
  assert.equal(fitColWidth('12rem', 6), `max(12rem, ${fitLength(6)})`);
  assert.equal(fitColWidth(undefined, 6), undefined);
  assert.match(fitLength(9.05), /^calc\(9\.05em \+ 2 \* var\(--cell-px\) \+ 2px\)$/);
  assert.equal(minWidthCalc([200, `max(130px, ${fitLength(9.05)})`]), `calc(200px + max(130px, ${fitLength(9.05)}))`);
  assert.equal(minWidthCalc([]), 'calc(0px)');
  assert.ok(FIT_SCAN_LIMIT >= 1000);
});

test('DataTable sizes every numeric column with it (rows and totals; custom renders keep their width)', () => {
  const src = readFileSync(new URL('../DataTable.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /import \{ DRCR_SUFFIX_EM, FIT_SCAN_LIMIT, fitColWidth, fitEm, minWidthCalc \} from '\.\/lib\/numericFit\.ts';/);
  assert.match(src, /if \(!c\.kind \|\| !NUMERIC_KINDS\.has\(c\.kind\) \|\| c\.render\) continue;/);
  assert.match(src, /for \(const f of footer \?\? \[\]\)/);
  assert.match(src, /fitEm\(texts, drcr \? DRCR_SUFFIX_EM : 0\)/);
  assert.match(src, /<col key=\{c\.key\} style=\{colWidth\(c\) !== undefined \? \{ width: colWidth\(c\) \} : undefined\} \/>/);
  assert.match(src, /const minTableWidth = minWidthCalc\(/);
  assert.match(src, /style=\{\{ minWidth: minTableWidth \}\}/);
});
