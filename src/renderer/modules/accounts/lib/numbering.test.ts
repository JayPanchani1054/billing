import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherNumbering } from '../../../../shared/types/accounts.ts';
import { GST_DOC_NUMBER_MAX_LENGTH as SHARED_MAX, GST_NUMBERED_BASE_TYPES } from '../../../../shared/numbering.ts';
import type { VoucherTypeRow } from '../../../../shared/types/accounts.ts';
import {
  badCharacters,
  buildSeriesRows,
  checkNumbering,
  confirmWarningsOf,
  defaultLedgerSide,
  DIGIT_OPTIONS,
  draftFromNumbering,
  draftNumbering,
  formatNumber,
  fyUniquenessNote,
  gapsSummary,
  GST_DOC_NUMBER_MAX_LENGTH,
  gstValidText,
  GST_DOCUMENT_BASE_TYPES,
  insertToken,
  lengthNote,
  monthFix,
  newSeriesNumbering,
  newTypeNumbering,
  nextNumberProblem,
  nextNumberToSet,
  numberingPatch,
  numberLength,
  numberingPreview,
  previewNextSeq,
  restartForMonthly,
  restartForSwitch,
  restartLabel,
  restartText,
  seriesClashes,
  seriesClashWarning,
  seriesNameProblem,
  seriesPreview,
  SIMPLE_METHOD_OPTIONS,
  METHOD_OPTIONS,
  tokenChips,
  yearlySwitchOn,
} from './numbering.ts';

const n = (over: Partial<VoucherNumbering> = {}): VoucherNumbering => ({ method: 'automatic', prefix: null, suffix: null, start: 1, width: 0, restart: 'yearly', ...over });

describe('numbering preview', () => {
  it('formats prefix + zero-padded number + suffix (same as vouchers formatVoucherNumber)', () => {
    assert.equal(formatNumber(n({ prefix: 'INV/', suffix: '/26-27', width: 4 }), 7), 'INV/0007/26-27');
    assert.equal(formatNumber(n(), 12), '12');
  });

  it('live preview shows the first two numbers; none/manual → null', () => {
    assert.deepEqual(numberingPreview(n({ prefix: 'S-', start: 100 })), { first: 'S-100', second: 'S-101' });
    assert.equal(numberingPreview(n({ method: 'manual' })), null);
    assert.equal(numberingPreview(n({ method: 'none' })), null);
  });

  it('length meter: prefix 4 + max(width 4, start digits 1) + suffix 6 = 14', () => {
    assert.equal(numberLength(n({ prefix: 'INV/', suffix: '/26-27', width: 4 })), 14);
  });

  it('restart text', () => {
    assert.match(restartText('monthly'), /every month/);
    assert.match(restartText('yearly', '2027-28'), /2027-28/);
  });
});

describe('checkNumbering — GST invoice-number rules (mirror of core)', () => {
  it('bad characters are errors for GST documents of a GST company', () => {
    const r = checkNumbering('sales', n({ prefix: 'INV #' }), true);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].path, 'numbering.prefix');
    assert.match(r.errors[0].message, /a space, '#'/);
    assert.deepEqual(badCharacters('A_B.C'), ['_', '.']);
  });

  it('…and only warnings for other types or a non-GST company', () => {
    assert.equal(checkNumbering('payment', n({ prefix: 'PAY #' }), true).errors.length, 0);
    assert.equal(checkNumbering('payment', n({ prefix: 'PAY #' }), true).warnings.length, 1);
    assert.equal(checkNumbering('sales', n({ prefix: 'INV #' }), false).errors.length, 0);
  });

  it('17 characters is refused: prefix 10 + width 5 + suffix 2', () => {
    const r = checkNumbering('sales', n({ prefix: 'ABCDEFGHIJ', width: 5, suffix: '-X' }), true);
    assert.match(r.errors[0].message, /17 characters long/);
  });

  it('headroom under 6 digits warns with the last safe number', () => {
    // 16 − prefix 8 − suffix 3 = 5 digits of room → numbers exceed 16 characters after 99,999.
    const r = checkNumbering('sales', n({ prefix: 'INV/2627', suffix: '/MH' }), true);
    assert.equal(r.errors.length, 0);
    assert.match(r.warnings[0], /after no\. 99,999/);
  });

  it('monthly restart and no numbering are errors; manual warns', () => {
    assert.equal(checkNumbering('credit_note', n({ restart: 'monthly' }), true).errors[0].path, 'numbering.restart');
    assert.equal(checkNumbering('debit_note', n({ method: 'none' }), true).errors[0].path, 'numbering.method');
    const manual = checkNumbering('sales', n({ method: 'manual', restart: 'monthly' }), true);
    assert.equal(manual.errors.length, 0);
    assert.match(manual.warnings[0], /unique within the financial year/);
    // Purchase numbers are the supplier's: no GST rule.
    assert.deepEqual(checkNumbering('purchase', n({ restart: 'monthly' }), true), { errors: [], warnings: [] });
  });

  it('default ledger side per base type', () => {
    assert.equal(defaultLedgerSide('sales'), 'sales');
    assert.equal(defaultLedgerSide('debit_note'), 'purchase');
    assert.equal(defaultLedgerSide('payment'), null);
  });
});

