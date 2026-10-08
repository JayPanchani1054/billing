import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyGstin, gstinOkText, gstinProblem } from './gstin.ts';
import type { GstinFields } from './gstin.ts';

// Check characters computed with shared/gst gstinCheckChar (Luhn mod-36).
const MH = '27AAPFU0939F1ZV';
const KA = '29AABCT1332L1ZA';
const UIN = '0717UNO00157UNO';

const base: GstinFields = { gstin: '', stateCode: '', pan: '', registrationType: '' };

describe('applyGstin — live autofill', () => {
  it('partial input only updates the text (normalised, upper-case, max 15)', () => {
    const r = applyGstin(base, ' 27aapfu ');
    assert.equal(r.gstin, '27AAPFU');
    assert.equal(r.valid, false);
    assert.equal(r.stateCode, '');
    assert.deepEqual(r.filled, []);
  });

  it('a valid GSTIN fills state, PAN and makes an unclassified party Regular', () => {
    const r = applyGstin(base, MH.toLowerCase());
    assert.equal(r.valid, true);
    assert.equal(r.stateCode, '27');
    assert.equal(r.pan, 'AAPFU0939F');
    assert.equal(r.registrationType, 'regular');
    assert.deepEqual(r.filled, ['state', 'pan', 'registration']);
  });

  it('overwrites a different state (the GSTIN is authoritative) and keeps composition/SEZ types', () => {
    const r = applyGstin({ ...base, stateCode: '27', registrationType: 'composition' }, KA);
    assert.equal(r.stateCode, '29');
    assert.equal(r.registrationType, 'composition');
    assert.deepEqual(r.filled, ['state', 'pan']);
  });

  it('Unregistered / Consumer become Regular once a GSTIN is entered', () => {
    assert.equal(applyGstin({ ...base, registrationType: 'unregistered' }, MH).registrationType, 'regular');
    assert.equal(applyGstin({ ...base, registrationType: 'consumer' }, MH).registrationType, 'regular');
  });

  it('a UIN makes the party a UIN holder', () => {
    const r = applyGstin({ ...base, registrationType: 'regular' }, UIN);
    assert.equal(r.valid, true);
    assert.equal(r.registrationType, 'uin');
    assert.equal(r.stateCode, '07');
  });

  it('mistyped check character stays invalid', () => {
    const r = applyGstin(base, `${MH.slice(0, 14)}A`);
    assert.equal(r.valid, false);
    assert.equal(r.registrationType, '');
  });
});

describe('gstinProblem — same rules as the core', () => {
  it('partial GSTIN is quiet while typing but reported on save', () => {
    const f = { ...base, gstin: '27AAP', registrationType: 'regular' as const };
    assert.equal(gstinProblem(f, false), null);
    assert.match(gstinProblem(f, true)?.message ?? '', /15 characters/);
  });

  it('wrong check character', () => {
    const p = gstinProblem({ ...base, gstin: `${MH.slice(0, 14)}A` }, false);
    assert.equal(p?.field, 'gstin');
    assert.match(p?.message ?? '', /check character/);
  });

  it('Regular without GSTIN; Unregistered with GSTIN', () => {
    assert.match(gstinProblem({ ...base, registrationType: 'regular' }, true)?.message ?? '', /GSTIN is required/);
    assert.match(gstinProblem({ ...base, gstin: MH, stateCode: '27', registrationType: 'unregistered' }, true)?.message ?? '', /cannot have a GSTIN/);
  });

  it('state mismatch names both states', () => {
    const p = gstinProblem({ ...base, gstin: MH, stateCode: '29', registrationType: 'regular' }, true);
    assert.match(p?.message ?? '', /Maharashtra.*Karnataka/);
  });

  it('overseas: no GSTIN, state 96 or blank; 96 only for overseas', () => {
    assert.equal(gstinProblem({ ...base, registrationType: 'overseas', stateCode: '96' }, true), null);
    assert.equal(gstinProblem({ ...base, registrationType: 'overseas', gstin: MH }, true)?.field, 'gstin');
    assert.equal(gstinProblem({ ...base, registrationType: 'regular', gstin: MH, stateCode: '96' }, true)?.field, 'stateCode');
  });

  it('valid combination → null, and an OK hint', () => {
    assert.equal(gstinProblem({ gstin: MH, stateCode: '27', pan: 'AAPFU0939F', registrationType: 'regular' }, true), null);
    assert.equal(gstinOkText(MH), 'Valid GSTIN · Maharashtra · PAN AAPFU0939F');
    assert.equal(gstinOkText('27AAP'), null);
  });
});
