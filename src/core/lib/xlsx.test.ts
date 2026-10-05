import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileFormatError } from './text.ts';
import { findAll, firstChild, parseXml, textOf } from './xml.ts';
import {
  AMOUNT_FORMAT,
  AMOUNT_FORMAT_NEGATIVE,
  columnName,
  dateToSerial,
  isDateFormatCode,
  readXlsx,
  sanitizeSheetNames,
  serialToDate,
  writeXlsx,
} from './xlsx.ts';
import type { XlsxSheet } from './xlsx.ts';
import { createZip, readZip } from './zip.ts';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function pkg(parts: Record<string, string>): Uint8Array {
  return createZip(Object.entries(parts).map(([name, data]) => ({ name, data })));
}

function part(bytes: Uint8Array, name: string): string {
  return readZip(bytes).readText(name);
}

describe('writeXlsx → readXlsx round trip', () => {
  it('preserves strings, numbers, booleans, dates and empty cells', () => {
    const sheet: XlsxSheet = {
      name: 'Day Book',
      title: ['ABC Traders Pvt Ltd', 'Day Book', '1-Apr-2024 to 31-Mar-2025'],
      columns: [
        { header: 'Date', kind: 'date' },
        { header: 'Particulars' },
        { header: 'Amount', kind: 'amount' },
        { header: 'Qty', kind: 'integer' },
        { header: 'GST %', kind: 'percent' },
        { header: 'Paid' },
      ],
      rows: [
        ['2024-04-01', 'Ram & Sons <Pune>', 125000.5, 10, 0.18, true],
        ['2025-03-31', { v: 'Cash', bold: true, indent: 2 }, -1234567.25, null, 0.05, false],
        [null, '', undefined, 0, null, null],
        ['1900-01-01', 'राम ₹ “quotes” 😀', 0.1, -3, 1, null],
        ['not a date', '  spaced  ', '12.50', 'abc', '5', 'TRUE'],
      ],
      freezeHeader: true,
      autoFilter: true,
    };
    const out = readXlsx(writeXlsx({ sheets: [sheet] }));
    assert.equal(out.sheets.length, 1);
    assert.equal(out.sheets[0].name, 'Day Book');
    assert.deepEqual(out.sheets[0].rows, [
      ['ABC Traders Pvt Ltd'],
      ['Day Book'],
      ['1-Apr-2024 to 31-Mar-2025'],
      [],
      ['Date', 'Particulars', 'Amount', 'Qty', 'GST %', 'Paid'],
      ['2024-04-01', 'Ram & Sons <Pune>', 125000.5, 10, 0.18, true],
      ['2025-03-31', 'Cash', -1234567.25, null, 0.05, false],
      [null, null, null, 0],
      ['1900-01-01', 'राम ₹ “quotes” 😀', 0.1, -3, 1],
      ['not a date', '  spaced  ', 12.5, 'abc', 5, 'TRUE'],
    ]);
  });

  it('writes formula-like text as inert strings (never <f>), including CSV-injection payloads', () => {
    const payloads = ['=HYPERLINK("http://evil","click")', '+cmd|/C calc!A0', '-2+3', '@SUM(A1:A9)', '=1+1'];
    const bytes = writeXlsx({ sheets: [{ name: 'S', rows: payloads.map((p) => [p]) }] });
    const sheetXml = part(bytes, 'xl/worksheets/sheet1.xml');
    assert.ok(!/<f[ >]/.test(sheetXml), 'no formula elements');
    assert.equal(findAll(parseXml(sheetXml), (e) => e.name === 'c' && e.attrs.t !== 's').length, 0, 'all cells are shared strings');
    assert.deepEqual(readXlsx(bytes).sheets[0].rows, payloads.map((p) => [p]));
  });

  it('keeps numbers forced to text as text (GSTIN-like codes, leading zeros)', () => {
    const bytes = writeXlsx({
      sheets: [{ name: 'S', columns: [{ header: 'PIN', kind: 'text' }], rows: [['007'], [400001], [{ v: 12.5, kind: 'text' }]] }],
    });
    assert.deepEqual(readXlsx(bytes).sheets[0].rows, [['PIN'], ['007'], ['400001'], ['12.5']]);
  });

  it('strips XML-invalid control characters and protects literal _xHHHH_ sequences', () => {
    const bytes = writeXlsx({ sheets: [{ name: 'S', rows: [['a\u0000b\u0007c\u001Fd\te\nf'], ['_x0041_ and _x005F_']] }] });
    assert.deepEqual(readXlsx(bytes).sheets[0].rows, [['abcd\te\nf'], ['_x0041_ and _x005F_']]);
    assert.match(part(bytes, 'xl/sharedStrings.xml'), /_x005F_x0041_ and _x005F_x005F_/);
  });

  it('round-trips several sheets and honours maxRows', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i, `row ${i}`]);
    const bytes = writeXlsx({ sheets: [{ name: 'A', rows }, { name: 'B', rows: [['only']] }] });
    const all = readXlsx(bytes);
    assert.deepEqual(all.sheets.map((s) => [s.name, s.rows.length]), [['A', 100], ['B', 1]]);
    const some = readXlsx(bytes, { maxRows: 10 });
    assert.equal(some.sheets[0].rows.length, 10);
    assert.deepEqual(some.sheets[0].rows[9], [9, 'row 9']);
  });

  it('writes an empty workbook as one empty sheet', () => {
    assert.deepEqual(readXlsx(writeXlsx({ sheets: [] })).sheets, [{ name: 'Sheet1', rows: [] }]);
  });
});

