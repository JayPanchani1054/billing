/**
 * Security review (final wave): the attachment content check (store.ts contentProblem), which the core
 * runs when a file is attached and Electron main runs again before a copy is opened in another program.
 *   - XML: a namespace written with character references, or defaulted by a DTD (<!ATTLIST>), is still
 *     a web page to the browser that opens .xml files;
 *   - Office / OpenDocument: Excel 4.0 macro sheets, ActiveX controls and OpenDocument Basic / script
 *     macros run code just like VBA.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentTypeOf } from '../../../shared/attachments.ts';
import { contentProblem } from './store.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** A minimal ZIP local-file header (PK\3\4 + fixed fields) followed by the part name. */
const zipWith = (...names: string[]): Uint8Array => {
  const parts: number[] = [];
  for (const n of names) parts.push(0x50, 0x4b, 0x03, 0x04, ...new Array<number>(26).fill(0), ...enc(n), 0x00);
  return new Uint8Array(parts);
};

describe('attachments: content check against active content', () => {
  const xml = attachmentTypeOf('einvoice.xml')!;

  it('refuses an XML web page whose namespace is written with character references or defaulted by a DTD', () => {
    for (const page of [
      '<?xml version="1.0"?><html xmlns="&#104;ttp://www.w3.org/1999/xhtml"><body onload="x()">bill</body></html>',
      '<?xml version="1.0"?><h:html xmlns:h="&#x68;&#x74;tp://www.w3.org/1999/xhtml"><h:body/></h:html>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/&#115;vg"><a/></svg>',
      '<?xml version="1.0"?><!DOCTYPE html [<!ATTLIST html xmlns CDATA #FIXED "http://www.w3.org/1999/xhtml">]><html><body/></html>',
    ]) {
      assert.match(contentProblem(xml, enc(page)) ?? '', /could run when opened/, page);
    }
  });

  it('still accepts plain data XML with character references and escaped text', () => {
    for (const data of [
      '<?xml version="1.0"?><Invoice><Irn>abc</Irn><Note>A &amp; B &#8377; 100 &#x20B9;</Note></Invoice>',
      '<?xml version="1.0"?><Bill><Remark>&lt;script&gt; is just text here</Remark></Bill>',
    ]) {
      assert.equal(contentProblem(xml, enc(data)), null, data);
    }
  });

  it('refuses Office / OpenDocument files with macro sheets, ActiveX controls or Basic / script macros', () => {
    const xlsx = attachmentTypeOf('book.xlsx')!;
    const docx = attachmentTypeOf('letter.docx')!;
    const ods = attachmentTypeOf('sheet.ods')!;
    const odt = attachmentTypeOf('text.odt')!;
    assert.equal(contentProblem(xlsx, zipWith('[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml')), null);
    assert.equal(contentProblem(ods, zipWith('mimetype', 'content.xml', 'styles.xml')), null);
    const cases: Array<[typeof xlsx, Uint8Array]> = [
      [xlsx, zipWith('[Content_Types].xml', 'xl/workbook.xml', 'xl/vbaProject.bin')],
      [xlsx, zipWith('[Content_Types].xml', 'xl/workbook.xml', 'xl/macrosheets/sheet1.xml')],
      [docx, zipWith('[Content_Types].xml', 'word/document.xml', 'word/activeX/activeX1.xml', 'word/activeX/activeX1.bin')],
      [ods, zipWith('mimetype', 'content.xml', 'Basic/Standard/Module1.xml', 'Basic/script-lc.xml')],
      [odt, zipWith('mimetype', 'content.xml', 'Scripts/python/run.py')],
    ];
    for (const [type, bytes] of cases) assert.match(contentProblem(type, bytes) ?? '', /macros or ActiveX/, type.ext);
  });
});
