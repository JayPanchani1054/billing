/**
 * GST details block shared by the stock group form and the stock item form: own details on/off,
 * taxability, slab, cess, HSN/SAC (with the F12 digits hint), "applicable from" and the dated
 * rate history (a wrongly dated row can be removed).
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { GstHistoryRow } from '../../../shared/types/inventory.ts';
import { GST_CORE_RATES_2025, GST_RATES, isRetiredSlabOn } from '../../../shared/gst/index.ts';
import { formatDate, formatMoney, formatPercent } from '../../app/index.ts';
import { AmountInput, Banner, DataTable, DateInput, Field, FieldGroup, IconButton, PercentInput, Select, Stack, Switch, TextInput } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import type { GstDraft } from './lib/gstDraft.ts';
import { OTHER_RATE, patchFromRateSelect, rateSelectGroups, rateSelectValue, showApplicableFrom } from './lib/gstDraft.ts';
import { hsnHint, TAXABILITY_OPTIONS, taxabilityLabel } from './lib/itemForm.ts';

export interface GstFieldsProps {
  value: GstDraft;
  onChange: (patch: Partial<GstDraft>) => void;
  errors: Record<string, string | undefined>;
  /** 'goods' / 'services' for an item; null for a stock group. */
  kind: 'goods' | 'services' | null;
  /** F12 › GST › HSN digits. */
  hsnDigits: number;
  /** 'item' or 'group' — used in the plain-language texts. */
  noun: 'stock item' | 'stock group';
  /** Existing master (shows "applicable from" and the history). */
  existing: boolean;
  /** The details differ from what is saved (show "applicable from" prominently). */
  changed: boolean;
  history: readonly GstHistoryRow[];
  /** Remove one dated history row (only when the user may alter masters). */
  onDeleteHistory?: (row: GstHistoryRow) => void;
  /** Where the GST comes from today (shown under the switch). */
  effectiveText?: string;
  /** Unit symbol for "cess per unit". */
  unitSymbol?: string;
  /** Working date (for date shorthand and the retired-slab note). */
  referenceDate: string;
  /** Element id prefix for focusing invalid fields ('inv-item-'). */
  idPrefix: string;
  /**
   * The saved master already carries its own GST details. Only then can a date keep the old
   * details for earlier dates; for a new or inheriting master the details apply to every date
   * (history cannot say "inherit until"), so no date is asked.
   */
  savedOwn?: boolean;
  /** View only (no permission to change the master). */
  readOnly?: boolean;
  /**
   * (2.1) Which rows to draw: 'all' (default — the stock group dialog), 'essentials' (the switch, the
   * rate, HSN/SAC and "Applicable from" — the stock item's Essentials) or 'details' (taxability, cess
   * and the rate history — behind the item's "More details").
   */
  part?: 'all' | 'essentials' | 'details';
  /** (2.1) 'inline' draws one "Label : value" row per field (master forms); 'stack' (default) groups them. */
  layout?: 'stack' | 'inline';
}

