/**
 * Excel / CSV import: templates, preview (validates every row, writes nothing), commit (all-or-nothing
 * or skip invalid), masters through the accounts / inventory services and invoices through the
 * vouchers service.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IMPORT_KINDS } from '../../../shared/types/data.ts';
import { AppError } from '../../lib/errors.ts';
import { readXlsx, writeXlsx } from '../../lib/xlsx.ts';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import { setupKit, type Kit } from '../vouchers/testkit.ts';
import { commitImport, importTemplate, previewImport } from './importer.ts';
import { KIND_SPECS } from './importSpecs.ts';
import { dataRoutes } from './routes.ts';

const csv = (text: string): Uint8Array => new TextEncoder().encode(text);

let t: TestCompany;
beforeEach(() => {
  t = createTestCompany({ today: '2026-10-05' });
});
afterEach(() => t.close());

const LEDGERS_CSV = [
  'Name,Under,Opening Balance,Dr/Cr,GSTIN,Credit Days,Email',
  `Acme Traders,Sundry Debtors,25000,Dr,${makeGstin('27', 'AAFCA4321B')},30,a@acme.example`,
  'Office Rent,Indirect Expenses,,,,,',
  'Bad Group Ltd,No Such Group,100,Dr,,,',
  'Broken GSTIN,Sundry Creditors,500,Cr,27ABCDE1234F1Z0,,',
  'Capital - Ramesh,Capital Account,25000,Cr,,,',
].join('\r\n');

describe('data.import.template', () => {
  it('every kind has an xlsx template: header row, two examples and an Instructions sheet', () => {
    for (const kind of IMPORT_KINDS) {
      const out = importTemplate(kind);
      assert.match(out.fileName, /\.xlsx$/);
      const book = readXlsx(out.bytes);
      const names = book.sheets.map((s) => s.name);
      assert.ok(names.includes('Instructions'), `${kind}: ${names.join(',')}`);
      const data = book.sheets.find((s) => s.name !== 'Instructions');
      assert.ok(data, kind);
      const headerAt = data.rows.findIndex((r) => r.some((c) => typeof c === 'string' && c.length > 0));
      assert.ok(data.rows.length - headerAt - 1 >= 2, `${kind} has two example rows`);
    }
  });

  it('example rows left in a template are refused (never imported by accident)', () => {
    const out = importTemplate('ledgers');
    const p = previewImport(t.ctx, { kind: 'ledgers', fileName: out.fileName, bytes: out.bytes });
    assert.equal(p.summary.total, 2);
    assert.equal(p.summary.error, 2);
    for (const r of p.rows) assert.match(r.messages.join(' '), /example row \d from the template/);
    assert.throws(
      () => commitImport(t.ctx, { kind: 'ledgers', fileName: out.fileName, bytes: out.bytes, options: { skipInvalid: false, updateExisting: false } }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
    );
  });

  it('the template examples are otherwise valid data (each kind\'s examples, renamed, preview without errors)', () => {
    // Change the record key of every example so the rows are no longer the template's own; for the masters
    // kinds whose examples refer only to predefined masters, they must then pass the real validation.
    for (const kind of ['groups', 'ledgers', 'godowns', 'cost_centres'] as const) {
      const spec = KIND_SPECS[kind];
      const cell = (v: string | number | null): string => (v === null ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const lines = [spec.columns.map((c) => c.header).join(',')];
      for (const i of [0, 1] as const) {
        // Renamed consistently: a later example may sit under the first one (parent = its name).
        const names = new Set(spec.columns.filter((c) => c.key === 'name').flatMap((c) => c.examples.filter((x): x is string => typeof x === 'string')));
        lines.push(spec.columns.map((c) => cell(typeof c.examples[i] === 'string' && names.has(c.examples[i] as string) ? `${c.examples[i] as string} Two` : c.examples[i])).join(','));
      }
      const p = previewImport(t.ctx, { kind, fileName: `${kind}.csv`, bytes: csv(lines.join('\r\n')) });
      assert.equal(p.summary.error, 0, `${kind}: ${JSON.stringify(p.rows.filter((r) => r.status === 'error'))}`);
    }
  });

  it('needs the data.import permission', async () => {
    const r = await t.call(dataRoutes, 'data.import.template', { kind: 'ledgers' }, { session: t.sessionAs({ permissions: ['masters.view'] }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN');
  });
});

describe('data.import.preview', () => {
  it('reports every row with its status and plain-English messages, and writes nothing', () => {
    const before = t.db.value<number>('SELECT COUNT(*) FROM ledgers');
    const p = previewImport(t.ctx, { kind: 'ledgers', fileName: 'ledgers.csv', bytes: csv(LEDGERS_CSV) });
    assert.equal(p.headerRow, 1);
    assert.deepEqual(
      p.rows.map((r) => [r.rowNumber, r.key, r.status]),
      [
        [2, 'Acme Traders', 'ok'],
        [3, 'Office Rent', 'ok'],
        [4, 'Bad Group Ltd', 'error'],
        [5, 'Broken GSTIN', 'error'],
        [6, 'Capital - Ramesh', 'ok'],
      ],
    );
    assert.match(p.rows[2].messages.join(' '), /No Such Group/);
    assert.match(p.rows[3].messages.join(' '), /GSTIN|PAN/i);
    assert.deepEqual(
      { total: p.summary.total, ok: p.summary.ok, error: p.summary.error, willCreate: p.summary.willCreate },
      { total: 5, ok: 3, error: 2, willCreate: 3 },
    );
    assert.equal(t.db.value('SELECT COUNT(*) FROM ledgers'), before);
    assert.equal(t.db.value('SELECT COUNT(*) FROM import_batches'), 0);
  });

  it('maps headers by alias, case and spacing; lists unknown headers', () => {
    const p = previewImport(t.ctx, {
      kind: 'ledgers',
      fileName: 'x.csv',
      bytes: csv('Ledger Name ,  GROUP,Opening Bal,Favourite Colour\r\nKumar Stores,Sundry Debtors,100,Blue'),
    });
    assert.deepEqual(
      p.mappedColumns.map((m) => m.key),
      ['name', 'parent', 'openingBalance'],
    );
    assert.deepEqual(p.unmappedHeaders, ['Favourite Colour']);
    assert.equal(p.rows[0].status, 'ok');
  });

  it('later rows see earlier ones (a group created in row 2 is the parent in row 3)', () => {
    const p = previewImport(t.ctx, { kind: 'groups', fileName: 'g.csv', bytes: csv('Name,Under\r\nBranch Debtors,Sundry Debtors\r\nPune Debtors,Branch Debtors') });
    assert.equal(p.summary.error, 0, JSON.stringify(p.rows));
    assert.equal(t.db.value(`SELECT COUNT(*) FROM groups WHERE name = 'Branch Debtors'`), 0);
  });

  it('an existing master is a duplicate (skipped) unless "update existing" is on', () => {
    t.db.transaction(() => t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS' }));
    const bytes = csv('Name,Under,Email\r\nAcme Traders,Sundry Debtors,new@acme.example');
    const skip = previewImport(t.ctx, { kind: 'ledgers', fileName: 'l.csv', bytes });
    assert.equal(skip.rows[0].status, 'duplicate');
    assert.equal(skip.rows[0].action, 'skip');
    const upd = previewImport(t.ctx, { kind: 'ledgers', fileName: 'l.csv', bytes, options: { updateExisting: true } });
    assert.equal(upd.rows[0].action, 'update');
    commitImport(t.ctx, { kind: 'ledgers', fileName: 'l.csv', bytes, options: { skipInvalid: false, updateExisting: true } });
    assert.equal(t.db.value(`SELECT email FROM ledgers WHERE name = 'Acme Traders'`), 'new@acme.example');
  });

  it('a file without the required columns is refused with the missing column named', () => {
    assert.throws(
      () => previewImport(t.ctx, { kind: 'ledgers', fileName: 'x.csv', bytes: csv('Colour,Size\r\nBlue,3') }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /Name|Under/.test(e.message),
    );
  });

  it('reads xlsx with real date and number cells', () => {
    t.db.transaction(() => t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', openingBalance: 25_000_00, billWise: true }));
    const bytes = writeXlsx({
      sheets: [
        {
          name: 'Opening Balances',
          columns: [{ header: 'Ledger' }, { header: 'Opening Balance', kind: 'amount' }, { header: 'Dr/Cr' }, { header: 'Bill Ref' }, { header: 'Bill Date', kind: 'date' }, { header: 'Bill Amount', kind: 'amount' }],
          rows: [
            ['Acme Traders', 25000, 'Dr', 'INV-0912', '2026-02-10', 10000],
            ['Acme Traders', null, null, 'INV-0952', '2026-03-05', 15000],
          ],
        },
      ],
    });
    const r = commitImport(t.ctx, { kind: 'opening_balances', fileName: 'ob.xlsx', bytes, options: { skipInvalid: false, updateExisting: true } });
    assert.equal(r.failed, 0, JSON.stringify(r.rows));
    assert.deepEqual(
      t.db.all(`SELECT bill_name, bill_date, amount FROM opening_bills ORDER BY bill_name`),
      [
        { bill_name: 'INV-0912', bill_date: '2026-02-10', amount: 10_000_00 },
        { bill_name: 'INV-0952', bill_date: '2026-03-05', amount: 15_000_00 },
      ],
    );
  });
});

describe('data.import.commit', () => {
  it('is all-or-nothing by default: one bad row and nothing is imported', () => {
    const before = t.db.value<number>('SELECT COUNT(*) FROM ledgers');
    assert.throws(
      () => commitImport(t.ctx, { kind: 'ledgers', fileName: 'ledgers.csv', bytes: csv(LEDGERS_CSV), options: { skipInvalid: false, updateExisting: false } }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /2 of 5 records have errors, so nothing was imported/.test(e.message),
    );
    assert.equal(t.db.value('SELECT COUNT(*) FROM ledgers'), before);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM audit_log WHERE action = 'import'`), 0);
  });

  it('with "skip invalid rows" imports the good rows and reports the bad ones', () => {
    const r = commitImport(t.ctx, { kind: 'ledgers', fileName: 'ledgers.csv', bytes: csv(LEDGERS_CSV), options: { skipInvalid: true, updateExisting: false } });
    assert.deepEqual({ total: r.total, created: r.created, failed: r.failed }, { total: 5, created: 3, failed: 2 });
    assert.deepEqual(
      r.rows.map((x) => x.rowNumber),
      [4, 5],
    );
    // ₹25,000 Dr → +25,00,000 paise; ₹25,000 Cr → −25,00,000.
    assert.equal(t.db.value(`SELECT opening_balance FROM ledgers WHERE name = 'Acme Traders'`), 25_000_00);
    assert.equal(t.db.value(`SELECT opening_balance FROM ledgers WHERE name = 'Capital - Ramesh'`), -25_000_00);
    assert.equal(t.db.value(`SELECT default_credit_days FROM ledgers WHERE name = 'Acme Traders'`), 30);
    const audit = t.db.get<{ entity_label: string; after_json: string }>(`SELECT entity_label, after_json FROM audit_log WHERE action = 'import'`);
    assert.match(audit?.entity_label ?? '', /ledgers\.csv/);
    assert.equal(JSON.parse(audit?.after_json ?? '{}').created, 3);
  });

  it('stock items and opening stock (paise from rupees, value = qty × rate)', () => {
    const items = csv('Name,Unit,GST Rate,HSN/SAC,Opening Qty,Opening Rate\r\nMixer Grinder,Nos,18,8509,10,2400.50\r\nRice Bag,Nos,5,1006,,');
    const r = commitImport(t.ctx, { kind: 'stock_items', fileName: 'i.csv', bytes: items, options: { skipInvalid: false, updateExisting: false } });
    assert.equal(r.created, 2, JSON.stringify(r.rows));
    // 10 × ₹2,400.50 = ₹24,005 = 24,00,500 paise
    assert.equal(t.db.value(`SELECT o.value FROM stock_openings o JOIN stock_items i ON i.id = o.item_id WHERE i.name = 'Mixer Grinder'`), 24_005_00);
    const op = csv('Item,Godown,Quantity,Rate\r\nRice Bag,Main Location,40,1100');
    const r2 = commitImport(t.ctx, { kind: 'stock_openings', fileName: 'o.csv', bytes: op, options: { skipInvalid: false, updateExisting: true } });
    assert.equal(r2.failed, 0, JSON.stringify(r2.rows));
    assert.deepEqual(t.db.get(`SELECT o.qty, o.value FROM stock_openings o JOIN stock_items i ON i.id = o.item_id WHERE i.name = 'Rice Bag'`), { qty: 40, value: 44_000_00 });
  });

  it('data.import alone does not let a user create or alter masters or vouchers', async () => {
    const bytes = csv('Name,Under\r\nBranch Debtors,Sundry Debtors');
    const importer = t.sessionAs({ permissions: ['data.import', 'masters.view'] });
    const denied = await t.call(dataRoutes, 'data.import.commit', { kind: 'groups', fileName: 'g.csv', bytes, options: { skipInvalid: false, updateExisting: false } }, { session: importer });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.error.code, 'FORBIDDEN');
      assert.match(denied.error.message, /masters\.create/);
    }
    const creator = t.sessionAs({ permissions: ['data.import', 'masters.view', 'masters.create'] });
    const upd = await t.call(dataRoutes, 'data.import.preview', { kind: 'groups', fileName: 'g.csv', bytes, options: { updateExisting: true } }, { session: creator });
    assert.equal(upd.ok, false, 'updating existing masters needs masters.alter');
    const ok = await t.call(dataRoutes, 'data.import.commit', { kind: 'groups', fileName: 'g.csv', bytes, options: { skipInvalid: false, updateExisting: false } }, { session: creator });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const vouchers = await t.call(dataRoutes, 'data.import.preview', { kind: 'sales_invoices', fileName: 's.csv', bytes }, { session: creator });
    assert.equal(vouchers.ok, false);
    if (!vouchers.ok) assert.match(vouchers.error.message, /vouchers\.create/);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM groups WHERE name = 'Branch Debtors'`), 1);
  });

  it('runs through the dispatcher and returns the counts', async () => {
    const r = await t.call(dataRoutes, 'data.import.commit', {
      kind: 'groups',
      fileName: 'g.csv',
      bytes: csv('Name,Under\r\nBranch Debtors,Sundry Debtors'),
      options: { skipInvalid: false, updateExisting: false },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.equal((r.data as { created: number }).created, 1);
    const kinds = await t.callOk<Array<{ kind: string; columns: unknown[] }>>(dataRoutes, 'data.import.kinds');
    assert.equal(kinds.length, IMPORT_KINDS.length);
  });
});

describe('data.import: invoices and vouchers through the vouchers service', () => {
  let k: Kit;
  beforeEach(() => {
    k = setupKit();
  });
  afterEach(() => k.t.close());

  it('sales invoices: rows with the same number form one invoice; GST is computed like manual entry', () => {
    const bytes = csv(
      [
        'Invoice No,Date,Party,Item,Ledger,Qty,Rate,Amount,Narration',
        'INV-101,10-04-2026,Acme Traders,Mixer Grinder,,2,150,,Imported',
        'INV-101,10-04-2026,Acme Traders,Rice Bag,,4,50,,',
        'INV-102,12-04-2026,Bangalore Retail,Mixer Grinder,,1,150,,',
      ].join('\r\n'),
    );
    const p = previewImport(k.t.ctx, { kind: 'sales_invoices', fileName: 's.csv', bytes, options: { acknowledgeWarnings: true } });
    assert.equal(p.summary.total, 2);
    assert.deepEqual(p.rows[0].rowNumbers, [2, 3]);
    assert.equal(p.summary.error, 0, JSON.stringify(p.rows));
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM vouchers`), 0);

    const r = commitImport(k.t.ctx, { kind: 'sales_invoices', fileName: 's.csv', bytes, options: { skipInvalid: false, updateExisting: false, acknowledgeWarnings: true } });
    assert.equal(r.created, 2, JSON.stringify(r.rows));
    const v = k.t.db.get<{ id: number; place_of_supply: string; narration: string }>(
      `SELECT v.id, v.place_of_supply, v.narration FROM vouchers v JOIN ledger_entries le ON le.voucher_id = v.id
        WHERE le.ledger_id = :acme AND v.base_type = 'sales'`,
      { acme: k.L.acme },
    );
    // Mixer 2 × 150 = 300 @18% → CGST 27 + SGST 27; Rice 4 × 50 = 200 @5% → CGST 5 + SGST 5.
    // 300 + 200 + 54 + 10 = ₹564 to Acme.
    assert.equal(k.t.db.value(`SELECT amount FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l`, { id: v?.id ?? 0, l: k.L.acme }), 564_00);
    assert.equal(v?.place_of_supply, '27');
    assert.equal(v?.narration, 'Imported');
    assert.deepEqual(
      k.t.db.get(`SELECT SUM(cgst) AS c, SUM(sgst) AS s, SUM(igst) AS i FROM gst_lines WHERE voucher_id = :id`, { id: v?.id ?? 0 }),
      { c: 32_00, s: 32_00, i: 0 },
    );
    // Bangalore (29) → inter-state: IGST 18% of 150 = 27 → ₹177.
    assert.equal(k.t.db.value(`SELECT amount FROM ledger_entries WHERE ledger_id = :l`, { l: k.L.blr }), 177_00);
    // Stock left the godown: mixer 50 − 2 − 1.
    assert.equal(k.t.db.value(`SELECT SUM(qty) FROM inventory_entries WHERE item_id = :i`, { i: k.I.mixer }), -3);
  });

  it('an invoice with an unknown party or item fails with the row number; skip invalid keeps the good invoice', () => {
    const bytes = csv(
      ['Invoice No,Date,Party,Item,Qty,Rate', 'INV-201,10-04-2026,Acme Traders,Mixer Grinder,1,150', 'INV-202,10-04-2026,Nobody & Co,Mixer Grinder,1,150', 'INV-203,10-04-2026,Acme Traders,Gold Bar,1,150'].join(
        '\r\n',
      ),
    );
    const p = previewImport(k.t.ctx, { kind: 'sales_invoices', fileName: 's.csv', bytes, options: { acknowledgeWarnings: true } });
    // Row 2 is valid; its number cannot be kept because "Sales" numbers automatically (a warning, not an error).
    assert.equal(p.rows[0].status, 'warning');
    assert.match(p.rows[0].messages.join(' '), /automatic numbering/);
    assert.deepEqual(
      p.rows.map((r) => r.status === 'error'),
      [false, true, true],
    );
    assert.match(p.rows[1].messages.join(' '), /Nobody & Co/);
    assert.match(p.rows[2].messages.join(' '), /Gold Bar/);
    assert.throws(() => commitImport(k.t.ctx, { kind: 'sales_invoices', fileName: 's.csv', bytes, options: { skipInvalid: false, updateExisting: false, acknowledgeWarnings: true } }), AppError);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers'), 0);
    const r = commitImport(k.t.ctx, { kind: 'sales_invoices', fileName: 's.csv', bytes, options: { skipInvalid: true, updateExisting: false, acknowledgeWarnings: true } });
    assert.deepEqual({ created: r.created, failed: r.failed }, { created: 1, failed: 2 });
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers'), 1);
  });

  it('purchase invoices keep the supplier bill number as the reference', () => {
    const bytes = csv('Supplier Invoice No,Date,Supplier,Item,Qty,Rate\r\nSS/451,03-04-2026,Supreme Suppliers,Rice Bag,20,40');
    const r = commitImport(k.t.ctx, { kind: 'purchase_invoices', fileName: 'p.csv', bytes, options: { skipInvalid: false, updateExisting: false, acknowledgeWarnings: true } });
    assert.equal(r.created, 1, JSON.stringify(r.rows));
    // 20 × 40 = 800 @5% intra-state → CGST 20 + SGST 20 → ₹840 Cr to the supplier.
    assert.deepEqual(k.t.db.get(`SELECT reference_no, base_type FROM vouchers`), { reference_no: 'SS/451', base_type: 'purchase' });
    assert.equal(k.t.db.value(`SELECT amount FROM ledger_entries WHERE ledger_id = :l`, { l: k.L.supplier }), -840_00);
  });

  it('journal / payment vouchers from Dr/Cr lines; an unbalanced voucher is an error', () => {
    const bytes = csv(
      [
        'Voucher Key,Date,Voucher Type,Ledger,Debit,Credit,Narration',
        'J1,10-04-2026,Journal,Office Rent,12000,,Rent',
        'J1,10-04-2026,Journal,Owner Capital,,12000,',
        'P1,11-04-2026,Payment,Office Rent,500,,',
        'P1,11-04-2026,Payment,Cash,,500,',
        'BAD,12-04-2026,Journal,Office Rent,100,,',
        'BAD,12-04-2026,Journal,Cash,,90,',
      ].join('\r\n'),
    );
    const p = previewImport(k.t.ctx, { kind: 'vouchers_ledger', fileName: 'v.csv', bytes, options: { acknowledgeWarnings: true } });
    assert.deepEqual(
      p.rows.map((r) => [r.key, r.status === 'error']),
      [
        ['J1', false],
        ['P1', false],
        ['BAD', true],
      ],
    );
    const r = commitImport(k.t.ctx, { kind: 'vouchers_ledger', fileName: 'v.csv', bytes, options: { skipInvalid: true, updateExisting: false, acknowledgeWarnings: true } });
    assert.equal(r.created, 2);
    assert.equal(k.t.db.value(`SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l`, { l: k.L.rent }), 12_500_00);
    assert.equal(k.t.db.value('SELECT SUM(amount) FROM ledger_entries'), 0);
  });
});
