import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BalanceSheetResult, TrialBalanceResult } from '../../../shared/types/reports.ts';
import { reportsRoutes } from './routes.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';

const FINANCIAL = ['reports.profitLoss', 'reports.balanceSheet', 'reports.ratios', 'reports.cashFlow', 'reports.fundsFlow'];

test('every reports route is read-only (transactional: false) and permission-guarded', () => {
  for (const [name, r] of Object.entries(reportsRoutes)) {
    assert.equal(r.transactional, false, name);
    assert.equal(r.access, FINANCIAL.includes(name) ? 'reports.financial' : 'reports.view', name);
    assert.ok(name.startsWith('reports.'), name);
  }
  assert.equal(Object.keys(reportsRoutes).length, 15);
});

test('routes through the dispatcher: Trial Balance and Balance Sheet', async () => {
  const b = makeBooks();
  const tb = await b.t.callOk<TrialBalanceResult>(reportsRoutes, 'reports.trialBalance', { ...APRIL, mode: 'detailed' });
  assert.equal(tb.balanced, true);
  const bs = await b.t.callOk<BalanceSheetResult>(reportsRoutes, 'reports.balanceSheet', { asOf: APRIL.to });
  assert.equal(bs.assetsTotal, EXPECTED.bsTotal);
});

test('a Data Entry user may see the Trial Balance but not the P&L / Balance Sheet', async () => {
  const b = makeBooks();
  const session = b.t.sessionAs({ role: 'Data Entry' });
  const tb = await b.t.call(reportsRoutes, 'reports.trialBalance', APRIL, { session });
  assert.equal(tb.ok, true);
  for (const name of FINANCIAL) {
    const input = name === 'reports.balanceSheet' ? { asOf: APRIL.to } : APRIL;
    const r = await b.t.call(reportsRoutes, name, input, { session });
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN', name);
  }
});

test('reversed period and bad input are VALIDATION errors with a field path', async () => {
  const b = makeBooks({ skipVouchers: true });
  const r = await b.t.call(reportsRoutes, 'reports.trialBalance', { from: '2026-04-30', to: '2026-04-01' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'VALIDATION');
    assert.equal((r.error.details as Array<{ path: string }>)[0].path, 'to');
  }
  const bad = await b.t.call(reportsRoutes, 'reports.trialBalance', { from: '2026-02-30', to: '2026-04-01', mode: 'everything' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const paths = (bad.error.details as Array<{ path: string }>).map((d) => d.path).sort();
    assert.deepEqual(paths, ['from', 'mode']);
  }
  const reg = await b.t.call(reportsRoutes, 'reports.register', APRIL);
  assert.equal(reg.ok, false);
  if (!reg.ok) assert.equal(reg.error.code, 'VALIDATION');
  const grp = await b.t.call(reportsRoutes, 'reports.groupSummary', { ...APRIL, groupId: 99_999 });
  assert.equal(grp.ok, false);
  if (!grp.ok) assert.equal(grp.error.code, 'VALIDATION');
  const basis = await b.t.call(reportsRoutes, 'reports.groupSummary', { ...APRIL, groupId: b.t.ids.groups.SALES_ACCOUNTS, basis: 'cash' });
  assert.equal(basis.ok, false);
  if (!basis.ok) assert.deepEqual((basis.error.details as Array<{ path: string }>).map((d) => d.path), ['basis']);
});

test('Group Summary basis travels through the dispatcher (the P&L drill-down)', async () => {
  const b = makeBooks();
  const r = await b.t.call(reportsRoutes, 'reports.groupSummary', { ...APRIL, groupId: b.t.ids.groups.SALES_ACCOUNTS, basis: 'profitLoss' });
  assert.equal(r.ok, true);
  if (r.ok) {
    const out = r.data as { basis: string; totals: { closing: number } };
    // April sales Cr 1,20,00,000 — the P&L Sales Accounts line.
    assert.deepEqual([out.basis, out.totals.closing], ['profitLoss', -12_000_000]);
  }
});

test('every route answers on an empty company', async () => {
  const b = makeBooks({ skipVouchers: true });
  const inputs: Record<string, unknown> = {
    'reports.trialBalance': APRIL,
    'reports.profitLoss': { ...APRIL, compareWith: 'previous_year' },
    'reports.balanceSheet': { asOf: APRIL.to, compareAsOf: '2026-03-31' },
    'reports.groupSummary': { ...APRIL, groupId: b.t.ids.groups.CURRENT_ASSETS },
    'reports.groupVouchers': { ...APRIL, groupId: b.t.ids.groups.CURRENT_ASSETS },
    'reports.ledger': { ...APRIL, ledgerId: b.L.cash },
    'reports.monthlySummary': { ...APRIL, ledgerId: b.L.cash },
    'reports.cashBank': APRIL,
    'reports.register': { ...APRIL, baseType: 'sales', includeVouchers: true },
    'reports.cashFlow': APRIL,
    'reports.fundsFlow': APRIL,
    'reports.ratios': APRIL,
    'reports.exceptions': { ...APRIL, includeNoNarration: true },
    'reports.costCentres': APRIL,
    'reports.statistics': APRIL,
  };
  for (const name of Object.keys(reportsRoutes)) {
    const r = await b.t.call(reportsRoutes, name, inputs[name]);
    assert.equal(r.ok, true, `${name}: ${r.ok ? '' : r.error.message}`);
  }
});
