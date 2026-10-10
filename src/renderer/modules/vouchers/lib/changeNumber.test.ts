import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherNumberCheckResult } from '../../../../shared/types/vouchers.ts';
import {
  changeNumberAvailability,
  changeNumberTitle,
  continueSeriesState,
  isGstDocType,
  numberMessage,
  numberNoun,
  overrideOf,
  renumberedText,
} from './changeNumber.ts';

const ok = (over: Partial<VoucherNumberCheckResult> = {}): VoucherNumberCheckResult => ({ ok: true, taken: false, problems: [], seq: null, scopeLabel: 'FY 2026-27', ...over });
const SCHEME = { prefix: 'INV/{FY}/', suffix: null, width: 4 };

describe('Change Number dialog: the live message under "New number"', () => {
  it('an empty box explains what may be typed (GST documents: the Rule 46 format)', () => {
    assert.deepEqual(numberMessage('  ', null, true, null), { tone: 'neutral', text: "Up to 16 letters, digits, '/' or '-'.", canAccept: false });
    assert.equal(numberMessage('', null, false, null).text, 'Type the new number.');
  });

  it('the current number is not a change', () => {
    assert.deepEqual(numberMessage(' INV/26-27/0042 ', 'INV/26-27/0042', true, null), { tone: 'neutral', text: 'This is the current number.', canAccept: false });
  });

  it('format problems show at once (the shared texts), before any server answer', () => {
    const long = numberMessage('INV/2026-27/000141', null, true, null);
    assert.equal(long.tone, 'danger');
    assert.match(long.text, /at most 16 characters; this one has 18/);
    assert.equal(long.canAccept, false);
    assert.match(numberMessage('INV 141', null, true, null).text, /only letters, digits, '\/' and '-' \(not a space\)/);
    // A voucher that is not a GST document may use spaces (1–60 characters).
    assert.equal(numberMessage('JV 141', null, false, null).text, 'Checking…');
  });

  it('waits for an answer about THIS number (a stale answer is never shown)', () => {
    const stale = { number: 'INV/26-27/0140', result: ok(), error: null };
    assert.deepEqual(numberMessage('INV/26-27/0141', null, true, stale), { tone: 'neutral', text: 'Checking…', canAccept: false });
  });

  it('available: "✓ Available in FY 2026-27 · 14 of 16 characters" and accept enabled', () => {
    const m = numberMessage('INV/26-27/0141', 'INV/26-27/0042', true, { number: 'INV/26-27/0141', result: ok({ seq: 141 }), error: null });
    assert.deepEqual(m, { tone: 'success', text: '✓ Available in FY 2026-27 · 14 of 16 characters', canAccept: true });
    // No character count for a voucher that is not a GST document.
    assert.equal(numberMessage('A-100', null, false, { number: 'A-100', result: ok({ scopeLabel: 'Apr 2026' }), error: null }).text, '✓ Available in Apr 2026');
  });

  it('taken in the scope, server problems and errors block accepting', () => {
    const taken = numberMessage('INV/26-27/0005', null, true, { number: 'INV/26-27/0005', result: ok({ ok: false, taken: true }), error: null });
    assert.deepEqual(taken, { tone: 'danger', text: 'INV/26-27/0005 is already used in FY 2026-27.', canAccept: false });
    const prob = numberMessage('A-1', null, true, { number: 'A-1', result: ok({ ok: false, problems: ['Something the server says.'] }), error: null });
    assert.deepEqual(prob, { tone: 'danger', text: 'Something the server says.', canAccept: false });
    const err = numberMessage('A-1', null, true, { number: 'A-1', result: null, error: 'Could not check the number.' });
    assert.deepEqual(err, { tone: 'danger', text: 'Could not check the number.', canAccept: false });
  });
});

