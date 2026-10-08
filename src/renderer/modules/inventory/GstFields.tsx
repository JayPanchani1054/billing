/**
 * GST details block shared by the stock group form and the stock item form: own details on/off,
 * taxability, slab, cess, HSN/SAC (with the F12 digits hint), "applicable from" and the dated
 * rate history (a wrongly dated row can be removed).
 */
import { useMemo } from 'react';
import type { GstHistoryRow } from '../../../shared/types/inventory.ts';
import { GST_CORE_RATES_2025, GST_RATES, isRetiredSlabOn } from '../../../shared/gst/index.ts';
import { formatDate, formatMoney, formatPercent } from '../../app/index.ts';
import { AmountInput, Banner, DataTable, DateInput, Field, FieldGroup, IconButton, PercentInput, Select, Stack, Switch, TextInput } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import type { GstDraft } from './lib/gstDraft.ts';
import { OTHER_RATE, patchFromRateSelect, rateSelectGroups, rateSelectValue } from './lib/gstDraft.ts';
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
}

export function GstFields({ value: d, onChange, errors, kind, hsnDigits, noun, existing, changed, history, onDeleteHistory, effectiveText, unitSymbol, referenceDate, idPrefix, savedOwn = false, readOnly = false }: GstFieldsProps) {
  const groups = useMemo(() => rateSelectGroups(GST_CORE_RATES_2025, GST_RATES), []);
  const taxable = d.taxability === 'taxable';
  const selectValue = rateSelectValue(d);
  const retired = d.gstApplicable && taxable && d.gstRate !== null && isRetiredSlabOn(d.gstRate, d.gstApplicableFrom ?? referenceDate);
  const needsDate = existing && history.length > 0 && changed && d.gstApplicable;
  const showDate = d.gstApplicable && existing && (savedOwn || history.length > 0);
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
        hidden: !onDeleteHistory,
        render: (h) => (
          <IconButton icon="trash" size="sm" variant="ghost" aria-label={`Remove the rate from ${formatDate(h.applicableFrom)}`} onClick={() => onDeleteHistory?.(h)} />
        ),
      },
    ],
    [onDeleteHistory],
  );

  return (
    <Stack gap={3}>
      <Field
        label="Set GST details here"
        htmlFor={`${idPrefix}gstApplicable`}
        hint={
          d.gstApplicable
            ? `This ${noun} has its own GST rate. Items under it use this unless they set their own.`
            : (effectiveText ?? `The rate comes from the ${noun === 'stock item' ? 'stock group' : 'parent group'}, or else from the sales/purchase ledger.`)
        }
      >
        <Switch
          id={`${idPrefix}gstApplicable`}
          checked={d.gstApplicable}
          onChange={(v) => onChange({ gstApplicable: v })}
          label={d.gstApplicable ? 'Yes — own GST details' : `No — inherit`}
          disabled={readOnly}
        />
      </Field>
      {existing && !d.gstApplicable && history.length > 0 ? (
        <Banner tone="warning" inline>
          Saving with this off removes the {history.length} dated rate{history.length === 1 ? '' : 's'} below, and the {noun} goes back to the inherited rate.
        </Banner>
      ) : null}
      {d.gstApplicable ? (
        <FieldGroup columns={3}>
          <Field label="Taxability" htmlFor={`${idPrefix}taxability`} hint={TAXABILITY_OPTIONS.find((o) => o.value === d.taxability)?.description}>
            <Select
              id={`${idPrefix}taxability`}
              value={d.taxability}
              onChange={(v) => onChange({ taxability: v })}
              options={TAXABILITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              disabled={readOnly}
            />
          </Field>
          {taxable ? (
            <Field label="GST rate" required htmlFor={`${idPrefix}gstRate`} error={errors.gstRate} hint={retired ? 'This slab was retired for most goods on 22-Sep-2025. Check the rate is still right.' : 'IGST rate; CGST and SGST are half each.'}>
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
          ) : null}
          {taxable && selectValue === OTHER_RATE ? (
            <Field label="Another rate" required htmlFor={`${idPrefix}gstRateOther`} error={errors.gstRate} hint="Only for a rate not in the list (allowed as non-standard).">
              <PercentInput id={`${idPrefix}gstRateOther`} value={d.gstRate} onChange={(v) => onChange({ gstRate: v, allowNonStandardRate: true })} max={100} readOnly={readOnly} />
            </Field>
          ) : null}
          {taxable ? (
            <Field label="Cess" optional htmlFor={`${idPrefix}cessRate`} error={errors.cessRate} hint="Compensation cess % (tobacco, aerated drinks, cars).">
              <PercentInput id={`${idPrefix}cessRate`} value={d.cessRate} onChange={(v) => onChange({ cessRate: v })} max={400} blankZero readOnly={readOnly} />
            </Field>
          ) : null}
          {taxable ? (
            <Field label={`Cess per ${unitSymbol || 'unit'}`} optional htmlFor={`${idPrefix}cessPerUnit`} error={errors.cessPerUnit} hint="Specific cess in rupees per unit, if any.">
              <AmountInput id={`${idPrefix}cessPerUnit`} value={d.cessPerUnit} onChange={(v) => onChange({ cessPerUnit: v })} symbol blankZero readOnly={readOnly} />
            </Field>
          ) : null}
        </FieldGroup>
      ) : null}
      <FieldGroup columns={2}>
        <Field
          label={kind === 'services' ? 'SAC' : kind === 'goods' ? 'HSN code' : 'HSN/SAC'}
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
      </FieldGroup>
      {history.length > 0 ? (
        <Stack gap={1}>
          <p className="bx-inv-note">
            Rate history — invoices use the row in force on their date{onDeleteHistory ? '. Remove a row only if its date was entered by mistake.' : '.'}
          </p>
          <DataTable aria-label="GST rate history" columns={historyColumns} rows={history} getRowKey={(h) => String(h.id)} density="compact" />
        </Stack>
      ) : null}
    </Stack>
  );
}
