/**
 * Report output goes through the core for every format (data.export permission + 'export' edit-log
 * entry): Excel and CSV bytes come from 'data.export.table'; Print and PDF are authorised and logged
 * by 'data.export.audit' BEFORE anything is printed or saved. Runs against a stubbed preload bridge.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
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
