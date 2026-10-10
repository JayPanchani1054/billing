/**
 * Voucher register table shared by the Day Book and the generic voucher list.
 *
 * Enter / double-click opens the voucher for alteration; Alt+Enter opens the read-only view
 * (also for cancelled vouchers and users who may not alter); Alt+A alters, Ctrl+P prints (Alt+P
 * prints the register itself), Alt+2 duplicates and Alt+D deletes the highlighted voucher.
 */
import { useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useApiMutation, useCan, useConfirm, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem } from '../../app/index.ts';
import { Badge, DataTable, useToast } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { dayBookTotals, keyAfterRemoval, openTarget } from './lib/daybook.ts';
import type { DayBookRow } from './lib/daybook.ts';
import { VOUCHER_INVALIDATES } from './entry/VoucherEntryScreen.tsx';

export interface VoucherTableState {
  selectedKey: string | null;
  setSelectedKey: (k: string | null) => void;
  /** Rail actions acting on the highlighted voucher. */
  actions: ScreenActionItem[];
  open: (r: DayBookRow) => void;
  view: (r: DayBookRow) => void;
}

/** Selection + row actions (alter / view / delete / duplicate) for a voucher table. */
export function useVoucherTable(rows: readonly DayBookRow[]): VoucherTableState {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canAlter = useCan('vouchers.alter');
  const canCreate = useCan('vouchers.create');
  const canDelete = useCan('vouchers.delete');
  const del = useApiMutation('vouchers.delete', { invalidates: VOUCHER_INVALIDATES });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = rows.find((r) => String(r.id) === selectedKey) ?? null;

  const view = (r: DayBookRow) => nav.push('vouchers.view', { id: r.id });
  // Enter alters; cancelled vouchers, generated e-invoices and users who may not alter get the view.
  const open = (r: DayBookRow) => nav.push(openTarget(r, canAlter), { id: r.id });
  const remove = async (r: DayBookRow) => {
    if (r.irnGenerated) {
      toast.info('This voucher cannot be deleted', { message: 'Its e-invoice (IRN) has been generated. Open it (Alt+Enter) and cancel it instead.' });
      return;
    }
    const ok = await confirm({
      title: `Delete ${r.typeName} ${r.number}?`.replace(/\s+\?/, '?'),
      message: 'The voucher and its GST entries are removed from the books. To keep a record of it instead, open it and cancel it (Alt+X).',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    const nextKey = keyAfterRemoval(rows, r.id);
    try {
      await del.mutate({ id: r.id });
      setSelectedKey(nextKey);
      toast.success(`${r.typeName} ${r.number} deleted`.replace(/\s+/g, ' '));
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };
  const actions: ScreenActionItem[] = [
    { key: 'Alt+Enter', label: 'View', icon: 'eye', onClick: () => selected && view(selected), disabled: !selected, group: 'row' },
    {
      key: 'Alt+A',
      label: 'Alter',
      icon: 'edit',
      onClick: () => selected && nav.push('vouchers.entry', { id: selected.id }),
      disabled: !selected || openTarget(selected, canAlter) !== 'vouchers.entry',
      hint: selected && (selected.isCancelled || selected.irnGenerated) ? 'A cancelled voucher, or one with an e-invoice, can only be viewed (Alt+Enter).' : undefined,
      hidden: !canAlter,
      group: 'row',
    },
    { key: 'Ctrl+P', label: 'Print voucher', icon: 'print', onClick: () => selected && nav.push('print.voucher', { id: selected.id }), disabled: !selected, hidden: !nav.isRegistered('print.voucher'), group: 'row' },
    { key: 'Alt+2', label: 'Duplicate', icon: 'copy', onClick: () => selected && nav.push('vouchers.entry', { duplicateOf: selected.id }), disabled: !selected, hidden: !canCreate, group: 'row' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => selected && void remove(selected), disabled: !selected || del.pending, hidden: !canDelete, group: 'danger' },
  ];
  return { selectedKey, setSelectedKey, actions, open, view };
}

export interface VoucherTableProps {
  rows: readonly DayBookRow[];
  state: VoucherTableState;
  loading: boolean;
  empty: ReactNode;
  label: string;
  /** Extra footer note (e.g. "showing the first 1,000"). */
  showTotals?: boolean;
}

export function VoucherTable({ rows, state, loading, empty, label, showTotals = true }: VoucherTableProps) {
  const columns = useMemo<Column<DayBookRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      {
        key: 'particulars',
        header: 'Particulars',
        sortable: true,
        render: (r) => (
          <span className={r.isCancelled ? 'bx-vch-list__name is-cancelled' : 'bx-vch-list__name'}>
            <span className="bx-truncate">{r.particulars || <span className="bx-muted">—</span>}</span>
            {r.flags.map((f) => (
              <Badge key={f} size="sm" tone={f === 'Cancelled' ? 'danger' : f === 'Optional' ? 'warning' : 'info'}>
                {f}
              </Badge>
            ))}
          </span>
        ),
      },
      { key: 'typeName', header: 'Vch Type', width: 150, sortable: true },
      { key: 'number', header: 'Vch No.', width: 130, sortable: true },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true },
    ],
    [],
  );
  const totals = useMemo(() => dayBookTotals(rows), [rows]);
  const footerRows = useMemo<FooterRow[]>(
    () => (showTotals && rows.length > 0 ? [{ key: 'total', cells: { particulars: 'Total (optional and cancelled vouchers not counted)', debit: totals.debit, credit: totals.credit } }] : []),
    [showTotals, rows.length, totals],
  );
  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLTableElement>, r: DayBookRow | null) => {
    if (r && e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      state.view(r);
    }
  };
  return (
    <DataTable<DayBookRow>
      aria-label={label}
      autoFocus
      columns={columns}
      rows={rows}
      getRowKey={(r) => String(r.id)}
      loading={loading}
      selectedKey={state.selectedKey}
      onSelect={(k) => state.setSelectedKey(k)}
      onRowActivate={(r) => state.open(r)}
      onRowKeyDown={onRowKeyDown}
      getRowClassName={(r) => (r.isCancelled || r.isOptional ? 'bx-vch-list__row is-muted' : undefined)}
      footerRows={footerRows}
      empty={empty}
    />
  );
}
