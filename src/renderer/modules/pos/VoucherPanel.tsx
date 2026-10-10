/**
 * Panel at the end of 'vouchers.view' (ModuleDef.voucherPanels) for a POS bill or return: how it was
 * paid / refunded (each tender with its reference), cash tendered and change, what is on account,
 * the counter, and the bill a return came from. Alt+T opens Return / exchange from this bill.
 * Hidden for other vouchers and while F11 › POS invoicing is off.
 */
import { formatMoney } from '../../../shared/format.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav, useScreenActions } from '../../app/nav.tsx';
import type { VoucherPanelProps } from '../../app/registry.ts';
import { useFeatures } from '../../app/state.tsx';
import { Panel, Stack } from '../../ui/index.ts';

export function PosVoucherPanel({ voucherId, baseType, isCancelled, updatedAt }: VoucherPanelProps) {
  const nav = useNav();
  const on = useFeatures().pos === true && (baseType === 'sales' || baseType === 'credit_note');
  const q = useApiQuery('pos.voucher', { id: voucherId }, { enabled: on, staleTime: 10_000 });
  const d = on ? q.data : null;
  useScreenActions(
    d && d.kind === 'sale' && !isCancelled
      ? [{ key: 'Alt+T', label: 'Return / exchange', icon: 'undo', group: 'details', onClick: () => nav.push('pos.return', { billId: voucherId }) }]
      : [],
  );
  // updatedAt is part of the props so a re-saved voucher re-renders this panel with fresh data.
  void updatedAt;
  if (!d) return null;
  const sale = d.kind === 'sale';
  return (
    <Panel title={sale ? 'POS bill' : 'POS return'} description={sale ? 'Paid at the counter · Alt+T Return / exchange' : 'Refunded at the counter'}>
      <Stack gap={1}>
        {d.tenders.map((t, i) => (
          <div key={i}>
            <span>{t.name}</span>
            {t.reference ? <span className="bx-muted"> (Ref {t.reference})</span> : null} <strong className="bx-num">₹ {formatMoney(t.amount)}</strong>
            <span className="bx-muted"> → {t.ledgerName}</span>
          </div>
        ))}
        {d.credit > 0 ? (
          <div>
            {sale ? 'On account' : 'Credited to the account'} <strong className="bx-num">₹ {formatMoney(d.credit)}</strong>
          </div>
        ) : null}
        {d.cashTendered !== null ? (
          <div className="bx-muted">
            Cash handed over ₹ {formatMoney(d.cashTendered)} · change ₹ {formatMoney(d.change)}
          </div>
        ) : null}
        {d.counter ? <div className="bx-muted">Counter: {d.counter}</div> : null}
        {d.returnOfId !== null ? (
          <div>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                nav.push('vouchers.view', { id: d.returnOfId });
              }}
            >
              Open the bill it was returned from
            </a>
          </div>
        ) : null}
      </Stack>
    </Panel>
  );
}
