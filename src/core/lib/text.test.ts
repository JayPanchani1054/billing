import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from './errors.ts';
import { FileFormatError, decodeText, encodeUtf8WithBom, positionAt, stripBom } from './text.ts';
import { REQUEST_TAG } from '../modules/data/xmlFormat.ts';

const utf16le = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf16le'));
const utf16be = (s: string): Uint8Array => {
  const le = utf16le(s);
  const be = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
};

describe('decodeText', () => {
  it('decodes UTF-8 with and without BOM (₹ and Devanagari intact)', () => {
    const s = 'Ram & Sons ₹1,250 — राम';
    const plain = decodeText(new TextEncoder().encode(s));
    assert.deepEqual(plain, { text: s, encoding: 'utf-8', bom: false });
    const withBom = decodeText(encodeUtf8WithBom(s));
    assert.deepEqual(withBom, { text: s, encoding: 'utf-8', bom: true });
  });

  it('decodes UTF-16LE and UTF-16BE with a BOM', () => {
    const s = '<ENVELOPE>₹ राम</ENVELOPE>';
    const le = decodeText(new Uint8Array([0xff, 0xfe, ...utf16le(s)]));
    assert.deepEqual(le, { text: s, encoding: 'utf-16le', bom: true });
    const be = decodeText(new Uint8Array([0xfe, 0xff, ...utf16be(s)]));
    assert.deepEqual(be, { text: s, encoding: 'utf-16be', bom: true });
  });

  it('detects BOM-less UTF-16LE (Tally export) and UTF-16BE from NUL byte positions', () => {
    const xml = `<ENVELOPE><HEADER><${REQUEST_TAG}>Import Data</${REQUEST_TAG}></HEADER></ENVELOPE>`;
    assert.deepEqual(decodeText(utf16le(xml)), { text: xml, encoding: 'utf-16le', bom: false });
    assert.deepEqual(decodeText(utf16be(xml)), { text: xml, encoding: 'utf-16be', bom: false });
    // Mostly non-Latin UTF-16LE with ASCII markup is still detected.
    const hindi = '<NAME>राम श्याम ट्रेडर्स</NAME>';
    assert.equal(decodeText(utf16le(hindi)).text, hindi);
  });

  it('falls back to Windows-1252 for invalid UTF-8 (smart quotes, euro, accents)', () => {
    const bytes = new Uint8Array([0x93, 0x48, 0x69, 0x94, 0x20, 0x80, 0x35, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x96, 0x97]);
    assert.deepEqual(decodeText(bytes), { text: '“Hi” €5 café–—', encoding: 'windows-1252', bom: false });
  });

  it('handles empty and tiny inputs', () => {
    assert.deepEqual(decodeText(new Uint8Array(0)), { text: '', encoding: 'utf-8', bom: false });
    assert.deepEqual(decodeText(new Uint8Array([0x41])), { text: 'A', encoding: 'utf-8', bom: false });
    assert.deepEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf])), { text: '', encoding: 'utf-8', bom: true });
  });
});

describe('encodeUtf8WithBom / stripBom', () => {
  it('prefixes exactly one BOM', () => {
    const bytes = encodeUtf8WithBom('﻿a₹');
    assert.deepEqual([...bytes], [0xef, 0xbb, 0xbf, 0x61, 0xe2, 0x82, 0xb9]);
    assert.equal(stripBom('﻿abc'), 'abc');
    assert.equal(stripBom('abc'), 'abc');
  });
});

describe('positionAt / FileFormatError', () => {
  it('computes 1-based line/column across LF, CRLF and CR line ends', () => {
    const text = 'ab\ncd\r\nef\rgh';
    assert.deepEqual(positionAt(text, 0), { line: 1, column: 1 });
    assert.deepEqual(positionAt(text, 4), { line: 2, column: 2 });
    assert.deepEqual(positionAt(text, 7), { line: 3, column: 1 });
    assert.deepEqual(positionAt(text, 11), { line: 4, column: 2 });
  });

  it('is a VALIDATION AppError carrying the position', () => {
    const err = new FileFormatError('xml', 'Bad tag', { line: 3, column: 7 });
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'VALIDATION');
    assert.equal(err.message, 'Bad tag (line 3, column 7)');
    assert.equal(err.line, 3);
    assert.equal(err.column, 7);
    assert.equal(err.format, 'xml');
    assert.deepEqual(err.toPayload().details, [{ path: 'file', message: 'Bad tag (line 3, column 7)' }]);
  });
});
