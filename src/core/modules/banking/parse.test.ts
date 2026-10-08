/**
 * Statement parsing (pure): cell values, header classification, bank layouts (SBI, HDFC, ICICI, Axis, Kotak,
 * Yes Bank, PNB, Bank of Baroda, Canara, generic), junk/summary rows, ordering, balance check and hashes.
 * Amounts are paise; statement amounts are from the bank's view (deposit +, withdrawal −).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StatementMapping } from '../../../shared/types/banking.ts';
import { FileFormatError } from '../../lib/text.ts';
import { dateToSerial, writeXlsx } from '../../lib/xlsx.ts';
import { accountMismatch, parseStatement, referenceKey, statementAccountNumbers, type ParsedStatement } from './parse.ts';
import { classifyHeader, headerKey } from './presets.ts';
import { detectDateOrder, parseStatementAmount, parseStatementDate } from './values.ts';
import { rs, textBytes } from './testkit.ts';

const lines = (p: ParsedStatement) =>
  (p.extract?.lines ?? []).map((l) => [l.txnDate, l.amount, l.balance, l.reference, l.description] as const);

describe('statement cell values', () => {
  it('reads the date formats Indian banks use', () => {
    const cases: Array<[string | number, string | null]> = [
      ['01/04/2026', '2026-04-01'],
      ['1-4-26', '2026-04-01'],
      ['31.03.2026', '2026-03-31'],
      ['01-Apr-2026', '2026-04-01'],
      ['1 Apr 2026', '2026-04-01'],
      ['01/APR/26', '2026-04-01'],
      ['1st April, 2026', '2026-04-01'],
      ['Apr 01, 2026', '2026-04-01'],
      ['2026-04-01', '2026-04-01'],
      ['2026/4/1', '2026-04-01'],
      ['01042026', '2026-04-01'],
      ['20260401', '2026-04-01'],
      ['01-04-2026 10:20:30', '2026-04-01'],
      ['01/04/2026 10:20 AM', '2026-04-01'],
      [dateToSerial('2026-04-01') as number, '2026-04-01'],
      ['31/02/2026', null],
      ['********', null],
      ['Opening Balance', null],
      [125000, null], // an amount, not an Excel serial in the statement range
    ];
    for (const [cell, want] of cases) assert.equal(parseStatementDate(cell), want, String(cell));
    assert.equal(parseStatementDate('04/13/2026', 'mdy'), '2026-04-13');
    assert.equal(parseStatementDate('04/13/2026', 'dmy'), null);
  });

  it('detects mm/dd only when a day above 12 proves it (dd/mm otherwise)', () => {
    assert.equal(detectDateOrder(['01/04/2026', '13/04/2026']), 'dmy');
    assert.equal(detectDateOrder(['04/01/2026', '04/13/2026']), 'mdy');
    assert.equal(detectDateOrder(['01/04/2026', '02/04/2026']), 'dmy');
    assert.equal(detectDateOrder(['2026-04-13', null, 5]), 'dmy');
  });

  it('reads amounts with Indian grouping, Cr/Dr suffixes, brackets and currency', () => {
    assert.deepEqual(parseStatementAmount('1,23,456.78'), { value: 12345678, drCr: null });
    assert.deepEqual(parseStatementAmount('1,25,000.00 Cr'), { value: 12500000, drCr: 'cr' });
    assert.deepEqual(parseStatementAmount('500.00Dr'), { value: 50000, drCr: 'dr' });
    assert.deepEqual(parseStatementAmount('Dr 50'), { value: 5000, drCr: 'dr' });
    assert.deepEqual(parseStatementAmount('1,000.00 (Cr)'), { value: 100000, drCr: 'cr' });
    assert.deepEqual(parseStatementAmount('(1,234.00)'), { value: -123400, drCr: null });
    assert.deepEqual(parseStatementAmount('1234.50-'), { value: -123450, drCr: null });
    assert.deepEqual(parseStatementAmount('₹ 1,234'), { value: 123400, drCr: null });
    assert.deepEqual(parseStatementAmount('INR 1,234.00'), { value: 123400, drCr: null });
    assert.deepEqual(parseStatementAmount(2500.5), { value: 250050, drCr: null });
    for (const blank of ['', ' ', '-', 'NIL', null]) assert.equal(parseStatementAmount(blank), null, String(blank));
    assert.equal(parseStatementAmount('abc'), undefined);
  });

  it('classifies statement column captions by meaning', () => {
    const roles = (hs: string[]) => hs.map((h) => classifyHeader(h)?.role ?? null);
    assert.deepEqual(roles(['Txn Date', 'Value Dt', 'Narration', 'Chq./Ref.No.', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance']), [
      'date', 'valueDate', 'description', 'reference', 'debit', 'credit', 'balance',
    ]);
    assert.deepEqual(roles(['Dr / Cr', 'Amount', 'WITHDRAWAL(DR)', 'DEPOSIT(CR)', 'BAL', 'CHQNO', 'Txn No.', 'Branch Name', 'S No.', 'SOL']), [
      'drCr', 'amount', 'debit', 'credit', 'balance', 'reference', null, null, null, null,
    ]);
    assert.equal(classifyHeader('Transaction Posted Date')?.priority, 2);
    assert.equal(classifyHeader('01/04/2026'), null, 'data, not a caption');
    assert.equal(headerKey('Withdrawal Amount (INR )'), 'withdrawal amount');
  });
});

describe('bank layouts', () => {
  it('SBI: tab-separated ".xls" with account details above, "1 Apr 2026" dates and a footer', () => {
    const tsv = [
      'Account Name\t:\tTest Traders Pvt Ltd',
      'Address\t:\t12 MG Road, Fort',
      'Date\t:\t5 May 2026',
      'Account Number\t:\t00000012345678901',
      'Account Description\t:\tCURRENT ACCOUNT',
      'Branch\t:\tFORT MUMBAI',
      'IFS Code\t:\tSBIN0000300',
      'Balance as on 1 Apr 2026\t:\t1,00,000.00',
      '\t\t',
      'Account Statement from 1 Apr 2026 to 30 Apr 2026',
      '\t\t',
      'Txn Date\tValue Date\tDescription\tRef No./Cheque No.\t        Debit\tCredit\tBalance',
      '1 Apr 2026\t1 Apr 2026\tBY TRANSFER-NEFT*HDFC0000001*N091260001*ACME TRADERS\tTRANSFER FROM 3199\t \t25,000.00\t1,25,000.00',
      '3 Apr 2026\t3 Apr 2026\tTO CLEARING CHQ 000501 SUPREME SUPPLIERS\t000501\t40,000.00\t \t85,000.00',
      '5 Apr 2026\t5 Apr 2026\tATM WDL ATM CASH 1234 FORT\t \t5,000.00\t \t80,000.00',
      '**This is a computer generated statement and does not require a signature',
    ].join('\r\n');
    const p = parseStatement('sbi.xls', textBytes(tsv), { bankHint: 'State Bank of India' });
    assert.equal(p.layout.preset.id, 'sbi');
    assert.equal(p.layout.detectedBy, 'preset');
    assert.equal(p.layout.mapping?.headerRow, 11);
    assert.equal(p.file.delimiter, '\t');
    assert.deepEqual(lines(p), [
      ['2026-04-01', rs(25_000), rs(1_25_000), 'TRANSFER FROM 3199', 'BY TRANSFER-NEFT*HDFC0000001*N091260001*ACME TRADERS'],
      ['2026-04-03', -rs(40_000), rs(85_000), '000501', 'TO CLEARING CHQ 000501 SUPREME SUPPLIERS'],
      ['2026-04-05', -rs(5_000), rs(80_000), '', 'ATM WDL ATM CASH 1234 FORT'],
    ]);
    const s = p.extract?.summary;
    // Opening from "Balance as on …" above the table; closing = last running balance.
    assert.equal(s?.openingBalance, rs(1_00_000));
    assert.equal(s?.closingBalance, rs(80_000));
    assert.deepEqual([s?.totalDeposits, s?.totalWithdrawals, s?.depositCount, s?.withdrawalCount], [rs(25_000), rs(45_000), 1, 2]);
    // 1,25,000 − 40,000 = 85,000 ✓; 85,000 − 5,000 = 80,000 ✓
    assert.deepEqual(s?.balanceCheck, { checked: 2, mismatches: 0, firstMismatchRow: null, swappedLikely: false });
    assert.deepEqual(p.extract?.issues.map((i) => [i.row, i.reason]), [[16, 'Not a transaction row']]);
  });

  it('HDFC: CSV with dd/mm/yy dates, asterisk separators and a STATEMENT SUMMARY block', () => {
    const csv = [
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '********,********,********,********,********,********,********',
      '01/04/26,NEFT CR-HDFC0000001-ACME TRADERS-N091260001,0000N091260001,01/04/26,,"25,000.00","1,25,000.00"',
      '03/04/26,CHQ PAID-MICR CTS-SUPREME SUPPLIERS,0000000000000501,03/04/26,"40,000.00",,"85,000.00"',
      '13/04/26,UPI-BHARAT STORES-BHARAT@OKSBI-412345678901,0000412345678901,13/04/26,,"1,180.00","86,180.00"',
      '********,********,********,********,********,********,********',
      'STATEMENT SUMMARY  :-,,,,,,',
      'Opening Balance,Dr Count,Cr Count,Debits,Credits,Closing Bal,',
      '"1,00,000.00",1,2,"40,000.00","26,180.00","86,180.00",',
    ].join('\n');
    const p = parseStatement('hdfc.csv', textBytes(csv), { bankHint: 'HDFC Bank' });
    assert.equal(p.layout.preset.id, 'hdfc');
    assert.equal(p.extract?.dateOrder, 'dmy'); // 13/04/26 proves dd/mm
    assert.deepEqual(lines(p).map((l) => [l[0], l[1], l[2], l[3]]), [
      ['2026-04-01', rs(25_000), rs(1_25_000), '0000N091260001'],
      ['2026-04-03', -rs(40_000), rs(85_000), '0000000000000501'],
      ['2026-04-13', rs(1_180), rs(86_180), '0000412345678901'],
    ]);
    assert.deepEqual(p.extract?.issues.map((i) => [i.row, i.level, i.reason]), [
      [2, 'info', 'Separator row'],
      [6, 'info', 'Separator row'],
      [7, 'info', 'Closing balance / total row'],
      [8, 'info', 'Statement footer'],
      [9, 'info', 'Statement footer'],
    ]);
    // Opening derived from the first line: 1,25,000 − 25,000.
    assert.equal(p.extract?.summary.openingBalance, rs(1_00_000));
    assert.equal(p.extract?.summary.skippedRows, 5);
  });

  it('ICICI: .xlsx with title rows, date cells, text dates and both value/transaction dates', () => {
    const bytes = writeXlsx({
      sheets: [
        {
          name: 'OpTransactionHistory',
          rows: [
            ['DETAILED STATEMENT'],
            ['Account Number', '000405012345 ( INR ) - TEST TRADERS PVT LTD'],
            ['Transaction Period', 'From 01/04/2026 To 30/04/2026'],
            [],
            ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )'],
            [1, { v: '2026-04-01', kind: 'date' }, { v: '2026-04-01', kind: 'date' }, '-', 'NEFT-N091260001-ACME TRADERS', 0, 25000, 125000],
            [2, '02/04/2026', '03/04/2026', '000501', 'CLG/SUPREME SUPPLIERS/000501', 40000, 0, 85000],
            [3, { v: '2026-04-30', kind: 'date' }, { v: '2026-04-30', kind: 'date' }, '', 'Int.Pd:01-04-2026 to 30-04-2026', 0, 312.5, 85312.5],
            [],
            ['Legends Used in Account Statement'],
          ],
        },
      ],
    });
    const p = parseStatement('icici.xlsx', bytes, { bankHint: 'ICICI Bank' });
    assert.equal(p.file.format, 'xlsx');
    assert.equal(p.layout.preset.id, 'icici');
    assert.equal(p.layout.mapping?.sheet, 'OpTransactionHistory');
    assert.deepEqual(p.layout.mapping?.columns, { date: 2, valueDate: 1, reference: 3, description: 4, debit: 5, credit: 6, balance: 7 });
    assert.deepEqual(lines(p).map((l) => [l[0], l[1], l[2], l[3]]), [
      ['2026-04-01', rs(25_000), rs(1_25_000), ''],
      ['2026-04-03', -rs(40_000), rs(85_000), '000501'],
      // ₹312.50 interest credit; 85,000 + 312.50 = 85,312.50 ✓ (blank cheque number → '').
      ['2026-04-30', 31250, 8531250, ''],
    ]);
    assert.equal(p.extract?.lines[1].valueDate, '2026-04-02');
  });

  it('Axis: OPENING BALANCE / TRANSACTION TOTAL / CLOSING BALANCE rows, DR and CR columns, dd-mm-yyyy', () => {
    const csv = [
      'Tran Date,CHQNO,PARTICULARS,DR,CR,BAL,SOL',
      ',,OPENING BALANCE,,,"1,00,000.00",',
      '01-04-2026,,NEFT/N091260001/ACME TRADERS,,25000.00,125000.00,1234',
      '03-04-2026,501,CLG/SUPREME SUPPLIERS,40000.00,,85000.00,1234',
      ',,TRANSACTION TOTAL,40000.00,25000.00,,',
      ',,CLOSING BALANCE,,,85000.00,',
    ].join('\n');
    const p = parseStatement('axis.csv', textBytes(csv), { bankHint: 'Axis Bank' });
    assert.equal(p.layout.preset.id, 'axis');
    assert.deepEqual(lines(p).map((l) => [l[0], l[1], l[3]]), [
      ['2026-04-01', rs(25_000), ''],
      ['2026-04-03', -rs(40_000), '501'],
    ]);
    assert.equal(p.extract?.summary.openingBalance, rs(1_00_000));
    assert.equal(p.extract?.summary.closingBalance, rs(85_000));
    assert.deepEqual(p.extract?.issues.map((i) => i.reason), ['Opening balance row', 'Closing balance / total row', 'Closing balance / total row']);
  });

  it('Kotak: single Amount column with a Dr/Cr column, and a second Dr/Cr column for the balance', () => {
    const csv = [
      'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
      '1,01-04-2026,01-04-2026,NEFT ACME TRADERS,N091260001,"25,000.00",CR,"25,000.00",CR',
      '2,03-04-2026,03-04-2026,CHQ 501 SUPREME,501,"40,000.00",DR,"15,000.00",DR',
      '3,04-04-2026,04-04-2026,IMPS BHARAT,412345678901,"20,000.00",CR,"5,000.00",CR',
    ].join('\n');
    const p = parseStatement('kotak.csv', textBytes(csv), { bankHint: 'Kotak' });
    assert.equal(p.layout.preset.id, 'kotak');
    assert.deepEqual(p.layout.mapping?.columns, { date: 1, valueDate: 2, description: 3, reference: 4, amount: 5, drCr: 6, balance: 7, balanceDrCr: 8 });
    // 25,000 − 40,000 = −15,000 (overdrawn, "Dr" balance); −15,000 + 20,000 = 5,000.
    assert.deepEqual(lines(p).map((l) => [l[1], l[2]]), [
      [rs(25_000), rs(25_000)],
      [-rs(40_000), -rs(15_000)],
      [rs(20_000), rs(5_000)],
    ]);
    assert.equal(p.extract?.summary.balanceCheck.mismatches, 0);
  });

  it('Yes Bank (dd-MMM-yyyy), PNB (Cr/Dr suffix balances), Bank of Baroda and Canara (dates with time)', () => {
    const yes = parseStatement(
      'yes.csv',
      textBytes(
        [
          'Transaction Date,Value Date,Cheque No/Reference No,Description,Withdrawals,Deposits,Running Balance',
          '01-Apr-2026,01-Apr-2026,N091260001,NEFT ACME TRADERS,,25000.00,125000.00',
          '02-Apr-2026,02-Apr-2026,,SMS CHARGES,17.70,,124982.30',
        ].join('\n'),
      ),
    );
    assert.equal(yes.layout.preset.id, 'yes');
    assert.deepEqual(lines(yes).map((l) => [l[0], l[1], l[2]]), [['2026-04-01', rs(25_000), rs(1_25_000)], ['2026-04-02', -1770, 12498230]]);

    const pnb = parseStatement(
      'pnb.csv',
      textBytes(
        [
          'Txn No.,Txn Date,Description,Branch Name,Cheque No.,Dr Amount,Cr Amount,Balance,Value Date',
          'S81234,01/04/2026,NEFT-ACME TRADERS,FORT,,,25000.00,"25,000.00 Cr",01/04/2026',
          'S81240,02/04/2026,CHQ PAID SUPREME,FORT,501,"75,000.00",,"50,000.00 Dr",02/04/2026',
        ].join('\n'),
      ),
    );
    assert.equal(pnb.layout.preset.id, 'pnb');
    assert.deepEqual(lines(pnb).map((l) => [l[1], l[2], l[3]]), [[rs(25_000), rs(25_000), ''], [-rs(75_000), -rs(50_000), '501']]);

    const bob = parseStatement(
      'bob.csv',
      textBytes(
        [
          'TRAN DATE,VALUE DATE,NARRATION,CHQ.NO.,WITHDRAWAL(DR),DEPOSIT(CR),BALANCE(INR)',
          '01/04/2026,01/04/2026,NEFT-ACME TRADERS,,,"25,000.00","1,25,000.00Cr"',
        ].join('\n'),
      ),
    );
    assert.equal(bob.layout.preset.id, 'bob');
    assert.deepEqual(lines(bob).map((l) => [l[1], l[2]]), [[rs(25_000), rs(1_25_000)]]);

    const canara = parseStatement(
      'canara.csv',
      textBytes(
        [
          'Txn Date,Value Date,Cheque No.,Description,Branch Code,Debit,Credit,Balance',
          '01-04-2026 10:20:30,01-04-2026,,NEFT ACME TRADERS,1234,,25000.00,125000.00',
          '02-04-2026 16:05:00,02-04-2026,000501,CLG SUPREME,1234,40000.00,,85000.00',
        ].join('\n'),
      ),
      { bankHint: 'Canara Bank' },
    );
    assert.equal(canara.layout.preset.id, 'canara');
    assert.deepEqual(lines(canara).map((l) => [l[0], l[1]]), [['2026-04-01', rs(25_000)], ['2026-04-02', -rs(40_000)]]);
  });

  it('generic: semicolon file with a single signed Amount column (minus = withdrawal)', () => {
    const csv = ['Posting Date;Details;Reference;Amount;Balance', '2026-04-01;Opening deposit;;100000.00;100000.00', '2026-04-03;Rent April;R-4;-15000.00;85000.00'].join(
      '\n',
    );
    const p = parseStatement('other.csv', textBytes(csv));
    assert.equal(p.layout.preset.id, 'generic');
    assert.equal(p.layout.detectedBy, 'auto');
    assert.equal(p.file.delimiter, ';');
    assert.deepEqual(p.layout.mapping?.columns, { date: 0, description: 1, reference: 2, amount: 3, balance: 4 });
    assert.deepEqual(lines(p).map((l) => [l[1], l[2]]), [[rs(1_00_000), rs(1_00_000)], [-rs(15_000), rs(85_000)]]);
    // Same file read with "positive = withdrawal" (some card/loan exports): signs flip.
    const flipped = parseStatement('other.csv', textBytes(csv), { mapping: { ...(p.layout.mapping as StatementMapping), amountSign: 'withdrawal_positive' } });
    assert.deepEqual(lines(flipped).map((l) => l[1]), [-rs(1_00_000), rs(15_000)]);
  });
});

describe('statement checks', () => {
  it('reads a newest-first statement bottom-up and checks the running balance in date order', () => {
    const csv = [
      'Date,Narration,Withdrawal,Deposit,Balance',
      '05/04/2026,ATM WDL,2000.00,,93000.00',
      '03/04/2026,NEFT ACME,,20000.00,95000.00',
      '02/04/2026,CHQ 501,25000.00,,75000.00',
    ].join('\n');
    const p = parseStatement('desc.csv', textBytes(csv));
    assert.equal(p.extract?.summary.order, 'descending');
    assert.deepEqual(p.extract?.lines.map((l) => [l.seq, l.txnDate, l.row]), [[0, '2026-04-02', 4], [1, '2026-04-03', 3], [2, '2026-04-05', 2]]);
    // 75,000 + 20,000 = 95,000 ✓; 95,000 − 2,000 = 93,000 ✓; opening = 75,000 + 25,000 = 1,00,000.
    assert.equal(p.extract?.summary.balanceCheck.mismatches, 0);
    assert.equal(p.extract?.summary.openingBalance, rs(1_00_000));
  });

  it('flags withdrawal and deposit columns that were swapped in the mapping', () => {
    const csv = ['Date,Narration,Withdrawal,Deposit,Balance', '01/04/2026,A,,1000.00,11000.00', '02/04/2026,B,500.00,,10500.00', '03/04/2026,C,,250.00,10750.00'].join('\n');
    const auto = parseStatement('s.csv', textBytes(csv));
    const m = auto.layout.mapping as StatementMapping;
    assert.equal(auto.extract?.summary.balanceCheck.mismatches, 0);
    const swapped = parseStatement('s.csv', textBytes(csv), { mapping: { ...m, columns: { ...m.columns, debit: m.columns.credit, credit: m.columns.debit } } });
    assert.deepEqual(swapped.extract?.summary.balanceCheck, { checked: 2, mismatches: 2, firstMismatchRow: 3, swappedLikely: true });
    assert.match(swapped.extract?.issues[0].reason ?? '', /Running balance does not agree/);
  });

  it('joins narration continued on the next row and reports unreadable rows', () => {
    const csv = [
      'Date,Narration,Ref,Debit,Credit,Balance',
      '01/04/2026,NEFT CR N091260001,N091260001,,25000.00,125000.00',
      ',ACME TRADERS PVT LTD,,,,',
      '02/04/2026,CHQ 501,501,abc,,',
      '31/02/2026,BAD DATE,,100.00,,',
      '03/04/2026,BOTH,,100.00,200.00,',
      ',NO DATE BUT MONEY,,300.00,,',
    ].join('\n');
    const p = parseStatement('m.csv', textBytes(csv));
    assert.deepEqual(p.extract?.lines.map((l) => l.description), ['NEFT CR N091260001 ACME TRADERS PVT LTD']);
    assert.deepEqual(p.extract?.issues.map((i) => [i.row, i.level, i.reason]), [
      [3, 'info', 'Narration continued from the previous row'],
      [4, 'warning', 'Unreadable withdrawal amount "abc"'],
      [5, 'warning', 'Unreadable date "31/02/2026"'],
      [6, 'warning', 'Both the withdrawal and the deposit column have an amount'],
      [7, 'warning', 'Amount without a date'],
    ]);
    assert.equal(p.extract?.summary.skippedRows, 4, 'the continuation row is part of a line, not skipped');
  });

  it('gives identical lines distinct, stable dedupe hashes (occurrence within the file)', () => {
    const csv = ['Date,Narration,Debit,Credit', '01/04/2026,UPI TEA STALL,20.00,', '01/04/2026,UPI TEA STALL,20.00,', '02/04/2026,UPI TEA STALL,20.00,'].join('\n');
    const a = parseStatement('u.csv', textBytes(csv)).extract?.lines.map((l) => l.hash) ?? [];
    const b = parseStatement('u.csv', textBytes(csv)).extract?.lines.map((l) => l.hash) ?? [];
    assert.equal(new Set(a).size, 3);
    assert.deepEqual(a, b);
  });

  it('the CSV and the Excel download of the same statement give the same hashes (cheque no. 000501 vs the number 501)', () => {
    const csv = ['Date,Narration,Chq No,Debit,Credit,Balance', '06/04/2026,CHQ PAID SUPREME,000501,"40,000.00",,"85,000.00"'].join('\n');
    const xlsx = writeXlsx({
      sheets: [{ name: 'Statement', rows: [['Date', 'Narration', 'Chq No', 'Debit', 'Credit', 'Balance'], ['06/04/2026', 'CHQ PAID SUPREME', 501, 40000, null, 85000]] }],
    });
    const a = parseStatement('s.csv', textBytes(csv)).extract?.lines ?? [];
    const b = parseStatement('s.xlsx', xlsx).extract?.lines ?? [];
    assert.deepEqual([a[0]?.reference, b[0]?.reference], ['000501', '501']);
    assert.equal(a[0]?.hash, b[0]?.hash);
    assert.equal(referenceKey('000501'), '501');
    assert.equal(referenceKey('N0912-60001'), 'N091260001');
    assert.equal(referenceKey('0'), '0');
  });

  it('reads Excel serial dates in a General-format column', () => {
    const serial = dateToSerial('2026-04-07') as number;
    const bytes = writeXlsx({ sheets: [{ name: 'Sheet1', rows: [['Date', 'Description', 'Debit', 'Credit', 'Balance'], [serial, 'NEFT ACME', null, 1500, 101500]] }] });
    const p = parseStatement('serial.xlsx', bytes);
    assert.deepEqual(lines(p).map((l) => [l[0], l[1]]), [['2026-04-07', rs(1_500)]]);
  });

  it('uses a given mapping when the captions are not recognisable', () => {
    const csv = ['Col A,Col B,Col C,Col D', '01/04/2026,Cash deposit,5000.00 Cr,105000.00', '02/04/2026,Cheque 77,1200.00 Dr,103800.00'].join('\n');
    const auto = parseStatement('x.csv', textBytes(csv));
    assert.equal(auto.layout.mapping, null);
    assert.equal(auto.extract, null);
    const mapping: StatementMapping = { preset: 'generic', headerRow: 0, columns: { date: 0, description: 1, amount: 2, balance: 3 }, dateOrder: 'dmy' };
    const p = parseStatement('x.csv', textBytes(csv), { mapping });
    assert.equal(p.layout.detectedBy, 'given');
    // "Cr" suffix = deposit, "Dr" = withdrawal.
    assert.deepEqual(lines(p).map((l) => l[1]), [rs(5_000), -rs(1_200)]);
    assert.throws(
      () => parseStatement('x.csv', textBytes(csv), { mapping: { ...mapping, columns: { date: 0, description: 0, amount: 2 } } }),
      (e: unknown) => e instanceof FileFormatError && /Column 1 is chosen both as Date and as Narration/.test(e.message),
    );
  });

  it('refuses HTML/XML "Excel" files, old .xls workbooks, PDFs and empty files with a clear message', () => {
    const cases: Array<[Uint8Array, RegExp]> = [
      [textBytes('<html><body><table><tr><td>Date</td></tr></table></body></html>'), /web page \(HTML table\).*Save As/],
      [textBytes('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"></Workbook>'), /Excel 2003 XML spreadsheet/],
      [new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), /old Excel 97-2003 \(\.xls\) workbook/],
      [textBytes('%PDF-1.7 ...'), /PDF statements cannot be imported/],
      [new Uint8Array(0), /is empty/],
    ];
    for (const [bytes, re] of cases) {
      assert.throws(
        () => parseStatement('statement.xls', bytes),
        (e: unknown) => e instanceof FileFormatError && e.code === 'VALIDATION' && re.test(e.message),
        String(re),
      );
    }
  });
});

describe('account number above the heading', () => {
  it('finds "Account Number", "A/C No." and masked numbers, ignores "Account Name" / "Account Statement"', () => {
    const rows = [
      ['Account Name', ':', 'Test Traders'],
      ['Account Statement from 1 Apr 2026'],
      ['Account Number', ':', '00000012345678901'],
      ['A/C No. XXXXXXXX5678'],
      ['Date', 'Narration', 'Debit', 'Credit'],
    ];
    assert.deepEqual(statementAccountNumbers(rows, 4), ['00000012345678901', 'XXXXXXXX5678']);
    // Rows below the heading are transactions, never read for account numbers.
    assert.deepEqual(statementAccountNumbers(rows, 2), []);
    assert.equal(accountMismatch(['XXXXXXXX5678'], '50100012345678'), null);
    assert.equal(accountMismatch(['00000012345678901'], '50100012345678'), '8901');
    assert.equal(accountMismatch([], '50100012345678'), null);
    assert.equal(accountMismatch(['XXXX8901'], null), null);
  });
});
