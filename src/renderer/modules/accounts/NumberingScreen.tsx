/**
 * 'accounts.numbering' — Invoice Numbering (2.0, docs/ARCHITECTURE.md › Invoice numbering and renumbering): every number series (one per voucher type)
 * on one screen, with a simple editor (SeriesDrawer.tsx). A focused facade over the voucher types: the
 * Voucher Type form keeps every other option (behaviour, defaults, printing).
 *
 *   List: "Invoices & notes" (sales, credit and debit notes — GST documents) first, then "Other vouchers"
 *   (collapsed). Columns (2.1): Series · Next number (formatted, e.g. INV/26-27/0033) · Restarts · Used.
 *   Enter / Alt+A edits the highlighted series · Alt+C creates a series based on it (a new voucher type
 *   with its own numbers, entered with F10) · Alt+H edit history. More ▾ holds Alter (Alt+A), Voucher
 *   Types and Edit history; "Create series" is the one title-row button.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { useBooks, useWorkingDate } from '../../app/working.tsx';
import { Banner, Button, DataTable, EmptyState, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { NameCell } from './components.tsx';
import { BASE_TYPE_LABELS, buildSeriesRows, seriesGroup } from './lib/numbering.ts';
import type { SeriesListRow } from './lib/numbering.ts';
import { SeriesDrawer } from './SeriesDrawer.tsx';
import type { EditorTarget } from './SeriesDrawer.tsx';

/** The two editor uses of this screen (the voucher type form uses the third, 'draft'). */
type ListTarget = Extract<EditorTarget, { kind: 'alter' | 'create' }>;

