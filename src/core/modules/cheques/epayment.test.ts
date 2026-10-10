/**
 * Bulk e-payment file: candidates (bank-transfer Payments), mode rules (RTGS ≥ ₹2 lakh, IMPS ≤ ₹5 lakh),
 * problems that keep a payment out, CSV content, batch record and edit log. Today 15-Apr-2026.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv } from '../../lib/csv.ts';
import { EPAYMENT_COLUMNS, exportEPayments, listEPayments } from './epayment.ts';
import { savePayee } from './payees.ts';
import { chequeKit } from './testkit.ts';

describe('e-payments', () => {
  it('lists bank-transfer payments with their mode and what keeps them out', () => {
    const k = chequeKit();
    const neft = k.pay({ amount: 1_180_00, type: null, narration: 'Bill 77 & 78 (April)' }); // no instrument: NEFT below ₹2 lakh
    const big = k.pay({ amount: 2_50_000_00, type: null }); // ≥ ₹2 lakh → RTGS
    const rtgsSmall = k.pay({ amount: 50_000_00, type: 'rtgs' });
    const imps = k.pay({ amount: 6_00_000_00, type: 'imps' });
    const noDetails = k.pay({ amount: 100_00, type: 'neft', to: k.L.gta });
    k.pay({ amount: 100_00 }); // cheque: never in a payment file
    const list = listEPayments(k.t.db, { from: '2026-04-01', to: '2026-04-30' });
    const by = new Map(list.map((c) => [c.voucherId, c]));
    assert.equal(list.length, 5);
    assert.deepEqual([by.get(neft.id)?.mode, by.get(neft.id)?.problem], ['neft', null]);
    assert.equal(by.get(big.id)?.mode, 'rtgs');
    assert.match(by.get(rtgsSmall.id)?.problem ?? '', /RTGS is for ₹2,00,000 and above/);
    assert.match(by.get(imps.id)?.problem ?? '', /IMPS allows up to ₹5,00,000/);
    assert.match(by.get(noDetails.id)?.problem ?? '', /Add the bank account and IFSC of Speedy Transport/);
    assert.equal(by.get(neft.id)?.beneficiaryName, 'Supreme Suppliers Pvt Ltd');
  });

  it('exports a CSV of the ready payments, skips the rest, records the batch and the edit log', () => {
    const k = chequeKit();
    savePayee(k.t.ctx, { ledgerId: k.L.supplier, paymentMode: 'imps' });
    const a = k.pay({ amount: 1_180_50, type: null, narration: 'Bill 77 & 78 (April)' });
    const b = k.pay({ amount: 100_00, type: 'neft', to: k.L.gta });
    const res = exportEPayments(k.t.ctx, { voucherIds: [a.id, b.id] });
    assert.equal(res.rows, 1);
    assert.equal(res.total, 1_180_50);
    assert.deepEqual(res.skipped.map((s) => s.voucherId), [b.id]);
    assert.match(res.fileName, /^e-payments HDFC Bank 2026-04-15\.csv$/);
    const rows = parseCsv(new TextDecoder().decode(res.bytes));
    assert.deepEqual(rows[0], [...EPAYMENT_COLUMNS]);
    const r = Object.fromEntries(EPAYMENT_COLUMNS.map((c, i) => [c, rows[1][i]]));
    assert.equal(r['Payment Mode'], 'IMPS', "the payee's preferred mode");
    assert.equal(r.Amount, '1180.50');
    assert.equal(r['Value Date'], '15/04/2026');
    assert.equal(r['Beneficiary Name'], 'Supreme Suppliers Pvt Ltd');
    assert.equal(r['Beneficiary Account No'], '123456789012');
    assert.equal(r['Beneficiary IFSC'], 'SBIN0001234');
    assert.equal(r['Debit Account No'], '50100012345678');
    assert.equal(r.Remarks, 'Bill 77 & 78 (April)');
    // Recorded: the next listing says when it was exported; one export entry in the edit log.
    assert.ok(listEPayments(k.t.db, { from: '2026-04-01', to: '2026-04-30' }).find((c) => c.voucherId === a.id)?.exportedAt);
    assert.equal(k.t.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE action = 'export' AND entity_type = 'epayment_batch'"), 1);
  });

  it('refuses a past value date and a file with nothing ready', () => {
    const k = chequeKit();
    const a = k.pay({ amount: 100_00, type: 'neft' });
    assert.throws(() => exportEPayments(k.t.ctx, { voucherIds: [a.id], valueDate: '2026-04-01' }), /cannot be before today/);
    const c = k.pay({ amount: 100_00 });
    assert.throws(() => exportEPayments(k.t.ctx, { voucherIds: [c.id] }), /Not a bank-transfer Payment/);
  });
});
