/**
 * V7 — R1 usability walk-through (2.0 verification): the five first-day tasks of a new owner (create a
 * company, add a customer and an item, make and print a GST invoice, record a payment, see who owes)
 * each have an obvious mouse path and a keyboard path, in plain words. The API side of the same day is
 * pinned by src/core/testing/e2e/first-day.test.ts; this file pins the renderer's words and entries the
 * walk-through found wrong or missing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classOfGroup, indexGroups, ledgerCreateSubtitle } from '../../modules/accounts/lib/groupClass.ts';
import { groupIdOf, predefinedTestGroups } from '../../modules/accounts/lib/testGroups.ts';
import { recommendedSummary } from '../../modules/company/lib/companyForm.ts';
import { createMenuGroups } from './createMenu.ts';
import { ESSENTIALS } from './essentials.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, '../..', rel), 'utf8');

describe('V7 — R1 walk-through', () => {
  test('every R1 task has a Create ▾ entry (mouse) and an Essentials entry (keyboard) on a new GST company', () => {
    const create = createMenuGroups({ voucherAvailable: () => true, canCreateVouchers: true, canCreateMasters: true, ledgerFormOpenable: true, itemFormOpenable: true, inventory: true })
      .flat()
      .map((i) => i.label);
    for (const label of ['Sales invoice', 'Receipt', 'Customer', 'Item']) assert.ok(create.includes(label), `Create ▾ › ${label}`);
    const essentials = ESSENTIALS.flatMap((g) => g.entries.map((e) => e.label ?? e.baseType));
    for (const entry of ['sales', 'receipt', 'Create Ledger', 'Create Stock Item', 'Receivables', 'Settings']) assert.ok(essentials.includes(entry), `Essentials › ${entry}`);
  });

  test('voucher entry: the primary button reads "Save" (SPEC §6.7 — "primary Save (Ctrl+A)"), not the jargon "Accept"', () => {
    const src = read('modules/vouchers/entry/VoucherEntryScreen.tsx');
    assert.match(src, /\{ key: 'Ctrl\+A', label: isAlter \? 'Save changes' : 'Save', icon: 'save', primary: true,/);
    assert.match(src, /\{isAlter \? 'Save changes' : 'Save'\}/, 'the footer button says the same');
    assert.ok(!/label: isAlter \? 'Save changes' : 'Accept'/.test(src));
    assert.match(src, /hint="Enter Next · Shift\+Enter Back · Ctrl\+A Save ·/);
  });

  test('Create ▾ › Customer / Supplier: Ledger Creation says in plain words what is being created', () => {
    const groups = predefinedTestGroups();
    const index = indexGroups(groups);
    const sub = (code: Parameters<typeof groupIdOf>[1]) => ledgerCreateSubtitle(classOfGroup(index, groupIdOf(groups, code)));
    assert.match(sub('SUNDRY_DEBTORS'), /^A new customer — .*Receivables\.$/);
    assert.match(sub('SUNDRY_CREDITORS'), /^A new supplier — .*Payables\.$/);
    assert.equal(sub('BANK_ACCOUNTS'), 'A ledger is an account: a customer, supplier, bank, expense, income or tax head.');
    assert.equal(ledgerCreateSubtitle(null), 'A ledger is an account: a customer, supplier, bank, expense, income or tax head.');
    assert.match(read('modules/accounts/LedgerFormScreen.tsx'), /: ledgerCreateSubtitle\(cls\);/);
  });

  test('"Create with recommended settings" points to Settings — the FY, books and password are not changed with F11 / F12', () => {
    const s = recommendedSummary('2026-10-10');
    assert.ok(!/F11|F12/.test(s), s);
    assert.match(s, /Change any of it later in Settings\.$/);
  });
});
