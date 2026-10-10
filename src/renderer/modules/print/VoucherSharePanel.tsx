/**
 * (print group) Panel extension on 'vouchers.view' (ModuleDef.voucherPanels): adds the rail action
 * Alt+W "Share (e-mail / WhatsApp)", which opens the print preview of the voucher with the Share dialog
 * (the PDF is rendered from the same preview, so what is shared is what would print). Renders nothing.
 */
import { useNav, useScreenActions } from '../../app/nav.tsx';
import type { VoucherPanelProps } from '../../app/registry.ts';
import { useCan } from '../../app/state.tsx';
import { EXPORT_DENIED_HINT_TEXT } from './lib/share.ts';

export function VoucherSharePanel({ voucherId, isCancelled }: VoucherPanelProps) {
  const nav = useNav();
  const canExport = useCan('data.export');
  useScreenActions([
    {
      key: 'Alt+W',
      label: 'Share (e-mail / WhatsApp)',
      icon: 'mail',
      group: 'output',
      onClick: () => nav.push('print.voucher', { id: voucherId, share: true }),
      hidden: isCancelled || !nav.isRegistered('print.voucher'),
      disabled: !canExport,
      hint: canExport ? 'Opens the print preview with the Share dialog' : EXPORT_DENIED_HINT_TEXT,
    },
  ]);
  return null;
}
