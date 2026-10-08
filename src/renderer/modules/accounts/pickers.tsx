/**
 * Reusable masters pickers (public API of the accounts module — keep stable; see README.md):
 *
 *   <LedgerPicker value={ledgerId} onChange={(id, row) => …} classes={['party']} asOf={date} showBalance allowCreate />
 *   const { rows, byId, loading } = useLedgerPicker({ classes: ['bank'] });
 *   <GroupPicker value={groupId} onChange={(id, row) => …} allowCreate />
 *
 * Both are type-ahead Pickers (ui/Combobox): Enter selects, Tab selects and moves on, Alt+C opens
 * the master form with the typed text (create-and-return) and selects the new master.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { formatDrCr } from '../../../shared/format.ts';
import type { GroupRow, LedgerClassName, LedgerPickerInput, LedgerPickerRow } from '../../../shared/types/accounts.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { useCan } from '../../app/state.tsx';
import { Picker } from '../../ui/index.ts';
import type { ControlSize } from '../../ui/index.ts';

// ───────────────────────────── Ledgers ─────────────────────────────

export interface UseLedgerPickerOptions {
  /** Ledgers matching ANY of these classes (e.g. ['party'], ['cash_bank'], ['sales']). */
  classes?: readonly LedgerClassName[];
  /** Only ledgers in these groups (and their sub-groups). */
  groupIds?: readonly number[];
  /** Balance date (default today). */
  asOf?: string;
  /** Include inactive ledgers (they cannot be used in new vouchers). Default false. */
  includeInactive?: boolean;
  /** false = don't load yet. */
  enabled?: boolean;
}

