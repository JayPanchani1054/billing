/**
 * List screen for the tree masters (stock groups, stock categories, godowns): tree view with
 * expand/collapse, type-to-search (flat results), Enter alters, Alt+C creates (under the selected
 * row with Alt+Shift+C), Alt+D (or Ctrl+D) deletes, Alt+E export, Alt+P print.
 */
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ReportScreen, useCan, useConfirm, useNav, userMessage } from '../../app/index.ts';
import type { ExportCell, ExportColumn, ScreenActionItem } from '../../app/index.ts';
import { Button, DataTable, EmptyState, Field, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column, IconName } from '../../ui/index.ts';
import type { Leveled } from './lib/tree.ts';
import { orderTree } from './lib/tree.ts';
import './inventory.css';

export interface TreeMasterRow {
  id: number;
  parentId: number | null;
  name: string;
  alias: string | null;
}

export interface TreeMasterListProps<T extends TreeMasterRow> {
  title: string;
  /** 'stock group' — used in messages. */
  noun: string;
  icon: IconName;
  rows: readonly T[] | undefined;
  loading: boolean;
  refreshing?: boolean;
  error: unknown;
  onRetry: () => void;
  /** Columns after the Name column. */
  columns: readonly Column<Leveled<T>>[];
  exportColumns: readonly ExportColumn[];
  exportRow: (r: T) => readonly ExportCell[];
  formScreen: string;
  /** Delete one row (throws ApiError). */
  onDelete: (r: T) => Promise<void>;
  /** Why a row cannot be deleted (null: it can). */
  deleteBlocked?: (r: T) => string | null;
  emptyTitle: string;
  emptyBody: string;
  /** More rail actions for the selected row (null when none is selected). */
  extraActions?: (current: T | null) => readonly ScreenActionItem[];
  /** Shown above the table. */
  notice?: ReactNode;
  subtitle?: ReactNode;
}

export function TreeMasterList<T extends TreeMasterRow>(props: TreeMasterListProps<T>) {
  const { title, noun, icon, rows, loading, refreshing, error, onRetry, columns, exportColumns, exportRow, formScreen, onDelete, deleteBlocked, emptyTitle, emptyBody, extraActions, notice, subtitle } = props;
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const q = useDebouncedValue(search.trim().toLowerCase(), 120);
  const tree = useMemo(() => orderTree(rows ?? []), [rows]);
  const shown = useMemo(
    () => (q ? tree.filter((r) => r.name.toLowerCase().includes(q) || (r.alias ?? '').toLowerCase().includes(q)).map((r) => ({ ...r, level: 0, hasChildren: false })) : tree),
    [tree, q],
  );
  const current = shown.find((r) => String(r.id) === selected) ?? null;

  const allColumns = useMemo<Column<Leveled<T>>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        tree: true,
        render: (r) => (
          <span className="bx-inv-pick">
            <span className="bx-inv-pick__name">{r.name}</span>
            {r.alias ? <span className="bx-inv-pick__meta">{r.alias}</span> : null}
          </span>
        ),
        title: (r) => (r.alias ? `${r.name} (${r.alias})` : r.name),
      },
      ...columns,
    ],
    [columns],
  );

  const remove = async (r: T | null): Promise<void> => {
    if (!r || busy) return;
    const blocked = deleteBlocked?.(r) ?? null;
    if (blocked) {
      toast.info(`“${r.name}” cannot be deleted`, { message: blocked });
      return;
    }
    const ok = await confirm({ title: `Delete ${noun} “${r.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    setBusy(true);
    try {
      await onDelete(r);
      toast.success(`${noun[0].toUpperCase()}${noun.slice(1)} “${r.name}” deleted`);
      const i = shown.findIndex((x) => x.id === r.id);
      const next = shown[i + 1] ?? shown[i - 1];
      setSelected(next ? String(next.id) : undefined);
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const create = (parentId?: number): void => {
    nav.push(formScreen, { ...(search.trim() ? { initialName: search.trim() } : {}), ...(parentId !== undefined ? { parentId } : {}) });
  };

  return (
    <ReportScreen
      title={title}
      subtitle={subtitle}
      periodMode="none"
      loading={loading}
      refreshing={refreshing}
      error={error}
      onRetry={onRetry}
      hint={`Type to Search · Enter Alter · Alt+C Create ${noun.replace(/\b\w/g, (c) => c.toUpperCase())} · Alt+D Delete · →/← Expand/Collapse`}
      actions={[
        { key: 'Alt+C', label: `Create ${noun}`, icon: 'plus', primary: true, onClick: () => create(), hidden: !canCreate },
        { key: 'Alt+Shift+C', label: 'Create under selected', icon: 'plus', onClick: () => create(current?.id), hidden: !canCreate, disabled: !current },
        ...(extraActions?.(current) ?? []),
        {
          key: 'Alt+D, Ctrl+D',
          label: 'Delete',
          icon: 'trash',
          onClick: () => void remove(current),
          hidden: !canDelete,
          disabled: !current || busy,
          hint: current ? (deleteBlocked?.(current) ?? undefined) : undefined,
          group: 'danger',
        },
      ]}
      filters={
        <Field label="Search" hideLabel>
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leadingIcon="search"
            placeholder={`Search ${noun}s`}
            aria-label={`Search ${noun}s`}
            data-autofocus=""
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                gridRef.current?.focus();
              }
            }}
          />
        </Field>
      }
      exportDef={() => ({ columns: exportColumns, rows: tree.map((r) => exportRow(r)), levels: tree.map((r) => r.level) })}
    >
      {notice}
      <DataTable
        aria-label={title}
        gridRef={gridRef}
        columns={allColumns}
        rows={shown}
        getRowKey={(r) => String(r.id)}
        getRowLevel={q ? undefined : (r) => r.level}
        expandable={!q}
        defaultExpanded="all"
        selectedKey={selected}
        onSelect={(k) => setSelected(k ?? undefined)}
        onRowActivate={(r) => nav.push(formScreen, { id: r.id })}
        loading={loading}
        empty={
          q ? (
            <EmptyState icon="search" title={`No ${noun}s match “${search.trim()}”`} body="Change the search, or press Alt+C to create it." />
          ) : (
            <EmptyState
              icon={icon}
              title={emptyTitle}
              body={emptyBody}
              action={
                canCreate ? (
                  <Button variant="primary" icon="plus" shortcut="Alt+C" onClick={() => create()}>
                    Create {noun}
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
    </ReportScreen>
  );
}
