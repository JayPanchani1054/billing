/**
 * POS block of a printed bill / return (PrintVoucherData.pos): how it was paid (each tender with its
 * reference), cash tendered and change, what is left on account, the counter and the cashier. Called
 * by the print module's data builder (print/data.ts). A bill paid in full at the counter carries no
 * "Scan to pay" UPI QR (nothing is due); one partly on credit asks only for the balance.
 */
import type { PrintPos } from '../../../shared/types/pos.ts';
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import type { Db } from '../../db/db.ts';
import { upiUri } from '../print/data.ts';
import { tenderLabel } from './hook.ts';
import { billTenders } from './returns.ts';

export function posPrintBlock(db: Db, data: PrintVoucherData): PrintPos | null {
  if (data.sample || data.id <= 0) return null;
  const b = db.get<{ kind: 'sale' | 'return'; paid: number; credit: number; cash_tendered: number | null; change_due: number; counter: string | null; cashier: string | null }>(
    `SELECT b.kind, b.paid, b.credit, b.cash_tendered, b.change_due, b.counter, json_extract(v.meta, '$.createdByName') AS cashier
       FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id WHERE b.voucher_id = :id`,
    { id: data.id },
  );
  if (!b) return null;
  const tenders = billTenders(db, data.id).map((t) => ({ label: tenderLabel(t.name, t.kind, t.reference), amount: t.amount }));
  if (data.upi) {
    if (b.kind === 'return' || b.credit <= 0) data.upi = null;
    else if (b.credit < data.upi.amount) {
      const amount = b.credit;
      data.upi = { ...data.upi, amount, uri: upiUri({ id: data.upi.id, payeeName: data.upi.payeeName, amount, note: data.upi.note }) };
    }
  }
  return {
    kind: b.kind,
    tenders,
    paid: b.paid,
    credit: b.credit,
    cashTendered: b.cash_tendered,
    change: b.change_due,
    counter: b.counter,
    cashier: b.cashier,
  };
}