describe('a new voucher type gets its own number series', () => {
  it('takes the parent\'s method, padding and restart but not its prefix, suffix or start (same as the core)', () => {
    const parent = n({ prefix: 'INV/', suffix: '/26', start: 500, width: 4, restart: 'never', method: 'automatic_override' });
    assert.deepEqual(newTypeNumbering(parent), { method: 'automatic_override', prefix: null, suffix: null, start: 1, width: 4, restart: 'never' });
    assert.deepEqual(newTypeNumbering(null), n());
  });

  const types = [
    { id: 1, name: 'Sales', baseType: 'sales' as const, isActive: true, numbering: n() },
    { id: 2, name: 'Export Sales', baseType: 'sales' as const, isActive: true, numbering: n({ prefix: 'EXP/' }) },
    { id: 3, name: 'Old Series', baseType: 'sales' as const, isActive: false, numbering: n({ prefix: 'CS/' }) },
    { id: 4, name: 'Credit Note', baseType: 'credit_note' as const, isActive: true, numbering: n() },
    { id: 5, name: 'Payment', baseType: 'payment' as const, isActive: true, numbering: n() },
  ];

  it('two automatic sales series without a prefix clash (both issue 1, 2, …)', () => {
    assert.deepEqual(seriesClashes(types, null, 'sales', n()), ['Sales']);
    const w = seriesClashWarning(['Sales'], n());
    assert.match(w ?? '', /“Sales” already numbers documents without a prefix, so both series would issue 1, 2/);
  });

  it('prefix compared without case; padding must match; own row, inactive types and other kinds ignored', () => {
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ prefix: 'exp/' })), ['Export Sales']);
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ prefix: 'EXP/', width: 4 })), []);
    assert.deepEqual(seriesClashes(types, 2, 'sales', n({ prefix: 'EXP/' })), []);
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ prefix: 'CS/' })), []);
    // Credit notes are a separate document kind; payments are not GST documents at all.
    assert.deepEqual(seriesClashes(types, null, 'credit_note', n({ prefix: 'EXP/' })), []);
    assert.deepEqual(seriesClashes(types, null, 'payment', n()), []);
    // Manual numbering issues nothing automatically.
    assert.deepEqual(seriesClashes(types, null, 'sales', n({ method: 'manual' })), []);
    assert.equal(seriesClashWarning([], n()), null);
  });
});

describe('tokens and dated rows in the form preview (dataplus)', () => {
  it('previews numbers for the working date and measures the longest expansion', () => {
    const scheme = n({ prefix: 'INV/{FY}/', width: 4, prefixRows: [{ applicableFrom: '2026-10-01', text: '{MMM}/' }] });
    assert.deepEqual(numberingPreview(scheme, '2026-09-01'), { first: 'INV/26-27/0001', second: 'INV/26-27/0002' });
    assert.deepEqual(numberingPreview(scheme, '2026-10-05'), { first: 'Oct/0001', second: 'Oct/0002' });
    assert.equal(numberLength(scheme), 4 + 5 + 1 + 4);
    assert.equal(checkNumbering('sales', n({ prefix: 'X/{BAD}/' }), true).errors.length, 1);
  });
});

