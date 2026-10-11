/**
 * (2.1, SPEC-21 §1.11) The words of the calm print screens: the Print Preview context run and state words,
 * the layout editor's group captions and "Always printed" line, the one-line "Before you print" text and
 * the printer item / dialog options.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activeNoteRow,
  alwaysPrintedText,
  ASK_EVERY_TIME,
  groupCaption,
  hiddenCount,
  mergeDocWarnings,
  previewContext,
  previewStateWords,
  printerItemLabel,
  printerName,
  printerOptions,
  printerTitle,
  warningsLine,
} from './calm.ts';

describe('Print Preview title row', () => {
  test('context run: "Sales 33 · Asha Retail"; no number, no party', () => {
    assert.equal(previewContext({ title: 'Sales', number: '33', party: { name: 'Asha Retail' } }), 'Sales 33 · Asha Retail');
    assert.equal(previewContext({ title: 'Journal', number: null, party: null }), 'Journal');
    assert.equal(previewContext({ title: 'Receipt Voucher', number: '25', party: { name: null } }), 'Receipt Voucher 25');
    assert.equal(previewContext({ title: 'Tax Invoice', number: '', party: { name: '' } }), 'Tax Invoice');
  });

  test('state words: Cancelled (danger) or Optional (warning) — never two coloured words', () => {
    const none = { cancelled: false, optional: false, einvoice: false, customized: false };
    assert.deepEqual(previewStateWords(none), []);
    assert.deepEqual(previewStateWords({ ...none, cancelled: true }), [{ text: 'Cancelled', tone: 'danger' }]);
    assert.deepEqual(previewStateWords({ ...none, optional: true }), [{ text: 'Optional', tone: 'warning' }]);
    const all = previewStateWords({ cancelled: true, optional: true, einvoice: true, customized: true });
    assert.deepEqual(
      all.map((w) => w.text),
      ['Cancelled', 'Optional', 'e-Invoice', 'Customized for this print'],
    );
    assert.equal(all.filter((w) => w.tone !== null).length, 1, 'at most one coloured word');
    assert.equal(all[0].tone, 'danger', 'the legal state wins');
    assert.deepEqual(previewStateWords({ ...none, einvoice: true, customized: true }).map((w) => w.tone), [null, null]);
  });
});

describe('Customize what prints', () => {
  const row = (shown: boolean, locked = false) => ({ shown, locked });

  test('group caption: the label alone, "· n hidden" only when something is hidden (no "n of m shown")', () => {
    assert.equal(groupCaption('Header', [row(true), row(true), row(true, true)]), 'Header');
    assert.equal(groupCaption('Header', [row(false), row(true), row(false)]), 'Header · 2 hidden');
    assert.equal(groupCaption('Payment', [row(false)]), 'Payment · 1 hidden');
    assert.equal(groupCaption('Item columns', []), 'Item columns');
    assert.doesNotMatch(groupCaption('Header', [row(false), row(true)]), /of \d+ shown/);
  });

  test('a locked part always prints: never counted hidden', () => {
    assert.equal(hiddenCount([row(false, true), row(true, true)]), 0);
    assert.equal(hiddenCount([row(false, true), row(false)]), 1);
  });

  test('the notes row: keyboard focus and click-to-select move it; a mouse press never does, its click does', () => {
    // Tab to "Logo": its notes show.
    let row = activeNoteRow(null, { type: 'focus', row: 'logo', pointerDown: false });
    assert.equal(row, 'logo');
    // Mouse press on "Bank details" further down: the focus moves with the button still down — the notes of
    // "Logo" must stay, or the rows below it slide up under the pointer before the release.
    row = activeNoteRow(row, { type: 'focus', row: 'bank', pointerDown: true });
    assert.equal(row, 'logo', 'a press does not move the rows');
    // The release completes the click on "Bank details": now its notes show.
    row = activeNoteRow(row, { type: 'click', row: 'bank' });
    assert.equal(row, 'bank');
    // A part clicked in the preview focuses its switch after the click (no button down).
    row = activeNoteRow(row, { type: 'focus', row: 'title', pointerDown: false });
    assert.equal(row, 'title');
    // Esc back to the preview: no notes stay out.
    assert.equal(activeNoteRow(row, { type: 'leave' }), null);
  });

  test('locked parts collapse to one line', () => {
    assert.equal(alwaysPrintedText(['Invoice no.', 'Date', 'Grand total']), 'Always printed: Invoice no., Date, Grand total');
    assert.equal(alwaysPrintedText([]), '');
  });
});

describe('"Before you print" is one line', () => {
  test('every warning, in order, joined by " · "; blanks dropped; none → empty (no banner)', () => {
    const w1 = 'HSN/SAC codes — required on a tax invoice (Rule 46(g))';
    const w2 = 'Line 2 is billed above its MRP';
    assert.equal(warningsLine([w1]), w1);
    assert.equal(warningsLine([w1, ' ', w2]), `${w1} · ${w2}`);
    assert.equal(warningsLine([]), '');
    assert.doesNotMatch(warningsLine([w1, w2]), /\n/);
  });
});

describe('Print Vouchers: one entry per warning text', () => {
  const rule = 'HSN/SAC codes — required on a tax invoice (Rule 46(g))';
  const mrp = 'Line 2 is billed above its MRP';

  test('the same warning on many documents is named once, with every document; first-seen order', () => {
    assert.deepEqual(
      mergeDocWarnings([
        { label: 'Sales 33', warnings: [rule] },
        { label: 'Sales 34', warnings: [mrp, rule] },
        { label: 'Sales 35', warnings: [rule, ' '] },
      ]),
      [`Sales 33, Sales 34, Sales 35: ${rule}`, `Sales 34: ${mrp}`],
    );
  });

  test('a document without a number has no stray space; no label → the warning alone; nothing → nothing', () => {
    assert.deepEqual(mergeDocWarnings([{ label: 'Journal ', warnings: [mrp] }]), [`Journal: ${mrp}`]);
    assert.deepEqual(mergeDocWarnings([{ label: '', warnings: [mrp] }]), [mrp]);
    assert.deepEqual(mergeDocWarnings([{ label: 'Sales 1', warnings: [] }]), []);
    assert.deepEqual(mergeDocWarnings([{ label: 'Sales 1', warnings: [rule, rule] }]), [`Sales 1: ${rule}`], 'a document is named once');
  });
});

describe('Printer (More › "Printer: …")', () => {
  const printers = [
    { name: 'HP_LaserJet', displayName: 'HP LaserJet' },
    { name: 'TVS_RP3160', displayName: 'TVS RP 3160' },
  ];

  test('the item names the printer in use; a roll says "Receipt printer"', () => {
    assert.equal(printerItemLabel('', null, false), `Printer: ${ASK_EVERY_TIME}…`);
    assert.equal(printerItemLabel('HP_LaserJet', printers, false), 'Printer: HP LaserJet…');
    assert.equal(printerItemLabel('TVS_RP3160', printers, true), 'Receipt printer: TVS RP 3160…');
    assert.equal(printerItemLabel('Gone_Printer', printers, false), 'Printer: Gone_Printer…', 'a saved printer no longer installed is named as saved');
    assert.equal(printerTitle(true), 'Receipt printer');
    assert.equal(printerTitle(false), 'Printer');
    assert.equal(printerName('', printers), 'Ask every time');
  });

  test('options: ask every time first, the installed printers, then a saved one no longer listed', () => {
    assert.deepEqual(printerOptions('', null), [{ value: '', label: 'Ask every time (printer dialog)' }]);
    assert.deepEqual(
      printerOptions('HP_LaserJet', printers).map((o) => o.value),
      ['', 'HP_LaserJet', 'TVS_RP3160'],
    );
    assert.deepEqual(printerOptions('Gone_Printer', printers).at(-1), { value: 'Gone_Printer', label: 'Gone_Printer' });
  });
});
