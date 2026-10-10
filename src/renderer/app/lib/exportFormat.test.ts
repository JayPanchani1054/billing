import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildPrintHtml,
  bytesToBase64,
  csvCellText,
  escapeHtml,
  exportFileName,
  fileSlug,
  formatBytes,
  formatExportCell,
  guardFormula,
  sniffImageMime,
  toCsv,
} from './exportFormat.ts';
import type { TableExportDef } from './exportFormat.ts';

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>alert("x") & 'y'</script>`), '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
  });
  test('null/undefined → empty; numbers stringified; already-escaped text is escaped again', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml('&amp;'), '&amp;amp;');
    assert.equal(escapeHtml('Sharma & Sons — ₹ बही'), 'Sharma &amp; Sons — ₹ बही');
  });
});

describe('cell formatting', () => {
  test('formatExportCell by kind', () => {
    assert.equal(formatExportCell(12345678, { header: 'A', kind: 'amount' }), '1,23,456.78');
    assert.equal(formatExportCell(-150000, { header: 'B', kind: 'drcr' }), '1,500.00 Cr');
    assert.equal(formatExportCell(0, { header: 'B', kind: 'drcr' }), '');
    assert.equal(formatExportCell(12.5, { header: 'Q', kind: 'qty', decimals: 3 }), '12.500');
    assert.equal(formatExportCell(18, { header: 'P', kind: 'percent' }), '18.00%');
    assert.equal(formatExportCell('2026-10-05', { header: 'D', kind: 'date' }), '05-Oct-2026');
    assert.equal(formatExportCell(true, { header: 'X' }), 'Yes');
    assert.equal(formatExportCell(null, { header: 'X' }), '');
    assert.equal(formatExportCell('Opening', { header: 'A', kind: 'amount' }), 'Opening');
  });

  test('csvCellText: plain rupees, Dr/Cr, ISO-free dates', () => {
    assert.equal(csvCellText(12345678, { header: 'A', kind: 'amount' }), '123456.78');
    assert.equal(csvCellText(-5, { header: 'A', kind: 'amount' }), '-0.05');
    assert.equal(csvCellText(-150000, { header: 'B', kind: 'drcr' }), '1500.00 Cr');
    assert.equal(csvCellText(150000, { header: 'B', kind: 'drcr' }), '1500.00 Dr');
    assert.equal(csvCellText('2026-10-05', { header: 'D', kind: 'date' }), '05-10-2026');
  });
});

describe('CSV', () => {
  const def: Pick<TableExportDef, 'columns' | 'rows' | 'totals'> = {
    columns: [
      { header: 'Particulars', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Closing', kind: 'drcr' },
    ],
    rows: [
      ['Cash', 100000, 100000],
      ['Sharma, "Bros"', null, -2500],
      ['=HYPERLINK("x")', 1, 1],
    ],
    totals: ['Total', 100001, null],
  };

  test('BOM, CRLF, quoting and formula guard', () => {
    const csv = toCsv(def);
    assert.ok(csv.startsWith('﻿'));
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'Particulars,Debit,Closing');
    assert.equal(lines[1], 'Cash,1000.00,1000.00 Dr');
    assert.equal(lines[2], '"Sharma, ""Bros""",,25.00 Cr');
    assert.equal(lines[3], `"'=HYPERLINK(""x"")",0.01,0.01 Dr`);
    assert.equal(lines[4], 'Total,1000.01,');
    assert.equal(lines[5], '');
  });

  test('guardFormula', () => {
    for (const s of ['=1+1', '+91 98', '-x', '@SUM', '\tA']) assert.ok(guardFormula(s).startsWith("'"));
    assert.equal(guardFormula('Cash'), 'Cash');
    // Plain numbers written as text are left alone (negative amounts stay numbers in the spreadsheet).
    for (const s of ['-12.50', '-1,23,456.00', '+5', '-0']) assert.equal(guardFormula(s), s);
    for (const s of ['-1+1', '-2+3+cmd|\' /C calc\'!A0', '-', '+91 98765 43210']) assert.ok(guardFormula(s).startsWith("'"));
  });

  test('text in a numeric column is guarded too; a negative number is written bare', () => {
    const csv = toCsv({
      columns: [{ header: 'Name' }, { header: 'Amount', kind: 'amount' }],
      rows: [['A', '=1+1'], ['B', -1250], ['C', '-12.50']],
    });
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[1], "A,'=1+1");
    assert.equal(lines[2], 'B,-12.50');
    assert.equal(lines[3], 'C,-12.50');
  });
});

describe('file names', () => {
  test('slug and period suffix', () => {
    assert.equal(fileSlug('Trial Balance (Detailed)'), 'Trial-Balance-Detailed');
    assert.equal(fileSlug('../../etc/passwd'), 'etc-passwd');
    assert.equal(fileSlug('***'), 'Report');
    assert.equal(exportFileName({ title: 'Day Book', period: { from: '2026-04-01', to: '2026-10-05' } }, 'csv'), 'Day-Book_01-04-2026_to_05-10-2026.csv');
    assert.equal(exportFileName({ title: 'Ledgers' }, 'xlsx'), 'Ledgers.xlsx');
  });
});

describe('buildPrintHtml', () => {
  const def: TableExportDef = {
    title: 'Trial <Balance>',
    subtitle: 'Detailed',
    period: { from: '2026-04-01', to: '2026-10-05' },
    columns: [
      { header: 'Particulars' },
      { header: 'Closing', kind: 'drcr' },
    ],
    rows: [
      ['<img src=x onerror=alert(1)>', 123450],
      ['Child', -100],
    ],
    levels: [0, 1],
    totals: ['Total', 123350],
    notes: 'Figures in ₹ & paise',
  };

  test('escapes every value and contains no script or external resource', () => {
    const html = buildPrintHtml(def, { company: 'Sharma "Traders"', printedOn: '2026-10-05' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(html.includes('Trial &lt;Balance&gt;'));
    assert.ok(html.includes('Sharma &quot;Traders&quot;'));
    assert.ok(!/<script|src=["']?http|<link/i.test(html));
    assert.ok(html.includes('1,234.50 Dr'));
    assert.ok(html.includes('1.00 Cr'));
    assert.ok(html.includes('class="total"'));
    assert.ok(html.includes('01-Apr-2026 to 05-Oct-2026'));
    assert.ok(html.includes('counter(page)'));
    assert.ok(html.includes('Printed on 05-Oct-2026'));
    assert.ok(html.includes('size: A4 portrait'));
    assert.ok(html.includes('padding-left:15pt'), 'tree level indents the first column');
    assert.ok(html.includes('Figures in ₹ &amp; paise'));
  });

  test('landscape and empty table', () => {
    const html = buildPrintHtml({ title: 'Empty', columns: [{ header: 'A' }, { header: 'B' }], rows: [], landscape: true });
    assert.ok(html.includes('size: A4 landscape'));
    assert.ok(html.includes('colspan="2"'));
  });

  test('quotes in the CSS footer are escaped', () => {
    const html = buildPrintHtml({ title: 'T', columns: [{ header: 'A' }], rows: [] }, { appName: 'Bahi "ERP"' });
    assert.ok(html.includes('content: "Bahi \\"ERP\\""'));
  });
});

describe('bytes', () => {
  test('bytesToBase64 matches the platform encoder', () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'बही ₹']) {
      const bytes = new TextEncoder().encode(s);
      assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
    }
    const all = new Uint8Array(256).map((_, i) => i);
    assert.equal(bytesToBase64(all), Buffer.from(all).toString('base64'));
  });

  test('sniffImageMime', () => {
    assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
    assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImageMime(new TextEncoder().encode('GIF89a...')), 'image/gif');
    assert.equal(sniffImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImageMime(new TextEncoder().encode('<svg xmlns=')), null);
    assert.equal(sniffImageMime(new Uint8Array()), null);
  });

  test('formatBytes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(3_500_000), '3.3 MB');
    assert.equal(formatBytes(-1), '');
  });
});
