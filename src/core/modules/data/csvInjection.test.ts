/**
 * Final wave (verifier): CSV / formula injection in the masters and vouchers exports (exportData.ts
 * csvValue → shared/csvSafe.ts). A master name or narration starting with = + - @ is written with a
 * leading apostrophe; amounts stay plain numbers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv } from '../../lib/csv.ts';
import { readZip } from '../../lib/zip.ts';
import { save, setupKit } from '../vouchers/testkit.ts';
import { exportMasters, exportVouchers } from './exportData.ts';

describe('data exports neutralise spreadsheet formulas', () => {
  it('masters CSV: a ledger named like a formula is prefixed with an apostrophe', () => {
    const k = setupKit();
    k.t.addLedger({ name: '@SUM(A1:A9)', group: 'SUNDRY_DEBTORS' });
    k.t.addLedger({ name: '-2+3 Traders', group: 'SUNDRY_DEBTORS' });
    const out = exportMasters(k.t.ctx, { kinds: ['ledgers'], format: 'csv' });
    const text = new TextDecoder().decode(out.bytes);
    const names = parseCsv(text).map((r) => r[0]);
    assert.ok(names.includes("'@SUM(A1:A9)"), names.join(' | '));
    assert.ok(names.includes("'-2+3 Traders"));
    assert.ok(!names.includes('@SUM(A1:A9)'));
    k.t.close();
  });

  it('vouchers CSV: a narration starting with = is neutralised; amounts stay plain numbers', async () => {
    const k = setupKit();
    save(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-04-12',
      mode: 'ledger',
      narration: '=HYPERLINK("http://x.example","click")',
      ledgers: [
        { ledgerId: k.L.rent, amount: 500_00 },
        { ledgerId: k.L.capital, amount: -500_00 },
      ],
    });
    const out = await exportVouchers(k.t.ctx, { from: '2026-04-01', to: '2026-04-30', format: 'csv', baseTypes: ['journal'] });
    const zip = readZip(out.bytes);
    const vouchers = zip.readText('Vouchers.csv');
    assert.ok(vouchers.includes(`"'=HYPERLINK(""http://x.example"",""click"")"`), vouchers);
    assert.ok(!/(^|,)"?=HYPERLINK/m.test(vouchers));
    const entries = parseCsv(zip.readText('Ledger-Entries.csv').replace(/^﻿/, ''));
    const cells = entries.flat();
    assert.equal(cells.filter((c) => c === '500.00').length, 2, 'debit and credit are plain numbers');
    assert.ok(!cells.some((c) => c.startsWith("'5")));
    k.t.close();
  });
});
