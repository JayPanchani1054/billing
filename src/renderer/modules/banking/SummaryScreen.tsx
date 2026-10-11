/**
 * 'banking.summary' — Bank overview: every bank / OD account as on the period end (Alt+F2) with the balance
 * as per books and as per bank, open items, the last reconciled date and the latest imported statement.
 * Enter opens the reconciliation; Alt+I imports a statement and Alt+M matches it for the highlighted bank;
 * Alt+Q cheque register, Alt+T post-dated cheques, Alt+C creates a bank ledger (under Bank Accounts).
 * 2.1: the stat says what is not in the bank yet and links the statement lines to match; with 3 or more
 * accounts the balances are a bar graph (inline in the table up to 7 accounts) — lib/charts.ts.
 */
import { useMemo, useState } from 'react';
import type { BankSummaryRow } from '../../../shared/types/banking.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../shared/format.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Badge, DataTable, StatLine } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { inlineBars } from '../../ui/lib/chartSpec.ts';
import { NoBanks, bankLabel, useBanks } from './components.tsx';
import { bankBalancesChart, bankSummaryStat } from './lib/charts.ts';
import { summaryExport } from './lib/exports.ts';

export function SummaryScreen(_props: ScreenProps<Record<string, never>>) {
  const nav = useNav();
  const canEdit = useCan('banking.reconcile');
  const canCreateLedger = useCan('masters.create');
  const { to: asOf } = usePeriod();
  const { banks, loading, error, refetch, refreshing } = useBanks(asOf);
  const [cursor, setCursor] = useState<string | null>(null);
  const selected = banks.find((b) => String(b.id) === cursor) ?? banks[0] ?? null;
  const spec = useMemo(() => bankBalancesChart(banks, (id) => nav.push('banking.brs', { ledgerId: id })), [banks, nav]);
  const inline = inlineBars(spec, banks.length);

  const columns = useMemo<Column<BankSummaryRow>[]>(
    () => [
      { key: 'name', header: 'Bank account', minWidth: 200, sortable: true, value: (r) => bankLabel(r) },
      {
        key: 'balanceAsPerBooks',
        header: 'As per books',
        kind: 'drcr',
        width: 150,
        total: true,
        sortable: true,
        ...(inline ? { bar: { value: (r: BankSummaryRow) => r.balanceAsPerBooks, slot: 'polarity' as const } } : {}),
      },
      { key: 'issued', header: 'Not presented', kind: 'amount', width: 130, blankZero: true, value: (r) => r.unreconciled.issued, total: true },
      { key: 'deposits', header: 'Not cleared', kind: 'amount', width: 130, blankZero: true, value: (r) => r.unreconciled.deposits, total: true },
      { key: 'balanceAsPerBank', header: 'As per bank', kind: 'drcr', width: 150, total: true, sortable: true },
      { key: 'lastReconciledDate', header: 'Reconciled up to', kind: 'date', width: 120, sortable: true },
      {
        key: 'statement',
        header: 'Latest statement',
        width: 220,
        value: (r) => r.lastStatement?.date ?? '',
        render: (r) => {
          if (!r.lastStatement) return <span className="bx-muted">Not imported</span>;
          const bal = r.lastStatement.balance;
          // Compared with the bank balance per the books on the statement's own date (not the overview date).
          const diff = r.lastStatement.difference;
          const text = `${formatDate(r.lastStatement.date)}${bal !== null ? ` · ${formatDrCr(bal, { keepZero: true })}` : ''}`;
          return diff !== null && diff !== 0 ? (
            <span title={`Statement − bank as per books on ${formatDate(r.lastStatement.date)}: ${formatDrCr(diff)}`}>
              {text}{' '}
              <Badge size="sm" tone="warning">
                Differs by {formatMoney(Math.abs(diff))}
              </Badge>
            </span>
          ) : (
            <span>
              {text}
              {diff === 0 ? <span className="bx-muted"> · agrees</span> : null}
            </span>
          );
        },
      },
      {
        key: 'unmatched',
        header: 'Statement lines to match',
        width: 170,
        align: 'right',
        value: (r) => r.statementLines.unmatched,
        render: (r) =>
          r.statementLines.unmatched > 0 ? (
            <Badge size="sm" tone="warning">
              {r.statementLines.unmatched} unmatched
            </Badge>
          ) : r.lastStatement ? (
            <span className="bx-muted">All matched</span>
          ) : (
            ''
          ),
      },
    ],
    [inline],
  );

  if (!loading && !error && banks.length === 0) {
    return (
      <ReportScreen title="Bank Overview" periodMode="asOn">
        <NoBanks />
      </ReportScreen>
    );
  }

  // The first bank with lines to match (the stat's link opens Match statement for it).
  const toMatch = banks.find((b) => b.statementLines.unmatched > 0) ?? null;
  const stat = bankSummaryStat(banks).map((it) => ({
    ...it,
    onClick: it.id === 'match' && canEdit && toMatch ? () => nav.push('banking.match', { ledgerId: toMatch.id }) : undefined,
  }));

  return (
    <ReportScreen
      title="Bank Overview"
      periodMode="asOn"
      loading={loading}
      refreshing={refreshing}
      error={error}
      onRetry={() => void refetch()}
      exportDef={() => summaryExport(banks)}
      graph={reportGraph(spec, { inline })}
      stat={stat.length > 0 ? <StatLine items={stat} /> : null}
      hint="Enter Reconcile · Alt+I Import statement · Alt+M Match · Alt+Q Cheque register · Alt+T Post-dated cheques · Alt+C Create Bank Ledger · Alt+F2 Date"
      actions={[
        { key: 'Alt+I', label: 'Import statement', icon: 'upload', onClick: () => nav.push('banking.import', { ledgerId: selected?.id }), hidden: !canEdit, disabled: !selected },
        { key: 'Alt+M', label: 'Match statement', icon: 'link', onClick: () => nav.push('banking.match', { ledgerId: selected?.id }), hidden: !canEdit, disabled: !selected },
        { key: 'Alt+Q', label: 'Cheque register', icon: 'book', onClick: () => nav.push('banking.cheques', { ledgerId: selected?.id }), group: 'go' },
        { key: 'Alt+T', label: 'Post-dated cheques', icon: 'calendar', onClick: () => nav.push('banking.pdc'), group: 'go' },
        { key: 'Alt+C', label: 'Create bank ledger', icon: 'plus', onClick: () => nav.push('accounts.ledger.form', { groupCode: 'BANK_ACCOUNTS' }), hidden: !canCreateLedger, group: 'masters' },
      ]}
    >
      <DataTable
        aria-label="Bank accounts"
        autoFocus
        columns={columns}
        rows={banks}
        getRowKey={(r) => String(r.id)}
        selectedKey={cursor}
        onSelect={setCursor}
        onRowActivate={(r) => nav.push('banking.brs', { ledgerId: r.id })}
        loading={loading}
      />
    </ReportScreen>
  );
}