describe('writeXlsx package details', () => {
  it('sanitises sheet names: invalid chars, 31-char limit, uniqueness, reserved names', () => {
    assert.deepEqual(
      sanitizeSheetNames([
        'GSTR-1: B2B [Apr/24]*?',
        'gstr-1: b2b [apr/24]*?',
        'A very long sheet name that exceeds thirty-one characters',
        "'quoted'",
        '',
        'History',
        'Sales\\Purchase',
      ]),
      [
        'GSTR-1_ B2B _Apr_24___',
        'gstr-1_ b2b _apr_24___ (2)',
        'A very long sheet name that exc',
        'quoted',
        'Sheet',
        'History_',
        'Sales_Purchase',
      ],
    );
    const names = sanitizeSheetNames(Array.from({ length: 3 }, () => 'X'.repeat(40)));
    assert.deepEqual(names, ['X'.repeat(31), `${'X'.repeat(27)} (2)`, `${'X'.repeat(27)} (3)`]);
    const bytes = writeXlsx({ sheets: [{ name: 'a:b', rows: [] }, { name: 'A_B', rows: [] }] });
    assert.deepEqual(readXlsx(bytes).sheets.map((s) => s.name), ['a_b', 'A_B (2)']);
  });

  it('deduplicates shared strings', () => {
    const bytes = writeXlsx({
      sheets: [
        { name: 'One', columns: [{ header: 'Party' }], rows: [['Ram'], ['Shyam'], ['Ram'], ['Ram']] },
        { name: 'Two', rows: [['Shyam', 'Ram']] },
      ],
    });
    const sst = parseXml(part(bytes, 'xl/sharedStrings.xml'));
    assert.equal(sst.attrs.count, '7');
    assert.equal(sst.attrs.uniqueCount, '3');
    assert.deepEqual(findAll(sst, 'si').map((si) => textOf(si)), ['Party', 'Ram', 'Shyam']);
  });

  it('defines Indian amount, date, integer and percent formats, bold and indent styles', () => {
    const bytes = writeXlsx({
      sheets: [
        {
          name: 'TB',
          columns: [{ header: 'Particulars' }, { header: 'Amount', kind: 'amount' }],
          rows: [
            [{ v: 'Capital', bold: true }, 1500000],
            [{ v: 'Drawings', indent: 3 }, -250000],
            ['Date', { v: '2024-04-01', kind: 'date' }],
            ['Int', { v: 7, kind: 'integer' }],
            ['Pct', { v: 0.18, kind: 'percent' }],
          ],
        },
      ],
    });
    const styles = parseXml(part(bytes, 'xl/styles.xml'));
    const fmts = Object.fromEntries(findAll(styles, 'numFmts/numFmt').map((f) => [f.attrs.numFmtId, f.attrs.formatCode]));
    assert.deepEqual(fmts, { '164': AMOUNT_FORMAT, '165': AMOUNT_FORMAT_NEGATIVE, '166': 'dd-mmm-yyyy' });
    assert.equal(AMOUNT_FORMAT, '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00');
    const xfs = findAll(styles, 'cellXfs/xf');
    const sheet = parseXml(part(bytes, 'xl/worksheets/sheet1.xml'));
    const cell = (ref: string) => findAll(sheet, (e) => e.name === 'c' && e.attrs.r === ref)[0];
    const xfOf = (ref: string) => xfs[Number(cell(ref).attrs.s ?? 0)];
    assert.equal(xfOf('B2').attrs.numFmtId, '164');
    assert.equal(xfOf('B3').attrs.numFmtId, '165');
    assert.equal(xfOf('B4').attrs.numFmtId, '166');
    assert.equal(textOf(firstChild(cell('B4'), 'v')), '45383');
    assert.equal(xfOf('B5').attrs.numFmtId, '1');
    assert.equal(xfOf('B6').attrs.numFmtId, '10');
    const fonts = findAll(styles, 'fonts/font');
    assert.ok(firstChild(fonts[Number(xfOf('A2').attrs.fontId)], 'b'), 'bold font');
    assert.ok(firstChild(fonts[Number(xfOf('A1').attrs.fontId)], 'b'), 'header is bold');
    assert.deepEqual(firstChild(xfOf('A3'), 'alignment')?.attrs, { horizontal: 'left', indent: '3' });
  });

  it('freezes the header row, adds an auto-filter and column widths', () => {
    const bytes = writeXlsx({
      sheets: [
        {
          name: "Ram's Ledger",
          title: ['Company', 'Ledger'],
          columns: [{ header: 'Date', kind: 'date', width: 12 }, { header: 'Narration' }],
          rows: [['2024-04-01', 'x'.repeat(30)], ['2024-04-02', 'y']],
          freezeHeader: true,
          autoFilter: true,
        },
      ],
    });
    const sheet = parseXml(part(bytes, 'xl/worksheets/sheet1.xml'));
    assert.deepEqual(findAll(sheet, 'sheetViews/sheetView/pane')[0].attrs, {
      ySplit: '4',
      topLeftCell: 'A5',
      activePane: 'bottomLeft',
      state: 'frozen',
    });
    assert.equal(firstChild(sheet, 'autoFilter')?.attrs.ref, 'A4:B6');
    assert.equal(firstChild(sheet, 'dimension')?.attrs.ref, 'A1:B6');
    assert.deepEqual(findAll(sheet, 'cols/col').map((c) => c.attrs.width), ['12', '32']);
    const wb = parseXml(part(bytes, 'xl/workbook.xml'));
    const dn = findAll(wb, 'definedNames/definedName')[0];
    assert.equal(dn.attrs.name, '_xlnm._FilterDatabase');
    assert.equal(textOf(dn), "'Ram''s Ledger'!$A$4:$B$6");
  });

  it('is a valid OPC package: every part parses, content types and relationships resolve', () => {
    const bytes = writeXlsx({
      creator: 'Bahi <ERP> & Co',
      sheets: [
        { name: 'One', columns: [{ header: 'A' }], rows: [['x']] },
        { name: 'Two', rows: [[1]] },
      ],
    });
    const zip = readZip(bytes);
    const names = zip.list();
    assert.deepEqual(names.slice().sort(), [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    for (const name of names) assert.ok(parseXml(zip.readText(name)).name.length > 0, `${name} parses`);
    const types = parseXml(zip.readText('[Content_Types].xml'));
    for (const o of findAll(types, 'Override')) assert.ok(zip.has(o.attrs.PartName.slice(1)), `${o.attrs.PartName} exists`);
    for (const r of findAll(parseXml(zip.readText('_rels/.rels')), 'Relationship')) assert.ok(zip.has(r.attrs.Target));
    for (const r of findAll(parseXml(zip.readText('xl/_rels/workbook.xml.rels')), 'Relationship')) {
      assert.ok(zip.has(`xl/${r.attrs.Target}`), r.attrs.Target);
    }
    const core = parseXml(zip.readText('docProps/core.xml'));
    assert.equal(textOf(firstChild(core, 'dc:creator')), 'Bahi <ERP> & Co');
    assert.equal(parseXml(zip.readText('xl/workbook.xml')).attrs.xmlns, MAIN);
  });

  it('rejects sheets beyond Excel limits', () => {
    assert.throws(() => writeXlsx({ sheets: [{ name: 'W', rows: [new Array(16_385).fill(1)] }] }), RangeError);
  });

  it('exports 50 000 rows in reasonable time', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => ['2024-04-01', `Party ${i % 300}`, i * 10.5, -i]);
    const t0 = performance.now();
    const bytes = writeXlsx({
      sheets: [{ name: 'Big', columns: [{ header: 'Date', kind: 'date' }, { header: 'Party' }, { header: 'Dr', kind: 'amount' }, { header: 'Cr', kind: 'amount' }], rows }],
    });
    const back = readXlsx(bytes);
    assert.equal(back.sheets[0].rows.length, 50_001);
    assert.deepEqual(back.sheets[0].rows[50_000], ['2024-04-01', 'Party 199', 524989.5, -49999]);
    assert.ok(performance.now() - t0 < 5000);
  });
});

