import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { marginsFor, pdfPageOptions, printPageOptions, resolvePageSpec, ROLL_MAX_HEIGHT_MM, ROLL_MIN_HEIGHT_MM, validPrinterName } from './printPage.ts';

describe('resolvePageSpec', () => {
  it('named sheets keep their size and orientation (A5 landscape = A5 + landscape)', () => {
    assert.deepEqual(resolvePageSpec(undefined, undefined, undefined), { kind: 'named', size: 'A4', landscape: false });
    assert.deepEqual(resolvePageSpec('A5', true, 999), { kind: 'named', size: 'A5', landscape: true });
    assert.deepEqual(resolvePageSpec('Legal', false, undefined), { kind: 'named', size: 'Legal', landscape: false });
    assert.deepEqual(resolvePageSpec('Letter', undefined, undefined), { kind: 'named', size: 'Letter', landscape: false });
  });

  it('rolls take the measured height, rounded up and clamped', () => {
    assert.deepEqual(resolvePageSpec('80mm', true, 123.2), { kind: 'roll', widthMm: 80, heightMm: 124 });
    assert.deepEqual(resolvePageSpec('58mm', undefined, 10), { kind: 'roll', widthMm: 58, heightMm: ROLL_MIN_HEIGHT_MM });
    assert.deepEqual(resolvePageSpec('58mm', undefined, 1e9), { kind: 'roll', widthMm: 58, heightMm: ROLL_MAX_HEIGHT_MM });
    assert.deepEqual(resolvePageSpec('80mm', undefined, undefined), { kind: 'roll', widthMm: 80, heightMm: 297 });
  });

  it('refuses impossible roll lengths', () => {
    assert.throws(() => resolvePageSpec('80mm', false, Number.NaN), /receipt length/);
    assert.throws(() => resolvePageSpec('80mm', false, -5), /receipt length/);
    assert.throws(() => resolvePageSpec('80mm', false, Number.POSITIVE_INFINITY), /receipt length/);
  });
});

describe('Electron page options', () => {
  it('printToPDF uses inches, print uses microns, rolls are never landscape', () => {
    const roll = resolvePageSpec('80mm', true, 254);
    // 80 mm / 25.4 = 3.1496 in; 254 mm = 10 in
    assert.deepEqual(pdfPageOptions(roll), { pageSize: { width: 3.1496, height: 10 }, landscape: false });
    assert.deepEqual(printPageOptions(roll), { pageSize: { width: 80_000, height: 254_000 }, landscape: false });
    const a5l = resolvePageSpec('A5', true, undefined);
    assert.deepEqual(pdfPageOptions(a5l), { pageSize: 'A5', landscape: true });
    assert.deepEqual(printPageOptions(a5l), { pageSize: 'A5', landscape: true });
  });

  it('rolls print without margins', () => {
    assert.equal(marginsFor(resolvePageSpec('58mm', false, 100), 'default'), 'none');
    assert.equal(marginsFor(resolvePageSpec('A4', false, undefined), 'minimum'), 'minimum');
  });
});

describe('validPrinterName', () => {
  it('accepts OS printer names and refuses control characters / oversize values', () => {
    assert.equal(validPrinterName('EPSON TM-T82 Receipt'), true);
    assert.equal(validPrinterName('\\\\server\\HP LaserJet'), true);
    assert.equal(validPrinterName(''), false);
    assert.equal(validPrinterName('bad\nname'), false);
    assert.equal(validPrinterName('x'.repeat(300)), false);
    assert.equal(validPrinterName(42), false);
  });
});

describe('custom pages (cheque leaves)', () => {
  it('takes a size in mm within limits, printed edge to edge', () => {
    const leaf = resolvePageSpec('custom', true, undefined, { width: 202, height: 92 });
    assert.deepEqual(leaf, { kind: 'custom', widthMm: 202, heightMm: 92 });
    assert.deepEqual(printPageOptions(leaf), { pageSize: { width: 202_000, height: 92_000 }, landscape: false });
    // 202 / 25.4 = 7.9528 in; 92 / 25.4 = 3.622 in
    assert.deepEqual(pdfPageOptions(leaf), { pageSize: { width: 7.9528, height: 3.622 }, landscape: false });
    assert.equal(marginsFor(leaf, 'default'), 'none');
    assert.throws(() => resolvePageSpec('custom', false, undefined, { width: 20, height: 92 }), /50–400 mm/);
    assert.throws(() => resolvePageSpec('custom', false, undefined, undefined), /Invalid paper size/);
    assert.throws(() => resolvePageSpec('custom', false, undefined, { width: '202', height: 92 }), /Invalid paper size/);
  });
});
