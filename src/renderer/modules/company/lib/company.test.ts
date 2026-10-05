import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gstinCheckChar } from '../../../../shared/gst/gstin.ts';
import { applyGstin, booksFromForFy, buildCreateInput, defaultDraft, draftFieldOfPath, firstInvalidStep, gstinError, stepOfPath, validateStep } from './companyForm.ts';
import type { CompanyDraft } from './companyForm.ts';
import { passwordPolicyError, passwordStrength, usernameError } from './password.ts';

const withCheck = (first14: string) => first14 + gstinCheckChar(first14);
const GSTIN_MH = withCheck('27AAPFU0939F1Z'); // Maharashtra, PAN AAPFU0939F

function valid(): CompanyDraft {
  return {
    ...defaultDraft('2026-10-05'),
    name: 'Sharma Traders',
    stateCode: '27',
    gstin: GSTIN_MH,
    pan: 'AAPFU0939F',
    ownerPassword: 'ledger2026',
    ownerPasswordConfirm: 'ledger2026',
  };
}

describe('password policy and strength', () => {
  test('policy mirrors the server', () => {
    assert.equal(passwordPolicyError('short1'), 'Use at least 8 characters');
    assert.equal(passwordPolicyError('abcdefgh'), 'Include at least one digit');
    assert.equal(passwordPolicyError('12345678'), 'Include at least one letter');
    assert.equal(passwordPolicyError(' abcdefg1'), 'Remove spaces at the start or end');
    assert.equal(passwordPolicyError('खाता2026बही'), null, 'Unicode letters count');
    assert.equal(passwordPolicyError('ledger2026'), null);
  });

  test('strength meter', () => {
    assert.equal(passwordStrength('abc').score, 0);
    assert.equal(passwordStrength('password1').score, 1, 'common word');
    assert.equal(passwordStrength('sharma2026', ['Sharma Traders']).score, 1, 'company name');
    const ok = passwordStrength('ledger2026');
    assert.ok(ok.acceptable && ok.score >= 1 && ok.score <= 2);
    assert.equal(passwordStrength('Monsoon-Ledger-77-Pune!').score, 4);
    assert.ok(passwordStrength('abcd5678x').tips.some((t) => /sequences/.test(t)));
  });

  test('username rules', () => {
    assert.equal(usernameError('ab'), 'Use at least 3 characters');
    assert.match(usernameError('-owner') ?? '', /letters, digits/);
    assert.equal(usernameError('ramesh.k'), null);
  });
});

describe('company wizard model', () => {
  test('defaults: April FY, books from the start of the current FY, protected', () => {
    const d = defaultDraft('2026-10-05');
    assert.equal(d.fyStartMonth, 4);
    assert.equal(d.booksFrom, '2026-04-01');
    assert.equal(defaultDraft('2027-02-10').booksFrom, '2026-04-01');
    assert.equal(booksFromForFy('2026-10-05', 1), '2026-01-01');
    assert.equal(d.secure, true);
    assert.equal(d.features.inventory, true);
  });

  test('a valid GSTIN fills the state and PAN', () => {
    const d = applyGstin(defaultDraft('2026-10-05'), ` ${GSTIN_MH.toLowerCase()} `);
    assert.equal(d.gstin, GSTIN_MH);
    assert.equal(d.stateCode, '27');
    assert.equal(d.pan, 'AAPFU0939F');
    const partial = applyGstin(defaultDraft('2026-10-05'), '27AAPF');
    assert.equal(partial.stateCode, '');
  });

  test('GSTIN errors are specific', () => {
    assert.match(gstinError('', '27', 'regular') ?? '', /required/);
    assert.equal(gstinError('', '27', 'unregistered'), null);
    assert.match(gstinError('27AAPFU0939F1Z', '27', 'regular') ?? '', /15 characters/);
    assert.match(gstinError(GSTIN_MH, '29', 'composition') ?? '', /belongs to state 27/);
    const typo = GSTIN_MH.slice(0, 14) + (GSTIN_MH[14] === 'A' ? 'B' : 'A');
    assert.match(gstinError(typo, '27', 'regular') ?? '', /check character/);
  });

  test('step validation', () => {
    const d = valid();
    for (const s of ['business', 'gst', 'books', 'features', 'security', 'review'] as const) assert.deepEqual(validateStep(s, d), {}, s);
    assert.ok(validateStep('business', { ...d, name: ' ' }).name);
    assert.ok(validateStep('business', { ...d, pincode: '012345' }).pincode);
    assert.ok(validateStep('business', { ...d, email: 'x@' }).email);
    assert.ok(validateStep('gst', { ...d, pan: 'AAAAA1111A' }).pan, 'PAN must match GSTIN');
    assert.ok(validateStep('security', { ...d, ownerPasswordConfirm: 'other' }).ownerPasswordConfirm);
    assert.deepEqual(validateStep('security', { ...d, secure: false, ownerPassword: '' }), {});
    assert.equal(firstInvalidStep({ ...d, gstin: '' }), 'gst');
    assert.equal(firstInvalidStep(d), null);
  });

  test('buildCreateInput', () => {
    const input = buildCreateInput({ ...valid(), mailingName: '  ', address: 'Shop 4, MG Road\nPune' });
    assert.equal(input.mailingName, undefined);
    assert.equal(input.address, 'Shop 4, MG Road\nPune');
    assert.equal(input.features?.gst, true);
    assert.deepEqual(input.owner, { username: 'owner', displayName: undefined, password: 'ledger2026' });

    const unreg = buildCreateInput({ ...valid(), gstRegistrationType: 'unregistered', features: { einvoice: true, inventory: false, batches: true } });
    assert.equal(unreg.gstin, undefined);
    assert.equal(unreg.features?.gst, false);
    assert.equal(unreg.features?.einvoice, false);
    assert.equal(unreg.features?.batches, false);
    assert.equal(buildCreateInput({ ...valid(), secure: false }).owner, undefined);
  });

  test('server error paths map to steps and fields', () => {
    assert.equal(stepOfPath('owner.password'), 'security');
    assert.equal(stepOfPath('gstin'), 'gst');
    assert.equal(stepOfPath('booksFrom'), 'books');
    assert.equal(stepOfPath('features.gst'), 'features');
    assert.equal(stepOfPath('name'), 'business');
    assert.equal(draftFieldOfPath('owner.password'), 'ownerPassword');
    assert.equal(draftFieldOfPath('stateCode'), 'stateCode');
  });
});
