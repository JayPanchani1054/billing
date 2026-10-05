import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PlaceOfSupplyInput } from '../types/gst.ts';
import {
  b2clThresholdOn,
  classifySupply,
  GST_NATURE_LABELS,
  isOutwardNature,
  isRegisteredParty,
  isZeroRatedNature,
  type ClassifyContext,
} from './classify.ts';
import { determinePlaceOfSupply, isInterState, taxModeFor } from './pos.ts';
import { GST_NATURES } from '../types/gst.ts';

describe('determinePlaceOfSupply', () => {
  const pos = (over: Partial<PlaceOfSupplyInput>): string =>
    determinePlaceOfSupply({ direction: 'outward', supplyKind: 'goods', companyStateCode: '27', partyRegistration: 'regular', partyStateCode: '29', ...over }).code;

  test('explicit wins, but only when it is a known code', () => {
    assert.equal(pos({ explicit: '07' }), '07');
    assert.equal(pos({ explicit: '7' }), '07');
    assert.equal(pos({ explicit: 'XX' }), '29');
    assert.equal(pos({ explicit: '96', partyRegistration: 'regular' }), '96');
  });

  test('outward: overseas → 96; goods → consignee else party; services → party', () => {
    assert.equal(pos({ partyRegistration: 'overseas', partyStateCode: null }), '96');
    assert.equal(pos({ consigneeStateCode: '24' }), '24');
    assert.equal(pos({}), '29');
    assert.equal(pos({ supplyKind: 'services', consigneeStateCode: '24' }), '29');
    assert.equal(pos({ partyStateCode: null }), '27');
  });

  test('inward: POS is the company state (including imports)', () => {
    assert.equal(pos({ direction: 'inward' }), '27');
    const imp = determinePlaceOfSupply({ direction: 'inward', supplyKind: 'goods', companyStateCode: '27', partyRegistration: 'overseas' });
    assert.equal(imp.code, '27');
    assert.match(imp.reason, /Import/);
    assert.equal(pos({ direction: 'inward', companyStateCode: undefined }), '29');
  });

  test('nothing known → empty code with a reason', () => {
    const r = determinePlaceOfSupply({ direction: 'outward', supplyKind: 'goods', partyRegistration: 'consumer' });
    assert.equal(r.code, '');
    assert.match(r.reason, /could not be determined/);
  });
});

describe('isInterState and taxModeFor', () => {
  test('state comparison', () => {
    assert.equal(isInterState('27', '27'), false);
    assert.equal(isInterState('27', '29'), true);
    assert.equal(isInterState('7', '07'), false);
    assert.equal(isInterState('', ''), false);
    assert.equal(isInterState('27', ''), true);
  });

  test('SEZ (either side), exports and imports are always inter-state', () => {
    assert.equal(isInterState('27', '27', 'sez'), true);
    assert.equal(isInterState('27', '27', 'regular', { companyIsSez: true }), true);
    assert.equal(isInterState('27', '27', 'overseas'), true);
    assert.equal(isInterState('27', '96', 'regular'), true);
  });

  test('tax mode', () => {
    assert.equal(taxModeFor(true, '27'), 'igst');
    assert.equal(taxModeFor(false, '27'), 'cgst_sgst');
    assert.equal(taxModeFor(false, '04'), 'cgst_utgst');
    assert.equal(taxModeFor(false, '35'), 'cgst_utgst');
    assert.equal(taxModeFor(true, '27', false), 'none');
  });
});

