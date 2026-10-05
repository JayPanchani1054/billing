/**
 * 'outstanding.receivables' / 'outstanding.payables' — Tally "Outstandings" for one side, in three
 * views (Ctrl+1/2/3):
 *   Parties — KPI strip + party-wise outstanding with credit-limit use (Tally "Group Outstandings")
 *   Bills   — every pending bill with due date and overdue days (Tally "Bills Receivable/Payable")
 *   Ageing  — party amounts in ageing buckets (editable periods, due-date or bill-date basis) + chart
 * "As on" = the period's end date (Alt+F2). Enter opens the party (bills: the voucher).
 * Amounts are shown ledger-signed with Dr/Cr; parties without bill-wise details are aged FIFO
 * (Alt+N switches to a single "On Account" line).
 */
import { useMemo, useRef, useState } from 'react';
import type { AgeingBasis, AgeingResult, NonBillWiseMode, OutstandingSide, PartyOutstandingRow } from '../../../shared/types/outstanding.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { formatDate } from '../../../shared/dates.ts';
import {
  Badge,
  BarChart,
  DataTable,
  EmptyState,
  Field,
  Inline,
  NumberInput,
  SegmentedControl,
  Switch,
  TextInput,
  useDebouncedValue,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { Fill, GroupSelect, KpiStrip, OverdueBadge, UtilisationBar, VGap, useGroupOptions } from './components.tsx';
import {
  OUTSTANDING_VIEWS,
  SIDE_TEXT,
  ageingExport,
  billsExport,
  bucketText,
  keyBills,
  ledgerSign,
  parseBucketText,
  partiesExport,
  refTypeLabel,
} from './lib/model.ts';
import type { KeyedBillRow, OutstandingView } from './lib/model.ts';

export interface OutstandingParams {
  view?: OutstandingView;
  groupId?: number;
  overdueOnly?: boolean;
}

export function ReceivablesScreen({ params }: ScreenProps<OutstandingParams>) {
  return <OutstandingReport side="receivable" params={params ?? {}} />;
}

export function PayablesScreen({ params }: ScreenProps<OutstandingParams>) {
  return <OutstandingReport side="payable" params={params ?? {}} />;
}

type AgeingRow = AgeingResult['rows'][number];

function OutstandingReport({ side, params }: { side: OutstandingSide; params: OutstandingParams }) {
  const nav = useNav();
  const { to: asOf } = usePeriod();
  const t = SIDE_TEXT[side];
  const sign = ledgerSign(side);

  const [view, setView] = useState<OutstandingView>(params.view ?? (params.overdueOnly ? 'bills' : 'parties'));
  const [fifo, setFifo] = useState(true);
  const nonBillWise: NonBillWiseMode = fifo ? 'fifo' : 'on_account';
  const [groupId, setGroupId] = useState<number | undefined>(params.groupId);
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search.trim(), 250);
  const [overdueOnly, setOverdueOnly] = useState(params.overdueOnly ?? false);
  const [minDays, setMinDays] = useState<number | null>(null);
  const [overLimitOnly, setOverLimitOnly] = useState(false);
  const [bucketDraft, setBucketDraft] = useState(bucketText(DEFAULT_AGEING_BUCKETS));
  const [buckets, setBuckets] = useState<number[]>([...DEFAULT_AGEING_BUCKETS]);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const [basis, setBasis] = useState<AgeingBasis>('due_date');
  const [cursor, setCursor] = useState<{ ledgerId: number; ledgerName: string } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bucketRef = useRef<HTMLInputElement | null>(null);
  const groups = useGroupOptions(side);

  const base = { side, asOf, groupId, search: term || undefined, nonBillWise };
  const summary = useApiQuery('outstanding.partySummary', base, { keepPrevious: true });
  const bills = useApiQuery(
    'outstanding.bills',
    { ...base, overdueOnly: overdueOnly || undefined, minOverdueDays: minDays ?? undefined, limit: 10_000 },
    { keepPrevious: true, enabled: view === 'bills' },
  );
  const ageing = useApiQuery('outstanding.ageing', { ...base, buckets, basis }, { keepPrevious: true, enabled: view === 'ageing' });

  const partyRows = useMemo(() => (summary.data?.rows ?? []).filter((r) => !overLimitOnly || r.overLimit), [summary.data, overLimitOnly]);
  const billRows = useMemo(() => keyBills(bills.data?.rows ?? []), [bills.data]);
  const ageRows = ageing.data?.rows ?? [];

  const applyBuckets = (): void => {
    const parsed = parseBucketText(bucketDraft);
    if (!parsed.ok) {
      setBucketError(parsed.error);
      return;
    }
    setBucketError(null);
    setBuckets(parsed.buckets);
    setBucketDraft(bucketText(parsed.buckets));
  };

  // ── Columns ──
  const partyColumns = useMemo<Column<PartyOutstandingRow>[]>(
    () => [
      { key: 'ledgerName', header: t.party, sortable: true, minWidth: 200 },
      { key: 'groupName', header: 'Group', width: 150, sortable: true },
      { key: 'pending', header: 'Outstanding', kind: 'drcr', width: 150, value: (r) => r.pending * sign, total: true, sortable: true },
      { key: 'overdue', header: 'Overdue', kind: 'drcr', width: 140, value: (r) => r.overdue * sign, total: true, sortable: true },
      { key: 'notDue', header: 'Not due', kind: 'drcr', width: 140, value: (r) => r.notDue * sign, total: true, sortable: true },
      { key: 'unadjusted', header: 'Adv. / on a/c', kind: 'drcr', width: 140, value: (r) => (r.advance + r.onAccount) * sign, total: true, sortable: true },
      {
        key: 'oldestDueDays',
        header: 'Oldest overdue',
        width: 120,
        align: 'right',
        sortable: true,
        value: (r) => r.oldestDueDays,
        render: (r) => <OverdueBadge days={r.oldestDueDays} />,
      },
      {
        key: 'utilisation',
        header: 'Credit limit used',
        width: 160,
        sortable: true,
        value: (r) => r.utilisationPercent,
        sortValue: (r) => r.utilisationPercent ?? -1,
        render: (r) => <UtilisationBar percent={r.utilisationPercent} partyName={r.ledgerName} />,
      },
    ],
    [t, sign],
  );

  const billColumns = useMemo<Column<KeyedBillRow>[]>(
    () => [
      { key: 'billDate', header: 'Date', kind: 'date', width: 110, sortable: true },
      {
        key: 'billName',
        header: 'Bill no.',
        width: 170,
        sortable: true,
        render: (r) =>
          r.refType === 'new' ? (
            r.billName
          ) : (
            <Inline gap={1} wrap={false}>
              <span className="bx-truncate">{r.billName}</span>
              <Badge size="sm" tone={r.refType === 'advance' ? 'info' : 'neutral'}>
                {refTypeLabel(r.refType)}
              </Badge>
            </Inline>
          ),
      },
      { key: 'ledgerName', header: t.party, minWidth: 180, sortable: true },
      { key: 'dueDate', header: 'Due date', kind: 'date', width: 110, sortable: true },
      {
        key: 'overdueDays',
        header: 'Overdue',
        width: 110,
        align: 'right',
        sortable: true,
        render: (r) => <OverdueBadge days={r.overdueDays} notDueText={r.dueDate ? 'Not due' : ''} />,
      },
      { key: 'originalAmount', header: 'Bill amount', kind: 'drcr', width: 150, value: (r) => r.originalAmount * sign, sortable: true },
      { key: 'pendingAmount', header: 'Pending', kind: 'drcr', width: 150, value: (r) => r.pendingAmount * sign, total: true, sortable: true },
    ],
    [t, sign],
  );

  const bucketLabels = ageing.data?.buckets.map((b) => b.label).join('|') ?? '';
  const ageColumns = useMemo<Column<AgeingRow>[]>(() => {
    const labels = bucketLabels ? bucketLabels.split('|') : [];
    return [
      { key: 'ledgerName', header: t.party, sortable: true, minWidth: 200 },
      ...labels.map(
        (label, i): Column<AgeingRow> => ({ key: `b${i}`, header: label, kind: 'drcr', width: 130, value: (r) => r.amounts[i] * sign, total: true, sortable: true }),
      ),
      { key: 'advance', header: 'Advance', kind: 'drcr', width: 120, value: (r) => r.advance * sign, total: true },
      { key: 'onAccount', header: 'On account', kind: 'drcr', width: 120, value: (r) => r.onAccount * sign, total: true },
      { key: 'total', header: 'Total', kind: 'drcr', width: 150, value: (r) => r.total * sign, total: true, sortable: true },
    ];
  }, [t, sign, bucketLabels]);

  // ── Actions ──
  const openParty = (ledgerId: number): void => {
    nav.push('outstanding.party', { ledgerId });
  };
  const actions: ScreenActionItem[] = [
    ...OUTSTANDING_VIEWS.map((v) => ({ key: v.key, label: `${v.label} view`, onClick: () => setView(v.value), group: 'view', disabled: view === v.value })),
    { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: () => searchRef.current?.focus(), group: 'view' },
    { key: 'Alt+O', label: overdueOnly ? 'Show all bills' : 'Overdue only', icon: 'filter', onClick: () => setOverdueOnly((x) => !x), hidden: view !== 'bills', group: 'filter' },
    { key: 'Alt+B', label: 'Ageing periods', icon: 'sliders', onClick: () => bucketRef.current?.focus(), hidden: view !== 'ageing', group: 'filter' },
    {
      key: 'Alt+U',
      label: basis === 'due_date' ? 'Age by bill date' : 'Age by due date',
      icon: 'calendar',
      onClick: () => setBasis((b) => (b === 'due_date' ? 'bill_date' : 'due_date')),
      hidden: view !== 'ageing',
      group: 'filter',
    },
    {
      key: 'Alt+N',
      label: fifo ? 'Non-bill-wise: On Account' : 'Non-bill-wise: FIFO',
      onClick: () => setFifo((x) => !x),
      group: 'filter',
      hint: 'Parties without bill-wise details: age their balance FIFO against the latest invoices, or show it as one On Account line',
    },
    { key: 'Alt+S', label: 'Statement', icon: 'file', onClick: () => cursor && nav.push('outstanding.statement', { ledgerId: cursor.ledgerId }), disabled: !cursor, group: 'party', hint: cursor ? `Statement of account for ${cursor.ledgerName}` : 'Select a party first' },
    { key: 'Alt+L', label: 'Ledger', icon: 'ledger', onClick: () => cursor && nav.push('reports.ledger', { ledgerId: cursor.ledgerId }), disabled: !cursor, group: 'party' },
    { key: 'Alt+I', label: 'Interest', icon: 'percent', onClick: () => nav.push('outstanding.interest', cursor ? { ledgerId: cursor.ledgerId } : groupId !== undefined ? { groupId } : {}), group: 'go' },
    { key: 'Alt+R', label: 'Reminders', icon: 'mail', onClick: () => nav.push('outstanding.reminders', groupId !== undefined ? { groupId } : {}), hidden: side !== 'receivable', group: 'go' },
    { key: 'Alt+W', label: t.otherTitle, icon: 'arrow-right', onClick: () => nav.replace(t.otherScreen), group: 'go' },
  ];

  const active = view === 'parties' ? summary : view === 'bills' ? bills : ageing;
  const exportDef = () => {
    if (view === 'bills' && bills.data) return billsExport(bills.data);
    if (view === 'ageing' && ageing.data) return ageingExport(ageing.data);
    return summary.data ? partiesExport({ ...summary.data, rows: partyRows }) : { columns: [], rows: [] };
  };
  const nothing = `Nothing ${side === 'receivable' ? 'receivable' : 'payable'} as on ${formatDate(asOf)}`;
  const filtered = !!term || groupId !== undefined || overLimitOnly || (view === 'bills' && (overdueOnly || minDays !== null));
  const emptyBody = filtered ? 'No party or bill matches these filters — clear the search or filters.' : `Every ${t.party.toLowerCase()} is settled. Change the date with Alt+F2.`;

  return (
    <ReportScreen
      title={t.title}
      subtitle={view === 'parties' ? 'Party-wise outstanding' : view === 'bills' ? 'Bill-wise outstanding' : `Ageing by ${basis === 'due_date' ? 'due date' : 'bill date'}`}
      periodMode="asOn"
      exportDef={exportDef}
      loading={summary.loading && !summary.data}
      refreshing={active.refreshing || (active.loading && active.data !== undefined)}
      error={active.error ?? summary.error}
      onRetry={() => void active.refetch()}
      actions={actions}
      hint="Enter Open · Ctrl+1/2/3 Views · Ctrl+F Search · Alt+F2 As on · Alt+E Export · Alt+P Print · Esc Back"
      filters={
        <Inline gap={2}>
          <SegmentedControl<OutstandingView> aria-label="View" size="sm" value={view} onChange={setView} options={OUTSTANDING_VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
          <TextInput
            ref={searchRef}
            size="sm"
            leadingIcon="search"
            value={search}
            onValueChange={setSearch}
            placeholder={`Search ${t.parties}${view === 'bills' ? ' or bills' : ''}`}
            aria-label={`Search ${t.parties}`}
          />
          <GroupSelect options={groups} value={groupId} onChange={setGroupId} allLabel={side === 'receivable' ? 'All debtors' : 'All creditors'} />
        </Inline>
      }
    >
      <KpiStrip
        summary={summary.data}
        loading={summary.loading}
        onOverdue={() => {
          setView('bills');
          setOverdueOnly(true);
        }}
        onOverLimit={() => {
          setView('parties');
          setOverLimitOnly(true);
        }}
      />
      <VGap />
      {view === 'parties' ? (
        <>
          <Inline gap={3}>
            <Switch size="sm" checked={overLimitOnly} onChange={setOverLimitOnly} label="Only parties over their credit limit" showState={false} />
          </Inline>
          <VGap />
          <DataTable<PartyOutstandingRow>
            aria-label={`${t.title} by party`}
            autoFocus
            columns={partyColumns}
            rows={partyRows}
            getRowKey={(r) => String(r.ledgerId)}
            loading={summary.loading}
            onRowActivate={(r) => openParty(r.ledgerId)}
            onSelect={(_, r) => setCursor(r ? { ledgerId: r.ledgerId, ledgerName: r.ledgerName } : null)}
            typeToJump={(r) => r.ledgerName}
            empty={<EmptyState icon="check-circle" title={nothing} body={emptyBody} />}
          />
        </>
      ) : view === 'bills' ? (
        <>
          <Inline gap={3}>
            <Switch size="sm" checked={overdueOnly} onChange={setOverdueOnly} label="Overdue only" showState={false} aria-keyshortcuts="Alt+O" />
            <Field label="Overdue by at least" layout="inline" labelWidth="auto">
              <NumberInput size="sm" value={minDays} onChange={(v) => setMinDays(v === null || v <= 0 ? null : Math.round(v))} min={0} max={36_500} suffix="days" style={{ width: 90 }} aria-label="Minimum overdue days" />
            </Field>
            {bills.data && bills.data.total > billRows.length ? (
              <span className="bx-muted">
                Showing the first {billRows.length.toLocaleString('en-IN')} of {bills.data.total.toLocaleString('en-IN')} bills — narrow the search to see the rest.
              </span>
            ) : null}
          </Inline>
          <VGap />
          <DataTable<KeyedBillRow>
            aria-label={`${t.title} by bill`}
            autoFocus
            columns={billColumns}
            rows={billRows}
            getRowKey={(r) => r.key}
            loading={bills.loading}
            onRowActivate={(r) => (r.voucherId !== null ? nav.push('vouchers.view', { id: r.voucherId }) : openParty(r.ledgerId))}
            onSelect={(_, r) => setCursor(r ? { ledgerId: r.ledgerId, ledgerName: r.ledgerName } : null)}
            typeToJump={(r) => r.billName}
            empty={<EmptyState icon="check-circle" title={overdueOnly || minDays !== null ? 'No overdue bills' : nothing} body={emptyBody} />}
          />
        </>
      ) : (
        <>
          <Inline gap={3} align="start">
            <Field label="Ageing periods (days)" layout="inline" labelWidth="auto" error={bucketError ?? undefined}>
              <TextInput
                ref={bucketRef}
                size="sm"
                value={bucketDraft}
                onValueChange={setBucketDraft}
                onBlur={applyBuckets}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyBuckets();
                  }
                }}
                aria-keyshortcuts="Alt+B"
                style={{ width: 170 }}
              />
            </Field>
            <SegmentedControl<AgeingBasis>
              aria-label="Age by"
              size="sm"
              value={basis}
              onChange={setBasis}
              options={[
                { value: 'due_date', label: 'By due date' },
                { value: 'bill_date', label: 'By bill date' },
              ]}
            />
          </Inline>
          <VGap />
          {ageing.data && ageing.data.rows.length > 0 ? (
            <>
              <BarChart
                title={`${t.title} by age, as on ${formatDate(asOf)}`}
                description="Total outstanding in each ageing period"
                categories={ageing.data.buckets.map((b) => b.label)}
                series={[{ name: t.amount, values: ageing.data.totals.amounts, slot: 1 }]}
                valueFormat="inr"
                height={170}
              />
              <VGap />
            </>
          ) : null}
          <Fill>
            <DataTable<AgeingRow>
              aria-label={`${t.title} ageing`}
              autoFocus
              columns={ageColumns}
              rows={ageRows}
              getRowKey={(r) => String(r.ledgerId)}
              loading={ageing.loading}
              onRowActivate={(r) => openParty(r.ledgerId)}
              onSelect={(_, r) => setCursor(r ? { ledgerId: r.ledgerId, ledgerName: r.ledgerName } : null)}
              typeToJump={(r) => r.ledgerName}
              empty={<EmptyState icon="check-circle" title={nothing} body={emptyBody} />}
            />
          </Fill>
        </>
      )}
    </ReportScreen>
  );
}
