/**
 * Security review (final wave): the composition category and the dated composition rates decide the
 * CMP-08 / GSTR-4 tax of every quarter they cover, so a change reaching into the locked period (F12) is
 * refused — like the CMP-08 interest and GSTR-3B manual entries of a locked period.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestCompany } from '../../testing/fixtures.ts';
import { AppError } from '../../lib/errors.ts';
import { setPeriodLock } from '../company/service.ts';
import { compositionSettings, deleteCompositionRate, saveCompositionCategory, saveCompositionRate } from './composition.ts';

const locked = (e: unknown): boolean => e instanceof AppError && e.code === 'LOCKED';

describe('composition rates and the locked period', () => {
  it('refuses rate rows and category changes that reach into the locked period; later dates still work', () => {
    const t = createTestCompany({ today: '2026-08-15' });
    try {
      const settings = compositionSettings(t.db);
      const category = settings.category;
      const other = (['trader', 'manufacturer', 'restaurant', 'services'] as const).find((c) => c !== category) ?? 'manufacturer';
      saveCompositionRate(t.ctx, { category, effectiveFrom: '2026-04-01', rate: 1, basis: 'turnover' });
      const row = compositionSettings(t.db).rates.find((r) => r.effectiveFrom === '2026-04-01' && r.category === category);
      assert.ok(row);
      setPeriodLock(t.ctx, '2026-06-30');

      assert.throws(() => saveCompositionRate(t.ctx, { category, effectiveFrom: '2026-05-01', rate: 2, basis: 'turnover' }), locked);
      assert.throws(() => saveCompositionRate(t.ctx, { id: row.id, category, effectiveFrom: '2026-04-01', rate: 2, basis: 'turnover' }), locked);
      // Moving a locked row past the lock date still changes the locked quarter.
      assert.throws(() => saveCompositionRate(t.ctx, { id: row.id, category, effectiveFrom: '2026-07-01', rate: 1, basis: 'turnover' }), locked);
      assert.throws(() => deleteCompositionRate(t.ctx, row.id), locked);
      assert.throws(() => saveCompositionCategory(t.ctx, other), locked);

      // Unchanged re-save, the same category, and a rate from after the lock date are fine.
      saveCompositionRate(t.ctx, { id: row.id, category, effectiveFrom: '2026-04-01', rate: 1, basis: 'turnover', note: 'note only' });
      saveCompositionCategory(t.ctx, category);
      saveCompositionRate(t.ctx, { category, effectiveFrom: '2026-07-01', rate: 2, basis: 'turnover' });
      assert.equal(compositionSettings(t.db).rates.find((r) => r.id === row.id)?.rate, 1);
    } finally {
      t.close();
    }
  });
});
