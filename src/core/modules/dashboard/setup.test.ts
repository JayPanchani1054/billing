/**
 * dashboard.summary `setup`: the "Get started" steps are done when the books say so (regression: the
 * Gateway checklist marked a step done as soon as it was clicked, and the dashboard card disappeared
 * at the first voucher). Each change below is a real save, which also proves the summary memo
 * refreshes the facts (any write changes its key).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../../../shared/settings.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { companyRoutes } from '../company/routes.ts';
import { invoicePrintingCustomised } from './setup.ts';
import { summaryForCtx } from './summary.ts';
import { buildDashboardBooks, INPUT, TODAY } from './testkit.ts';

test('a new company: only what the create wizard filled in counts as done', () => {
  const t = createTestCompany({ today: TODAY });
  const s = summaryForCtx(t.ctx, INPUT).setup;
  assert.deepEqual(s, {
    profileComplete: true, // the fixture company has an address and a state
    featuresReviewed: false,
    invoicePrintingSet: false,
    hasOwnLedgers: false, // predefined ledgers (Cash, Sales, GST…) do not count
    hasItems: false,
    hasSales: false,
    backupFolderSet: false,
  });
  t.close();
});

test('each step turns done from the data, and the memoised summary picks it up', async () => {
  const t = createTestCompany({ today: TODAY });
  summaryForCtx(t.ctx, INPUT); // warm the memo
  await t.callOk(companyRoutes, 'company.features.save', { billWise: !summaryForCtx(t.ctx, INPUT).features.billWise });
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.featuresReviewed, true);

  await t.callOk(companyRoutes, 'company.config.save', { invoice: { template: 'classic' } });
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.invoicePrintingSet, true);

  t.addLedger({ name: 'Acme Retail', group: 'SUNDRY_DEBTORS' });
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.hasOwnLedgers, true);

  t.addStockItem({ name: 'Mixer Grinder' });
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.hasItems, true);

  const folder = process.platform === 'win32' ? 'D:\\Backups' : '/var/backups/bahi';
  await t.callOk(companyRoutes, 'company.config.save', { backup: { folder } });
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.backupFolderSet, true);

  await t.callOk(companyRoutes, 'company.profile.save', { ...profileOf(t), address: '   ' });
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.profileComplete, false, 'a blank address is not done');
  t.close();
});

test('first sale: done once a sales voucher exists', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT).setup;
  assert.equal(s.hasSales, true);
  assert.equal(s.hasOwnLedgers, true);
  assert.equal(s.hasItems, true);
  b.t.close();
});

test('password protection alone is not a review of the features', async () => {
  const t = createTestCompany({ today: TODAY });
  const f = summaryForCtx(t.ctx, INPUT).features;
  // What security/toggle.ts records when the Owner turns password protection on.
  t.db.transaction(() => t.ctx.audit({ action: 'settings', entityType: 'company_features', entityLabel: 'Features (F11)', before: { ...f, security: false }, after: { ...f, security: true } }));
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.featuresReviewed, false);
  t.db.transaction(() => t.ctx.audit({ action: 'settings', entityType: 'company_features', entityLabel: 'Features (F11)', before: { security: true, godowns: false }, after: { security: true, godowns: true } }));
  assert.equal(summaryForCtx(t.ctx, INPUT).setup.featuresReviewed, true);
  t.close();
});

test('invoicePrintingCustomised: copies compared as a set; any other change counts', () => {
  const d = DEFAULT_CONFIG.invoice;
  assert.equal(invoicePrintingCustomised(structuredClone(d)), false);
  assert.equal(invoicePrintingCustomised({ ...d, bankLedgerId: 4 }), true);
  assert.equal(invoicePrintingCustomised({ ...d, copies: ['original', 'duplicate'] }), true);
  assert.equal(invoicePrintingCustomised({ ...d, upiId: 'shop@okhdfcbank' }), true);
});

function profileOf(t: ReturnType<typeof createTestCompany>): Record<string, unknown> {
  const row = t.db.get<{ name: string; state_code: string; books_from: string; fy_start_month: number; gstin: string | null; gst_registration_type: string }>(
    'SELECT name, state_code, books_from, fy_start_month, gstin, gst_registration_type FROM company WHERE id = 1',
  );
  assert.ok(row);
  return {
    name: row.name,
    stateCode: row.state_code,
    booksFrom: row.books_from,
    fyStartMonth: row.fy_start_month,
    gstin: row.gstin ?? '',
    gstRegistrationType: row.gst_registration_type,
  };
}
