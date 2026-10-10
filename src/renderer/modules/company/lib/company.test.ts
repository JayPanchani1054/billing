import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gstinCheckChar } from '../../../../shared/gst/gstin.ts';
import { applyGstin, applyRecommended, booksFromForFy, buildCreateInput, defaultDraft, draftFieldOfPath, firstInvalidStep, gstinError, recommendedSummary, stepOfPath, validateStep, WIZARD_STEPS } from './companyForm.ts';
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

describe('create with recommended settings (2.0)', () => {
  const TODAY = '2026-10-05';

  test('steps 3–5 take their defaults; what the user typed on steps 1–2 stays', () => {
    const typed: CompanyDraft = { ...valid(), fyStartMonth: 1, booksFrom: '2026-01-01', features: { inventory: false, batches: true }, secure: false, ownerUsername: '', ownerPassword: '', ownerPasswordConfirm: '' };
    const r = applyRecommended(typed, TODAY);
    const def = defaultDraft(TODAY);
    assert.equal(r.fyStartMonth, 4);
    assert.equal(r.booksFrom, '2026-04-01');
    assert.deepEqual(r.features, def.features);
    assert.equal(r.secure, true, 'password protection on (the recommended choice)');
    assert.equal(r.ownerUsername, 'owner');
    for (const k of ['name', 'stateCode', 'gstin', 'pan', 'gstRegistrationType'] as const) assert.equal(r[k], typed[k]);
    // Only a password is missing before it can be created — the Review step asks for it inline.
    assert.equal(firstInvalidStep(r), 'security');
    assert.equal(firstInvalidStep({ ...r, secure: false }), null, 'or protection switched off: ready to create');
    assert.equal(firstInvalidStep({ ...r, ownerPassword: 'ledger2026', ownerPasswordConfirm: 'ledger2026' }), null);
  });

  test('a step the user already opened keeps their choices; a typed owner name and password are kept', () => {
    const custom: CompanyDraft = { ...valid(), fyStartMonth: 1, booksFrom: '2026-01-01', features: { inventory: false }, ownerUsername: 'meera' };
    const afterFeatures = applyRecommended(custom, TODAY, WIZARD_STEPS.indexOf('features'));
    assert.equal(afterFeatures.fyStartMonth, 1, 'Books was opened');
    assert.deepEqual(afterFeatures.features, { inventory: false }, 'Features was opened');
    assert.equal(afterFeatures.ownerUsername, 'meera');
    assert.equal(afterFeatures.ownerPassword, 'ledger2026');
    assert.deepEqual(applyRecommended(custom, TODAY, WIZARD_STEPS.indexOf('review')), custom, 'every step opened: nothing changes');
  });

  test('the recommended company is what the Next path would create with its defaults', () => {
    const nextPath = buildCreateInput({ ...valid(), secure: false });
    const quick = buildCreateInput({ ...applyRecommended({ ...valid(), fyStartMonth: 7 }, TODAY), secure: false });
    assert.deepEqual(quick, nextPath);
  });

  test('summary names the financial year and what is switched on', () => {
    assert.equal(
      recommendedSummary(TODAY),
      'Financial year April to March (FY 2026-27, books from 01-Apr-2026), stock and bill-wise dues on, password protection on. Change any of it later with F11 and F12.',
    );
  });
});

describe('create with recommended settings: wizard wiring (CreateCompanyWizard.tsx)', () => {
  test('the button sits on the GST & tax step only; Review shows the password fields inline on that path only', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../CreateCompanyWizard.tsx', import.meta.url), 'utf8');
    assert.match(src, /\{step === 'gst' \? \(\s*<Button icon="check-circle" onClick=\{recommend\} disabled=\{busy\}>\s*Create with recommended settings/);
    assert.match(src, /setDraft\(\(d\) => applyRecommended\(d, today, furthest\)\)/);
    assert.match(src, /<ReviewSection title="Security"[^\n]*>\s*\{quick \? \(\s*<Stack gap=\{3\}>\s*<SecurityFields /);
    // Ctrl+A (create) reads `quick`: the hotkey must see its current value.
    assert.match(src, /\[draft, step, touched, busy, quick\]/);
    // The note promises the defaults only while Books, Features and Security are still unopened.
    assert.match(src, /furthest < WIZARD_STEPS\.indexOf\('books'\)\s*\? `skips the next three steps: \$\{recommendedSummary\(today\)\}`/);
  });
});
