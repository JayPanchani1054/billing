/**
 * 'banking.summary' — Bank overview: every bank / OD account as on the period end (Alt+F2) with the balance
 * as per books and as per bank, open items, the last reconciled date and the latest imported statement.
 * Enter opens the reconciliation; Alt+I imports a statement and Alt+M matches it for the highlighted bank;
 * Alt+Q cheque register, Alt+T post-dated cheques, Alt+C creates a bank ledger (under Bank Accounts).
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
import { Badge, DataTable, Inline, KpiCard, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { NoBanks, bankLabel, useBanks } from './components.tsx';
import { summaryExport } from './lib/exports.ts';

export function SummaryScreen(_props: ScreenProps<Record<string, never>>) {
  const nav = useNav();
  const canEdit = useCan('banking.reconcile');
  const canCreateLedger = useCan('masters.create');
  const { to: asOf } = usePeriod();
  const { banks, loading, error, refetch, refreshing } = useBanks(asOf);
  const [cursor, setCursor] = useState<string | null>(null);
  const selected = banks.find((b) => String(b.id) === cursor) ?? banks[0] ?? null;

  const columns = useMemo<Column<BankSummaryRow>[]>(
    () => [
      { key: 'name', header: 'Bank account', minWidth: 200, sortable: true, value: (r) => bankLabel(r) },
      { key: 'balanceAsPerBooks', header: 'As per books', kind: 'drcr', width: 150, total: true, sortable: true },
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
          return (
            <Inline gap={1} wrap={false}>
              <span>
                {formatDate(r.lastStatement.date)}
                {bal !== null ? ` · ${formatDrCr(bal, { keepZero: true })}` : ''}
              </span>
              {diff !== null && diff !== 0 ? (
                <Badge size="sm" tone="warning" title={`Statement − bank as per books on ${formatDate(r.lastStatement.date)}: ${formatDrCr(diff)}`}>
                  Differs by {formatMoney(Math.abs(diff))}
                </Badge>
              ) : diff === 0 ? (
                <Badge size="sm" tone="success">
                  Agrees
                </Badge>
              ) : null}
            </Inline>
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
            <Badge size="sm" tone="success">
              All matched
            </Badge>
          ) : (
            ''
          ),
      },
    ],
    [],
  );

  if (!loading && !error && banks.length === 0) {
    return (
      <ReportScreen title="Bank Overview" periodMode="asOn">
        <NoBanks />
      </ReportScreen>
    );
  }

  const totalBooks = banks.reduce((s, b) => s + b.balanceAsPerBooks, 0);
  const totalBank = banks.reduce((s, b) => s + b.balanceAsPerBank, 0);
  const openItems = banks.reduce((s, b) => s + b.unreconciled.count, 0);
  const toMatch = banks.reduce((s, b) => s + b.statementLines.unmatched, 0);

  return (
    <ReportScreen
      title="Bank Overview"
      periodMode="asOn"
      loading={loading}
      refreshing={refreshing}
      error={error}
      onRetry={() => void refetch()}
      exportDef={() => summaryExport(banks)}
      hint="Enter Reconcile · Alt+I Import statement · Alt+M Match · Alt+Q Cheque register · Alt+T Post-dated cheques · Alt+C Create Bank Ledger · Alt+F2 Date"
      actions={[
        { key: 'Alt+I', label: 'Import statement', icon: 'upload', onClick: () => nav.push('banking.import', { ledgerId: selected?.id }), hidden: !canEdit, disabled: !selected },
        { key: 'Alt+M', label: 'Match statement', icon: 'link', onClick: () => nav.push('banking.match', { ledgerId: selected?.id }), hidden: !canEdit, disabled: !selected },
        { key: 'Alt+Q', label: 'Cheque register', icon: 'book', onClick: () => nav.push('banking.cheques', { ledgerId: selected?.id }), group: 'go' },
        { key: 'Alt+T', label: 'Post-dated cheques', icon: 'calendar', onClick: () => nav.push('banking.pdc'), group: 'go' },
        { key: 'Alt+C', label: 'Create bank ledger', icon: 'plus', onClick: () => nav.push('accounts.ledger.form', { groupCode: 'BANK_ACCOUNTS' }), hidden: !canCreateLedger, group: 'masters' },
      ]}
    >
      <Stack gap={3}>
        <Inline gap={3} wrap>
          <KpiCard
            label="Bank balance as per books"
            value={`₹ ${formatDrCr(totalBooks, { keepZero: true })}`}
            caption={`${banks.length} account${banks.length === 1 ? '' : 's'} · Dr = money in the bank, Cr = overdrawn (OD / CC)`}
            icon="bank"
          />
          <KpiCard label="Bank balance as per bank" value={`₹ ${formatDrCr(totalBank, { keepZero: true })}`} caption="From bank dates entered so far" icon="building" />
          <KpiCard label="Entries not yet in the bank" value={String(openItems)} caption="Cheques not presented or cleared" icon="clock" />
          <KpiCard label="Statement lines to match" value={String(toMatch)} caption={toMatch > 0 ? 'Open Match statement (Alt+M)' : 'Nothing waiting'} icon="link" />
        </Inline>
        <div className="bx-bk-table--tall">
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
        </div>
      </Stack>
    </ReportScreen>
  );
}
