/**
 * 'accounts.ledger.form' — Ledger Creation / Alteration, a single keyboard-first page.
 * Params: { id? (alter) | initialName? (create), groupId? | groupCode? (create under a group, by id or by
 * reserved code such as 'SUNDRY_DEBTORS' / 'BANK_ACCOUNTS'), forResult? }.
 *
 * Sections appear by the group's class: Basic → Opening balance (+ opening bills when bill-wise) →
 * Party details + GST registration (customers/suppliers) → Bank details → Tax ledger → GST details
 * (sales/purchase/income/expense/fixed assets) → Other settings (cost centres, inventory, TDS).
 * Enter moves field to field; Enter on the last field or Ctrl+A saves. Create = "Save & create next"
 * (rapid entry, keeps the group); opened for a result = "Save & return" (nav.pop({ id, name }));
 * alter = save and close. Alt+D deletes (the server explains why a ledger cannot be deleted), Alt+H shows
 * the ledger's edit history.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useAppState, useCan, useCompany } from '../../app/state.tsx';
import { useBooks, useWorkingDate } from '../../app/working.tsx';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  Field,
  FieldGroup,
  NumberInput,
  PercentInput,
  Select,
  Stack,
  Switch,
  TextArea,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { focusFirstInvalid, OkHint, StatePicker } from './components.tsx';
import { LEDGER_DEPENDENTS, useDeleteLedger } from './hooks.ts';
import { classOfGroup, groupIsUnder, indexGroups, initialGroupId } from './lib/groupClass.ts';
import { applyGstin, gstinOkText, NO_GSTIN, REGISTRATION_OPTIONS } from './lib/gstin.ts';
import { applyGroupDefaults, buildSaveInput, draftFromDetail, emptyLedgerDraft, gstHistoryEffect, isDraftDirty, validateLedgerDraft } from './lib/ledgerDraft.ts';
import type { LedgerDraft } from './lib/ledgerDraft.ts';
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
        icon="ledger"
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
  const app = useAppState();
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
    ? `${original.groupPath.join(' › ')}${original.voucherCount ? ` · used in ${original.voucherCount} voucher${original.voucherCount === 1 ? '' : 's'}` : ''}`
    : savedCount > 0
      ? `${savedCount} created in this session`
      : 'A ledger is an account: a customer, supplier, bank, expense, income or tax head.';

  const openingDisabled = !sections.openingBalance;
  const gstOn = sections.gstDetails && d.gstApplicable;
  const rateValue = d.gstRate === null ? '' : GST_RATES.includes(d.gstRate) && !d.allowNonStandardRate ? String(d.gstRate) : 'other';

  return (
    <Screen
      title={original ? 'Ledger Alteration' : 'Ledger Creation'}
      subtitle={subtitle}
      icon="ledger"
      width="form"
      dirty={dirty}
      meta={
        original ? (
          <>
            {original.closingBalance !== 0 ? <Badge tone="neutral">Balance {formatDrCr(original.closingBalance)}</Badge> : null}
            {!original.isActive ? <Badge tone="warning">Inactive</Badge> : null}
            {original.isPredefined ? <Badge tone="neutral" variant="outline">Built-in</Badge> : null}
          </>
        ) : undefined
      }
      hint={`Enter Next field · Shift+Enter Back · Ctrl+A ${saveLabel} · Alt+C Create group (in Under) · Esc Back`}
      actions={[
        { key: 'Ctrl+A', label: saveLabel, icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly },
        { key: 'Alt+S', label: 'Save & close', icon: 'check', onClick: () => void submit('close'), hidden: !!original || forResult || readOnly },
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
      footer={
        readOnly ? undefined : (
          <>
            {original && canDelete ? (
              <Button variant="ghost" icon="trash" onClick={() => void remove()} shortcut="Alt+D">
                Delete
              </Button>
            ) : null}
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" loading={save.pending} onClick={() => void submit()} shortcut="Ctrl+A">
              {saveLabel}
            </Button>
          </>
        )
      }
    >
      <div ref={formBox}>
      <AttachmentsRailAction entityType="ledger" entityId={original?.id ?? null} label={original?.name} />
      <div ref={formRef}>
        <Stack gap={6}>
          {readOnly ? <ReadOnlyNotice what="ledgers" /> : null}

          <FieldGroup legend="Basic details" columns={2}>
            <Field label="Name" required error={err('name')}>
              <TextInput ref={nameRef} data-autofocus value={d.name} onChange={(e) => set('name', e.target.value)} readOnly={readOnly} maxLength={200} placeholder="e.g. Sharma Traders, HDFC Bank, Office Rent" />
            </Field>
            <Field label="Alias" optional error={err('alias')} hint="Another name to find it by (short name, code).">
              <TextInput value={d.alias} onChange={(e) => set('alias', e.target.value)} readOnly={readOnly} maxLength={200} />
            </Field>
            <Field
              label="More aliases"
              optional
              error={err('moreAliases') ?? Object.entries(errors).find(([k]) => k.startsWith('aliases'))?.[1]}
              hint="One per line: local-language name, old code, supplier's code… Found in every search. Ctrl+Enter moves on."
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
            <Field
              label="Under"
              required
              error={err('groupId')}
              hint={reserved ? 'Built-in ledgers stay in their group.' : cls ? groupHint(cls) : 'Alt+C creates a new group with what you typed.'}
            >
              <GroupPicker value={d.groupId} onChange={(id) => onGroup(id)} invalid={!!err('groupId')} readOnly={readOnly || !!reserved} />
            </Field>
            <Field label="Active" hint={d.isActive ? 'Can be used in new vouchers.' : 'Kept in old vouchers and reports, hidden from new ones.'}>
              <Switch checked={d.isActive} onChange={(v) => set('isActive', v)} disabled={readOnly || !!reserved} aria-label="Active" />
            </Field>
            {sections.currency ? <CurrencyField value={d.currencyId} onChange={(v) => set('currencyId', v)} readOnly={readOnly} error={err('currencyId')} /> : null}
            <Field label="Notes" optional>
              <TextArea value={d.notes} onChange={(e) => set('notes', e.target.value)} readOnly={readOnly} rows={2} autoGrow maxRows={5} maxLength={1000} />
            </Field>
          </FieldGroup>

          <FieldGroup legend="Opening balance" description={`As on ${formatDate(booksFrom)}, when the books begin. Press D or C to switch Debit / Credit.`} columns={2}>
            {openingDisabled ? (
              <Banner tone="info" inline>
                Inventory is integrated with accounts, so the opening stock is the total of the stock items' opening values. Enter opening quantities and rates in the stock items instead.
                {d.openingBalance !== 0 ? ` This ledger still carries an opening balance of ₹ ${formatDrCr(d.openingBalance)} from before; it is kept as it is.` : ''}
              </Banner>
            ) : (
              <Field label="Opening balance" error={err('openingBalance')} hint={side === 'dr' ? 'Usually Dr for this kind of account.' : 'Usually Cr for this kind of account.'}>
                <AmountInput key={side} drcr defaultSide={side} value={d.openingBalance} onChange={(v) => set('openingBalance', v ?? 0)} readOnly={readOnly} symbol />
              </Field>
            )}
            {sections.billWise ? (
              <Field label="Maintain balances bill by bill" hint="Track each invoice separately for outstanding and ageing.">
                <Switch checked={d.billWise} onChange={(v) => set('billWise', v)} disabled={readOnly} aria-label="Maintain balances bill by bill" />
              </Field>
            ) : null}
          </FieldGroup>

          {sections.billWise && d.billWise && (d.openingBalance !== 0 || d.openingBills.length > 0) ? (
            <FieldGroup legend="Opening bills" description="Break the opening balance into the bills that were unpaid when the books began (optional).">
              <OpeningBillsGrid
                bills={d.openingBills}
                onChange={(b) => set('openingBills', b)}
                opening={d.openingBalance}
                booksFrom={booksFrom}
                defaultSide={side}
                errors={errors}
                readOnly={readOnly}
              />
            </FieldGroup>
          ) : null}

          {sections.party ? (
            <FieldGroup legend="Party details" description="Printed on invoices and used for GST returns." columns={2}>
              <Field label="Mailing name" optional hint="Name printed on documents, if different.">
                <TextInput value={d.mailingName} onChange={(e) => set('mailingName', e.target.value)} readOnly={readOnly} placeholder={d.name} maxLength={200} />
              </Field>
              <Field label="Contact person" optional>
                <TextInput value={d.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} readOnly={readOnly} maxLength={100} />
              </Field>
              <Field label="Address" optional>
                <TextArea value={d.address} onChange={(e) => set('address', e.target.value)} readOnly={readOnly} rows={3} autoGrow maxRows={6} maxLength={500} />
              </Field>
              <Stack gap={3}>
                <Field label="State" error={err('stateCode')} hint="Decides CGST + SGST or IGST on invoices.">
                  <StatePicker value={d.stateCode} onChange={(c) => set('stateCode', c)} invalid={!!err('stateCode')} readOnly={readOnly} />
                </Field>
                <Field label={d.registrationType === 'overseas' ? 'Postal code' : 'PIN code'} optional error={err('pincode')}>
                  <TextInput value={d.pincode} onChange={(e) => set('pincode', e.target.value.slice(0, 10))} readOnly={readOnly} inputMode="numeric" mono />
                </Field>
              </Stack>
              <Field label="Country" optional>
                <TextInput value={d.country} onChange={(e) => set('country', e.target.value)} readOnly={readOnly} maxLength={60} />
              </Field>
              <Field label="Phone" optional>
                <TextInput value={d.phone} onChange={(e) => set('phone', e.target.value)} readOnly={readOnly} inputMode="tel" maxLength={40} />
              </Field>
              <Field label="Mobile" optional error={err('mobile')}>
                <TextInput value={d.mobile} onChange={(e) => set('mobile', e.target.value)} readOnly={readOnly} inputMode="tel" maxLength={20} placeholder="98765 43210" />
              </Field>
              <Field label="Email" optional error={err('email')}>
                <TextInput value={d.email} onChange={(e) => set('email', e.target.value)} readOnly={readOnly} type="email" maxLength={254} />
              </Field>
              <Field label="PAN" optional error={err('pan')}>
                <TextInput value={d.pan} onChange={(e) => set('pan', e.target.value.toUpperCase().slice(0, 10))} readOnly={readOnly} uppercase mono spellCheck={false} />
              </Field>
              <Field label="Credit period" optional error={err('defaultCreditDays')} hint="Days allowed for payment; sets the due date of new bills.">
                <NumberInput value={d.defaultCreditDays} onChange={(v) => set('defaultCreditDays', v)} min={0} max={3650} readOnly={readOnly} suffix="days" />
              </Field>
              <Field label="Credit limit" optional error={err('creditLimit')} hint="Warns when a sale takes the balance above this.">
                <AmountInput value={d.creditLimit} onChange={(v) => set('creditLimit', v)} readOnly={readOnly} symbol blankZero />
              </Field>
              {sections.interest ? (
                <>
                  <Field label="Calculate interest" hint="On overdue bills, % per annum.">
                    <Switch checked={d.interestEnabled} onChange={(v) => set('interestEnabled', v)} disabled={readOnly} aria-label="Calculate interest" />
                  </Field>
                  {d.interestEnabled ? (
                    <Field label="Interest rate" required error={err('interestRate')}>
                      <PercentInput value={d.interestRate} onChange={(v) => set('interestRate', v)} max={100} readOnly={readOnly} />
                    </Field>
                  ) : null}
                </>
              ) : null}
            </FieldGroup>
          ) : null}

          {sections.party ? (
            <FieldGroup legend="GST registration" description="Typing a valid GSTIN fills the state and PAN for you." columns={2}>
              <Field
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
              {/* Shown for unregistered / consumer parties too: typing a valid GSTIN makes the party Regular. */}
              {d.registrationType !== 'overseas' ? (
                <Field label={d.registrationType === 'uin' ? 'UIN' : 'GSTIN'} error={err('gstin')} hint={gstinOkText(d.gstin) ? <OkHint>{gstinOkText(d.gstin)}</OkHint> : '15 characters, e.g. 27AAPFU0939F1ZV'}>
                  <TextInput value={d.gstin} onChange={(e) => onGstin(e.target.value)} readOnly={readOnly} uppercase mono maxLength={15} spellCheck={false} autoComplete="off" />
                </Field>
              ) : (
                <span />
              )}
              <Field label="E-commerce operator" hint="Amazon, Flipkart and similar operators that collect TCS.">
                <Switch checked={d.isEcommerceOperator} onChange={(v) => set('isEcommerceOperator', v)} disabled={readOnly} aria-label="E-commerce operator" />
              </Field>
            </FieldGroup>
          ) : null}

          {sections.bank ? (
            <FieldGroup legend="Bank details" description="Printed on invoices for payment, and used for cheques." columns={2}>
              <Field label="Account holder name" optional>
                <TextInput value={d.bankAccountHolder} onChange={(e) => set('bankAccountHolder', e.target.value)} readOnly={readOnly} maxLength={200} />
              </Field>
              <Field label="Account number" optional error={err('bankAccountNo')}>
                <TextInput value={d.bankAccountNo} onChange={(e) => set('bankAccountNo', e.target.value)} readOnly={readOnly} mono inputMode="numeric" maxLength={24} />
              </Field>
              <Field label="IFSC" optional error={err('bankIfsc')} hint={d.bankIfsc.trim().length === 11 && !err('bankIfsc') ? <OkHint>Valid IFSC · bank code {d.bankIfsc.trim().toUpperCase().slice(0, 4)}</OkHint> : 'e.g. HDFC0001234'}>
                <TextInput value={d.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase().slice(0, 11))} readOnly={readOnly} uppercase mono spellCheck={false} />
              </Field>
              <Field label="Bank name" optional>
                <TextInput value={d.bankName} onChange={(e) => set('bankName', e.target.value)} readOnly={readOnly} maxLength={100} />
              </Field>
              <Field label="Branch" optional>
                <TextInput value={d.bankBranch} onChange={(e) => set('bankBranch', e.target.value)} readOnly={readOnly} maxLength={100} />
              </Field>
              <Field label="UPI ID" optional error={err('bankUpiId')} hint="Printed as a QR code on invoices.">
                <TextInput value={d.bankUpiId} onChange={(e) => set('bankUpiId', e.target.value.trim())} readOnly={readOnly} placeholder="shop@okhdfcbank" maxLength={100} />
              </Field>
              <Field label="Cheque book" hint="Keep track of cheque numbers for this account.">
                <Switch checked={d.chequeBookEnabled} onChange={(v) => set('chequeBookEnabled', v)} disabled={readOnly} aria-label="Cheque book" />
              </Field>
            </FieldGroup>
          ) : null}

          {sections.tax ? (
            <FieldGroup legend="Tax ledger" description={reserved ? 'Built-in tax ledgers keep their tax settings.' : 'What kind of tax this ledger holds.'} columns={2}>
              <Field label="Type of duty / tax" error={err('taxType')}>
                <Select<LedgerTaxType | ''> value={d.taxType} onChange={(v) => set('taxType', v)} disabled={readOnly || !!reserved} options={TAX_TYPE_OPTIONS} />
              </Field>
              {d.taxType === 'GST' ? (
                <>
                  <Field label="GST duty head" required error={err('gstDutyHead')}>
                    <Select<GstDutyHead | ''> value={d.gstDutyHead} onChange={(v) => set('gstDutyHead', v)} disabled={readOnly || !!reserved} options={DUTY_HEAD_OPTIONS} />
                  </Field>
                  <Field label="Used for" error={err('gstTaxDirection')}>
                    <Select<GstTaxDirection | ''> value={d.gstTaxDirection} onChange={(v) => set('gstTaxDirection', v)} disabled={readOnly || !!reserved} options={DIRECTION_OPTIONS} />
                  </Field>
                </>
              ) : null}
            </FieldGroup>
          ) : null}

          {sections.gstDetails ? (
            <FieldGroup legend="GST details" description="Used when an invoice line has no stock item, or the item has no rate." columns={2}>
              <Field label="GST applicable">
                <Switch checked={d.gstApplicable} onChange={(v) => set('gstApplicable', v)} disabled={readOnly} aria-label="GST applicable" />
              </Field>
              {gstOn ? (
                <>
                  <Field label="Taxability" error={err('gstTaxability')}>
                    <Select<Taxability> value={d.gstTaxability} onChange={(v) => set('gstTaxability', v)} disabled={readOnly} options={TAXABILITY_OPTIONS} />
                  </Field>
                  {d.gstTaxability === 'taxable' ? (
                    <>
                      <Field label="GST rate" error={err('gstRate')} hint={rateValue === '' ? 'Each stock item’s own rate is used.' : undefined}>
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
                        <Field label="Notified rate" error={err('gstRate')} hint="A rate prescribed by a notification that is not a regular slab.">
                          <PercentInput value={d.gstRate} onChange={(v) => set('gstRate', v)} max={100} readOnly={readOnly} />
                        </Field>
                      ) : null}
                      <Field label="Cess rate" optional error={err('cessRate')}>
                        <PercentInput value={d.cessRate} onChange={(v) => set('cessRate', v)} max={400} readOnly={readOnly} blankZero />
                      </Field>
                    </>
                  ) : null}
                  <Field label="HSN / SAC" optional error={err('hsnSac')} hint="4, 6 or 8 digits. SAC codes (services) start with 99.">
                    <TextInput value={d.hsnSac} onChange={(e) => set('hsnSac', e.target.value.replace(/\D/g, '').slice(0, 8))} readOnly={readOnly} inputMode="numeric" mono />
                  </Field>
                  <Field label="Goods or services" error={err('gstSupplyType')}>
                    <Select<SupplyKind | ''> value={d.gstSupplyType} onChange={(v) => set('gstSupplyType', v)} disabled={readOnly} options={SUPPLY_OPTIONS} />
                  </Field>
                  {sections.gstInward ? (
                    <>
                      <Field label="Reverse charge" error={err('isReverseCharge')} hint="Tax is paid by you, not the supplier (e.g. GTA, legal services).">
                        <Switch checked={d.isReverseCharge} onChange={(v) => set('isReverseCharge', v)} disabled={readOnly} aria-label="Reverse charge" />
                      </Field>
                      <Field label="Input tax credit" error={err('itcEligibility')}>
                        <Select<ItcEligibility | ''> value={d.itcEligibility} onChange={(v) => set('itcEligibility', v)} disabled={readOnly} options={ITC_OPTIONS} />
                      </Field>
                    </>
                  ) : null}
                </>
              ) : null}
              {sections.gstCharges ? (
                <>
                  <Field label="Include in assessable value" hint="For charges like freight or packing that add to the taxable value of an invoice.">
                    <Select<IncludeInAssessable | ''>
                      value={d.includeInAssessable === 'none' ? '' : d.includeInAssessable}
                      onChange={(v) => set('includeInAssessable', v)}
                      disabled={readOnly}
                      options={ASSESSABLE_OPTIONS}
                    />
                  </Field>
                  {d.includeInAssessable === 'goods' || d.includeInAssessable === 'services' ? (
                    <Field label="Spread over the items">
                      <Select<AppropriateBy> value={d.appropriateBy || 'value'} onChange={(v) => set('appropriateBy', v)} disabled={readOnly} options={APPROPRIATE_OPTIONS} />
                    </Field>
                  ) : null}
                </>
              ) : null}
              {historyEffect === 'dated' ? (
                <Field
                  label="These GST details apply from"
                  optional
                  error={err('applicableFrom')}
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
              ) : null}
              {historyEffect === 'removes' && original && original.gstRateHistory.length > 0 ? (
                <Banner tone="warning" inline>
                  {d.gstApplicable
                    ? 'Without a rate, each invoice line takes the stock item’s rate, and this ledger’s dated GST rate history is removed.'
                    : 'GST will not apply to this ledger, and its dated GST rate history is removed.'}{' '}
                  To change the rate only from a date, choose the new rate or taxability (e.g. Exempt) instead and give the date.
                </Banner>
              ) : null}
            </FieldGroup>
          ) : null}

          {original && sections.gstDetails && original.gstRateHistory.length > 0 ? <GstHistoryTable original={original} /> : null}

          {sections.costCentres || sections.inventoryValues || sections.tds ? (
            <FieldGroup legend="Other settings" columns={2}>
              {sections.costCentres ? (
                <Field label="Cost centres applicable" hint="Ask for cost centres when this ledger is used in a voucher.">
                  <Switch checked={d.costCentresApplicable} onChange={(v) => set('costCentresApplicable', v)} disabled={readOnly} aria-label="Cost centres applicable" />
                </Field>
              ) : null}
              {sections.inventoryValues ? (
                <Field label="Inventory values are affected" hint="Invoices with this ledger carry stock items (sales and purchase ledgers).">
                  <Switch checked={d.inventoryValuesAffected} onChange={(v) => set('inventoryValuesAffected', v)} disabled={readOnly} aria-label="Inventory values are affected" />
                </Field>
              ) : null}
              {sections.tds ? (
                <>
                  <Field label="TDS applicable">
                    <Switch checked={d.tdsApplicable} onChange={(v) => set('tdsApplicable', v)} disabled={readOnly} aria-label="TDS applicable" />
                  </Field>
                  {d.tdsApplicable ? (
                    <Field label="TDS section" optional error={err('tdsSection')} hint="e.g. 194C contractors, 194J professional fees.">
                      <TextInput value={d.tdsSection} onChange={(e) => set('tdsSection', e.target.value.toUpperCase().slice(0, 20))} readOnly={readOnly} mono />
                    </Field>
                  ) : null}
                  {/* tds module: the deduction itself uses the ledger's TDS / TCS details (nature, deductee type, PAN, certificate). */}
                  {original ? (
                    <Field label="TDS / TCS details" hint="Nature of payment, deductee type, PAN and lower-deduction certificate used to work out TDS on vouchers.">
                      <Button size="sm" icon="percent" onClick={() => nav.push('tds.ledger.form', { ledgerId: original.id })}>
                        Open TDS / TCS details
                      </Button>
                    </Field>
                  ) : null}
                </>
              ) : null}
            </FieldGroup>
          ) : null}

          {!original && !forResult ? (
            <span className="bx-muted">After saving, a fresh form opens under the same group for the next ledger. Press Alt+S to save and close instead.</span>
          ) : null}
          {app.company?.gstEnabled === false && sections.party ? (
            <span className="bx-muted">GST is off for this company (F11); registration details are still stored for when you turn it on.</span>
          ) : null}
        </Stack>
      </div>
      </div>
    </Screen>
  );
}

