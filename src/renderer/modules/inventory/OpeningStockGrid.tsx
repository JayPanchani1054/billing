/**
 * Opening stock grid of the stock item form: one row per godown / batch with quantity, rate and
 * value (calculated as qty × rate, or typed to override). Enter moves through the cells (the form's
 * useEnterAdvance); with godown or batch columns, Enter on the value of a filled last row adds the
 * next row. Ctrl+Enter adds a row from anywhere in the grid (also the "Add row" button);
 * Ctrl+Delete removes the current row.
 */
import type { KeyboardEvent } from 'react';
import { formatMoney, formatQty, formatRate } from '../../app/index.ts';
import { Button, DateInput, IconButton, NumberInput, QuantityInput, TextInput } from '../../ui/index.ts';
import type { OpeningContext, OpeningDraft, OpeningField } from './lib/opening.ts';
import { editOpening, emptyOpening, isBlankOpening, openingTotals, rowRate, rowValue } from './lib/opening.ts';
import { AmountInput } from '../../ui/index.ts';
import { GodownPicker } from './pickers.tsx';

export interface OpeningStockGridProps {
  rows: readonly OpeningDraft[];
  /** Receives an updater (applied to the latest rows, so a cell commit and Enter never race). */
  onChange: (update: (rows: readonly OpeningDraft[]) => OpeningDraft[]) => void;
  ctx: OpeningContext;
  /** Errors keyed `${index}.${field}`. */
  errors: Record<string, string | undefined>;
  /** Default godown for new rows (Main Location). */
  defaultGodownId: number | null;
  readOnly?: boolean;
  referenceDate: string;
  /** id prefix for cells: `${prefix}${index}-${field}`. */
  idPrefix: string;
}

export function openingCellId(prefix: string, index: number, field: OpeningField): string {
  return `${prefix}${index}-${field}`;
}