// ───────────────────── 2.0: Invoice Numbering screen helpers ─────────────────────

describe('one source for the GST constants (no copies in the renderer)', () => {
  it('re-exports the shared list and length', () => {
    assert.equal(GST_DOCUMENT_BASE_TYPES, GST_NUMBERED_BASE_TYPES);
    assert.equal(GST_DOC_NUMBER_MAX_LENGTH, SHARED_MAX);
    assert.deepEqual(SIMPLE_METHOD_OPTIONS.map((o) => o.value), METHOD_OPTIONS.map((o) => o.value));
    assert.deepEqual(DIGIT_OPTIONS.map((o) => o.value), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    assert.equal(DIGIT_OPTIONS[4].label, '4 (0001)');
  });
});

describe('token chips insert at the caret', () => {
  it('chips name today\'s value of each token', () => {
    const chips = tokenChips('2026-10-10');
    assert.deepEqual(chips.map((c) => c.label), ['FY 26-27', '2026-27', 'YY', 'MM', 'Mon']);
    assert.deepEqual(chips.map((c) => c.token), ['{FY}', '{FYYYYY}', '{YY}', '{MM}', '{MMM}']);
    assert.match(chips[4].title, /^Insert \{MMM\} — .*Oct today$/);
    // The accessible name starts with the visible text (WCAG 2.5.3) and names the code it inserts.
    assert.deepEqual(chips.map((c) => c.name), ['FY 26-27 (insert {FY})', '2026-27 (insert {FYYYYY})', 'YY (insert {YY})', 'MM (insert {MM})', 'Mon (insert {MMM})']);
    for (const c of chips) assert.ok(c.name.startsWith(c.label), c.name);
  });

  it('inserts at the caret, replaces a selection, appends without a caret', () => {
    assert.deepEqual(insertToken('INV//', '{FY}', 4, 4), { text: 'INV/{FY}/', caret: 8 });
    assert.deepEqual(insertToken('INV/XX/', '{FY}', 4, 6), { text: 'INV/{FY}/', caret: 8 });
    assert.deepEqual(insertToken('INV/', '{MM}', null, null), { text: 'INV/{MM}', caret: 8 });
    assert.deepEqual(insertToken('', '{FY}', 5, 9), { text: '{FY}', caret: 4 });
    // A reversed or out-of-range selection is clamped.
    assert.deepEqual(insertToken('AB', '{YY}', 1, 0), { text: 'A{YY}B', caret: 5 });
  });

  it('refuses a prefix longer than 16 characters as typed', () => {
    assert.equal(insertToken('INV/{FYYYYY}/', '{MMM}', null, null), null);
    assert.ok(insertToken('INV/{FY}/', '{MM}', null, null));
  });
});

describe('restart switches', () => {
  it('switch on ⇒ yearly, off ⇒ never; every month ⇒ monthly, back ⇒ yearly', () => {
    assert.equal(restartForSwitch(true), 'yearly');
    assert.equal(restartForSwitch(false), 'never');
    assert.equal(restartForMonthly(true), 'monthly');
    assert.equal(restartForMonthly(false), 'yearly');
    assert.equal(yearlySwitchOn('yearly'), true);
    assert.equal(yearlySwitchOn('monthly'), true);
    assert.equal(yearlySwitchOn('never'), false);
    assert.equal(restartLabel(n()), 'Every financial year');
    assert.equal(restartLabel(n({ restart: 'never' })), 'Never');
    assert.equal(restartLabel(n({ method: 'none' })), '—');
  });

  it('turning yearly off on a GST series shows the FY-uniqueness note (not for other vouchers or without GST)', () => {
    assert.match(fyUniquenessNote('sales', n({ restart: 'never' }), true) ?? '', /unique within each financial year/);
    assert.equal(fyUniquenessNote('sales', n({ restart: 'yearly' }), true), null);
    assert.equal(fyUniquenessNote('payment', n({ restart: 'never' }), true), null);
    assert.equal(fyUniquenessNote('sales', n({ restart: 'never' }), false), null);
  });

  it('monthly restart on a GST series: one-click month fix only when it cures the problem', () => {
    assert.equal(monthFix('sales', n({ prefix: 'INV/{FY}/', restart: 'monthly' }), true), 'INV/{FY}/{MM}/');
    assert.equal(monthFix('sales', n({ prefix: 'INV', restart: 'monthly' }), true), 'INV/{MM}/');
    assert.equal(monthFix('sales', n({ restart: 'monthly' }), true), '{MM}/');
    // The fixed scheme passes the shared check.
    assert.deepEqual(checkNumbering('sales', n({ prefix: 'INV/{FY}/{MM}/', restart: 'monthly' }), true).errors, []);
    // Nothing to fix.
    assert.equal(monthFix('sales', n({ prefix: 'INV/{MM}/', restart: 'monthly' }), true), null);
    assert.equal(monthFix('sales', n({ prefix: 'INV/', restart: 'yearly' }), true), null);
    assert.equal(monthFix('payment', n({ prefix: 'PAY/', restart: 'monthly' }), true), null);
    // Too long to add, or a dated row without the month: fixed in the Voucher Type form instead.
    assert.equal(monthFix('sales', n({ prefix: 'ABCDEFGHIJKLM', restart: 'monthly' }), true), null);
    assert.equal(monthFix('sales', n({ prefix: 'INV/', restart: 'monthly', prefixRows: [{ applicableFrom: '2026-10-01', text: 'B/' }] }), true), null);
  });
});

describe('the list: invoices & notes first, then other vouchers', () => {
  const vt = (id: number, name: string, baseType: VoucherTypeRow['baseType'], numbering: VoucherNumbering = n()): VoucherTypeRow => ({
    id,
    guid: `g${id}`,
    name,
    alias: null,
    abbreviation: null,
    baseType,
    parentId: null,
    parentName: null,
    isPredefined: true,
    isActive: true,
    hotkey: null,
    numbering,
    voucherCount: 0,
  });
  const types = [vt(1, 'Payment', 'payment'), vt(2, 'Sales', 'sales', n({ prefix: 'INV/{FY}/', width: 4 })), vt(3, 'Journal', 'journal', n({ method: 'manual' })), vt(4, 'Credit Note', 'credit_note'), vt(5, 'Memo', 'memorandum', n({ method: 'none' }))];
  const statuses = [
    { id: 2, periodLabel: 'FY 2026-27', counter: 41, highestUsed: 41, nextSeq: 42, next: 'INV/26-27/0042', vouchersInPeriod: 41 },
    { id: 1, periodLabel: 'FY 2026-27', counter: 0, highestUsed: null, nextSeq: 1, next: '1', vouchersInPeriod: 0 },
  ];

  it('groups, order, examples, restarts and next numbers', () => {
    const rows = buildSeriesRows(types, statuses, '2026-10-10');
    assert.deepEqual(
      rows.map((r) => (r.kind === 'group' ? `[${r.label} ${r.count}]` : r.type.name)),
      ['[Invoices & notes 2]', 'Sales', 'Credit Note', '[Other vouchers 3]', 'Payment', 'Journal', 'Memo'],
    );
    const sales = rows.find((r) => r.kind === 'series' && r.type.id === 2);
    assert.ok(sales && sales.kind === 'series');
    assert.deepEqual([sales.example, sales.restarts, sales.next, sales.vouchers], ['INV/26-27/0001', 'Every financial year', 'INV/26-27/0042', 41]);
    const journal = rows.find((r) => r.kind === 'series' && r.type.id === 3);
    assert.ok(journal && journal.kind === 'series');
    assert.deepEqual([journal.example, journal.next], ['Typed by hand', 'Typed by hand']);
    const memo = rows.find((r) => r.kind === 'series' && r.type.id === 5);
    assert.ok(memo && memo.kind === 'series');
    assert.deepEqual([memo.example, memo.restarts, memo.next], ['—', '—', '—']);
    // A series without its status yet (still loading) shows a placeholder, never a wrong number.
    const credit = rows.find((r) => r.kind === 'series' && r.type.id === 4);
    assert.ok(credit && credit.kind === 'series');
    assert.equal(credit.next, '…');
    // Keys are unique (the grid's row keys).
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  });

  it('an empty group is left out', () => {
    assert.deepEqual(buildSeriesRows([types[0]], [], '2026-10-10').map((r) => r.key), ['group:other', '1']);
  });
});

describe('the editor draft', () => {
  const base = n({ prefix: 'INV/{FY}/', width: 4, prefixRows: [{ applicableFrom: '2027-04-01', text: 'B/{FY}/' }] });

  it('round-trips without changes: no patch, no next number to set', () => {
    const d = draftFromNumbering(base, 42);
    assert.deepEqual(d, { name: '', method: 'automatic', prefix: 'INV/{FY}/', suffix: '', width: 4, start: 1, restart: 'yearly', next: 42 });
    assert.equal(numberingPatch(base, d), null);
    assert.equal(nextNumberToSet(d, d), null);
    // Dated rows are kept in the scheme used for the preview, and never sent.
    assert.deepEqual(draftNumbering(base, d).prefixRows, base.prefixRows);
  });

  it('sends only the changed keys (key-level patch); empty text clears', () => {
    const d = { ...draftFromNumbering(base, 42), prefix: '', restart: 'never' as const, width: 5 };
    assert.deepEqual(numberingPatch(base, d), { prefix: null, width: 5, restart: 'never' });
    assert.deepEqual(numberingPatch(n(), { ...draftFromNumbering(n(), 1), suffix: '/MH', method: 'automatic_override' }), { method: 'automatic_override', suffix: '/MH' });
  });

  it('the next number is set only when changed, and only for automatic numbering', () => {
    const initial = draftFromNumbering(base, 42);
    assert.equal(nextNumberToSet({ ...initial, next: 41 }, initial), 41);
    assert.equal(nextNumberToSet({ ...initial, next: 41, method: 'manual' }, initial), null);
    assert.equal(draftFromNumbering(n({ method: 'manual' }), 7).next, null);
  });

  it('next number checks', () => {
    assert.equal(nextNumberProblem(41, 1), null);
    assert.match(nextNumberProblem(null, 1) ?? '', /whole number from 1 to 99,99,99,999/);
    assert.match(nextNumberProblem(0, 1) ?? '', /whole number/);
    assert.match(nextNumberProblem(1.5, 1) ?? '', /whole number/);
    assert.match(nextNumberProblem(1_000_000_000, 1) ?? '', /whole number/);
    assert.match(nextNumberProblem(5, 100) ?? '', /starts at 100/);
  });

  it('preview: today, the first number of the next financial year and the longest length (describeScheme)', () => {
    const p = seriesPreview(n({ prefix: 'INV/{FY}/', width: 4 }), '2026-10-10', 4, 42);
    assert.deepEqual(p, { today: { date: '2026-10-10', number: 'INV/26-27/0042' }, nextFy: { date: '2027-04-01', number: 'INV/27-28/0001' }, longest: 14, resetsOn: 'financial year' });
    assert.equal(seriesPreview(n({ method: 'manual' }), '2026-10-10'), null);
    assert.equal(lengthNote(14, true), 'longest 14 of 16 characters');
    assert.equal(lengthNote(14, false), 'longest 14 characters');
    // The draft's checks are the shared checks (same as the Voucher Type form and the core).
    assert.equal(checkNumbering('sales', draftNumbering(n(), { ...draftFromNumbering(n(), 1), prefix: 'INV #' }), true).errors.length, 1);
  });
});

describe('the preview shows the next number the core will give after the save', () => {
  const base = n({ prefix: 'INV/', width: 4 });
  const status = { counter: 41, nextSeq: 42 };

  it('unchanged → the series\' next number; a typed next number → that number', () => {
    const initial = draftFromNumbering(base, 42);
    assert.equal(previewNextSeq(initial, initial, status), 42);
    assert.equal(previewNextSeq({ ...initial, prefix: 'X/', width: 5 }, initial, status), 42);
    assert.equal(previewNextSeq({ ...initial, next: 100 }, initial, status), 100);
  });

  it('a higher starting number lifts the next number; a lower one stops holding it up', () => {
    const initial = draftFromNumbering(base, 42);
    assert.equal(previewNextSeq({ ...initial, start: 100 }, initial, status), 100);
    assert.equal(previewNextSeq({ ...initial, start: 10 }, initial, status), 42);
    // Start 500, nothing given out yet (counter 0): next 500. Back to start 1 → 1.
    const held = draftFromNumbering(n({ start: 500 }), 500);
    assert.equal(previewNextSeq({ ...held, start: 1 }, held, { counter: 0, nextSeq: 500 }), 1);
    assert.equal(previewNextSeq({ ...held, start: 600 }, held, { counter: 0, nextSeq: 500 }), 600);
  });

  it('after a restart change (or from manual to automatic) it is known only once saved', () => {
    const initial = draftFromNumbering(base, 42);
    assert.equal(previewNextSeq({ ...initial, restart: 'never' }, initial, status), null);
    assert.equal(previewNextSeq({ ...initial, restart: 'never', next: 7 }, initial, status), 7);
    const manual = draftFromNumbering(n({ method: 'manual' }), 42);
    assert.equal(previewNextSeq({ ...manual, method: 'automatic' }, manual, status), null);
    assert.equal(previewNextSeq(manual, manual, status), null);
    assert.equal(previewNextSeq(initial, initial, null), 42);
  });

  it('Create series: the parent\'s method, digits and restart, never its prefix, start or dated rows', () => {
    const parent = n({ method: 'automatic_override', prefix: 'INV/', suffix: '/X', start: 9, width: 4, restart: 'never', prefixRows: [{ applicableFrom: '2027-04-01', text: 'B/' }] });
    assert.deepEqual(newSeriesNumbering(parent), { method: 'automatic_override', prefix: null, suffix: null, start: 1, width: 4, restart: 'never' });
    assert.equal(gstValidText('sales'), 'Valid GST invoice number');
    assert.equal(gstValidText('credit_note'), 'Valid GST note number');
  });
});

describe('server answers', () => {
  it('confirm warnings: VoucherWarning objects or strings', () => {
    assert.deepEqual(confirmWarningsOf({ needsConfirmation: true, warnings: [{ code: 'numbering', message: 'Numbers 2–40 will not be issued' }, 'plain', { x: 1 }, ''] }), ['Numbers 2–40 will not be issued', 'plain']);
    assert.deepEqual(confirmWarningsOf(null), []);
    assert.deepEqual(confirmWarningsOf({ warnings: 'x' }), []);
  });

  it('gaps summary', () => {
    assert.equal(gapsSummary({ first: null, last: null, issued: 0, missing: [], missingCount: 0 }), 'No numbers issued yet this financial year.');
    assert.equal(gapsSummary({ first: 'INV/1', last: 'INV/9', issued: 9, missing: [], missingCount: 0 }), 'No gaps: every number from INV/1 to INV/9 was issued.');
    assert.equal(gapsSummary({ first: 'INV/1', last: 'INV/9', issued: 6, missing: ['INV/5', 'INV/6', 'INV/9'], missingCount: 3 }), '3 missing (INV/5, INV/6, INV/9)');
    assert.equal(gapsSummary({ first: 'A1', last: 'A1500', issued: 2, missing: ['A2', 'A3', 'A4', 'A5'], missingCount: 1498 }), '1,498 missing (A2, A3, A4, …)');
  });

  it('a new series needs a unique name', () => {
    assert.match(seriesNameProblem('  ', []) ?? '', /Enter a name/);
    assert.match(seriesNameProblem('sales', [{ name: 'Sales' }]) ?? '', /already a voucher type/);
    assert.match(seriesNameProblem('x'.repeat(61), []) ?? '', /at most 60/);
    assert.equal(seriesNameProblem('Cash Sales', [{ name: 'Sales' }]), null);
  });
});
