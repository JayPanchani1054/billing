/**
 * 'data.verify' — "Check books": runs the data integrity checks of the open company and lists each
 * with pass / problems; the selected check's details show underneath. Alt+R runs again; Alt+E/Alt+P
 * export or print the list. 2.1: all-passed is the toolbar row's stat; problems are a one-line banner;
 * what the checks cover and what to do about damage is in More › About this report.
 */
import { useMemo, useState } from 'react';
import type { DataVerifyCheck } from '../../../shared/types/data.ts';
import { formatDateTime } from '../../app/display.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { Badge, Banner, DataTable, EmptyState, Panel, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { dataCheckSummary } from './lib/backupView.ts';

export function VerifyScreen() {
  const nav = useNav();
  const canBackup = useCan('data.backup');
  const q = useApiQuery('data.verify', {}, { staleTime: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const checks = q.data?.checks ?? [];
  const current = checks.find((c) => c.name === selected) ?? checks.find((c) => !c.ok) ?? null;
  const summary = q.data ? dataCheckSummary(q.data) : null;

  const columns = useMemo<Column<DataVerifyCheck>[]>(
    () => [
      {
        key: 'ok',
        header: 'Result',
        width: 130,
        value: (c) => (c.ok ? 'Passed' : 'Problems found'),
        render: (c) =>
          c.ok ? (
            <span className="bx-muted">Passed ✓</span>
          ) : (
            <Badge tone="danger" size="sm">
              Problems found
            </Badge>
          ),
      },
      { key: 'label', header: 'Check' },
      { key: 'count', header: 'Problems', kind: 'number', width: 110, blankZero: true },
    ],
    [],
  );

  return (
    <ReportScreen
      title="Check Books"
      subtitle={q.data ? `Checked ${formatDateTime(q.data.checkedAt)}` : 'Checking the company data…'}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="↑/↓ Choose a check · Alt+R Check again · Alt+E Export · Esc Back"
      actions={[
        { key: 'Alt+R', label: 'Check again', icon: 'refresh', onClick: () => void q.refetch(), disabled: q.refreshing },
        { key: 'Alt+B', label: 'Backups', icon: 'database', onClick: () => nav.push('data.backup'), hidden: !canBackup, group: 'more' },
      ]}
      // A check result, not a total (SPEC-21 D24): "Your books are in order"; problems are a one-line banner.
      stat={summary && summary.tone === 'success' ? <span>{summary.title} ✓</span> : undefined}
      about={
        <p>
          Each row is one check over the whole company — from the database file and every voucher to opening balances, attached files and the
          edit log. Enter on a check shows what it found. If the database itself is damaged, restore a recent backup (Backups, Alt+B).
        </p>
      }
      exportDef={() => ({
        columns: [{ header: 'Check' }, { header: 'Result' }, { header: 'Problems', kind: 'number' }, { header: 'Details' }],
        rows: checks.map((c) => [c.label, c.ok ? 'Passed' : 'Problems found', c.count, c.details.join(' | ')]),
      })}
    >
      <Stack gap={4}>
        {summary && summary.tone !== 'success' ? (
          <Banner tone={summary.tone} title={summary.title}>
            {summary.message}
          </Banner>
        ) : null}
        <DataTable
          aria-label="Data checks"
          autoFocus
          columns={columns}
          rows={checks}
          getRowKey={(c) => c.name}
          selectedKey={current?.name ?? null}
          onSelect={(k) => setSelected(k)}
          onRowActivate={(c) => setSelected(c.name)}
          loading={q.loading}
          virtualize={false}
          empty={<EmptyState size="sm" title="No checks ran" body="Alt+R checks the books again." />}
        />
        {current ? (
          <Panel title={current.label} headingLevel={2}>
            {current.details.length ? (
              <Stack gap={2}>
                <p className="bx-muted">
                  {current.count} problem{current.count === 1 ? '' : 's'}
                  {current.count > current.details.length ? ` — the first ${current.details.length} are listed` : ''}
                </p>
                <ul className="bx-data-details" aria-label={`Problems found by “${current.label}”`}>
                  {current.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </Stack>
            ) : (
              <p className="bx-muted">No problems found.</p>
            )}
          </Panel>
        ) : null}
      </Stack>
    </ReportScreen>
  );
}
