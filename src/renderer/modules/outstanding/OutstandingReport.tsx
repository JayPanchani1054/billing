/**
 * 'outstanding.receivables' / 'outstanding.payables' — "Outstandings" for one side, in three
 * views (Ctrl+1/2/3):
 *   Parties — party-wise outstanding ("Group Outstandings"); the answer in words on the toolbar row
 *   Bills   — every pending bill with due date and overdue days ("Bills Receivable/Payable")
 *   Ageing  — party amounts in ageing buckets (editable periods, due-date or bill-date basis) + the graph
 * "As on" = the period's end date (Alt+F2). Enter opens the party (bills: the voucher; Alt+V the party).
 * Amounts are shown ledger-signed with Dr/Cr; parties without bill-wise details are aged FIFO
 * (Alt+N switches to a single "On Account" line).
 *
 * 2.1 (SPEC-21 §1.9, D25): the stat "To collect ₹x · Overdue ₹y · ₹z not matched to bills ›" replaces the
 * KPI tiles; "N over credit limit" is the context run's one danger word; uniform columns hide (Group and
 * Credit limit used via More › Columns…); days are plain "190 d"; the credit-limit switch is a checkable
 * More item; the Ageing view is the only graph (no ageing fetch in the Parties and Bills views); its
 * periods and the bills' filters sit in popovers.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { AgeingBasis, AgeingResult, NonBillWiseMode, OutstandingSide, PartyOutstandingRow } from '../../../shared/types/outstanding.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { checkItem, columnsItem } from '../../app/lib/moreItems.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { formatDate } from '../../../shared/dates.ts';
import { Button, DataTable, EmptyState, Field, FiltersPopover, Inline, NumberInput, Popover, SegmentedControl, StatLine, Switch, TextInput, useDebouncedValue } from '../../ui/index.ts';
import type { Column, StatLineItem } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { DangerWord, Fill, GroupSelect, LimitUsed, OverdueDays, useGroupOptions } from './components.tsx';
import { ageingChart, receivablesStat } from './lib/charts.ts';
import type { OutstandingStatId } from './lib/charts.ts';
import {
  NO_BILL_FILTER,
  OUTSTANDING_VIEWS,
  SIDE_TEXT,
  ageColumnFilter,
  ageingExport,
  billFilterCount,
  billsExport,
  billsInView,
  bucketText,
  keyBills,
  ledgerSign,
  parseBucketText,
  partiesExport,
  partiesInView,
  refTypeLabel,
  withMinDays,
  withOverdueOnly,
  withUnmatchedOnly,
} from './lib/model.ts';
import type { BillFilter, KeyedBillRow, OutstandingView } from './lib/model.ts';

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

/** Columns of the Parties view shown only on request (More › Columns…); exports keep every column. */
const PARTY_COLUMNS_HIDDEN = ['groupName', 'utilisation'];

