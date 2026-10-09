import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ExportFileResult, ImportCommitResult } from '../../../shared/types/data.ts';
import { AppError } from '../../lib/errors.ts';
import { decodeText } from '../../lib/text.ts';
import { readXlsx } from '../../lib/xlsx.ts';
import { readZip } from '../../lib/zip.ts';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { paiseText } from './exportTable.ts';
import { exportMasters, exportVouchers } from './exportData.ts';
import { commitImport } from './importer.ts';
import { dataRoutes } from './routes.ts';

type Rows = Array<Array<string | number | boolean | null>>;

/** Rows from the header row (first row whose first cell equals `first`) onwards. */
function fromHeader(rows: Rows, first: string): Rows {
  const i = rows.findIndex((r) => r[0] === first);
  assert.ok(i >= 0, `header "${first}" not found`);
  return rows.slice(i);
}

let t: TestCompany;
beforeEach(() => {
  t = createTestCompany({ today: '2026-10-05' });
});
afterEach(() => t.close());

const table = {
  title: 'Trial Balance',
  period: { from: '2026-04-01', to: '2026-09-30' },
  columns: [
    { header: 'Particulars', kind: 'text' as const },
    { header: 'Debit', kind: 'amount' as const },
    { header: 'Closing', kind: 'drcr' as const },
    { header: 'Rate', kind: 'percent' as const },
    { header: 'Qty', kind: 'qty' as const, decimals: 3 },
    { header: 'Date', kind: 'date' as const },
  ],
  rows: [
    ['Cash', 1_23_456_78, 1_00_000_00, 18, 12.5, '2026-04-05'],
    ['=HYPERLINK("http://evil")', 5, -2_500_50, null, null, null],
    ['Sharma, "Bros"', null, 0, 5, 1, '2026-05-01'],
  ],
  totals: ['Total', 1_23_456_83, null, null, null, null],
};

