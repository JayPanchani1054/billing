/**
 * 'accounts.chart' — Chart of Accounts: every group with its sub-groups and ledgers and their
 * closing balances as on the period end (Alt+F2). Search keeps the path to each match.
 * Enter opens the group / ledger form, →/← expand/collapse, Alt+F1 detailed/condensed,
 * Alt+C creates a ledger under the highlighted group, Alt+U a sub-group; Alt+E / Alt+P export / print.
 */
import { useMemo, useState } from 'react';
import { formatIndianNumber } from '../../../shared/format.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Button, Checkbox, DataTable, EmptyState, TextInput, useDebouncedValue } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { NameCell } from './components.tsx';
import { filterChart, flattenChart, parentKeys, parentKeysUpTo } from './lib/chartTree.ts';
import type { ChartRow } from './lib/chartTree.ts';

export function ChartScreen() {
  const nav = useNav();
  const { to } = usePeriod();
  const canCreate = useCan('masters.create');
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 150);
  const q = useApiQuery('accounts.chart', { asOf: to, activeOnly: activeOnly || undefined }, { keepPrevious: true });
  const all = useMemo(() => flattenChart(q.data?.roots ?? []), [q.data]);
  const rows = useMemo(() => filterChart(all, debounced), [all, debounced]);
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const allParents = useMemo(() => parentKeys(all), [all]);
  const detailed = expanded !== null && allParents.size > 0 && [...allParents].every((k) => expanded.has(k));
  // While searching everything that matches is shown expanded.
  const effective = useMemo(() => (debounced ? parentKeys(rows) : (expanded ?? parentKeysUpTo(all, 1))), [debounced, rows, expanded, all]);

  const current = rows.find((r) => r.key === cursor) ?? null;
  const groupForCreate = current ? (current.kind === 'group' ? current.id : groupOfLedger(rows, current)) : null;

  const columns = useMemo<Column<ChartRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Particulars',
        tree: true,
        render: (r) => (
          <NameCell
            name={r.name}
            alias={r.alias}
            inactive={!r.isActive}
            extra={r.kind === 'group' && r.ledgerCount > 0 ? <span className="bx-muted">{formatIndianNumber(r.ledgerCount, 0)}</span> : null}
          />
        ),
        title: (r) => [...r.parents, r.name].join(' › '),
      },
      { key: 'kind', header: 'Kind', width: 90, value: (r) => (r.kind === 'group' ? 'Group' : 'Ledger') },
      { key: 'closing', header: 'Closing balance', kind: 'drcr', width: 180 },
    ],
    [],
  );

  const toggleDetail = () => setExpanded(detailed ? parentKeysUpTo(all, 1) : allParents);
  const createLedger = () => nav.push('accounts.ledger.form', groupForCreate !== null ? { groupId: groupForCreate } : {});
  const createGroup = () => nav.push('accounts.group.form', groupForCreate !== null ? { parentId: groupForCreate } : {});
  const open = (r: ChartRow) => nav.push(r.kind === 'group' ? 'accounts.group.form' : 'accounts.ledger.form', { id: r.id });

  const data = q.data;
  return (
    <ReportScreen
      title="Chart of Accounts"
      subtitle={data ? `${formatIndianNumber(data.groupCount, 0)} groups · ${formatIndianNumber(data.ledgerCount, 0)} ledgers` : undefined}
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open · →/← Expand/Collapse · Alt+F1 Detailed · Alt+C Create Ledger · Alt+U Create Group · Alt+E Export · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create ledger', icon: 'plus', primary: true, onClick: createLedger, disabled: !canCreate },
        { key: 'Alt+U', label: 'Create group', icon: 'layers', onClick: createGroup, disabled: !canCreate },
        { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: detailed ? 'chevrons-up-down' : 'list', onClick: toggleDetail, group: 'view' },
      ]}
      filters={
        <div className="bx-acc-toolbar">
          <TextInput
            wrapperClassName="bx-acc-toolbar__search"
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leadingIcon="search"
            placeholder="Find a group or ledger"
            aria-label="Find a group or ledger"
          />
          <Button size="sm" variant="ghost" onClick={() => setExpanded(allParents)} disabled={!!debounced}>
            Expand all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set())} disabled={!!debounced}>
            Collapse all
          </Button>
          <Checkbox checked={activeOnly} onChange={setActiveOnly} label="Hide inactive ledgers" />
        </div>
      }
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Kind' }, { header: 'Closing balance', kind: 'drcr' }],
        rows: rows.map((r) => [r.name, r.kind === 'group' ? 'Group' : 'Ledger', r.closing]),
        levels: rows.map((r) => r.level),
      })}
    >
      <DataTable<ChartRow>
        aria-label="Chart of accounts"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.kind === 'group'}
        expandable
        expandedKeys={effective}
        onExpandedChange={(keys) => setExpanded(keys)}
        selectedKey={cursor}
        onSelect={(k) => setCursor(k)}
        onRowActivate={open}
        loading={q.loading}
        footerRows={
          data
            ? [
                { key: 'dr', cells: { name: 'Total of debit balances', closing: data.totalDebit }, tone: 'subtle' },
                { key: 'cr', cells: { name: 'Total of credit balances', closing: -data.totalCredit }, tone: 'subtle' },
              ]
            : undefined
        }
        empty={
          debounced ? (
            <EmptyState icon="search" title="Nothing matches" body={`No group or ledger contains “${debounced}”.`} />
          ) : (
            <EmptyState icon="layers" title="No accounts yet" body="Press Alt+C to create the first ledger." />
          )
        }
      />
    </ReportScreen>
  );
}

/** Group id of the nearest group row above a ledger row (its parent in the tree). */
function groupOfLedger(rows: readonly ChartRow[], ledger: ChartRow): number | null {
  const i = rows.indexOf(ledger);
  for (let k = i - 1; k >= 0; k--) if (rows[k].kind === 'group' && rows[k].level < ledger.level) return rows[k].id;
  return null;
}
