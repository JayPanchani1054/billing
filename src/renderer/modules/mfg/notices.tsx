/**
 * mfg pieces shown by other screens through ModuleDef extension points (no hotkeys of their own):
 *  - JobWorkAlertNotice (gatewayNotices) — goods with job workers past / near their CGST s.143 return date;
 *  - MfgCard            (dashboardCards) — s.143 alerts and open job work orders;
 *  - MfgVoucherPanel    (voucherPanels)  — on 'vouchers.view' of a Manufacturing Journal / Material In / Out:
 *                                          BOM and revision, job work order, process, additional costs.
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { STOCK_JOURNAL_CLASS_LABELS } from '../../../shared/types/mfg.ts';
import { useApiQuery, useCan, useCompany, useFeatures, useNav, userMessage, useWorkingDate } from '../../app/index.ts';
import type { VoucherPanelProps } from '../../app/index.ts';
import { Badge, Banner, Button, Card, Inline, KeyValueList, Stack } from '../../ui/index.ts';
import { useEffect, useRef, useState } from 'react';
import { alertText } from './lib/model.ts';

function readFlag(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, '1');
  } catch {
    // Storage unavailable: the notice shows again next time.
  }
}

/** Gateway notice; dismissed for the rest of the working day. */
export function JobWorkAlertNotice() {
  const features = useFeatures();
  const can = useCan('reports.view');
  const company = useCompany();
  const { date } = useWorkingDate();
  const nav = useNav();
  const key = `pevqori.mfg.s143.${company.id}.${date}`;
  const [dismissed, setDismissed] = useState(() => readFlag(key));
  const q = useApiQuery('mfg.jobWork.alerts', { asOf: date }, { enabled: features.jobWork && can && !dismissed, staleTime: 60_000 });
  const a = q.data;
  const text = a ? alertText(a) : null;
  if (!features.jobWork || !can || dismissed || !a || !text) return null;
  return (
    <Banner
      tone={a.overdue > 0 ? 'danger' : 'warning'}
      icon="truck"
      title={a.overdue > 0 ? 'Job work goods past the return date' : 'Job work goods due back soon'}
      onDismiss={() => {
        writeFlag(key);
        setDismissed(true);
      }}
      action={
        <Button size="sm" variant="primary" onClick={() => nav.push('mfg.jobWork.pending', { direction: 'out' })}>
          Review
        </Button>
      }
    >
      {text}
    </Banner>
  );
}

export function MfgCard({ className }: { className?: string }) {
  const features = useFeatures();
  const canReports = useCan('reports.view');
  const canVouchers = useCan('vouchers.view');
  const { date } = useWorkingDate();
  const nav = useNav();
  const alerts = useApiQuery('mfg.jobWork.alerts', { asOf: date }, { enabled: features.jobWork && canReports, staleTime: 30_000 });
  const orders = useApiQuery('mfg.jobWorkOrder.list', { status: 'open', limit: 2000 }, { enabled: features.jobWork && canVouchers, staleTime: 30_000 });
  if (!features.jobWork || (!canReports && !canVouchers)) return null;
  const a = alerts.data;
  const openOrders = orders.data?.rows ?? [];
  const overdueOrders = openOrders.filter((o) => o.overdue).length;
  const row = (label: string, value: string, onClick: (() => void) | undefined, tone?: 'danger' | 'warning') => (
    <Inline gap={2} justify="between" key={label}>
      <span>{label}</span>
      {onClick ? (
        <Button size="sm" variant="link" onClick={onClick}>
          {tone ? <Badge tone={tone} size="sm">{value}</Badge> : value}
        </Button>
      ) : (
        <span className="bx-num">{value}</span>
      )}
    </Inline>
  );
  const go = (screen: string, params: Record<string, unknown> = {}) => (nav.canOpen(screen) ? () => nav.push(screen, params) : undefined);
  return (
    <Card className={className} title="Job work" subtitle="CGST s.143 return limits and open orders" padding="sm">
      <Stack gap={2}>
        {a ? (
          <>
            {row('Challan lines overdue', String(a.overdue), go('mfg.jobWork.pending', { direction: 'out' }), a.overdue > 0 ? 'danger' : undefined)}
            {row('Due back within 30 days', String(a.dueSoon), go('mfg.jobWork.pending', { direction: 'out' }), a.dueSoon > 0 ? 'warning' : undefined)}
            {a.overdueValue > 0 ? <p className="bx-muted">Overdue value ₹ {formatMoney(a.overdueValue)} — deemed supplied on the day sent; GST with interest is payable.</p> : null}
            {a.nextDue ? <p className="bx-muted">Next return date {formatDate(a.nextDue)}.</p> : null}
          </>
        ) : canReports ? (
          <p className="bx-muted">{alerts.error ? userMessage(alerts.error) : 'Loading…'}</p>
        ) : null}
        {canVouchers ? row('Open job work orders', String(openOrders.length), go('mfg.jobWorkOrder.list'), overdueOrders > 0 ? 'warning' : undefined) : null}
      </Stack>
    </Card>
  );
}

export function MfgVoucherPanel({ voucherId, baseType, updatedAt }: VoucherPanelProps) {
  const features = useFeatures();
  const on = baseType === 'stock_journal' && (features.manufacturing || features.jobWork);
  // A plain stock journal answers VALIDATION ("not a Manufacturing Journal…"): nothing to show.
  const q = useApiQuery('mfg.journal.get', { id: voucherId }, { enabled: on, staleTime: 0 });
  const seen = useRef(updatedAt);
  const { refetch } = q;
  useEffect(() => {
    if (seen.current === updatedAt) return;
    seen.current = updatedAt;
    if (on) void refetch();
  }, [updatedAt, refetch, on]);
  const d = q.data;
  if (!on || !d) return null;
  const ledgers = new Map(d.ledgers.map((l) => [l.id, l.name]));
  const costs = d.block.additionalCosts ?? [];
  return (
    <Card title={STOCK_JOURNAL_CLASS_LABELS[d.class]} subtitle="Manufacturing and job work details" padding="sm">
      <KeyValueList
        items={[
          { label: 'Bill of materials', value: d.bomName ?? '', hideEmpty: true },
          { label: 'Job work order', value: d.orderNumber ?? '', hideEmpty: true },
          { label: 'Nature of job work', value: d.block.process ?? '', hideEmpty: true },
          ...costs.map((c, i) => ({
            label: `Additional cost ${i + 1}: ${(c.ledgerId !== undefined ? ledgers.get(c.ledgerId) : undefined) ?? c.label ?? ''}`,
            value: c.basis === 'amount' ? `₹ ${formatMoney(c.value)}` : `${c.value}% of the consumed cost`,
          })),
        ]}
      />
    </Card>
  );
}
