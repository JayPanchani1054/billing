/**
 * GST rate resolution precedence (taxprofile.ts) — item override → item history → item columns →
 * stock group chain → sales/purchase ledger → 0% with a warning; ledger lines: override → history →
 * columns → non-GST.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dbTaxLookup, resolveItemTaxProfile, resolveLedgerTaxProfile } from './taxprofile.ts';
import { gstLines, salesInput, save, setupKit, type Kit } from './testkit.ts';

function history(k: Kit, entityType: 'stock_item' | 'stock_group' | 'ledger', id: number, from: string, rate: number, hsn: string | null = null, taxability = 'taxable'): void {
  k.t.db.run(
    `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate) VALUES (:t, :id, :from, :hsn, :tax, :rate, 0)`,
    { t: entityType, id, from, hsn, tax: taxability, rate },
  );
}

function stockGroup(k: Kit, name: string, parentId: number | null, cols: { gst_applicable?: string; gst_rate?: number | null; hsn_sac?: string | null } = {}): number {
  const ts = k.t.clock.now().toISOString();
  return k.t.db.run(
    `INSERT INTO stock_groups (guid, name, parent_id, gst_applicable, gst_rate, hsn_sac, created_at, updated_at)
     VALUES (:g, :n, :p, :app, :rate, :hsn, :ts, :ts)`,
    { g: `sg-${name}`, n: name, p: parentId, app: cols.gst_applicable ?? 'not_applicable', rate: cols.gst_rate ?? null, hsn: cols.hsn_sac ?? null, ts },
  ).lastInsertRowid;
}

describe('item tax profile', () => {
  it('effective-dated item history wins over the item columns; the latest row on or before the date applies', () => {
    const k = setupKit();
    const item = k.t.addStockItem({ name: 'Biscuits', gstRate: 18, hsnSac: '1905' }); // history 18% from 01-Apr-2026
    history(k, 'stock_item', item, '2026-06-01', 5);
    const at = (date: string) => resolveItemTaxProfile(dbTaxLookup(k.t.db), { itemId: item, date, ledgerId: k.L.sales });
    assert.deepEqual([at('2026-05-31').rate, at('2026-05-31').source], [18, 'item_history']);
    assert.deepEqual([at('2026-06-01').rate, at('2026-06-01').hsnSac], [5, '1905'], 'HSN falls back to the item when the history row has none');
    // The voucher engine uses the rate in force on the voucher date.
    const before = save(k, salesInput(k, { date: '2026-05-31', items: [{ itemId: item, qty: 1, rate: 100 }] }));
    const after = save(k, salesInput(k, { date: '2026-06-02', items: [{ itemId: item, qty: 1, rate: 100 }] }));
    assert.equal(gstLines(k, before.id)[0].rate, 18);
    assert.equal(gstLines(k, after.id)[0].rate, 5);
    k.t.close();
  });

  it('line override beats everything but keeps the HSN', () => {
    const k = setupKit();
    const p = resolveItemTaxProfile(dbTaxLookup(k.t.db), { itemId: k.I.mixer, date: k.t.today, ledgerId: k.L.sales, gstRateOverride: 5 });
    assert.deepEqual([p.rate, p.taxability, p.hsnSac, p.source, p.missing], [5, 'taxable', '8509', 'override', false]);
    k.t.close();
  });

  it('item columns apply when there is no history', () => {
    const k = setupKit();
    const item = k.t.addStockItem({ name: 'Plain', columns: { gst_rate: 12, hsn_sac: '3004' } });
    const p = resolveItemTaxProfile(dbTaxLookup(k.t.db), { itemId: item, date: k.t.today });
    assert.deepEqual([p.rate, p.hsnSac, p.source], [12, '3004', 'item']);
    const exempt = k.t.addStockItem({ name: 'Fresh Milk', columns: { gst_taxability: 'exempt', hsn_sac: '0401' } });
    const e = resolveItemTaxProfile(dbTaxLookup(k.t.db), { itemId: exempt, date: k.t.today });
    assert.deepEqual([e.taxability, e.rate, e.source], ['exempt', 0, 'item']);
    k.t.close();
  });

  it('walks the stock group chain (nearest first: history, then columns)', () => {
    const k = setupKit();
    const parent = stockGroup(k, 'Electronics', null, { gst_applicable: 'applicable', gst_rate: 18, hsn_sac: '8500' });
    const child = stockGroup(k, 'Small Appliances', parent);
    const item = k.t.addStockItem({ name: 'Toaster', groupId: child });
    const lookup = () => dbTaxLookup(k.t.db);
    let p = resolveItemTaxProfile(lookup(), { itemId: item, date: k.t.today, ledgerId: k.L.sales });
    assert.deepEqual([p.rate, p.hsnSac, p.source], [18, '8500', 'stock_group']);
    history(k, 'stock_group', child, '2026-04-01', 28, '8516');
    p = resolveItemTaxProfile(lookup(), { itemId: item, date: k.t.today, ledgerId: k.L.sales });
    assert.deepEqual([p.rate, p.hsnSac, p.source], [28, '8516', 'stock_group_history']);
    k.t.close();
  });

  it('falls back to the sales ledger, then to 0% with missing: true', () => {
    const k = setupKit();
    const item = k.t.addStockItem({ name: 'Mystery Box', hsnSac: '9999' });
    const ledger = k.t.addLedger({ name: 'Sales @12%', group: 'SALES_ACCOUNTS', gstRate: 12 });
    const viaLedger = resolveItemTaxProfile(dbTaxLookup(k.t.db), { itemId: item, date: k.t.today, ledgerId: ledger });
    assert.deepEqual([viaLedger.rate, viaLedger.source, viaLedger.hsnSac], [12, 'ledger_history', '9999']);
    // The reserved Sales ledger is GST-applicable but has no rate: not a resolution.
    const none = resolveItemTaxProfile(dbTaxLookup(k.t.db), { itemId: item, date: k.t.today, ledgerId: k.L.sales });
    assert.deepEqual([none.rate, none.taxability, none.source, none.missing], [0, 'taxable', 'default', true]);
    k.t.close();
  });
});

describe('ledger tax profile', () => {
  it('history → columns → non-GST, with overrides merged on top', () => {
    const k = setupKit();
    const lookup = () => dbTaxLookup(k.t.db);
    const consult = resolveLedgerTaxProfile(lookup(), { ledgerId: k.L.consult, date: k.t.today });
    assert.deepEqual([consult.rate, consult.hsnSac, consult.supplyKind, consult.source], [18, '998311', 'services', 'ledger_history']);
    const rent = resolveLedgerTaxProfile(lookup(), { ledgerId: k.L.rent, date: k.t.today });
    assert.deepEqual([rent.taxability, rent.rate, rent.source], ['non_gst', 0, 'not_applicable']);
    const overridden = resolveLedgerTaxProfile(lookup(), { ledgerId: k.L.rent, date: k.t.today, override: { rate: 18, hsnSac: '997212', supplyKind: 'services' } });
    assert.deepEqual([overridden.taxability, overridden.rate, overridden.hsnSac, overridden.supplyKind, overridden.source], ['taxable', 18, '997212', 'services', 'override']);
    const exempt = resolveLedgerTaxProfile(lookup(), { ledgerId: k.L.consult, date: k.t.today, override: { taxability: 'exempt' } });
    assert.deepEqual([exempt.taxability, exempt.rate, exempt.hsnSac], ['exempt', 0, '998311']);
    const cols = k.t.addLedger({ name: 'Commission Income', group: 'INDIRECT_INCOMES', columns: { gst_applicable: 'applicable', gst_taxability: 'taxable', gst_rate: 18, hsn_sac: '996111' } });
    const c = resolveLedgerTaxProfile(lookup(), { ledgerId: cols, date: k.t.today });
    assert.deepEqual([c.rate, c.source, c.supplyKind], [18, 'ledger', 'services']);
    k.t.close();
  });
});
