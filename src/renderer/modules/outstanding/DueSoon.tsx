/**
 * <DueSoonWidget side days /> — dashboard tile: bills falling due within `days` days of the working
 * date (due today included), plus what is already overdue. Enter on a bill opens the party's
 * outstanding; the two figures open Receivables/Payables (bills view, overdue only for the second).
 * Renders nothing for users without reports.view. Reads 'outstanding.dueSoon'.
 */
import { useMemo } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { DueSoonRow, OutstandingSide } from '../../../shared/types/outstanding.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { useCan } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Button, Card, DataTable, EmptyState, KpiCard } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { SIDE_TEXT } from './lib/model.ts';
import { clampLookAhead, dueInText } from './lib/reminders.ts';

export interface DueSoonWidgetProps {
  side: OutstandingSide;
  /** Look-ahead in days from the working date (0–366). */
  days: number;
  /** Bills listed (default 8). */
  limit?: number;
  /** Table height in px (default 260). */
  height?: number;
  className?: string;
}

export function DueSoonWidget({ side, days, limit = 8, height = 260, className }: DueSoonWidgetProps) {
  const canView = useCan('reports.view');
  const nav = useNav();
  const { date } = useWorkingDate();
  const t = SIDE_TEXT[side];
  const look = clampLookAhead(days);
  const rowLimit = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.round(limit))) : 8;
  const q = useApiQuery('outstanding.dueSoon', { side, asOf: date, days: look, limit: rowLimit, nonBillWise: 'fifo' }, { enabled: canView, keepPrevious: true, staleTime: 60_000 });
  const d = q.data;

  const columns = useMemo<Column<DueSoonRow>[]>(
    () => [
      { key: 'ledgerName', header: t.party, minWidth: 120 },
      { key: 'billName', header: 'Bill', width: 100 },
      {
        key: 'daysToDue',
        header: 'Due',
        width: 110,
        value: (r) => dueInText(r.daysToDue),
        title: (r) => (r.dueDate ? `Due on ${formatDate(r.dueDate)}` : undefined),
        render: (r) => <span className={`bx-os-due__when${r.daysToDue <= 0 ? ' is-today' : ''}`}>{dueInText(r.daysToDue)}</span>,
      },
      { key: 'pendingAmount', header: 'Amount', kind: 'amount', width: 120 },
    ],
    [t],
  );

  if (!canView) return null;
  const title = side === 'receivable' ? `Payments to collect — next ${look} days` : `Payments to make — next ${look} days`;
  return (
    <Card
      className={className}
      title={title}
      padding="sm"
      actions={
        <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={() => nav.push(t.screen, { view: 'bills' })}>
          View all
        </Button>
      }
    >
      <div className="bx-os-due__stats">
        <KpiCard
          label={`Due by ${formatDate(d?.until ?? date)}`}
          value={d?.amount ?? 0}
          amount
          loading={q.loading && !d}
          caption={d ? `${d.total} ${d.total === 1 ? 'bill' : 'bills'}` : undefined}
          icon="calendar"
          onClick={() => nav.push(t.screen, { view: 'bills' })}
        />
        <KpiCard
          label="Already overdue"
          value={d?.overdue.amount ?? 0}
          amount
          loading={q.loading && !d}
          caption={d ? `${d.overdue.count} ${d.overdue.count === 1 ? 'bill' : 'bills'}` : undefined}
          icon="clock"
          onClick={() => nav.push(t.screen, { view: 'bills', overdueOnly: true })}
        />
      </div>
      {q.error && !d ? (
        <EmptyState size="sm" icon="alert" title="Could not load due bills" body={userMessage(q.error)} action={<Button size="sm" icon="refresh" onClick={() => void q.refetch()}>Try again</Button>} />
      ) : (
        <DataTable<DueSoonRow>
          aria-label={title}
          columns={columns}
          rows={d?.rows ?? []}
          getRowKey={(r, i) => `${r.ledgerId}|${r.billName}|${i}`}
          loading={q.loading && !d}
          skeletonRows={4}
          height={height}
          density="compact"
          onRowActivate={(r) => nav.push('outstanding.party', { ledgerId: r.ledgerId })}
          empty={<EmptyState size="sm" icon="check-circle" title={`Nothing falls due in the next ${look} days`} body={`No ${t.parties} have bills due by ${formatDate(d?.until ?? date)}.`} />}
        />
      )}
      {d && d.total > d.rows.length ? <p className="bx-muted">{d.total - d.rows.length} more — View all to see every bill.</p> : null}
    </Card>
  );
}
