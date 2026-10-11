/**
 * 'accounts.ledger.list' — all ledgers with their closing balance (as on the period end, Alt+F2),
 * virtualised for 10,000+ ledgers. 2.1 (SPEC-21 §1.7, D22): one toolbar row — search and the type filter
 * "All types ▾" (`params.chip` preselects it) —; the title row reads "Create ledger · More ▾": Print
 * (Alt+P) and Export (Alt+E) are in More (`outputInMore`), with Create several (Alt+B, Alt+M), the
 * checkable "Hide inactive ledgers", Edit history (Alt+H), Chart of accounts (Alt+T) and Delete (Alt+D /
 * Ctrl+D; the server explains when a ledger cannot be deleted). No Type column, no "Built-in" badges; a
 * GSTIN column only when some ledger has one. Enter opens the ledger (alteration).
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatIndianNumber } from '../../../shared/format.ts';
import type { LedgerListRow } from '../../../shared/types/accounts.ts';
import { api } from '../../app/api.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import { checkItem } from '../../app/lib/moreItems.ts';
import { Button, DataTable, EmptyState, Select, TextInput, useDebouncedValue } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { NameCell } from './components.tsx';
import { useDeleteLedger } from './hooks.ts';
import { chipClasses, LEDGER_CHIPS } from './lib/ledgerFilters.ts';
import type { LedgerChip } from './lib/ledgerFilters.ts';

const LIMIT = 10_000;

export function LedgerListScreen({ params }: ScreenProps<{ chip?: LedgerChip; search?: string }>) {
  const nav = useNav();
  const { to } = usePeriod();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const canAudit = useCan('audit.view');
  const deleteLedger = useDeleteLedger();
  const [chip, setChip] = useState<LedgerChip>(LEDGER_CHIPS.some((c) => c.id === params.chip) ? (params.chip as LedgerChip) : 'all');
  const [search, setSearch] = useState(params.search ?? '');
  // "Hide inactive ledgers" (More ▾, checkable, keyless): inactive ledgers are listed by default.
  const [hideInactive, setHideInactive] = useState(false);
  const showInactive = !hideInactive;
  const debounced = useDebouncedValue(search.trim(), 200);
  const classes = chipClasses(chip);
  const q = useApiQuery(
    'accounts.ledger.list',
    { search: debounced || undefined, classes, withBalance: true, asOf: to, activeOnly: showInactive ? undefined : true, limit: LIMIT },
    { keepPrevious: true },
  );
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? null;

  const columns = useMemo<Column<LedgerListRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Ledger',
        sortable: true,
        render: (r) => <NameCell name={r.name} alias={r.alias} inactive={!r.isActive} />,
        title: (r) => r.name,
      },
      { key: 'groupName', header: 'Under', width: 220, sortable: true },
      // Blank for unregistered parties; the column hides when no ledger shown has a GSTIN.
      { key: 'gstin', header: 'GSTIN', width: 170, render: (r) => (r.gstin ? <span className="bx-num">{r.gstin}</span> : null) },
      { key: 'closingBalance', header: 'Closing balance', kind: 'drcr', width: 170, sortable: true, keepEmpty: true, value: (r) => r.closingBalance ?? 0 },
    ],
    [],
  );

  const create = () => nav.push('accounts.ledger.form', {});
  const remove = async () => {
    if (current) await deleteLedger({ id: current.id, name: current.name, isActive: current.isActive, isPredefined: current.isPredefined });
  };

  /**
   * Alt+H: the ledger's Edit history, scoped by its guid (read from the ledger: list rows carry no guid)
   * so a ledger id reused after a delete does not mix in the deleted ledger's entries.
   */
  const openHistory = async (r: LedgerListRow): Promise<void> => {
    let entityGuid: string | undefined;
    try {
      entityGuid = (await api('accounts.ledger.get', { id: r.id })).guid;
    } catch {
      // Not readable (just deleted elsewhere…): the history by id still shows what happened.
    }
    nav.push('security.audit', { entityType: 'ledger', entityId: r.id, label: r.name, ...(entityGuid ? { entityGuid } : {}) });
  };

  const filtered = debounced !== '' || chip !== 'all' || hideInactive;
  const chipLabel = LEDGER_CHIPS.find((c) => c.id === chip)?.label ?? 'All';
  const showAll = () => {
    setSearch('');
    setChip('all');
    setHideInactive(false);
  };

  return (
    <ReportScreen
      title="Ledgers"
      subtitle={q.data ? `${formatIndianNumber(total, 0)} ledger${total === 1 ? '' : 's'}` : undefined}
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      outputInMore
      hint="Enter Alter · Alt+C Create · Alt+D Delete · Alt+B Bulk create · Alt+H Edit History · Alt+T Chart · Alt+E Export · Esc Back"
      actions={[
        {
          key: 'Alt+C',
          label: 'Create ledger',
          icon: 'plus',
          onClick: create,
          disabled: !canCreate,
          prominent: true,
        },
        // Alt+M is the 2.1 alias (the Stock Items list uses Alt+M for the same thing).
        { key: 'Alt+B, Alt+M', label: 'Create several', icon: 'list', onClick: () => nav.push('accounts.ledger.bulk'), disabled: !canCreate },
        checkItem('Hide inactive ledgers', hideInactive, setHideInactive),
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => current && void openHistory(current),
          disabled: !current,
          hidden: !canAudit,
          group: 'more',
        },
        { key: 'Alt+T', label: 'Chart of accounts', icon: 'layers', onClick: () => nav.push('accounts.chart'), group: 'more' },
        { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), disabled: !canDelete || !current, group: 'danger' },
      ]}
      filters={
        <>
          <TextInput
            size="sm"
            wrapperClassName="bx-acc-toolbar__search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leadingIcon="search"
            placeholder="Search name, alias or GSTIN"
            aria-label="Search ledgers"
          />
          <Select<LedgerChip>
            size="sm"
            aria-label="Show ledgers of type"
            value={chip}
            onChange={setChip}
            options={LEDGER_CHIPS.map((c) => ({ value: c.id, label: c.id === 'all' ? 'All types' : c.label }))}
          />
          {total > rows.length ? <span className="bx-muted">First {formatIndianNumber(rows.length, 0)} — type to narrow down</span> : null}
        </>
      }
      exportDef={() => ({
        subtitle: chip === 'all' ? 'All ledgers' : chipLabel,
        period: `As on ${formatDate(to)}`,
        columns: [{ header: 'Ledger' }, { header: 'Alias' }, { header: 'Under' }, { header: 'GSTIN' }, { header: 'Closing balance', kind: 'drcr' }],
        rows: rows.map((r) => [r.name, r.alias ?? '', r.groupName, r.gstin ?? '', r.closingBalance ?? 0]),
      })}
    >
      <DataTable<LedgerListRow>
        aria-label="Ledgers"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={cursor}
        onSelect={(k) => setCursor(k)}
        loading={q.loading}
        hideEmptyColumns
        onRowActivate={(r) => nav.push('accounts.ledger.form', { id: r.id })}
        defaultSort={{ key: 'name', direction: 'asc' }}
        empty={
          filtered ? (
            <EmptyState title="No ledgers match" body="Change the search or the type." action={<Button variant="link" onClick={showAll}>Show all ledgers</Button>} />
          ) : (
            <EmptyState
              title="No ledgers yet"
              body="Create your customers, suppliers, bank accounts and expense heads."
              action={canCreate ? <Button variant="link" onClick={create}>Create ledger</Button> : undefined}
            />
          )
        }
      />
    </ReportScreen>
  );
}
