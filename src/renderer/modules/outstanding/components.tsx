/**
 * Shared pieces of the outstanding screens: layout fillers, overdue days and credit-limit use as plain
 * text, the context run's danger word, party/group pickers and print/PDF output of ready HTML documents.
 */
import { useMemo } from 'react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { todayLocal } from '../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../shared/format.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import type { OutstandingSide } from '../../../shared/types/outstanding.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { native } from '../../app/bridge.ts';
import { showInFolder } from '../../app/export.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useCan } from '../../app/state.tsx';
import { Picker, Select, Spacer, useToast } from '../../ui/index.ts';
import type { SelectOption } from '../../ui/index.ts';
import { daysText, isLate } from './lib/charts.ts';
import { utilisationTone } from './lib/model.ts';

// ───────────────────────────── Layout ─────────────────────────────

const FILL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };

/** Takes the remaining height of a report body (geometry only) so a DataTable inside can scroll. */
export function Fill({ children }: { children: ReactNode }) {
  return <div style={FILL_STYLE}>{children}</div>;
}

/** Vertical gap between direct children of a report body. */
export function VGap() {
  return <Spacer size={3} axis="vertical" />;
}

// ───────────────────────────── Cells ─────────────────────────────

/**
 * Overdue days as plain text — "190 d" (2.1, D25: no pills). Danger text only beyond the last ageing
 * period (`limits`, default 30/60/90/180); `notDueText` for a bill that is not yet due.
 */
export function OverdueDays({ days, notDueText = '', limits = DEFAULT_AGEING_BUCKETS }: { days: number; notDueText?: string; limits?: readonly number[] }) {
  if (days <= 0) return notDueText ? <span className="bx-muted">{notDueText}</span> : null;
  return <span className={isLate(days, limits) ? 'bx-os-danger' : undefined}>{daysText(days)}</span>;
}

/** Credit-limit use as plain text ("64%"); danger text above the limit; "No limit" muted. */
export function LimitUsed({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="bx-muted">No limit</span>;
  return <span className={utilisationTone(percent) === 'danger' ? 'bx-os-danger' : undefined}>{`${Math.round(percent)}%`}</span>;
}

/** The context run's one danger word ("3 over credit limit"). */
export function DangerWord({ children }: { children: ReactNode }) {
  return <span className="bx-os-danger">{children}</span>;
}

// ───────────────────────────── Pickers ─────────────────────────────

export interface PartyOption {
  id: number;
  name: string;
  groupName: string;
  side: OutstandingSide;
  /** Ledger-signed balance (Dr +). */
  balance: number;
}

/**
 * Debtors and creditors (and bill-wise ledgers in the outstanding scope) for party pickers, from
 * 'outstanding.partySummary' — needs only reports.view.
 */
export function usePartyOptions(asOf: string, enabled = true): { options: PartyOption[]; loading: boolean } {
  const rec = useApiQuery('outstanding.partySummary', { side: 'receivable', asOf, includeZero: true }, { staleTime: 60_000, enabled });
  const pay = useApiQuery('outstanding.partySummary', { side: 'payable', asOf, includeZero: true }, { staleTime: 60_000, enabled });
  const options = useMemo(() => {
    const out = new Map<number, PartyOption>();
    for (const r of rec.data?.rows ?? []) out.set(r.ledgerId, { id: r.ledgerId, name: r.ledgerName, groupName: r.groupName, side: 'receivable', balance: r.pending });
    for (const r of pay.data?.rows ?? []) if (!out.has(r.ledgerId)) out.set(r.ledgerId, { id: r.ledgerId, name: r.ledgerName, groupName: r.groupName, side: 'payable', balance: -r.pending });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' }));
  }, [rec.data, pay.data]);
  return { options, loading: rec.loading || pay.loading };
}

export function PartyPicker({
  options,
  value,
  onChange,
  autoFocus,
  placeholder = 'Type a party name',
  inputRef,
  onCommit,
}: {
  options: readonly PartyOption[];
  value: number | null;
  onChange: (id: number | null) => void;
  autoFocus?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Enter on a party (after it is chosen): move on, e.g. to the next field. Without it Enter stays put. */
  onCommit?: (id: number) => void;
}) {
  const selected = options.find((o) => o.id === value) ?? null;
  return (
    <Picker<PartyOption>
      items={options}
      getKey={(o) => String(o.id)}
      getLabel={(o) => o.name}
      getKeywords={(o) => [o.groupName]}
      groupBy={(o) => o.groupName}
      rightMeta={(o) => formatDrCr(o.balance)}
      value={selected}
      onChange={(o) => onChange(o ? o.id : null)}
      onCommit={onCommit ? (o) => o && onCommit(o.id) : undefined}
      placeholder={placeholder}
      autoFocus={autoFocus}
      emptyText="No party by that name"
      clearable={false}
      ref={inputRef}
    />
  );
}

/**
 * Groups under Sundry Debtors / Sundry Creditors (incl. the group itself) for a group filter.
 * Empty when the user may not list groups (masters.view) — the filter is then hidden.
 */
export function useGroupOptions(side: OutstandingSide | 'both'): SelectOption[] {
  // Listing groups needs masters.view; without it the filter is simply hidden (no refused request).
  const canList = useCan('masters.view');
  const q = useApiQuery('accounts.group.list', {}, { staleTime: 5 * 60_000, enabled: canList });
  return useMemo(() => {
    const rows = q.data?.rows ?? [];
    const roots = rows.filter((g) => (side !== 'payable' && g.reservedCode === 'SUNDRY_DEBTORS') || (side !== 'receivable' && g.reservedCode === 'SUNDRY_CREDITORS'));
    const keep = new Set(roots.map((g) => g.id));
    // Parents come before children in the list; repeat until no new descendant is found (cheap: few hundred groups).
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of rows) {
        if (g.parentId !== null && keep.has(g.parentId) && !keep.has(g.id)) {
          keep.add(g.id);
          grew = true;
        }
      }
    }
    return rows.filter((g) => keep.has(g.id)).map((g) => ({ value: String(g.id), label: `${'  '.repeat(Math.max(0, g.depth - 1))}${g.name}` }));
  }, [q.data, side]);
}