/** What each stat figure's tooltip says (the label is in the line). */
const STAT_TITLES: Readonly<Record<OutstandingStatId | 'overdueHere', string>> = {
  net: 'Bills less advances and amounts on account — the Net outstanding total',
  overdue: 'Bills past their due date — opens the Ageing view (Ctrl+3)',
  overdueHere: 'Bills past their due date',
  unmatched: 'Advances and amounts on account — opens those lines in the Bills view',
};

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
  // The Bills view's filters, changed only through lib/model.ts (they exclude each other where they must).
  const [billFilter, setBillFilter] = useState<BillFilter>({ ...NO_BILL_FILTER, overdueOnly: params.overdueOnly ?? false });
  const { overdueOnly, minDays, unmatchedOnly } = billFilter;
  const [overLimitOnly, setOverLimitOnly] = useState(false);
  const [hiddenParty, setHiddenParty] = useState<string[]>(PARTY_COLUMNS_HIDDEN);
  const [bucketDraft, setBucketDraft] = useState(bucketText(DEFAULT_AGEING_BUCKETS));
  const [buckets, setBuckets] = useState<number[]>([...DEFAULT_AGEING_BUCKETS]);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const [periodsOpen, setPeriodsOpen] = useState(false);
  const [basis, setBasis] = useState<AgeingBasis>('due_date');
  const [cursor, setCursor] = useState<{ ledgerId: number; ledgerName: string } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bucketRef = useRef<HTMLInputElement | null>(null);
  const periodsRef = useRef<HTMLButtonElement | null>(null);
  const groups = useGroupOptions(side);

  const base = { side, asOf, groupId, search: term || undefined, nonBillWise };
  const summary = useApiQuery('outstanding.partySummary', base, { keepPrevious: true });
  const bills = useApiQuery(
    'outstanding.bills',
    { ...base, overdueOnly: overdueOnly || undefined, minOverdueDays: minDays ?? undefined, limit: 10_000 },
    { keepPrevious: true, enabled: view === 'bills' },
  );
  // The Ageing view is the only one that ages (and draws): no ageing request in the other two.
  const ageing = useApiQuery('outstanding.ageing', { ...base, buckets, basis }, { keepPrevious: true, enabled: view === 'ageing' });

  // Rows AND totals of the lists as shown (the over-limit and not-matched filters recompute the totals).
  const partyView = useMemo(() => (summary.data ? partiesInView(summary.data, overLimitOnly) : undefined), [summary.data, overLimitOnly]);
  const partyRows = useMemo(() => partyView?.rows ?? [], [partyView]);
  const billView = useMemo(() => (bills.data ? billsInView(bills.data, unmatchedOnly) : undefined), [bills.data, unmatchedOnly]);
  const billRows = useMemo(() => keyBills(billView?.rows ?? []), [billView]);
  const ageRows = useMemo(() => ageing.data?.rows ?? [], [ageing.data]);

  // The highlighted party drives Alt+S / Alt+L / Alt+I / Alt+V. It must be a row of the table on
  // screen: switching views or filtering must never leave an invisible party behind.
  const visibleIds = useMemo(
    () => new Set<number>((view === 'parties' ? partyRows : view === 'bills' ? billRows : ageRows).map((r) => r.ledgerId)),
    [view, partyRows, billRows, ageRows],
  );
  const party = cursor !== null && visibleIds.has(cursor.ledgerId) ? cursor : null;
  const changeView = (v: OutstandingView): void => {
    setView(v);
    setCursor(null);
  };

  /** Applies the typed periods; false (and the reason shown) when they are not valid. */
  const applyBuckets = (): boolean => {
    const parsed = parseBucketText(bucketDraft);
    if (!parsed.ok) {
      setBucketError(parsed.error);
      return false;
    }
    setBucketError(null);
    setBuckets(parsed.buckets);
    setBucketDraft(bucketText(parsed.buckets));
    return true;
  };
  /** Forgets a typed edit: the field shows the periods in use again. */
  const discardBuckets = (): void => {
    setBucketDraft(bucketText(buckets));
    setBucketError(null);
  };
  // Esc in the field cancels the edit; the popover's own Esc handler then closes it (focus back on Periods).
  const discardOnClose = useRef(false);
  const closePeriods = (): void => {
    // Leaving the popover (outside click, Tab) applies valid periods, as leaving the 2.0 field did, and
    // forgets invalid ones; Esc forgets the edit either way.
    if (discardOnClose.current || !applyBuckets()) discardBuckets();
    discardOnClose.current = false;
    setPeriodsOpen(false);
  };

  // Bills view filters (the "not matched" link and the graph's columns set them).
  const showUnmatched = (): void => {
    changeView('bills');
    setBillFilter((f) => withUnmatchedOnly(f, true));
  };
  const drillAge = useRef<(minDays: number | null) => void>(() => undefined);
  drillAge.current = (from) => {
    changeView('bills');
    setBillFilter(ageColumnFilter(from, basis));
  };
  const onAgeColumn = useCallback((from: number | null) => drillAge.current(from), []);

  // ── The graph (Ageing view only) and the stat ──
  const ageSpec = useMemo(() => (view === 'ageing' && ageing.data ? ageingChart(ageing.data, onAgeColumn) : null), [view, ageing.data, onAgeColumn]);
  const statSource = view === 'parties' ? partyView : summary.data;
  const statItems = useMemo<StatLineItem[]>(
    () =>
      statSource
        ? receivablesStat(statSource).map((it) => ({
            label: it.label,
            value: it.value,
            link: it.link,
            title: it.id === 'overdue' && view === 'ageing' ? STAT_TITLES.overdueHere : STAT_TITLES[it.id],
            onClick: it.id === 'overdue' ? (view === 'ageing' ? undefined : () => changeView('ageing')) : it.id === 'unmatched' ? showUnmatched : undefined,
          }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statSource, view],
  );
  const overLimitCount = summary.data?.totals.overLimitCount ?? 0;

  // ── Columns ──
  const partyColumns = useMemo<Column<PartyOutstandingRow>[]>(
    () => [
      { key: 'ledgerName', header: t.party, sortable: true, minWidth: 200 },
      { key: 'overdue', header: 'Overdue', kind: 'drcr', width: 150, value: (r) => r.overdue * sign, total: true, sortable: true },
      { key: 'notDue', header: 'Not due', kind: 'drcr', width: 150, value: (r) => r.notDue * sign, total: true, sortable: true },
      { key: 'unadjusted', header: 'Advances & on account', kind: 'drcr', width: 190, value: (r) => (r.advance + r.onAccount) * sign, total: true, sortable: true },
      { key: 'pending', header: 'Net outstanding', kind: 'drcr', width: 160, value: (r) => r.pending * sign, total: true, sortable: true },
      {
        key: 'oldestDueDays',
        header: 'Oldest',
        width: 90,
        align: 'right',
        sortable: true,
        value: (r) => r.oldestDueDays || null,
        sortValue: (r) => r.oldestDueDays,
        render: (r) => <OverdueDays days={r.oldestDueDays} limits={buckets} />,
      },
      { key: 'groupName', header: 'Group', width: 150, sortable: true },
      {
        key: 'utilisation',
        header: 'Credit limit used',
        width: 140,
        align: 'right',
        sortable: true,
        value: (r) => r.utilisationPercent,
        sortValue: (r) => r.utilisationPercent ?? -1,
        render: (r) => <LimitUsed percent={r.utilisationPercent} />,
      },
    ],
    [t, sign, buckets],
  );

  const billColumns = useMemo<Column<KeyedBillRow>[]>(
    () => [
      { key: 'billDate', header: 'Date', kind: 'date', width: 110, sortable: true },
      {
        key: 'billName',
        header: 'Bill no.',
        width: 190,
        sortable: true,
        title: (r) => (r.refType === 'new' || r.refType === 'on_account' ? r.billName : `${r.billName} (${refTypeLabel(r.refType)})`),
        render: (r) =>
          r.refType === 'new' || r.refType === 'on_account' ? (
            r.billName
          ) : (
            <span className="bx-truncate">
              {r.billName}
              <span className="bx-muted"> · {refTypeLabel(r.refType)}</span>
            </span>
          ),
      },
      { key: 'ledgerName', header: t.party, minWidth: 180, sortable: true },
      { key: 'dueDate', header: 'Due date', kind: 'date', width: 110, sortable: true },
      {
        key: 'overdueDays',
        header: 'Overdue',
        width: 100,
        align: 'right',
        sortable: true,
        render: (r) => <OverdueDays days={r.overdueDays} notDueText={r.dueDate ? 'Not due' : ''} limits={buckets} />,
      },
      { key: 'originalAmount', header: 'Bill amount', kind: 'drcr', width: 150, value: (r) => r.originalAmount * sign, sortable: true },
      { key: 'pendingAmount', header: 'Pending', kind: 'drcr', width: 150, value: (r) => r.pendingAmount * sign, total: true, sortable: true },
    ],
    [t, sign, buckets],
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
    ...OUTSTANDING_VIEWS.map((v) => ({ key: v.key, label: `${v.label} view`, onClick: () => changeView(v.value), group: 'view', disabled: view === v.value })),
    { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: () => searchRef.current?.focus(), group: 'view' },
    { key: 'Alt+O', label: 'Overdue only', icon: 'filter', onClick: () => setBillFilter((f) => withOverdueOnly(f, !f.overdueOnly)), hidden: view !== 'bills', group: 'filter', checked: overdueOnly },
    { key: 'Alt+B', label: 'Ageing periods', icon: 'sliders', onClick: () => setPeriodsOpen(true), hidden: view !== 'ageing', group: 'filter', hint: `${bucketText(buckets)} days` },
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
    ...(view === 'parties' ? [checkItem('Only parties over their credit limit', overLimitOnly, setOverLimitOnly), columnsItem(partyColumns, hiddenParty, setHiddenParty)] : []),
    {
      key: 'Alt+V',
      label: 'Party outstanding',
      icon: 'list',
      onClick: () => party && openParty(party.ledgerId),
      disabled: !party,
      hidden: view === 'parties',
      group: 'party',
      hint: party ? `All bills of ${party.ledgerName}` : 'Select a bill first',
    },
    { key: 'Alt+S', label: 'Statement', icon: 'file', onClick: () => party && nav.push('outstanding.statement', { ledgerId: party.ledgerId }), disabled: !party, group: 'party', hint: party ? `Statement of account for ${party.ledgerName}` : 'Select a party first' },
    { key: 'Alt+L', label: 'Ledger', icon: 'ledger', onClick: () => party && nav.push('reports.ledger', { ledgerId: party.ledgerId }), disabled: !party, group: 'party' },
    {
      key: 'Alt+I',
      label: 'Interest',
      icon: 'percent',
      onClick: () => nav.push('outstanding.interest', party ? { ledgerId: party.ledgerId } : groupId !== undefined ? { groupId } : {}),
      group: 'go',
      hint: party ? `Interest for ${party.ledgerName}` : groupId !== undefined ? 'Interest for the parties of this group' : 'Interest for all debtors and creditors',
    },
    {
      // Collections: the highlighted customer's reminder letter (the reminders screen can widen to everyone).
      key: 'Alt+R',
      label: party ? 'Reminder letter' : 'Reminders',
      icon: 'mail',
      onClick: () => nav.push('outstanding.reminders', party ? { ledgerId: party.ledgerId } : groupId !== undefined ? { groupId } : {}),
      hidden: side !== 'receivable',
      group: 'go',
      hint: party ? `Payment reminder for ${party.ledgerName}` : 'Reminder letters for every customer with overdue bills',
    },
    // Alt+W is a convention key (Share): 2.1 keeps it here but never as a button (SPEC-21 D25, §3.1 rule 2b).
    { key: 'Alt+W', label: t.otherTitle, icon: 'arrow-right', onClick: () => nav.replace(t.otherScreen), group: 'go', demoted: true },
  ];

  const active = view === 'parties' ? summary : view === 'bills' ? bills : ageing;
  const exportDef = () => {
    if (view === 'bills' && billView) return billsExport(billView);
    if (view === 'ageing' && ageing.data) return ageingExport(ageing.data);
    return partyView ? partiesExport(partyView) : { columns: [], rows: [] };
  };
  const nothing = `Nothing ${side === 'receivable' ? 'receivable' : 'payable'} as on ${formatDate(asOf)}`;
  const filtered = !!term || groupId !== undefined || overLimitOnly || (view === 'bills' && (overdueOnly || minDays !== null || unmatchedOnly));
  const emptyBody = filtered ? 'No party or bill matches these filters — clear the search or filters.' : `Every ${t.party.toLowerCase()} is settled. Change the date with Alt+F2.`;
  const billFilters = billFilterCount(billFilter);
  const truncated = view === 'bills' && bills.data && bills.data.total > bills.data.rows.length ? bills.data : null;

  return (
    <ReportScreen
      title={t.title}
      subtitle={view === 'ageing' ? `aged by ${basis === 'due_date' ? 'due date' : 'bill date'}` : undefined}
      meta={overLimitCount > 0 ? <DangerWord>{`${overLimitCount} over credit limit`}</DangerWord> : undefined}
      periodMode="asOn"
      exportDef={exportDef}
      loading={summary.loading && !summary.data}
      refreshing={active.refreshing || (active.loading && active.data !== undefined)}
      error={active.error ?? summary.error}
      onRetry={() => void active.refetch()}
      actions={actions}
      graph={reportGraph(ageSpec)}
      stat={statItems.length ? <StatLine items={statItems} /> : undefined}
      hint={
        view === 'bills'
          ? 'Enter Open voucher · Alt+V Party · Alt+O Overdue only · Ctrl+1/2/3 Views · Ctrl+F Search · Alt+F2 As on · Alt+E Export · Esc Back'
          : `Enter Open party · Ctrl+1/2/3 Views · Ctrl+F Search · Alt+S Statement${side === 'receivable' ? ' · Alt+R Reminder' : ''} · Alt+F2 As on · Alt+E Export · Alt+P Print · Esc Back`
      }
      toolbar={
        truncated ? (
          <span className="bx-muted" title="Narrow the search to see the rest">
            {`First ${truncated.rows.length.toLocaleString('en-IN')} of ${truncated.total.toLocaleString('en-IN')} bills`}
          </span>
        ) : undefined
      }
      filters={
        <Inline gap={2}>
          <SegmentedControl<OutstandingView> aria-label="View" size="sm" value={view} onChange={changeView} options={OUTSTANDING_VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
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
          {view === 'bills' ? (
            <FiltersPopover
              count={billFilters}
              onClear={() => setBillFilter(NO_BILL_FILTER)}
            >
              <Switch
                size="sm"
                checked={overdueOnly}
                onChange={(on) => setBillFilter((f) => withOverdueOnly(f, on))}
                label="Overdue only"
                showState={false}
                aria-keyshortcuts="Alt+O"
              />
              <Field label="Overdue by at least" layout="inline" labelWidth="auto">
                <NumberInput
                  size="sm"
                  value={minDays}
                  onChange={(v) => setBillFilter((f) => withMinDays(f, v))}
                  min={0}
                  max={36_500}
                  suffix="days"
                  style={{ width: 90 }}
                  aria-label="Minimum overdue days"
                />
              </Field>
              <Switch
                size="sm"
                checked={unmatchedOnly}
                onChange={(on) => setBillFilter((f) => withUnmatchedOnly(f, on))}
                label="Only advances and on account"
                showState={false}
              />
            </FiltersPopover>
          ) : view === 'ageing' ? (
            <>
              <Button
                ref={periodsRef}
                variant="ghost"
                size="sm"
                iconRight="chevron-down"
                aria-haspopup="dialog"
                aria-expanded={periodsOpen}
                aria-keyshortcuts="Alt+B"
                title="Ageing periods · Alt+B"
                onClick={() => (periodsOpen ? closePeriods() : setPeriodsOpen(true))}
              >
                {`Periods ${bucketText(buckets)} days`}
              </Button>
              <Popover open={periodsOpen} onClose={closePeriods} anchorRef={periodsRef} aria-label="Ageing periods" initialFocus={bucketRef}>
                <Field label="Ageing periods (days)" error={bucketError ?? undefined}>
                  <TextInput
                    ref={bucketRef}
                    size="sm"
                    value={bucketDraft}
                    onValueChange={setBucketDraft}
                    onKeyDown={(e) => {
                      // Esc cancels the edit (the popover closes itself and returns focus to Periods).
                      if (e.key === 'Escape') discardOnClose.current = true;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (applyBuckets()) {
                          setPeriodsOpen(false);
                          periodsRef.current?.focus();
                        }
                      }
                    }}
                    style={{ width: 200 }}
                  />
                </Field>
              </Popover>
            </>
          ) : null}
        </Inline>
      }
    >
      {view === 'parties' ? (
        <DataTable<PartyOutstandingRow>
          aria-label={`${t.title} by party`}
          autoFocus
          columns={partyColumns}
          rows={partyRows}
          getRowKey={(r) => String(r.ledgerId)}
          loading={summary.loading}
          hideEmptyColumns
          hiddenColumns={hiddenParty}
          onRowActivate={(r) => openParty(r.ledgerId)}
          onSelect={(_, r) => setCursor(r ? { ledgerId: r.ledgerId, ledgerName: r.ledgerName } : null)}
          typeToJump={(r) => r.ledgerName}
          empty={<EmptyState icon="check-circle" title={nothing} body={emptyBody} />}
        />
      ) : view === 'bills' ? (
        <DataTable<KeyedBillRow>
          aria-label={`${t.title} by bill`}
          autoFocus
          columns={billColumns}
          rows={billRows}
          getRowKey={(r) => r.key}
          loading={bills.loading}
          hideEmptyColumns
          onRowActivate={(r) => (r.voucherId !== null ? nav.push('vouchers.view', { id: r.voucherId }) : openParty(r.ledgerId))}
          onSelect={(_, r) => setCursor(r ? { ledgerId: r.ledgerId, ledgerName: r.ledgerName } : null)}
          typeToJump={(r) => r.billName}
          empty={<EmptyState icon="check-circle" title={overdueOnly || minDays !== null ? 'No overdue bills' : nothing} body={emptyBody} />}
        />
      ) : (
        <Fill>
          <DataTable<AgeingRow>
            aria-label={`${t.title} ageing`}
            autoFocus
            columns={ageColumns}
            rows={ageRows}
            getRowKey={(r) => String(r.ledgerId)}
            loading={ageing.loading}
            hideEmptyColumns
            onRowActivate={(r) => openParty(r.ledgerId)}
            onSelect={(_, r) => setCursor(r ? { ledgerId: r.ledgerId, ledgerName: r.ledgerName } : null)}
            typeToJump={(r) => r.ledgerName}
            empty={<EmptyState icon="check-circle" title={nothing} body={emptyBody} />}
          />
        </Fill>
      )}
    </ReportScreen>
  );
}