describe('data.export.table', () => {
  it('xlsx: amounts arrive in paise and are written as rupees; Dr/Cr gets its own column', async () => {
    const out = await t.callOk<ExportFileResult>(dataRoutes, 'data.export.table', { ...table, format: 'xlsx' });
    assert.equal(out.fileName, 'Trial-Balance_01-04-2026_to_30-09-2026.xlsx');
    assert.equal(out.rowCount, 3);
    const book = readXlsx(out.bytes);
    const rows = fromHeader(book.sheets[0].rows, 'Particulars');
    assert.deepEqual(rows[0], ['Particulars', 'Debit', 'Closing', 'Dr/Cr', 'Rate', 'Qty', 'Date']);
    // 1,23,456.78 rupees = 12345678 paise / 100; percent 18 → 0.18 (Excel percentage)
    assert.deepEqual(rows[1], ['Cash', 123456.78, 100000, 'Dr', 0.18, 12.5, '2026-04-05']);
    assert.equal(rows[2][1], 0.05);
    assert.deepEqual(rows[2].slice(2, 4), [2500.5, 'Cr']);
    // Text is a shared string in Excel, never a formula.
    assert.equal(rows[2][0], '=HYPERLINK("http://evil")');
    assert.deepEqual(rows[4].slice(0, 2), ['Total', 123456.83]);
  });

  it('xlsx: the title block names the company and the period', async () => {
    const out = await t.callOk<ExportFileResult>(dataRoutes, 'data.export.table', { ...table, format: 'xlsx' });
    const top = readXlsx(out.bytes).sheets[0].rows.slice(0, 3).map((r) => r[0]);
    assert.deepEqual(top, ['Test Traders Pvt Ltd', 'Trial Balance', '01-Apr-2026 to 30-Sep-2026']);
  });

  it('csv: paise → rupees text, signed Dr/Cr column, formula injection neutralised, UTF-8 BOM', async () => {
    const out = await t.callOk<ExportFileResult>(dataRoutes, 'data.export.table', { ...table, format: 'csv' });
    assert.equal(out.fileName, 'Trial-Balance_01-04-2026_to_30-09-2026.csv');
    assert.deepEqual([...out.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = decodeText(out.bytes).text.split('\r\n');
    assert.equal(lines[0], 'Particulars,Debit,Closing (Dr +/Cr -),Rate,Qty,Date');
    assert.equal(lines[1], 'Cash,123456.78,100000.00,18.00,12.500,2026-04-05');
    assert.equal(lines[2], `"'=HYPERLINK(""http://evil"")",0.05,-2500.50,,,`);
    assert.equal(lines[3], '"Sharma, ""Bros""",,0.00,5.00,1.000,2026-05-01');
    assert.equal(lines[4], 'Total,123456.83,,,,');
  });

  it('csv: every formula prefix (= + - @ tab) is neutralised, also in headers', async () => {
    const out = await t.callOk<ExportFileResult>(dataRoutes, 'data.export.table', {
      title: 'X',
      columns: [{ header: '=cmd|A1' }],
      rows: [['+91 98200'], ['-2+3'], ['@SUM(A1)'], ['\tA'], ['plain']],
      format: 'csv',
    });
    const lines = decodeText(out.bytes).text.split('\r\n');
    for (const l of lines.slice(0, 5)) assert.ok(l.startsWith(`'`) || l.startsWith(`"'`), l);
    assert.equal(lines[5], 'plain');
  });

  it('paiseText is exact for large and negative amounts', async () => {
    assert.equal(paiseText(0), '0.00');
    assert.equal(paiseText(-5), '-0.05');
    assert.equal(paiseText(9_007_199_254_740_991), '90071992547409.91');
  });

  it('accepts sparse rows (undefined cells) as sent by the renderer', async () => {
    const out = await t.callOk<ExportFileResult>(dataRoutes, 'data.export.table', {
      title: 'Sparse',
      columns: [{ header: 'A' }, { header: 'B', kind: 'amount' }],
      rows: [['x', undefined], [undefined, 100]],
      format: 'csv',
    });
    assert.deepEqual(decodeText(out.bytes).text.split('\r\n').slice(1, 3), ['x,', ',1.00']);
  });

  it('writes an "export" audit entry and needs data.export', async () => {
    await t.callOk(dataRoutes, 'data.export.table', { ...table, format: 'csv' });
    assert.equal(t.db.value(`SELECT entity_label FROM audit_log WHERE action = 'export'`), 'Trial Balance');
    const r = await t.call(dataRoutes, 'data.export.table', { ...table, format: 'csv' }, { session: t.sessionAs({ permissions: ['reports.view'] }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN');
  });

  it('csv for a user without data.export (built-in Data Entry role) is refused and not logged', async () => {
    const dataEntry = t.sessionAs({ permissions: ['masters.view', 'vouchers.view', 'vouchers.create', 'reports.view'] });
    const before = t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE action = 'export'`);
    for (const format of ['csv', 'xlsx'] as const) {
      const r = await t.call(dataRoutes, 'data.export.table', { ...table, format }, { session: dataEntry });
      assert.equal(r.ok, false, format);
      if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN');
    }
    assert.equal(t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE action = 'export'`), before);
  });

  it('rejects malformed rows with a validation error', async () => {
    const r = await t.call(dataRoutes, 'data.export.table', { title: 'X', columns: [{ header: 'A' }], rows: [[{ evil: true }]], format: 'csv' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'VALIDATION');
  });
});

describe('data.export.masters → data.import round trip', () => {
  it('exported ledgers, groups and stock items import into a fresh company unchanged', async () => {
    t.db.transaction(() => {
      t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', 'AAFCA4321B'), openingBalance: 25_000_00, creditDays: 30, email: 'a@acme.example' });
      t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS', openingBalance: 1_50_000_00, bank: { accountNo: '50100012345678', ifsc: 'HDFC0000001', bankName: 'HDFC Bank' } });
      t.addLedger({ name: 'Capital', group: 'CAPITAL_ACCOUNT', openingBalance: -1_75_000_00 });
      t.addStockItem({ name: 'Mixer Grinder', unit: 'Nos', gstRate: 18, hsnSac: '8509', openingQty: 10, openingRate: 2400 });
    });
    const book = exportMasters(t.ctx, { kinds: ['groups', 'ledgers', 'stock_items'], format: 'xlsx' });
    assert.equal(book.fileName, 'Masters.xlsx');
    const sheets = readXlsx(book.bytes).sheets.map((s) => s.name);
    assert.deepEqual(sheets, ['Groups', 'Ledgers', 'Stock Items']);

    const target = createTestCompany({ today: '2026-10-05', name: 'Copy Co' });
    try {
      const imp = (kind: 'groups' | 'ledgers' | 'stock_items', sheet: string): Promise<ImportCommitResult> =>
        commitImport(target.ctx, { kind, fileName: 'Masters.xlsx', bytes: book.bytes, options: { skipInvalid: false, updateExisting: false, sheet } });
      const g = await imp('groups', 'Groups');
      assert.equal(g.failed, 0);
      const l = await imp('ledgers', 'Ledgers');
      assert.equal(l.failed, 0, JSON.stringify(l.rows));
      assert.equal(l.created, 3);
      const i = await imp('stock_items', 'Stock Items');
      assert.equal(i.failed, 0, JSON.stringify(i.rows));
      const acme = target.db.get<{ opening_balance: number; gstin: string; default_credit_days: number; email: string; state_code: string }>(
        `SELECT opening_balance, gstin, default_credit_days, email, state_code FROM ledgers WHERE name = 'Acme Traders'`,
      );
      assert.deepEqual(acme, { opening_balance: 25_000_00, gstin: makeGstin('27', 'AAFCA4321B'), default_credit_days: 30, email: 'a@acme.example', state_code: '27' });
      assert.equal(target.db.value(`SELECT bank_ifsc FROM ledgers WHERE name = 'HDFC Bank'`), 'HDFC0000001');
      assert.equal(target.db.value(`SELECT opening_balance FROM ledgers WHERE name = 'Capital'`), -1_75_000_00);
      const item = target.db.get<{ gst_rate: number; hsn_sac: string; qty: number; value: number }>(
        `SELECT i.gst_rate, i.hsn_sac, o.qty, o.value FROM stock_items i JOIN stock_openings o ON o.item_id = i.id WHERE i.name = 'Mixer Grinder'`,
      );
      // 10 × ₹2,400 = ₹24,000 = 24,00,000 paise
      assert.deepEqual(item, { gst_rate: 18, hsn_sac: '8509', qty: 10, value: 24_000_00 });
    } finally {
      target.close();
    }
  });

  it('csv with several kinds is a zip with one CSV per kind', async () => {
    const out = exportMasters(t.ctx, { kinds: ['units', 'godowns'], format: 'csv' });
    assert.equal(out.fileName, 'Masters.zip');
    const zip = readZip(out.bytes);
    assert.deepEqual(zip.list().sort(), ['Godowns.csv', 'Units.csv']);
    assert.match(zip.readText('Units.csv'), /Symbol,Formal Name,UQC/);
  });

  it('requires at least one kind and the data.export permission', async () => {
    assert.throws(() => exportMasters(t.ctx, { kinds: [], format: 'xlsx' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
    assert.throws(() => exportMasters(t.ctxAs({ permissions: ['masters.view'] }), { kinds: ['ledgers'], format: 'xlsx' }), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
  });
});

describe('data.export.vouchers', () => {
  let k: Kit;
  beforeEach(() => {
    k = setupKit();
  });
  afterEach(() => k.t.close());

  it('exports headers, ledger entries and stock lines of the period', async () => {
    // 2 × ₹150 = ₹300 taxable; CGST 9% 27 + SGST 27 → ₹354 to Acme.
    const s = save(k, { voucherTypeId: k.vt.sales, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 2, rate: 150 }] });
    save(k, { voucherTypeId: k.vt.journal, date: '2026-04-12', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 500_00 }, { ledgerId: k.L.capital, amount: -500_00 }] });
    const out = exportVouchers(k.t.ctx, { from: '2026-04-01', to: '2026-04-30', format: 'xlsx' });
    assert.equal(out.fileName, 'Vouchers_01-04-2026_to_30-04-2026.xlsx');
    const [head, entries, stock] = readXlsx(out.bytes).sheets;
    assert.deepEqual([head.name, entries.name, stock.name], ['Vouchers', 'Ledger Entries', 'Inventory Entries']);
    assert.equal(head.rows.length, 3); // header + 2 vouchers
    const sale = head.rows.find((r) => r[4] === s.number);
    assert.equal(sale?.[14], 354); // Total in rupees
    const acmeLine = entries.rows.find((r) => r[4] === 'Acme Traders');
    assert.equal(acmeLine?.[5], 354); // Debit ₹354
    assert.equal(stock.rows[1][5], 'Mixer Grinder');
    assert.equal(stock.rows[1][7], 'Out');
  });

  it('csv is a zip of three files; cancelled vouchers are left out by default', async () => {
    save(k, { voucherTypeId: k.vt.journal, date: '2026-04-12', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 500_00 }, { ledgerId: k.L.capital, amount: -500_00 }] });
    const out = exportVouchers(k.t.ctx, { from: '2026-04-01', to: '2026-04-30', format: 'csv', baseTypes: ['journal'] });
    const zip = readZip(out.bytes);
    assert.deepEqual(zip.list().sort(), ['Inventory-Entries.csv', 'Ledger-Entries.csv', 'Vouchers.csv']);
    assert.equal(out.rowCount, 1 + 2);
  });
});

describe('data.export.audit (report printed or saved as PDF)', () => {
  it('records an "export" edit-log entry with the format, row count and period', async () => {
    const out = await t.callOk<{ ok: true }>(dataRoutes, 'data.export.audit', { title: 'Balance Sheet', period: { from: '2026-04-01', to: '2026-09-30' }, rows: 42, format: 'pdf' });
    assert.deepEqual(out, { ok: true });
    const row = t.db.get<{ entity_type: string; entity_label: string; after_json: string | null }>(`SELECT entity_type, entity_label, after_json FROM audit_log WHERE action = 'export' ORDER BY id DESC LIMIT 1`);
    assert.equal(row?.entity_type, 'report');
    assert.equal(row?.entity_label, 'Balance Sheet');
    const after = JSON.parse(row?.after_json ?? '{}') as { format?: string; rows?: number; period?: string };
    assert.deepEqual([after.format, after.rows], ['pdf', 42]);
    assert.match(after.period ?? '', /2026/);
  });

  it('needs data.export for print and PDF alike (FORBIDDEN, nothing logged)', async () => {
    const dataEntry = t.sessionAs({ permissions: ['masters.view', 'vouchers.view', 'vouchers.create', 'reports.view'] });
    for (const format of ['pdf', 'print'] as const) {
      const r = await t.call(dataRoutes, 'data.export.audit', { title: 'Ledger', rows: 3, format }, { session: dataEntry });
      assert.equal(r.ok, false, format);
      if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN');
    }
    assert.equal(t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE action = 'export'`), 0);
    // With the permission it goes through.
    const allowed = await t.call(dataRoutes, 'data.export.audit', { title: 'Ledger', rows: 3, format: 'print' }, { session: t.sessionAs({ permissions: ['reports.view', 'data.export'] }) });
    assert.equal(allowed.ok, true);
  });

  it('rejects an unknown format', async () => {
    const r = await t.call(dataRoutes, 'data.export.audit', { title: 'Ledger', rows: 3, format: 'xlsx' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'VALIDATION');
  });
});
