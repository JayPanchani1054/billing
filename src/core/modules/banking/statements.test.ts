/**
 * Statement import end to end: preview (no writes, duplicates flagged, saved mapping), import (batch, lines in
 * the bank's view, audit), dedupe on re-import, line listing / search / counts, batches and batch deletion,
 * permissions through the real dispatcher.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type {
  DeleteBatchResult,
  StatementBatch,
  StatementImportResult,
  StatementLinesResult,
  StatementMapping,
  StatementPreview,
} from '../../../shared/types/banking.ts';
import { AppError } from '../../lib/errors.ts';
import { writeXlsx } from '../../lib/xlsx.ts';
import { autoMatch } from './matching.ts';
import { bankingRoutes } from './routes.ts';
import { deleteBatch, importStatement, previewStatement, statementBatches, statementLines } from './statements.ts';
import { bankDateOf, payment, receipt, rs, setupBank, textBytes, type BankKit } from './testkit.ts';

const APRIL_1 = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '02/04/26,NEFT CR-HDFC0000001-ACME TRADERS-N091260001,N091260001,02/04/26,,"25,000.00","1,25,000.00"',
  '06/04/26,CHQ PAID-MICR CTS-SUPREME SUPPLIERS,000501,06/04/26,"40,000.00",,"85,000.00"',
  '10/04/26,UPI-TEA STALL,0000412345678901,10/04/26,20.00,,"84,980.00"',
];
/** Second download overlapping the first: two lines already imported + two new ones. */
const APRIL_2 = [
  ...APRIL_1.slice(0, 1),
  APRIL_1[2],
  APRIL_1[3],
  '10/04/26,UPI-TEA STALL,0000412345678902,10/04/26,20.00,,"84,960.00"',
  '30/04/26,SMS CHARGES QTR,,30/04/26,590.00,,"84,370.00"',
];

