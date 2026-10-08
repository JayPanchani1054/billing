import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyGstDraft, gstChanged, gstDraftFrom, gstSaveFields, validateGstDraft } from './gstDraft.ts';
import type { GstMaster } from './gstDraft.ts';

const group: GstMaster = { gstApplicable: true, taxability: 'taxable', gstRate: 18, cessRate: null, cessPerUnit: 0, hsnSac: '8517' };

test('group draft round trip; a rename sends no GST fields even with history', () => {
  const d = gstDraftFrom(group);
  assert.equal(gstChanged(d, group), false);
  assert.deepEqual(gstSaveFields(d, group), {});
  assert.deepEqual(validateGstDraft(d, group, { kind: null, hasHistory: true }), {});
});

test('group HSN may be goods or services; a change with history needs a date', () => {
  const d = { ...gstDraftFrom(group), hsnSac: '998314' };
  assert.equal(validateGstDraft(d, group, { kind: null, hasHistory: false }).hsnSac, undefined);
  assert.match(validateGstDraft(d, group, { kind: null, hasHistory: true }).gstApplicableFrom, /from which date/);
  const dated = { ...d, gstApplicableFrom: '2026-10-01' };
  assert.deepEqual(gstSaveFields(dated, group), {
    hsnSac: '998314',
    gstApplicable: true,
    taxability: 'taxable',
    gstRate: 18,
    cessRate: null,
    cessPerUnit: null,
    gstApplicableFrom: '2026-10-01',
  });
});

test('inheriting master: only the switch (and HSN) are sent', () => {
  const inherit: GstMaster = { gstApplicable: false, taxability: null, gstRate: null, cessRate: null, cessPerUnit: 0, hsnSac: null };
  const d = gstDraftFrom(inherit);
  assert.deepEqual(d, emptyGstDraft());
  assert.deepEqual(gstSaveFields({ ...d, hsnSac: '1006 30' }, inherit), { hsnSac: '100630' });
  // A new master with nothing set still says "no own details".
  assert.deepEqual(gstSaveFields(d, null), { hsnSac: null, gstApplicable: false });
});

test('nil-rated master keeps no rate; turning it taxable needs a rate', () => {
  const nil: GstMaster = { gstApplicable: true, taxability: 'nil_rated', gstRate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: null };
  const d = gstDraftFrom(nil);
  assert.equal(d.gstRate, null);
  const taxable = { ...d, taxability: 'taxable' as const };
  assert.match(validateGstDraft(taxable, nil, { kind: 'goods', hasHistory: false }).gstRate, /Enter the GST rate/);
  assert.deepEqual(gstSaveFields({ ...taxable, gstRate: 5 }, nil), { hsnSac: null, gstApplicable: true, taxability: 'taxable', gstRate: 5, cessRate: null, cessPerUnit: null });
});

test('rate select: slabs first, then other notified rates, then another rate', async () => {
  const { rateSelectGroups, rateSelectValue, patchFromRateSelect, OTHER_RATE } = await import('./gstDraft.ts');
  const g = rateSelectGroups([0, 5, 18, 40], [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);
  assert.deepEqual(g[0].options.map((o) => o.value), ['0', '5', '18', '40']);
  assert.equal(g[0].options[0].label, '0% (zero rated)');
  assert.deepEqual(g[1].options.map((o) => o.value), ['0.1', '0.25', '1', '1.5', '3', '6', '7.5', '12', '28']);
  assert.equal(g[2].options[0].value, OTHER_RATE);
  assert.equal(rateSelectValue({ gstRate: 18, allowNonStandardRate: false }), '18');
  assert.equal(rateSelectValue({ gstRate: 13, allowNonStandardRate: false }), OTHER_RATE);
  assert.equal(rateSelectValue({ gstRate: null, allowNonStandardRate: false }), '');
  assert.deepEqual(patchFromRateSelect('5'), { gstRate: 5, allowNonStandardRate: false });
  assert.deepEqual(patchFromRateSelect(OTHER_RATE), { allowNonStandardRate: true });
});
