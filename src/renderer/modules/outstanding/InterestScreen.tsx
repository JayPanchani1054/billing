/**
 * 'outstanding.interest' { ledgerId?, groupId? } — interest on overdue bills (Tally "Interest
 * Calculation"): one party, a group, or all debtors and creditors, for the period (Alt+F2).
 * Rate: the party ledger's own rate by default (blank = each ledger's rate); basis due/bill date;
 * grace days. Enter on a bill opens a drawer with its balance segments (how the interest was worked
 * out, lines adding up to the paisa). Export (Alt+E) / Print (Alt+P) the bill list.
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { AgeingBasis, InterestBillRow } from '../../../shared/types/outstanding.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Grid,
  Inline,
  KeyValueList,
  KpiCard,
  NumberInput,
  PercentInput,
  SegmentedControl,
  useDebouncedValue,
  useEnterAdvance,
} from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { GroupSelect, PartyPicker, VGap, usePartyOptions, useGroupOptions } from './components.tsx';
import { interestBasisText, interestInput, interestSegmentLines, rateText } from './lib/interest.ts';
import type { InterestScope, SegmentLine } from './lib/interest.ts';
import { interestExport, refTypeLabel } from './lib/model.ts';

export interface InterestParams {
  ledgerId?: number;
  groupId?: number;
}

interface KeyedInterestRow extends InterestBillRow {
  key: string;
}

const SCOPES: ReadonlyArray<{ value: InterestScope; label: string }> = [
  { value: 'party', label: 'One party' },
  { value: 'group', label: 'Group' },
  { value: 'all', label: 'All debtors & creditors' },
];

export function InterestScreen({ params }: ScreenProps<InterestParams>) {
  const nav = useNav();
  const { from, to } = usePeriod();
  const p = params ?? {};
  const [scope, setScope] = useState<InterestScope>(typeof p.ledgerId === 'number' ? 'party' : typeof p.groupId === 'number' ? 'group' : 'all');
  const [ledgerId, setLedgerId] = useState<number | null>(typeof p.ledgerId === 'number' ? p.ledgerId : null);
  const [groupId, setGroupId] = useState<number | undefined>(typeof p.groupId === 'number' ? p.groupId : undefined);
  /** The user's rate; null = not typed (party: the ledger's rate; others: each ledger's rate). */
  const [rateOverride, setRateOverride] = useState<number | null>(null);
  const [rateCleared, setRateCleared] = useState(false);
  const [basis, setBasis] = useState<AgeingBasis>('due_date');
  const [grace, setGrace] = useState<number | null>(null);
  const [open, setOpen] = useState<KeyedInterestRow | null>(null);
  const [cursor, setCursor] = useState<KeyedInterestRow | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const rateRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);
  // Enter moves rate → basis → grace days, then on to the bill list (Tally-style).
  const paramsRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => gridRef.current?.focus() });

  const parties = usePartyOptions(to, scope === 'party');
  const groups = useGroupOptions('both');

  // The party's own interest rate (ledger master) is the default rate in party scope.
  const ledgerQ = useApiQuery('outstanding.ledgerBills', { ledgerId: ledgerId ?? 0, asOf: to }, { enabled: scope === 'party' && ledgerId !== null, staleTime: 60_000 });
  const ledgerRate = scope === 'party' && ledgerQ.data && ledgerQ.data.ledger.id === ledgerId ? ledgerQ.data.ledger.interestRate : null;
  const shownRate = rateOverride ?? (rateCleared ? null : ledgerRate);

  const rate = useDebouncedValue(shownRate, 300);
  const graceDays = useDebouncedValue(grace, 300);
  // Ask the server only once the typed values have settled and, in party scope, once the party's own
  // rate is known — otherwise a calculation at a half-typed or not-yet-loaded rate would run (and
  // briefly show) first.
  const settled = rate === shownRate && graceDays === grace;
  const ledgerRatePending = scope === 'party' && ledgerId !== null && rateOverride === null && !rateCleared && ledgerQ.loading;
  const built = interestInput({ scope, ledgerId, groupId, from, to, ratePercent: rate, basis, graceDays });
  const ready = built.ok && settled && !ledgerRatePending;
  const q = useApiQuery('outstanding.interest', built.ok ? built.input : { from, to }, { enabled: ready, keepPrevious: true });
  const d = built.ok ? q.data : undefined;
  const waiting = built.ok && !d && (q.loading || !ready);

  const rows = useMemo<KeyedInterestRow[]>(() => {
    const seen = new Map<string, number>();
    return (d?.rows ?? []).map((r) => {
      const base = `${r.ledgerId}|${r.billName}|${r.billDate ?? ''}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { ...r, key: n === 0 ? base : `${base}#${n}` };
    });
  }, [d]);
  const mixedSides = rows.some((r) => r.side === 'receivable') && rows.some((r) => r.side === 'payable');
  const current = cursor !== null && rows.some((r) => r.key === cursor.key) ? cursor : null;

  const changeParty = (id: number | null): void => {
    setLedgerId(id);
    setRateOverride(null);
    setRateCleared(false);
  };

  const columns = useMemo<Column<KeyedInterestRow>[]>(
    () => [
      { key: 'ledgerName', header: 'Party', minWidth: 180, sortable: true, hidden: scope === 'party' },
      {
        key: 'billName',
        header: 'Bill no.',
        width: 150,
        sortable: true,
        render: (r) =>
          r.refType === 'new' ? (
            r.billName
          ) : (
            <Inline gap={1} wrap={false}>
              <span className="bx-truncate">{r.billName}</span>
              <Badge size="sm">{refTypeLabel(r.refType)}</Badge>
            </Inline>
          ),
      },
      { key: 'billDate', header: 'Bill date', kind: 'date', width: 110, sortable: true },
      { key: 'dueDate', header: 'Due date', kind: 'date', width: 110, sortable: true },
      { key: 'interestFrom', header: 'Interest after', kind: 'date', width: 120, sortable: true, title: () => 'Interest is charged for the days after this date' },
      { key: 'principal', header: 'Principal', kind: 'amount', width: 140, sortable: true },
      { key: 'ratePercent', header: 'Rate', width: 90, align: 'right', value: (r) => rateText(r.ratePercent), sortValue: (r) => r.ratePercent, sortable: true },
      { key: 'days', header: 'Days', kind: 'number', width: 70, sortable: true },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 130, sortable: true },
      {
        key: 'side',
        header: 'Side',
        width: 120,
        hidden: !mixedSides,
        value: (r) => (r.side === 'receivable' ? 'To charge' : 'Payable'),
        render: (r) => <Badge size="sm" tone={r.side === 'receivable' ? 'brand' : 'accent'}>{r.side === 'receivable' ? 'To charge' : 'Payable'}</Badge>,
      },
    ],
    [scope, mixedSides],
  );

  const footerRows: FooterRow[] = d
    ? [
        ...(d.totals.receivable !== 0 || !mixedSides ? [{ key: 'rec', tone: 'total' as const, cells: { billName: mixedSides ? 'To charge customers' : 'Total interest', interest: mixedSides ? d.totals.receivable : d.totals.receivable + d.totals.payable } }] : []),
        ...(mixedSides ? [{ key: 'pay', tone: 'total' as const, cells: { billName: 'Payable to suppliers', interest: d.totals.payable } }] : []),
      ]
    : [];

  const openParty = (id: number): void => {
    nav.push('outstanding.party', { ledgerId: id });
  };
  const actions: ScreenActionItem[] = [
    {
      key: 'Alt+N',
      label: 'Choose party',
      icon: 'user',
      onClick: () => {
        setScope('party');
        setTimeout(() => pickerRef.current?.focus(), 0);
      },
      group: 'filter',
    },
    { key: 'Alt+R', label: 'Rate', icon: 'percent', onClick: () => rateRef.current?.focus(), group: 'filter' },
    {
      key: 'Alt+U',
      label: basis === 'due_date' ? 'From bill date' : 'From due date',
      icon: 'calendar',
      onClick: () => setBasis((b) => (b === 'due_date' ? 'bill_date' : 'due_date')),
      group: 'filter',
    },
    { key: 'Alt+O', label: 'Party outstanding', icon: 'list', onClick: () => current && openParty(current.ledgerId), disabled: !current, group: 'party' },
  ];

  const anyRate = d ? d.rows.length > 0 : false;
  const partyName = scope === 'party' && ledgerQ.data && ledgerQ.data.ledger.id === ledgerId ? ledgerQ.data.ledger.name : null;
  const title = partyName ? `Interest — ${partyName}` : 'Interest Calculation';
  const nothingBody = !built.ok
    ? built.reason
    : d && d.skipped.length > 0 && !anyRate
      ? 'No interest rate is set for these parties. Enter a rate above, or set the interest rate on the party ledger.'
      : 'No bill was overdue in this period at an interest rate — change the period (Alt+F2), rate or grace days.';

  return (
    <>
      <ReportScreen
        title={title}
        subtitle={interestBasisText(basis, graceDays ?? 0)}
        periodMode="range"
        exportDef={() => (d ? interestExport(d) : { columns: [], rows: [] })}
        refreshing={q.refreshing || (built.ok && !!d && (!ready || q.isPrevious))}
        error={built.ok ? q.error : undefined}
        onRetry={() => void q.refetch()}
        actions={actions}
        hint="Enter Next field / Bill details · Alt+N Party · Alt+R Rate · Alt+U Basis · Alt+O Party outstanding · Alt+F2 Period · Alt+E Export · Esc Back"
        filters={
          <Inline gap={2}>
            <SegmentedControl<InterestScope> aria-label="Calculate for" size="sm" value={scope} onChange={setScope} options={SCOPES.map((s) => ({ ...s, disabled: s.value === 'group' && groups.length === 0 }))} />
            {scope === 'party' ? (
              <div style={{ width: 280 }}>
                <PartyPicker
                  options={parties.options}
                  value={ledgerId}
                  onChange={changeParty}
                  onCommit={() => rateRef.current?.focus()}
                  autoFocus={ledgerId === null}
                  inputRef={pickerRef}
                  placeholder="Customer or supplier"
                />
              </div>
            ) : scope === 'group' ? (
              <GroupSelect options={groups} value={groupId} onChange={setGroupId} allLabel="Choose a group" />
            ) : null}
          </Inline>
        }
      >
        <div ref={paramsRef}>
          <Inline gap={4} align="end">
            <Field label="Interest rate (per year)" hint={
                ledgerRatePending
                  ? 'Reading the party’s rate…'
                  : shownRate === null
                    ? scope === 'party' && ledgerId !== null && !rateCleared
                      ? 'This party has no rate — enter one'
                      : 'Blank = each party’s own rate'
                    : rateOverride === null
                      ? 'From the party ledger'
                      : undefined
              }>
              <PercentInput
                ref={rateRef}
                size="sm"
                value={shownRate}
                onChange={(v) => {
                  setRateOverride(v);
                  setRateCleared(v === null);
                }}
                max={100}
                placeholder="Ledger rate"
                aria-keyshortcuts="Alt+R"
                style={{ width: 130 }}
              />
            </Field>
            <Field label="Count interest from">
              <SegmentedControl<AgeingBasis>
                aria-label="Count interest from"
                size="sm"
                value={basis}
                onChange={setBasis}
                options={[
                  { value: 'due_date', label: 'Due date' },
                  { value: 'bill_date', label: 'Bill date' },
                ]}
              />
            </Field>
            <Field label="Grace days" hint="Interest-free days">
              <NumberInput size="sm" value={grace} onChange={(v) => setGrace(v === null ? null : Math.max(0, Math.round(v)))} min={0} max={3650} suffix="days" style={{ width: 110 }} />
            </Field>
          </Inline>
        </div>
        <VGap />
        {d ? (
          <Grid minItemWidth={170} gap={3}>
            <KpiCard label="Interest to charge" value={d.totals.receivable} amount icon="rupee" caption="From customers (receivable)" />
            <KpiCard label="Interest payable" value={d.totals.payable} amount icon="wallet" caption="To suppliers (e.g. MSME delayed payments)" />
            <KpiCard label="Bills" value={String(d.totals.billCount)} icon="invoice" caption={`${formatDate(d.from)} to ${formatDate(d.to)}`} />
            <KpiCard label="Parties without a rate" value={String(d.skipped.length)} icon="alert" caption={d.skipped.length ? 'Not calculated — see below' : 'Every party has a rate'} />
          </Grid>
        ) : null}
        {d && d.skipped.length > 0 ? (
          <>
            <VGap />
            <Banner tone="warning" inline title={`${d.skipped.length} ${d.skipped.length === 1 ? 'party was' : 'parties were'} not calculated`}>
              {d.skipped
                .slice(0, 5)
                .map((s) => `${s.ledgerName} (${s.reason})`)
                .join('; ')}
              {d.skipped.length > 5 ? ` and ${d.skipped.length - 5} more` : ''}. Enter a rate above to apply it to everyone, or set the interest rate on each party ledger.
            </Banner>
          </>
        ) : null}
        <VGap />
        <DataTable<KeyedInterestRow>
          aria-label="Interest by bill"
          autoFocus={scope !== 'party' || ledgerId !== null}
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          loading={waiting}
          gridRef={gridRef}
          footerRows={footerRows}
          onRowActivate={(r) => setOpen(r)}
          onSelect={(_, r) => setCursor(r ?? null)}
          typeToJump={(r) => (scope === 'party' ? r.billName : r.ledgerName)}
          empty={<EmptyState icon="percent" title={built.ok ? 'No interest for this period' : 'Choose what to calculate'} body={nothingBody} />}
        />
      </ReportScreen>
      <InterestDrawer row={open} onClose={() => setOpen(null)} onOpenParty={(id) => {
          setOpen(null);
          openParty(id);
        }} />
    </>
  );
}

