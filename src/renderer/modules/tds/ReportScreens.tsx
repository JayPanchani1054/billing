/**
 * TDS/TCS reports (all read from the derived tds_lines / tds_challans):
 *   'tds.computation' { kind? }   per party + section for the period (Alt+F2): credited, below
 *                                 threshold, base, deducted, deposited, balance. Enter → lines.
 *   'tds.lines' { … filters }     the voucher lines behind a figure. Enter → voucher, Alt+A alter.
 *   'tds.outstanding' { kind? }   deducted but not deposited per section + month as on the period
 *                                 end: due date (7th / 30-Apr for March), interest u/s 201(1A)(ii) /
 *                                 206C(7); quarterly statements with late fee u/s 234E. Enter → lines,
 *                                 Alt+C pay the highlighted month (challan), Alt+F1 also settled months.
 *   'tds.challans' { kind? }      challan register (deposit date in the period). Enter → challan.
 *   'tds.exceptions' { kind? }    no / invalid PAN, deducted below threshold, threshold crossed but
 *                                 not deducted, short deduction. Enter → voucher.
 * Ctrl+1 / Ctrl+2 switch TDS / TCS where both are on. Alt+E export, Alt+P print.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type {
  TdsChallanRow,
  TdsComputationRow,
  TdsExceptionRow,
  TdsKind,
  TdsLineRow,
  TdsOutstandingRow,
  TdsStatementRow,
} from '../../../shared/types/tds.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Badge, Banner, DataTable, EmptyState, Grid, KpiCard, Panel, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { KindSwitch, PanBadge, TdsOff, useKind } from './components.tsx';
import {
  challansExport,
  computationExport,
  EXCEPTION_LABEL,
  exceptionsExport,
  KIND_LABEL,
  OUTSTANDING_STATUS,
  outstandingExport,
  STATUS_LABEL,
} from './lib/model.ts';

const inr = (p: number): string => formatMoney(p, { symbol: true });

// ───────────────────────────── Computation ─────────────────────────────

export function ComputationScreen({ params }: ScreenProps<{ kind?: TdsKind }>) {
  const nav = useNav();
  const { from, to } = usePeriod();
  const { kind, kinds, setKind, kindActions } = useKind(params?.kind);
  const q = useApiQuery('tds.computation', { from, to, kind: kind ?? 'tds' }, { enabled: kind !== null, keepPrevious: true });
  const rows = q.data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => r.key === cursor) ?? null;
  const k = kind ?? 'tds';
  const verb = k === 'tds' ? 'Deducted' : 'Collected';

  const columns = useMemo<Column<TdsComputationRow>[]>(
    () => [
      { key: 'partyName', header: k === 'tds' ? 'Deductee' : 'Collectee', minWidth: 200, sortable: true },
      { key: 'pan', header: 'PAN', width: 140, value: (r) => r.pan ?? '', render: (r) => <PanBadge status={r.panStatus} pan={r.pan} /> },
      { key: 'section', header: 'Section', width: 90, sortable: true },
      { key: 'natureName', header: 'Nature', minWidth: 180 },
      { key: 'count', header: 'Lines', kind: 'number', width: 64 },
      { key: 'credited', header: k === 'tds' ? 'Paid / credited' : 'Sales value', kind: 'amount', width: 140, total: true, sortable: true },
      { key: 'belowThreshold', header: 'Below threshold', kind: 'amount', width: 130, blankZero: true, total: true },
      { key: 'base', header: 'Tax base', kind: 'amount', width: 130, total: true },
      { key: 'deducted', header: verb, kind: 'amount', width: 120, total: true, sortable: true },
      { key: 'deposited', header: 'Deposited', kind: 'amount', width: 120, total: true },
      { key: 'balance', header: 'Balance', kind: 'amount', width: 120, total: true, blankZero: true },
    ],
    [k, verb],
  );

  if (kind === null) return <TdsOff title="TDS / TCS Computation" />;
  return (
    <ReportScreen
      title={`${KIND_LABEL[k]} Computation`}
      subtitle="Per party and section, from the vouchers of the period"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={<KindSwitch kind={k} kinds={kinds} onChange={setKind} />}
      exportDef={() => (q.data ? computationExport(q.data) : { columns: [], rows: [] })}
      actions={[
        ...kindActions,
        {
          key: 'Alt+M',
          label: 'Party TDS details',
          icon: 'ledger',
          disabled: !current?.partyLedgerId,
          onClick: () => current?.partyLedgerId && nav.push('tds.ledger.form', { ledgerId: current.partyLedgerId }),
        },
      ]}
      hint="Enter Lines · Alt+M Party TDS details · Ctrl+1 TDS · Ctrl+2 TCS · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <DataTable<TdsComputationRow>
        aria-label={`${KIND_LABEL[k]} computation`}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        selectedKey={cursor}
        onSelect={(key) => setCursor(key)}
        onRowActivate={(r) =>
          nav.push('tds.lines', {
            kind: r.kind,
            natureId: r.natureId,
            partyLedgerId: r.partyLedgerId ?? undefined,
            from,
            to,
            title: `${r.partyName} — ${r.section}`,
          })
        }
        empty={<EmptyState title={`No ${KIND_LABEL[k]} in this period`} body="Change the period (Alt+F2), or check that the expense / sales ledgers have TDS/TCS details (TDS/TCS › Ledger details)." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Lines ─────────────────────────────

export interface LinesParams {
  kind?: TdsKind;
  partyLedgerId?: number;
  natureId?: number;
  section?: string;
  period?: string;
  from?: string;
  to?: string;
  title?: string;
}

export function LinesScreen({ params }: ScreenProps<LinesParams>) {
  const nav = useNav();
  const global = usePeriod();
  const p = params ?? {};
  const from = p.from ?? global.from;
  const to = p.to ?? global.to;
  const { kind } = useKind(p.kind);
  const canAlter = useCan('vouchers.alter');
  const input = {
    from,
    to,
    kind: kind ?? 'tds',
    ...(p.partyLedgerId !== undefined ? { partyLedgerId: p.partyLedgerId } : {}),
    ...(p.natureId !== undefined ? { natureId: p.natureId } : {}),
    ...(p.section !== undefined ? { section: p.section } : {}),
    ...(p.period !== undefined ? { period: p.period } : {}),
  };
  const q = useApiQuery('tds.lines', input, { enabled: kind !== null, keepPrevious: true });
  const rows = q.data ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? null;

  const columns = useMemo<Column<TdsLineRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 100, sortable: true },
      { key: 'voucher', header: 'Voucher', width: 150, value: (r) => `${r.typeName} ${r.number ?? ''}`.trim() },
      { key: 'partyName', header: 'Party', minWidth: 160, value: (r) => r.partyName ?? '(no party)' },
      { key: 'section', header: 'Section', width: 80 },
      { key: 'assessable', header: 'Amount', kind: 'amount', width: 120, total: true },
      { key: 'catchUp', header: 'Earlier taken in', kind: 'amount', width: 120, blankZero: true, total: true, title: () => 'Earlier credits below the threshold taken in when it was crossed' },
      { key: 'advanceAdjusted', header: 'Advance set off', kind: 'amount', width: 120, blankZero: true, total: true, title: () => 'Part of the bill already taxed when the advance was paid' },
      { key: 'base', header: 'Base', kind: 'amount', width: 120, total: true },
      { key: 'rate', header: 'Rate', width: 70, align: 'right', value: (r) => (r.amount > 0 || r.status === 'certificate' ? `${r.rate}%` : '') },
      { key: 'amount', header: 'Tax', kind: 'amount', width: 110, total: true, blankZero: true },
      {
        key: 'status',
        header: 'Status',
        width: 170,
        value: (r) => STATUS_LABEL[r.status],
        render: (r) => (
          <Badge size="sm" tone={r.status === 'deducted' ? 'brand' : r.status === 'overridden_nil' || r.status === 'no_party' ? 'warning' : 'neutral'}>
            {r.overridden ? `${STATUS_LABEL[r.status]} (changed)` : STATUS_LABEL[r.status]}
          </Badge>
        ),
      },
      { key: 'deposited', header: 'Deposited', kind: 'amount', width: 110, blankZero: true, total: true },
      { key: 'balance', header: 'Balance', kind: 'amount', width: 110, blankZero: true, total: true },
      { key: 'dueDate', header: 'Due', kind: 'date', width: 100 },
    ],
    [],
  );

  if (kind === null) return <TdsOff title="TDS / TCS Lines" />;
  return (
    <ReportScreen
      title={p.title ? `${KIND_LABEL[kind]} Lines: ${p.title}` : `${KIND_LABEL[kind]} Lines`}
      period={{ from, to }}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      exportDef={() => ({
        columns: [
          { header: 'Date', kind: 'date' },
          { header: 'Voucher' },
          { header: 'Party' },
          { header: 'Section' },
          { header: 'Amount', kind: 'amount' },
          { header: 'Base', kind: 'amount' },
          { header: 'Rate %', kind: 'percent' },
          { header: 'Tax', kind: 'amount' },
          { header: 'Status' },
          { header: 'Deposited', kind: 'amount' },
          { header: 'Balance', kind: 'amount' },
          { header: 'Note' },
        ],
        rows: rows.map((r) => [r.date, `${r.typeName} ${r.number ?? ''}`.trim(), r.partyName ?? '', r.section, r.assessable, r.base, r.rate, r.amount, STATUS_LABEL[r.status], r.deposited, r.balance, r.note ?? '']),
        landscape: true,
      })}
      actions={[
        { key: 'Alt+Enter', label: 'View voucher', icon: 'eye', disabled: !current, onClick: () => current && nav.push('vouchers.view', { id: current.voucherId }) },
        { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', disabled: !current || !canAlter, onClick: () => current && nav.push('vouchers.entry', { id: current.voucherId }) },
      ]}
      hint="Enter View voucher · Alt+A Alter voucher · Alt+E Export · Esc Back"
    >
      <Stack gap={3}>
        <DataTable<TdsLineRow>
          aria-label="TDS / TCS voucher lines"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          selectedKey={cursor}
          onSelect={(key) => setCursor(key)}
          onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
          empty={<EmptyState title="No lines" body="Nothing was computed for this selection in the period." />}
        />
        {current?.note ? (
          <Banner tone={current.overridden ? 'warning' : 'info'} inline title={`${current.typeName} ${current.number ?? ''} — ${formatDate(current.date)}`}>
            {current.note}
          </Banner>
        ) : null}
      </Stack>
    </ReportScreen>
  );
}

// ───────────────────────────── Outstanding ─────────────────────────────

export function OutstandingScreen({ params }: ScreenProps<{ kind?: TdsKind }>) {
  const nav = useNav();
  const { to } = usePeriod();
  const { kind, kinds, setKind, kindActions } = useKind(params?.kind);
  const [all, setAll] = useState(false);
  const canPay = useCan('vouchers.create');
  const q = useApiQuery('tds.outstanding', { asOf: to, kind: kind ?? 'tds', includeSettled: all }, { enabled: kind !== null, keepPrevious: true });
  const d = q.data;
  const rows = d?.rows ?? [];
  const statements = d?.statements ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => r.key === cursor) ?? null;
  const k = kind ?? 'tds';

  const columns = useMemo<Column<TdsOutstandingRow>[]>(
    () => [
      { key: 'periodLabel', header: 'Month', width: 110, sortValue: (r) => r.period, sortable: true },
      { key: 'section', header: 'Section', width: 90, sortable: true },
      { key: 'payableLedgerName', header: 'Ledger', minWidth: 160 },
      { key: 'deducted', header: k === 'tds' ? 'Deducted' : 'Collected', kind: 'amount', width: 120, total: true },
      { key: 'deposited', header: 'Deposited', kind: 'amount', width: 120, total: true, blankZero: true },
      { key: 'balance', header: 'Balance', kind: 'amount', width: 120, total: true, blankZero: true },
      { key: 'dueDate', header: 'Due date', kind: 'date', width: 100, sortable: true },
      { key: 'daysOverdue', header: 'Days late', kind: 'number', width: 80, value: (r) => (r.daysOverdue > 0 ? r.daysOverdue : '') },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 110, total: true, blankZero: true },
      { key: 'interestPaid', header: 'Interest paid', kind: 'amount', width: 110, total: true, blankZero: true },
      {
        key: 'status',
        header: 'Status',
        width: 110,
        value: (r) => OUTSTANDING_STATUS[r.status],
        render: (r) => (
          <Badge size="sm" tone={r.status === 'overdue' ? 'danger' : r.status === 'due' ? 'warning' : r.status === 'paid_late' || r.status === 'excess' ? 'info' : 'success'}>
            {OUTSTANDING_STATUS[r.status]}
          </Badge>
        ),
      },
    ],
    [k],
  );

  const stmtColumns = useMemo<Column<TdsStatementRow>[]>(
    () => [
      { key: 'form', header: 'Form', width: 70 },
      { key: 'label', header: 'Quarter', width: 120 },
      { key: 'dueDate', header: 'Due', kind: 'date', width: 100 },
      { key: 'filedOn', header: 'Filed on', kind: 'date', width: 100 },
      { key: 'tokenNo', header: 'Token', width: 140, value: (r) => r.tokenNo ?? '' },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 120 },
      { key: 'daysLate', header: 'Days late', kind: 'number', width: 80, value: (r) => (r.daysLate > 0 ? r.daysLate : '') },
      { key: 'lateFee', header: 'Fee u/s 234E', kind: 'amount', width: 120, blankZero: true, total: true },
      {
        key: 'status',
        header: 'Status',
        width: 100,
        value: (r) => r.status,
        render: (r) => (
          <Badge size="sm" tone={r.status === 'overdue' ? 'danger' : r.status === 'due' ? 'warning' : r.status === 'filed_late' ? 'info' : 'success'}>
            {r.status === 'overdue' ? 'Overdue' : r.status === 'due' ? 'Due' : r.status === 'filed_late' ? 'Filed late' : 'Filed'}
          </Badge>
        ),
      },
    ],
    [],
  );

  const payCurrent = (): void => {
    if (!current) return;
    nav.push('tds.challan', { kind: k, section: current.section, period: current.period });
  };

  if (kind === null) return <TdsOff title="TDS / TCS Outstanding" />;
  return (
    <ReportScreen
      title={`${KIND_LABEL[k]} Outstanding`}
      subtitle={k === 'tds' ? 'Deducted but not deposited; due by the 7th of the next month (30 April for March)' : 'Collected but not deposited; due by the 7th of the next month'}
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={<KindSwitch kind={k} kinds={kinds} onChange={setKind} />}
      exportDef={() => (d ? outstandingExport(d) : { columns: [], rows: [] })}
      actions={[
        ...kindActions,
        { key: 'Alt+C', label: 'Create challan', icon: 'plus', primary: true, disabled: !canPay, onClick: () => (current ? payCurrent() : nav.push('tds.challan', { kind: k })) },
        { key: 'Alt+F1', label: all ? 'Only unsettled' : 'Include settled', group: 'view', onClick: () => setAll((x) => !x) },
      ]}
      hint="Enter Lines · Alt+C Create challan for the month · Alt+F1 Settled months · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <Stack gap={4}>
        {d ? (
          <Grid columns={4} gap={3}>
            <KpiCard label="Balance to deposit" value={d.totals.balance} amount />
            <KpiCard label="Interest so far" value={d.totals.interest - d.totals.interestPaid} amount caption={k === 'tds' ? 's.201(1A)(ii) 1.5% per month or part' : 's.206C(7) 1% per month or part'} />
            <KpiCard label="Late fee u/s 234E" value={d.totals.lateFee} amount caption="₹200 a day, up to the tax" />
            <KpiCard label={k === 'tds' ? 'Deducted' : 'Collected'} value={d.totals.deducted} amount caption={`Deposited ${inr(d.totals.deposited)}`} />
          </Grid>
        ) : null}
        <DataTable<TdsOutstandingRow>
          aria-label={`${KIND_LABEL[k]} outstanding by month`}
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          selectedKey={cursor}
          onSelect={(key) => setCursor(key)}
          onRowActivate={(r) => nav.push('tds.lines', { kind: r.kind, section: r.section, period: r.period, from: `${r.period}-01`, to, title: `${r.section} ${r.periodLabel}` })}
          empty={<EmptyState title="Nothing outstanding" body={`All ${KIND_LABEL[k]} up to ${formatDate(to)} has been deposited. Alt+F1 shows settled months too.`} />}
        />
        <Panel title="Quarterly statements" description={k === 'tds' ? 'Form 26Q / 27Q — due 31 Jul, 31 Oct, 31 Jan and 31 May' : 'Form 27EQ — due 15 Jul, 15 Oct, 15 Jan and 15 May'}>
          <DataTable<TdsStatementRow>
            aria-label="Quarterly statements"
            columns={stmtColumns}
            rows={statements}
            getRowKey={(r) => r.key}
            onRowActivate={(r) => nav.push('tds.return', { form: r.form, fyStart: r.fyStart, quarter: r.quarter })}
            height={Math.min(260, 40 + 32 * (statements.length + 2))}
            empty={<EmptyState size="sm" title="No statements due yet" />}
          />
        </Panel>
      </Stack>
    </ReportScreen>
  );
}

// ───────────────────────────── Challan register ─────────────────────────────

export function ChallansScreen({ params }: ScreenProps<{ kind?: TdsKind }>) {
  const nav = useNav();
  const { from, to } = usePeriod();
  const { kind, kinds, setKind, kindActions } = useKind(params?.kind);
  const canPay = useCan('vouchers.create');
  const q = useApiQuery('tds.challans', { from, to, kind: kind ?? 'tds' }, { enabled: kind !== null, keepPrevious: true });
  const rows = q.data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? null;
  const k = kind ?? 'tds';

  const columns = useMemo<Column<TdsChallanRow>[]>(
    () => [
      { key: 'depositDate', header: 'Deposited', kind: 'date', width: 100, sortable: true },
      { key: 'bsrCode', header: 'BSR code', width: 90 },
      { key: 'challanNo', header: 'Challan no.', width: 90 },
      { key: 'section', header: 'Section', width: 80, sortable: true },
      { key: 'periodLabel', header: 'For month', width: 100, sortValue: (r) => r.period, sortable: true },
      { key: 'bankName', header: 'Paid from', minWidth: 140, value: (r) => r.bankName ?? '' },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 110, total: true, value: (r) => r.tax + r.surcharge + r.cess },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 100, total: true, blankZero: true },
      { key: 'fee', header: 'Fee', kind: 'amount', width: 90, total: true, blankZero: true },
      { key: 'others', header: 'Others', kind: 'amount', width: 90, total: true, blankZero: true },
      { key: 'total', header: 'Total', kind: 'amount', width: 120, total: true },
      { key: 'unconsumed', header: 'Unconsumed', kind: 'amount', width: 110, total: true, blankZero: true, title: () => 'Tax deposited beyond the deductions of its month' },
      {
        key: 'late',
        header: 'On time',
        width: 80,
        value: (r) => (r.late ? 'Late' : 'Yes'),
        render: (r) => (r.late ? <Badge size="sm" tone="warning">Late</Badge> : <span className="bx-muted">Yes</span>),
      },
      { key: 'number', header: 'Voucher', width: 100, value: (r) => r.number ?? '' },
    ],
    [],
  );

  if (kind === null) return <TdsOff title="Challan Register" />;
  return (
    <ReportScreen
      title={`${KIND_LABEL[k]} Challan Register`}
      subtitle="ITNS 281 challans by deposit date"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={<KindSwitch kind={k} kinds={kinds} onChange={setKind} />}
      exportDef={() => (q.data ? challansExport(q.data) : { columns: [], rows: [] })}
      actions={[
        ...kindActions,
        { key: 'Alt+C', label: 'Create challan', icon: 'plus', primary: true, disabled: !canPay, onClick: () => nav.push('tds.challan', { kind: k }) },
        { key: 'Alt+Enter', label: 'View voucher', icon: 'eye', disabled: !current, onClick: () => current && nav.push('vouchers.view', { id: current.voucherId }) },
      ]}
      hint="Enter Alter challan · Alt+C Create challan · Alt+Enter View voucher · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <DataTable<TdsChallanRow>
        aria-label="Challan register"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={cursor}
        onSelect={(key) => setCursor(key)}
        onRowActivate={(r) => nav.push('tds.challan', { voucherId: r.voucherId })}
        empty={<EmptyState title="No challans in this period" body="Press Alt+C to record a challan you paid." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Exceptions ─────────────────────────────

export function ExceptionsScreen({ params }: ScreenProps<{ kind?: TdsKind }>) {
  const nav = useNav();
  const { from, to } = usePeriod();
  const { kind, kinds, setKind, kindActions } = useKind(params?.kind);
  const canAlter = useCan('vouchers.alter');
  const q = useApiQuery('tds.exceptions', { from, to, kind: kind ?? 'tds' }, { enabled: kind !== null, keepPrevious: true });
  const rows = q.data ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => r.key === cursor) ?? null;
  const k = kind ?? 'tds';
  const errors = rows.filter((r) => r.severity === 'error').length;

  const columns = useMemo<Column<TdsExceptionRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 100, sortable: true },
      {
        key: 'type',
        header: 'Problem',
        width: 210,
        value: (r) => EXCEPTION_LABEL[r.type],
        sortable: true,
        render: (r) => (
          <Badge size="sm" tone={r.severity === 'error' ? 'danger' : 'warning'} icon="alert">
            {EXCEPTION_LABEL[r.type]}
          </Badge>
        ),
      },
      { key: 'voucher', header: 'Voucher', width: 140, value: (r) => `${r.typeName} ${r.number ?? ''}`.trim() },
      { key: 'partyName', header: 'Party', minWidth: 150, value: (r) => r.partyName ?? '' },
      { key: 'section', header: 'Section', width: 80 },
      { key: 'message', header: 'Details', minWidth: 320 },
      { key: 'shortfall', header: 'Shortfall', kind: 'amount', width: 110, blankZero: true, total: true },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 100, blankZero: true, total: true },
    ],
    [],
  );

  if (kind === null) return <TdsOff title="TDS / TCS Exceptions" />;
  return (
    <ReportScreen
      title={`${KIND_LABEL[k]} Exceptions`}
      subtitle={rows.length === 0 ? 'Nothing to fix' : `${rows.length} item(s), ${errors} to fix before filing`}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={<KindSwitch kind={k} kinds={kinds} onChange={setKind} />}
      exportDef={() => exceptionsExport(rows)}
      actions={[
        ...kindActions,
        { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', disabled: !current || !canAlter, onClick: () => current && nav.push('vouchers.entry', { id: current.voucherId }) },
        {
          key: 'Alt+M',
          label: 'Party TDS details',
          icon: 'ledger',
          disabled: !current?.partyLedgerId,
          onClick: () => current?.partyLedgerId && nav.push('tds.ledger.form', { ledgerId: current.partyLedgerId }),
        },
      ]}
      hint="Enter View voucher · Alt+A Alter voucher · Alt+M Party TDS details · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <DataTable<TdsExceptionRow>
        aria-label={`${KIND_LABEL[k]} exceptions`}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        selectedKey={cursor}
        onSelect={(key) => setCursor(key)}
        onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
        empty={<EmptyState icon="check-circle" title="No exceptions" body="PANs, thresholds and deductions look right for this period." />}
      />
    </ReportScreen>
  );
}
