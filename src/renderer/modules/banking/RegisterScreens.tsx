/**
 * Banking registers:
 *  - 'banking.cheques' { ledgerId? } — cheques/DDs issued and received in the period (Alt+F2), with clearing
 *    status, stale cheques (over 3 months) and totals. Filters: bank, status (Ctrl+1/2/3), direction.
 *  - 'banking.pdc' { ledgerId? } — post-dated cheques pending as on the period end, receivable and payable,
 *    days to maturity; Alt+T also lists matured ones.
 * Enter opens the voucher; Alt+E export, Alt+P print.
 */
import { useMemo, useState } from 'react';
import type { ChequeDirection, ChequeRegisterRow, ChequeStatusFilter, PdcRow } from '../../../shared/types/banking.ts';
import { formatMoney } from '../../../shared/format.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Badge, DataTable, EmptyState, Inline, KpiCard, SegmentedControl, Stack, Switch } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { BankSelect, useBanks } from './components.tsx';
import { CHEQUE_STATUS_LABEL, chequeRegisterExport, pdcExport } from './lib/exports.ts';

const STATUS_OPTIONS: ReadonlyArray<{ value: ChequeStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'uncleared', label: 'Not cleared' },
  { value: 'cleared', label: 'Cleared' },
];
const DIRECTION_OPTIONS: ReadonlyArray<{ value: ChequeDirection | 'all'; label: string }> = [
  { value: 'all', label: 'Issued & received' },
  { value: 'issued', label: 'Issued' },
  { value: 'received', label: 'Received' },
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
  const totals = q.data?.totals;

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
        render: (r) =>
          r.stale ? (
            <Badge size="sm" tone="danger" icon="alert">
              Stale (over 3 months)
            </Badge>
          ) : (
            <Badge size="sm" tone={r.status === 'cleared' ? 'success' : r.status === 'post_dated' ? 'info' : 'warning'}>
              {CHEQUE_STATUS_LABEL[r.status]}
            </Badge>
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
      hint="Enter open voucher · Ctrl+1/2/3 All / Not cleared / Cleared · Alt+F2 period"
      filters={
        <Inline gap={2} wrap>
          <BankSelect banks={banks} value={ledgerId} onChange={setLedgerId} allowAll />
          <SegmentedControl aria-label="Clearing status" size="sm" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
          <SegmentedControl aria-label="Issued or received" size="sm" options={DIRECTION_OPTIONS} value={direction} onChange={setDirection} />
        </Inline>
      }
      actions={[
        { key: 'Ctrl+1', label: 'All cheques', onClick: () => setStatus('all'), group: 'view', disabled: status === 'all' },
        { key: 'Ctrl+2', label: 'Not cleared', onClick: () => setStatus('uncleared'), group: 'view', disabled: status === 'uncleared' },
        { key: 'Ctrl+3', label: 'Cleared', onClick: () => setStatus('cleared'), group: 'view', disabled: status === 'cleared' },
        { key: 'Alt+R', label: 'Reconciliation', icon: 'bank', onClick: () => nav.push('banking.brs', { ledgerId: ledgerId ?? undefined }), group: 'go' },
      ]}
    >
      <Stack gap={3}>
        {totals ? (
          <Inline gap={3} wrap>
            <KpiCard label="Cheques issued" value={totals.issued.amount} amount caption={`${totals.issued.count} cheques · ${totals.issued.uncleared} not cleared (${formatMoney(totals.issued.unclearedAmount, { symbol: true })})`} icon="arrow-up" />
            <KpiCard label="Cheques received" value={totals.received.amount} amount caption={`${totals.received.count} cheques · ${totals.received.uncleared} not cleared (${formatMoney(totals.received.unclearedAmount, { symbol: true })})`} icon="arrow-down" />
            <KpiCard label="Stale cheques" value={String(totals.stale)} caption="Not cleared and older than 3 months — re-issue or cancel" icon="alert" />
          </Inline>
        ) : null}
        <div className="bx-bk-table--tall">
          <DataTable
            aria-label="Cheque register"
            autoFocus
            columns={columns}
            rows={rows}
            getRowKey={(r) => String(r.ledgerEntryId)}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
            loading={q.loading}
            empty={<EmptyState icon="book" title="No cheques in this period" body="Cheques and DDs entered in Payment, Receipt and Contra vouchers appear here. Change the period with Alt+F2." />}
          />
        </div>
      </Stack>
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
  const totals = q.data?.totals;

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
            <Badge size="sm" tone="warning">
              Due — deposit / present
            </Badge>
          ) : (
            `${r.daysToMaturity} day${r.daysToMaturity === 1 ? '' : 's'}`
          ),
      },
      { key: 'kind', header: 'Type', width: 110, sortable: true, render: (r) => <Badge size="sm" tone={r.kind === 'receivable' ? 'info' : 'neutral'}>{r.kind === 'receivable' ? 'Receivable' : 'Payable'}</Badge> },
      { key: 'particulars', header: 'Party', minWidth: 180, sortable: true },
      { key: 'instrumentNo', header: 'Cheque no.', width: 120 },
      { key: 'drawnOn', header: 'Drawn on', width: 130 },
      { key: 'bankLedgerName', header: 'Bank', width: 150, hidden: ledgerId !== null },
      { key: 'voucher', header: 'Voucher', width: 140, value: (r) => `${r.voucherType} ${r.number ?? ''}` },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 130, total: true, sortable: true },
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
      hint="Enter open voucher · Alt+T include matured · Alt+F2 date"
      filters={
        <Inline gap={2} wrap align="center">
          <BankSelect banks={banks} value={ledgerId} onChange={setLedgerId} allowAll />
          <Switch checked={includeMatured} onChange={setIncludeMatured} label="Include matured" size="sm" />
        </Inline>
      }
      actions={[{ key: 'Alt+T', label: includeMatured ? 'Hide matured' : 'Include matured', onClick: () => setIncludeMatured((v) => !v), group: 'view' }]}
    >
      <Stack gap={3}>
        {totals ? (
          <Inline gap={3} wrap>
            <KpiCard label="PDC receivable" value={totals.receivable.amount} amount caption={`${totals.receivable.count} cheque${totals.receivable.count === 1 ? '' : 's'} from customers`} icon="arrow-down" />
            <KpiCard label="PDC payable" value={totals.payable.amount} amount caption={`${totals.payable.count} cheque${totals.payable.count === 1 ? '' : 's'} issued to suppliers`} icon="arrow-up" />
          </Inline>
        ) : null}
        <div className="bx-bk-table--tall">
          <DataTable
            aria-label="Post-dated cheques"
            autoFocus
            columns={columns}
            rows={rows}
            getRowKey={(r) => String(r.ledgerEntryId)}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
            loading={q.loading}
            empty={
              <EmptyState
                icon="calendar"
                title="No post-dated cheques pending"
                body="Mark a Receipt or Payment as post-dated to keep it out of the books until its date. It is listed here until it matures."
              />
            }
          />
        </div>
      </Stack>
    </ReportScreen>
  );
}
