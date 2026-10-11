/**
 * 'accounts.ledger.form' — Ledger Creation / Alteration, a single keyboard-first page.
 * Params: { id? (alter) | initialName? (create), groupId? | groupCode? (create under a group, by id or by
 * reserved code such as 'SUNDRY_DEBTORS' / 'BANK_ACCOUNTS'), forResult? }.
 *
 * 2.1 (SPEC-21 §1.8, D23): one flat column of inline fields. The Essentials of the group's class are on
 * screen (lib/ledgerEssentials.ts: Name, Under, Opening balance; + GSTIN, PAN, State, Address, Mobile
 * for parties; + account number and IFSC for banks; + type of duty for tax ledgers; + GST rate and HSN
 * for sales / purchase ledgers); everything else sits behind the "More details" line (Ctrl+I, Alt+F1 —
 * remembered per computer profile), which opens by itself when a field inside holds a value or an error.
 * Enter moves field to field (collapsed fields are skipped); Enter on the last field or Ctrl+A saves. Create = "Save & create next"
 * (rapid entry, keeps the group); opened for a result = "Save & return" (nav.pop({ id, name }));
 * alter = save and close. Alt+D deletes (the server explains why a ledger cannot be deleted), Alt+H shows
 * the ledger's edit history.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GroupCode, GstDutyHead, GstTaxDirection } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr } from '../../../shared/format.ts';
import { GST_RATES } from '../../../shared/gst/rates.ts';
import type { AppropriateBy, GroupRow, IncludeInAssessable, ItcEligibility, LedgerClass, LedgerDetail, LedgerTaxType } from '../../../shared/types/accounts.ts';
import type { RegistrationType, SupplyKind, Taxability } from '../../../shared/types/gst.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav, useScreenResult } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReadOnlyNotice, Screen } from '../../app/Screen.tsx';
import { setMoreDetailsOpen, useUiPrefs } from '../../app/preferences.ts';
import { useCan, useCompany } from '../../app/state.tsx';
import { useBooks, useWorkingDate } from '../../app/working.tsx';
import {
  AmountInput,
  Banner,
  Button,
  DataTable,
  DateInput,
  DisclosureLine,
  Field,
  NumberInput,
  PercentInput,
  Select,
  Switch,
  TextArea,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { focusFirstInvalid, OkHint, StatePicker } from './components.tsx';
import { LEDGER_DEPENDENTS, useDeleteLedger } from './hooks.ts';
import { classOfGroup, groupIsUnder, indexGroups, initialGroupId, ledgerCreateSubtitle } from './lib/groupClass.ts';
import { applyGstin, gstinOkText, NO_GSTIN, REGISTRATION_OPTIONS } from './lib/gstin.ts';
import { applyGroupDefaults, buildSaveInput, draftFromDetail, emptyLedgerDraft, gstHistoryEffect, isDraftDirty, validateLedgerDraft } from './lib/ledgerDraft.ts';
import type { LedgerDraft } from './lib/ledgerDraft.ts';
import { essentialFields, LEDGER_FORM_KIND, moreDetailGroups, moreDetailsRevealed, moreDetailsSummary } from './lib/ledgerEssentials.ts';
import type { LedgerField } from './lib/ledgerEssentials.ts';
import { defaultOpeningSide, ledgerSections } from './lib/ledgerSections.ts';
import { remapBillErrors } from './lib/openingBills.ts';
import { OpeningBillsGrid } from './OpeningBillsGrid.tsx';
import { GroupPicker, useGroups } from './pickers.tsx';
import { AttachmentsRailAction } from '../attachments/AttachmentsScreens.tsx';

export interface LedgerFormParams {
  id?: number;
  initialName?: string;
  groupId?: number;
  /** Reserved code of the group to create under ('SUNDRY_DEBTORS', 'BANK_ACCOUNTS', …) when the caller has no id. */
  groupCode?: GroupCode;
  forResult?: boolean;
}

export function LedgerFormScreen({ params }: ScreenProps<LedgerFormParams>) {
  const isAlter = typeof params.id === 'number';
  const existing = useApiQuery('accounts.ledger.get', { id: params.id ?? 0 }, { enabled: isAlter });
  const groups = useGroups();
  const title = isAlter ? 'Ledger Alteration' : 'Ledger Creation';
  if ((isAlter && !existing.data) || (groups.rows.length === 0 && (groups.loading || groups.error))) {
    return (
      <Screen
        title={title}
        width="form"
        loading={existing.loading || groups.loading}
        error={existing.error ?? groups.error}
        onRetry={() => {
          void existing.refetch();
          groups.refetch();
        }}
      />
    );
  }
  return <LedgerForm key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'} original={existing.data ?? null} params={params} groups={groups.rows} />;
}

// ───────────────────────────── Option lists ─────────────────────────────