export function NumberingScreen() {
  const nav = useNav();
  const { fyStartMonth } = useBooks();
  const { date: today } = useWorkingDate();
  const canCreate = useCan('masters.create');
  const canAudit = useCan('audit.view');
  const list = useApiQuery('accounts.voucherType.list', {});
  const types = list.data?.rows ?? [];
  // One status call for every series (staleTime 0: vouchers saved elsewhere move the next numbers).
  const status = useApiQuery('accounts.voucherType.numberingStatus', { date: today }, { enabled: list.data !== undefined, staleTime: 0, keepPrevious: true });
  const rows = useMemo(() => buildSeriesRows(types, status.data ?? [], today, fyStartMonth), [types, status.data, today, fyStartMonth]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['group:gst']));
  const [cursor, setCursor] = useState<string | null>(null);
  const [editor, setEditor] = useState<ListTarget | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  // An alteration opens once the series' status (its next number) is current — a refetch after a voucher
  // saved elsewhere must not leave a stale next number in the editor; later refetches do not reset it.
  const [editorShown, setEditorShown] = useState(false);
  const statusReady = (status.data !== undefined && !status.refreshing) || status.error !== null;
  if (editor && !editorShown && (editor.kind === 'create' || statusReady)) setEditorShown(true);
  const current = rows.find((r): r is Extract<SeriesListRow, { kind: 'series' }> => r.kind === 'series' && r.key === cursor) ?? null;

  const open = (row: SeriesListRow | null) => {
    if (!row) return;
    if (row.kind === 'group') {
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
      return;
    }
    setEditor({ kind: 'alter', type: row.type });
  };
  const createFrom = () => {
    const parent = current?.type ?? types.find((t) => t.isPredefined && t.baseType === 'sales') ?? null;
    if (parent) setEditor({ kind: 'create', parent });
  };
  const closeEditor = (savedId?: number) => {
    setEditor(null);
    setEditorShown(false);
    setEditorDirty(false);
    if (savedId !== undefined && editor) {
      // Show the saved (or just created) series: open its group and highlight it once the list reloads.
      const baseType = editor.kind === 'alter' ? editor.type.baseType : editor.parent.baseType;
      setExpanded((s) => new Set([...s, `group:${seriesGroup(baseType)}`]));
      setCursor(String(savedId));
    }
  };

  const columns = useMemo<Column<SeriesListRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Series',
        render: (r) =>
          r.kind === 'group' ? (
            <span>
              {r.label} <span className="bx-acc-name__alias">({r.count})</span>
            </span>
          ) : (
            <NameCell name={r.type.name} alias={r.type.isPredefined ? null : BASE_TYPE_LABELS[r.type.baseType]} inactive={!r.type.isActive} />
          ),
        value: (r) => (r.kind === 'group' ? r.label : r.type.name),
      },
      // The number the next voucher of the series gets, as printed (status: accounts.voucherType.numberingStatus).
      { key: 'next', header: 'Next number', width: 200, render: (r) => (r.kind === 'series' ? <span className="bx-num">{r.next}</span> : null), value: (r) => (r.kind === 'series' ? r.next : '') },
      { key: 'restarts', header: 'Restarts', width: 190, value: (r) => (r.kind === 'series' ? r.restarts : '') },
      // Vouchers of the series in the current numbering period (this financial year, or month).
      { key: 'vouchers', header: 'Used', kind: 'number', width: 100, blankZero: true, value: (r) => (r.kind === 'series' ? r.vouchers : null) },
    ],
    [],
  );

  return (
    <Screen
      title="Invoice Numbering"
      subtitle={`Numbers as on ${formatDate(today, 'D-MMM-YY')}`}
      dirty={editorDirty}
      loading={list.loading && !list.data}
      error={list.error}
      onRetry={() => void list.refetch()}
      hint="Enter Alter · Alt+C Create series · Alt+H Edit history · Esc Back"
      actions={[
        {
          key: 'Alt+C',
          label: 'Create series',
          icon: 'plus',
          onClick: createFrom,
          hidden: !canCreate,
          hint: 'A new voucher type based on the highlighted one, with its own numbers (entered with F10).',
          prominent: true,
        },
        // Enter does the same on the highlighted row; Alt+A stays registered (More ▾, SPEC-21 §3.1 rule 2b).
        { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => open(current), disabled: !current, hint: current ? undefined : 'Highlight a series first.', demoted: true },
        { key: '', label: 'Voucher Types', onClick: () => nav.push('accounts.voucherTypes'), group: 'more', hint: 'Every voucher type with all its options' },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => current && nav.push('security.audit', { entityType: 'voucher_type', entityId: current.type.id, entityGuid: current.type.guid, label: current.type.name }),
          hidden: !canAudit,
          disabled: !current,
          group: 'more',
        },
      ]}
    >
      <Stack gap={3} grow>
        {status.error ? (
          <Banner tone="warning" inline action={<Button size="sm" onClick={() => void status.refetch()}>Retry</Button>}>
            The next numbers could not be read: {userMessage(status.error)}
          </Banner>
        ) : null}
        <DataTable
          aria-label="Number series"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          getRowLevel={(r) => (r.kind === 'group' ? 0 : 1)}
          isGroupRow={(r) => r.kind === 'group'}
          expandable
          expandedKeys={expanded}
          onExpandedChange={(keys) => setExpanded(keys)}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => open(r)}
          loading={list.loading}
          empty={<EmptyState title="No number series" body="Voucher types carry the number series. Open Voucher Types (More ▾) to check them." />}
        />
      </Stack>
      {editor && editorShown ? (
        <SeriesDrawer
          key={editor.kind === 'alter' ? `alter:${editor.type.id}` : `create:${editor.parent.id}`}
          target={editor}
          types={types}
          status={editor.kind === 'alter' ? ((status.data ?? []).find((s) => s.id === editor.type.id) ?? null) : null}
          today={today}
          fyStartMonth={fyStartMonth}
          onDirtyChange={setEditorDirty}
          onClose={closeEditor}
          onOpenForm={(id) => {
            closeEditor();
            nav.push('accounts.voucherType.form', { id });
          }}
        />
      ) : null}
    </Screen>
  );
}
