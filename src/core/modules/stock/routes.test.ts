import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PendingOrdersResult, StockItemVouchersResult, StockSummaryResult } from '../../../shared/types/stock.ts';
import { routes } from '../../api/routes.ts';
import { stockRoutes } from './routes.ts';
import { APRIL, stockScenario, type StockKit } from './testkit.ts';

const NAMES = [
  'stock.summary',
  'stock.categorySummary',
  'stock.itemVouchers',
  'stock.godownSummary',
  'stock.movement',
  'stock.ageing',
  'stock.reorder',
  'stock.negative',
  'stock.batches',
  'stock.pendingOrders',
  'stock.profitability',
  'stock.physicalVariance',
];

test('every stock route is read-only (transactional: false), reports.view (profitability: reports.financial), and registered in the API', () => {
  assert.deepEqual(Object.keys(stockRoutes).sort(), [...NAMES].sort());
  for (const [name, r] of Object.entries(stockRoutes)) {
    assert.equal(r.transactional, false, name);
    assert.equal(r.access, name === 'stock.profitability' ? 'reports.financial' : 'reports.view', name);
    assert.equal(r.scope, 'company', name);
    assert.ok(name in routes, `${name} is in the route aggregator`);
  }
});

describe('stock routes through the dispatcher', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('summary, item vouchers and pending orders answer with the service results', async () => {
    const s = await k.t.callOk<StockSummaryResult>(stockRoutes, 'stock.summary', { ...APRIL });
    assert.equal(s.totals.closingValue, 3_93_262);
    const iv = await k.t.callOk<StockItemVouchersResult>(stockRoutes, 'stock.itemVouchers', { itemId: k.I.A, ...APRIL });
    assert.equal(iv.closing.value, 95_466);
    const po = await k.t.callOk<PendingOrdersResult>(stockRoutes, 'stock.pendingOrders', { kind: 'purchase', asOf: '2026-06-30' });
    assert.equal(po.totals.pendingValue, 3_60_000);
  });

  test('every route runs on the scenario without error', async () => {
    const inputs: Record<string, unknown> = {
      'stock.summary': { ...APRIL, showZero: true },
      'stock.categorySummary': APRIL,
      'stock.itemVouchers': { itemId: k.I.R, from: '2026-04-01', to: '2026-06-30' },
      'stock.godownSummary': { asOf: '2026-06-30' },
      'stock.movement': { from: '2026-04-01', to: '2026-06-30', groupId: k.groups.kitchen },
      'stock.ageing': { asOf: '2026-06-30', buckets: [15, 45] },
      'stock.reorder': { asOf: '2026-06-30' },
      'stock.negative': { asOf: '2026-06-30' },
      'stock.batches': { asOf: '2026-06-30', expiringWithinDays: 20 },
      'stock.pendingOrders': { kind: 'sales', asOf: '2026-06-30' },
      'stock.profitability': { from: '2026-04-01', to: '2026-06-30' },
      'stock.physicalVariance': { from: '2026-04-01', to: '2026-06-30' },
    };
    for (const name of NAMES) {
      const r = await k.t.call(stockRoutes, name, inputs[name]);
      assert.equal(r.ok, true, `${name}: ${r.ok ? '' : r.error.message}`);
    }
  });

  test('a user without reports.view is refused', async () => {
    const session = k.t.sessionAs({ permissions: ['company.view', 'vouchers.view'] });
    const r = await k.t.call(stockRoutes, 'stock.summary', APRIL, { session });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN');
    const de = await k.t.call(stockRoutes, 'stock.summary', APRIL, { session: k.t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(de.ok, true, 'Data Entry holds reports.view');
  });

  test('item margins need reports.financial: Data Entry is refused Item Profitability, an Accountant is not', async () => {
    const de = await k.t.call(stockRoutes, 'stock.profitability', APRIL, { session: k.t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(de.ok, false);
    if (!de.ok) assert.equal(de.error.code, 'FORBIDDEN');
    const acc = await k.t.call(stockRoutes, 'stock.profitability', APRIL, { session: k.t.sessionAs({ permissions: ['company.view', 'reports.view', 'reports.financial'] }) });
    assert.equal(acc.ok, true);
  });

  test('bad input: field paths for the user', async () => {
    const rev = await k.t.call(stockRoutes, 'stock.summary', { from: '2026-04-30', to: '2026-04-01' });
    assert.equal(rev.ok, false);
    if (!rev.ok) {
      assert.equal(rev.error.code, 'VALIDATION');
      assert.deepEqual((rev.error.details as Array<{ path: string }>).map((d) => d.path), ['to']);
    }
    const kind = await k.t.call(stockRoutes, 'stock.pendingOrders', { kind: 'job_work', asOf: '2026-06-30' });
    assert.equal(kind.ok, false);
    if (!kind.ok) assert.deepEqual((kind.error.details as Array<{ path: string }>).map((d) => d.path), ['kind']);
    const buckets = await k.t.call(stockRoutes, 'stock.ageing', { asOf: '2026-06-30', buckets: [0] });
    assert.equal(buckets.ok, false);
    if (!buckets.ok) assert.deepEqual((buckets.error.details as Array<{ path: string }>).map((d) => d.path), ['buckets[0]']);
    const item = await k.t.call(stockRoutes, 'stock.itemVouchers', { itemId: 99_999, ...APRIL });
    assert.equal(item.ok, false);
    if (!item.ok) assert.equal(item.error.code, 'NOT_FOUND');
  });

  test('reports never write: the database is unchanged after running every report', async () => {
    const count = (): number => k.t.db.value<number>('SELECT COUNT(*) FROM audit_log') ?? 0;
    const before = count();
    await k.t.callOk(stockRoutes, 'stock.profitability', { from: '2026-04-01', to: '2026-06-30' });
    await k.t.callOk(stockRoutes, 'stock.godownSummary', { asOf: '2026-06-30' });
    assert.equal(count(), before);
  });
});
