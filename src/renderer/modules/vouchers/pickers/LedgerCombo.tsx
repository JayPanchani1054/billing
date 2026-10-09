/**
 * Ledger picker of the voucher screen (UI kit Combobox over 'accounts.ledger.picker').
 *
 *   <LedgerCombo rows={ledgers.rows} slot="party" baseType="sales" value={id} onChange={…} onRefetch={ledgers.refetch} />
 *
 * `rows` is the screen's one cached list; the slot narrows it (ledgerAllowed). Alt+C opens
 * 'accounts.ledger.form' for a result with the typed name under the group that fits the slot
 * (createGroupCode: customer / supplier / sales / purchase / bank) and selects the ledger it returns —
 * unless the user moved it to a group this slot refuses, which is explained instead (the save would fail).
 */
import { memo, useMemo, useState } from 'react';
import type { Ref } from 'react';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDrCr } from '../../../../shared/format.ts';
import type { LedgerPickerRow } from '../../../../shared/types/accounts.ts';
import { api, useCan, useNav } from '../../../app/index.ts';
import { Combobox, useToast } from '../../../ui/index.ts';
import type { ControlSize } from '../../../ui/index.ts';
import { createdLedgerProblem, createGroupCode, ledgerAllowed, slotNoun } from '../lib/masters.ts';
import type { LedgerSlot } from '../lib/masters.ts';

export interface LedgerComboProps {
  rows: readonly LedgerPickerRow[];
  slot: LedgerSlot;
  baseType: VoucherBaseType;
  direction?: 'outward' | 'inward';
  value: number | null;
  onChange: (id: number | null, row: LedgerPickerRow | null) => void;
  /** Enter on a choice: consumed — the caller moves focus. Omit to let Enter advance the form. */
  onCommit?: (id: number | null, row: LedgerPickerRow | null) => void;
  /** Called after a ledger was created with Alt+C (refetch the list). */
  onRefetch?: () => void;
  /** Ledgers not offered (e.g. the party itself on an invoice line). */
  excludeIds?: readonly number[];
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  invalid?: boolean;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  size?: ControlSize;
  showBalance?: boolean;
  /** Open the list when focused (default true). Grids pass false on empty rows so Enter leaves the grid. */
  openOnFocus?: boolean;
  ref?: Ref<HTMLInputElement>;
}

function pendingRow(id: number, name: string): LedgerPickerRow {
  return { id, name, alias: null, groupId: 0, groupName: '', classes: [], balance: 0, gstin: null, stateCode: null, registrationType: null, billWise: false, isActive: true };
}

/** Filtered list per (rows, slot, base type, direction): shared by every row using the same slot. */
const filterCache = new WeakMap<readonly LedgerPickerRow[], Map<string, readonly LedgerPickerRow[]>>();
function rowsFor(rows: readonly LedgerPickerRow[], slot: LedgerSlot, baseType: VoucherBaseType, direction: 'outward' | 'inward'): readonly LedgerPickerRow[] {
  let byKey = filterCache.get(rows);
  if (!byKey) {
    byKey = new Map();
    filterCache.set(rows, byKey);
  }
  const k = `${slot}:${baseType}:${direction}`;
  let out = byKey.get(k);
  if (!out) {
    out = rows.filter((r) => ledgerAllowed(slot, baseType, r.classes, direction));
    byKey.set(k, out);
  }
  return out;
}

export const LedgerCombo = memo(function LedgerCombo(props: LedgerComboProps) {
  const { rows, slot, baseType, direction = 'outward', value, onChange, onCommit, onRefetch, excludeIds, showBalance = true, size, ref } = props;
  const nav = useNav();
  const toast = useToast();
  const canCreate = useCan('masters.create');
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  const base = rowsFor(rows, slot, baseType, direction);
  const exclude = (excludeIds ?? []).join(',');
  const items = useMemo(() => {
    if (!exclude) return base;
    const ex = new Set(exclude.split(',').map(Number));
    return base.filter((r) => !ex.has(r.id));
  }, [base, exclude]);
  const selected = useMemo(() => {
    if (value === null) return null;
    const found = rows.find((r) => r.id === value);
    if (found) return found;
    return created && created.id === value ? pendingRow(created.id, created.name) : pendingRow(value, '…');
  }, [rows, value, created]);

  const create = async (typed: string) => {
    const groupCode = createGroupCode(slot, baseType, direction);
    const out = await nav.pushForResult<{ id: number; name: string }>('accounts.ledger.form', { initialName: typed.trim(), forResult: true, ...(groupCode ? { groupCode } : {}) });
    if (!out) return;
    onRefetch?.();
    // The form lets the user change the group: only select a ledger this place accepts.
    try {
      const detail = await api('accounts.ledger.get', { id: out.id });
      const problem = createdLedgerProblem(detail, slot, baseType, direction);
      if (problem) {
        toast.error('This ledger cannot be used here', { message: problem });
        return;
      }
    } catch {
      // Could not read it back: select it anyway — the save explains a wrong ledger.
    }
    setCreated(out);
    const row = rows.find((r) => r.id === out.id) ?? pendingRow(out.id, out.name);
    onChange(out.id, row);
  };

  const noun = slotNoun(slot, baseType);
  return (
    <Combobox<LedgerPickerRow>
      ref={ref}
      id={props.id}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      items={items}
      getKey={(l) => String(l.id)}
      getLabel={(l) => l.name}
      getAlias={(l) => l.alias}
      getKeywords={(l) => [l.gstin ?? '', l.groupName]}
      groupBy={(l) => l.groupName}
      rightMeta={showBalance ? (l) => <span className="bx-num">{formatDrCr(l.balance) || '—'}</span> : undefined}
      value={selected}
      onChange={(l) => onChange(l?.id ?? null, l)}
      onCommit={onCommit ? (l) => onCommit(l?.id ?? null, l) : undefined}
      onCreate={canCreate ? (q) => void create(q) : undefined}
      createLabel={(q) => (q.trim() ? `Create ledger “${q.trim()}”` : 'Create a new ledger')}
      placeholder={props.placeholder ?? `Type a ${noun} name`}
      emptyText={canCreate ? `No ${noun} matches — press Alt+C to create it` : `No ${noun} matches`}
      invalid={props.invalid}
      required={props.required}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      size={size}
      openOnFocus={props.openOnFocus}
      listMinWidth={360}
    />
  );
});
