/**
 * "More details" auto-reveal of the Group and Voucher Type forms (lib/formReveal.ts). The real seeded books
 * are checked in coreContract.test.ts; this file pins the rule itself and that the two forms use it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { automaticAbbreviation, groupMoreRevealed, voucherTypeMoreRevealed, voucherTypeUsual } from './formReveal.ts';
import type { VoucherTypeRevealDraft } from './formReveal.ts';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');

const group = { alias: '', isSubledger: false, netBalances: false, usedForCalculation: false, sortOrder: 260 };

describe('group form', () => {
  it('the position every group gets from the books does not open it; its error does', () => {
    assert.equal(groupMoreRevealed(group, {}), false);
    assert.equal(groupMoreRevealed({ ...group, sortOrder: null }, {}), false);
    assert.equal(groupMoreRevealed(group, { sortOrder: 'Enter 0 to 9999' }), true);
  });

  it('an alias, a switch turned on or an error inside opens it', () => {
    assert.equal(groupMoreRevealed({ ...group, alias: 'SD' }, {}), true);
    assert.equal(groupMoreRevealed({ ...group, alias: '   ' }, {}), false);
    for (const k of ['isSubledger', 'netBalances', 'usedForCalculation'] as const) assert.equal(groupMoreRevealed({ ...group, [k]: true }, {}), true, k);
    assert.equal(groupMoreRevealed(group, { alias: 'The alias is the same as the name — leave it blank' }), true);
    // Errors of the always-visible fields do not.
    assert.equal(groupMoreRevealed(group, { name: 'Enter the group name' }), false);
  });
});

describe('voucher type form', () => {
  const vt = (patch: Partial<VoucherTypeRevealDraft> = {}): VoucherTypeRevealDraft => ({
    name: 'Cash Sales',
    alias: '',
    abbreviation: '',
    isActive: true,
    preventDuplicates: false,
    useEffectiveDate: false,
    allowZeroValue: false,
    optionalByDefault: false,
    narrationPerEntry: false,
    printAfterSave: false,
    config: { defaultLedgerId: null, printTitle: null, showMrp: null, showHsnSummary: null, printLayout: null },
    ...patch,
  });
  const builtIn = { name: 'Sales', isPredefined: true, abbreviation: 'Sale' };

  it('a new type, as the form starts it, keeps it closed', () => {
    assert.equal(voucherTypeMoreRevealed(vt(), {}, voucherTypeUsual(null, 'Cash Sales')), false);
  });

  it('what the books fill in is not a reason: their abbreviation, prevent duplicates, the default ledger, print layout', () => {
    assert.equal(automaticAbbreviation('  Export Sales Invoice '), 'Export Sal');
    const own = voucherTypeUsual({ name: 'Export Sales Invoice', isPredefined: false, abbreviation: 'Export Sal' }, 'Export Sales Invoice');
    assert.equal(voucherTypeMoreRevealed(vt({ name: 'Export Sales Invoice', abbreviation: 'Export Sal', preventDuplicates: true, config: { defaultLedgerId: 4 } }), {}, own), false);
    // Renamed later: the abbreviation the books gave from the old name is still theirs.
    const renamed = voucherTypeUsual({ name: 'Export Sales Invoice', isPredefined: false, abbreviation: 'Export Sal' }, 'Overseas Sales');
    assert.equal(voucherTypeMoreRevealed(vt({ name: 'Overseas Sales', abbreviation: 'Export Sal' }), {}, renamed), false);
    const sales = voucherTypeUsual(builtIn, 'Sales');
    assert.equal(voucherTypeMoreRevealed(vt({ name: 'Sales', abbreviation: 'Sale', preventDuplicates: true, config: { defaultLedgerId: 4, showHsnSummary: false, printLayout: { x: 1 } } }), {}, sales), false);
  });

  it('a choice someone made opens it', () => {
    const usual = voucherTypeUsual(null, 'Cash Sales');
    const cases: Array<[string, Partial<VoucherTypeRevealDraft>]> = [
      ['alias', { alias: 'CS' }],
      ['own abbreviation', { abbreviation: 'CSL' }],
      ['inactive', { isActive: false }],
      ['effective dates', { useEffectiveDate: true }],
      ['zero value', { allowZeroValue: true }],
      ['optional', { optionalByDefault: true }],
      ['narration per entry', { narrationPerEntry: true }],
      ['print after save', { printAfterSave: true }],
      ['print title', { config: { printTitle: 'Cash Memo' } }],
      ['do not print MRP', { config: { showMrp: false } }],
      ['default party', { config: { defaultPartyLedgerId: 7 } }],
    ];
    for (const [what, patch] of cases) assert.equal(voucherTypeMoreRevealed(vt(patch), {}, usual), true, what);
    // A built-in type with duplicates allowed is unusual; so is another abbreviation on it.
    const sales = voucherTypeUsual(builtIn, 'Sales');
    assert.equal(voucherTypeMoreRevealed(vt({ name: 'Sales', abbreviation: 'Sale', preventDuplicates: false }), {}, sales), true);
    assert.equal(voucherTypeMoreRevealed(vt({ name: 'Sales', abbreviation: 'Tax', preventDuplicates: true }), {}, sales), true);
  });

  it('an error inside opens it (config errors are nested); errors of the visible fields do not', () => {
    const usual = voucherTypeUsual(null, 'Cash Sales');
    assert.equal(voucherTypeMoreRevealed(vt(), { 'config.bankLedgerId': 'Choose a bank ledger' }, usual), true);
    assert.equal(voucherTypeMoreRevealed(vt(), { abbreviation: 'Too long' }, usual), true);
    assert.equal(voucherTypeMoreRevealed(vt(), { name: 'Enter the voucher type name', 'numbering.prefix': 'Too long' }, usual), false);
  });
});

describe('the forms use the rule', () => {
  it('Group and Voucher Type forms take their auto-reveal from lib/formReveal.ts', () => {
    const groups = read('GroupScreens.tsx');
    assert.match(groups, /const revealed = groupMoreRevealed\(d, errors\);/);
    assert.match(groups, /forceOpen=\{revealed\}/);
    const types = read('VoucherTypeScreens.tsx');
    assert.match(types, /const usual = useMemo\(\(\) => voucherTypeUsual\(original, d\.name\), \[original, d\.name\]\);/);
    assert.match(types, /const revealed = voucherTypeMoreRevealed\(d, errors, usual\);/);
    assert.match(types, /forceOpen=\{revealed\}/);
    for (const src of [groups, types]) assert.doesNotMatch(src, /shouldReveal\(/);
  });

  it('one template: the voucher type form lays its More details out as the ledger and group forms do (inline fields, plain section titles)', () => {
    const types = read('VoucherTypeScreens.tsx');
    assert.doesNotMatch(types, /<FieldGroup/);
    assert.doesNotMatch(types, /<Field (key=\{f\.key\} )?label=/, 'every field of the form is inline');
    for (const title of ['General', 'Behaviour', 'Defaults for new vouchers', 'Printing']) assert.match(types, new RegExp(`<h2 className="bx-acc-form__title">${title}</h2>`));
  });
});