export function OpeningStockGrid({ rows, onChange, ctx, errors, defaultGodownId, readOnly = false, referenceDate, idPrefix }: OpeningStockGridProps) {
  const set = (i: number, field: OpeningField, v: number | string | null): void => {
    onChange((list) => list.map((r, k) => (k === i ? editOpening(r, field, v) : r)));
  };
  const addRow = (): void => {
    const index = rows.length;
    onChange((list) => [...list, emptyOpening(list[list.length - 1]?.godownId ?? defaultGodownId)]);
    // Focus the first cell of the new row once rendered.
    const first: OpeningField = ctx.multipleGodowns ? 'godownId' : ctx.batches ? 'batchName' : 'qty';
    window.setTimeout(() => document.getElementById(openingCellId(idPrefix, index, first))?.focus(), 0);
  };
  const removeRow = (i: number): void => {
    onChange((list) => list.filter((_, k) => k !== i));
    // Keep the keyboard in the grid: the row that moved up (or the new last row).
    const next = Math.min(i, rows.length - 2);
    if (next >= 0) window.setTimeout(() => document.getElementById(openingCellId(idPrefix, next, 'qty'))?.focus(), 0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, i: number): void => {
    if (readOnly || e.defaultPrevented) return;
    if (e.key === 'Enter' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      addRow();
    } else if (e.key === 'Delete' && e.ctrlKey && !e.altKey) {
      e.preventDefault();
      removeRow(i);
    } else if (
      e.key === 'Enter' &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      (ctx.multipleGodowns || ctx.batches) &&
      i === rows.length - 1 &&
      !isBlankOpening(rows[i]) &&
      e.target instanceof HTMLElement &&
      e.target.id === openingCellId(idPrefix, i, 'value')
    ) {
      // After the last filled row comes a fresh row for the next godown / batch. Enter on
      // that blank row's cells then runs on to the end of the form (blank rows are not saved).
      e.preventDefault();
      addRow();
    }
  };
  const totals = openingTotals(rows);
  const unit = ctx.unitSymbol;
  const err = (i: number, f: OpeningField): string | undefined => errors[`${i}.${f}`];
  const cellErr = (i: number, f: OpeningField) => {
    const m = err(i, f);
    return m ? (
      <span className="bx-inv-grid__error" id={`${openingCellId(idPrefix, i, f)}-err`}>
        {m}
      </span>
    ) : null;
  };
  const described = (i: number, f: OpeningField): string | undefined => (err(i, f) ? `${openingCellId(idPrefix, i, f)}-err` : undefined);

  return (
    <div className="bx-inv-grid" role="group" aria-label="Opening stock">
      <table className="bx-inv-grid__table">
        <colgroup>
          <col style={{ width: 40 }} />
          {ctx.multipleGodowns ? <col style={{ width: '24%' }} /> : null}
          {ctx.batches ? <col style={{ width: '16%' }} /> : null}
          {ctx.batches && ctx.trackMfgDate ? <col style={{ width: 150 }} /> : null}
          {ctx.batches && ctx.useExpiry ? <col style={{ width: 150 }} /> : null}
          <col />
          <col />
          <col />
          <col style={{ width: 44 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="bx-inv-grid__th" scope="col">
              <span className="bx-sr-only">Row</span>
            </th>
            {ctx.multipleGodowns ? (
              <th className="bx-inv-grid__th" scope="col">
                Godown
              </th>
            ) : null}
            {ctx.batches ? (
              <th className="bx-inv-grid__th" scope="col">
                Batch
              </th>
            ) : null}
            {ctx.batches && ctx.trackMfgDate ? (
              <th className="bx-inv-grid__th" scope="col">
                Mfg date
              </th>
            ) : null}
            {ctx.batches && ctx.useExpiry ? (
              <th className="bx-inv-grid__th" scope="col">
                Expiry
              </th>
            ) : null}
            <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
              Quantity{unit ? ` (${unit})` : ''}
            </th>
            <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
              Rate (₹ per {unit || 'unit'})
            </th>
            <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
              Value (₹)
            </th>
            <th className="bx-inv-grid__th" scope="col">
              <span className="bx-sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const value = rowValue(r);
            const rate = rowRate(r);
            return (
              <tr key={r.key} className="bx-inv-grid__row" onKeyDown={(e) => onKeyDown(e, i)}>
                <td className="bx-inv-grid__td bx-inv-grid__td--index">{i + 1}</td>
                {ctx.multipleGodowns ? (
                  <td className="bx-inv-grid__td">
                    <GodownPicker
                      id={openingCellId(idPrefix, i, 'godownId')}
                      aria-label={`Row ${i + 1} godown`}
                      size="sm"
                      value={r.godownId}
                      onChange={(id) => set(i, 'godownId', id)}
                      invalid={!!err(i, 'godownId')}
                      readOnly={readOnly}
                    />
                    {cellErr(i, 'godownId')}
                  </td>
                ) : null}
                {ctx.batches ? (
                  <td className="bx-inv-grid__td">
                    <TextInput
                      id={openingCellId(idPrefix, i, 'batchName')}
                      aria-label={`Row ${i + 1} batch`}
                      aria-describedby={described(i, 'batchName')}
                      size="sm"
                      value={r.batchName}
                      onChange={(e) => set(i, 'batchName', e.target.value)}
                      maxLength={100}
                      invalid={!!err(i, 'batchName')}
                      readOnly={readOnly}
                    />
                    {cellErr(i, 'batchName')}
                  </td>
                ) : null}
                {ctx.batches && ctx.trackMfgDate ? (
                  <td className="bx-inv-grid__td">
                    <DateInput
                      id={openingCellId(idPrefix, i, 'mfgDate')}
                      aria-label={`Row ${i + 1} manufacturing date`}
                      size="sm"
                      value={r.mfgDate}
                      onChange={(v) => set(i, 'mfgDate', v)}
                      referenceDate={referenceDate}
                      showWeekday={false}
                      readOnly={readOnly}
                    />
                    {cellErr(i, 'mfgDate')}
                  </td>
                ) : null}
                {ctx.batches && ctx.useExpiry ? (
                  <td className="bx-inv-grid__td">
                    <DateInput
                      id={openingCellId(idPrefix, i, 'expiryDate')}
                      aria-label={`Row ${i + 1} expiry date`}
                      aria-describedby={described(i, 'expiryDate')}
                      size="sm"
                      value={r.expiryDate}
                      onChange={(v) => set(i, 'expiryDate', v)}
                      referenceDate={referenceDate}
                      showWeekday={false}
                      invalid={!!err(i, 'expiryDate')}
                      readOnly={readOnly}
                    />
                    {cellErr(i, 'expiryDate')}
                  </td>
                ) : null}
                <td className="bx-inv-grid__td bx-inv-grid__td--num">
                  <QuantityInput
                    id={openingCellId(idPrefix, i, 'qty')}
                    aria-label={`Row ${i + 1} quantity`}
                    aria-describedby={described(i, 'qty')}
                    size="sm"
                    value={r.qty}
                    onChange={(v) => set(i, 'qty', v)}
                    decimals={ctx.unitDecimals}
                    unit={unit}
                    invalid={!!err(i, 'qty')}
                    readOnly={readOnly}
                  />
                  {cellErr(i, 'qty')}
                </td>
                <td className="bx-inv-grid__td bx-inv-grid__td--num">
                  {r.valueOverridden ? (
                    <span className="bx-inv-grid__td--static" title="Worked out from the value you typed">
                      {rate === null ? '—' : formatRate(rate)}
                      <span className="bx-sr-only"> (worked out from the value)</span>
                    </span>
                  ) : null}
                  <NumberInput
                    id={openingCellId(idPrefix, i, 'rate')}
                    aria-label={r.valueOverridden ? `Row ${i + 1} rate — type to recalculate the value` : `Row ${i + 1} rate`}
                    aria-describedby={described(i, 'rate')}
                    size="sm"
                    value={r.valueOverridden ? null : r.rate}
                    onChange={(v) => set(i, 'rate', v)}
                    decimals={4}
                    min={0}
                    placeholder={r.valueOverridden ? 'Type to recalculate' : undefined}
                    invalid={!!err(i, 'rate')}
                    readOnly={readOnly}
                  />
                  {cellErr(i, 'rate')}
                </td>
                <td className="bx-inv-grid__td bx-inv-grid__td--num">
                  <AmountInput
                    id={openingCellId(idPrefix, i, 'value')}
                    aria-label={`Row ${i + 1} value`}
                    aria-describedby={described(i, 'value')}
                    size="sm"
                    value={value}
                    onChange={(v) => {
                      if (v !== value) set(i, 'value', v);
                    }}
                    invalid={!!err(i, 'value')}
                    readOnly={readOnly}
                  />
                  {r.valueOverridden ? <span className="bx-inv-override">Typed value</span> : null}
                  {cellErr(i, 'value')}
                </td>
                <td className="bx-inv-grid__td">
                  {readOnly ? null : (
                    <IconButton icon="trash" size="sm" variant="ghost" aria-label={`Remove row ${i + 1}`} tabIndex={-1} onClick={() => removeRow(i)} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bx-inv-grid__foot">
            <td className="bx-inv-grid__td" colSpan={1 + (ctx.multipleGodowns ? 1 : 0) + (ctx.batches ? 1 : 0) + (ctx.batches && ctx.trackMfgDate ? 1 : 0) + (ctx.batches && ctx.useExpiry ? 1 : 0)}>
              Total
            </td>
            <td className="bx-inv-grid__td bx-inv-grid__td--num">{formatQty(totals.qty, ctx.unitDecimals, unit)}</td>
            <td className="bx-inv-grid__td bx-inv-grid__td--num">{totals.qty > 0 ? formatRate(totals.rate) : ''}</td>
            <td className="bx-inv-grid__td bx-inv-grid__td--num">{formatMoney(totals.value)}</td>
            <td className="bx-inv-grid__td" />
          </tr>
        </tfoot>
      </table>
      {readOnly ? null : (
        <div className="bx-inv-grid__actions" data-enter-ignore="">
          <Button size="sm" variant="ghost" icon="plus" shortcut="Ctrl+Enter" onClick={addRow}>
            Add row
          </Button>
        </div>
      )}
    </div>
  );
}
