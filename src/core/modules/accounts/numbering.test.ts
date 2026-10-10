/**
 * 2.0 (WP-04): invoice number series — numberingStatus, setNextNumber, numberGaps — through the real
 * routes, their SQL plans, restart seeding, and migration 250 (vouchers.renumber for the Accountant).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSIONS, SYSTEM_ROLES } from '../../../shared/constants.ts';
import type { NumberGapsResult, NumberingStatusRow, SetNextNumberResult, VoucherRuleErrorDetails } from '../../../shared/types/vouchers.ts';
import { migration250 } from '../../db/migrations/250_renumber.ts';
import { allPlanProblems, recordSql } from '../../testing/sqlPlans.ts';
import { salesInput, save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { numberGaps, numberingStatus } from './numbering.ts';
import { accountsRoutes } from './routes.ts';
import { saveVoucherType } from './voucherTypes.ts';

const configureSales = (k: Kit, cols: Record<string, string | number | null>): void => {
  for (const [col, value] of Object.entries(cols)) {
    // Column names come from this test file only (fixed identifiers), values are bound.
    k.t.db.run(`UPDATE voucher_types SET ${col} = :v WHERE id = :id`, { v: value, id: k.vt.sales });
  }
};

const status = (k: Kit, date = k.t.today): Promise<NumberingStatusRow[]> =>
  k.t.callOk<NumberingStatusRow[]>(accountsRoutes, 'accounts.voucherType.numberingStatus', { ids: [k.vt.sales], date });

describe('accounts.voucherType.numberingStatus', () => {
  it('reports the counter, the highest number used, the next number and the vouchers of the period', async () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INV/{FY}/', numbering_width: 4 });
    assert.deepEqual(await status(k), [
      { id: k.vt.sales, periodKey: '2026-27', periodLabel: 'FY 2026-27', counter: 0, highestUsed: null, nextSeq: 1, next: 'INV/26-27/0001', vouchersInPeriod: 0 },
    ]);
    save(k, salesInput(k));
    save(k, salesInput(k, { numberOverride: { number: 'INV/26-27/0003' } }));
    const [s] = await status(k);
    assert.deepEqual([s.counter, s.highestUsed, s.nextSeq, s.next, s.vouchersInPeriod], [1, 3, 2, 'INV/26-27/0002', 2]);
    save(k, salesInput(k));
    const [t] = await status(k);
    assert.deepEqual([t.counter, t.highestUsed, t.nextSeq, t.next], [2, 3, 4, 'INV/26-27/0004'], 'the typed 0003 is skipped');
    // Every type when no ids are given; manual types have no next number.
    configureSales(k, { numbering_method: 'manual' });
    const all = numberingStatus(k.t.db, { date: k.t.today });
    assert.ok(all.length >= 18, String(all.length));
    const sales = all.find((r) => r.id === k.vt.sales);
    assert.equal(sales?.next, '');
    // Monthly series: the month's label.
    configureSales(k, { numbering_method: 'automatic', numbering_restart: 'monthly', numbering_prefix: 'S/{MM}/' });
    assert.equal((await status(k))[0].periodLabel, 'Apr 2026');
    k.t.close();
  });
});

describe('accounts.voucherType.setNextNumber', () => {
  it('raises the next number (confirming the skipped numbers), lowers it (used numbers skipped) and audits the counter', async () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INV/', numbering_width: 3 });
    for (let i = 0; i < 7; i++) save(k, salesInput(k));
    // Setting exactly the next number needs no confirmation.
    assert.deepEqual(await k.t.callOk<SetNextNumberResult>(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 8 }), { next: 'INV/008', warnings: [] });
    // Raise 8 → 12: numbers 8–11 are never issued — confirm first.
    const first = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 12 });
    assert.equal(first.ok, false);
    const details = (first.ok ? null : first.error.details) as VoucherRuleErrorDetails;
    assert.equal(details.needsConfirmation, true);
    assert.deepEqual(details.warnings.map((w) => [w.code, w.level, w.message]), [
      ['numbering', 'confirm', 'Numbers 8–11 will not be issued; report them in GSTR-1 Table 13.'],
    ]);
    const up = await k.t.callOk<SetNextNumberResult>(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 12, acknowledgeWarnings: true });
    assert.equal(up.next, 'INV/012');
    assert.equal(save(k, salesInput(k)).number, 'INV/012');
    const log = k.t.db.get<{ before_json: string; after_json: string; entity_label: string }>(
      `SELECT before_json, after_json, entity_label FROM audit_log WHERE entity_type = 'voucher_type' AND entity_id = :id ORDER BY id DESC LIMIT 1`,
      { id: k.vt.sales },
    );
    assert.deepEqual(JSON.parse(log?.after_json ?? '{}').counter, { periodKey: '2026-27', lastNumber: 11, from: 7, to: 11 });
    assert.deepEqual(JSON.parse(log?.before_json ?? '{}').counter, { periodKey: '2026-27', lastNumber: 7 });
    assert.match(log?.entity_label ?? '', /next number INV\/012/);

    // Lower to 5: 5–7 and 12 are used — confirm; allocation then skips them (5, 6, 7 taken → 8).
    const low = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 5 });
    assert.match(low.ok ? '' : low.error.message, /Numbers already used will be skipped automatically/);
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 5, acknowledgeWarnings: true });
    assert.equal(k.t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :id AND period_key = '2026-27'`, { id: k.vt.sales }), 4, 'the counter can go down');
    assert.equal(save(k, salesInput(k)).number, 'INV/008');
    assert.equal(save(k, salesInput(k)).number, 'INV/009');

    // 1–9 and 12 are used; the series gives INV/010 next. Raising to 13 skips 10 and 11 (12 is used):
    // confirm first — the warning counts from the real next number, not from the highest used one.
    const skip = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 13 });
    assert.deepEqual(((skip.ok ? null : skip.error.details) as VoucherRuleErrorDetails).warnings.map((w) => w.message), [
      'Unused numbers 10–12 will not be issued; report them in GSTR-1 Table 13.',
    ]);
    // Back to the real next number: only the "already used" confirmation (12 is above it), no skip.
    const back = await k.t.callOk<SetNextNumberResult>(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 10, acknowledgeWarnings: true });
    assert.deepEqual(back, { next: 'INV/010', warnings: ['Numbers up to INV/012 are already used in FY 2026-27. Numbers already used will be skipped automatically.'] });
    k.t.close();
  });

  it('a lower setting that still leaves an unused number behind a typed one warns about the skipped number', async () => {
    const k = setupKit();
    for (let i = 0; i < 7; i++) save(k, salesInput(k));
    // A typed number above the counter (counter stays 7): 10 is used, 8 and 9 are free.
    save(k, salesInput(k, { numberOverride: { number: '10' } }));
    const r = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 9 });
    assert.deepEqual(((r.ok ? null : r.error.details) as VoucherRuleErrorDetails).warnings.map((w) => w.message), [
      'Numbers up to 10 are already used in FY 2026-27. Numbers already used will be skipped automatically.',
      'Number 8 will not be issued; report it in GSTR-1 Table 13.',
    ]);
    k.t.close();
  });

  it('validates the number, the GST format and the series, and needs vouchers.renumber', async () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INVOICE/2026-27/', numbering_width: 0 });
    const long = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 1000 });
    assert.equal(long.ok ? 'ok' : long.error.code, 'VALIDATION');
    assert.match(long.ok ? '' : long.error.message, /INVOICE\/2026-27\/1000: GST invoice numbers can have at most 16 characters/);
    const zero = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 0 });
    assert.equal(zero.ok ? 'ok' : zero.error.code, 'VALIDATION');
    configureSales(k, { numbering_prefix: null, numbering_start: 100 });
    const belowStart = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 50 });
    assert.match(belowStart.ok ? '' : belowStart.error.message, /start at 100/);
    configureSales(k, { numbering_method: 'manual' });
    const manual = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 150 });
    assert.equal(manual.ok ? 'ok' : manual.error.code, 'BUSINESS_RULE');
    configureSales(k, { numbering_method: 'automatic' });
    // Data Entry and the Auditor cannot; the Accountant can.
    for (const role of ['Data Entry', 'Auditor']) {
      const r = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 150, acknowledgeWarnings: true }, { session: k.t.sessionAs({ role }) });
      assert.equal(r.ok ? 'ok' : r.error.code, 'FORBIDDEN', role);
    }
    const acc = await k.t.call(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 150, acknowledgeWarnings: true }, { session: k.t.sessionAs({ role: 'Accountant' }) });
    assert.equal(acc.ok ? 'ok' : acc.error.message, 'ok');
    k.t.close();
  });
});

describe('accounts.voucherType.numberGaps', () => {
  it('lists the missing numbers between the first and the last (≤ 200) with counts; cancelled numbers are issued, not missing', async () => {
    const k = setupKit({ today: '2026-06-30' });
    configureSales(k, { numbering_prefix: 'G/', numbering_width: 3 });
    const seqs = [1, 2, 5, 6, 9];
    const ids: number[] = [];
    for (const n of seqs) ids.push(save(k, salesInput(k, { date: '2026-05-10', numberOverride: { number: `G/${String(n).padStart(3, '0')}` } })).id);
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.numberGaps', { id: k.vt.sales, from: '2026-04-01', to: '2026-06-30' });
    k.t.db.run('UPDATE vouchers SET is_cancelled = 1, affects_books = 0 WHERE id = :id', { id: ids[3] });
    const g = await k.t.callOk<NumberGapsResult>(accountsRoutes, 'accounts.voucherType.numberGaps', { id: k.vt.sales, from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(g, { first: 'G/001', last: 'G/009', issued: 5, cancelled: 1, missing: ['G/003', 'G/004', 'G/007', 'G/008'], missingCount: 4 });
    // Bounded by the date range.
    const none = await k.t.callOk<NumberGapsResult>(accountsRoutes, 'accounts.voucherType.numberGaps', { id: k.vt.sales, from: '2026-06-01', to: '2026-06-30' });
    assert.deepEqual(none, { first: null, last: null, issued: 0, cancelled: 0, missing: [], missingCount: 0 });
    // A huge jump: the count is exact, the list stops at 200.
    save(k, salesInput(k, { date: '2026-05-11', numberOverride: { number: 'G/5000' } }));
    const big = numberGaps(k.t.db, { id: k.vt.sales, from: '2026-04-01', to: '2026-06-30' });
    assert.equal(big.missingCount, 4 + 4990);
    assert.equal(big.missing.length, 200);
    assert.equal(big.last, 'G/5000');
    const bad = await k.t.call(accountsRoutes, 'accounts.voucherType.numberGaps', { id: k.vt.sales, from: '2026-06-30', to: '2026-04-01' });
    assert.equal(bad.ok ? 'ok' : bad.error.code, 'VALIDATION');
    k.t.close();
  });

  it('a monthly series finds gaps per month (each month restarts)', () => {
    const k = setupKit({ today: '2026-06-30' });
    configureSales(k, { numbering_restart: 'monthly', numbering_prefix: 'M/{MM}/' });
    save(k, salesInput(k, { date: '2026-04-10' }));
    save(k, salesInput(k, { date: '2026-04-11', numberOverride: { number: 'M/04/3' } }));
    save(k, salesInput(k, { date: '2026-05-10' }));
    save(k, salesInput(k, { date: '2026-05-11' }));
    const g = numberGaps(k.t.db, { id: k.vt.sales, from: '2026-04-01', to: '2026-05-31' });
    assert.deepEqual(g, { first: 'M/04/1', last: 'M/05/2', issued: 4, cancelled: 0, missing: ['M/04/2'], missingCount: 1 });
    k.t.close();
  });
});

describe('numbering routes: SQL plans (no scan of the books)', () => {
  it('numberingStatus, setNextNumber, numberGaps and numberCheck look rows up through indexes', async () => {
    const k = setupKit();
    for (let i = 0; i < 3; i++) save(k, salesInput(k));
    const { vouchersRoutes } = await import('../vouchers/routes.ts');
    const rec = recordSql(k.t.db);
    rec.start();
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.numberingStatus', { date: k.t.today });
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.setNextNumber', { id: k.vt.sales, date: k.t.today, next: 4 });
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.numberGaps', { id: k.vt.sales, from: '2026-04-01', to: '2027-03-31' });
    await k.t.callOk(vouchersRoutes, 'vouchers.numberCheck', { voucherTypeId: k.vt.sales, date: k.t.today, number: '2' });
    const statements = rec.stop();
    assert.ok(statements.length > 0);
    assert.deepEqual(allPlanProblems(k.t.db, statements, 'numbering'), []);
    k.t.close();
  });
});

describe('restart seeding (voucher type save)', () => {
  it('a restart change starts the new period counter at the highest number used in its scope, never lowering it', () => {
    const k = setupKit();
    for (let i = 0; i < 5; i++) save(k, salesInput(k));
    saveVoucherType(k.t.ctx, { id: k.vt.sales, numbering: { restart: 'never' } });
    assert.equal(k.t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :id AND period_key = 'all'`, { id: k.vt.sales }), 5);
    assert.equal(save(k, salesInput(k)).number, '6');
    // Back to yearly: the FY counter is already 5 → MAX keeps 6 (the never-series' sixth voucher counts too).
    saveVoucherType(k.t.ctx, { id: k.vt.sales, numbering: { restart: 'yearly' } });
    assert.equal(k.t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :id AND period_key = '2026-27'`, { id: k.vt.sales }), 6);
    // Unchanged restart: no seeding write.
    k.t.db.run(`UPDATE voucher_counters SET last_number = 2 WHERE voucher_type_id = :id AND period_key = '2026-27'`, { id: k.vt.sales });
    saveVoucherType(k.t.ctx, { id: k.vt.sales, numbering: { width: 2 } });
    assert.equal(k.t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :id AND period_key = '2026-27'`, { id: k.vt.sales }), 2);
    k.t.close();
  });
});

describe('restart seeding: numbers of another year`s format do not make the series jump', () => {
  it('INV/{FY}/ switched yearly → never continues this year`s numbers, not last year`s higher ones', () => {
    const k = setupKit({ today: '2027-04-15', booksFrom: '2026-04-01' });
    configureSales(k, { numbering_prefix: 'INV/{FY}/', numbering_width: 4 });
    for (let i = 0; i < 5; i++) save(k, salesInput(k, { date: '2026-06-01' }));
    save(k, salesInput(k));
    save(k, salesInput(k));
    saveVoucherType(k.t.ctx, { id: k.vt.sales, numbering: { restart: 'never' } });
    assert.equal(k.t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :id AND period_key = 'all'`, { id: k.vt.sales }), 2);
    assert.equal(save(k, salesInput(k)).number, 'INV/27-28/0003');
    k.t.close();
  });
});

describe('migration 250: vouchers.renumber', () => {
  it('grants the permission to the Accountant once (idempotent); Owner via all; Data Entry / Auditor / custom roles unchanged', () => {
    const k = setupKit();
    const perms = (name: string): string[] => JSON.parse(k.t.db.value<string>('SELECT permissions FROM roles WHERE name = :name', { name }) ?? '[]');
    // A company created by 1.0: the Accountant role without the new permission.
    const old = perms('Accountant').filter((p) => p !== 'vouchers.renumber');
    k.t.db.run(`UPDATE roles SET permissions = :p WHERE name = 'Accountant'`, { p: JSON.stringify(old) });
    k.t.db.run(`INSERT INTO roles (name, description, permissions, is_system, created_at, updated_at) VALUES ('Billing', 'custom', '["vouchers.view","vouchers.alter"]', 0, :ts, :ts)`, { ts: '2026-04-15T00:00:00.000Z' });
    const before = { de: perms('Data Entry'), au: perms('Auditor'), owner: k.t.db.value<string>(`SELECT permissions FROM roles WHERE name = 'Owner'`) };
    k.t.db.exec(migration250.sql);
    k.t.db.exec(migration250.sql);
    assert.deepEqual(perms('Accountant'), [...old, 'vouchers.renumber']);
    assert.deepEqual(perms('Data Entry'), before.de);
    assert.deepEqual(perms('Auditor'), before.au);
    assert.deepEqual(perms('Billing'), ['vouchers.view', 'vouchers.alter']);
    assert.equal(k.t.db.value<string>(`SELECT permissions FROM roles WHERE name = 'Owner'`), before.owner);
    // New companies: SYSTEM_ROLES already carry it for the Accountant; the Owner holds every permission.
    const role = (n: string) => SYSTEM_ROLES.find((r) => r.name === n)?.permissions;
    assert.ok((role('Accountant') as readonly string[]).includes('vouchers.renumber'));
    assert.equal(role('Owner'), 'all');
    assert.ok(PERMISSIONS.includes('vouchers.renumber'));
    assert.equal((role('Data Entry') as readonly string[]).includes('vouchers.renumber'), false);
    assert.equal((role('Auditor') as readonly string[]).includes('vouchers.renumber'), false);
    k.t.close();
  });
});