export function GstFields({
  value: d,
  onChange,
  errors,
  kind,
  hsnDigits,
  noun,
  existing,
  changed,
  history,
  onDeleteHistory,
  effectiveText,
  unitSymbol,
  referenceDate,
  idPrefix,
  savedOwn = false,
  readOnly = false,
  part = 'all',
  layout = 'stack',
}: GstFieldsProps) {
  const groups = useMemo(() => rateSelectGroups(GST_CORE_RATES_2025, GST_RATES), []);
  const taxable = d.taxability === 'taxable';
  const selectValue = rateSelectValue(d);
  const retired = d.gstApplicable && taxable && d.gstRate !== null && isRetiredSlabOn(d.gstRate, d.gstApplicableFrom ?? referenceDate);
  const needsDate = existing && history.length > 0 && changed && d.gstApplicable;
  // The item's Essentials show the date only while it can matter (a change, a date or an error).
  const showDate = showApplicableFrom({
    gstApplicable: d.gstApplicable,
    existing,
    savedOwn,
    historyCount: history.length,
    changed,
    value: d.gstApplicableFrom,
    error: errors.gstApplicableFrom,
    onlyWhenNeeded: part === 'essentials',
  });
  const inline = layout === 'inline';
  const fl = inline ? ('inline' as const) : undefined;
  /** Inline rows stand alone in the form's column; stacked fields share a grid row. */
  const row = (columns: 1 | 2 | 3, children: ReactNode) => (inline ? <>{children}</> : <FieldGroup columns={columns}>{children}</FieldGroup>);
  const historyColumns = useMemo<Column<GstHistoryRow>[]>(
    () => [
      { key: 'applicableFrom', header: 'From', kind: 'date', width: 120 },
      {
        key: 'rate',
        header: 'GST',
        render: (h) => (h.taxability === 'taxable' ? formatPercent(h.rate) : taxabilityLabel(h.taxability)),
        width: 110,
      },
      {
        key: 'cess',
        header: 'Cess',
        render: (h) => [h.cessRate ? formatPercent(h.cessRate) : '', h.cessPerUnit ? `₹${formatMoney(h.cessPerUnit)}/unit` : ''].filter(Boolean).join(' + ') || '—',
        width: 140,
      },
      { key: 'hsnSac', header: 'HSN/SAC', render: (h) => h.hsnSac ?? '—' },
      {
        key: 'remove',
        header: '',
        headerLabel: 'Remove',
        width: 52,
        hidden: !onDeleteHistory || readOnly,
        render: (h) => (
          <IconButton icon="trash" size="sm" variant="ghost" aria-label={`Remove the rate from ${formatDate(h.applicableFrom)}`} onClick={() => onDeleteHistory?.(h)} />
        ),
      },
    ],
    [onDeleteHistory, readOnly],
  );

  const switchField = (
    <Field
      label="Set GST details here"
      layout={fl}
      htmlFor={`${idPrefix}gstApplicable`}
      // Where the rate comes from while inheriting is a fact about this master: always shown.
      hintApplies={!d.gstApplicable && effectiveText !== undefined}
      hint={
        d.gstApplicable
          ? `This ${noun} has its own GST rate. Items under it use this unless they set their own.`
          : (effectiveText ?? `The rate comes from the ${noun === 'stock item' ? 'stock group' : 'parent group'}, or else from the sales/purchase ledger.`)
      }
    >
      <Switch id={`${idPrefix}gstApplicable`} checked={d.gstApplicable} onChange={(v) => onChange({ gstApplicable: v })} label={d.gstApplicable ? 'Yes — own GST details' : `No — inherit`} disabled={readOnly} />
    </Field>
  );
  const dropsHistory =
    existing && !d.gstApplicable && history.length > 0 ? (
      <Banner tone="warning" inline>
        Saving with this off removes the {history.length} dated rate{history.length === 1 ? '' : 's'} of its GST rate history, and the {noun} goes back to the inherited rate.
      </Banner>
    ) : null;
  const taxabilityField = (
    <Field label="Taxability" layout={fl} htmlFor={`${idPrefix}taxability`} hint={TAXABILITY_OPTIONS.find((o) => o.value === d.taxability)?.description}>
      <Select id={`${idPrefix}taxability`} value={d.taxability} onChange={(v) => onChange({ taxability: v })} options={TAXABILITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} disabled={readOnly} />
    </Field>
  );
  const rateFields = (
    <>
      <Field
        label="GST rate"
        layout={fl}
        required
        htmlFor={`${idPrefix}gstRate`}
        error={errors.gstRate}
        hintApplies={retired}
        hint={retired ? 'This slab was retired for most goods on 22-Sep-2025. Check the rate is still right.' : 'IGST rate; CGST and SGST are half each.'}
      >
        <Select
          id={`${idPrefix}gstRate`}
          value={selectValue}
          onChange={(v) => onChange(patchFromRateSelect(v))}
          options={groups}
          placeholder="Choose rate"
          invalid={!!errors.gstRate && selectValue !== OTHER_RATE}
          disabled={readOnly}
        />
      </Field>
      {selectValue === OTHER_RATE ? (
        <Field label="Another rate" layout={fl} required htmlFor={`${idPrefix}gstRateOther`} error={errors.gstRate} hint="Only for a rate not in the list (allowed as non-standard).">
          <PercentInput id={`${idPrefix}gstRateOther`} value={d.gstRate} onChange={(v) => onChange({ gstRate: v, allowNonStandardRate: true })} max={100} readOnly={readOnly} />
        </Field>
      ) : null}
    </>
  );
  const cessFields = (
    <>
      <Field label="Cess" layout={fl} optional htmlFor={`${idPrefix}cessRate`} error={errors.cessRate} hint="Compensation cess % (tobacco, aerated drinks, cars).">
        <PercentInput id={`${idPrefix}cessRate`} value={d.cessRate} onChange={(v) => onChange({ cessRate: v })} max={400} blankZero readOnly={readOnly} />
      </Field>
      <Field label={`Cess per ${unitSymbol || 'unit'}`} layout={fl} optional htmlFor={`${idPrefix}cessPerUnit`} error={errors.cessPerUnit} hint="Specific cess in rupees per unit, if any.">
        <AmountInput id={`${idPrefix}cessPerUnit`} value={d.cessPerUnit} onChange={(v) => onChange({ cessPerUnit: v })} symbol blankZero readOnly={readOnly} />
      </Field>
    </>
  );
  const hsnAndDate = (
    <>
      <Field
        label={kind === 'services' ? 'SAC' : kind === 'goods' ? 'HSN code' : 'HSN/SAC'}
        layout={fl}
        optional
        htmlFor={`${idPrefix}hsnSac`}
        error={errors.hsnSac}
        hint={kind === null ? `For items under this group that have none. ${hsnHint(hsnDigits, false)}` : hsnHint(hsnDigits, kind === 'services')}
      >
        <TextInput id={`${idPrefix}hsnSac`} value={d.hsnSac} onChange={(e) => onChange({ hsnSac: e.target.value.replace(/[^0-9 ]/g, '') })} inputMode="numeric" maxLength={11} mono readOnly={readOnly} />
      </Field>
      {showDate ? (
        <Field
          label="Applicable from"
          layout={fl}
          required={needsDate}
          optional={!needsDate}
          htmlFor={`${idPrefix}gstApplicableFrom`}
          error={errors.gstApplicableFrom}
          hint={
            needsDate
              ? 'From which date the new GST details apply. Earlier invoices keep the earlier rate.'
              : 'Give a date to keep the old rate for earlier dates (rate change). Leave blank to correct a mistake.'
          }
        >
          <DateInput id={`${idPrefix}gstApplicableFrom`} value={d.gstApplicableFrom} onChange={(v) => onChange({ gstApplicableFrom: v })} referenceDate={referenceDate} readOnly={readOnly} />
        </Field>
      ) : null}
    </>
  );
  const historyTable =
    history.length > 0 ? (
      <Stack gap={1}>
        <p className="bx-inv-note">
          Rate history — invoices use the row in force on their date
          {onDeleteHistory && !readOnly ? '. Remove a row (select it and press Delete) only if its date was entered by mistake.' : '.'}
        </p>
        <DataTable
          aria-label="GST rate history"
          columns={historyColumns}
          rows={history}
          getRowKey={(h) => String(h.id)}
          density="compact"
          onRowKeyDown={(e, row) => {
            // Keyboard path to the row's remove button (the grid is one Tab stop).
            if (e.key === 'Delete' && !e.ctrlKey && !e.altKey && row && onDeleteHistory && !readOnly) {
              e.preventDefault();
              onDeleteHistory(row);
            }
          }}
        />
      </Stack>
    ) : null;

  if (part === 'essentials') {
    return (
      <>
        {switchField}
        {dropsHistory}
        {d.gstApplicable && taxable ? rateFields : null}
        {hsnAndDate}
      </>
    );
  }
  if (part === 'details') {
    return (
      <>
        {d.gstApplicable ? taxabilityField : null}
        {d.gstApplicable && taxable ? cessFields : null}
        {historyTable}
      </>
    );
  }
  return (
    <Stack gap={3}>
      {switchField}
      {dropsHistory}
      {d.gstApplicable
        ? row(
            3,
            <>
              {taxabilityField}
              {taxable ? rateFields : null}
              {taxable ? cessFields : null}
            </>,
          )
        : null}
      {row(2, hsnAndDate)}
      {historyTable}
    </Stack>
  );
}
