/**
 * Saved bar of voucher entry (after a voucher is created; lib/savedBar.ts) — 2.1: one neutral line,
 * only the ✓ is green (SPEC-21 D20):
 *
 *   ✓ Saved Sales 33 · ₹ 27,140.00 · Asha Retail     Print · Share · Record payment     ×
 *
 * The voucher reference opens the voucher (what the 2.0 toast's View did). Print and Share are the
 * screen's own Alt+P / Alt+W actions (the voucher just saved; while the bar offers Print, the title row's
 * Print is `demoted` to More); Record payment opens a Receipt (sales) or Payment (purchase) with the party
 * filled in. A status region named "Voucher saved" (announced once), outside the Enter chain; it goes
 * away on the next save, on × or once the next voucher is touched (the entry screen decides).
 */
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Banner, Button } from '../../../ui/index.ts';
import { voucherRefLabel } from '../lib/printing.ts';
import { savedBarDetails } from '../lib/savedBar.ts';
import type { SavedBarState } from '../lib/savedBar.ts';

export interface SavedBarProps {
  bar: SavedBarState;
  /** Open the saved voucher (the reference is a link when given). */
  onOpen?: () => void;
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

export function SavedBar({ bar, onOpen, onPrint, onShare, shareDisabled, shareHint, onRecordPayment, onDismiss }: SavedBarProps) {
  const ref = voucherRefLabel(bar);
  const links: ReactNode[] = [];
  if (onPrint)
    links.push(
      <Button key="print" variant="link" shortcut="Alt+P" onClick={onPrint}>
        Print
      </Button>,
    );
  if (onShare)
    links.push(
      <Button key="share" variant="link" shortcut="Alt+W" disabled={shareDisabled} title={shareHint} onClick={onShare}>
        Share
      </Button>,
    );
  if (onRecordPayment)
    links.push(
      <Button key="pay" variant="link" onClick={onRecordPayment}>
        Record payment
      </Button>,
    );
  return (
    <Banner
      tone="success"
      className="bx-vch-saved"
      aria-label="Voucher saved"
      title={
        <>
          <span className="bx-vch-saved__ok" aria-hidden="true">
            ✓{' '}
          </span>
          Saved{' '}
          {onOpen ? (
            <button type="button" className="bx-vch-saved__ref" title={`Open ${ref}`} onClick={onOpen}>
              {ref}
            </button>
          ) : (
            ref
          )}
          <span className="bx-num">{savedBarDetails(bar)}</span>
        </>
      }
      action={
        links.length > 0
          ? links.map((l, i) => (
              <Fragment key={i}>
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                {l}
              </Fragment>
            ))
          : undefined
      }
      onDismiss={onDismiss}
    />
  );
}