describe('classifySupply', () => {
  const out = (over: Partial<ClassifyContext> = {}, value = 50_000_00, allNonTaxable = false) =>
    classifySupply(
      { direction: 'outward', companyRegistration: 'regular', partyRegistration: 'regular', interState: false, ...over },
      { invoiceValue: value, allNonTaxable },
    );
  const inw = (over: Partial<ClassifyContext> = {}, totals: { goodsValue?: number; servicesValue?: number; allNonTaxable?: boolean } = {}) =>
    classifySupply(
      { direction: 'inward', companyRegistration: 'regular', partyRegistration: 'regular', interState: false, ...over },
      { invoiceValue: 1000, allNonTaxable: totals.allNonTaxable ?? false, goodsValue: totals.goodsValue, servicesValue: totals.servicesValue },
    );

  test('company registration comes first', () => {
    assert.equal(out({ companyRegistration: 'unregistered' }), 'no_gst');
    assert.equal(inw({ companyRegistration: 'unregistered' }), 'no_gst');
    assert.equal(out({ companyRegistration: 'composition', partyRegistration: 'overseas' }), 'composition_outward');
  });

  test('outward natures in rule order', () => {
    assert.equal(out({ partyRegistration: 'overseas' }), 'export_lut');
    assert.equal(out({ partyRegistration: 'overseas', exportWithPayment: true }), 'export_wpay');
    assert.equal(out({ partyRegistration: 'sez' }, 1, true), 'sez_lut', 'SEZ wins over nil/exempt');
    assert.equal(out({ partyRegistration: 'sez', exportWithPayment: true }), 'sez_wpay');
    assert.equal(out({ partyRegistration: 'deemed_export' }), 'deemed_export');
    assert.equal(out({}, 1, true), 'nil_exempt');
    assert.equal(out({ partyRegistration: 'composition' }), 'b2b');
    assert.equal(out({ partyRegistration: 'uin' }), 'b2b');
  });

  test('B2CL is strictly above the threshold and inter-state only', () => {
    const b2c = { partyRegistration: 'unregistered' as const, interState: true };
    assert.equal(out(b2c, 1_00_000_00), 'b2cs');
    assert.equal(out(b2c, 1_00_000_01), 'b2cl');
    assert.equal(out({ ...b2c, interState: false }, 5_00_000_00), 'b2cs');
    assert.equal(out({ ...b2c, partyRegistration: 'consumer', b2clThresholdPaise: 2_50_000_00 }, 2_00_000_00), 'b2cs');
  });

  test('statutory B2CL threshold by invoice date', () => {
    assert.equal(b2clThresholdOn('2024-07-31'), 2_50_000_00);
    assert.equal(b2clThresholdOn('2024-08-01'), 1_00_000_00);
    assert.equal(b2clThresholdOn('2026-10-05'), 1_00_000_00);
    assert.equal(b2clThresholdOn(''), 1_00_000_00);
    assert.equal(b2clThresholdOn(undefined), 1_00_000_00);
  });

  test('inward natures in rule order', () => {
    assert.equal(inw({ partyRegistration: 'overseas' }, { goodsValue: 100, servicesValue: 50 }), 'import_goods');
    assert.equal(inw({ partyRegistration: 'overseas' }, { goodsValue: 50, servicesValue: 100 }), 'import_services');
    assert.equal(inw({ partyRegistration: 'overseas' }, { goodsValue: 100, servicesValue: 100 }), 'import_goods');
    assert.equal(inw({ partyRegistration: 'sez', reverseCharge: true }), 'inward_sez');
    assert.equal(inw({ partyRegistration: 'unregistered', reverseCharge: true }), 'inward_rcm');
    assert.equal(inw({ partyRegistration: 'unregistered' }), 'inward_unregistered');
    assert.equal(inw({ partyRegistration: 'consumer' }), 'inward_unregistered');
    assert.equal(inw({ partyRegistration: 'composition' }), 'inward_composition');
    assert.equal(inw({}, { allNonTaxable: true }), 'inward_nil_exempt');
    assert.equal(inw({}), 'inward_b2b');
  });

  test('labels and helpers cover every nature', () => {
    for (const n of GST_NATURES) assert.ok(GST_NATURE_LABELS[n].length > 0, n);
    assert.equal(isOutwardNature('b2cl'), true);
    assert.equal(isOutwardNature('import_goods'), false);
    assert.equal(isOutwardNature('inward_rcm'), false);
    assert.equal(isZeroRatedNature('sez_lut'), true);
    assert.equal(isZeroRatedNature('deemed_export'), false);
    assert.equal(isRegisteredParty('uin'), true);
    assert.equal(isRegisteredParty('consumer'), false);
  });
});
