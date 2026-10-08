/**
 * Opening bills of a bill-wise ledger: one row per bill outstanding when the books begin, with a
 * live "bills total vs opening balance" check. Enter moves across the cells (the form's
 * useEnterAdvance scope); Alt+N adds a row; the last row is always blank so typing just continues.
 */
import { useRef } from 'react';
import type { Paise } from '../../../shared/money.ts';
import { formatDate } from '../../../shared/dates.ts';
import { AmountInput, Button, DateInput, IconButton, TextInput, useHotkeys } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { checkBills, emptyBill, fillDifference, isBlankBill, newBillKey } from './lib/openingBills.ts';
import type { BillDraft } from './lib/openingBills.ts';

export interface OpeningBillsGridProps {
  bills: readonly BillDraft[];
  onChange: (bills: BillDraft[]) => void;
  opening: Paise;
  booksFrom: string;
  defaultSide: 'dr' | 'cr';
  /** Errors keyed `openingBills[i].<field>` plus `openingBills` for the total. */
  errors: Readonly<Record<string, string>>;
  readOnly?: boolean;
}

export function OpeningBillsGrid({ bills, onChange, opening, booksFrom, defaultSide, errors, readOnly }: OpeningBillsGridProps) {
  // The grid always ends with a blank row so typing just continues; its key is stable until it is used.
  const trailingKey = useRef(newBillKey());
  const synth = bills.length === 0 || !isBlankBill(bills[bills.length - 1]);
  const rows = synth ? [...bills, { ...emptyBill(booksFrom), key: trailingKey.current }] : bills;
  const check = checkBills(opening, rows);
  const set = (i: number, patch: Partial<BillDraft>) => {
    const next = rows.map((b, k) => (k === i ? { ...b, ...patch } : b));
    if (synth && i === rows.length - 1) trailingKey.current = newBillKey();
    onChange(next);
  };
  const remove = (i: number) => onChange(rows.filter((_, k) => k !== i));
  const add = () => onChange([...rows.filter((b) => !isBlankBill(b)), emptyBill(booksFrom)]);
  useHotkeys({ 'Alt+N': readOnly ? undefined : () => add() }, [rows, readOnly]);
  const err = (i: number, f: string): string | undefined => errors[`openingBills[${i}].${f}`];

  return (
    <div className="bx-acc-fill" data-testid="opening-bills">
      <div className="bx-acc-grid-wrap">
        <table className="bx-acc-grid" aria-label="Opening bills">
          <thead>
            <tr>
              <th className="bx-acc-grid__index" scope="col">
                #
              </th>
              <th scope="col">Bill no.</th>
              <th scope="col">Bill date</th>
              <th scope="col">Due date</th>
              <th scope="col" className="is-num">
                Amount outstanding
              </th>
              <th scope="col" className="bx-acc-grid__actions">
                <span className="bx-sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => {
              const last = i === rows.length - 1 && isBlankBill(b);
              return (
                <tr key={b.key}>
                  <td className="bx-acc-grid__index">{i + 1}</td>
                  <td>
                    <TextInput
                      size="sm"
                      value={b.billName}
                      onChange={(e) => set(i, { billName: e.target.value })}
                      aria-label={`Bill ${i + 1} number`}
                      placeholder={last ? 'New bill' : undefined}
                      invalid={!!err(i, 'billName')}
                      readOnly={readOnly}
                      maxLength={50}
                    />
                    {err(i, 'billName') ? <span className="bx-acc-grid__error">{err(i, 'billName')}</span> : null}
                  </td>
                  <td>
                    <DateInput
                      size="sm"
                      value={b.billDate}
                      onChange={(v) => set(i, { billDate: v })}
                      referenceDate={booksFrom}
                      maxDate={booksFrom}
                      aria-label={`Bill ${i + 1} date`}
                      invalid={!!err(i, 'billDate')}
                      readOnly={readOnly}
                    />
                    {err(i, 'billDate') ? <span className="bx-acc-grid__error">{err(i, 'billDate')}</span> : null}
                  </td>
                  <td>
                    <DateInput
                      size="sm"
                      value={b.dueDate}
                      onChange={(v) => set(i, { dueDate: v })}
                      referenceDate={b.billDate ?? booksFrom}
                      aria-label={`Bill ${i + 1} due date`}
                      invalid={!!err(i, 'dueDate')}
                      readOnly={readOnly}
                    />
                    {err(i, 'dueDate') ? <span className="bx-acc-grid__error">{err(i, 'dueDate')}</span> : null}
                  </td>
                  <td>
                    <AmountInput
                      size="sm"
                      drcr
                      defaultSide={defaultSide}
                      value={b.amount}
                      onChange={(v) => set(i, { amount: v })}
                      aria-label={`Bill ${i + 1} amount`}
                      invalid={!!err(i, 'amount')}
                      readOnly={readOnly}
                    />
                    {err(i, 'amount') ? <span className="bx-acc-grid__error">{err(i, 'amount')}</span> : null}
                  </td>
                  <td className="bx-acc-grid__actions">
                    {!last && !readOnly ? <IconButton icon="trash" size="sm" aria-label={`Remove bill ${i + 1}`} tabIndex={-1} onClick={() => remove(i)} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={cx('bx-acc-check', check.balanced ? 'is-ok' : 'is-off')} role="status" aria-live="polite">
        <span>{errors.openingBills ?? check.message}</span>
        {!check.balanced && !readOnly ? (
          <Button size="sm" variant="ghost" icon="calculator" onClick={() => onChange(fillDifference(rows, opening, booksFrom))}>
            Put the difference in a bill
          </Button>
        ) : null}
        {!readOnly ? (
          <Button size="sm" variant="ghost" icon="plus" shortcut="Alt+N" onClick={add}>
            Add bill
          </Button>
        ) : null}
      </div>
      <span className="bx-muted">Bills outstanding on {formatDate(booksFrom)}, when the books begin. Press D or C in an amount to switch Dr/Cr — an advance is on the other side.</span>
    </div>
  );
}
