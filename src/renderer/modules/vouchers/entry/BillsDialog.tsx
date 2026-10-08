/**
 * Bill-wise allocation (Tally "Bill-wise Details"): split one party entry into New Ref / Agst Ref /
 * Advance / On Account lines, with the party's pending bills alongside and FIFO auto-allocation.
 *
 * Keys: Enter next field · Alt+F oldest bills first · Alt+N add line · Ctrl+D remove line ·
 * Ctrl+A accept · Esc cancel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, diffDays, formatDate } from '../../../../shared/dates.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import { BILL_REF_TYPES } from '../../../../shared/types/vouchers.ts';
import type { BillAllocationInput, BillRefType, PendingBill } from '../../../../shared/types/vouchers.ts';
import { formatDrCr, useApiQuery } from '../../../app/index.ts';
import { AmountInput, Banner, Button, Combobox, DateInput, EmptyState, Hotkeys, IconButton, Modal, Select, TextInput, useEnterAdvance } from '../../../ui/index.ts';
import { allocationRemaining, autoAllocateFifo, checkAllocations, defaultAllocation, fifoOrder, REF_TYPE_LABEL, settleableBills } from '../lib/bills.ts';

export interface BillsDialogProps {
  ledgerId: number;
  ledgerName: string;
  /** Entry amount (magnitude) to allocate. */
  amount: Paise;
  /** Side of the entry: a Cr entry settles Dr (receivable) bills and vice versa. */
  side: 'dr' | 'cr';
  date: string;
  excludeVoucherId: number | null;
  initial: readonly BillAllocationInput[] | null;
  /** Name suggested for a New Ref (the voucher / supplier invoice number). */
  suggestedName: string;
  creditDays: number | null;
  /** Invoice party: offer "Use default" (null = the server's New Ref named after the voucher). */
  allowDefault?: boolean;
  onAccept: (bills: BillAllocationInput[] | null) => void;
  onClose: () => void;
}

interface Line extends BillAllocationInput {
  k: number;
}

const REF_OPTIONS = BILL_REF_TYPES.map((t) => ({ value: t, label: REF_TYPE_LABEL[t] }));

