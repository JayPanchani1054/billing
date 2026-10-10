/**
 * Saved bar of voucher entry (after a voucher is created; lib/savedBar.ts):
 *
 *   ✓ Saved Sales INV/26-27/0042 · ₹ 11,800.00 — [Print Alt+P] [Share Alt+W] [Record payment] [×]
 *
 * Print and Share are the screen's own Alt+P / Alt+W actions (the voucher just saved); Record payment
 * opens a Receipt (sales) or Payment (purchase) with the party filled in. A success Banner (a status
 * region, announced once; no CSS of its own), outside the Enter chain; it goes away on the next save,
 * on × or once the next voucher is touched (the entry screen decides).
 */
import { formatMoney } from '../../../../shared/format.ts';
import { Banner, Button } from '../../../ui/index.ts';
import { savedBarTitle } from '../lib/savedBar.ts';
import type { SavedBarState } from '../lib/savedBar.ts';

export interface SavedBarProps {
  bar: SavedBarState;
  /** Print the saved voucher (hidden when the print module is not there). */
  onPrint?: () => void;
  /** Share it (e-mail / WhatsApp); `shareHint` explains a disabled Share. */
  onShare?: () => void;
  shareDisabled?: boolean;
  shareHint?: string;
  /** Record the payment of this invoice, when it has one (lib/savedBar.ts › recordPaymentTarget). */
  onRecordPayment?: () => void;
  onDismiss: () => void;
}

export function SavedBar({ bar, onPrint, onShare, shareDisabled, shareHint, onRecordPayment, onDismiss }: SavedBarProps) {
  return (
    <Banner
      tone="success"
      inline
      aria-label="Voucher saved"
      title={
        <>
          {savedBarTitle(bar)}
          <span className="bx-num"> · ₹ {formatMoney(bar.amount)}</span>
        </>
      }
      action={
        <>
          {onPrint ? (
            <Button size="sm" variant="secondary" icon="print" shortcut="Alt+P" onClick={onPrint}>
              Print
            </Button>
          ) : null}
          {onShare ? (
            <Button size="sm" variant="secondary" icon="mail" shortcut="Alt+W" disabled={shareDisabled} title={shareHint} onClick={onShare}>
              Share
            </Button>
          ) : null}
          {onRecordPayment ? (
            <Button size="sm" variant="secondary" icon="rupee" onClick={onRecordPayment}>
              Record payment
            </Button>
          ) : null}
        </>
      }
      onDismiss={onDismiss}
    />
  );
}
