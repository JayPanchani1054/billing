import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLabelFor, emptyQuickParty, quickPartyGroup, quickPartyInput, quickPartyNoun, quickPartyProblems, withGstin } from './quickParty.ts';

// A valid GSTIN (checksum) of Maharashtra: PAN AAPFU0939F.
const GSTIN = '27AAPFU0939F1ZV';

describe('quick customer / supplier (Alt+C in a party picker)', () => {
  it('only customer and supplier pickers get the quick dialog', () => {
    assert.equal(quickPartyGroup('SUNDRY_DEBTORS'), 'SUNDRY_DEBTORS');
    assert.equal(quickPartyGroup('SUNDRY_CREDITORS'), 'SUNDRY_CREDITORS');
    assert.equal(quickPartyGroup('BANK_ACCOUNTS'), null);
    assert.equal(quickPartyGroup('SALES_ACCOUNTS'), null);
    assert.equal(quickPartyGroup(null), null);
    assert.equal(quickPartyNoun('SUNDRY_DEBTORS'), 'customer');
    assert.equal(quickPartyNoun('SUNDRY_CREDITORS'), 'supplier');
  });

  it("the picker's create row names what Alt+C opens", () => {
    assert.equal(createLabelFor('SUNDRY_DEBTORS', ' Ravi Traders '), 'Create customer “Ravi Traders”');
    assert.equal(createLabelFor('SUNDRY_CREDITORS', ''), 'Create a new supplier');
    assert.equal(createLabelFor(null, 'Freight'), 'Create ledger “Freight”');
    assert.equal(createLabelFor(null, ' '), 'Create a new ledger');
  });

  it('starts from the typed name and the company state', () => {
    assert.deepEqual(emptyQuickParty('  Ravi Traders ', '24'), { name: 'Ravi Traders', gstin: '', stateCode: '24', pan: '', registrationType: '', mobile: '', email: '', address: '' });
    assert.equal(emptyQuickParty('x', null).stateCode, '');
  });

  it('a valid GSTIN fills state, PAN and registration type (same rules as the ledger form)', () => {
    const d = withGstin(emptyQuickParty('Ravi Traders', '24'), GSTIN.toLowerCase());
    assert.equal(d.gstin, GSTIN);
    assert.equal(d.stateCode, '27');
    assert.equal(d.pan, 'AAPFU0939F');
    assert.equal(d.registrationType, 'regular');
    // Partial input only changes the text.
    const partial = withGstin(emptyQuickParty('Ravi', '24'), '27AAP');
    assert.deepEqual([partial.gstin, partial.stateCode, partial.pan, partial.registrationType], ['27AAP', '24', '', '']);
  });

  it('problems: name required, bad GSTIN (on save), mobile and e-mail format', () => {
    assert.deepEqual(quickPartyProblems(emptyQuickParty('', '24'), true), { name: 'Enter the name.' });
    const bad = withGstin(emptyQuickParty('Ravi', '24'), '27AAPFU0939F1ZX');
    assert.match(quickPartyProblems(bad, true).gstin ?? '', /GSTIN|check/i);
    assert.deepEqual(quickPartyProblems({ ...emptyQuickParty('Ravi', '24'), gstin: '27AAP' }, false), {}, 'partial GSTIN is not an error while typing');
    const contact = { ...emptyQuickParty('Ravi', '24'), mobile: 'call me', email: 'ravi@' };
    const p = quickPartyProblems(contact, true);
    assert.ok(p.mobile && p.email);
    assert.deepEqual(quickPartyProblems({ ...emptyQuickParty('Ravi', '24'), mobile: '+91 98250-12345', email: 'ravi@example.com' }, true), {});
  });

  it('the save input: under the given group, bill-wise per F11, only what was filled in', () => {
    const d = { ...withGstin(emptyQuickParty('Ravi Traders', '24'), GSTIN), mobile: ' 9825012345 ', email: 'ravi@example.com', address: ' 12 MG Road\nSurat ' };
    assert.deepEqual(quickPartyInput(d, { groupId: 31, billWise: true }), {
      name: 'Ravi Traders',
      groupId: 31,
      billWise: true,
      country: 'India',
      gstin: GSTIN,
      stateCode: '27',
      pan: 'AAPFU0939F',
      registrationType: 'regular',
      mobile: '9825012345',
      email: 'ravi@example.com',
      address: '12 MG Road\nSurat',
    });
    // Without a GSTIN the registration type is left to the core default (unregistered); the state is kept.
    assert.deepEqual(quickPartyInput(emptyQuickParty('Walk-in', '24'), { groupId: 31, billWise: false }), { name: 'Walk-in', groupId: 31, billWise: false, country: 'India', stateCode: '24' });
  });

  it('a GSTIN typed and then cleared takes its PAN with it (the dialog has no PAN box to show it)', () => {
    const typed = withGstin(emptyQuickParty('Ravi Traders', '24'), GSTIN);
    const cleared = withGstin(typed, '');
    assert.equal(cleared.pan, 'AAPFU0939F', 'the draft still holds the PAN filled earlier');
    const input = quickPartyInput(cleared, { groupId: 31, billWise: false });
    assert.equal(input.pan, undefined, 'never saved unseen');
    assert.equal(input.gstin, undefined);
    assert.equal(input.registrationType, 'unregistered');
    assert.equal(input.stateCode, '27', 'the state stays: the State box shows it again');
  });
});