export function BillsDialog(props: BillsDialogProps) {
  const { ledgerId, ledgerName, amount, side, date, excludeVoucherId, initial, suggestedName, creditDays, allowDefault, onAccept, onClose } = props;
  const input = excludeVoucherId === null ? { ledgerId, asOf: date } : { ledgerId, asOf: date, excludeVoucherId };
  const pendingQ = useApiQuery('vouchers.pendingBills', input);
  const pending = useMemo(() => fifoOrder(pendingQ.data ?? []), [pendingQ.data]);
  const settleable = useMemo(() => settleableBills(pending, side), [pending, side]);
  const seq = useRef(1000);
  const fresh = !initial || initial.length === 0;
  const [lines, setLines] = useState<Line[]>(() => {
    const src = fresh ? defaultAllocation({ pending: [], amount, side, date, suggestedName, creditDays, invoiceParty: !!allowDefault }) : initial;
    return src.map((b, i) => ({ ...b, k: i }));
  });
  // Tally: a receipt / payment against a party with pending bills starts as "Agst Ref" on the oldest
  // bills. The bills arrive after the dialog opens: apply that default once, unless the user has typed.
  const edited = useRef(false);
  const defaulted = useRef(false);
  useEffect(() => {
    if (!fresh || defaulted.current || edited.current || !pendingQ.data) return;
    defaulted.current = true;
    const src = defaultAllocation({ pending: pendingQ.data, amount, side, date, suggestedName, creditDays, invoiceParty: !!allowDefault });
    setLines(src.map((b) => ({ ...b, k: nextK() })));
    // Runs once, when the pending bills arrive.
  }, [pendingQ.data]);
  const nextK = () => {
    seq.current += 1;
    return seq.current;
  };
  const issues = checkAllocations(lines, amount);
  const remaining = allocationRemaining(lines, amount);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => accept() });

  const patch = (k: number, p: Partial<BillAllocationInput>) => {
    edited.current = true;
    setLines((ls) => ls.map((l) => (l.k === k ? { ...l, ...p } : l)));
  };
  const remove = (k: number) => {
    edited.current = true;
    setLines((ls) => ls.filter((l) => l.k !== k));
  };
  /** Ctrl+D: remove the line the cursor is on. */
  const removeFocused = () => {
    const tr = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-bill-line]');
    const k = tr ? Number(tr.dataset.billLine) : NaN;
    if (Number.isFinite(k)) remove(k);
  };
  const addLine = (b?: Partial<BillAllocationInput>) => {
    edited.current = true;
    const left = Math.max(0, allocationRemaining(lines, amount));
    setLines((ls) => [...ls, { k: nextK(), refType: 'against', billName: '', amount: left, ...b }]);
  };
  const fifo = () => {
    edited.current = true;
    const out = autoAllocateFifo(pending, amount, side, { remainder: 'on_account' });
    setLines(out.map((b) => ({ ...b, k: nextK() })));
  };
  const takeBill = (b: PendingBill) => {
    const left = Math.max(0, allocationRemaining(lines, amount));
    addLine({ refType: 'against', billName: b.billName, amount: Math.min(Math.abs(b.amount), left || Math.abs(b.amount)) });
  };
  const accept = () => {
    if (issues.length > 0) return;
    onAccept(
      lines.map(({ k: _k, ...b }) => {
        const out: BillAllocationInput = { refType: b.refType, amount: b.amount };
        if (b.refType !== 'on_account' && b.billName) out.billName = b.billName.trim();
        if (b.refType === 'new' || b.refType === 'advance') {
          if (b.creditDays !== undefined && b.creditDays !== null) out.creditDays = b.creditDays;
          if (b.dueDate) out.dueDate = b.dueDate;
        }
        return out;
      }),
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Bill-wise details — ${ledgerName}`}
      description={`Allocate ₹ ${formatMoney(amount)} ${side === 'dr' ? 'Dr' : 'Cr'} to bills. Settle a pending bill with Agst Ref, start a bill with New Ref, or keep it On Account.`}
      footerStart={
        <span className="bx-vch-bills__remaining" aria-live="polite">
          {remaining === 0 ? 'Fully allocated' : remaining > 0 ? `Still to allocate: ₹ ${formatMoney(remaining)}` : `Over-allocated by ₹ ${formatMoney(-remaining)}`}
        </span>
      }
      footer={
        <>
          {allowDefault ? (
            <Button variant="ghost" onClick={() => onAccept(null)}>
              Use default
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={issues.length > 0} onClick={accept}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => accept(), 'Alt+F': () => fifo(), 'Alt+N': () => addLine(), 'Ctrl+D': () => removeFocused() }} />
      <div className="bx-vch-bills">
        <div className="bx-vch-bills__lines" ref={formRef}>
          <table className="bx-vch-mini" aria-label="Bill allocations">
            <thead>
              <tr>
                <th scope="col">Type of ref</th>
                <th scope="col">Bill name</th>
                <th scope="col">Due date</th>
                <th scope="col" className="is-num">
                  Amount
                </th>
                <th scope="col">
                  <span className="bx-sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.k} data-bill-line={l.k}>
                  <td>
                    <Select<BillRefType> aria-label="Type of reference" size="sm" options={REF_OPTIONS} value={l.refType} onChange={(v) => patch(l.k, { refType: v, billName: v === 'on_account' ? undefined : l.billName })} />
                  </td>
                  <td>
                    {l.refType === 'against' ? (
                      <Combobox<PendingBill>
                        aria-label="Pending bill"
                        size="sm"
                        items={settleable}
                        getKey={(b) => b.billName}
                        getLabel={(b) => b.billName}
                        rightMeta={(b) => <span className="bx-num">{formatDrCr(b.amount)}</span>}
                        value={settleable.find((b) => b.billName === l.billName) ?? null}
                        onChange={(b) => patch(l.k, { billName: b?.billName ?? '', amount: b && !l.amount ? Math.abs(b.amount) : l.amount })}
                        placeholder="Choose a pending bill"
                        emptyText="No pending bill on this side"
                      />
                    ) : l.refType === 'on_account' ? (
                      <span className="bx-muted">—</span>
                    ) : (
                      <TextInput aria-label="Bill name" size="sm" value={l.billName ?? ''} maxLength={50} onValueChange={(v) => patch(l.k, { billName: v })} />
                    )}
                  </td>
                  <td>
                    {l.refType === 'new' || l.refType === 'advance' ? (
                      <DateInput
                        aria-label="Due date"
                        size="sm"
                        value={l.dueDate ?? null}
                        referenceDate={date}
                        minDate={date}
                        onChange={(d) => patch(l.k, { dueDate: d ?? undefined, creditDays: undefined })}
                      />
                    ) : (
                      <span className="bx-muted">—</span>
                    )}
                  </td>
                  <td className="is-num">
                    <AmountInput aria-label="Amount" size="sm" value={l.amount || null} onChange={(v) => patch(l.k, { amount: v ?? 0 })} />
                  </td>
                  <td>
                    <IconButton icon="trash" size="sm" aria-label="Remove this line" tabIndex={-1} onClick={() => remove(l.k)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bx-vch-bills__actions">
            <Button size="sm" icon="plus" shortcut="Alt+N" onClick={() => addLine()}>
              Add line
            </Button>
            <Button size="sm" icon="zap" shortcut="Alt+F" disabled={settleable.length === 0} onClick={fifo}>
              Settle oldest bills first
            </Button>
          </div>
          {issues.length > 0 && lines.length > 0 ? (
            <Banner tone="warning" inline>
              {issues[0].message}
            </Banner>
          ) : null}
        </div>
        <aside className="bx-vch-bills__pending" aria-label="Pending bills">
          <h3 className="bx-vch-side__title">Pending bills</h3>
          {pendingQ.loading ? (
            <p className="bx-muted">Loading…</p>
          ) : pending.length === 0 ? (
            <EmptyState size="sm" icon="receipt" title="No pending bills" body="Nothing is outstanding for this ledger on the voucher date." />
          ) : (
            <ul className="bx-vch-bills__list">
              {pending.map((b) => {
                const usable = settleable.includes(b);
                const overdue = b.dueDate !== null && b.dueDate < date;
                return (
                  <li key={b.billName}>
                    <button type="button" className="bx-vch-bills__bill" disabled={!usable} onClick={() => takeBill(b)} title={usable ? 'Settle this bill (Agst Ref)' : 'On the same side as this entry — cannot be settled by it'}>
                      <span className="bx-vch-bills__name">{b.billName}</span>
                      <span className="bx-muted">
                        {formatDate(b.billDate, 'D-MMM-YY')}
                        {b.dueDate ? ` · due ${formatDate(b.dueDate, 'D-MMM-YY')}` : ''}
                        {overdue ? ` · ${diffDays(b.dueDate as string, date)} days overdue` : ''}
                      </span>
                      <span className="bx-num">{formatDrCr(b.amount)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {creditDays ? <p className="bx-muted bx-vch-bills__note">Default credit period: {creditDays} days (due {formatDate(addDays(date, creditDays), 'D-MMM-YY')}).</p> : null}
        </aside>
      </div>
    </Modal>
  );
}
