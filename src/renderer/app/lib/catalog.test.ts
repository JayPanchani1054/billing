import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_FEATURES } from '../../../shared/settings.ts';
import { parseHotkeyList } from '../../ui/lib/hotkeys.ts';
import { changedFeatures, FEATURE_CATALOG, featureBlockedReason, isFeatureAvailable, normalizeFeatureToggles } from './featureCatalog.ts';
import { filterShortcuts, GLOBAL_SHORTCUTS, reservedGlobalKeys, VOUCHER_SHORTCUTS } from './shortcuts.ts';

describe('feature catalogue', () => {
  test('covers every CompanyFeatures key exactly once', () => {
    const keys = FEATURE_CATALOG.map((f) => f.key).sort();
    assert.deepEqual(keys, Object.keys(DEFAULT_FEATURES).sort());
  });

  test('dependency rules match the server', () => {
    const f = normalizeFeatureToggles({ ...DEFAULT_FEATURES, inventory: false, batches: true, expiryDates: true, gst: false, einvoice: true });
    assert.equal(f.batches, false);
    assert.equal(f.expiryDates, false);
    assert.equal(f.integrateInventory, false);
    assert.equal(f.einvoice, false);
    assert.equal(f.orderProcessing, DEFAULT_FEATURES.orderProcessing, 'independent features untouched');
    const g = normalizeFeatureToggles({ ...DEFAULT_FEATURES, inventory: true, batches: false, expiryDates: true });
    assert.equal(g.expiryDates, false);
  });

  test('blocked reasons name the missing prerequisite', () => {
    const off = { ...DEFAULT_FEATURES, inventory: false, batches: false };
    assert.equal(featureBlockedReason('expiryDates', off), 'Turn on Maintain stock first.');
    assert.equal(featureBlockedReason('expiryDates', { ...DEFAULT_FEATURES, batches: false }), 'Turn on Batches first.');
    assert.equal(featureBlockedReason('gst', off), null);
    assert.equal(isFeatureAvailable('expiryDates', { ...DEFAULT_FEATURES, batches: true }), true);
  });

  test('changedFeatures', () => {
    assert.deepEqual(changedFeatures(DEFAULT_FEATURES, { ...DEFAULT_FEATURES, tds: true }), ['tds']);
  });
});

describe('global shortcuts', () => {
  test('no two global bindings share a key', () => {
    const seen = new Map<string, string>();
    for (const s of GLOBAL_SHORTCUTS.filter((x) => x.global)) {
      for (const h of parseHotkeyList(s.keys)) {
        const id = `${h.ctrl ? 'c' : ''}${h.alt ? 'a' : ''}${h.shift ? 's' : ''}${h.meta ? 'm' : ''}+${h.key}`;
        assert.ok(!seen.has(id), `${s.keys} (${s.label}) clashes with ${seen.get(id)}`);
        seen.set(id, s.label);
      }
    }
  });

  test('the Tally voucher keys are present', () => {
    const byType = Object.fromEntries(VOUCHER_SHORTCUTS.map((s) => [s.baseType, s.keys]));
    assert.equal(byType.contra, 'F4');
    assert.equal(byType.payment, 'F5');
    assert.equal(byType.receipt, 'F6');
    assert.equal(byType.journal, 'F7');
    assert.equal(byType.sales, 'F8');
    assert.equal(byType.purchase, 'F9');
    assert.equal(byType.credit_note, 'Ctrl+F8');
    assert.equal(byType.debit_note, 'Ctrl+F9');
    assert.equal(byType.sales_order, 'Alt+F5');
    assert.equal(byType.purchase_order, 'Alt+F6');
    assert.equal(byType.delivery_note, 'Alt+F8');
    assert.equal(byType.receipt_note, 'Alt+F9');
    assert.equal(byType.stock_journal, 'Alt+F7');
    assert.equal(byType.reversing_journal, undefined, 'F10 is the voucher picker');
  });

  test('reserved keys and filtering', () => {
    const reserved = reservedGlobalKeys();
    for (const k of ['F2', 'Alt+F2', 'Ctrl+G', 'Ctrl+K', 'F8', 'F11', 'F12', 'Ctrl+Q', 'F1']) assert.ok(reserved.includes(k), k);
    assert.ok(!reserved.includes('Escape'));
    assert.ok(filterShortcuts(GLOBAL_SHORTCUTS, 'sales').some((s) => s.keys === 'F8'));
    assert.equal(filterShortcuts(GLOBAL_SHORTCUTS, '').length, GLOBAL_SHORTCUTS.length);
  });
});
