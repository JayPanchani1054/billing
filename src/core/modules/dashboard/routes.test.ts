/**
 * 'dashboard.summary' through the real dispatcher: access, validation and the JSON-safe result.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardSummary } from '../../../shared/types/dashboard.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { dashboardRoutes } from './routes.ts';
import { buildDashboardBooks, INPUT, TODAY } from './testkit.ts';

test('dashboard.summary: returns the summary for reports.view', async () => {
  const b = buildDashboardBooks();
  const s = await b.t.callOk<DashboardSummary>(dashboardRoutes, 'dashboard.summary', INPUT);
  assert.equal(s.sales.ytd, 480_000);
  assert.equal(s.asOf, TODAY);
  // JSON-safe (it crosses IPC).
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  const viewer = await b.t.call(dashboardRoutes, 'dashboard.summary', INPUT, { session: b.t.sessionAs({ permissions: ['reports.view'] }) });
  assert.equal(viewer.ok, true);
  b.t.close();
});

test('dashboard.summary: FORBIDDEN without reports.view', async () => {
  const t = createTestCompany({ today: TODAY });
  const res = await t.call(dashboardRoutes, 'dashboard.summary', INPUT, { session: t.sessionAs({ permissions: ['vouchers.view'] }) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'FORBIDDEN');
  t.close();
});

test('dashboard.summary: VALIDATION for a reversed period or a bad date', async () => {
  const t = createTestCompany({ today: TODAY });
  const reversed = await t.call(dashboardRoutes, 'dashboard.summary', { asOf: TODAY, from: '2026-10-08', to: '2026-04-01' });
  assert.equal(reversed.ok, false);
  if (!reversed.ok) {
    assert.equal(reversed.error.code, 'VALIDATION');
    assert.match(reversed.error.message, /period ends before it starts/);
  }
  const bad = await t.call(dashboardRoutes, 'dashboard.summary', { asOf: '2026-02-30', from: '2026-04-01', to: TODAY });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'VALIDATION');
  const missing = await t.call(dashboardRoutes, 'dashboard.summary', { asOf: TODAY });
  assert.equal(missing.ok, false);
  t.close();
});

test('dashboard.summary is a non-transactional read-only route', () => {
  const r = dashboardRoutes['dashboard.summary'];
  assert.equal(r.transactional, false);
  assert.equal(r.access, 'reports.view');
});
