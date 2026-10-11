/**
 * Banking registers:
 *  - 'banking.cheques' { ledgerId? } — cheques/DDs issued and received in the period (Alt+F2), with clearing
 *    status, stale cheques (over 3 months) and totals. View tabs: All / Not cleared / Cleared (Ctrl+1/2/3);
 *    the bank is the one filter; "Issued only" / "Received only" are checkable More items. The stat says
 *    what is not cleared (issued, received) and how many are stale — no graph (two numbers, SPEC-21 §5).
 *  - 'banking.pdc' { ledgerId? } — post-dated cheques pending as on the period end, In (received) and Out
 *    (issued) in their own columns, days to maturity; Alt+T also lists matured ones. The graph: the net in /
 *    out by week (Due now, Week 1 … Week 8, Later), lib/charts.ts.
 * Enter opens the voucher; Alt+E export, Alt+P print.
 */
import { useMemo, useState } from 'react';
import type { ChequeDirection, ChequeRegisterRow, ChequeStatusFilter, PdcRow } from '../../../shared/types/banking.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { checkItem } from '../../app/lib/moreItems.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Badge, DataTable, EmptyState, Inline, SegmentedControl, StatLine } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { BankSelect, useBanks } from './components.tsx';
import { chequeRegisterStat, pdcChart, pdcIn, pdcOut } from './lib/charts.ts';
import { CHEQUE_STATUS_LABEL, chequeRegisterExport, pdcExport } from './lib/exports.ts';

const STATUS_OPTIONS: ReadonlyArray<{ value: ChequeStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'uncleared', label: 'Not cleared' },
  { value: 'cleared', label: 'Cleared' },
];

export function ChequeRegisterScreen({ params }: ScreenProps<{ ledgerId?: number }>) {
  const nav = useNav();
  const { from, to } = usePeriod();
  const { banks } = useBanks(to);
  const [ledgerId, setLedgerId] = useState<number | null>(params.ledgerId ?? null);
  const [status, setStatus] = useState<ChequeStatusFilter>('all');
  const [direction, setDirection] = useState<ChequeDirection | 'all'>('all');
  const q = useApiQuery('banking.chequeRegister', { ledgerId: ledgerId ?? undefined, from, to, status, direction }, { keepPrevious: true });
  const rows = q.data?.rows ?? NO_CHEQUES;
  const stat = q.data ? chequeRegisterStat(q.data) : [];

  const columns = useMemo<Column<ChequeRegisterRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 104, sortable: true },
      { key: 'instrumentNo', header: 'Cheque no.', width: 120, sortable: true, render: (r) => `${r.instrumentType === 'dd' ? 'DD ' : ''}${r.instrumentNo ?? ''}` },
      { key: 'direction', header: 'Type', width: 96, render: (r) => (r.direction === 'issued' ? 'Issued' : 'Received'), sortable: true },
      { key: 'particulars', header: 'Party', minWidth: 180, sortable: true },
      { key: 'bankLedgerName', header: 'Bank', width: 150, hidden: ledgerId !== null },
      { key: 'drawnOn', header: 'Drawn on', width: 130 },
      { key: 'voucher', header: 'Voucher', width: 140, value: (r) => `${r.voucherType} ${r.number ?? ''}` },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 130, total: true, sortable: true },
      { key: 'bankDate', header: 'Bank date', kind: 'date', width: 104, sortable: true },
      {
        key: 'status',
        header: 'Status',
        width: 150,
        sortable: true,
        value: (r) => (r.stale ? 'Stale' : CHEQUE_STATUS_LABEL[r.status]),
        // Only the exception is marked: a stale cheque; the rest are plain words.
        render: (r) =>
          r.stale ? (
            <Badge size="sm" tone="danger" title="Not cleared 3 months after its date">
              Stale (over 3 months)
            </Badge>
          ) : (
            CHEQUE_STATUS_LABEL[r.status]
          ),
      },
    ],
    [ledgerId],
  );

  return (
    <ReportScreen
      title="Cheque Register"
      periodMode="range"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      exportDef={() => chequeRegisterExport(rows)}
      stat={stat.length > 0 ? <StatLine items={stat} /> : null}
      hint="Enter Open voucher · Ctrl+1/2/3 All / Not cleared / Cleared · Alt+F2 Period"
      filters={
        <Inline gap={4} wrap align="center">
          <SegmentedControl aria-label="Clearing status" size="sm" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
          <BankSelect banks={banks} value={ledgerId} onChange={setLedgerId} allowAll />
        </Inline>
      }
      actions={[
        { key: 'Ctrl+1', label: 'All cheques', onClick: () => setStatus('all'), group: 'view', disabled: status === 'all' },
        { key: 'Ctrl+2', label: 'Not cleared', onClick: () => setStatus('uncleared'), group: 'view', disabled: status === 'uncleared' },
        { key: 'Ctrl+3', label: 'Cleared', onClick: () => setStatus('cleared'), group: 'view', disabled: status === 'cleared' },
        // Issued / received: checkable, keyless More items (one filter on the toolbar row is the bank).
        checkItem('Issued only', direction === 'issued', (on) => setDirection(on ? 'issued' : 'all')),
        checkItem('Received only', direction === 'received', (on) => setDirection(on ? 'received' : 'all')),
        { key: 'Alt+R', label: 'Reconciliation', icon: 'bank', onClick: () => nav.push('banking.brs', { ledgerId: ledgerId ?? undefined }), group: 'go' },
      ]}
      meta={direction === 'all' ? undefined : direction === 'issued' ? 'Issued only' : 'Received only'}
    >
      <DataTable
        aria-label="Cheque register"
        hideEmptyColumns
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.ledgerEntryId)}
        onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
        loading={q.loading}
        empty={<EmptyState title="No cheques in this period" body="Cheques and DDs entered in Payment, Receipt and Contra vouchers appear here. Change the period with Alt+F2." />}
      />
    </ReportScreen>
  );
}

