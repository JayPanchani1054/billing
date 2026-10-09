/**
 * Printed documents and GST screens spell the GSTN terms 'e-Invoice' and 'e-Way Bill' (regression:
 * invoices printed 'E-invoice', 'E-way Bill No.' and 'E-way bill:' while the app said 'e-Invoice' /
 * 'e-Way bill'). Scans the source of the print templates, print screens and GST screens; comments
 * are ignored.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = ['..', '../templates', '../../gst'].map((d) => path.resolve(here, d));

function sourceLines(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return;
        out.push({ where: `${path.basename(dir)}/${f}:${i + 1}`, text: line.replace(/\/\/.*$/, '') });
      });
    }
  }
  return out;
}

test("no 'E-invoice' / 'E-way' spelling in printed documents or GST screens", () => {
  const bad = sourceLines().filter((l) => /\bE-(invoice|Invoice|way|Way)\b/.test(l.text));
  assert.deepEqual(bad.map((l) => l.where), []);
});

test("labels and titles say 'e-Way Bill', not 'e-way bill'", () => {
  const bad = sourceLines().filter((l) => /(label|title|legend|aria-label)\s*[=:]\s*\{?\s*['"`][^'"`]*\be-[Ww]ay bill/.test(l.text));
  assert.deepEqual(bad.map((l) => l.where), []);
});

test('voucher-type print overrides point to Invoice Printing (the one editor) and use its wording', () => {
  const src = fs.readFileSync(path.resolve(here, '../../accounts/VoucherTypeScreens.tsx'), 'utf8');
  assert.doesNotMatch(src, /bank chosen in F12/);
  assert.match(src, /Overrides the bank chosen in Invoice Printing/);
  assert.match(src, /label="Template" error=\{cfgErr\.printTemplate\}/);
  assert.match(src, /\{ value: '', label: 'As set in Invoice Printing' \}/);
  assert.match(src, /\{ value: 'compact', label: 'Compact 80 mm' \}/);
  assert.match(src, /label="Terms & conditions"/);
});
