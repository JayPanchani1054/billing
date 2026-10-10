/**
 * (print group) Panel extension on 'vouchers.view' (ModuleDef.voucherPanels): on a Payment or Contra,
 * with F11 › Cheque printing on, adds the rail action Alt+K "Print cheque" (the cheque print preview of
 * this voucher: payee, amount in words and figures, date boxes in the bank's layout). Renders nothing.
 */
import { useNav, useScreenActions } from '../../app/nav.tsx';
import type { VoucherPanelProps } from '../../app/registry.ts';
import { useFeatures } from '../../app/state.tsx';

export function VoucherChequePanel({ voucherId, baseType, isCancelled, isOptional }: VoucherPanelProps) {
  const nav = useNav();
  const on = useFeatures().chequePrinting;
  const applies = on && (baseType === 'payment' || baseType === 'contra') && !isCancelled && !isOptional;
  useScreenActions(
    applies
      ? [
          {
            key: 'Alt+K',
            label: 'Print cheque',
            icon: 'print',
            group: 'output',
            onClick: () => nav.push('cheques.print', { voucherIds: [voucherId] }),
            hint: 'Preview and print the cheque of this payment in the bank’s layout',
          },
        ]
      : [],
  );
  return null;
}