const TAXABILITY_OPTIONS: ReadonlyArray<{ value: Taxability; label: string }> = [
  { value: 'taxable', label: 'Taxable' },
  { value: 'exempt', label: 'Exempt' },
  { value: 'nil_rated', label: 'Nil rated' },
  { value: 'non_gst', label: 'Non-GST' },
];
const SUPPLY_OPTIONS: ReadonlyArray<{ value: SupplyKind | ''; label: string }> = [
  { value: '', label: 'Work out from HSN/SAC' },
  { value: 'goods', label: 'Goods' },
  { value: 'services', label: 'Services' },
];
const ITC_OPTIONS: ReadonlyArray<{ value: ItcEligibility | ''; label: string }> = [
  { value: '', label: 'Not specified' },
  { value: 'inputs', label: 'Inputs' },
  { value: 'capital_goods', label: 'Capital goods' },
  { value: 'input_services', label: 'Input services' },
  { value: 'ineligible', label: 'Ineligible (blocked credit)' },
];
const ASSESSABLE_OPTIONS: ReadonlyArray<{ value: IncludeInAssessable | ''; label: string }> = [
  { value: '', label: 'Not applicable' },
  { value: 'goods', label: 'Yes — for goods' },
  { value: 'services', label: 'Yes — for services' },
];
const APPROPRIATE_OPTIONS: ReadonlyArray<{ value: AppropriateBy; label: string }> = [
  { value: 'value', label: 'Based on value' },
  { value: 'quantity', label: 'Based on quantity' },
];
const TAX_TYPE_OPTIONS: ReadonlyArray<{ value: LedgerTaxType | ''; label: string }> = [
  { value: '', label: 'Not specified' },
  { value: 'GST', label: 'GST' },
  { value: 'TDS', label: 'TDS' },
  { value: 'TCS', label: 'TCS' },
  { value: 'OTHER', label: 'Others' },
];
const DUTY_HEAD_OPTIONS: ReadonlyArray<{ value: GstDutyHead | ''; label: string }> = [
  { value: '', label: 'Choose…' },
  { value: 'IGST', label: 'Integrated tax (IGST)' },
  { value: 'CGST', label: 'Central tax (CGST)' },
  { value: 'SGST', label: 'State / UT tax (SGST/UTGST)' },
  { value: 'CESS', label: 'Cess' },
];
const DIRECTION_OPTIONS: ReadonlyArray<{ value: GstTaxDirection | ''; label: string }> = [
  { value: '', label: 'Not specified' },
  { value: 'output', label: 'Output — tax collected on sales' },
  { value: 'input', label: 'Input — tax credit on purchases' },
  { value: 'rcm_liability', label: 'Reverse charge payable' },
];
/** Rate select: '' = not set (rate from stock items), a slab, or 'other' for a notified non-standard rate. */
const RATE_OPTIONS = [
  { value: '', label: 'Not set — take the rate from the stock items' },
  ...GST_RATES.map((r) => ({ value: String(r), label: `${r}%` })),
  { value: 'other', label: 'Other rate (notified)…' },
];

const GROUP_FOR_LIVE = new Set(['gstin', 'stateCode', 'registrationType']);

// ───────────────────────────── Form ─────────────────────────────

