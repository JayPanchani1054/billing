import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Db } from '../../db/db.ts';
import { migrate } from '../../db/migrate.ts';
import { migrations } from '../../db/migrations/index.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { saveVoucherType } from '../accounts/voucherTypes.ts';
import { saveFeatures } from '../company/service.ts';
import { getGodown, saveGodown } from '../inventory/masters.ts';
import { classedTypes } from './journalQueries.ts';

describe('mfg setup', () => {
  test('migration 210: existing third-party godowns stay valued as our stock', () => {
    const db = new Db(':memory:');
    try {
      migrate(db, migrations.filter((m) => m.version < 210));
      const ts = '2026-01-01T00:00:00.000Z';
      db.run(`INSERT INTO godowns (guid, name, is_predefined, is_third_party, created_at, updated_at) VALUES ('g1', 'Agent', 0, 1, :ts, :ts)`, { ts });
      db.run(`INSERT INTO godowns (guid, name, is_predefined, is_third_party, created_at, updated_at) VALUES ('g2', 'Shop', 0, 0, :ts, :ts)`, { ts });
      const r = migrate(db);
      assert.ok(r.applied.includes(210));
      assert.deepEqual(
        db.all<{ name: string; kind: string }>('SELECT name, third_party_kind AS kind FROM godowns ORDER BY name').map((g) => [g.name, g.kind]),
        [
          ['Agent', 'ours_with_party'],
          ['Shop', 'none'],
        ],
      );
    } finally {
      db.close();
    }
  });

  test('turning the features on (F11) creates the Manufacturing Journal and Material In / Out types once', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    assert.deepEqual(classedTypes(t.db), []);
    saveFeatures(t.ctx, { manufacturing: true });
    assert.deepEqual(classedTypes(t.db).map((x) => [x.name, x.class]), [['Manufacturing Journal', 'manufacturing']]);
    saveFeatures(t.ctx, { jobWork: true });
    saveFeatures(t.ctx, { jobWork: false });
    saveFeatures(t.ctx, { jobWork: true });
    assert.deepEqual(
      classedTypes(t.db).map((x) => x.class).sort(),
      ['manufacturing', 'material_in', 'material_out'],
    );
    const parent = t.db.value<number>(`SELECT parent_id FROM voucher_types WHERE name = 'Material Out'`);
    assert.equal(parent, t.ids.voucherTypes.stock_journal);
    // Job work needs multiple godowns: switching those off switches job work off too.
    const f = saveFeatures(t.ctx, { multipleGodowns: false });
    assert.equal(f.jobWork, false);
    t.close();
  });

  test('voucher type class: stock journals only, and fixed once vouchers exist', () => {
    const t = createTestCompany({ features: { manufacturing: true } });
    assert.throws(
      () => saveVoucherType(t.ctx, { name: 'Odd', baseType: 'sales', config: { stockJournalClass: 'manufacturing' } }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
    );
    const own = saveVoucherType(t.ctx, { name: 'Assembly', baseType: 'stock_journal', config: { stockJournalClass: 'manufacturing' } });
    assert.ok(classedTypes(t.db).some((x) => x.id === own.id));
    t.close();
  });

  test('godown master: kinds, legacy switch, party, Main Location stays own', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const legacy = saveGodown(t.ctx, { name: 'Agent', isThirdParty: true });
    assert.equal(legacy.thirdPartyKind, 'ours_with_party');
    const theirs = saveGodown(t.ctx, { id: legacy.id, name: 'Agent', thirdPartyKind: 'party_with_us' });
    assert.equal(theirs.isThirdParty, true);
    assert.equal(getGodown(t.db, legacy.id).thirdPartyKind, 'party_with_us');
    const own = saveGodown(t.ctx, { id: legacy.id, name: 'Agent', isThirdParty: false });
    assert.equal(own.thirdPartyKind, 'none');
    assert.throws(() => saveGodown(t.ctx, { id: t.ids.mainGodownId, name: 'Main Location', thirdPartyKind: 'ours_with_party' }), (e: unknown) => e instanceof AppError);
    t.close();
  });
});
