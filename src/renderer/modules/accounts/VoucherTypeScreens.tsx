/**
 * 'accounts.voucherTypes' — voucher types (built-in and your own) with their numbering.
 *   Enter alter · Alt+C create a type based on the highlighted one · Alt+D (or Ctrl+D) delete · Alt+E / Alt+P
 *   export / print and the checkable "Hide inactive types" in More ▾ (2.1).
 * 'accounts.voucherType.form' — Voucher Type Creation / Alteration. Params { id? | parentId? | baseType? }.
 *   2.1: Name, Based on and ONE numbering line on screen — the line opens the Invoice Numbering editor
 *   (SeriesDrawer, 'draft': prefix / suffix, digits, restart, method, dated prefix / suffix rows under its
 *   Advanced, the live preview and the GST invoice-number checks); the form's Save sends it with the rest.
 *   Abbreviation, alias, active, behaviour switches, defaults (ledger, party, invoice mode, godown) and
 *   printing (title, declaration, terms, bank, template) sit behind "More details".
 */
import { useId, useMemo, useRef, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { NumberingMethod, VoucherNumbering, VoucherTypeConfig, VoucherTypeDetail, VoucherTypeRow, VoucherTypeSaveInput } from '../../../shared/types/accounts.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, nestedFieldErrors, userMessage } from '../../app/lib/apiErrors.ts';
import { checkItem } from '../../app/lib/moreItems.ts';
import { useNav } from '../../app/nav.tsx';
import { setMoreDetailsOpen, useUiPrefs } from '../../app/preferences.ts';
import { invalidate } from '../../app/queryClient.ts';
import type { ScreenProps } from '../../app/registry.ts';
import { ReadOnlyNotice, ReportScreen, Screen } from '../../app/Screen.tsx';
import { useCan, useCompany } from '../../app/state.tsx';
import { useBooks, useWorkingDate } from '../../app/working.tsx';
import {
  Banner,
  Button,
  DataTable,
  DisclosureLine,
  EmptyState,
  Field,
  Select,
  Switch,
  TextArea,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { focusFirstInvalid, NameCell } from './components.tsx';
import { voucherTypeMoreRevealed, voucherTypeUsual } from './lib/formReveal.ts';
import {
  BASE_TYPE_LABELS,
  checkNumbering,
  defaultLedgerSide,
  GST_DOCUMENT_BASE_TYPES,
  isInvoiceBase,
  METHOD_OPTIONS,
  movesStock,
  newTypeNumbering,
  numberingPreview,
  numberingSummary,
  seriesClashes,
  seriesClashWarning,
} from './lib/numbering.ts';
import { LedgerPicker } from './pickers.tsx';
import { SeriesDrawer } from './SeriesDrawer.tsx';

const methodLabel = (m: NumberingMethod): string => METHOD_OPTIONS.find((o) => o.value === m)?.label ?? m;

// ───────────────────────────── List ─────────────────────────────

export function VoucherTypesScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 150);
  const q = useApiQuery('accounts.voucherType.list', { search: debounced || undefined, activeOnly: activeOnly || undefined }, { keepPrevious: true });
  const rows = q.data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? null;

  const columns = useMemo<Column<VoucherTypeRow>[]>(
    () => [
      { key: 'name', header: 'Voucher type', render: (r) => <NameCell name={r.name} alias={r.abbreviation} inactive={!r.isActive} />, sortable: true, sortValue: (r) => r.name },
      { key: 'baseType', header: 'Type of voucher', width: 150, value: (r) => BASE_TYPE_LABELS[r.baseType], sortable: true },
      // One column (2.1): the first number when numbered automatically, else how numbers are given.
      { key: 'sample', header: 'Numbering', width: 190, render: (r) => <span className="bx-num">{numberingPreview(r.numbering)?.first ?? methodLabel(r.numbering.method)}</span>, value: (r) => numberingPreview(r.numbering)?.first ?? methodLabel(r.numbering.method) },
      { key: 'hotkey', header: 'Key', width: 80 },
      { key: 'voucherCount', header: 'Vouchers', kind: 'number', width: 100, blankZero: true },
    ],
    [],
  );

  const remove = async () => {
    if (!current) return;
    if (current.isPredefined) {
      toast.info(`“${current.name}” is a built-in voucher type`, { message: 'Built-in types cannot be deleted. Change their numbering or settings instead.' });
      return;
    }
    if (!(await confirm({ title: `Delete voucher type “${current.name}”?`, message: 'A type that has vouchers, or other types based on it, cannot be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('accounts.voucherType.delete', { id: current.id });
      invalidate('accounts');
      invalidate('vouchers');
      toast.success(`Voucher type “${current.name}” deleted`);
    } catch (err) {
      toast.error(`“${current.name}” cannot be deleted`, { message: userMessage(err), duration: 10_000 });
    }
  };

  return (
    <ReportScreen
      title="Voucher Types"
      subtitle={q.data ? `${q.data.total} types` : undefined}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      outputInMore
      hint="Enter Alter · Alt+C Create based on the highlighted type · Alt+D Delete · Alt+E Export · Esc Back"
      actions={[
        {
          key: 'Alt+C',
          label: 'Create type',
          icon: 'plus',
          disabled: !canCreate,
          onClick: () => nav.push('accounts.voucherType.form', current ? { parentId: current.id } : {}),
          prominent: true,
        },
        checkItem('Hide inactive types', activeOnly, setActiveOnly),
        { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', group: 'danger', disabled: !canDelete || !current || current.isPredefined, onClick: () => void remove() },
      ]}
      filters={<TextInput size="sm" wrapperClassName="bx-acc-toolbar__search" value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Find a voucher type" aria-label="Find a voucher type" />}
      exportDef={() => ({
        columns: [{ header: 'Voucher type' }, { header: 'Type of voucher' }, { header: 'Numbering' }, { header: 'First number' }, { header: 'Vouchers', kind: 'number' }],
        rows: rows.map((r) => [r.name, BASE_TYPE_LABELS[r.baseType], methodLabel(r.numbering.method), numberingPreview(r.numbering)?.first ?? '', r.voucherCount]),
      })}
    >
      <DataTable<VoucherTypeRow>
        aria-label="Voucher types"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={cursor}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(r) => nav.push('accounts.voucherType.form', { id: r.id })}
        loading={q.loading}
        hideEmptyColumns
        empty={<EmptyState title="No voucher type matches" body="Change the search." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export interface VoucherTypeFormParams {
  id?: number;
  parentId?: number;
  baseType?: VoucherBaseType;
}

export function VoucherTypeFormScreen({ params }: ScreenProps<VoucherTypeFormParams>) {
  const isAlter = typeof params.id === 'number';
  const q = useApiQuery('accounts.voucherType.get', { id: params.id ?? 0 }, { enabled: isAlter });
  const list = useApiQuery('accounts.voucherType.list', {});
  const types = list.data?.rows ?? [];
  if ((isAlter && !q.data) || (!list.data && (list.loading || list.error))) {
    return (
      <Screen
        title={isAlter ? 'Voucher Type Alteration' : 'Voucher Type Creation'}
        icon="journal"
        width="form"
        loading={q.loading || list.loading}
        error={q.error ?? list.error}
        onRetry={() => {
          void q.refetch();
          void list.refetch();
        }}
      />
    );
  }
  return <VoucherTypeForm key={q.data ? `${q.data.id}:${q.data.updatedAt}` : 'new'} original={q.data ?? null} params={params} types={types} />;
}

interface VtDraft {
  name: string;
  alias: string;
  abbreviation: string;
  parentId: number | null;
  isActive: boolean;
  numbering: VoucherNumbering;
  preventDuplicates: boolean;
  useEffectiveDate: boolean;
  allowZeroValue: boolean;
  optionalByDefault: boolean;
  narrationPerEntry: boolean;
  printAfterSave: boolean;
  config: Required<{ [K in keyof VoucherTypeConfig]: VoucherTypeConfig[K] | null }>;
}

const EMPTY_CONFIG: VtDraft['config'] = {
  defaultLedgerId: null,
  defaultPartyLedgerId: null,
  printTitle: null,
  declaration: null,
  terms: null,
  bankLedgerId: null,
  invoiceMode: null,
  defaultGodownId: null,
  printTemplate: null,
  stockJournalClass: null,
  showMrp: null,
  posInvoice: null,
  // (2.0, print layout — edited from the print preview; kept as loaded, sent only when changed)
  showHsnSummary: null,
  showBankDetails: null,
  showUpiQr: null,
  itemwiseTax: null,
  printLayout: null,
};

function draftOf(vt: VoucherTypeDetail | null, parent: VoucherTypeRow | null): VtDraft {
  if (!vt) {
    return {
      name: '',
      alias: '',
      abbreviation: '',
      parentId: parent?.id ?? null,
      isActive: true,
      // Like the core: the parent's method/padding/restart but its own series (no prefix, from 1).
      numbering: newTypeNumbering(parent?.numbering ?? null),
      preventDuplicates: false,
      useEffectiveDate: false,
      allowZeroValue: false,
      optionalByDefault: false,
      narrationPerEntry: false,
      printAfterSave: false,
      config: { ...EMPTY_CONFIG },
    };
  }
  return {
    name: vt.name,
    alias: vt.alias ?? '',
    abbreviation: vt.abbreviation ?? '',
    parentId: vt.parentId,
    isActive: vt.isActive,
    numbering: { ...vt.numbering },
    preventDuplicates: vt.preventDuplicates,
    useEffectiveDate: vt.useEffectiveDate,
    allowZeroValue: vt.allowZeroValue,
    optionalByDefault: vt.optionalByDefault,
    narrationPerEntry: vt.narrationPerEntry,
    printAfterSave: vt.printAfterSave,
    config: { ...EMPTY_CONFIG, ...vt.config },
  };
}

const FLAGS: ReadonlyArray<{ key: 'preventDuplicates' | 'useEffectiveDate' | 'allowZeroValue' | 'optionalByDefault' | 'narrationPerEntry' | 'printAfterSave'; label: string; hint: string }> = [
  { key: 'preventDuplicates', label: 'Prevent duplicate numbers', hint: 'Refuse a number already used in the same numbering period.' },
  { key: 'useEffectiveDate', label: 'Use effective dates', hint: 'Enter a separate date from which the voucher takes effect.' },
  { key: 'allowZeroValue', label: 'Allow zero-value vouchers', hint: 'e.g. free samples or replacements.' },
  { key: 'optionalByDefault', label: 'Make vouchers optional by default', hint: 'Optional vouchers do not affect the books until made regular.' },
  { key: 'narrationPerEntry', label: 'Narration for each entry', hint: 'A separate note on every line, not just the voucher.' },
  { key: 'printAfterSave', label: 'Print after saving', hint: 'Open the print preview each time a voucher is saved.' },
];

function VoucherTypeForm({ original, params, types }: { original: VoucherTypeDetail | null; params: VoucherTypeFormParams; types: readonly VoucherTypeRow[] }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const company = useCompany();
  const { fyStartMonth } = useBooks();
  const { date: workingDate } = useWorkingDate();
  const canSave = useCan(original ? 'masters.alter' : 'masters.create');
  const canDelete = useCan('masters.delete');
  const canAudit = useCan('audit.view');
  const save = useApiMutation('accounts.voucherType.save', { invalidates: ['vouchers', 'print'] });
  const initialParent = useMemo(() => {
    if (typeof params.parentId === 'number') return types.find((t) => t.id === params.parentId) ?? null;
    if (params.baseType) return types.find((t) => t.isPredefined && t.baseType === params.baseType) ?? null;
    return null;
  }, [params.parentId, params.baseType, types]);
  const baselineRef = useRef(draftOf(original, initialParent));
  const [d, setD] = useState<VtDraft>(baselineRef.current);
  const [numberingOpen, setNumberingOpen] = useState(false);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const numberingId = useId();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formBox = useRef<HTMLDivElement>(null);
  const predefined = original?.isPredefined ?? false;
  const readOnly = !canSave;
  const parent = d.parentId !== null ? (types.find((t) => t.id === d.parentId) ?? null) : null;
  const baseType: VoucherBaseType | null = original?.baseType ?? parent?.baseType ?? null;
  const dirty = JSON.stringify(d) !== JSON.stringify(baselineRef.current);
  const gstDoc = baseType !== null && GST_DOCUMENT_BASE_TYPES.includes(baseType);
  const check = baseType ? checkNumbering(baseType, d.numbering, company.gstEnabled) : { errors: [], warnings: [] };
  const clash = baseType && company.gstEnabled ? seriesClashWarning(seriesClashes(types, original?.id ?? null, baseType, d.numbering), d.numbering) : null;
  const warnings = clash ? [...check.warnings, clash] : check.warnings;
  const next = useApiQuery('vouchers.nextNumber', { voucherTypeId: original?.id ?? 0, date: workingDate }, { enabled: original !== null && d.numbering.method !== 'none' });
  const side = baseType ? defaultLedgerSide(baseType) : null;
  const godowns = useApiQuery('inventory.godown.list', {}, { enabled: company.features.inventory && company.features.multipleGodowns && baseType !== null && movesStock(baseType) });

  const set = <K extends keyof VtDraft>(k: K, v: VtDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => withoutKey(e, k));
  };
  /** New type: choosing another "based on" type also takes its numbering, unless numbering was edited. */
  const setParent = (id: number | null) => {
    setD((x) => {
      if (original) return { ...x, parentId: id };
      const was = types.find((t) => t.id === x.parentId) ?? null;
      const untouched = JSON.stringify(x.numbering) === JSON.stringify(newTypeNumbering(was?.numbering ?? null));
      const now = types.find((t) => t.id === id) ?? null;
      return { ...x, parentId: id, numbering: untouched ? newTypeNumbering(now?.numbering ?? null) : x.numbering };
    });
    setErrors((e) => withoutKey(e, 'parentId'));
  };
  const setNum = <K extends keyof VoucherNumbering>(k: K, v: VoucherNumbering[K]) => {
    setD((x) => ({ ...x, numbering: { ...x.numbering, [k]: v } }));
    setErrors((e) => withoutKey(e, `numbering.${k}`));
  };
  const setCfg = <K extends keyof VtDraft['config']>(k: K, v: VtDraft['config'][K]) => {
    setD((x) => ({ ...x, config: { ...x.config, [k]: v } }));
    setErrors((e) => withoutKey(e, `config.${k}`));
  };

  const buildInput = (): VoucherTypeSaveInput => {
    const base = baselineRef.current;
    const input: VoucherTypeSaveInput = original ? { id: original.id } : {};
    const changed = <K extends keyof VtDraft>(k: K): boolean => !original || JSON.stringify(d[k]) !== JSON.stringify(base[k]);
    if (!predefined) {
      if (changed('name')) input.name = d.name.trim();
      if (!original && d.parentId !== null) input.parentId = d.parentId;
      if (original && changed('parentId') && d.parentId !== null) input.parentId = d.parentId;
      if (changed('isActive')) input.isActive = d.isActive;
    }
    if (changed('alias')) input.alias = d.alias.trim() || null;
    if (changed('abbreviation')) input.abbreviation = d.abbreviation.trim() || null;
    if (changed('numbering')) input.numbering = { ...d.numbering, prefix: d.numbering.prefix || null, suffix: d.numbering.suffix || null };
    for (const f of FLAGS) if (changed(f.key)) input[f.key] = d[f.key];
    const cfg: VoucherTypeConfig = {};
    let anyCfg = false;
    for (const k of Object.keys(d.config) as Array<keyof VtDraft['config']>) {
      const now = d.config[k];
      const was = original ? base.config[k] : null;
      if (JSON.stringify(now ?? null) !== JSON.stringify(was ?? null)) {
        (cfg as Record<string, unknown>)[k] = typeof now === 'string' ? now.trim() || null : now;
        anyCfg = true;
      }
    }
    if (anyCfg) input.config = cfg;
    return input;
  };

  const submit = async () => {
    if (readOnly || save.pending) return;
    const e: Record<string, string> = {};
    if (!d.name.trim()) e.name = 'Enter the voucher type name';
    if (!original && d.parentId === null) e.parentId = 'Choose the voucher type this one is based on';
    for (const x of check.errors) e[x.path] = x.message;
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.error('Please correct the highlighted fields', { message: Object.values(e)[0] });
      focusFirstInvalid(formBox.current);
      return;
    }
    const input = buildInput();
    if (original && Object.keys(input).length === 1) {
      nav.pop();
      return;
    }
    if (original && input.numbering && original.voucherCount > 0) {
      const ok = await confirm({
        title: 'Change the numbering?',
        message: `${original.voucherCount} voucher${original.voucherCount === 1 ? '' : 's'} already use this type. Their numbers stay as they are; only new vouchers follow the new numbering.`,
        confirmLabel: 'Change numbering',
      });
      if (!ok) return;
    }
    try {
      const out = await save.mutate(input);
      toast.success(`Voucher type “${out.name}” saved`, { message: out.numberingWarnings[0] });
      nav.pop();
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (Object.keys(f).length > 0) {
        setErrors(f);
        focusFirstInvalid(formBox.current);
      }
      toast.error('The voucher type was not saved', { message: Object.values(f)[0] ?? userMessage(err) });
    }
  };

  const remove = async () => {
    if (!original || predefined) return;
    if (!(await confirm({ title: `Delete voucher type “${original.name}”?`, message: 'A type that has vouchers, or other types based on it, cannot be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('accounts.voucherType.delete', { id: original.id });
      invalidate('accounts');
      invalidate('vouchers');
      toast.success(`Voucher type “${original.name}” deleted`);
      nav.pop();
    } catch (err) {
      toast.error(`“${original.name}” cannot be deleted`, { message: userMessage(err), duration: 10_000 });
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const cfgErr = nestedFieldErrors(errors, 'config');
  const numberingError = Object.entries(errors).find(([k]) => k.startsWith('numbering'))?.[1];
  const parentOptions = types.filter((t) => t.id !== original?.id).map((t) => ({ value: String(t.id), label: `${t.name} (${BASE_TYPE_LABELS[t.baseType]})` }));
  const godownOptions = (godowns.data?.rows ?? []).map((g) => ({ value: String(g.id), label: g.name }));
  const summary = numberingSummary(d.numbering, workingDate, fyStartMonth);
  // 2.1: abbreviation, alias, active and the Behaviour / Defaults / Printing sections sit behind "More details";
  // a value chosen there (not what the books give a type by themselves) or an error opens it (lib/formReveal.ts).
  const prefs = useUiPrefs();
  const usual = useMemo(() => voucherTypeUsual(original, d.name), [original, d.name]);
  const revealed = voucherTypeMoreRevealed(d, errors, usual);
  const moreOpen = prefs.moreDetails[VOUCHER_TYPE_FORM_KIND] === true || revealed;

  return (
    <Screen
      title={original ? 'Voucher Type Alteration' : 'Voucher Type Creation'}
      subtitle={original ? `${BASE_TYPE_LABELS[original.baseType]}${original.parentName ? ` · based on ${original.parentName}` : ''}${original.hotkey ? ` · ${original.hotkey}` : ''} · ${original.voucherCount} voucher${original.voucherCount === 1 ? '' : 's'}` : 'A kind of entry with its own numbering and print settings, e.g. "Cash Sales".'}
      width="form"
      dirty={dirty || drawerDirty}
      meta={original && !original.isActive ? <span className="bx-acc-warn">Inactive</span> : undefined}
      hint="Enter Next field · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly },
        { key: '', label: 'Invoice Numbering', onClick: () => nav.push('accounts.numbering'), group: 'more', hint: 'Every number series on one screen, with the next numbers and the gaps of the year' },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !original || predefined || !canDelete, group: 'danger' },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => original && nav.push('security.audit', { entityType: 'voucher_type', entityId: original.id, entityGuid: original.guid, label: original.name }),
          hidden: !original || !canAudit,
          group: 'more',
        },
      ]}
    >
      <div ref={formBox}>
      <div ref={formRef} className="bx-acc-form">
          {readOnly ? <ReadOnlyNotice what="voucher types" /> : null}
          <Field layout="inline" label="Name" required error={errors.name || undefined}>
            <TextInput data-autofocus value={d.name} onChange={(e) => set('name', e.target.value)} readOnly={readOnly || predefined} maxLength={60} />
          </Field>
          <Field layout="inline" label="Based on" required={!original} error={errors.parentId || undefined} hint={baseType ? `Works like ${BASE_TYPE_LABELS[baseType]}.` : 'Its behaviour (sales, payment, journal…) comes from this type.'}>
            <Select value={d.parentId === null ? '' : String(d.parentId)} onChange={(v) => setParent(v === '' ? null : Number(v))} disabled={readOnly || predefined} placeholder="Choose…" options={parentOptions} />
          </Field>
          {/* 2.1: the numbering is one line; it opens the Invoice Numbering editor (dated rows under its Advanced). */}
          <Field
            layout="inline"
            label="Numbering"
            htmlFor={numberingId}
            error={numberingError}
            hint={original && next.data && JSON.stringify(d.numbering) === JSON.stringify(baselineRef.current.numbering) ? `Next voucher: ${next.data}` : undefined}
            hintApplies
          >
            <Button id={numberingId} variant="link" disabled={!baseType} title={baseType ? 'Change the numbering' : 'Choose what it is based on first'} onClick={() => setNumberingOpen(true)}>
              {summary} ›
            </Button>
          </Field>
          {check.errors.length > 0 ? (
            <Banner tone="danger" title={gstDoc && company.gstEnabled ? 'This numbering cannot be used for GST documents' : 'Fix the numbering'}>
              <ul>
                {check.errors.map((x) => (
                  <li key={x.path + x.message}>{x.message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {warnings.length > 0 ? (
            <Banner tone="warning" title="Check the numbering">
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Banner>
          ) : null}

          <DisclosureLine summary="abbreviation, behaviour, defaults, printing" open={moreOpen} forceOpen={revealed} onToggle={(open) => setMoreDetailsOpen(VOUCHER_TYPE_FORM_KIND, open)} className="bx-acc-form__more" regionClassName="bx-acc-form">
          <section className="bx-acc-form" aria-label="General">
            <h2 className="bx-acc-form__title">General</h2>
            <Field layout="inline" label="Abbreviation" optional error={errors.abbreviation || undefined} hint="Short name shown in registers.">
              <TextInput value={d.abbreviation} onChange={(e) => set('abbreviation', e.target.value)} readOnly={readOnly} maxLength={10} />
            </Field>
            <Field layout="inline" label="Alias" optional error={errors.alias || undefined}>
              <TextInput value={d.alias} onChange={(e) => set('alias', e.target.value)} readOnly={readOnly} maxLength={60} />
            </Field>
            <Field layout="inline" label="Active" hint={predefined ? 'Built-in types are always active.' : 'Inactive types are hidden when entering vouchers.'}>
              <Switch checked={d.isActive} onChange={(v) => set('isActive', v)} disabled={readOnly || predefined} aria-label="Active" />
            </Field>
          </section>

          <section className="bx-acc-form" aria-label="Behaviour">
            <h2 className="bx-acc-form__title">Behaviour</h2>
            {FLAGS.map((f) => (
              <Field key={f.key} layout="inline" label={f.label} hint={f.hint}>
                <Switch checked={d[f.key]} onChange={(v) => set(f.key, v)} disabled={readOnly} aria-label={f.label} />
              </Field>
            ))}
          </section>

          {baseType ? (
            <section className="bx-acc-form" aria-label="Defaults for new vouchers">
              <h2 className="bx-acc-form__title">Defaults for new vouchers</h2>
              {side ? (
                <Field layout="inline" label={side === 'sales' ? 'Default sales ledger' : 'Default purchase ledger'} optional error={cfgErr.defaultLedgerId}>
                  <LedgerPicker classes={[side]} value={d.config.defaultLedgerId ?? null} onChange={(id) => setCfg('defaultLedgerId', id)} readOnly={readOnly} showBalance={false} />
                </Field>
              ) : null}
              <Field layout="inline" label="Default party" optional error={cfgErr.defaultPartyLedgerId} hint="e.g. Cash for a Cash Sales type.">
                <LedgerPicker classes={['party', 'cash_bank']} value={d.config.defaultPartyLedgerId ?? null} onChange={(id) => setCfg('defaultPartyLedgerId', id)} readOnly={readOnly} showBalance={false} />
              </Field>
              {isInvoiceBase(baseType) ? (
                <Field layout="inline" label="Invoice mode" error={cfgErr.invoiceMode} hint="Item invoice lists stock items; accounting invoice lists ledgers only.">
                  <Select
                    value={d.config.invoiceMode ?? ''}
                    onChange={(v) => setCfg('invoiceMode', v === '' ? null : v)}
                    disabled={readOnly}
                    options={[
                      { value: '', label: 'As set in F12' },
                      { value: 'item', label: 'Item invoice' },
                      { value: 'accounting', label: 'Accounting invoice' },
                    ]}
                  />
                </Field>
              ) : null}
              {baseType === 'stock_journal' && (company.features.manufacturing || company.features.jobWork || d.config.stockJournalClass) ? (
                <Field layout="inline" label="Use as" error={cfgErr.stockJournalClass} hint="Manufacturing Journal: build finished goods from a bill of materials. Material Out / In: job work challans.">
                  <Select
                    value={d.config.stockJournalClass ?? ''}
                    onChange={(v) => setCfg('stockJournalClass', v === 'manufacturing' || v === 'material_out' || v === 'material_in' ? v : null)}
                    disabled={readOnly || predefined || (original?.voucherCount ?? 0) > 0}
                    options={[
                      { value: '', label: 'Stock Journal' },
                      { value: 'manufacturing', label: 'Manufacturing Journal' },
                      { value: 'material_out', label: 'Material Out (job work)' },
                      { value: 'material_in', label: 'Material In (job work)' },
                    ]}
                  />
                </Field>
              ) : null}
              {baseType === 'sales' && (company.features.pos || d.config.posInvoice === true) ? (
                <Field layout="inline" label="Use as" error={cfgErr.posInvoice} hint="POS invoice: bills are entered on the POS counter (barcode scan, split payment, change, thermal receipt). Fixed once the type has vouchers.">
                  <Select
                    value={d.config.posInvoice === true ? 'pos' : ''}
                    onChange={(v) => setCfg('posInvoice', v === 'pos' ? true : null)}
                    disabled={readOnly || predefined || (original?.voucherCount ?? 0) > 0}
                    options={[
                      { value: '', label: 'Sales invoice' },
                      { value: 'pos', label: 'POS invoice (counter billing)' },
                    ]}
                  />
                </Field>
              ) : null}
              {godownOptions.length > 0 ? (
                <Field layout="inline" label="Default godown" optional error={cfgErr.defaultGodownId}>
                  <Select value={d.config.defaultGodownId === null || d.config.defaultGodownId === undefined ? '' : String(d.config.defaultGodownId)} onChange={(v) => setCfg('defaultGodownId', v === '' ? null : Number(v))} disabled={readOnly} placeholder="None" options={godownOptions} />
                </Field>
              ) : null}
            </section>
          ) : null}

          {baseType && (isInvoiceBase(baseType) || baseType === 'receipt' || baseType === 'sales_order' || baseType === 'delivery_note') ? (
            <section className="bx-acc-form" aria-label="Printing">
              <h2 className="bx-acc-form__title">Printing</h2>
              <Field layout="inline" label="Title on the document" optional error={cfgErr.printTitle} hint={baseType === 'sales' ? 'e.g. Tax Invoice, Bill of Supply.' : undefined}>
                <TextInput value={d.config.printTitle ?? ''} onChange={(e) => setCfg('printTitle', e.target.value)} readOnly={readOnly} maxLength={100} />
              </Field>
              <Field layout="inline" label="Bank details printed" optional error={cfgErr.bankLedgerId} hint="Overrides the bank chosen in Invoice Printing for this type.">
                <LedgerPicker classes={['bank']} value={d.config.bankLedgerId ?? null} onChange={(id) => setCfg('bankLedgerId', id)} readOnly={readOnly} showBalance={false} allowCreate={false} />
              </Field>
              <Field layout="inline" label="Template" error={cfgErr.printTemplate}>
                <Select
                  value={d.config.printTemplate ?? ''}
                  onChange={(v) => setCfg('printTemplate', v === '' ? null : v)}
                  disabled={readOnly}
                  options={[
                    { value: '', label: 'As set in Invoice Printing' },
                    { value: 'modern', label: 'Modern' },
                    { value: 'classic', label: 'Classic' },
                    { value: 'compact', label: 'Compact receipt (thermal roll)' },
                  ]}
                />
              </Field>
              {/* print group: MRP column on this type's documents. */}
              <Field layout="inline" label="MRP column" error={cfgErr.showMrp} hint="Prints the items' MRP (and 'You saved' on receipts).">
                <Select
                  value={d.config.showMrp === true ? 'yes' : d.config.showMrp === false ? 'no' : ''}
                  onChange={(v) => setCfg('showMrp', v === 'yes' ? true : v === 'no' ? false : null)}
                  disabled={readOnly}
                  options={[
                    { value: '', label: 'As set in Invoice Printing' },
                    { value: 'yes', label: 'Print MRP' },
                    { value: 'no', label: 'Do not print MRP' },
                  ]}
                />
              </Field>
              <Field layout="inline" label="Declaration" optional error={cfgErr.declaration}>
                <TextArea value={d.config.declaration ?? ''} onChange={(e) => setCfg('declaration', e.target.value)} readOnly={readOnly} rows={2} autoGrow maxRows={5} maxLength={2000} placeholder="We declare that this invoice shows the actual price of the goods described…" />
              </Field>
              <Field layout="inline" label="Terms & conditions" optional error={cfgErr.terms}>
                <TextArea value={d.config.terms ?? ''} onChange={(e) => setCfg('terms', e.target.value)} readOnly={readOnly} rows={2} autoGrow maxRows={6} maxLength={4000} />
              </Field>
            </section>
          ) : null}
          </DisclosureLine>
      </div>
      </div>
      {numberingOpen && baseType ? (
        <SeriesDrawer
          target={{ kind: 'draft', name: d.name, baseType, typeId: original?.id ?? null, numbering: d.numbering, readOnly, onApply: (n) => set('numbering', n) }}
          types={types}
          status={null}
          today={workingDate}
          fyStartMonth={fyStartMonth}
          onDirtyChange={setDrawerDirty}
          onClose={() => {
            setNumberingOpen(false);
            setDrawerDirty(false);
          }}
        />
      ) : null}
    </Screen>
  );
}

/** The ui-preference key of the voucher type form's "More details" (`moreDetails`). */
const VOUCHER_TYPE_FORM_KIND = 'voucherType';

function withoutKey(e: Record<string, string>, k: string): Record<string, string> {
  if (!(k in e)) return e;
  const copy = { ...e };
  delete copy[k];
  return copy;
}