describe('statement import', () => {
  let k: BankKit;
  beforeEach(() => {
    k = setupBank();
  });
  afterEach(() => k.t.close());

  const preview = (lines: string[], mapping?: StatementMapping): Promise<StatementPreview> =>
    k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', { ledgerId: k.L.hdfc, fileName: 'hdfc.csv', bytes: textBytes(lines.join('\n')), mapping });
  const doImport = (lines: string[], mapping: StatementMapping, fileName = 'hdfc.csv'): Promise<StatementImportResult> =>
    k.t.callOk<StatementImportResult>(bankingRoutes, 'banking.statement.import', { ledgerId: k.L.hdfc, fileName, bytes: textBytes(lines.join('\n')), mapping });
  const count = (sql: string): number => k.t.db.value<number>(sql) ?? 0;

  it('preview detects the HDFC layout, returns parsed lines and the summary, and writes nothing', async () => {
    const p = await preview(APRIL_1);
    assert.equal(p.format, 'csv');
    assert.equal(p.preset.id, 'hdfc');
    assert.equal(p.detectedBy, 'preset');
    assert.equal(p.dateOrder, 'dmy');
    assert.deepEqual(p.mapping?.columns, { date: 0, description: 1, reference: 2, valueDate: 3, debit: 4, credit: 5, balance: 6 });
    assert.deepEqual(
      p.lines.map((l) => [l.txnDate, l.amount, l.balance, l.duplicate]),
      [
        ['2026-04-02', rs(25_000), rs(1_25_000), false],
        ['2026-04-06', -rs(40_000), rs(85_000), false],
        ['2026-04-10', -2000, 8498000, false],
      ],
    );
    // Deposits 25,000; withdrawals 40,000 + 20 = 40,020; opening 1,25,000 − 25,000 = 1,00,000.
    assert.deepEqual(
      [p.summary.totalDeposits, p.summary.totalWithdrawals, p.summary.openingBalance, p.summary.closingBalance, p.summary.duplicates],
      [rs(25_000), rs(40_020), rs(1_00_000), 8498000, 0],
    );
    assert.equal(p.headers[4], 'Withdrawal Amt.');
    assert.equal(p.rawPreview.length, 4);
    assert.equal(count('SELECT COUNT(*) FROM bank_statement_lines'), 0);
    assert.equal(count(`SELECT COUNT(*) FROM import_batches`), 0);
    assert.equal(count('SELECT COUNT(*) FROM bank_statement_presets'), 0);
  });

  it('import stores the lines (deposit +, withdrawal −) with a batch, saves the mapping and audits', async () => {
    const p = await preview(APRIL_1);
    const res = await doImport(APRIL_1, p.mapping as StatementMapping);
    assert.deepEqual(
      { ...res, batchId: typeof res.batchId },
      {
        batchId: 'number',
        imported: 3,
        duplicates: 0,
        skippedRows: 0,
        from: '2026-04-02',
        to: '2026-04-10',
        totalDeposits: rs(25_000),
        totalWithdrawals: rs(40_020),
        closingBalance: 8498000,
      },
    );
    const rows = k.t.db.all<{ amount: number; status: string; seq: number; source_row: number; line_hash: string | null }>(
      'SELECT amount, status, seq, source_row, line_hash FROM bank_statement_lines ORDER BY seq',
    );
    assert.deepEqual(rows.map((r) => [r.amount, r.status, r.seq, r.source_row]), [[rs(25_000), 'unmatched', 0, 2], [-rs(40_000), 'unmatched', 1, 3], [-2000, 'unmatched', 2, 4]]);
    assert.ok(rows.every((r) => typeof r.line_hash === 'string' && r.line_hash.length === 64));
    const audit = k.t.db.get<{ action: string; entity_type: string; entity_id: number }>(`SELECT action, entity_type, entity_id FROM audit_log WHERE entity_type = 'bank_statement'`);
    assert.deepEqual(audit, { action: 'import', entity_type: 'bank_statement', entity_id: res.batchId });

    // Next month's file is read with the saved mapping (even under a generic name).
    const again = await preview(APRIL_2);
    assert.equal(again.detectedBy, 'saved');
    assert.equal(again.preset.id, 'hdfc');
  });

  it('dedupes on re-import: only new lines are stored; the same file twice imports nothing', async () => {
    const p = await preview(APRIL_1);
    const mapping = p.mapping as StatementMapping;
    await doImport(APRIL_1, mapping);
    const same = await doImport(APRIL_1, mapping, 'hdfc-copy.csv');
    assert.equal(same.batchId, null);
    assert.equal(same.imported, 0);
    assert.equal(same.duplicates, 3);

    const p2 = await preview(APRIL_2);
    assert.deepEqual(p2.lines.map((l) => l.duplicate), [true, true, false, false]);
    assert.equal(p2.summary.duplicates, 2);
    const res = await doImport(APRIL_2, p2.mapping as StatementMapping, 'hdfc-2.csv');
    // The second ₹20 tea-stall payment has another UPI reference and balance: a new line, not a duplicate.
    assert.deepEqual([res.imported, res.duplicates, res.totalWithdrawals], [2, 2, 2000 + rs(590)]);
    assert.equal(count('SELECT COUNT(*) FROM bank_statement_lines'), 5);
    assert.equal(count(`SELECT COUNT(*) FROM import_batches WHERE kind = 'bank_statement'`), 2);
  });

  it('lists lines with status counts, search by text or amount and totals; batches with their counts', async () => {
    const p = await preview(APRIL_2);
    const imp = await doImport(APRIL_2, p.mapping as StatementMapping);
    payment(k, { date: '2026-04-03', amount: 40_000, other: k.L.supreme, instrument: { type: 'cheque', number: '000501' } });
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    const all = await k.t.callOk<StatementLinesResult>(bankingRoutes, 'banking.statement.lines', { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30' });
    assert.equal(all.total, 4);
    assert.deepEqual(all.counts, { unmatched: 3, matched: 1, created: 0, ignored: 0 });
    assert.equal(all.rows[0].status, 'matched');
    assert.equal(all.rows[0].matched?.particulars, 'Supreme Suppliers');
    assert.equal(all.rows[0].matchMethod, 'auto');
    // Withdrawals 40,000 + 20 + 20 + 590 = 40,630; no deposits in this file.
    assert.deepEqual(all.totals, { deposits: 0, withdrawals: rs(40_630) });

    const unmatched = statementLines(k.t.db, { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30', status: 'unmatched' });
    assert.equal(unmatched.total, 3);
    const tea = statementLines(k.t.db, { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30', search: 'tea stall' });
    assert.equal(tea.total, 2);
    const byAmount = statementLines(k.t.db, { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30', search: '590.00' });
    assert.deepEqual(byAmount.rows.map((r) => r.withdrawal), [rs(590)]);
    const pct = statementLines(k.t.db, { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30', search: '100%' });
    assert.equal(pct.total, 0, 'LIKE wildcards in the search are literal');

    const batches = await k.t.callOk<StatementBatch[]>(bankingRoutes, 'banking.statement.batches', { ledgerId: k.L.hdfc });
    assert.equal(batches.length, 1);
    const b = batches[0];
    assert.deepEqual(
      [b.id, b.ledgerName, b.preset, b.lineCount, b.counts.matched, b.totalDeposits, b.from, b.to],
      [imp.batchId, 'HDFC Bank', 'hdfc', 4, 1, 0, '2026-04-06', '2026-04-30'],
    );
    assert.deepEqual(statementBatches(k.t.db, k.L.sbiOd), []);
  });

  it('deleting a batch with matched lines needs "unmatch", which clears the bank dates', async () => {
    const p = await preview(APRIL_1);
    const imp = await doImport(APRIL_1, p.mapping as StatementMapping);
    const r = receipt(k, { date: '2026-04-02', amount: 25_000, other: k.L.acme });
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    assert.equal(bankDateOf(k, r.entryId), '2026-04-02');
    const batchId = imp.batchId as number;
    assert.throws(
      () => deleteBatch(k.t.ctx, batchId, false),
      (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /1 line of this statement is reconciled/.test(e.message),
    );
    const res = await k.t.callOk<DeleteBatchResult>(bankingRoutes, 'banking.statement.deleteBatch', { batchId, unmatch: true });
    assert.deepEqual(res, { batchId, deletedLines: 3, unmatched: 1 });
    assert.equal(bankDateOf(k, r.entryId), null);
    assert.equal(count('SELECT COUNT(*) FROM bank_statement_lines'), 0);
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'bank_statement' AND action = 'delete'`), 1);
  });

  it('preview without recognisable headings returns raw rows and a mapping of null; a non-bank ledger is refused', async () => {
    const odd = ['Col A,Col B,Col C,Col D', '01/04/2026,Cash deposit,5000.00 Cr,105000.00'];
    const p = await preview(odd);
    assert.equal(p.mapping, null);
    assert.equal(p.lines.length, 0);
    assert.deepEqual(p.rawPreview[1], ['01/04/2026', 'Cash deposit', '5000.00 Cr', '105000.00']);
    assert.match(p.issues[0].reason, /column headings/);
    const given = await preview(odd, { preset: 'generic', headerRow: 0, columns: { date: 0, description: 1, amount: 2, balance: 3 }, dateOrder: 'auto' });
    assert.deepEqual(given.lines.map((l) => l.amount), [rs(5_000)]);
    assert.throws(
      () => previewStatement(k.t.db, { ledgerId: k.L.rent, fileName: 'x.csv', bytes: textBytes(odd.join('\n')) }),
      (e: unknown) => e instanceof AppError && /Statement import is available only for ledgers under Bank Accounts or Bank OD/.test(e.message),
    );
    const html = await k.t.call(bankingRoutes, 'banking.statement.preview', { ledgerId: k.L.hdfc, fileName: 'stmt.xls', bytes: textBytes('<html><table></table></html>') });
    assert.equal(html.ok, false);
    assert.match(!html.ok ? html.error.message : '', /web page \(HTML table\)/);
  });

  it('import refuses a mapping that finds no transactions', () => {
    assert.throws(
      () =>
        importStatement(k.t.ctx, {
          ledgerId: k.L.hdfc,
          fileName: 'empty.csv',
          bytes: textBytes('Date,Narration,Debit,Credit\n'),
          mapping: { preset: 'generic', headerRow: 0, columns: { date: 0, description: 1, debit: 2, credit: 3 }, dateOrder: 'dmy' },
        }),
      (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /No transactions were found/.test(e.message),
    );
  });

  it('permissions: Data Entry cannot preview or import; Auditor can list lines but not delete batches', async () => {
    const p = await preview(APRIL_1);
    const imp = await doImport(APRIL_1, p.mapping as StatementMapping);
    const dataEntry = k.t.sessionAs({ role: 'Data Entry' });
    const auditor = k.t.sessionAs({ role: 'Auditor' });
    const input = { ledgerId: k.L.hdfc, fileName: 'hdfc.csv', bytes: textBytes(APRIL_1.join('\n')) };
    const pv = await k.t.call(bankingRoutes, 'banking.statement.preview', input, { session: dataEntry });
    assert.equal(!pv.ok && pv.error.code, 'FORBIDDEN');
    const im = await k.t.call(bankingRoutes, 'banking.statement.import', { ...input, mapping: p.mapping }, { session: dataEntry });
    assert.equal(!im.ok && im.error.code, 'FORBIDDEN');
    const ls = await k.t.call(bankingRoutes, 'banking.statement.lines', { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30' }, { session: auditor });
    assert.equal(ls.ok, true);
    const del = await k.t.call(bankingRoutes, 'banking.statement.deleteBatch', { batchId: imp.batchId }, { session: auditor });
    assert.equal(!del.ok && del.error.code, 'FORBIDDEN');
    const bad = await k.t.call(bankingRoutes, 'banking.statement.lines', { ledgerId: k.L.hdfc, from: '2026-04-30', to: '2026-04-01' });
    assert.equal(!bad.ok && bad.error.code, 'VALIDATION');
  });
});

describe('statement import: worksheet choice', () => {
  it('reads the worksheet the user picks; the preview names the sheet it read', async () => {
    const k = setupBank();
    try {
      const head = ['Date', 'Narration', 'Debit', 'Credit', 'Balance'];
      const bytes = writeXlsx({
        sheets: [
          { name: 'Savings', rows: [head, ['01/04/2026', 'NEFT ACME', null, 1000, 101000]] },
          { name: 'Current', rows: [['Account: Current'], head, ['02/04/2026', 'CHQ 000501', 500, null, 99500], ['03/04/2026', 'NEFT BHARAT', null, 2000, 101500]] },
        ],
      });
      const input = { ledgerId: k.L.hdfc, fileName: 'two.xlsx', bytes };
      const auto = await k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', input);
      assert.deepEqual([auto.sheets, auto.sheet, auto.lines.length], [['Savings', 'Current'], 'Savings', 1]);
      const cur = await k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', { ...input, sheet: 'Current' });
      // Heading on row 2 of the Current sheet; −500 then +2,000.
      assert.deepEqual([cur.sheet, cur.mapping?.sheet, cur.mapping?.headerRow], ['Current', 'Current', 1]);
      assert.deepEqual(cur.lines.map((l) => l.amount), [-rs(500), rs(2_000)]);
      const res = await k.t.callOk<StatementImportResult>(bankingRoutes, 'banking.statement.import', { ...input, mapping: cur.mapping });
      assert.equal(res.imported, 2);
      const bad = await k.t.call(bankingRoutes, 'banking.statement.preview', { ...input, sheet: 'Loans' });
      assert.match(!bad.ok ? bad.error.message : '', /The worksheet "Loans" is not in this file.*Savings, Current/);
    } finally {
      k.t.close();
    }
  });
});

describe('statement import: other bank files', () => {
  it('imports an XLSX statement for a Bank OD ledger with Dr balances and a Kotak-style Dr/Cr column', async () => {
    const k = setupBank();
    try {
      const csv = [
        'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
        '1,01-04-2026,01-04-2026,CHQ 900001 SUPREME,900001,"10,000.00",DR,"2,10,000.00",DR',
        '2,02-04-2026,02-04-2026,NEFT ACME,N1,"50,000.00",CR,"1,60,000.00",DR',
      ].join('\n');
      const p = await k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', { ledgerId: k.L.sbiOd, fileName: 'kotak.csv', bytes: textBytes(csv) });
      assert.equal(p.preset.id, 'kotak');
      // −2,10,000 + 50,000 = −1,60,000 ✓ (overdrawn balances are negative).
      assert.deepEqual(p.lines.map((l) => [l.amount, l.balance]), [[-rs(10_000), -rs(2_10_000)], [rs(50_000), -rs(1_60_000)]]);
      assert.equal(p.summary.balanceCheck.mismatches, 0);
      assert.equal(p.summary.openingBalance, -rs(2_00_000));
      const pay = payment(k, { date: '2026-04-01', amount: 10_000, other: k.L.supreme, bank: k.L.sbiOd, instrument: { type: 'cheque', number: '900001' } });
      await k.t.callOk(bankingRoutes, 'banking.statement.import', { ledgerId: k.L.sbiOd, fileName: 'kotak.csv', bytes: textBytes(csv), mapping: p.mapping });
      const am = autoMatch(k.t.ctx, { ledgerId: k.L.sbiOd });
      assert.deepEqual(am.applied.map((a) => a.ledgerEntryId), [pay.entryId]);
    } finally {
      k.t.close();
    }
  });
});

describe('statement import: data safety', () => {
  it('lines dated before the books begin are skipped (already in the opening balance) and never imported', async () => {
    const k = setupBank(); // books from 01-Apr-2026
    try {
      const csv = [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '30/03/26,NEFT CR-OLD CUSTOMER,N1,30/03/26,,"5,000.00","1,00,000.00"',
        '31/03/26,CHQ PAID-OLD SUPPLIER,000400,31/03/26,"2,000.00",,"98,000.00"',
        '02/04/26,NEFT CR-ACME TRADERS,N2,02/04/26,,"25,000.00","1,23,000.00"',
      ].join('\n');
      const input = { ledgerId: k.L.hdfc, fileName: 'hdfc.csv', bytes: textBytes(csv) };
      const p = await k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', input);
      // Only the April line counts; the two March lines are skipped with the reason.
      assert.deepEqual(p.lines.map((l) => [l.txnDate, l.amount]), [['2026-04-02', rs(25_000)]]);
      assert.deepEqual([p.summary.lineCount, p.summary.totalDeposits, p.summary.totalWithdrawals, p.summary.from, p.summary.to, p.summary.skippedRows], [1, rs(25_000), 0, '2026-04-02', '2026-04-02', 2]);
      assert.deepEqual(
        p.issues.filter((i) => i.reason.startsWith('Dated before the books begin')).map((i) => i.row),
        [2, 3],
      );
      // The running balance check still covers the whole file: 1,00,000 − 2,000 = 98,000 ✓; 98,000 + 25,000 = 1,23,000 ✓.
      assert.equal(p.summary.balanceCheck.mismatches, 0);
      const res = await k.t.callOk<StatementImportResult>(bankingRoutes, 'banking.statement.import', { ...input, mapping: p.mapping });
      assert.deepEqual([res.imported, res.skippedRows, res.from, res.totalDeposits], [1, 2, '2026-04-02', rs(25_000)]);
      assert.equal(k.t.db.value<number>("SELECT COUNT(*) FROM bank_statement_lines WHERE txn_date < '2026-04-01'"), 0);

      const allOld = [csv.split('\n')[0], csv.split('\n')[1]].join('\n');
      const bad = await k.t.call(bankingRoutes, 'banking.statement.import', { ...input, bytes: textBytes(allOld), mapping: p.mapping });
      assert.match(!bad.ok ? bad.error.message : '', /dated before the books begin \(01-Apr-2026\).*opening balance of HDFC Bank/);
    } finally {
      k.t.close();
    }
  });

  it('warns (without blocking) when the file names another account number than the bank ledger', async () => {
    const k = setupBank(); // HDFC ledger account no. 50100012345678 (ends 5678)
    try {
      const body = [
        'Date\tNarration\tChq./Ref.No.\tValue Dt\tWithdrawal Amt.\tDeposit Amt.\tClosing Balance',
        '02/04/26\tNEFT CR-ACME TRADERS\tN2\t02/04/26\t\t25,000.00\t1,25,000.00',
      ];
      const file = (account: string): Uint8Array => textBytes([`Account Number\t:\t${account}`, 'Branch\t:\tFORT', ...body].join('\n'));
      const call = (account: string): Promise<StatementPreview> =>
        k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', { ledgerId: k.L.hdfc, fileName: 'hdfc.xls', bytes: file(account) });
      const other = await call('XXXXXXXXXX9999');
      assert.match(other.accountWarning ?? '', /ending 9999, but HDFC Bank is account no\. ending 5678/);
      assert.equal(other.lines.length, 1); // still readable and importable
      assert.equal((await call('50100012345678')).accountWarning, null);
      assert.equal((await call('XXXXXXXXXX5678')).accountWarning, null); // masked, same last 4 digits
      // No account number in the file → no check.
      const plain = await k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', { ledgerId: k.L.hdfc, fileName: 'hdfc.xls', bytes: textBytes(body.join('\n')) });
      assert.equal(plain.accountWarning, null);
    } finally {
      k.t.close();
    }
  });
});
