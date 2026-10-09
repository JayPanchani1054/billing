/**
 * Report output goes through the core for every format (data.export permission + 'export' edit-log
 * entry): Excel and CSV bytes come from 'data.export.table'; Print and PDF are authorised and logged
 * by 'data.export.audit' BEFORE anything is printed or saved. Runs against a stubbed preload bridge.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportTable, printReport, savePdf } from './export.ts';
import type { TableExportDef } from './export.ts';

interface Call {
  kind: 'api' | 'native';
  name: string;
  input: Record<string, unknown>;
}

const def: TableExportDef = {
  title: 'Trial Balance',
  period: { from: '2026-04-01', to: '2026-09-30' },
  columns: [{ header: 'Particulars' }, { header: 'Closing', kind: 'drcr' }],
  rows: [
    ['Cash', 150000],
    ['Capital', -150000],
  ],
};

let calls: Call[] = [];
let forbidden = false;
const g = globalThis as { window?: unknown };
let hadWindow = false;
let previousWindow: unknown;

beforeEach(() => {
  calls = [];
  forbidden = false;
  hadWindow = 'window' in g;
  previousWindow = g.window;
  g.window = {
    bahi: {
      api: async (name: string, input: Record<string, unknown>) => {
        calls.push({ kind: 'api', name, input });
        if (forbidden) return { ok: false, error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } };
        if (name === 'data.export.table') return { ok: true, data: { fileName: `Trial Balance.${String(input.format)}`, bytes: new Uint8Array([1, 2, 3]) } };
        return { ok: true, data: { ok: true } };
      },
      native: async (name: string, input: Record<string, unknown>) => {
        calls.push({ kind: 'native', name, input });
        if (name === 'print.print') return { ok: true, data: { printed: true } };
        return { ok: true, data: { path: `C:\\Exports\\${String(input.defaultName)}` } };
      },
      on: () => () => undefined,
    },
  };
});

afterEach(() => {
  if (hadWindow) g.window = previousWindow;
  else delete g.window;
});

describe('report export / print go through the core', () => {
  test('CSV is built by data.export.table (not in the renderer), then saved', async () => {
    const r = await exportTable(def, 'csv');
    assert.deepEqual(
      calls.map((c) => `${c.kind}:${c.name}`),
      ['api:data.export.table', 'native:dialog.saveFile'],
    );
    assert.equal(calls[0].input.format, 'csv');
    assert.deepEqual(calls[1].input.data, new Uint8Array([1, 2, 3]));
    assert.equal(r?.format, 'csv');
  });

  test('PDF and Print are authorised and logged by data.export.audit first', async () => {
    await savePdf(def);
    await printReport(def);
    assert.deepEqual(
      calls.map((c) => `${c.kind}:${c.name}`),
      ['api:data.export.audit', 'native:print.savePdf', 'api:data.export.audit', 'native:print.print'],
    );
    assert.deepEqual(calls[0].input, { title: 'Trial Balance', subtitle: undefined, period: def.period, rows: 2, format: 'pdf' });
    assert.equal(calls[2].input.format, 'print');
  });

  test('without data.export nothing leaves the app in any format', async () => {
    forbidden = true;
    for (const run of [() => exportTable(def, 'csv'), () => exportTable(def, 'xlsx'), () => savePdf(def), () => printReport(def)]) {
      await assert.rejects(run(), (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN');
    }
    assert.equal(calls.filter((c) => c.kind === 'native').length, 0, 'no save dialog, no PDF, no printer');
  });
});

/**
 * Screens that print or export through these helpers must not offer Print / Export to a user the
 * core will refuse (FORBIDDEN after the click): their Alt+P / Alt+E actions are disabled without
 * data.export. Business documents (reminder letters, invoices) are not report output and stay open.
 */
describe('screens offer report Print / Export only with data.export', () => {
  const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../modules');
  const files = (function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));
  })(modulesDir);

  /** `{ key: 'Alt+P', … }` action objects (balanced braces, may span lines). */
  function outputActions(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/\{\s*key:\s*'Alt\+[PE]'/g)) {
      let depth = 0;
      let end = m.index;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      out.push(text.slice(m.index, end + 1));
    }
    return out;
  }

  test('every Alt+P / Alt+E of a screen using printReport / savePdf / exportTable is gated', () => {
    const users = files.filter((f) => /import\s*\{[^}]*\b(printReport|savePdf|exportTable)\b[^}]*\}\s*from\s*'\.\.\/\.\.\/app\//.test(fs.readFileSync(f, 'utf8')));
    assert.ok(users.length >= 4, `only ${users.length} screens found`);
    const ungated: string[] = [];
    for (const f of users) {
      for (const a of outputActions(fs.readFileSync(f, 'utf8'))) {
        if (/label:\s*'[^']*letter/i.test(a)) continue; // reminder letters: business documents
        if (!/canExport|EXPORT_PERMISSION|'data\.export'/.test(a)) ungated.push(`${path.relative(modulesDir, f)}: ${a.slice(0, 80)}`);
      }
    }
    assert.deepEqual(ungated, []);
  });
});