export interface UseLedgerPickerResult {
  rows: readonly LedgerPickerRow[];
  byId: ReadonlyMap<number, LedgerPickerRow>;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

const EMPTY_ROWS: readonly LedgerPickerRow[] = [];

/** Cached ledger list for pickers (accounts.ledger.picker). Refetches after any accounts mutation. */
export function useLedgerPicker(options: UseLedgerPickerOptions = {}): UseLedgerPickerResult {
  const input = useMemo<LedgerPickerInput>(() => {
    const i: LedgerPickerInput = {};
    if (options.classes && options.classes.length > 0) i.classes = [...options.classes];
    if (options.groupIds && options.groupIds.length > 0) i.groupIds = [...options.groupIds];
    if (options.asOf) i.asOf = options.asOf;
    if (options.includeInactive) i.includeInactive = true;
    return i;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(options.classes ?? []).join(','), (options.groupIds ?? []).join(','), options.asOf, options.includeInactive]);
  const q = useApiQuery('accounts.ledger.picker', input, { keepPrevious: true, enabled: options.enabled !== false });
  const rows = q.data ?? EMPTY_ROWS;
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const refetch = useCallback(() => void q.refetch(), [q]);
  return { rows, byId, loading: q.loading, error: q.error, refetch };
}

export interface LedgerPickerProps extends UseLedgerPickerOptions {
  /** Selected ledger id. */
  value: number | null;
  onChange: (id: number | null, row: LedgerPickerRow | null) => void;
  /** Enter on a selection: the key is consumed — move focus yourself. Omit to let Enter advance the form. */
  onCommit?: (id: number | null, row: LedgerPickerRow | null) => void;
  /** Show the closing balance (Dr/Cr) on the right of each row. Default true. */
  showBalance?: boolean;
  /** Offer "+ Create" / Alt+C (opens accounts.ledger.form for a result). Default true when the user may create masters. */
  allowCreate?: boolean;
  /** Group the list by ledger group. Default true. */
  groupByGroup?: boolean;
  /** Ledger ids that may not be chosen (e.g. the ledger being edited). */
  excludeIds?: readonly number[];
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  size?: ControlSize;
  emptyText?: ReactNode;
  id?: string;
  'aria-label'?: string;
  ref?: Ref<HTMLInputElement>;
}

/** Placeholder row for a ledger just created (until the list refetches). */
function pendingRow(id: number, name: string): LedgerPickerRow {
  return { id, name, alias: null, groupId: 0, groupName: '', classes: [], balance: 0, gstin: null, stateCode: null, registrationType: null, billWise: false, isActive: true };
}

export function LedgerPicker(props: LedgerPickerProps) {
  const { value, onChange, onCommit, showBalance = true, groupByGroup = true, excludeIds, placeholder, disabled, readOnly, invalid, required, autoFocus, size, emptyText, id, ref } = props;
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const allowCreate = (props.allowCreate ?? true) && canCreate;
  const { rows, byId } = useLedgerPicker(props);
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  const items = useMemo(() => {
    if (!excludeIds || excludeIds.length === 0) return rows;
    const ex = new Set(excludeIds);
    return rows.filter((r) => !ex.has(r.id));
  }, [rows, excludeIds]);
  const selected = value === null ? null : (byId.get(value) ?? (created && created.id === value ? pendingRow(created.id, created.name) : null));

  const create = async (typed: string) => {
    const out = await nav.pushForResult<{ id: number; name: string }>('accounts.ledger.form', { initialName: typed.trim(), forResult: true });
    if (!out) return;
    setCreated(out);
    onChange(out.id, byId.get(out.id) ?? null);
  };

  return (
    <Picker<LedgerPickerRow>
      ref={ref}
      id={id}
      aria-label={props['aria-label']}
      items={items}
      getKey={(l) => String(l.id)}
      getLabel={(l) => l.name}
      getAlias={(l) => l.alias}
      getKeywords={(l) => [l.gstin ?? '', l.groupName]}
      groupBy={groupByGroup ? (l) => l.groupName : undefined}
      rightMeta={showBalance ? (l) => <span className="bx-num">{formatDrCr(l.balance) || '—'}</span> : undefined}
      isItemDisabled={(l) => !l.isActive}
      value={selected}
      onChange={(l) => onChange(l?.id ?? null, l)}
      onCommit={onCommit ? (l) => onCommit(l?.id ?? null, l) : undefined}
      onCreate={allowCreate ? (q) => void create(q) : undefined}
      createLabel={(q) => (q.trim() ? `Create ledger “${q.trim()}”` : 'Create a new ledger')}
      placeholder={placeholder ?? 'Type a ledger name, alias or GSTIN'}
      disabled={disabled}
      readOnly={readOnly}
      invalid={invalid}
      required={required}
      autoFocus={autoFocus}
      size={size}
      emptyText={emptyText ?? (allowCreate ? 'No ledger matches — press Alt+C to create it' : 'No ledger matches')}
    />
  );
}

// ───────────────────────────── Groups ─────────────────────────────

const EMPTY_GROUPS: readonly GroupRow[] = [];

/** All groups in tree order (accounts.group.list), with an id map. */
export function useGroups(options: { includeCounts?: boolean; enabled?: boolean } = {}): {
  rows: readonly GroupRow[];
  byId: ReadonlyMap<number, GroupRow>;
  loading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const q = useApiQuery('accounts.group.list', options.includeCounts ? { includeCounts: true } : {}, { keepPrevious: true, enabled: options.enabled !== false });
  const rows = q.data?.rows ?? EMPTY_GROUPS;
  const byId = useMemo(() => new Map(rows.map((g) => [g.id, g])), [rows]);
  const refetch = useCallback(() => void q.refetch(), [q]);
  return { rows, byId, loading: q.loading, error: q.error, refetch };
}

export interface GroupPickerProps {
  value: number | null;
  onChange: (id: number | null, row: GroupRow | null) => void;
  onCommit?: (id: number | null, row: GroupRow | null) => void;
  /** Offer "+ Create" / Alt+C (opens accounts.group.form for a result). Default true when allowed. */
  allowCreate?: boolean;
  /** Hide this group and its sub-groups (a group cannot be moved under itself). */
  excludeSubtreeOf?: number | null;
  /** Show only groups under these reserved codes' trees (e.g. ['SUNDRY_DEBTORS']). */
  filter?: (g: GroupRow) => boolean;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  size?: ControlSize;
  id?: string;
  'aria-label'?: string;
  ref?: Ref<HTMLInputElement>;
}

function pendingGroup(id: number, name: string): GroupRow {
  return {
    id,
    guid: '',
    name,
    alias: null,
    parentId: null,
    parentName: null,
    depth: 0,
    path: [name],
    primaryGroupId: id,
    primaryCode: null,
    nature: 'assets',
    affectsGrossProfit: false,
    reservedCode: null,
    isPredefined: false,
    isSubledger: false,
    netBalances: false,
    usedForCalculation: false,
    sortOrder: 0,
    childCount: 0,
  };
}

/** Breadcrumb of a group's parents ("Current Assets › Sundry Debtors"). */
export function groupTrail(g: Pick<GroupRow, 'path'>): string {
  return g.path.slice(0, -1).join(' › ');
}

export function GroupPicker(props: GroupPickerProps) {
  const { value, onChange, onCommit, excludeSubtreeOf, filter, placeholder, disabled, readOnly, invalid, required, autoFocus, size, id, ref } = props;
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const allowCreate = (props.allowCreate ?? true) && canCreate;
  const { rows, byId } = useGroups();
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  const items = useMemo(() => {
    let list = rows;
    if (excludeSubtreeOf !== null && excludeSubtreeOf !== undefined) {
      const self = byId.get(excludeSubtreeOf);
      if (self) list = list.filter((g) => !(g.id === self.id || (g.path.length > self.path.length && isUnder(g, self.id, byId))));
    }
    return filter ? list.filter(filter) : list;
  }, [rows, byId, excludeSubtreeOf, filter]);
  const selected = value === null ? null : (byId.get(value) ?? (created && created.id === value ? pendingGroup(created.id, created.name) : null));

  const create = async (typed: string) => {
    const out = await nav.pushForResult<{ id: number; name: string }>('accounts.group.form', { initialName: typed.trim(), forResult: true });
    if (!out) return;
    setCreated(out);
    onChange(out.id, byId.get(out.id) ?? null);
  };

  return (
    <Picker<GroupRow>
      ref={ref}
      id={id}
      aria-label={props['aria-label']}
      items={items}
      getKey={(g) => String(g.id)}
      getLabel={(g) => g.name}
      getAlias={(g) => g.alias}
      getKeywords={(g) => g.path}
      rightMeta={(g) => <span className="bx-muted">{groupTrail(g) || 'Primary'}</span>}
      value={selected}
      onChange={(g) => onChange(g?.id ?? null, g)}
      onCommit={onCommit ? (g) => onCommit(g?.id ?? null, g) : undefined}
      onCreate={allowCreate ? (q) => void create(q) : undefined}
      createLabel={(q) => (q.trim() ? `Create group “${q.trim()}”` : 'Create a new group')}
      placeholder={placeholder ?? 'Type a group, e.g. Sundry Debtors'}
      disabled={disabled}
      readOnly={readOnly}
      invalid={invalid}
      required={required}
      autoFocus={autoFocus}
      size={size}
      maxVisible={10}
      emptyText={allowCreate ? 'No group matches — press Alt+C to create it' : 'No group matches'}
    />
  );
}

function isUnder(g: GroupRow, ancestorId: number, byId: ReadonlyMap<number, GroupRow>): boolean {
  let cur: GroupRow | undefined = g;
  const seen = new Set<number>();
  while (cur && cur.parentId !== null && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}
