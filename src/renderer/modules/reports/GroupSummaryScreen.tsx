/**
 * 'reports.groupSummary' {groupId, from?, to?, view?, basis?} — sub-groups and ledgers of a group with
 * opening, debit, credit and closing (Tally Group Summary). Alt+V shows the group's vouchers instead
 * (Tally Group Vouchers); Alt+M opens the monthly summary. Enter drills further (sub-group → its
 * summary, ledger → Ledger Vouchers, voucher → the voucher; Alt+A alters it).
 * `basis: 'profitLoss'` (drilled from the P&L): income/expense groups show this period only, so the
 * total agrees with the P&L line; sub-groups opened from here keep that basis.
 */
import { useMemo, useState } from 'react';
import type { GroupSummaryBasis, GroupVoucherRow, TbRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState, SegmentedControl, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { TbTable, useDrill, useReportPeriod, useTreeExpansion } from './components.tsx';
import { currentRow, drillForRow, tbExport, voucherTarget } from './lib/model.ts';
import { visibleRows } from './lib/tree.ts';

export interface GroupSummaryParams {
  groupId?: number;
  from?: string;
  to?: string;
  view?: 'summary' | 'vouchers';
  basis?: GroupSummaryBasis;
}

type View = 'summary' | 'vouchers';

export function GroupSummaryScreen({ params }: ScreenProps<GroupSummaryParams>) {
  const groupId = typeof params?.groupId === 'number' ? params.groupId : null;
  const p = useReportPeriod(params);
  const drill = useDrill();
  const [view, setView] = useState<View>(params?.view ?? 'summary');
  const [showOpening, setShowOpening] = useState(true);
  const [showZero, setShowZero] = useState(false);
  const [cursor, setCursor] = useState<GroupVoucherRow | null>(null);
  const requestedBasis: GroupSummaryBasis = params?.basis === 'profitLoss' ? 'profitLoss' : 'trialBalance';
  const summary = useApiQuery(
    'reports.groupSummary',
    { groupId: groupId ?? 0, from: p.from, to: p.to, showZero, basis: requestedBasis },
    { keepPrevious: true, enabled: groupId !== null },
  );
  // The server falls back to the Trial-Balance basis for asset/liability groups.
  const basis: GroupSummaryBasis = summary.data?.basis ?? requestedBasis;
  const vouchers = useApiQuery('reports.groupVouchers', { groupId: groupId ?? 0, from: p.from, to: p.to }, { keepPrevious: true, enabled: groupId !== null && view === 'vouchers' });
  const rows = useMemo(() => summary.data?.rows ?? [], [summary.data]);
  const expansion = useTreeExpansion(`gs:${groupId ?? 0}`, rows, 0);
  const title = summary.data ? summary.data.group.name : 'Group Summary';
  const v = vouchers.data;
  const selected = currentRow(cursor, v?.rows, (r) => r.voucherId);

  const actions: ScreenActionItem[] = [
    { key: 'Alt+V', label: view === 'summary' ? 'Group vouchers' : 'Group summary', icon: 'list', onClick: () => setView(view === 'summary' ? 'vouchers' : 'summary'), group: 'view' },
    { key: 'Alt+M', label: 'Monthly summary', icon: 'calendar', onClick: () => groupId !== null && drill({ screen: 'reports.monthlySummary', params: { groupId, from: p.from, to: p.to } }), group: 'view' },
    { key: 'Alt+O', label: showOpening ? 'Hide opening' : 'Show opening', icon: 'columns', onClick: () => setShowOpening(!showOpening), hidden: view !== 'summary', group: 'view' },
    { key: 'Alt+Z', label: showZero ? 'Hide zero balances' : 'Show zero balances', icon: 'eye', onClick: () => setShowZero(!showZero), hidden: view !== 'summary', group: 'view' },
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', onClick: () => selected && drill(voucherTarget(selected.voucherId, selected.baseType, true)), hidden: view !== 'vouchers', disabled: !selected, group: 'voucher' },
  ];

  const vColumns = useMemo<Column<GroupVoucherRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'particulars', header: 'Particulars', minWidth: 220 },
      { key: 'voucherType', header: 'Vch Type', width: 130 },
      { key: 'number', header: 'Vch No.', width: 110 },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 140, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 140, blankZero: true },
      { key: 'balance', header: 'Balance', kind: 'drcr', width: 160 },
    ],
    [],
  );
  const vFooter: FooterRow[] = v
    ? [
        { key: 'opening', tone: 'subtle', cells: { particulars: 'Opening Balance', balance: v.opening } },
        { key: 'current', tone: 'subtle', cells: { particulars: 'Current Total', debit: v.totals.debit, credit: v.totals.credit } },
        { key: 'closing', tone: 'total', cells: { particulars: 'Closing Balance', balance: v.closing } },
      ]
    : [];

  if (groupId === null) {
    return (
      <ReportScreen title="Group Summary" periodMode="none">
        <EmptyState icon="layers" title="Choose a group" body="Open a group from the Trial Balance or the Balance Sheet (Enter on the group line)." />
      </ReportScreen>
    );
  }
  const q = view === 'summary' ? summary : vouchers;
  return (
    <ReportScreen
      title={title}
      subtitle={summary.data ? `${summary.data.group.path.join(' › ')}${basis === 'profitLoss' ? ' · as in the Profit & Loss A/c (this period only)' : ''}` : undefined}
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint={view === 'summary' ? 'Enter Drill down · →/← Expand/collapse · Alt+V Vouchers · Alt+M Monthly' : 'Enter Open voucher · Alt+A Alter · Alt+V Summary'}
      filters={
        <SegmentedControl<View>
          aria-label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'vouchers', label: 'Vouchers' },
          ]}
        />
      }
      exportDef={() =>
        view === 'summary'
          ? { subtitle: basis === 'profitLoss' ? 'Group Summary (Profit & Loss basis)' : 'Group Summary', ...tbExport(visibleRows(rows, expansion.expandedKeys), { opening: showOpening, transactions: true }) }
          : {
              subtitle: 'Group Vouchers',
              columns: [
                { header: 'Date', kind: 'date' },
                { header: 'Particulars' },
                { header: 'Vch Type' },
                { header: 'Vch No.' },
                { header: 'Debit', kind: 'amount' },
                { header: 'Credit', kind: 'amount' },
                { header: 'Balance', kind: 'drcr' },
              ],
              rows: (v?.rows ?? []).map((r) => [r.date, r.particulars, r.voucherType, r.number ?? '', r.debit || null, r.credit || null, r.balance]),
              totals: v ? ['', 'Closing Balance', '', '', v.totals.debit, v.totals.credit, v.closing] : undefined,
            }
      }
    >
      {view === 'summary' ? (
        <TbTable
          aria-label={`${title} — group summary`}
          rows={rows}
          expansion={expansion}
          showOpening={showOpening}
          showTransactions
          onActivate={(r: TbRow) => drill(drillForRow(r, p.period, { basis }))}
          loading={summary.loading}
          totalLabel="Total"
        />
      ) : (
        <Stack gap={2} grow>
          <DataTable<GroupVoucherRow>
            aria-label={`${title} — vouchers`}
            className="bx-rep-fill"
            columns={vColumns}
            rows={v?.rows ?? []}
            getRowKey={(r) => String(r.voucherId)}
            onRowActivate={(r) => drill(voucherTarget(r.voucherId, r.baseType))}
            onSelect={(_k, r) => setCursor(r)}
            footerRows={vFooter}
            loading={vouchers.loading}
            empty={<EmptyState icon="receipt" title="No vouchers in this period" body="Change the period with Alt+F2." />}
            autoFocus
          />
          {v?.truncated ? <p className="bx-rep-note">Showing the first {v.rows.length.toLocaleString('en-IN')} of {v.count.toLocaleString('en-IN')} vouchers; totals include all of them. Narrow the period to see the rest.</p> : null}
        </Stack>
      )}
    </ReportScreen>
  );
}
