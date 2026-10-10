/**
 * Payee bank details: validation (IFSC, account number), cash / bank ledgers refused, audit with
 * before / after, list, and removal with the ledger (trigger) without blocking the ledger delete.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deleteLedger } from '../accounts/ledgers.ts';
import { getPayee, listPayees, savePayee } from './payees.ts';
import { chequeKit } from './testkit.ts';

describe('payee bank details', () => {
  it('stores normalised details and works out the name on cheques', () => {
    const k = chequeKit();
    const p = getPayee(k.t.db, k.L.supplier);
    assert.equal(p.accountNo, '123456789012', 'spaces removed');
    assert.equal(p.ifsc, 'SBIN0001234', 'upper-cased');
    assert.equal(p.effectiveChequeName, 'Supreme Suppliers Private Limited');
    const cleared = savePayee(k.t.ctx, { ledgerId: k.L.supplier, chequeName: null });
    assert.equal(cleared.effectiveChequeName, 'Supreme Suppliers Pvt Ltd', 'falls back to the beneficiary name');
    assert.equal(getPayee(k.t.db, k.L.rent).effectiveChequeName, 'Office Rent', 'no details: the ledger name');
  });

  it('validates IFSC (4 letters, 0, 6 letters/digits) and the account number; both or neither', () => {
    const k = chequeKit();
    const bad = (input: Parameters<typeof savePayee>[1]): string[] => {
      try {
        savePayee(k.t.ctx, input);
        return [];
      } catch (err) {
        return ((err as { details?: Array<{ path: string }> }).details ?? []).map((d) => d.path);
      }
    };
    assert.deepEqual(bad({ ledgerId: k.L.gta, accountNo: '123456789', ifsc: 'SBIN1001234' }), ['ifsc'], 'fifth character must be 0');
    assert.deepEqual(bad({ ledgerId: k.L.gta, accountNo: '123456789', ifsc: 'SBI00012345' }), ['ifsc']);
    assert.deepEqual(bad({ ledgerId: k.L.gta, accountNo: '12', ifsc: 'HDFC0000123' }), ['accountNo']);
    assert.deepEqual(bad({ ledgerId: k.L.gta, accountNo: '123456789' }), ['ifsc']);
    assert.deepEqual(bad({ ledgerId: k.L.gta, accountNo: '123456789', ifsc: 'hdfc0abc123' }), []);
    assert.throws(() => savePayee(k.t.ctx, { ledgerId: k.L.bank, accountNo: '123456789', ifsc: 'HDFC0000123' }), /cash or bank ledger/);
  });

  it('every change is in the edit log with before / after', () => {
    const k = chequeKit();
    savePayee(k.t.ctx, { ledgerId: k.L.supplier, accountNo: '999988887777' });
    const row = k.t.db.get<{ before_json: string; after_json: string }>(
      "SELECT before_json, after_json FROM audit_log WHERE entity_type = 'ledger_bank_details' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(row);
    assert.match(row.before_json, /123456789012/);
    assert.match(row.after_json, /999988887777/);
    const before = k.t.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity_type = 'ledger_bank_details'");
    savePayee(k.t.ctx, { ledgerId: k.L.supplier, accountNo: '999988887777' });
    assert.equal(k.t.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity_type = 'ledger_bank_details'"), before, 'no change, no entry');
  });

  it('lists payees (with details, or every party) and goes away with the ledger', () => {
    const k = chequeKit();
    assert.deepEqual(listPayees(k.t.db, {}).rows.map((r) => r.ledgerName), ['Supreme Suppliers']);
    const all = listPayees(k.t.db, { withDetails: false, search: 'S' }).rows.map((r) => [r.ledgerName, r.hasDetails]);
    assert.ok(all.some(([n, has]) => n === 'Speedy Transport' && has === false));
    assert.ok(!all.some(([n]) => n === 'HDFC Bank'), 'bank ledgers are not payees');
    const temp = k.t.addLedger({ name: 'Temp Vendor', group: 'SUNDRY_CREDITORS' });
    savePayee(k.t.ctx, { ledgerId: temp, accountNo: '123456789', ifsc: 'HDFC0000123' });
    deleteLedger(k.t.ctx, temp);
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM payee_bank_details WHERE ledger_id = :id', { id: temp }), 0);
  });
});
