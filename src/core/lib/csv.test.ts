import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  headerKeys,
  neutraliseFormula,
  normaliseHeader,
  parseCsv,
  rowsToObjects,
  sniffDelimiter,
  toCsv,
} from './csv.ts';
import { FileFormatError, decodeText, encodeUtf8WithBom } from './text.ts';

describe('parseCsv', () => {
  it('parses simple rows with LF, CRLF and CR line ends; trailing newline adds no row', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a,b\r1,2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('\n'), [['']]);
  });

  it('handles quoted fields: delimiters, escaped quotes, embedded CR/LF', () => {
    const text = 'name,address,note\r\n"Ram, Sons","Line 1\r\nLine 2","He said ""hi"""\r\n"",x,"a\nb"\n';
    assert.deepEqual(parseCsv(text), [
      ['name', 'address', 'note'],
      ['Ram, Sons', 'Line 1\r\nLine 2', 'He said "hi"'],
      ['', 'x', 'a\nb'],
    ]);
  });

  it('keeps empty fields, trailing delimiters and quotes inside unquoted fields', () => {
    assert.deepEqual(parseCsv('a,,c,\n,,\n'), [['a', '', 'c', ''], ['', '', '']]);
    assert.deepEqual(parseCsv('5" pipe,x'), [['5" pipe', 'x']]);
    // Lenient: text after a closing quote is appended.
    assert.deepEqual(parseCsv('"ab"cd,e'), [['abcd', 'e']]);
  });

  it('strips a BOM and can skip empty rows', () => {
    assert.deepEqual(parseCsv('﻿Date,Amount\n01-04-2024,100\n'), [['Date', 'Amount'], ['01-04-2024', '100']]);
    const text = 'a,b\n\n,\n1,2\n\n';
    assert.deepEqual(parseCsv(text), [['a', 'b'], [''], ['', ''], ['1', '2'], ['']]);
    assert.deepEqual(parseCsv(text, { skipEmptyRows: true }), [['a', 'b'], ['1', '2']]);
  });

  it('throws FileFormatError with the position of an unterminated quote', () => {
    assert.throws(
      () => parseCsv('a,b\n1,"oops\n2,3\n'),
      (err: unknown) =>
        err instanceof FileFormatError && err.line === 2 && err.column === 3 && /Unterminated quoted field/.test(err.message),
    );
  });

  it('supports ; TAB and | delimiters', () => {
    assert.deepEqual(parseCsv('a;b\n"1;5";2', { delimiter: ';' }), [['a', 'b'], ['1;5', '2']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2', { delimiter: '\t' }), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a|b\n1|2', { delimiter: '|' }), [['a', 'b'], ['1', '2']]);
    assert.throws(() => parseCsv('a', { delimiter: '"' as ',' }), TypeError);
  });

  it("sniffs the delimiter with delimiter: 'auto'", () => {
    assert.equal(sniffDelimiter('Date;Narration;Amount\n01/04/2024;NEFT;1.234,50\n02/04/2024;UPI;99,00\n'), ';');
    assert.equal(sniffDelimiter('a\tb\tc\n1\t2,5\t3\n'), '\t');
    assert.equal(sniffDelimiter('a|b|c\n1|2|3\n'), '|');
    assert.equal(sniffDelimiter('Date,Narration,Amount\n01/04/2024,"NEFT; ref 1|2",1234.50\n'), ',');
    assert.equal(sniffDelimiter('single column\nvalue\n'), ',');
    // Bank statement with a title line before the header.
    assert.equal(sniffDelimiter('Statement of account\nDate;Desc;Debit;Credit\n1;a;2;3\n4;b;5;6\n'), ';');
    assert.deepEqual(parseCsv('x;y\n1;2\n', { delimiter: 'auto' }), [['x', 'y'], ['1', '2']]);
  });

  it('stops after maxRows rows', () => {
    const text = 'h1,h2\n1,2\n3,4\n5,6\n';
    assert.deepEqual(parseCsv(text, { maxRows: 2 }), [['h1', 'h2'], ['1', '2']]);
    assert.deepEqual(parseCsv(text, { maxRows: 0 }), []);
  });

  it('parses a large file quickly (no quadratic behaviour)', () => {
    const line = '"Ram ""&"" Sons, Pune",2024-04-01,-1234.50,"multi\nline"\n';
    const text = line.repeat(100_000);
    const t0 = performance.now();
    const rows = parseCsv(text);
    assert.equal(rows.length, 100_000);
    assert.deepEqual(rows[99_999], ['Ram "&" Sons, Pune', '2024-04-01', '-1234.50', 'multi\nline']);
    assert.ok(performance.now() - t0 < 3000);
  });
});

