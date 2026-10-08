/**
 * 'accounts.openingBalances' — opening trial balance: total debit and credit openings, the
 * difference explained in plain words, and every ledger that has an opening balance (Enter alters
 * the ledger to correct it). Alt+E / Alt+P export / print.
 *
 * The ledger list is accounts.ledger.list with the balance as on the day before the books begin:
 * no voucher can be dated earlier, so that balance is exactly the ledger's opening balance.
 */
import { useMemo } from 'react';
import { addDays, formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { LedgerListRow } from '../../../shared/types/accounts.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { useBooks } from '../../app/working.tsx';
import { Banner, Button, DataTable, EmptyState, Grid, KpiCard, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { NameCell } from './components.tsx';
import { explainOpening } from './lib/ledgerFilters.ts';

export function OpeningBalancesScreen() {
  const nav = useNav();
  const features = useFeatures();
  const canCreate = useCan('masters.create');
  const { booksFrom } = useBooks();
  const summary = useApiQuery('accounts.openingBalances.summary', {});
  const list = useApiQuery('accounts.ledger.list', { withBalance: true, asOf: addDays(booksFrom, -1), limit: 10_000 }, { keepPrevious: true });
  const rows = useMemo(() => (list.data?.rows ?? []).filter((r) => (r.closingBalance ?? 0) !== 0), [list.data]);
  const s = summary.data;
  const explanation = s ? explainOpening(s, null) : null;
  const integrated = features.inventory && features.integrateInventory;

  const columns = useMemo<Column<LedgerListRow>[]>(
    () => [
      { key: 'name', header: 'Ledger', sortable: true, render: (r) => <NameCell name={r.name} alias={r.alias} inactive={!r.isActive} /> },
      { key: 'groupName', header: 'Under', width: 220, sortable: true },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 160, blankZero: true, value: (r) => Math.max(0, r.closingBalance ?? 0), total: true, sortable: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 160, blankZero: true, value: (r) => Math.max(0, -(r.closingBalance ?? 0)), total: true, sortable: true },
    ],
    [],
  );

  return (
    <ReportScreen
      title="Opening Balances"
      subtitle={`As on ${formatDate(booksFrom)}, when the books begin`}
      periodMode="none"
      loading={summary.loading}
      refreshing={summary.refreshing || list.refreshing}
      error={summary.error ?? list.error}
      onRetry={() => {
        void summary.refetch();
        void list.refetch();
      }}
      hint="Enter Alter ledger · Alt+C Create ledger · Alt+E Export · Esc Back"
      actions={[{ key: 'Alt+C', label: 'Create ledger', icon: 'plus', primary: true, disabled: !canCreate, onClick: () => nav.push('accounts.ledger.form', {}) }]}
      exportDef={() => ({
        subtitle: `As on ${formatDate(booksFrom)}`,
        columns: [{ header: 'Ledger' }, { header: 'Under' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }],
        rows: rows.map((r) => [r.name, r.groupName, Math.max(0, r.closingBalance ?? 0), Math.max(0, -(r.closingBalance ?? 0))]),
        totals: s ? ['Total', '', s.totalDebit, s.totalCredit] : undefined,
      })}
    >
      <Stack gap={4} style={{ height: '100%' }}>
        {s ? (
          <Grid columns={3} gap={3}>
            <KpiCard label="Debit balances" value={`₹ ${formatMoney(s.totalDebit)}`} caption="Assets and expenses" />
            <KpiCard label="Credit balances" value={`₹ ${formatMoney(s.totalCredit)}`} caption="Capital, liabilities and income" />
            <KpiCard label="Difference" value={s.difference === 0 ? 'Nil' : `₹ ${formatMoney(Math.abs(s.difference))} ${s.difference > 0 ? 'Dr' : 'Cr'}`} caption={`${s.ledgerCount} ledger${s.ledgerCount === 1 ? '' : 's'} with an opening balance`} />
          </Grid>
        ) : null}
        {explanation ? (
          <Banner tone={explanation.tone} title={explanation.title}>
            {explanation.body}
            {integrated && s && s.difference < 0
              ? ' Inventory is integrated with accounts: the opening value of your stock items is added as a debit in the Balance Sheet, so a credit difference equal to your opening stock is expected.'
              : null}
          </Banner>
        ) : null}
        <div className="bx-acc-fill__table">
          <DataTable<LedgerListRow>
            aria-label="Ledgers with an opening balance"
            autoFocus
            columns={columns}
            rows={rows}
            getRowKey={(r) => String(r.id)}
            loading={list.loading}
            defaultSort={{ key: 'name', direction: 'asc' }}
            onRowActivate={(r) => nav.push('accounts.ledger.form', { id: r.id })}
            empty={
              <EmptyState
                icon="ledger"
                title="No opening balances"
                body="Moving from another system? Open each ledger (Ledgers → Enter) and enter its balance as on the day the books begin."
                action={<Button onClick={() => nav.push('accounts.ledger.list')}>Go to ledgers</Button>}
              />
            }
          />
        </div>
      </Stack>
    </ReportScreen>
  );
}
