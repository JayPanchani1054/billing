/**
 * Panel at the end of 'vouchers.view' (ModuleDef.voucherPanels): the foreign-currency side of the
 * voucher shown — the document currency and rate (export / import invoice), each entry of a ledger
 * kept in a foreign currency (amount @ rate → rupees, bills) and the realised exchange gain / loss the
 * voucher posted. Alt+Y opens the first such ledger in both currencies. Hidden when F11 › Multiple
 * currencies is off or nothing on the voucher is in a foreign currency.
 */
import { formatExchangeRate, formatForex } from '../../../shared/forex.ts';
import { formatMoney } from '../../../shared/format.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav, useScreenActions } from '../../app/nav.tsx';
import type { VoucherPanelProps } from '../../app/registry.ts';
import { useFeatures } from '../../app/state.tsx';
import { Panel, Stack } from '../../ui/index.ts';
import { fxDrCr, gainLossText } from './lib/model.ts';

export function ForexVoucherPanel({ voucherId, updatedAt }: VoucherPanelProps) {
  const nav = useNav();
  const features = useFeatures();
  const on = features.multiCurrency === true;
  const q = useApiQuery('forex.voucher', { id: voucherId }, { enabled: on, staleTime: 10_000 });
  // Feature turned off in F11 since this voucher was last shown: no panel and no Alt+Y (cached data aside).
  const d = on ? q.data : undefined;
  const first = d?.entries[0];
  useScreenActions(first ? [{ key: 'Alt+Y', label: 'Ledger in currency', icon: 'rupee', group: 'details', onClick: () => nav.push('forex.ledger', { ledgerId: first.ledgerId }) }] : []);
  // updatedAt is part of the props so a re-saved voucher re-renders this panel with fresh data.
  void updatedAt;
  if (!on || !d || (d.currency === null && d.entries.length === 0)) return null;
  const doc = d.currency && d.rate !== null ? d.currency : null;
  return (
    <Panel
      title="Foreign currency"
      description={doc ? `In ${doc.formalName} (${doc.isoCode ?? doc.symbol}) @ ₹${formatExchangeRate(d.rate as number)} · books in rupees · Alt+Y ledger` : 'Books in rupees · Alt+Y ledger in currency'}
    >
      <Stack gap={1}>
        {doc && d.documentForex !== null ? (
          <div>
            Invoice value <strong className="bx-num">{formatForex(d.documentForex, doc.decimalPlaces, doc.symbol)}</strong>
          </div>
        ) : null}
        {d.entries.map((e) => (
          <div key={`${e.lineNo}:${e.ledgerId}`}>
            <span>{e.ledgerName}</span>{' '}
            <strong className="bx-num">
              {e.forexAmount === 0 ? 'exchange adjustment' : fxDrCr(e.forexAmount, e.currency)}
              {e.rate !== null && e.forexAmount !== 0 ? ` @ ₹${formatExchangeRate(e.rate)}` : ''}
            </strong>{' '}
            <span className="bx-muted bx-num">
              = ₹ {formatMoney(Math.abs(e.amount))} {e.amount >= 0 ? 'Dr' : 'Cr'}
              {e.bills.length > 0 ? ` · ${e.bills.map((b) => `${b.billName ?? b.refType}: ${fxDrCr(b.forexAmount, e.currency) || `₹ ${formatMoney(Math.abs(b.amount))}`}`).join(', ')}` : ''}
            </span>
          </div>
        ))}
        {d.gainLoss !== 0 ? (
          <div>
            <strong>{gainLossText(d.gainLoss, formatMoney)}</strong> <span className="bx-muted">(realised, posted to {d.gainLossLedger?.name ?? 'Forex Gain/Loss'})</span>
          </div>
        ) : null}
      </Stack>
    </Panel>
  );
}
