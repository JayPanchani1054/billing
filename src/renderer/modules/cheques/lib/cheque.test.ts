import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequeLayoutSpec } from '../../../../shared/types/cheques.ts';
import { buildChequeHtml, calibrationMarks, charsThatFit, chequeCss, chequeMarks, chequePage, fitFontPt, mixedLayouts, selectedCheques, splitWords } from './cheque.ts';

const SPEC: ChequeLayoutSpec = {
  widthMm: 202,
  heightMm: 92,
  fontPt: 11,
  date: { x: 158, y: 9, pitch: 4.9 },
  payee: { x: 22, y: 21, w: 150 },
  words: { x: 33, y: 30, w: 122 },
  words2: { x: 10, y: 38, w: 140 },
  figures: { x: 160, y: 35, w: 36 },
  acPayee: { x: 8, y: 4, w: 30 },
  signatory: { x: 140, y: 60, w: 58 },
  offsetX: 0,
  offsetY: 0,
  placement: 'leaf',
  figuresPaise: true,
};

const ITEM = {
  dateDigits: '15042026',
  payee: 'Supreme Suppliers Private Limited',
  amountWords: 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only',
  amountFigures: '**12,34,567.89/-',
  acPayee: true,
  companyName: 'Acme Traders',
  signatory: 'Authorised Signatory',
};

describe('cheque geometry', () => {
  it('pages: the leaf itself, or the leaf at the top-left / top-centre of A4', () => {
    assert.deepEqual(chequePage(SPEC), { native: { pageSize: 'custom', customPageMm: { width: 202, height: 92 }, margins: 'none' }, widthMm: 202, heightMm: 92, leftMm: 0, topMm: 0 });
    // (210 − 202) / 2 = 4 mm
    assert.equal(chequePage({ ...SPEC, placement: 'a4_center' }).leftMm, 4);
    assert.deepEqual(chequePage({ ...SPEC, placement: 'a4_left' }).native, { pageSize: 'A4', margins: 'none' });
  });

  it('date digits go in eight boxes, pitch apart, shifted by the calibration offsets', () => {
    const { marks } = chequeMarks(ITEM, { ...SPEC, offsetX: 1.5, offsetY: -0.5 });
    const digits = marks.filter((m) => m.kind === 'digit');
    assert.deepEqual(digits.map((m) => m.text).join(''), '15042026');
    assert.deepEqual(digits.map((m) => m.x), [159.5, 164.4, 169.3, 174.2, 179.1, 184, 188.9, 193.8]);
    assert.equal(digits[0].y, 8.5);
    const payee = marks.find((m) => m.key === 'payee');
    assert.deepEqual([payee?.x, payee?.y, payee?.bold], [23.5, 20.5, true]);
  });

  it('amount in words wraps on whole words; long payees are shrunk to fit; crossing only when asked', () => {
    // 11 pt: a glyph ≈ 11 × 0.3528 × 0.5 = 1.94 mm → 122 mm holds 62 characters.
    assert.equal(charsThatFit(122, 11), 62);
    const s = splitWords(ITEM.amountWords, 122, 140, 11);
    assert.equal(s.line1, 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and');
    assert.equal(s.line2, 'Eighty Nine Paise Only');
    assert.equal(s.overflow, false);
    assert.equal(splitWords('a '.repeat(200).trim(), 20, 20, 11).overflow, true);
    assert.equal(fitFontPt('Short', 150, 11), 11);
    assert.ok(fitFontPt('X'.repeat(200), 150, 11) < 11);
    assert.equal(fitFontPt('X'.repeat(2000), 150, 11), 7, 'never below 7 pt');
    const { marks } = chequeMarks({ ...ITEM, acPayee: false }, SPEC);
    assert.equal(marks.some((m) => m.kind === 'crossing'), false);
    assert.ok(chequeMarks(ITEM, SPEC).marks.some((m) => m.kind === 'crossing' && m.text === 'A/c Payee'));
  });

  it('calibration sheet: grid, leaf outline and a box per field', () => {
    const marks = calibrationMarks(SPEC);
    assert.equal(marks.filter((m) => m.kind === 'rule').length, 21 + 10, '0–200 mm every 10 (21) + 0–90 mm (10)');
    assert.ok(marks.some((m) => m.key === 'leaf' && m.w === 202 && m.h === 92));
    assert.deepEqual(marks.filter((m) => m.kind === 'box' && m.key.startsWith('d')).map((m) => m.text).join(''), 'DDMMYYYY');
  });
});

describe('cheque document', () => {
  it('is a self-contained page of the leaf size, edge to edge, no raw colours', () => {
    const html = buildChequeHtml({ title: 'Cheque <1>', body: '<div class="cq-docs"><div class="cq-page"></div></div>', spec: SPEC });
    assert.match(html, /@page \{ size: 202mm 92mm; margin: 0; \}/);
    assert.match(html, /<title>Cheque &lt;1&gt;<\/title>/);
    assert.match(chequeCss({ ...SPEC, placement: 'a4_center' }), /@page \{ size: 210mm 297mm; margin: 0; \}/);
    assert.doesNotMatch(chequeCss(SPEC), /#[0-9a-f]{3,8}\b|\brgba?\(/i);
    assert.doesNotMatch(chequeCss(SPEC, false), /@page|html, body/, 'the preview never restyles the app page');
    assert.throws(() => buildChequeHtml({ title: 'x', body: '<script></script>', spec: SPEC }));
  });

  it('selection helpers', () => {
    const items = [{ key: 'a' }, { key: 'b' }];
    assert.deepEqual(selectedCheques(items, new Set(['a'])), [{ key: 'b' }]);
    assert.deepEqual(mixedLayouts([{ layoutName: 'A', spec: SPEC }, { layoutName: 'A', spec: SPEC }]), []);
    assert.deepEqual(mixedLayouts([{ layoutName: 'A', spec: SPEC }, { layoutName: 'B', spec: { ...SPEC, fontPt: 10 } }]), ['A', 'B']);
  });
});
