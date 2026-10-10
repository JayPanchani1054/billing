/**
 * API-level twin of the 2.0 invoice-numbering flows (WP-04; the screens come in WP-07 / WP-08), driven
 * through runtime.dispatch exactly as the Electron main process does:
 *
 *   company → party + item → Sales series "INV/{FY}/" width 4 → first sale INV/26-27/0001
 *   → set next number 41 (confirm the skipped 2–40) → INV/26-27/0041
 *   → a sale with the user's own number A-100 (+ reason) → Day Book shows it → edit history records it
 *   → Voucher View renumbers a saved sale (entries / GST unchanged) → number check, gaps
 *   → GSTR-1 filed: renumbering asks to confirm and is logged as an amendment.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeGstin, testPan, TEST_PAN } from '../fixtures.ts';
import { startRuntime } from './harness.ts';
import type { E2E } from './harness.ts';

const TODAY = '2026-10-10';

interface Saved {
  id: number;
  number: string;
  updatedAt: string;
  warnings: Array<{ code: string; level: string; message: string }>;
}

describe('invoice numbering and renumbering (API twin)', () => {
  let e: E2E;
  let partyId = 0;
  let itemId = 0;
  let salesId = 0;
  let first: Saved;
  const sale = (over: Record<string, unknown> = {}) => ({
    voucherTypeId: salesId,
    date: TODAY,
    mode: 'item_invoice',
    partyLedgerId: partyId,
    items: [{ itemId, qty: 2, rate: 500 }],
    acknowledgeWarnings: true,
    ...over,
  });
  const detail = (id: number) =>
    e.call<{ number: string; updatedAt: string; entries: Array<{ ledgerId: number; amount: number }>; gstLines: Array<{ taxableValue: number; cgst: number; sgst: number }> }>('vouchers.get', { id });

  before(async () => {
    e = startRuntime(TODAY);
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Numbering Traders E2E',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false, gst: true },
    });
    const groups = await e.call<{ rows: Array<{ id: number; name: string }> }>('accounts.group.list', {});
    const debtors = groups.rows.find((g) => g.name === 'Sundry Debtors');
    assert.ok(debtors);
    partyId = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'Ravi Traders', groupId: debtors.id, gstin: makeGstin('27', testPan(2)), stateCode: '27', registrationType: 'regular' })).id;
    const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
    const nos = units.rows.find((u) => u.symbol === 'Nos');
    assert.ok(nos);
    itemId = (await e.call<{ item: { id: number } }>('inventory.item.save', { name: 'Steel Bolt M8', unitId: nos.id, gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7318', openings: [{ qty: 1000, rate: 100 }] })).item.id;
    const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
    const sales = types.rows.find((t) => t.baseType === 'sales' && t.isPredefined);
    assert.ok(sales);
    salesId = sales.id;
  });
  after(async () => {
    await e.close();
  });

  it('sets up the series INV/{FY}/0001 and shows its status', async () => {
    await e.call('accounts.voucherType.save', { id: salesId, numbering: { prefix: 'INV/{FY}/', width: 4 } });
    const [s] = await e.call<Array<{ periodLabel: string; next: string; counter: number }>>('accounts.voucherType.numberingStatus', { ids: [salesId], date: TODAY });
    assert.deepEqual([s.periodLabel, s.next, s.counter], ['FY 2026-27', 'INV/26-27/0001', 0]);
    first = await e.call<Saved>('vouchers.save', sale());
    assert.equal(first.number, 'INV/26-27/0001');
  });

  it('set next number 41: confirm the skipped numbers, then the next sale is INV/26-27/0041', async () => {
    const ask = await e.raw('accounts.voucherType.setNextNumber', { id: salesId, date: TODAY, next: 41 });
    assert.equal(ask.ok, false);
    if (!ask.ok) {
      assert.equal(ask.error.code, 'BUSINESS_RULE');
      assert.equal((ask.error.details as { needsConfirmation?: boolean }).needsConfirmation, true);
      assert.match(ask.error.message, /Numbers 2–40 will not be issued; report them in GSTR-1 Table 13/);
    }
    const r = await e.call<{ next: string }>('accounts.voucherType.setNextNumber', { id: salesId, date: TODAY, next: 41, acknowledgeWarnings: true });
    assert.equal(r.next, 'INV/26-27/0041');
    assert.equal((await e.call<Saved>('vouchers.save', sale())).number, 'INV/26-27/0041');
  });

  it('a sale with the user\'s own number A-100 (reason kept) shows in the Day Book and the edit history', async () => {
    const check = await e.call<{ ok: boolean; scopeLabel: string }>('vouchers.numberCheck', { voucherTypeId: salesId, date: TODAY, number: 'A-100' });
    assert.deepEqual([check.ok, check.scopeLabel], [true, 'FY 2026-27']);
    const s = await e.call<Saved>('vouchers.save', sale({ numberOverride: { number: 'A-100', reason: 'Matching the paper bill book' } }));
    assert.equal(s.number, 'A-100');
    const book = await e.call<{ rows: Array<{ id: number; number: string | null }> }>('vouchers.list', { from: TODAY, to: TODAY });
    assert.ok(book.rows.some((r) => r.id === s.id && r.number === 'A-100'));
    // The series goes on from 42: a typed number does not consume it.
    assert.equal((await e.call<Saved>('vouchers.save', sale())).number, 'INV/26-27/0042');
    const taken = await e.call<{ ok: boolean; taken: boolean }>('vouchers.numberCheck', { voucherTypeId: salesId, date: TODAY, number: 'A-100' });
    assert.deepEqual([taken.ok, taken.taken], [false, true]);
    const dup = await e.raw('vouchers.save', sale({ numberOverride: { number: 'A-100' } }));
    assert.equal(dup.ok ? 'ok' : dup.error.code, 'CONFLICT');
    const history = await e.call<{ versions: Array<{ action: string; changes: Array<{ path: string; after: unknown }> }> }>('security.audit.entityHistory', { entityType: 'voucher', entityId: s.id });
    const created = history.versions.find((v) => v.action === 'create');
    assert.ok(created?.changes.some((c) => c.path === 'numberOverride.reason' && c.after === 'Matching the paper bill book'), JSON.stringify(created?.changes.map((c) => c.path)));
  });

  it('Voucher View renumbers a saved sale: only the number changes; the edit history shows the change and the reason', async () => {
    const before = await detail(first.id);
    const r = await e.call<Saved>('vouchers.renumber', { id: first.id, number: 'INV/26-27/0141', reason: 'Reprinted', continueSeries: true, expectedUpdatedAt: before.updatedAt });
    assert.equal(r.number, 'INV/26-27/0141');
    const afterRenumber = await detail(first.id);
    assert.deepEqual(afterRenumber.entries.map((x) => [x.ledgerId, x.amount]), before.entries.map((x) => [x.ledgerId, x.amount]));
    assert.deepEqual(afterRenumber.gstLines.map((g) => [g.taxableValue, g.cgst, g.sgst]), before.gstLines.map((g) => [g.taxableValue, g.cgst, g.sgst]));
    // Continue the series from 141.
    assert.equal((await e.call<Saved>('vouchers.save', sale())).number, 'INV/26-27/0142');
    const history = await e.call<{ versions: Array<{ action: string; summary: string; changes: Array<{ path: string; before: unknown; after: unknown }> }> }>('security.audit.entityHistory', { entityType: 'voucher', entityId: first.id });
    const last = history.versions[history.versions.length - 1];
    assert.equal(last.action, 'alter');
    const byPath = new Map(last.changes.map((c) => [c.path, c]));
    assert.deepEqual([byPath.get('number')?.before, byPath.get('number')?.after], ['INV/26-27/0001', 'INV/26-27/0141']);
    assert.equal(byPath.get('numberChange.reason')?.after, 'Reprinted');
    // A view opened before someone else saved the voucher is refused (another updatedAt).
    const stale = await e.raw('vouchers.renumber', { id: first.id, number: 'INV/26-27/0150', expectedUpdatedAt: '2026-10-09T04:30:00.000Z' });
    assert.equal(stale.ok ? 'ok' : stale.error.code, 'CONFLICT');
  });

  it('number gaps of the year list the numbers never issued', async () => {
    const g = await e.call<{ first: string; last: string; issued: number; missingCount: number; missing: string[] }>('accounts.voucherType.numberGaps', { id: salesId, from: '2026-04-01', to: '2027-03-31' });
    // Issued in the format: 0041, 0042, 0141, 0142 (A-100 is outside the format). Missing: 0043–0140.
    assert.deepEqual([g.first, g.last, g.issued, g.missingCount], ['INV/26-27/0041', 'INV/26-27/0142', 4, 98]);
    assert.equal(g.missing[0], 'INV/26-27/0043');
  });

  it('after GSTR-1 is filed, renumbering an invoice of that month asks to confirm and is reported as an amendment', async () => {
    e.clock.setToday('2026-11-15');
    await e.call('gst.filing.mark', { form: 'gstr1', period: '102026', filedOn: '2026-11-11' });
    const target = await detail(first.id);
    const ask = await e.raw('vouchers.renumber', { id: first.id, number: 'INV/26-27/0200', expectedUpdatedAt: target.updatedAt });
    assert.equal(ask.ok, false);
    if (!ask.ok) {
      assert.equal((ask.error.details as { needsConfirmation?: boolean }).needsConfirmation, true);
      assert.match(ask.error.message, /GSTR-1 for Oct 2026 was filed/);
    }
    const r = await e.call<Saved>('vouchers.renumber', { id: first.id, number: 'INV/26-27/0200', expectedUpdatedAt: target.updatedAt, acknowledgeWarnings: true });
    assert.equal(r.number, 'INV/26-27/0200');
    const log = await e.call<Array<{ origNumber: string; kind: string }>>('gst.amendments.list', {});
    assert.ok(log.some((a) => a.origNumber === 'INV/26-27/0141' && a.kind === 'amended'), JSON.stringify(log));
  });
});
