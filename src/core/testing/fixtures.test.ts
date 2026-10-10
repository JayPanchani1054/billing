import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PREDEFINED_GROUPS } from '../../shared/constants.ts';
import { validateGstin } from '../../shared/gst/gstin.ts';
import { companyRoute, type RouteMap } from '../api/route.ts';
import { verifyAuditChain } from '../lib/audit.ts';
import { AppError } from '../lib/errors.ts';
import { v } from '../lib/validate.ts';
import { createTestCompany, makeGstin, testPan, TEST_OWNER_USERNAME } from './fixtures.ts';

describe('createTestCompany', () => {
  it('seeds a GST company with strict id maps', () => {
    const t = createTestCompany();
    assert.equal(t.today, '2026-04-15');
    assert.equal(t.booksFrom, '2026-04-01');
    assert.equal(Object.keys(t.ids.groups).length, PREDEFINED_GROUPS.length);
    assert.equal(t.db.value('SELECT reserved_code FROM ledgers WHERE id = :id', { id: t.ids.ledgers.OUTPUT_CGST }), 'OUTPUT_CGST');
    assert.equal(t.db.value('SELECT base_type FROM voucher_types WHERE id = :id', { id: t.ids.voucherTypes.sales }), 'sales');
    assert.equal(t.db.value('SELECT symbol FROM units WHERE id = :id', { id: t.ids.units.Kg }), 'Kg');
    assert.throws(() => t.ids.units.Furlong, /unit "Furlong" does not exist/);
    assert.equal(t.ctx.company.gstEnabled, true);
    assert.equal(t.ctx.session.implicit, true);
    assert.equal(t.ctx.clock.today(), '2026-04-15');
    t.close();
  });

  it('builds a non-GST company whose GST ledger lookups fail loudly', () => {
    const t = createTestCompany({ gst: false, stateCode: '07', today: '2027-01-10' });
    assert.equal(t.booksFrom, '2026-04-01');
    assert.equal(t.ctx.company.gstEnabled, false);
    assert.equal(t.db.value('SELECT gstin FROM company'), null);
    assert.ok(t.ids.ledgers.CASH > 0);
    assert.throws(() => t.ids.ledgers.OUTPUT_IGST, /GST is disabled/);
    t.close();
  });

  it('can run as a secured company with a real Owner user', () => {
    const t = createTestCompany({ security: true });
    assert.equal(t.ctx.session.username, TEST_OWNER_USERNAME);
    assert.equal(t.ctx.session.implicit, false);
    assert.equal(t.ctx.session.isOwner, true);
    assert.equal(t.ctx.company.securityEnabled, true);
    t.ctx.audit({ action: 'create', entityType: 'test' });
    assert.equal(t.db.value('SELECT user_id FROM audit_log'), t.ids.ownerUserId);
    t.close();
  });

  it('addLedger applies party defaults from the GSTIN and features', () => {
    const t = createTestCompany();
    const gstin = makeGstin('29', testPan(7));
    const id = t.addLedger({
      name: 'Bengaluru Distributors',
      group: 'SUNDRY_DEBTORS',
      gstin,
      openingBalance: 1_50_000_00,
      openingBills: [{ name: 'INV-99', date: '2026-03-15', amount: 1_50_000_00, dueDate: '2026-04-14' }],
    });
    const row = t.db.get<Record<string, unknown>>('SELECT * FROM ledgers WHERE id = :id', { id });
    assert.equal(row?.group_id, t.ids.groups.SUNDRY_DEBTORS);
    assert.equal(row?.state_code, '29');
    assert.equal(row?.gst_registration_type, 'regular');
    assert.equal(row?.pan, testPan(7));
    assert.equal(row?.maintain_bill_wise, 1);
    assert.equal(row?.opening_balance, 15_000_000);
    assert.equal(t.db.value('SELECT amount FROM opening_bills WHERE ledger_id = :id', { id }), 15_000_000);

    const walkIn = t.addLedger({ name: 'Walk-in Customer', group: 'SUNDRY_DEBTORS', billWise: false });
    assert.deepEqual(t.db.get('SELECT state_code, gst_registration_type, maintain_bill_wise FROM ledgers WHERE id = :id', { id: walkIn }), {
      state_code: '27',
      gst_registration_type: 'unregistered',
      maintain_bill_wise: 0,
    });
    t.close();
  });

  it('addLedger supports sales ledgers with GST details and raw column overrides', () => {
    const t = createTestCompany();
    const id = t.addLedger({ name: 'Sales @ 5%', group: 'SALES_ACCOUNTS', gstRate: 5, hsnSac: '1006', columns: { notes: 'rice' } });
    assert.deepEqual(t.db.get('SELECT gst_applicable, gst_taxability, gst_rate, inventory_values_affected, notes FROM ledgers WHERE id = :id', { id }), {
      gst_applicable: 'applicable',
      gst_taxability: 'taxable',
      gst_rate: 5,
      inventory_values_affected: 1,
      notes: 'rice',
    });
    assert.deepEqual(t.db.get(`SELECT applicable_from, rate FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id`, { id }), {
      applicable_from: '2026-04-01',
      rate: 5,
    });
    assert.throws(() => t.addLedger({ name: 'X', group: 'SALES_ACCOUNTS', columns: { no_such_column: 1 } }), /unknown column/);
    assert.throws(() => t.addLedger({ name: 'Sales @ 5%', group: 'SALES_ACCOUNTS' }), /UNIQUE/);
    t.close();
  });

  it('addStockItem creates the item, GST history and opening stock in the main godown', () => {
    const t = createTestCompany();
    const id = t.addStockItem({ name: 'Basmati Rice', unit: 'Kg', gstRate: 5, hsnSac: '1006', openingQty: 12.5, openingRate: 80.4, sellingPrice: 95_00 });
    assert.deepEqual(t.db.get('SELECT unit_id, gst_rate, hsn_sac, selling_price FROM stock_items WHERE id = :id', { id }), {
      unit_id: t.ids.units.Kg,
      gst_rate: 5,
      hsn_sac: '1006',
      selling_price: 9500,
    });
    // 12.5 × 80.40 = 1,005.00 → 100500 paise
    assert.deepEqual(t.db.get('SELECT godown_id, qty, rate, value FROM stock_openings WHERE item_id = :id', { id }), {
      godown_id: t.ids.mainGodownId,
      qty: 12.5,
      rate: 80.4,
      value: 100500,
    });
    const service = t.addStockItem({ name: 'Installation', isService: true, gstRate: 18, unit: 'Hrs' });
    assert.equal(t.db.value('SELECT COUNT(*) FROM stock_openings WHERE item_id = :id', { id: service }), 0);
    t.close();
  });

  it('call() goes through the real dispatcher; ctxAs()/sessionAs() limit permissions', async () => {
    const t = createTestCompany();
    const routes = {
      'demo.write': companyRoute({
        access: 'masters.create',
        input: v.object({ name: v.string({ min: 1 }) }),
        handler: (ctx, input) => {
          ctx.audit({ action: 'create', entityType: 'demo', entityLabel: input.name });
          return { by: ctx.session.username };
        },
      }),
    } satisfies RouteMap;
    assert.deepEqual(await t.callOk(routes, 'demo.write', { name: 'a' }), { by: 'owner' });
    const auditor = t.sessionAs({ role: 'Auditor' });
    const r = await t.call(routes, 'demo.write', { name: 'b' }, { session: auditor });
    assert.equal(!r.ok && r.error.code, 'FORBIDDEN');
    assert.equal(!(await t.call(routes, 'demo.write', { name: 'b' }, { session: null })).ok, true);
    await assert.rejects(t.callOk(routes, 'demo.write', { name: '' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
    const clerk = t.ctxAs({ permissions: ['masters.create'], username: 'clerk' });
    clerk.audit({ action: 'alter', entityType: 'demo' });
    assert.equal(t.db.value('SELECT username FROM audit_log ORDER BY id DESC LIMIT 1'), 'clerk');
    assert.deepEqual(verifyAuditChain(t.db), { ok: true, count: 2 });
    t.close();
  });

  it('the clock can be moved for date-sensitive tests', () => {
    const t = createTestCompany();
    t.clock.setToday('2026-05-20');
    assert.equal(t.today, '2026-05-20');
    assert.equal(t.ctx.clock.today(), '2026-05-20');
    t.clock.advance(36 * 3600_000);
    assert.equal(t.today, '2026-05-21');
    t.close();
  });

  it('lazily provides temp folders for code that writes files', () => {
    const t = createTestCompany();
    const dir = t.ctx.company.dir;
    assert.ok(dir.includes('pevqori-test-'));
    t.close();
  });
});

describe('makeGstin', () => {
  it('produces checksum-valid GSTINs', () => {
    for (const state of ['01', '07', '27', '29', '33', '37']) {
      const g = makeGstin(state);
      assert.equal(validateGstin(g).valid, true, g);
      assert.equal(g.slice(0, 2), state);
    }
    assert.equal(makeGstin('27'), '27AAPFU0939F1ZV', 'matches a published sample GSTIN');
    assert.equal(validateGstin(makeGstin('29', testPan(42), '2')).valid, true);
  });
});
