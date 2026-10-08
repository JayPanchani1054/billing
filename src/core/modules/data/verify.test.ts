/**
 * 'data.verify': passes on clean books and names each kind of injected corruption.
 * Corruption is written with raw SQL on purpose — the services would never produce it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DataVerifyResult } from '../../../shared/types/data.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { dataRoutes } from './routes.ts';
import { verifyData } from './verify.ts';

let k: Kit;
let sale: number;
let receipt: number;
let journal: number;

beforeEach(() => {
  k = setupKit();
  // The kit's opening stock is 100 × ₹50 + 50 × ₹150 + 10 × ₹10 = ₹12,600 with no ledger openings:
  // balance it with the owner's capital so the openings agree.
  k.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -12_600_00, id: k.L.capital });
  // Mixer 2 × ₹150 = ₹300 + CGST 27 + SGST 27 = ₹354 to Acme (new ref S-…).
  sale = save(k, { voucherTypeId: k.vt.sales, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 2, rate: 150 }] }).id;
  const saleNo = k.t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id: sale }) ?? '';
  receipt = save(k, {
    voucherTypeId: k.vt.receipt,
    date: '2026-04-12',
    mode: 'ledger',
    ledgers: [
      { ledgerId: k.L.acme, amount: -354_00, billAllocations: [{ refType: 'against', billName: saleNo, amount: 354_00 }] },
      { ledgerId: k.L.bank, amount: 354_00 },
    ],
  }).id;
  journal = save(k, { voucherTypeId: k.vt.journal, date: '2026-04-13', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 500_00 }, { ledgerId: k.L.capital, amount: -500_00 }] }).id;
});
afterEach(() => k.t.close());

const run = (): DataVerifyResult => verifyData(k.t.ctx);
const failing = (r: DataVerifyResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const details = (r: DataVerifyResult, name: string): string => (r.checks.find((c) => c.name === name)?.details ?? []).join(' | ');

describe('data.verify', () => {
  it('passes every check on clean books', () => {
    const r = run();
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.deepEqual(
      r.checks.map((c) => c.name),
      [
        'integrity',
        'foreign_keys',
        'voucher_balance',
        'voucher_children',
        'bill_allocations',
        'cost_allocations',
        'inventory_direction',
        'gst_tax_postings',
        'orphans',
        'group_tree',
        'opening_difference',
        'audit_chain',
        'duplicate_numbers',
      ],
    );
    assert.equal(r.checkedAt, k.t.clock.now().toISOString());
  });

  it('flags a voucher whose entries do not sum to zero', () => {
    k.t.db.run('UPDATE ledger_entries SET amount = amount + 100 WHERE voucher_id = :id AND ledger_id = :l', { id: journal, l: k.L.rent });
    const r = run();
    assert.deepEqual(failing(r), ['voucher_balance']);
    assert.match(details(r, 'voucher_balance'), /out of balance by ₹ 1\.00 Dr/);
  });

  it('flags child rows whose date disagrees with their voucher', () => {
    k.t.db.run(`UPDATE ledger_entries SET date = '2026-04-30' WHERE voucher_id = :id`, { id: journal });
    const r = run();
    assert.ok(failing(r).includes('voucher_children'));
    assert.match(details(r, 'voucher_children'), /ledger entries/);
  });

  it('flags bill allocations that do not add up to their entry', () => {
    k.t.db.run('UPDATE bill_allocations SET amount = amount + 1000 WHERE voucher_id = :id', { id: receipt });
    assert.ok(failing(run()).includes('bill_allocations'));
  });

  it('flags stock moving the wrong way for the voucher type', () => {
    k.t.db.run('UPDATE inventory_entries SET qty = -qty WHERE voucher_id = :id', { id: sale });
    assert.ok(failing(run()).includes('inventory_direction'));
  });

  it('flags GST details that disagree with the tax ledger postings', () => {
    k.t.db.run('UPDATE gst_lines SET cgst = cgst + 100 WHERE voucher_id = :id', { id: sale });
    const r = run();
    assert.ok(failing(r).includes('gst_tax_postings'));
    assert.match(details(r, 'gst_tax_postings'), /CGST/);
  });

  it('flags a voucher number used twice in the same series', () => {
    const second = save(k, { voucherTypeId: k.vt.journal, date: '2026-04-14', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 100_00 }, { ledgerId: k.L.capital, amount: -100_00 }] }).id;
    k.t.db.run('UPDATE vouchers SET number = (SELECT number FROM vouchers WHERE id = :a), number_seq = (SELECT number_seq FROM vouchers WHERE id = :a) WHERE id = :b', {
      a: journal,
      b: second,
    });
    assert.ok(failing(run()).includes('duplicate_numbers'));
  });

  it('flags a voucher in the books without entries, and rows pointing at missing records', () => {
    k.t.db.run('DELETE FROM ledger_entries WHERE voucher_id = :id', { id: journal });
    k.t.db.exec('PRAGMA foreign_keys = OFF');
    k.t.db.run(`UPDATE ledger_entries SET ledger_id = 999999 WHERE voucher_id = :id AND ledger_id = :l`, { id: receipt, l: k.L.bank });
    k.t.db.exec('PRAGMA foreign_keys = ON');
    const f = failing(run());
    assert.ok(f.includes('orphans'), f.join(','));
    assert.ok(f.includes('foreign_keys'), f.join(','));
  });

  it('flags a difference in opening balances', () => {
    k.t.db.run('UPDATE ledgers SET opening_balance = 1000 WHERE id = :id', { id: k.L.rent });
    const r = run();
    assert.deepEqual(failing(r), ['opening_difference']);
  });

  it('flags a broken edit-log chain', () => {
    const last = k.t.db.get<Record<string, unknown>>('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1');
    assert.ok(last);
    // Append a forged row with a made-up hash (the log is append-only, so forging is the only way in).
    const cols = Object.keys(last).filter((c) => c !== 'id');
    const forged: Record<string, unknown> = { ...last, hash: 'f'.repeat(64), entity_label: 'forged' };
    k.t.db.run(`INSERT INTO audit_log (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, Object.fromEntries(cols.map((c) => [c, forged[c] as never])));
    assert.ok(failing(run()).includes('audit_chain'));
  });

  it('flags a loop in the group tree', () => {
    const a = k.t.db.run(`INSERT INTO groups (guid, name, parent_id, nature, is_predefined, created_at, updated_at)
      SELECT 'g-a', 'Loop A', id, nature, 0, created_at, updated_at FROM groups WHERE id = :p`, { p: k.t.ids.groups.SUNDRY_DEBTORS }).lastInsertRowid;
    const b = k.t.db.run(`INSERT INTO groups (guid, name, parent_id, nature, is_predefined, created_at, updated_at)
      SELECT 'g-b', 'Loop B', :a, nature, 0, created_at, updated_at FROM groups WHERE id = :a`, { a }).lastInsertRowid;
    k.t.db.run('UPDATE groups SET parent_id = :b WHERE id = :a', { a, b });
    assert.ok(failing(run()).includes('group_tree'));
  });

  it('runs through the dispatcher and needs data.backup', async () => {
    const ok = await k.t.callOk<DataVerifyResult>(dataRoutes, 'data.verify');
    assert.equal(ok.ok, true);
    const denied = await k.t.call(dataRoutes, 'data.verify', undefined, { session: k.t.sessionAs({ permissions: ['vouchers.view'] }) });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
  });
});