export function GroupSelect({ options, value, onChange, allLabel }: { options: readonly SelectOption[]; value: number | undefined; onChange: (id: number | undefined) => void; allLabel: string }) {
  if (options.length <= 1) return null;
  return (
    <Select
      aria-label="Group"
      size="sm"
      options={[{ value: '', label: allLabel }, ...options]}
      value={value === undefined ? '' : String(value)}
      onChange={(v) => onChange(v === '' ? undefined : Number(v))}
    />
  );
}

// ───────────────────────────── Print / PDF of ready HTML ─────────────────────────────

/** print / PDF / clipboard actions with toasts (errors explained, "Show in folder" after saving). */
export function useDocumentOutput() {
  const toast = useToast();
  return useMemo(
    () => ({
      print: async (html: string): Promise<void> => {
        try {
          await native('print.print', { html });
        } catch (err) {
          toast.error('Could not print', { message: userMessage(err) });
        }
      },
      pdf: async (html: string, defaultName: string): Promise<void> => {
        try {
          const saved = await native('print.savePdf', { html, defaultName, pageSize: 'A4' });
          if (saved) {
            const name = saved.path.split(/[\\/]/).pop() ?? saved.path;
            toast.success(`Saved ${name}`, { action: { label: 'Show in folder', onClick: () => showInFolder(saved.path) } });
          }
        } catch (err) {
          toast.error('Could not save the PDF', { message: userMessage(err) });
        }
      },
      copy: async (text: string, what: string): Promise<void> => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(`${what} copied`, { message: 'Paste it into WhatsApp, e-mail or any document.' });
        } catch {
          toast.error('Could not copy to the clipboard', { message: 'Allow clipboard access for Pevqori, or print / save the letter as PDF instead.' });
        }
      },
    }),
    [toast],
  );
}

/** Today for "Printed on" footers. */
export const printedOn = (): string => todayLocal();