const NO_CHEQUES: readonly ChequeRegisterRow[] = [];
const NO_PDC: readonly PdcRow[] = [];

export function PdcScreen({ params }: ScreenProps<{ ledgerId?: number }>) {
  const nav = useNav();
  const { to: asOf } = usePeriod();
  const { banks } = useBanks(asOf);
  const [ledgerId, setLedgerId] = useState<number | null>(params.ledgerId ?? null);
  const [includeMatured, setIncludeMatured] = useState(false);
  const q = useApiQuery('banking.pdc', { asOf, ledgerId: ledgerId ?? undefined, includeMatured }, { keepPrevious: true });
  const rows = q.data?.rows ?? NO_PDC;
  const spec = useMemo(() => (q.data ? pdcChart(q.data) : null), [q.data]);

  const columns = useMemo<Column<PdcRow>[]>(
    () => [
      { key: 'date', header: 'Due date', kind: 'date', width: 104, sortable: true },
      {
        key: 'daysToMaturity',
        header: 'Due in',
        width: 110,
        align: 'right',
        sortable: true,
        render: (r) =>
          r.matured ? (
            <Badge size="sm" tone="warning" title="Deposit it (received) or expect it to be presented (issued)">
              Due now
            </Badge>
          ) : (
            `${r.daysToMaturity} day${r.daysToMaturity === 1 ? '' : 's'}`
          ),
      },
      { key: 'particulars', header: 'Party', minWidth: 180, sortable: true },
      { key: 'instrumentNo', header: 'Cheque no.', width: 120 },
      { key: 'drawnOn', header: 'Drawn on', width: 130 },
      { key: 'bankLedgerName', header: 'Bank', width: 150, hidden: ledgerId !== null },
      { key: 'voucher', header: 'Voucher', width: 140, value: (r) => `${r.voucherType} ${r.number ?? ''}` },
      // In (received from customers) and Out (issued to suppliers) in their own columns: the graph's net is In − Out.
      { key: 'in', header: 'In', headerLabel: 'In (received)', kind: 'amount', width: 130, total: true, sortable: true, blankZero: true, value: pdcIn },
      { key: 'out', header: 'Out', headerLabel: 'Out (issued)', kind: 'amount', width: 130, total: true, sortable: true, blankZero: true, value: pdcOut },
    ],
    [ledgerId],
  );

  return (
    <ReportScreen
      title="Post-dated Cheques"
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      exportDef={() => pdcExport(rows)}
      graph={reportGraph(spec)}
      hint="Enter Open voucher · Alt+T Include matured · Alt+F2 Date"
      filters={<BankSelect banks={banks} value={ledgerId} onChange={setLedgerId} allowAll />}
      actions={[{ key: 'Alt+T', label: 'Include matured', onClick: () => setIncludeMatured((v) => !v), group: 'view', checked: includeMatured }]}
      meta={includeMatured ? 'Matured included' : undefined}
    >
      <DataTable
        aria-label="Post-dated cheques"
        hideEmptyColumns
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.ledgerEntryId)}
        onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
        loading={q.loading}
        empty={
          <EmptyState
            title="No post-dated cheques pending"
            body="Mark a Receipt or Payment as post-dated to keep it out of the books until its date. It is listed here until it matures."
          />
        }
      />
    </ReportScreen>
  );
}