describe('toCsv', () => {
  it('quotes only when needed and uses CRLF with a trailing newline', () => {
    const csv = toCsv([
      ['Name', 'Amount', 'Active', 'Note'],
      ['Ram, Sons', 1250.5, true, 'said "hi"'],
      ['Line\nbreak', -3, false, null],
      [undefined, Number.NaN, 0, ''],
    ]);
    assert.equal(
      csv,
      'Name,Amount,Active,Note\r\n"Ram, Sons",1250.5,TRUE,"said ""hi"""\r\n"Line\nbreak",-3,FALSE,\r\n,,0,\r\n',
    );
    assert.equal(toCsv([]), '');
    assert.equal(toCsv([['a', 'b;c']], { delimiter: ';', newline: '\n' }), 'a;"b;c"\n');
    assert.throws(() => toCsv([['a']], { delimiter: '"' }), TypeError);
  });

  it('neutralises formula injection in text cells but never in real numbers', () => {
    const csv = toCsv([['=HYPERLINK("http://evil","x")', '+91 98765', '-2+3', '@SUM(A1)', '\tTAB', '\rCR', -42, 'safe', "'already"]]);
    assert.equal(
      csv,
      `"'=HYPERLINK(""http://evil"",""x"")",'+91 98765,'-2+3,'@SUM(A1),'\tTAB,"'\rCR",-42,safe,'already\r\n`,
    );
    assert.equal(neutraliseFormula('=1+1'), "'=1+1");
    assert.equal(neutraliseFormula('1+1'), '1+1');
    assert.equal(toCsv([['=1+1']], { neutraliseFormulas: false }), '=1+1\r\n');
  });

  it('adds a BOM when asked (Excel-friendly UTF-8)', () => {
    const csv = toCsv([['₹', 'राम']], { bom: true });
    assert.equal(csv, '﻿₹,राम\r\n');
    const bytes = encodeUtf8WithBom(csv);
    assert.deepEqual([...bytes.subarray(0, 4)], [0xef, 0xbb, 0xbf, 0xe2]);
    assert.deepEqual(parseCsv(decodeText(bytes).text), [['₹', 'राम']]);
  });

  it('round-trips tricky values through parseCsv', () => {
    const rows = [
      ['a', 'b,c', 'd"e', 'f\r\ng', ' lead', 'trail ', ''],
      ['ü', '₹ 1,00,000.00', '"', '""', ',', '\n', 'x'],
    ];
    assert.deepEqual(parseCsv(toCsv(rows, { neutraliseFormulas: false })), rows);
    assert.deepEqual(parseCsv(toCsv(rows, { delimiter: '\t' }), { delimiter: '\t' }), rows);
  });
});

describe('header mapping', () => {
  it('normalises headers: trim, collapse whitespace (incl. NBSP), case-insensitive', () => {
    assert.equal(normaliseHeader('  Txn   Date \n'), 'txn date');
    assert.equal(normaliseHeader('GSTIN/UIN'), 'gstin/uin');
    assert.equal(normaliseHeader(null), '');
    assert.equal(normaliseHeader(2024), '2024');
    assert.deepEqual(headerKeys(['Amount', ' amount ', '', 'AMOUNT', 'Date']), ['amount', 'amount 2', 'column 3', 'amount 3', 'date']);
  });

  it('rowsToObjects maps rows below the header row and skips blank rows', () => {
    const rows = [
      ['HDFC Bank statement', ''],
      ['Date', 'Narration', 'Withdrawal Amt.'],
      ['01/04/2024', 'NEFT-ABC', '1,000.00'],
      ['', '  ', ''],
      ['02/04/2024', 'UPI', '', 'extra'],
      ['03/04/2024'],
    ];
    assert.deepEqual(rowsToObjects(rows, { headerRow: 1 }), [
      { date: '01/04/2024', narration: 'NEFT-ABC', 'withdrawal amt.': '1,000.00' },
      { date: '02/04/2024', narration: 'UPI', 'withdrawal amt.': '', 'column 4': 'extra' },
      { date: '03/04/2024', narration: null, 'withdrawal amt.': null, 'column 4': null },
    ]);
    assert.deepEqual(rowsToObjects([], {}), []);
  });

  it('is safe against a "__proto__" header (own property, no prototype pollution)', () => {
    const [rec] = rowsToObjects([['__proto__', 'constructor'], ['{"polluted":1}', 'x']]);
    assert.equal(Object.getPrototypeOf(rec), Object.prototype);
    assert.ok(Object.hasOwn(rec, '__proto__'));
    assert.equal(rec['__proto__'], '{"polluted":1}');
    assert.equal(rec.constructor, 'x');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