describe('readXlsx compatibility', () => {
  /** Mimics Excel 365 output: extra namespaces/extLst, theme, rId order ≠ sheet order, rich text, phonetic runs. */
  const excelLike = (): Uint8Array =>
    pkg({
      '[Content_Types].xml':
        DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
      '_rels/.rels': `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml':
        DECL +
        `<workbook xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision">` +
        '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/>' +
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Users\\acct\\Downloads\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent>' +
        '<xr:revisionPtr revIDLastSave="0" documentId="8_{0B4E}" xr6:coreVersion="47" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6"/>' +
        '<bookViews><workbookView xWindow="-108" yWindow="-108" windowWidth="23256" windowHeight="12576"/></bookViews>' +
        '<sheets><sheet name="Bank Statement" sheetId="1" r:id="rId3"/><sheet name="Notes" sheetId="2" r:id="rId1"/></sheets>' +
        '<calcPr calcId="191029"/><extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst></workbook>',
      'xl/_rels/workbook.xml.rels':
        `${DECL}<Relationships xmlns="${PKG}">` +
        `<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId5" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
      'xl/theme/theme1.xml': `${DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"/>`,
      'xl/styles.xml':
        DECL +
        `<styleSheet xmlns="${MAIN}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">` +
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="[$-409]d\\-mmm\\-yy;@"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]\\-#,##0.00"/></numFmts>' +
        '<fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>',
      'xl/sharedStrings.xml':
        DECL +
        `<sst xmlns="${MAIN}" count="8" uniqueCount="7">` +
        '<si><t>Txn Date</t></si><si><t>Narration</t></si><si><t>Amount</t></si>' +
        '<si><r><rPr><b/><sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr><t>NEFT</t></r><r><rPr><sz val="11"/><rFont val="Calibri"/></rPr><t xml:space="preserve"> from Ram &amp; Sons</t></r></si>' +
        '<si><t>漢字</t><rPh sb="0" eb="2"><t>カンジ</t></rPh><phoneticPr fontId="1"/></si>' +
        '<si><t xml:space="preserve">  padded  </t></si>' +
        '<si><t>Line1_x000D_\nLine2</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        DECL +
        `<worksheet xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">` +
        '<dimension ref="A1:E7"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="B3" sqref="B3"/></sheetView></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="14.4" x14ac:dyDescent="0.3"/><cols><col min="1" max="1" width="10.77734375" bestFit="1" customWidth="1"/></cols>' +
        '<sheetData>' +
        '<row r="1" spans="1:3" x14ac:dyDescent="0.3"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2" spans="1:3" x14ac:dyDescent="0.3"><c r="A2" s="1"><v>45383</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" s="3"><v>-1250.5</v></c></row>' +
        '<row r="4" spans="1:5" x14ac:dyDescent="0.3"><c r="A4" s="2"><v>45747</v></c><c r="C4" s="4"><v>1E-3</v></c><c r="E4" t="b"><v>1</v></c></row>' +
        '<row r="5" spans="1:5"><c r="A5" s="5"><v>45383.75</v></c><c r="B5" t="e"><v>#N/A</v></c><c r="C5" t="str"><f>A5&amp;"x"</f><v>calc result</v></c><c r="D5" t="inlineStr"><is><t>inline ₹</t></is></c><c r="E5" s="1"/></row>' +
        '<row r="6" spans="2:5"><c r="B6" t="s"><v>4</v></c><c r="C6" t="s"><v>5</v></c><c r="D6" t="s"><v>6</v></c><c r="E6"><f>SUM(C2:C4)</f><v>-1250.499</v></c></row>' +
        '<row r="7" s="1" customFormat="1" x14ac:dyDescent="0.3"/>' +
        '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>',
      'xl/worksheets/sheet2.xml':
        `${DECL}<worksheet xmlns="${MAIN}"><sheetData><row><c t="inlineStr"><is><t>note</t></is></c><c><v>5</v></c></row><row><c r="C2"><v>7</v></c></row></sheetData></worksheet>`,
    });

  it('parses a hand-built Excel-style workbook (numFmtId 14 date, sparse rows, rich text, inline strings, errors)', () => {
    const out = readXlsx(excelLike());
    assert.deepEqual(out.sheets.map((s) => s.name), ['Bank Statement', 'Notes']);
    assert.deepEqual(out.sheets[0].rows, [
      ['Txn Date', 'Narration', 'Amount'],
      ['2024-04-01', 'NEFT from Ram & Sons', -1250.5],
      [],
      ['2025-03-31', null, 0.001, null, true],
      ['2024-04-01', null, 'calc result', 'inline ₹'],
      [null, '漢字', '  padded  ', 'Line1\r\nLine2', -1250.499],
    ]);
    assert.deepEqual(out.sheets[1].rows, [['note', 5], [null, null, 7]]);
  });

  it('honours the 1904 date system', () => {
    const wb = (pr: string): Uint8Array =>
      pkg({
        '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}">${pr}<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
        'xl/styles.xml': `<styleSheet xmlns="${MAIN}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="15"/></cellXfs></styleSheet>`,
        'xl/worksheets/sheet1.xml': `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" s="1"><v>43921</v></c><c r="B1" s="1"><v>0</v></c></row></sheetData></worksheet>`,
      });
    assert.deepEqual(readXlsx(wb('<workbookPr date1904="1"/>')).sheets[0].rows, [['2024-04-01', '1904-01-01']]);
    assert.deepEqual(readXlsx(wb('<workbookPr date1904="false"/>')).sheets[0].rows, [['2020-03-31', 0]]);
  });

  it('reads LibreOffice / Google Sheets / SDK variants: prefixes, absolute targets, t="n"/"d", no sharedStrings', () => {
    const bytes = pkg({
      '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<x:workbook xmlns:x="${MAIN}" xmlns:rel="${REL}"><x:workbookPr backupFile="false" date1904="false"/><x:sheets><x:sheet name="Ledger &amp; Co" sheetId="7" state="visible" rel:id="R9"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}"><Relationship Id="R9" Type="${REL}/worksheet" Target="/xl/worksheets/Sheet%201.xml"/><Relationship Id="R2" Type="${REL}/styles" Target="../xl/styles.xml"/><Relationship Id="R3" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`,
      'xl/styles.xml': `<x:styleSheet xmlns:x="${MAIN}"><x:numFmts count="2"><x:numFmt numFmtId="164" formatCode="DD/MM/YYYY"/><x:numFmt numFmtId="165" formatCode="&quot;Rs.&quot; #,##0.00"/></x:numFmts><x:cellXfs count="3"><x:xf numFmtId="0"/><x:xf numFmtId="164"/><x:xf numFmtId="165"/></x:cellXfs></x:styleSheet>`,
      'xl/worksheets/Sheet 1.xml':
        `<x:worksheet xmlns:x="${MAIN}"><x:sheetData>` +
        '<x:row r="1"><x:c r="A1" s="1" t="n"><x:v>45383</x:v></x:c><x:c r="B1" s="2" t="n"><x:v>99.5</x:v></x:c><x:c r="c1" t="b"><x:v>true</x:v></x:c></x:row>' +
        '<x:row r="2"><x:c r="A2" t="d"><x:v>2024-04-01T00:00:00</x:v></x:c><x:c r="B2" t="inlineStr"><x:is><x:r><x:t>a</x:t></x:r><x:r><x:t>b</x:t></x:r></x:is></x:c></x:row>' +
        '</x:sheetData></x:worksheet>',
    });
    assert.deepEqual(readXlsx(bytes).sheets, [
      { name: 'Ledger & Co', rows: [['2024-04-01', 99.5, true], ['2024-04-01', 'ab']] },
    ]);
  });

  it('refuses sparse-cell memory bombs (one far-right cell per row) via maxCells', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join('');
    const bomb = pkg({
      'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`,
    });
    // 2 000 rows × 16 384 columns = 32.8 M padded cells > default budget of 20 M.
    assert.throws(() => readXlsx(bomb), (err: unknown) => err instanceof FileFormatError && /more than 20000000 cells/.test(err.message));
    const ok = readXlsx(bomb, { maxRows: 2 });
    assert.equal(ok.sheets[0].rows.length, 2);
    assert.equal(ok.sheets[0].rows[1][16_383], 1);
    assert.throws(() => readXlsx(writeXlsx({ sheets: [{ name: 'S', rows: [[1, 2, 3], [4, 5, 6]] }] }), { maxCells: 5 }), /more than 5 cells/);
  });

  it('throws clear FileFormatErrors for non-workbooks', () => {
    const isErr = (re: RegExp) => (err: unknown) => err instanceof FileFormatError && re.test(err.message);
    assert.throws(() => readXlsx(new TextEncoder().encode('Date,Narration,Amount\n1,2,3\n')), isErr(/Not a ZIP archive/));
    assert.throws(() => readXlsx(pkg({ 'hello.txt': 'hi' })), isErr(/workbook part is missing/));
    const htmlXls = new TextEncoder().encode('\uFEFF  <html><body><table><tr><td>Date</td><td>Amount</td></tr></table></body></html>');
    assert.throws(() => readXlsx(htmlXls), isErr(/HTML\/XML table saved with an Excel extension/));
    assert.throws(() => readXlsx(pkg({ 'xl/workbook.bin': 'x' })), isErr(/\.xlsb/));
    assert.throws(() => readXlsx(pkg({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet' })), isErr(/\.ods/));
    assert.throws(() => readXlsx(pkg({ 'xl/workbook.xml': '<workbook><sheets>' })), isErr(/Invalid XML in xl\/workbook\.xml/));
    const missingSheet = pkg({
      'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    });
    assert.throws(() => readXlsx(missingSheet), isErr(/Worksheet "S" is missing/));
  });
});

describe('date and format helpers', () => {
  it('converts ISO dates to Excel serials and back (1900 system incl. the Lotus leap-year bug)', () => {
    const cases: [string, number][] = [
      ['1900-01-01', 1],
      ['1900-02-28', 59],
      ['1900-03-01', 61],
      ['2024-02-29', 45351],
      ['2024-04-01', 45383],
      ['2025-03-31', 45747],
      ['9999-12-31', 2958465],
    ];
    for (const [iso, serial] of cases) {
      assert.equal(dateToSerial(iso), serial, iso);
      assert.equal(serialToDate(serial), iso, String(serial));
    }
    assert.equal(serialToDate(60), '1900-02-29');
    assert.equal(serialToDate(45383.999), '2024-04-01');
    assert.equal(serialToDate(0.5), null);
    assert.equal(serialToDate(43921, true), '2024-04-01');
    for (const bad of ['2024-02-30', '1899-12-31', '24-04-01', '2024-4-1', '']) assert.equal(dateToSerial(bad), null, bad);
  });

  it('detects date number formats', () => {
    for (const code of ['dd-mmm-yyyy', 'DD/MM/YYYY', '[$-409]d\\-mmm\\-yy;@', 'yyyy-mm-dd hh:mm', '[$-F800]dddd, mmmm dd, yyyy', 'm/d/yy']) {
      assert.equal(isDateFormatCode(code), true, code);
    }
    for (const code of ['General', '0.00', '#,##0.00;[Red]\\-#,##0.00', '"Rs." #,##0', '0.00 "days"', '[Red][<0]0;0', AMOUNT_FORMAT, '@', '0%']) {
      assert.equal(isDateFormatCode(code), false, code);
    }
  });

  it('names columns like Excel', () => {
    assert.deepEqual([0, 25, 26, 51, 52, 701, 702, 16383].map(columnName), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  });
});