describe('Change Number dialog: "Continue the series from here"', () => {
  const base = { method: 'automatic' as const, scheme: SCHEME, nextNumber: 'INV/26-27/0042', date: '2026-10-10', fyStartMonth: 4, noun: 'invoice' };

  it('enabled for a number in the series format above the counter; the label names the next number', () => {
    const s = continueSeriesState({ ...base, seq: 141 });
    assert.deepEqual(s, { enabled: true, label: 'Continue the series from here (next invoice will be INV/26-27/0142)', reason: undefined });
    // Equal to the next number: continuing is allowed (the series simply goes on from there).
    assert.equal(continueSeriesState({ ...base, seq: 42 }).enabled, true);
  });

  it('disabled below the counter (the series never goes back)', () => {
    const s = continueSeriesState({ ...base, seq: 7 });
    assert.equal(s.enabled, false);
    assert.equal(s.reason, 'The next invoice already gets INV/26-27/0042: the series never goes back.');
  });

  it('disabled when the number is not in the series format', () => {
    const s = continueSeriesState({ ...base, seq: null });
    assert.equal(s.enabled, false);
    assert.equal(s.reason, "Only a number in the series' format (like INV/26-27/0042) can continue the series.");
  });

  it('disabled for a manually numbered series', () => {
    const s = continueSeriesState({ ...base, method: 'manual', seq: 141 });
    assert.equal(s.enabled, false);
    assert.match(s.reason ?? '', /numbered by hand/);
    assert.equal(continueSeriesState({ ...base, scheme: null, seq: 141 }).enabled, false);
  });

  it('without a known next number a parsed number can continue', () => {
    assert.equal(continueSeriesState({ ...base, nextNumber: '', seq: 5 }).enabled, true);
  });
});

describe('Change Number: availability, texts and the override sent', () => {
  it('entry: needs "Change voucher numbers" and a numbered type', () => {
    assert.deepEqual(changeNumberAvailability({ where: 'entry', canRenumber: true, method: 'automatic' }), { hidden: false, disabled: false, hint: undefined });
    assert.equal(changeNumberAvailability({ where: 'entry', canRenumber: false, method: 'automatic' }).hidden, true);
    assert.equal(changeNumberAvailability({ where: 'entry', canRenumber: true, method: 'none' }).hidden, true);
    assert.equal(changeNumberAvailability({ where: 'entry', canRenumber: true, method: 'manual' }).hidden, false);
  });

  it('view: needs alter too; cancelled and e-invoiced vouchers say why it is greyed out', () => {
    assert.equal(changeNumberAvailability({ where: 'view', canRenumber: true, canAlter: false, method: 'automatic' }).hidden, true);
    assert.equal(changeNumberAvailability({ where: 'view', canRenumber: true, canAlter: true, method: null }).hidden, false, 'method unknown: offered, the server decides');
    const cancelled = changeNumberAvailability({ where: 'view', canRenumber: true, canAlter: true, method: 'automatic', isCancelled: true });
    assert.equal(cancelled.disabled, true);
    assert.match(cancelled.hint ?? '', /cancelled voucher keeps its number/);
    const irn = changeNumberAvailability({ where: 'view', canRenumber: true, canAlter: true, method: 'automatic', irnGenerated: true });
    assert.equal(irn.disabled, true);
    assert.match(irn.hint ?? '', /e-invoice \(IRN\)/);
  });

  it('nouns and titles', () => {
    assert.equal(changeNumberTitle('sales'), 'Change invoice number');
    assert.equal(numberNoun('credit_note'), 'credit note');
    assert.equal(numberNoun('journal'), 'voucher');
    assert.equal(isGstDocType('sales', true), true);
    assert.equal(isGstDocType('sales', false), false);
    assert.equal(isGstDocType('purchase', true), false);
  });

  it('the override is trimmed; reason and continueSeries only when given', () => {
    assert.deepEqual(overrideOf(' A-100 ', '  ', false), { number: 'A-100' });
    assert.deepEqual(overrideOf('A-100', ' Matching the paper bill book ', true), { number: 'A-100', reason: 'Matching the paper bill book', continueSeries: true });
    assert.equal(overrideOf('A', 'x'.repeat(300), false).reason?.length, 200);
  });

  it('toast after renumbering', () => {
    assert.equal(renumberedText('Sales', 'INV/26-27/0042', 'INV/26-27/0141'), 'Sales INV/26-27/0042 renumbered to INV/26-27/0141');
  });
});
