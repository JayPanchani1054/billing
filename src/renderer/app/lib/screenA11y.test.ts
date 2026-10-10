/**
 * Accessibility and data-entry conventions every module screen follows (src/renderer/ui/README.md,
 * app/README.md §2/§8), checked on the real module sources (they import React, so they are read as text):
 *
 *   - every DataTable has an accessible name (`aria-label`), and every hand-made <table> in a
 *     parity-wave screen too (screen readers announce "table, Payment by tender", not just "table");
 *   - every DateInput resolves shorthand ("5", "5-10") against a reference date (the working date,
 *     or the date the field is about) — company settings that are not about a working day aside;
 *   - every report (ReportScreen) of a parity-wave module offers Export / Print (`exportDef`);
 *   - every report of a parity-wave module that shows a grid focuses it on open (`autoFocus` or
 *     `data-autofocus`), so ↑/↓ and Enter work without a click.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.tsx')) out.push({ file: path.relative(modulesDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** The opening tag `<Name …>` / `<Name<T> …>` starting at `i` (braces balanced, so `=>` inside props is skipped). */
function openingTag(text: string, i: number, name: string): string {
  let j = i + 1 + name.length;
  if (text[j] === '<') {
    for (let depth = 0; j < text.length; j++) {
      if (text[j] === '<') depth++;
      else if (text[j] === '>' && --depth === 0) {
        j++;
        break;
      }
    }
  }
  for (let depth = 0; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return text.slice(i, j + 1);
  }
  return text.slice(i);
}

function tags(files: ReadonlyArray<{ file: string; text: string }>, name: string): Array<{ where: string; tag: string }> {
  const out: Array<{ where: string; tag: string }> = [];
  for (const f of files) {
    for (const m of f.text.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
      out.push({ where: `${f.file}:${f.text.slice(0, m.index).split('\n').length}`, tag: openingTag(f.text, m.index, name) });
    }
  }
  return out;
}

/** Modules (and files) added by the feature-parity wave. */
const PARITY = /^(tds|documents|mfg|attachments|forex|pos|cheques)\/|^gst\/(AdvancesBoeScreens|CompositionScreens|FilingScreens|GapsScreens|LedgerScreens|SetoffScreen|GstDetailsDialog|VoucherGstPanel|plusComponents)\.tsx$|^data\/XmlExportScreen\.tsx$|^print\/(ShareDialog|VoucherSharePanel)\.tsx$/;

describe('screen accessibility and entry conventions (real modules)', () => {
  const files = sources(modulesDir);
  const parity = files.filter((f) => PARITY.test(f.file));

  test('the opening-tag reader skips generics and arrow functions', () => {
    const src = '<DataTable<Row> aria-label="X" onRowActivate={(r) => go(r)} />';
    assert.equal(openingTag(src, 0, 'DataTable'), src);
    assert.equal(openingTag('<DateInput value={d} onChange={(v) => set(v)}>rest', 0, 'DateInput'), '<DateInput value={d} onChange={(v) => set(v)}>');
  });

  test('the scan sees the parity-wave screens', () => {
    for (const m of ['tds/', 'documents/', 'mfg/', 'attachments/', 'forex/', 'pos/', 'cheques/']) assert.ok(parity.some((f) => f.file.startsWith(m)), `${m} not scanned`);
    assert.ok(tags(parity, 'DataTable').length > 60);
  });

  test('every DataTable has an accessible name', () => {
    const all = tags(files, 'DataTable');
    assert.ok(all.length > 150, `only ${all.length} tables scanned`);
    assert.deepEqual(all.filter((t) => !/\baria-label=/.test(t.tag)).map((t) => t.where), []);
  });

  test('every hand-made <table> of a parity-wave screen has an accessible name (printed documents aside)', () => {
    const screens = parity.filter((f) => !/PrintBlock\.tsx$/.test(f.file));
    const all = tags(screens, 'table');
    assert.ok(all.length >= 5, `only ${all.length} tables scanned`);
    assert.deepEqual(all.filter((t) => !/\baria-label=/.test(t.tag)).map((t) => t.where), []);
  });

  test('every DateInput resolves shorthand against a reference date', () => {
    // Company settings dates (books beginning, financial year) are not about the working day.
    const SETTINGS = /^company\/(CompanyProfileScreen|ConfigScreen)\.tsx:/;
    const all = tags(files, 'DateInput');
    assert.ok(all.length > 40, `only ${all.length} date inputs scanned`);
    assert.deepEqual(all.filter((t) => !/\breferenceDate=/.test(t.tag) && !SETTINGS.test(t.where)).map((t) => t.where), []);
  });

  test('every parity-wave report offers Export / Print (exportDef)', () => {
    const all = tags(parity, 'ReportScreen');
    assert.ok(all.length >= 30, `only ${all.length} reports scanned`);
    assert.deepEqual(all.filter((t) => !/\bexportDef=/.test(t.tag)).map((t) => t.where), []);
  });

  test('every parity-wave report with a grid focuses it on open', () => {
    const bad: string[] = [];
    let reports = 0;
    for (const f of parity) {
      for (const part of f.text.split(/\n(?=(?:export )?function [A-Z])/)) {
        if (!/<ReportScreen\b/.test(part) || !/<DataTable\b/.test(part)) continue;
        reports++;
        const grids = [...part.matchAll(/<DataTable\b/g)].map((m) => openingTag(part, m.index, 'DataTable'));
        if (!grids.some((g) => /\bautoFocus\b/.test(g)) && !/data-autofocus/.test(part)) bad.push(`${f.file}: ${/function ([A-Z]\w*)/.exec(part)?.[1]}`);
      }
    }
    assert.ok(reports >= 25, `only ${reports} reports scanned`);
    assert.deepEqual(bad, []);
  });
});
