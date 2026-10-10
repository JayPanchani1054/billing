/**
 * Test helpers for the cheques module: the vouchers testkit with F11 › Cheque printing on, bank details
 * on the supplier, and Payment / Contra builders. Company Maharashtra, today 15-Apr-2026.
 */
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { saveFeatures } from '../company/service.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { savePayee } from './payees.ts';

export interface ChequeKit extends Kit {
  pay(opts: { date?: string; amount: number; to?: number; chequeNo?: string; instrumentDate?: string; favouring?: string; type?: 'cheque' | 'neft' | 'rtgs' | 'imps' | null; narration?: string }): VoucherSaveResult;
  withdraw(opts: { date?: string; amount: number; chequeNo?: string }): VoucherSaveResult;
}

export function chequeKit(opts: { chequePrinting?: boolean } = {}): ChequeKit {
  const k = setupKit();
  if (opts.chequePrinting !== false) saveFeatures(k.t.ctx, { chequePrinting: true });
  k.t.db.run('UPDATE ledgers SET maintain_bill_wise = 0 WHERE id IN (:a, :b)', { a: k.L.supplier, b: k.L.gta });
  savePayee(k.t.ctx, { ledgerId: k.L.supplier, beneficiaryName: 'Supreme Suppliers Pvt Ltd', accountNo: '1234 5678 9012', ifsc: 'sbin0001234', bankName: 'State Bank of India', chequeName: 'Supreme Suppliers Private Limited' });
  const pay: ChequeKit['pay'] = (o) => {
    const type = o.type === undefined ? 'cheque' : o.type;
    const bankLine: NonNullable<VoucherInput['ledgers']>[number] = { ledgerId: k.L.bank, amount: -o.amount };
    if (type) {
      bankLine.instrument = {
        type,
        ...(o.chequeNo ? { number: o.chequeNo } : {}),
        ...(o.instrumentDate ? { date: o.instrumentDate } : {}),
        ...(o.favouring ? { favouring: o.favouring } : {}),
      };
    }
    return save(k, {
      voucherTypeId: k.vt.payment,
      date: o.date ?? '2026-04-15',
      mode: 'ledger',
      ...(o.narration ? { narration: o.narration } : {}),
      ledgers: [{ ledgerId: o.to ?? k.L.supplier, amount: o.amount }, bankLine],
    });
  };
  const withdraw: ChequeKit['withdraw'] = (o) =>
    save(k, {
      voucherTypeId: k.vt.contra,
      date: o.date ?? '2026-04-15',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.cash, amount: o.amount },
        { ledgerId: k.L.bank, amount: -o.amount, instrument: { type: 'cheque', ...(o.chequeNo ? { number: o.chequeNo } : {}) } },
      ],
    });
  return { ...k, pay, withdraw };
}

/** The cheque number stored on the bank line of a voucher. */
export function chequeOf(k: Kit, voucherId: number): string | null {
  return k.t.db.value<string | null>("SELECT instrument_no FROM ledger_entries WHERE voucher_id = :id AND instrument_type = 'cheque'", { id: voucherId }) ?? null;
}
