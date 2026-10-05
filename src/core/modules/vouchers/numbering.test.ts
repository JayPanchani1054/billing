/**
 * Voucher numbering: automatic series, yearly / monthly restart, prefix/suffix/width, manual numbering
 * with duplicate protection, automatic with manual override, and 'none'.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BindValue } from '../../db/db.ts';
import { formatVoucherNumber, loadVoucherType, parseVoucherSeq } from './numbering.ts';
import { vouchersRoutes } from './routes.ts';
import { nextVoucherNumber, previewVoucher } from './service.ts';
import { header, salesInput, save, setupKit, throwsApp, throwsField, type Kit } from './testkit.ts';

function configureSales(k: Kit, cols: Record<string, BindValue>): void {
  for (const [col, value] of Object.entries(cols)) {
    // Column names come from this test file only (fixed identifiers), values are bound.
    k.t.db.run(`UPDATE voucher_types SET ${col} = :v WHERE id = :id`, { v: value, id: k.vt.sales });
  }
}

const counters = (k: Kit): Array<[string, number]> =>
  k.t.db
    .all<{ period_key: string; last_number: number }>('SELECT period_key, last_number FROM voucher_counters WHERE voucher_type_id = :id ORDER BY period_key', { id: k.vt.sales })
    .map((r) => [r.period_key, r.last_number]);

describe('voucher numbering', () => {
  it('automatic numbering restarts every financial year', () => {
    const k = setupKit();
    const a = save(k, salesInput(k, { date: '2026-04-15' }));
    const b = save(k, salesInput(k, { date: '2027-03-31' }));
    const c = save(k, salesInput(k, { date: '2027-04-01' }));
    const d = save(k, salesInput(k, { date: '2027-04-02' }));
    assert.deepEqual([a.number, b.number, c.number, d.number], ['1', '2', '1', '2']);
    assert.deepEqual(counters(k), [['2026-27', 2], ['2027-28', 2]]);
    assert.equal(header(k, c.id).number_seq, 1);
    k.t.close();
  });

  it('monthly restart keys the counter by month', () => {
    const k = setupKit();
    configureSales(k, { numbering_restart: 'monthly', numbering_prefix: 'S-' });
    const a = save(k, salesInput(k, { date: '2026-04-30' }));
    const b = save(k, salesInput(k, { date: '2026-05-01' }));
    assert.deepEqual([a.number, b.number], ['S-1', 'S-1']);
    assert.deepEqual(counters(k), [['2026-04', 1], ['2026-05', 1]]);
    k.t.close();
  });

  it('prefix, zero-padded width and suffix', () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INV/', numbering_suffix: '/26-27', numbering_width: 4, numbering_start: 7 });
    const vt = loadVoucherType(k.t.db, k.vt.sales);
    assert.equal(formatVoucherNumber(vt, 7), 'INV/0007/26-27');
    assert.equal(parseVoucherSeq(vt, 'INV/0012/26-27'), 12);
    assert.equal(parseVoucherSeq(vt, 'X/0012/26-27'), null);
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, k.t.today), 'INV/0007/26-27');
    const a = save(k, salesInput(k));
    assert.equal(a.number, 'INV/0007/26-27');
    assert.equal(header(k, a.id).number_seq, 7);
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, k.t.today), 'INV/0008/26-27');
    k.t.close();
  });

  it('preview shows the next number without consuming it', () => {
    const k = setupKit();
    assert.equal(previewVoucher(k.t.ctx, salesInput(k)).number, '1');
    assert.equal(previewVoucher(k.t.ctx, salesInput(k)).number, '1');
    assert.equal(save(k, salesInput(k)).number, '1');
    assert.equal(previewVoucher(k.t.ctx, salesInput(k)).number, '2');
    k.t.close();
  });

  it('a failed save (rolled back by the route transaction) leaves no gap in the series', async () => {
    const k = setupKit();
    save(k, salesInput(k));
    // Make the write fail AFTER the number was allocated (gst_lines insert), through the real dispatcher.
    k.t.db.exec(`CREATE TEMP TRIGGER fail_gst BEFORE INSERT ON gst_lines BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;`);
    const r = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), acknowledgeWarnings: true });
    assert.equal(r.ok, false);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers'), 1);
    k.t.db.exec('DROP TRIGGER fail_gst');
    assert.deepEqual(counters(k), [['2026-27', 1]]);
    assert.equal(save(k, salesInput(k)).number, '2');
    k.t.close();
  });

  it('manual numbering: number required and duplicates rejected within the period', () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'manual' });
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, k.t.today), '');
    throwsField(() => save(k, salesInput(k)), 'number', /Enter the Sales number/);
    const a = save(k, salesInput(k, { number: 'A-100' }));
    assert.equal(a.number, 'A-100');
    throwsApp(() => save(k, salesInput(k, { number: 'A-100' })), 'CONFLICT', /already used/);
    // Same number in the next financial year is fine (yearly restart scope).
    assert.equal(save(k, salesInput(k, { number: 'A-100', date: '2027-04-05' })).number, 'A-100');
    // Duplicates allowed when prevent_duplicates is off.
    configureSales(k, { prevent_duplicates: 0 });
    assert.equal(save(k, salesInput(k, { number: 'A-100' })).number, 'A-100');
    k.t.close();
  });

  it('automatic with manual override: typed numbers do not consume the series; used numbers are skipped', () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'automatic_override' });
    const typed = save(k, salesInput(k, { number: '2' }));
    assert.equal(typed.number, '2');
    assert.equal(header(k, typed.id).number_seq, 2);
    assert.equal(save(k, salesInput(k)).number, '1');
    assert.equal(save(k, salesInput(k)).number, '3', '2 is taken, so the series skips it');
    // Typing the number the series would give anyway consumes it.
    assert.equal(save(k, salesInput(k, { number: '4' })).number, '4');
    assert.equal(save(k, salesInput(k)).number, '5');
    throwsApp(() => save(k, salesInput(k, { number: '5' })), 'CONFLICT', /already used/);
    k.t.close();
  });

  it("numbering 'none' leaves the number empty", () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'none' });
    const a = save(k, salesInput(k));
    assert.equal(a.number, null);
    // No number → the bill falls back to on account.
    assert.equal(k.t.db.value('SELECT ref_type FROM bill_allocations WHERE voucher_id = :id', { id: a.id }), 'on_account');
    k.t.close();
  });

  it('each voucher type has its own series', () => {
    const k = setupKit();
    assert.equal(save(k, salesInput(k)).number, '1');
    const cn = save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    assert.equal(cn.number, '1');
    assert.equal(save(k, salesInput(k)).number, '2');
    k.t.close();
  });
});