function LedgerForm({ original, params, groups }: { original: LedgerDetail | null; params: LedgerFormParams; groups: readonly GroupRow[] }) {
  const nav = useNav();
  const toast = useToast();
  const company = useCompany();
  const { booksFrom } = useBooks();
  const { date: workingDate } = useWorkingDate();
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const canSave = useCan(original ? 'masters.alter' : 'masters.create');
  const canDelete = useCan('masters.delete');
  const canAudit = useCan('audit.view');
  const deleteLedger = useDeleteLedger();
  const save = useApiMutation('accounts.ledger.save', { invalidates: [...LEDGER_DEPENDENTS] });
  const features = company.features;
  const index = useMemo(() => indexGroups(groups), [groups]);
  const defaultsCtx = useMemo(
    () => ({ features: { billWise: features.billWise, inventory: features.inventory, gst: features.gst }, gstEnabled: company.gstEnabled, companyStateCode: company.stateCode }),
    [features.billWise, features.inventory, features.gst, company.gstEnabled, company.stateCode],
  );

  const initialGroup = original ? null : initialGroupId(groups, params);
  const initial = useMemo<LedgerDraft>(() => {
    if (original) return draftFromDetail(original);
    const d = emptyLedgerDraft(params.initialName ?? '', initialGroup);
    return applyGroupDefaults(d, null, classOfGroup(index, initialGroup), defaultsCtx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original]);
  /**
   * The group whose usual defaults are in the draft (create only). Defaults are applied when the
   * group's class becomes known — also for a group just created with Alt+C, which reaches the group
   * index only after the list refetches.
   */
  const initialCls = classOfGroup(index, initialGroup);
  const applied = useRef<{ groupId: number | null; cls: LedgerClass | null }>(initialCls ? { groupId: initialGroup, cls: initialCls } : { groupId: null, cls: null });
  const [baseline, setBaseline] = useState<LedgerDraft>(initial);
  const [d, setD] = useState<LedgerDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [billIndexMap, setBillIndexMap] = useState<number[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const formBox = useRef<HTMLDivElement>(null);

  const cls = classOfGroup(index, d.groupId);
  const stockInHand = groupIsUnder(index, d.groupId, 'STOCK_IN_HAND');
  const sections = ledgerSections(cls, { features, gstEnabled: company.gstEnabled, stockInHand, billWiseOn: original?.billWise === true || (d.billWise && d.openingBills.length > 0) });
  const reserved = original?.reservedCode ?? null;
  const readOnly = !canSave;
  const dirty = isDraftDirty(d, baseline);
  const side = defaultOpeningSide(cls);

  const clientErrors = validateLedgerDraft(d, { sections, booksFrom, final: submitted });
  const shownClient: Record<string, string> = submitted
    ? clientErrors
    : Object.fromEntries(
        Object.entries(clientErrors).filter(
          ([k]) =>
            GROUP_FOR_LIVE.has(k) ||
            k.startsWith('openingBills') ||
            (k === 'bankIfsc' && d.bankIfsc.replace(/\s/g, '').length >= 11) ||
            (k === 'pan' && d.pan.trim().length >= 10) ||
            (k === 'hsnSac' && d.hsnSac.trim().length >= 4) ||
            k === 'gstRate',
        ),
      );
  const errors: Record<string, string> = { ...shownClient, ...serverErrors };
  const err = (k: string): string | undefined => errors[k] || undefined;

  // A server error is dropped (not blanked) once its field is edited, so the live client check for
  // that field shows again.
  const clearServer = (...keys: string[]) =>
    setServerErrors((e) => {
      if (!keys.some((k) => k in e)) return e;
      const copy = { ...e };
      for (const k of keys) delete copy[k];
      return copy;
    });

  const set = <K extends keyof LedgerDraft>(k: K, v: LedgerDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    clearServer(k as string);
  };

  const onGroup = (groupId: number | null) => {
    setD((x) => ({ ...x, groupId }));
    clearServer('groupId');
  };

  useEffect(() => {
    if (original) return;
    const next = classOfGroup(index, d.groupId);
    if (!next || applied.current.groupId === d.groupId) return;
    const prev = applied.current.cls;
    applied.current = { groupId: d.groupId, cls: next };
    setD((x) => applyGroupDefaults(x, prev, next, defaultsCtx));
  }, [original, index, d.groupId, defaultsCtx]);

  const onGstin = (raw: string) => {
    setD((x) => {
      const f = applyGstin(x, raw);
      return { ...x, gstin: f.gstin, stateCode: f.stateCode, pan: f.pan, registrationType: f.registrationType };
    });
    clearServer('gstin', 'pan', 'stateCode', 'registrationType');
  };

  const historyEffect = original !== null && sections.gstDetails ? gstHistoryEffect(d, sections, original) : 'none';
  const latestRate = original && original.gstRateHistory.length > 0 ? original.gstRateHistory[original.gstRateHistory.length - 1] : null;

  const submit = async (mode: 'default' | 'close' = 'default') => {
    if (readOnly || save.pending) return;
    setSubmitted(true);
    const problems = validateLedgerDraft(d, { sections, booksFrom, final: true });
    if (Object.keys(problems).length > 0) {
      toast.error('Please correct the highlighted fields', { message: Object.values(problems)[0] });
      focusFirstInvalid(formBox.current);
      return;
    }
    const build = buildSaveInput(d, sections, original);
    if (build.unchanged) {
      nav.pop();
      return;
    }
    setBillIndexMap(build.billIndexMap);
    try {
      const out = await save.mutate(build.input);
      setServerErrors({});
      if (forResult) {
        toast.success(`Ledger “${out.name}” ${original ? 'saved' : 'created'}`);
        returnResult({ id: out.id, name: out.name });
        return;
      }
      if (original || mode === 'close') {
        toast.success(`Ledger “${out.name}” ${original ? 'saved' : 'created'}`);
        nav.pop();
        return;
      }
      // Rapid entry: a fresh form under the same group.
      const fresh = applyGroupDefaults(emptyLedgerDraft('', d.groupId), null, cls, defaultsCtx);
      applied.current = { groupId: d.groupId, cls };
      setBaseline(fresh);
      setD(fresh);
      setSubmitted(false);
      setSavedCount((n) => n + 1);
      toast.success(`Ledger “${out.name}” created`, {
        message: 'Ready for the next one.',
        action: { label: 'Alter it', onClick: () => nav.push('accounts.ledger.form', { id: out.id }) },
      });
      nameRef.current?.focus();
    } catch (e) {
      const f = remapBillErrors(fieldErrorsOf(e), build.billIndexMap);
      if (Object.keys(f).length > 0) {
        setServerErrors(f);
        toast.error('The ledger was not saved', { message: Object.values(f)[0] });
        focusFirstInvalid(formBox.current);
      } else toast.error('The ledger was not saved', { message: userMessage(e) });
    }
  };

  const remove = async () => {
    if (!original) return;
    if (await deleteLedger({ id: original.id, name: original.name, isActive: original.isActive, isPredefined: original.isPredefined })) nav.pop();
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  useEffect(() => {
    if (savedCount > 0) nameRef.current?.focus();
  }, [savedCount]);

  const saveLabel = forResult ? 'Save & return' : original ? 'Save' : 'Save & create next';
  const subtitle = original
    ? `${original.groupPath[original.groupPath.length - 1] ?? ''}${original.closingBalance !== 0 ? ` · ${formatDrCr(original.closingBalance)}` : ''}`
    : savedCount > 0
      ? `${savedCount} created in this session`
      : ledgerCreateSubtitle(cls);

  const openingDisabled = !sections.openingBalance;
  const gstOn = sections.gstDetails && d.gstApplicable;
  const rateValue = d.gstRate === null ? '' : GST_RATES.includes(d.gstRate) && !d.allowNonStandardRate ? String(d.gstRate) : 'other';

  // 2.1 (SPEC-21 §1.8, D23): Essentials on screen, the rest behind "More details" (Ctrl+I, Alt+F1), which
  // opens by itself when a field inside holds a value other than the group's usual one, or an error.
  const essentials = essentialFields(cls, sections, d);
  const moreGroups = moreDetailGroups(cls, sections);
  const classDefaults = useMemo(() => applyGroupDefaults(emptyLedgerDraft('', d.groupId), null, cls, defaultsCtx), [d.groupId, cls, defaultsCtx]);
  const revealed = moreDetailsRevealed(cls, sections, d, errors, classDefaults);
  const prefs = useUiPrefs();
  const moreChosen = prefs.moreDetails[LEDGER_FORM_KIND] === true;
  const moreOpen = moreChosen || revealed;
  const toggleMore = () => setMoreDetailsOpen(LEDGER_FORM_KIND, !moreOpen);
  // Closing More details (Ctrl+I) while the cursor is in one of its fields: the cursor moves to the line
  // instead of being lost in a hidden region.
  const moreButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (moreOpen) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && formBox.current?.contains(el) && el.closest('[hidden]')) moreButton.current?.focus();
  }, [moreOpen]);

  /** One inline field row ("Label  [control]  hint"): the hint shows while the field has focus. */
  const field = (id: LedgerField): ReactNode => {
    switch (id) {
      case 'name':
        return (
          <Field layout="inline" label="Name" required error={err('name')}>
            <TextInput ref={nameRef} data-autofocus value={d.name} onChange={(e) => set('name', e.target.value)} readOnly={readOnly} maxLength={200} />
          </Field>
        );
      case 'groupId':
        return (
          <Field layout="inline" label="Under" required error={err('groupId')} hint={reserved ? 'Built-in ledgers stay in their group.' : 'The group it belongs to — Alt+C creates a new one.'}>
            <GroupPicker value={d.groupId} onChange={(id) => onGroup(id)} invalid={!!err('groupId')} readOnly={readOnly || !!reserved} />
          </Field>
        );
      case 'gstin':
        return (
          <Field
            layout="inline"
            label={d.registrationType === 'uin' ? 'UIN' : 'GSTIN'}
            error={err('gstin')}
            hint={
              gstinOkText(d.gstin) ? (
                <OkHint>{gstinOkText(d.gstin)}</OkHint>
              ) : company.gstEnabled === false ? (
                'GST is off for this company (F11); the registration is kept for when you turn it on.'
              ) : (
                'Typing a valid GSTIN fills the state and PAN.'
              )
            }
          >
            <TextInput value={d.gstin} onChange={(e) => onGstin(e.target.value)} readOnly={readOnly} uppercase mono maxLength={15} spellCheck={false} autoComplete="off" />
          </Field>
        );
      case 'pan':
        return (
          <Field layout="inline" label="PAN" optional error={err('pan')}>
            <TextInput value={d.pan} onChange={(e) => set('pan', e.target.value.toUpperCase().slice(0, 10))} readOnly={readOnly} uppercase mono spellCheck={false} />
          </Field>
        );
      case 'stateCode':
        return (
          <Field layout="inline" label="State" error={err('stateCode')} hint="Decides CGST + SGST or IGST on invoices.">
            <StatePicker value={d.stateCode} onChange={(c) => set('stateCode', c)} invalid={!!err('stateCode')} readOnly={readOnly} />
          </Field>
        );
      case 'address':
        return (
          <Field layout="inline" label="Address" optional>
            <TextArea value={d.address} onChange={(e) => set('address', e.target.value)} readOnly={readOnly} rows={1} autoGrow maxRows={6} maxLength={500} />
          </Field>
        );
      case 'mobile':
        return (
          <Field layout="inline" label="Mobile" optional error={err('mobile')}>
            <TextInput value={d.mobile} onChange={(e) => set('mobile', e.target.value)} readOnly={readOnly} inputMode="tel" maxLength={20} />
          </Field>
        );
      case 'bankAccountNo':
        return (
          <Field layout="inline" label="Account number" optional error={err('bankAccountNo')}>
            <TextInput value={d.bankAccountNo} onChange={(e) => set('bankAccountNo', e.target.value)} readOnly={readOnly} mono inputMode="numeric" maxLength={24} />
          </Field>
        );
      case 'bankIfsc':
        return (
          <Field layout="inline" label="IFSC" optional error={err('bankIfsc')} hint={d.bankIfsc.trim().length === 11 && !err('bankIfsc') ? <OkHint>Valid IFSC · bank code {d.bankIfsc.trim().toUpperCase().slice(0, 4)}</OkHint> : 'e.g. HDFC0001234'}>
            <TextInput value={d.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase().slice(0, 11))} readOnly={readOnly} uppercase mono spellCheck={false} />
          </Field>
        );
      case 'taxType':
        return (
          <Field layout="inline" label="Type of duty / tax" error={err('taxType')} hint={reserved ? 'Built-in tax ledgers keep their tax settings.' : undefined}>
            <Select<LedgerTaxType | ''> value={d.taxType} onChange={(v) => set('taxType', v)} disabled={readOnly || !!reserved} options={TAX_TYPE_OPTIONS} />
          </Field>
        );
      case 'gstDutyHead':
        return d.taxType === 'GST' ? (
          <Field layout="inline" label="GST duty head" required error={err('gstDutyHead')}>
            <Select<GstDutyHead | ''> value={d.gstDutyHead} onChange={(v) => set('gstDutyHead', v)} disabled={readOnly || !!reserved} options={DUTY_HEAD_OPTIONS} />
          </Field>
        ) : null;
      case 'gstTaxDirection':
        return d.taxType === 'GST' ? (
          <Field layout="inline" label="Used for" error={err('gstTaxDirection')}>
            <Select<GstTaxDirection | ''> value={d.gstTaxDirection} onChange={(v) => set('gstTaxDirection', v)} disabled={readOnly || !!reserved} options={DIRECTION_OPTIONS} />
          </Field>
        ) : null;
      case 'gstRate':
        return gstOn && d.gstTaxability === 'taxable' ? (
          <>
            <Field layout="inline" label="GST rate" error={err('gstRate')} hint={rateValue === '' ? 'Each stock item’s own rate is used.' : 'Used when an invoice line has no stock item, or the item has no rate.'}>
              <Select
                value={rateValue}
                disabled={readOnly}
                options={RATE_OPTIONS}
                onChange={(v) => {
                  if (v === 'other') setD((x) => ({ ...x, allowNonStandardRate: true }));
                  else setD((x) => ({ ...x, gstRate: v === '' ? null : Number(v), allowNonStandardRate: false }));
                }}
              />
            </Field>
            {rateValue === 'other' ? (
              <Field layout="inline" label="Notified rate" error={err('gstRate')} hint="A rate prescribed by a notification that is not a regular slab.">
                <PercentInput value={d.gstRate} onChange={(v) => set('gstRate', v)} max={100} readOnly={readOnly} />
              </Field>
            ) : null}
          </>
        ) : null;
      case 'hsnSac':
        return gstOn ? (
          <Field layout="inline" label="HSN / SAC" optional error={err('hsnSac')} hint="4, 6 or 8 digits. SAC codes (services) start with 99.">
            <TextInput value={d.hsnSac} onChange={(e) => set('hsnSac', e.target.value.replace(/\D/g, '').slice(0, 8))} readOnly={readOnly} inputMode="numeric" mono />
          </Field>
        ) : null;
      case 'applicableFrom':
        return historyEffect === 'dated' ? (
          <Field
            layout="inline"
            label="These GST details apply from"
            optional
            error={err('applicableFrom')}
            hintApplies
            hint={
              d.applicableFrom
                ? `Invoices dated before ${formatDate(d.applicableFrom)} keep the earlier details.`
                : latestRate && original && original.gstRateHistory.length > 1
                  ? `Leave blank to correct the details in force since ${formatDate(latestRate.applicableFrom)}.`
                  : 'Leave blank to correct the current details for all dates.'
            }
          >
            <DateInput value={d.applicableFrom} onChange={(v) => set('applicableFrom', v)} referenceDate={workingDate} minDate={booksFrom} readOnly={readOnly} />
          </Field>
        ) : historyEffect === 'removes' && original && original.gstRateHistory.length > 0 ? (
          <Banner tone="warning" inline>
            {d.gstApplicable
              ? 'Without a rate, each invoice line takes the stock item’s rate, and this ledger’s dated GST rate history is removed.'
              : 'GST will not apply to this ledger, and its dated GST rate history is removed.'}{' '}
            To change the rate only from a date, choose the new rate or taxability (e.g. Exempt) instead and give the date.
          </Banner>
        ) : null;
      case 'openingBalance':
        return openingDisabled ? (
          <Banner tone="info" inline>
            Inventory is integrated with accounts, so the opening stock is the total of the stock items' opening values. Enter opening quantities and rates in the stock items instead.
            {d.openingBalance !== 0 ? ` This ledger still carries an opening balance of ₹ ${formatDrCr(d.openingBalance)} from before; it is kept as it is.` : ''}
          </Banner>
        ) : (
          <Field layout="inline" label="Opening balance" error={err('openingBalance')} hint={`as on ${formatDate(booksFrom)}`} hintApplies>
            <AmountInput key={side} drcr defaultSide={side} value={d.openingBalance} onChange={(v) => set('openingBalance', v ?? 0)} readOnly={readOnly} symbol />
          </Field>
        );
      case 'openingBills':
        return d.billWise && (d.openingBalance !== 0 || d.openingBills.length > 0) ? (
          <section className="bx-acc-form__wide" aria-label="Opening bills">
            <h2 className="bx-acc-form__title">Opening bills</h2>
            <OpeningBillsGrid bills={d.openingBills} onChange={(b) => set('openingBills', b)} opening={d.openingBalance} booksFrom={booksFrom} defaultSide={side} errors={errors} readOnly={readOnly} />
          </section>
        ) : null;
      case 'alias':
        return (
          <Field layout="inline" label="Alias" optional error={err('alias')} hint="Another name to find it by (short name, code).">
            <TextInput value={d.alias} onChange={(e) => set('alias', e.target.value)} readOnly={readOnly} maxLength={200} />
          </Field>
        );
      case 'moreAliases':
        return (
          <Field
            layout="inline"
            label="More aliases"
            optional
            error={err('moreAliases') ?? Object.entries(errors).find(([k]) => k.startsWith('aliases'))?.[1]}
            hint="One per line: local-language name, old code, supplier's code… Ctrl+Enter moves on."
          >
            <TextArea
              value={d.moreAliases}
              onChange={(e) => {
                set('moreAliases', e.target.value);
                setServerErrors((x) => (Object.keys(x).some((k) => k.startsWith('aliases')) ? Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith('aliases'))) : x));
              }}
              readOnly={readOnly}
              rows={1}
              autoGrow
              maxRows={6}
              maxLength={4000}
              aria-label="More aliases, one per line"
            />
          </Field>
        );
      case 'isActive':
        return (
          <Field layout="inline" label="Active" hint={d.isActive ? 'Can be used in new vouchers.' : 'Kept in old vouchers and reports, hidden from new ones.'}>
            <Switch checked={d.isActive} onChange={(v) => set('isActive', v)} disabled={readOnly || !!reserved} aria-label="Active" />
          </Field>
        );
      case 'currencyId':
        return <CurrencyField value={d.currencyId} onChange={(v) => set('currencyId', v)} readOnly={readOnly} error={err('currencyId')} />;
      case 'notes':
        return (
          <Field layout="inline" label="Notes" optional>
            <TextArea value={d.notes} onChange={(e) => set('notes', e.target.value)} readOnly={readOnly} rows={1} autoGrow maxRows={5} maxLength={1000} />
          </Field>
        );
      case 'billWise':
        return (
          <Field layout="inline" label="Maintain balances bill by bill" hint="Track each invoice separately for outstanding and ageing.">
            <Switch checked={d.billWise} onChange={(v) => set('billWise', v)} disabled={readOnly} aria-label="Maintain balances bill by bill" />
          </Field>
        );
      case 'defaultCreditDays':
        return (
          <Field layout="inline" label="Credit period" optional error={err('defaultCreditDays')} hint="Days allowed for payment; sets the due date of new bills.">
            <NumberInput value={d.defaultCreditDays} onChange={(v) => set('defaultCreditDays', v)} min={0} max={3650} readOnly={readOnly} suffix="days" />
          </Field>
        );
      case 'creditLimit':
        return (
          <Field layout="inline" label="Credit limit" optional error={err('creditLimit')} hint="Warns when a sale takes the balance above this.">
            <AmountInput value={d.creditLimit} onChange={(v) => set('creditLimit', v)} readOnly={readOnly} symbol blankZero />
          </Field>
        );
      case 'interestEnabled':
        return (
          <Field layout="inline" label="Calculate interest" hint="On overdue bills, % per annum.">
            <Switch checked={d.interestEnabled} onChange={(v) => set('interestEnabled', v)} disabled={readOnly} aria-label="Calculate interest" />
          </Field>
        );
      case 'interestRate':
        return d.interestEnabled ? (
          <Field layout="inline" label="Interest rate" required error={err('interestRate')}>
            <PercentInput value={d.interestRate} onChange={(v) => set('interestRate', v)} max={100} readOnly={readOnly} />
          </Field>
        ) : null;
      case 'mailingName':
        return (
          <Field layout="inline" label="Mailing name" optional hint="Name printed on documents, if different.">
            <TextInput value={d.mailingName} onChange={(e) => set('mailingName', e.target.value)} readOnly={readOnly} placeholder={d.name} maxLength={200} />
          </Field>
        );
      case 'contactPerson':
        return (
          <Field layout="inline" label="Contact person" optional>
            <TextInput value={d.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} readOnly={readOnly} maxLength={100} />
          </Field>
        );
      case 'pincode':
        return (
          <Field layout="inline" label={d.registrationType === 'overseas' ? 'Postal code' : 'PIN code'} optional error={err('pincode')}>
            <TextInput value={d.pincode} onChange={(e) => set('pincode', e.target.value.slice(0, 10))} readOnly={readOnly} inputMode="numeric" mono />
          </Field>
        );
      case 'country':
        return (
          <Field layout="inline" label="Country" optional>
            <TextInput value={d.country} onChange={(e) => set('country', e.target.value)} readOnly={readOnly} maxLength={60} />
          </Field>
        );
      case 'phone':
        return (
          <Field layout="inline" label="Phone" optional>
            <TextInput value={d.phone} onChange={(e) => set('phone', e.target.value)} readOnly={readOnly} inputMode="tel" maxLength={40} />
          </Field>
        );
      case 'email':
        return (
          <Field layout="inline" label="Email" optional error={err('email')}>
            <TextInput value={d.email} onChange={(e) => set('email', e.target.value)} readOnly={readOnly} type="email" maxLength={254} />
          </Field>
        );
      case 'registrationType':
        return (
          <Field
            layout="inline"
            label="Registration type"
            error={err('registrationType')}
            hint={REGISTRATION_OPTIONS.find((o) => o.value === d.registrationType)?.hint ?? 'Leave it: a party with a GSTIN is Regular, without one Unregistered.'}
          >
            <Select<RegistrationType>
              value={d.registrationType}
              onChange={(v) =>
                setD((x) => ({ ...x, registrationType: v, gstin: NO_GSTIN.has(v) || v === 'overseas' ? '' : x.gstin, stateCode: v === 'overseas' ? '96' : x.stateCode === '96' ? '' : x.stateCode }))
              }
              disabled={readOnly}
              placeholder="Choose…"
              options={REGISTRATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </Field>
        );
      case 'isEcommerceOperator':
        return (
          <Field layout="inline" label="E-commerce operator" hint="Operators of online marketplaces that collect TCS.">
            <Switch checked={d.isEcommerceOperator} onChange={(v) => set('isEcommerceOperator', v)} disabled={readOnly} aria-label="E-commerce operator" />
          </Field>
        );
      case 'bankAccountHolder':
        return (
          <Field layout="inline" label="Account holder name" optional>
            <TextInput value={d.bankAccountHolder} onChange={(e) => set('bankAccountHolder', e.target.value)} readOnly={readOnly} maxLength={200} />
          </Field>
        );
      case 'bankName':
        return (
          <Field layout="inline" label="Bank name" optional>
            <TextInput value={d.bankName} onChange={(e) => set('bankName', e.target.value)} readOnly={readOnly} maxLength={100} />
          </Field>
        );
      case 'bankBranch':
        return (
          <Field layout="inline" label="Branch" optional>
            <TextInput value={d.bankBranch} onChange={(e) => set('bankBranch', e.target.value)} readOnly={readOnly} maxLength={100} />
          </Field>
        );
      case 'bankUpiId':
        return (
          <Field layout="inline" label="UPI ID" optional error={err('bankUpiId')} hint="Printed as a QR code on invoices.">
            <TextInput value={d.bankUpiId} onChange={(e) => set('bankUpiId', e.target.value.trim())} readOnly={readOnly} placeholder="shop@okhdfcbank" maxLength={100} />
          </Field>
        );
      case 'chequeBookEnabled':
        return (
          <Field layout="inline" label="Cheque book" hint="Keep track of cheque numbers for this account.">
            <Switch checked={d.chequeBookEnabled} onChange={(v) => set('chequeBookEnabled', v)} disabled={readOnly} aria-label="Cheque book" />
          </Field>
        );
      case 'gstApplicable':
        return (
          <Field layout="inline" label="GST applicable" hint="Used when an invoice line has no stock item, or the item has no rate.">
            <Switch checked={d.gstApplicable} onChange={(v) => set('gstApplicable', v)} disabled={readOnly} aria-label="GST applicable" />
          </Field>
        );
      case 'gstTaxability':
        return gstOn ? (
          <Field layout="inline" label="Taxability" error={err('gstTaxability')}>
            <Select<Taxability> value={d.gstTaxability} onChange={(v) => set('gstTaxability', v)} disabled={readOnly} options={TAXABILITY_OPTIONS} />
          </Field>
        ) : null;
      case 'cessRate':
        return gstOn && d.gstTaxability === 'taxable' ? (
          <Field layout="inline" label="Cess rate" optional error={err('cessRate')}>
            <PercentInput value={d.cessRate} onChange={(v) => set('cessRate', v)} max={400} readOnly={readOnly} blankZero />
          </Field>
        ) : null;
      case 'gstSupplyType':
        return gstOn ? (
          <Field layout="inline" label="Goods or services" error={err('gstSupplyType')}>
            <Select<SupplyKind | ''> value={d.gstSupplyType} onChange={(v) => set('gstSupplyType', v)} disabled={readOnly} options={SUPPLY_OPTIONS} />
          </Field>
        ) : null;
      case 'isReverseCharge':
        return gstOn ? (
          <Field layout="inline" label="Reverse charge" error={err('isReverseCharge')} hint="Tax is paid by you, not the supplier (e.g. GTA, legal services).">
            <Switch checked={d.isReverseCharge} onChange={(v) => set('isReverseCharge', v)} disabled={readOnly} aria-label="Reverse charge" />
          </Field>
        ) : null;
      case 'itcEligibility':
        return gstOn ? (
          <Field layout="inline" label="Input tax credit" error={err('itcEligibility')}>
            <Select<ItcEligibility | ''> value={d.itcEligibility} onChange={(v) => set('itcEligibility', v)} disabled={readOnly} options={ITC_OPTIONS} />
          </Field>
        ) : null;
      case 'includeInAssessable':
        return (
          <Field layout="inline" label="Include in assessable value" hint="For charges like freight or packing that add to the taxable value of an invoice.">
            <Select<IncludeInAssessable | ''> value={d.includeInAssessable === 'none' ? '' : d.includeInAssessable} onChange={(v) => set('includeInAssessable', v)} disabled={readOnly} options={ASSESSABLE_OPTIONS} />
          </Field>
        );
      case 'appropriateBy':
        return d.includeInAssessable === 'goods' || d.includeInAssessable === 'services' ? (
          <Field layout="inline" label="Spread over the items">
            <Select<AppropriateBy> value={d.appropriateBy || 'value'} onChange={(v) => set('appropriateBy', v)} disabled={readOnly} options={APPROPRIATE_OPTIONS} />
          </Field>
        ) : null;
      case 'costCentresApplicable':
        return (
          <Field layout="inline" label="Cost centres applicable" hint="Ask for cost centres when this ledger is used in a voucher.">
            <Switch checked={d.costCentresApplicable} onChange={(v) => set('costCentresApplicable', v)} disabled={readOnly} aria-label="Cost centres applicable" />
          </Field>
        );
      case 'inventoryValuesAffected':
        return (
          <Field layout="inline" label="Inventory values are affected" hint="Invoices with this ledger carry stock items (sales and purchase ledgers).">
            <Switch checked={d.inventoryValuesAffected} onChange={(v) => set('inventoryValuesAffected', v)} disabled={readOnly} aria-label="Inventory values are affected" />
          </Field>
        );
      case 'tdsApplicable':
        return (
          <Field layout="inline" label="TDS applicable">
            <Switch checked={d.tdsApplicable} onChange={(v) => set('tdsApplicable', v)} disabled={readOnly} aria-label="TDS applicable" />
          </Field>
        );
      case 'tdsSection':
        return d.tdsApplicable ? (
          <>
            <Field layout="inline" label="TDS section" optional error={err('tdsSection')} hint="e.g. 194C contractors, 194J professional fees.">
              <TextInput value={d.tdsSection} onChange={(e) => set('tdsSection', e.target.value.toUpperCase().slice(0, 20))} readOnly={readOnly} mono />
            </Field>
            {/* tds module: the deduction itself uses the ledger's TDS / TCS details (nature, deductee type, PAN, certificate). */}
            {original ? (
              <Field layout="inline" label="TDS / TCS details" hint="Nature of payment, deductee type, PAN and lower-deduction certificate used to work out TDS on vouchers.">
                <Button size="sm" variant="secondary" onClick={() => nav.push('tds.ledger.form', { ledgerId: original.id })}>
                  Open TDS / TCS details
                </Button>
              </Field>
            ) : null}
          </>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <Screen
      title={original ? 'Ledger Alteration' : 'Ledger Creation'}
      subtitle={subtitle}
      width="form"
      dirty={dirty}
      meta={original && !original.isActive ? <span className="bx-acc-warn">Inactive</span> : undefined}
      hint={`Enter Next field · Shift+Enter Back · Ctrl+A ${saveLabel} · Ctrl+I More details · Alt+C Create group (in Under) · D / C Debit / Credit · Esc Back`}
      actions={[
        {
          key: 'Ctrl+A',
          label: saveLabel,
          icon: 'save',
          primary: true,
          onClick: () => void submit(),
          disabled: readOnly,
          hint: forResult ? 'Saves and returns to where you were.' : original ? undefined : 'Saves and opens a blank form under the same group.',
        },
        { key: 'Alt+S', label: 'Save & close', icon: 'check', onClick: () => void submit('close'), hidden: !!original || forResult || readOnly },
        { key: 'Ctrl+I, Alt+F1', label: 'More details', icon: 'list', onClick: toggleMore, group: 'view', checked: moreOpen, demoted: true },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !original || !canDelete, group: 'danger' },
        {
          key: 'Alt+L',
          label: 'Ledger report',
          icon: 'book',
          onClick: () => original && nav.push('reports.ledger', { ledgerId: original.id }),
          hidden: !original || !nav.isRegistered('reports.ledger'),
          group: 'more',
        },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => original && nav.push('security.audit', { entityType: 'ledger', entityId: original.id, entityGuid: original.guid, label: original.name }),
          hidden: !original || !canAudit,
          hint: 'Who changed this ledger, and what (Edit Log).',
          group: 'more',
        },
      ]}
    >
      <div ref={formBox}>
        <AttachmentsRailAction entityType="ledger" entityId={original?.id ?? null} label={original?.name} />
        <div ref={formRef} className="bx-acc-form">
          {readOnly ? <ReadOnlyNotice what="ledgers" /> : null}
          {essentials.map((id) => (
            <Fragment key={id}>{field(id)}</Fragment>
          ))}
          {moreGroups.length > 0 ? (
            <DisclosureLine shortcut="Ctrl+I" summary={moreDetailsSummary(moreGroups)} open={moreOpen} forceOpen={revealed} onToggle={(open) => setMoreDetailsOpen(LEDGER_FORM_KIND, open)} className="bx-acc-form__more" regionClassName="bx-acc-form" buttonRef={moreButton}>
              {moreGroups.map((g) => (
                <section key={g.title} className="bx-acc-form" aria-label={g.title}>
                  <h2 className="bx-acc-form__title">{g.title}</h2>
                  {g.fields.map((id) => (
                    <Fragment key={id}>{field(id)}</Fragment>
                  ))}
                </section>
              ))}
              {original && sections.gstDetails && original.gstRateHistory.length > 0 ? <GstHistoryTable original={original} /> : null}
            </DisclosureLine>
          ) : null}
        </div>
      </div>
    </Screen>
  );
}

