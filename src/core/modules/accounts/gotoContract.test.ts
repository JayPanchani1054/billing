/**
 * The route contracts the renderer's built-in Go To ledger provider (renderer/app/gotoProviders.ts)
 * and its documented example (renderer/app/README.md §7) rely on. Regression: they called
 * 'accounts.ledger.picker' with { search, limit } and read `.rows` — the picker takes neither key and
 * returns an array of every ledger, so typing never narrowed the list (production drops unknown keys).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestCompany } from '../../testing/fixtures.ts';
import { accountsRoutes } from './routes.ts';

test("Go To ledgers: 'accounts.ledger.list' { search, limit } → { rows, total }, filtered and limited", async () => {
  const t = createTestCompany();
  for (const name of ['HDFC Bank', 'HDFC Credit Card', 'Hindustan Traders', 'Acme Retail']) t.addLedger({ name, group: 'SUNDRY_DEBTORS' });
  const out = await t.callOk<{ rows: Array<{ id: number; name: string; groupName: string }>; total: number }>(accountsRoutes, 'accounts.ledger.list', { search: 'hdfc', limit: 1 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.total, 2);
  assert.match(out.rows[0].name, /^HDFC/);
  assert.equal(typeof out.rows[0].groupName, 'string');
  t.close();
});

test("'accounts.ledger.picker' takes no search / limit (unknown keys are rejected under test)", async () => {
  const t = createTestCompany();
  const res = await t.call(accountsRoutes, 'accounts.ledger.picker', { search: 'hdfc', limit: 8 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'VALIDATION');
  t.close();
});
