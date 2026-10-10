/**
 * Challan suggestion nets debit-note reversals (found by the cross-feature tie-out,
 * all-features-year.test.ts): a debit note reversing part of a bill's TDS made the outstanding report and
 * the 26Q show the net, but `tds.challan.suggest` still asked for the gross — the challan over-deposited
 * the reversed part and the TDS Payable ledger ended in debit.
 *
 * Figures: bill 05-Jun Contract Charges ₹1,00,000 (194C firm 2% = ₹2,000); debit note 10-Jun ₹10,000
 * against it → ₹200 reversed; June's deposit by 7-Jul = ₹1,800.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TdsChallanSuggestion, TdsOutstandingResult } from '../../../shared/types/tds.ts';
import { tdsRoutes } from './routes.ts';
import { entries, purchase, save, setupTds } from './testkit.ts';

describe('TDS challan suggestion after a debit note', () => {
  it('suggests the net tax; deposited, the ledger and the outstanding report are both nil', async () => {
    const k = setupTds({ today: '2026-07-07' });
    save(k, purchase(k, '2026-06-05', k.L.contractor, k.L.contractExp, 1_00_000_00, 'SC-1'));
    const note = (date: string) =>
      save(k, {
        voucherTypeId: k.vt.debit_note,
        date,
        mode: 'accounting_invoice',
        partyLedgerId: k.L.contractor,
        originalInvoiceNo: 'SC-1',
        originalInvoiceDate: '2026-06-05',
        ledgers: [{ ledgerId: k.L.contractExp, amount: 10_000_00 }],
        partyBillAllocations: [{ refType: 'against', billName: 'SC-1', amount: 11_600_00 }],
      });
    const n = note('2026-06-10');
    assert.equal(entries(k, n.id)['TDS Payable – 194C'], 200_00);
    const sug = await k.t.callOk<TdsChallanSuggestion>(tdsRoutes, 'tds.challan.suggest', { kind: 'tds', section: '194C', period: '2026-06', depositDate: '2026-07-07' });
    assert.equal(sug.unpaid, 1_800_00, '2,000 − 200 reversed');
    await k.t.callOk(tdsRoutes, 'tds.challan.save', {
      date: '2026-07-07',
      bankLedgerId: k.L.bank,
      challan: { kind: 'tds', section: '194C', period: '2026-06', bsrCode: '0510001', challanNo: '00077', depositDate: '2026-07-07', tax: sug.unpaid, interest: sug.interest },
    });
    const os = await k.t.callOk<TdsOutstandingResult>(tdsRoutes, 'tds.outstanding', { asOf: '2026-07-07', kind: 'tds' });
    assert.equal(os.totals.balance, 0, 'nothing due, nothing deposited in excess');
    const payable = k.t.db.value<number>(
      `SELECT COALESCE(SUM(e.amount), 0) FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE l.name = 'TDS Payable – 194C' AND e.affects_books = 1`,
    );
    assert.equal(payable, 0, 'TDS Payable – 194C squared off');
    k.t.close();
  });

  it('a note dated after the deposit date does not change what was due on that date', async () => {
    const k = setupTds({ today: '2026-07-31' });
    save(k, purchase(k, '2026-06-05', k.L.contractor, k.L.contractExp, 1_00_000_00, 'SC-1'));
    save(k, {
      voucherTypeId: k.vt.debit_note,
      date: '2026-07-20',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.contractor,
      originalInvoiceNo: 'SC-1',
      originalInvoiceDate: '2026-06-05',
      ledgers: [{ ledgerId: k.L.contractExp, amount: 10_000_00 }],
      partyBillAllocations: [{ refType: 'against', billName: 'SC-1', amount: 11_600_00 }],
    });
    const on7 = await k.t.callOk<TdsChallanSuggestion>(tdsRoutes, 'tds.challan.suggest', { kind: 'tds', section: '194C', period: '2026-06', depositDate: '2026-07-07' });
    assert.equal(on7.unpaid, 2_000_00, 'on 7-Jul the note did not exist yet');
    const on25 = await k.t.callOk<TdsChallanSuggestion>(tdsRoutes, 'tds.challan.suggest', { kind: 'tds', section: '194C', period: '2026-06', depositDate: '2026-07-25' });
    assert.equal(on25.unpaid, 1_800_00, 'deposited late, after the note: the net');
    k.t.close();
  });
});
