/**
 * Printed "Paid by" block of a POS bill / return (PrintVoucherData.pos) — pure (tested in
 * print.test.ts). Amounts are formatted here so the receipt and the A4 invoice say the same thing.
 */
import { formatMoney } from '../../../../shared/format.ts';
import type { PrintPos } from '../../../../shared/types/pos.ts';

export interface PosPrintRow {
  key: string;
  label: string;
  amount: string;
  strong?: boolean;
}

export function posPrintRows(pos: PrintPos): { title: string; rows: PosPrintRow[]; footer: string | null } {
  const isReturn = pos.kind === 'return';
  const rows: PosPrintRow[] = pos.tenders.map((t, i) => ({ key: `t${i}`, label: t.label, amount: formatMoney(t.amount) }));
  if (pos.credit > 0) rows.push({ key: 'credit', label: isReturn ? 'Credited to your account' : 'On account (to pay)', amount: formatMoney(pos.credit), strong: !isReturn });
  if (!isReturn && pos.cashTendered !== null) {
    rows.push({ key: 'tendered', label: 'Cash tendered', amount: formatMoney(pos.cashTendered) });
    rows.push({ key: 'change', label: 'Change', amount: formatMoney(pos.change), strong: true });
  }
  const who = [pos.counter ? `Counter: ${pos.counter}` : null, pos.cashier ? `Cashier: ${pos.cashier}` : null].filter((x): x is string => x !== null);
  return { title: isReturn ? 'Refunded by' : 'Paid by', rows, footer: who.length > 0 ? who.join(' · ') : null };
}
