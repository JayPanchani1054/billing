/**
 * 'accounts.ledger.list' — all ledgers with their closing balance (as on the period end, Alt+F2),
 * class filter chips (Parties, Cash & Bank, Sales, …), search, virtualised for 10,000+ ledgers.
 * Enter opens the ledger (alteration), Alt+C creates one, Alt+D (or Ctrl+D) deletes the highlighted ledger
 * (the server explains when it cannot be deleted), Alt+H its edit history, Alt+T the chart of accounts,
 * Alt+E / Alt+P export / print.
 */
import { useMemo, useState } from 'react';
import { formatIndianNumber } from '../../../shared/format.ts';
import type { LedgerListRow } from '../../../shared/types/accounts.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Button, Checkbox, DataTable, EmptyState, SegmentedControl, TextInput, useDebouncedValue } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { NameCell } from './components.tsx';
import { useDeleteLedger } from './hooks.ts';
import { chipClasses, LEDGER_CHIPS, ledgerKind } from './lib/ledgerFilters.ts';
import type { LedgerChip } from './lib/ledgerFilters.ts';
import { registrationLabel } from './lib/gstin.ts';

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
  const [showInactive, setShowInactive] = useState(true);
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
        render: (r) => <NameCell name={r.name} alias={r.alias} inactive={!r.isActive} predefined={r.isPredefined} />,
        title: (r) => r.name,
      },
      { key: 'groupName', header: 'Under', width: 200, sortable: true },
      { key: 'kind', header: 'Type', width: 100, value: (r) => ledgerKind(r), sortable: true },
      { key: 'gstin', header: 'GSTIN', width: 170, render: (r) => (r.gstin ? <span className="bx-num">{r.gstin}</span> : r.registrationType ? <span className="bx-muted">{registrationLabel(r.registrationType)}</span> : null) },
      { key: 'closingBalance', header: 'Closing balance', kind: 'drcr', width: 170, sortable: true, value: (r) => r.closingBalance ?? 0 },
    ],
    [],
  );

  const create = () => nav.push('accounts.ledger.form', {});
  const remove = async () => {
    if (current) await deleteLedger({ id: current.id, name: current.name, isActive: current.isActive, isPredefined: current.isPredefined });
  };

  const filtered = debounced !== '' || chip !== 'all' || !showInactive;
  const chipLabel = LEDGER_CHIPS.find((c) => c.id === chip)?.label ?? 'All';

  return (
    <ReportScreen
      title="Ledgers"
      subtitle={q.data ? `${formatIndianNumber(total, 0)} ledger${total === 1 ? '' : 's'}${chip !== 'all' ? ` · ${chipLabel}` : ''}` : undefined}
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create · Alt+D Delete · Alt+B Bulk create · Alt+H Edit History · Alt+T Chart · Alt+E Export · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create ledger', icon: 'plus', primary: true, onClick: create, disabled: !canCreate },
        { key: 'Alt+B', label: 'Create several', icon: 'list', onClick: () => nav.push('accounts.ledger.bulk'), disabled: !canCreate },
        { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), disabled: !canDelete || !current, group: 'danger' },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => current && nav.push('security.audit', { entityType: 'ledger', entityId: current.id, label: current.name }),
          disabled: !current,
          hidden: !canAudit,
          group: 'more',
        },
        { key: 'Alt+T', label: 'Chart of accounts', icon: 'layers', onClick: () => nav.push('accounts.chart'), group: 'more' },
      ]}
      filters={
        <SegmentedControl<LedgerChip>
          aria-label="Show ledgers of type"
          size="sm"
          value={chip}
          onChange={setChip}
          options={LEDGER_CHIPS.map((c) => ({ value: c.id, label: c.label }))}
        />
      }
      exportDef={() => ({
        subtitle: chip === 'all' ? 'All ledgers' : chipLabel,
        columns: [{ header: 'Ledger' }, { header: 'Alias' }, { header: 'Under' }, { header: 'GSTIN' }, { header: 'Closing balance', kind: 'drcr' }],
        rows: rows.map((r) => [r.name, r.alias ?? '', r.groupName, r.gstin ?? '', r.closingBalance ?? 0]),
      })}
    >
      <div className="bx-acc-fill">
        <div className="bx-acc-toolbar">
          <TextInput
            wrapperClassName="bx-acc-toolbar__search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leadingIcon="search"
            placeholder="Search name, alias or GSTIN"
            aria-label="Search ledgers"
          />
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Show inactive" />
          {total > rows.length ? <span className="bx-muted">Showing the first {formatIndianNumber(rows.length, 0)} — type to narrow down.</span> : null}
        </div>
        <div className="bx-acc-fill__table">
          <DataTable<LedgerListRow>
              aria-label="Ledgers"
              autoFocus
              columns={columns}
              rows={rows}
              getRowKey={(r) => String(r.id)}
              selectedKey={cursor}
              onSelect={(k) => setCursor(k)}
              loading={q.loading}
              onRowActivate={(r) => nav.push('accounts.ledger.form', { id: r.id })}
              defaultSort={{ key: 'name', direction: 'asc' }}
              empty={
                filtered ? (
                  <EmptyState icon="search" title="No ledgers match" body="Change the search or the type filter." action={<Button onClick={() => { setSearch(''); setChip('all'); setShowInactive(true); }}>Show all ledgers</Button>} />
                ) : (
                  <EmptyState
                    icon="ledger"
                    title="No ledgers yet"
                    body="Create your customers, suppliers, bank accounts and expense heads. Press Alt+C."
                    action={canCreate ? <Button variant="primary" icon="plus" onClick={create}>Create ledger</Button> : undefined}
                  />
                )
              }
            />
        </div>
      </div>
    </ReportScreen>
  );
}
