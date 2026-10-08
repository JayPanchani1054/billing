/**
 * 'reports.exceptions' — Tally Exception Reports in tabs: ledgers with unusual balances (negative
 * cash, customer credit balances, …), optional, post-dated, cancelled and memorandum vouchers, and
 * accounting vouchers without narration. Enter opens the ledger or the voucher.
 */
import { useMemo, useState } from 'react';
import type { ExceptionVoucher, NegativeLedgerRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, EmptyState, Stack, Tabs } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { currentRow, voucherTarget } from './lib/model.ts';

type Tab = 'balances' | 'optional' | 'postDated' | 'cancelled' | 'memorandum' | 'noNarration';

const TABS: ReadonlyArray<{ id: Tab; label: string; key: string; empty: string }> = [
  { id: 'balances', label: 'Unusual balances', key: 'Ctrl+1', empty: 'Every ledger has the kind of balance you would expect.' },
  { id: 'optional', label: 'Optional', key: 'Ctrl+2', empty: 'No optional vouchers in this period.' },
  { id: 'postDated', label: 'Post-dated', key: 'Ctrl+3', empty: 'No post-dated vouchers in this period.' },
  { id: 'cancelled', label: 'Cancelled', key: 'Ctrl+4', empty: 'No cancelled vouchers in this period.' },
  { id: 'memorandum', label: 'Memorandum', key: 'Ctrl+5', empty: 'No memorandum or reversing journal vouchers in this period.' },
  { id: 'noNarration', label: 'Without narration', key: 'Ctrl+6', empty: 'Every accounting voucher has a narration.' },
];

export function ExceptionsScreen({ params }: ScreenProps<{ from?: string; to?: string; tab?: Tab }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const [tab, setTab] = useState<Tab>(params?.tab ?? 'balances');
  const [cursor, setCursor] = useState<ExceptionVoucher | null>(null);
  const q = useApiQuery('reports.exceptions', { from: p.from, to: p.to, includeNoNarration: true }, { keepPrevious: true });
  const d = q.data;
  const lists: Record<Exclude<Tab, 'balances'>, readonly ExceptionVoucher[]> = {
    optional: d?.optional ?? [],
    postDated: d?.postDated ?? [],
    cancelled: d?.cancelled ?? [],
    memorandum: d?.memorandum ?? [],
    noNarration: d?.noNarration ?? [],
  };
  const selected = tab === 'balances' ? null : currentRow(cursor, lists[tab], (r) => r.id);
  const count = (t: Tab): number => (t === 'balances' ? (d?.negativeLedgers.length ?? 0) : lists[t].length);

  const balanceColumns = useMemo<Column<NegativeLedgerRow>[]>(
    () => [
      { key: 'ledgerName', header: 'Ledger', minWidth: 200, sortable: true },
      { key: 'groupName', header: 'Group', width: 170, sortable: true },
      { key: 'closing', header: 'Closing Balance', kind: 'drcr', width: 170, sortable: true },
      { key: 'reason', header: 'Why it is unusual', minWidth: 280 },
    ],
    [],
  );
  const voucherColumns = useMemo<Column<ExceptionVoucher>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'partyName', header: 'Party', minWidth: 180, value: (r) => r.partyName ?? '' },
      { key: 'voucherType', header: 'Vch Type', width: 140 },
      { key: 'number', header: 'Vch No.', width: 110 },
      { key: 'narration', header: 'Narration', minWidth: 200, value: (r) => r.narration ?? '' },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 150, blankZero: true },
    ],
    [],
  );

  const actions: ScreenActionItem[] = [
    ...TABS.map((t) => ({ key: t.key, label: t.label, onClick: () => setTab(t.id), disabled: tab === t.id, group: 'tabs' })),
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit' as const, onClick: () => selected && tab !== 'cancelled' && drill(voucherTarget(selected.id, selected.baseType, true)), hidden: tab === 'balances', disabled: !selected || tab === 'cancelled', group: 'voucher' },
  ];
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <ReportScreen
      title="Exception Reports"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Ctrl+1…6 Switch list · Enter Open · Alt+A Alter voucher"
      exportDef={() =>
        tab === 'balances'
          ? {
              subtitle: current.label,
              columns: [{ header: 'Ledger' }, { header: 'Group' }, { header: 'Closing Balance', kind: 'drcr' }, { header: 'Why it is unusual' }],
              rows: (d?.negativeLedgers ?? []).map((r) => [r.ledgerName, r.groupName, r.closing, r.reason]),
            }
          : {
              subtitle: current.label,
              columns: [{ header: 'Date', kind: 'date' }, { header: 'Party' }, { header: 'Vch Type' }, { header: 'Vch No.' }, { header: 'Narration' }, { header: 'Amount', kind: 'amount' }],
              rows: lists[tab].map((v) => [v.date, v.partyName ?? '', v.voucherType, v.number ?? '', v.narration ?? '', v.amount]),
            }
      }
    >
      <Stack gap={2} grow>
        <Tabs
          aria-label="Exception lists"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          items={TABS.map((t) => ({ id: t.id, label: t.label, badge: d ? <Badge size="sm" tone={count(t.id) > 0 ? 'warning' : 'neutral'}>{count(t.id)}</Badge> : undefined }))}
        />
        {tab === 'balances' ? (
          <DataTable<NegativeLedgerRow>
            key="balances"
            aria-label={current.label}
            className="bx-rep-fill"
            columns={balanceColumns}
            rows={d?.negativeLedgers ?? []}
            getRowKey={(r) => String(r.ledgerId)}
            onRowActivate={(r) => drill({ screen: 'reports.ledger', params: { ledgerId: r.ledgerId, from: p.from, to: p.to } })}
            loading={q.loading}
            empty={<EmptyState icon="check-circle" title="Nothing unusual" body={current.empty} />}
            autoFocus
          />
        ) : (
          <DataTable<ExceptionVoucher>
            key={tab}
            aria-label={current.label}
            className="bx-rep-fill"
            columns={voucherColumns}
            rows={lists[tab]}
            getRowKey={(r) => String(r.id)}
            onRowActivate={(r) => drill(voucherTarget(r.id, r.baseType))}
            onSelect={(_k, r) => setCursor(r)}
            loading={q.loading}
            empty={<EmptyState icon="check-circle" title="Nothing here" body={current.empty} />}
            autoFocus
          />
        )}
        {d?.truncated ? <p className="bx-rep-note">Long lists are cut at 5,000 vouchers. Narrow the period to see the rest.</p> : null}
      </Stack>
    </ReportScreen>
  );
}
