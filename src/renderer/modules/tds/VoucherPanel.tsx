/**
 * Panel at the end of 'vouchers.view' (ModuleDef.voucherPanels): the TDS/TCS lines of the voucher
 * shown (section, base, rate, amount, deposited) or, for a challan Payment, the challan with what
 * it cleared. Alt+U opens the challan for alteration / the lines in the TDS/TCS line report.
 */
import { formatDate, formatMonth } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav, useScreenActions } from '../../app/nav.tsx';
import type { VoucherPanelProps } from '../../app/registry.ts';
import { useFeatures } from '../../app/state.tsx';
import { Badge, Panel, Stack } from '../../ui/index.ts';
import { KIND_LABEL, lineSummary, STATUS_LABEL } from './lib/model.ts';

const inr = (p: number): string => formatMoney(p, { symbol: true });

export function TdsVoucherPanel({ voucherId, updatedAt }: VoucherPanelProps) {
  const nav = useNav();
  const features = useFeatures();
  const on = features.tds || features.tcs;
  const q = useApiQuery('tds.voucher', { voucherId }, { enabled: on, staleTime: 10_000 });
  // TDS and TCS turned off in F11 since this voucher was last shown: no panel and no Alt+U (cached data aside).
  const d = on ? q.data : undefined;
  const challan = d?.challan ?? null;
  const lines = d?.lines ?? [];
  const first = lines[0];
  useScreenActions(
    challan
      ? [{ key: 'Alt+U', label: 'Alter challan', icon: 'receipt', group: 'details', onClick: () => nav.push('tds.challan', { voucherId }) }]
      : first
        ? [{ key: 'Alt+U', label: `${KIND_LABEL[first.kind]} lines`, icon: 'percent', group: 'details', onClick: () => nav.push('tds.lines', { kind: first.kind, from: first.date, to: first.date, ...(first.partyLedgerId !== null ? { partyLedgerId: first.partyLedgerId } : {}) }) }]
        : [],
  );
  if (!on || !d || (!challan && lines.length === 0)) return null;
  // updatedAt is part of the props so a re-saved voucher re-renders this panel with fresh data.
  void updatedAt;
  if (challan) {
    return (
      <Panel title={`${KIND_LABEL[challan.kind]} challan`} description={`u/s ${challan.section} for ${formatMonth(challan.period)} · Alt+U alter`}>
        <Stack gap={1}>
          <span>
            BSR {challan.bsrCode} · challan {challan.challanNo} · deposited {formatDate(challan.depositDate)} {challan.late ? <Badge size="sm" tone="warning">After the due date</Badge> : null}
          </span>
          <span className="bx-num">
            Tax {inr(challan.tax + challan.surcharge + challan.cess)} · interest {inr(challan.interest)} · fee {inr(challan.fee)} · cleared {inr(challan.cleared)}
            {challan.unconsumed > 0 ? ` · unconsumed ${inr(challan.unconsumed)}` : ''}
          </span>
        </Stack>
      </Panel>
    );
  }
  return (
    <Panel title="TDS / TCS" description="Computed when the voucher was saved · Alt+U lines">
      <Stack gap={1}>
        {lines.map((l) => (
          <div key={l.id}>
            <span>{lineSummary(l)}</span>{' '}
            <strong className="bx-num">{inr(l.amount)}</strong>{' '}
            {l.status !== 'deducted' ? <Badge size="sm">{STATUS_LABEL[l.status]}</Badge> : null}
            {l.overridden ? <Badge size="sm" tone="warning">Changed: {l.reason ?? ''}</Badge> : null}
            {l.amount > 0 ? <span className="bx-muted"> · deposited {inr(l.deposited)}{l.dueDate && l.balance > 0 ? `, due ${formatDate(l.dueDate)}` : ''}</span> : null}
          </div>
        ))}
      </Stack>
    </Panel>
  );
}