function groupHint(cls: NonNullable<ReturnType<typeof classOfGroup>>): string {
  if (cls.isDebtor) return 'A customer — bills, credit period and GST registration below.';
  if (cls.isCreditor) return 'A supplier — bills, credit period and GST registration below.';
  if (cls.isBank) return 'A bank account — account details below.';
  if (cls.isCash) return 'Cash in hand.';
  if (cls.isDutyTax) return 'A tax ledger — choose the tax below.';
  if (cls.isSales) return 'A sales account — GST details below.';
  if (cls.isPurchase) return 'A purchase account — GST details below.';
  if (cls.isIncome) return 'Income — shown in Profit & Loss.';
  if (cls.isExpense) return 'An expense — shown in Profit & Loss.';
  return cls.nature === 'assets' ? 'An asset — shown in the Balance Sheet.' : 'A liability — shown in the Balance Sheet.';
}

function CurrencyField({ value, onChange, readOnly, error }: { value: number | null; onChange: (v: number | null) => void; readOnly: boolean; error?: string }) {
  const q = useApiQuery('accounts.currency.list', {});
  const options = (q.data?.rows ?? []).map((c) => ({ value: String(c.id), label: `${c.symbol} — ${c.formalName}${c.isBase ? ' (base)' : ''}` }));
  return (
    <Field label="Currency" optional error={error} hint="For ledgers kept in a foreign currency.">
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
    <FieldGroup legend="GST rate history" description="Invoices use the details in force on their date. Newest first.">
      <div data-enter-ignore>
        <DataTable aria-label="GST rate history" columns={columns} rows={rows} getRowKey={(r) => String(r.id)} height={Math.min(220, 40 + rows.length * 34)} typeToJump={false} />
      </div>
    </FieldGroup>
  );
}