function CurrencyField({ value, onChange, readOnly, error }: { value: number | null; onChange: (v: number | null) => void; readOnly: boolean; error?: string }) {
  const q = useApiQuery('accounts.currency.list', {});
  const options = (q.data?.rows ?? []).map((c) => ({ value: String(c.id), label: `${c.symbol} — ${c.formalName}${c.isBase ? ' (base)' : ''}` }));
  return (
    <Field layout="inline" label="Currency" optional error={error} hint="For ledgers kept in a foreign currency.">
      <Select value={value === null ? '' : String(value)} onChange={(v) => onChange(v === '' ? null : Number(v))} disabled={readOnly} placeholder="Base currency (₹)" options={options} />
    </Field>
  );
}

interface HistoryRow {
  id: number;
  applicableFrom: string;
  taxability: string;
  rate: string;
  cess: string;
  hsnSac: string;
}

function GstHistoryTable({ original }: { original: LedgerDetail }) {
  const rows = useMemo<HistoryRow[]>(
    () =>
      original.gstRateHistory
        .slice()
        .reverse()
        .map((h) => ({
          id: h.id,
          applicableFrom: h.applicableFrom,
          taxability: TAXABILITY_OPTIONS.find((t) => t.value === h.taxability)?.label ?? h.taxability,
          rate: h.taxability === 'taxable' ? `${h.rate}%` : '—',
          cess: h.cessRate ? `${h.cessRate}%` : '',
          hsnSac: h.hsnSac ?? '',
        })),
    [original.gstRateHistory],
  );
  const columns = useMemo<Column<HistoryRow>[]>(
    () => [
      { key: 'applicableFrom', header: 'Applicable from', kind: 'date', width: 140 },
      { key: 'taxability', header: 'Taxability', width: 120 },
      { key: 'rate', header: 'Rate', width: 90, align: 'right' },
      { key: 'cess', header: 'Cess', width: 90, align: 'right' },
      { key: 'hsnSac', header: 'HSN / SAC' },
    ],
    [],
  );
  return (
    <section className="bx-acc-form__wide" aria-label="GST rate history" title="Invoices use the details in force on their date. Newest first.">
      <h2 className="bx-acc-form__title">GST rate history</h2>
      <div data-enter-ignore>
        <DataTable aria-label="GST rate history" columns={columns} rows={rows} getRowKey={(r) => String(r.id)} height={Math.min(220, 40 + rows.length * 34)} typeToJump={false} />
      </div>
    </section>
  );
}