function InterestDrawer({ row, onClose, onOpenParty }: { row: KeyedInterestRow | null; onClose: () => void; onOpenParty: (ledgerId: number) => void }) {
  const lines = useMemo(() => (row ? interestSegmentLines(row) : []), [row]);
  const columns = useMemo<Column<SegmentLine>[]>(
    () => [
      { key: 'period', header: 'Days', minWidth: 170, value: (l) => `${formatDate(l.firstDay)} – ${formatDate(l.lastDay)}` },
      { key: 'days', header: 'No. of days', kind: 'number', width: 90 },
      { key: 'balance', header: 'Balance', kind: 'amount', width: 130 },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 110, total: true },
    ],
    [],
  );
  if (!row) return null;
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={`${row.billName} — ${row.ledgerName}`}
      description={`${rateText(row.ratePercent)} simple interest on a 365-day year`}
      footer={
        <Inline gap={2} justify="end">
          <Button icon="list" onClick={() => onOpenParty(row.ledgerId)}>
            Party outstanding
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </Inline>
      }
    >
      <KeyValueList
        columns={2}
        items={[
          { label: 'Bill date', value: row.billDate ?? '', kind: 'date', hideEmpty: true },
          { label: 'Due date', value: row.dueDate ?? '', kind: 'date', hideEmpty: true },
          { label: 'Interest after', value: row.interestFrom, kind: 'date' },
          { label: 'Interest-bearing days', value: String(row.days) },
          { label: 'Principal', value: row.principal, kind: 'amount' },
          { label: 'Pending at period end', value: row.pendingAtEnd, kind: 'amount' },
          { label: 'Interest', value: row.interest, kind: 'amount', strong: true },
          { label: 'Side', value: row.side === 'receivable' ? 'To charge the customer' : 'Payable to the supplier' },
        ]}
      />
      <VGap />
      <DataTable<SegmentLine>
        aria-label="How the interest was worked out"
        autoFocus
        columns={columns}
        rows={lines}
        getRowKey={(l) => l.key}
        empty={<EmptyState icon="check-circle" title="No interest-bearing days" body="Nothing was pending after the interest date in this period." />}
      />
      <VGap />
      <p className="bx-muted">
        Each line: balance × days × {rateText(row.ratePercent)} ÷ 365. The bill’s interest is rounded once ({formatMoney(row.interest, { symbol: true })}); the lines are
        split from it so they add up exactly. A payment still bears interest on the day it is received and reduces the balance from the next day.
      </p>
    </Drawer>
  );
}
