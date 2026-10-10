/**
 * Security review (final wave): every master the app creates on the user's behalf is in the edit log.
 * Turning Manufacturing / Job work on (F11) creates voucher types; each is a 'create' entry of its own.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestCompany } from '../../testing/fixtures.ts';
import { saveFeatures } from '../company/service.ts';

describe('mfg voucher types created by F11 are audited', () => {
  test('one create entry per Manufacturing Journal / Material Out / Material In type, none when nothing is created', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const created = (): string[] =>
      t.db
        .all<{ entity_label: string }>(`SELECT entity_label FROM audit_log WHERE entity_type = 'voucher_type' AND action = 'create' ORDER BY id`)
        .map((r) => r.entity_label);
    assert.deepEqual(created(), []);
    saveFeatures(t.ctx, { manufacturing: true });
    assert.deepEqual(created(), ['Manufacturing Journal']);
    saveFeatures(t.ctx, { jobWork: true });
    assert.deepEqual(created(), ['Manufacturing Journal', 'Material Out', 'Material In']);
    // Off and on again: the types exist, nothing new is created or logged.
    saveFeatures(t.ctx, { manufacturing: false, jobWork: false });
    saveFeatures(t.ctx, { manufacturing: true, jobWork: true });
    assert.equal(created().length, 3);
  });
});
