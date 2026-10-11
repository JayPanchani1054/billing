/**
 * 'accounts.openingBalances' — opening trial balance: every ledger that has an opening balance (Enter
 * alters the ledger to correct it) with the Debit / Credit totals; 2.1: the toolbar row's stat says
 * "Difference ₹x Dr/Cr" only when there is one, and the plain-words explanation is in More ▾ › "About
 * this report". Alt+E / Alt+P export / print (More ▾).
 *
 * The ledger list is accounts.ledger.list with the balance as on the day before the books begin:
 * no voucher can be dated earlier, so that balance is exactly the ledger's opening balance.
 * With inventory integrated with accounts the opening stock (the stock items' opening value, a
 * debit) is part of the opening trial balance; it is read from the Trial Balance as on the books
 * beginning (reports.trialBalance → openingStock) when the user may see reports.
 */
import { useMemo } from 'react';
import { addDays, formatDate } from '../../../shared/dates.ts';
import type { LedgerListRow } from '../../../shared/types/accounts.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { useBooks } from '../../app/working.tsx';
import { Button, DataTable, EmptyState, StatLine } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { statMoney } from '../../ui/lib/statLine.ts';
import { NameCell } from './components.tsx';
import { explainOpening } from './lib/ledgerFilters.ts';

/** A row of the opening trial balance: a ledger, or the opening stock of the stock items (no ledger). */
interface OpeningRow {
  key: string;
  ledgerId: number | null;
  name: string;
  alias: string | null;
  isActive: boolean;
  groupName: string;
  /** Dr +, Cr −. */
  balance: number;
}

const ledgerRow = (r: LedgerListRow): OpeningRow => ({ key: String(r.id), ledgerId: r.id, name: r.name, alias: r.alias, isActive: r.isActive, groupName: r.groupName, balance: r.closingBalance ?? 0 });

export function OpeningBalancesScreen() {
  const nav = useNav();
  const features = useFeatures();
  const canCreate = useCan('masters.create');
  const canReports = useCan('reports.view');
  const { booksFrom } = useBooks();
  const summary = useApiQuery('accounts.openingBalances.summary', {});
  const list = useApiQuery('accounts.ledger.list', { withBalance: true, asOf: addDays(booksFrom, -1), limit: 10_000 }, { keepPrevious: true });
  const s = summary.data;
  const integrated = features.inventory && features.integrateInventory;
  const tb = useApiQuery('reports.trialBalance', { from: booksFrom, to: booksFrom, mode: 'groups' }, { enabled: integrated && canReports });
  const openingStock = integrated && tb.data ? tb.data.openingStock : null;
  // The opening stock (a debit) is a row of its own, so the table's totals are the opening trial balance.
  const rows = useMemo<OpeningRow[]>(() => {
    const ledgers = (list.data?.rows ?? []).filter((r) => (r.closingBalance ?? 0) !== 0).map(ledgerRow);
    return openingStock ? [{ key: 'stock', ledgerId: null, name: 'Opening stock (stock items)', alias: null, isActive: true, groupName: 'Stock-in-Hand', balance: openingStock }, ...ledgers] : ledgers;
  }, [list.data, openingStock]);
  const explanation = s ? explainOpening(s, openingStock) : null;
  // Σ Dr − Σ Cr including the opening stock (a debit) when it is known.
  const difference = s ? s.difference + (openingStock ?? 0) : 0;

  const columns = useMemo<Column<OpeningRow>[]>(
    () => [
      { key: 'name', header: 'Ledger', sortable: true, render: (r) => <NameCell name={r.name} alias={r.alias} inactive={!r.isActive} /> },
      { key: 'groupName', header: 'Under', width: 220, sortable: true },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 160, blankZero: true, value: (r) => Math.max(0, r.balance), total: true, sortable: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 160, blankZero: true, value: (r) => Math.max(0, -r.balance), total: true, sortable: true },
    ],
    [],
  );

  return (
    <ReportScreen
      title="Opening Balances"
      subtitle={`As on ${formatDate(booksFrom, 'D-MMM-YY')}, when the books begin`}
      periodMode="none"
      loading={summary.loading}
      refreshing={summary.refreshing || list.refreshing}
      error={summary.error ?? list.error}
      onRetry={() => {
        void summary.refetch();
        void list.refetch();
      }}
      outputInMore
      hint="Enter Alter ledger · Alt+C Create ledger · Alt+E Export · Esc Back"
      actions={[
        {
          key: 'Alt+C',
          label: 'Create ledger',
          icon: 'plus',
          disabled: !canCreate,
          onClick: () => nav.push('accounts.ledger.form', {}),
          prominent: true,
        },
      ]}
      // 2.1: the one thing the table's totals do not say — the difference, only when there is one.
      stat={
        s && difference !== 0 ? (
          <StatLine items={[{ label: 'Difference', value: `${statMoney(Math.abs(difference))} ${difference > 0 ? 'Dr' : 'Cr'}`, tone: 'warning', title: explanation?.body }]} />
        ) : undefined
      }
      about={
        explanation ? (
          <>
            <p>
              <strong>{explanation.title}.</strong> {explanation.body}
            </p>
            {integrated && openingStock === null && s && s.difference < 0 ? (
              <p>Inventory is integrated with accounts: the opening value of your stock items is added as a debit in the Balance Sheet, so a credit difference equal to your opening stock is expected.</p>
            ) : null}
            {s ? <p>{s.ledgerCount} ledger{s.ledgerCount === 1 ? '' : 's'} with an opening balance.</p> : null}
          </>
        ) : undefined
      }
      exportDef={() => ({
        subtitle: `As on ${formatDate(booksFrom)}`,
        columns: [{ header: 'Ledger' }, { header: 'Under' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }],
        rows: rows.map((r) => [r.name, r.groupName, Math.max(0, r.balance), Math.max(0, -r.balance)]),
        totals: s ? ['Total', '', s.totalDebit + (openingStock ?? 0), s.totalCredit] : undefined,
      })}
    >
      <DataTable<OpeningRow>
        aria-label="Ledgers with an opening balance"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        loading={list.loading}
        defaultSort={{ key: 'name', direction: 'asc' }}
        onRowActivate={(r) => (r.ledgerId !== null ? nav.push('accounts.ledger.form', { id: r.ledgerId }) : undefined)}
        empty={
          <EmptyState
            title="No opening balances"
            body="Moving from another system? Open each ledger (Ledgers → Enter) and enter its balance as on the day the books begin."
            action={<Button variant="link" onClick={() => nav.push('accounts.ledger.list')}>Go to ledgers</Button>}
          />
        }
      />
    </ReportScreen>
  );
}

