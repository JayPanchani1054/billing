/**
 * 'tds.natures' — Nature of Payment (TDS) / Nature of Goods (TCS): section, rates by deductee type,
 * no-PAN rate, thresholds, each effective from a date. Ctrl+1 / Ctrl+2 switch TDS / TCS, Enter
 * alters, Alt+C creates, Alt+D deletes (natures used on vouchers can only be marked inactive).
 * 'tds.nature.form' — create / alter one nature with its dated rate rows (Alt+R adds a row).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { TdsKind, TdsNature } from '../../../shared/types/tds.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { invalidate } from '../../app/queryClient.ts';
import type { ScreenProps } from '../../app/registry.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  IconButton,
  Inline,
  PercentInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { blankRate, enabledKinds, initialKind, KIND_LABEL, natureErrors, type RateDraft } from './lib/model.ts';
import { TdsOff } from './components.tsx';

const pct = (n: number | undefined | null): string => (n === undefined || n === null ? '' : `${n}%`);

export function NaturesScreen({ params }: ScreenProps<{ kind?: TdsKind }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const features = useFeatures();
  const canManage = useCan('tds.manage');
  const kinds = enabledKinds(features);
  const [kind, setKind] = useState<TdsKind | null>(initialKind(params?.kind, features));
  const k = kind && kinds.includes(kind) ? kind : (kinds[0] ?? null);
  const q = useApiQuery('tds.natures.list', { kind: k ?? 'tds', includeInactive: true }, { enabled: k !== null, keepPrevious: true });
  const rows = q.data ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? null;

  const columns = useMemo<Column<TdsNature>[]>(
    () => [
      { key: 'section', header: 'Section', width: 100, sortable: true },
      {
        key: 'name',
        header: k === 'tcs' ? 'Nature of goods' : 'Nature of payment',
        minWidth: 240,
        sortable: true,
        render: (r) => (
          <Inline gap={1} wrap={false}>
            <span className="bx-truncate">{r.name}</span>
            {!r.isActive ? <Badge size="sm">Inactive</Badge> : null}
            {r.forNonResidents ? <Badge size="sm" tone="info">Non-resident</Badge> : null}
          </Inline>
        ),
      },
      { key: 'ind', header: 'Individual / HUF', width: 120, align: 'right', value: (r) => pct(r.current?.rateIndividual) },
      { key: 'co', header: 'Company', width: 100, align: 'right', value: (r) => pct(r.current?.rateCompany) },
      { key: 'oth', header: 'Others', width: 90, align: 'right', value: (r) => pct(r.current?.rateOthers) },
      { key: 'nopan', header: 'No PAN', width: 90, align: 'right', value: (r) => pct(r.current?.rateNoPan) },
      { key: 'single', header: 'Single limit', kind: 'amount', width: 130, blankZero: true, value: (r) => r.current?.thresholdSingle ?? 0 },
      {
        key: 'agg',
        header: 'Yearly / monthly limit',
        kind: 'amount',
        width: 160,
        blankZero: true,
        value: (r) => r.current?.thresholdAggregate ?? 0,
        title: () => 'Aggregate threshold per party (per month for rent from 1-Apr-2025)',
      },
      { key: 'from', header: 'Rate from', kind: 'date', width: 110, value: (r) => r.current?.applicableFrom ?? '' },
      { key: 'usage', header: 'Used', kind: 'number', width: 70, value: (r) => r.usage ?? 0 },
    ],
    [k],
  );

  const remove = async (): Promise<void> => {
    if (!current) return;
    if (!(await confirm({ title: `Delete ${current.section} ${current.name}?`, message: 'Ledgers using it lose their nature.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('tds.natures.delete', { id: current.id });
      invalidate('tds');
      toast.success('Nature deleted');
    } catch (err) {
      toast.error('Cannot delete', { message: userMessage(err), duration: 10_000 });
    }
  };

  if (k === null) return <TdsOff title="Natures of Payment / Goods" />;
  return (
    <Screen
      title={k === 'tcs' ? 'Nature of Goods (TCS)' : 'Nature of Payment (TDS)'}
      subtitle="Sections, rates and thresholds. Rates in force today are shown; open a nature for its dated history."
      icon="percent"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create · Alt+D Delete · Ctrl+1 TDS · Ctrl+2 TCS · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create nature', icon: 'plus', primary: true, hidden: !canManage, disabled: !canManage, onClick: () => nav.push('tds.nature.form', { kind: k }) },
        { key: 'Alt+A', label: 'Alter', icon: 'edit', disabled: !current, onClick: () => current && nav.push('tds.nature.form', { id: current.id, kind: k }) },
        { key: 'Ctrl+1', label: 'TDS natures', group: 'view', hidden: !kinds.includes('tds'), disabled: k === 'tds', onClick: () => setKind('tds') },
        { key: 'Ctrl+2', label: 'TCS natures', group: 'view', hidden: !kinds.includes('tcs'), disabled: k === 'tcs', onClick: () => setKind('tcs') },
        { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', group: 'danger', hidden: !canManage, disabled: !canManage || !current || current.isSystem, onClick: () => void remove() },
      ]}
    >
      <Stack gap={3}>
        {kinds.length > 1 ? (
          <SegmentedControl<TdsKind> aria-label="TDS or TCS" size="sm" value={k} onChange={setKind} options={kinds.map((x) => ({ value: x, label: KIND_LABEL[x] }))} />
        ) : null}
        <DataTable<TdsNature>
          aria-label={k === 'tcs' ? 'Natures of goods' : 'Natures of payment'}
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          selectedKey={cursor}
          onSelect={(key) => setCursor(key)}
          onRowActivate={(r) => nav.push('tds.nature.form', { id: r.id, kind: k })}
          loading={q.loading}
          empty={<EmptyState title="No natures" body="Press Alt+C to create one." />}
        />
        <span className="bx-muted">
          Seeded for the Income-tax Act 1961 as in force for FY 2025-26 (Finance Act 2025). From 1-Apr-2026 the Income-tax Act 2025 applies: check the
          rates and sections against the latest Finance Act and alter them here when they change — add a dated rate row, never overwrite the old one.
        </span>
      </Stack>
    </Screen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

interface NatureDraft {
  name: string;
  section: string;
  section2025: string;
  forNonResidents: boolean;
  isActive: boolean;
  rates: RateDraft[];
}

export function NatureFormScreen({ params }: ScreenProps<{ id?: number; kind?: TdsKind }>) {
  const nav = useNav();
  const toast = useToast();
  const canManage = useCan('tds.manage');
  const { date: workingDate } = useWorkingDate();
  const existing = useApiQuery('tds.natures.get', { id: params.id ?? 0 }, { enabled: params.id !== undefined, staleTime: 0 });
  const kind: TdsKind = existing.data?.kind ?? params.kind ?? 'tds';
  const loaded = existing.data;
  const [draft, setDraft] = useState<NatureDraft | null>(null);
  const d: NatureDraft =
    draft ??
    (loaded
      ? {
          name: loaded.name,
          section: loaded.section,
          section2025: loaded.section2025 ?? '',
          forNonResidents: loaded.forNonResidents,
          isActive: loaded.isActive,
          rates: loaded.rates.map((r) => ({ ...r, id: undefined }) as RateDraft),
        }
      : { name: '', section: '', section2025: kind === 'tcs' ? '394' : '393', forNonResidents: false, isActive: true, rates: [blankRate(workingDate)] });
  const set = <K extends keyof NatureDraft>(key: K, value: NatureDraft[K]): void => setDraft({ ...d, [key]: value });
  const setRate = (i: number, patch: Partial<RateDraft>): void => setDraft({ ...d, rates: d.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useApiMutation('tds.natures.save');
  const readOnly = !canManage || (params.id !== undefined && !loaded);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  submitRef.current = async () => {
    if (save.pending || readOnly) return;
    const e = natureErrors(d);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      const out = await save.mutate({
        id: params.id,
        kind,
        name: d.name.trim(),
        section: d.section.trim(),
        section2025: d.section2025.trim() || undefined,
        forNonResidents: d.forNonResidents,
        isActive: d.isActive,
        rates: d.rates.map((r) => ({ ...r, note: r.note?.trim() ? r.note.trim() : null })),
      });
      toast.success(`${out.section} ${out.name} saved`);
      nav.pop();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(Object.keys(f).length > 0 ? f : { name: userMessage(err) });
    }
  };
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      formRef(el);
    },
    [formRef],
  );
  const addRate = (): void => {
    const last = d.rates[d.rates.length - 1];
    setDraft({ ...d, rates: [...d.rates, { ...(last ?? blankRate(workingDate)), applicableFrom: workingDate, note: null }] });
  };

  return (
    <Screen
      title={params.id ? `Alter ${KIND_LABEL[kind]} Nature` : `Create ${KIND_LABEL[kind]} Nature`}
      subtitle={loaded?.isSystem ? 'Came with the app — rates are yours to keep current.' : undefined}
      width="form"
      icon="percent"
      dirty={draft !== null}
      loading={existing.loading}
      error={existing.error}
      onRetry={() => void existing.refetch()}
      hint="Enter Next field · Alt+R Add rate row · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: readOnly || save.pending, onClick: accept },
        { key: 'Alt+R', label: 'Add rate row', icon: 'plus', disabled: readOnly, onClick: addRate },
      ]}
    >
      <div ref={setRoot}>
        <Stack gap={4}>
          {!canManage ? <Banner tone="info" inline>You can view natures; changing them needs the "Manage TDS/TCS setup" permission.</Banner> : null}
          <FieldGroup legend="Nature" columns={2}>
            <Field label="Name" required error={errors.name}>
              <TextInput data-autofocus value={d.name} onValueChange={(v) => set('name', v)} maxLength={120} readOnly={readOnly} />
            </Field>
            <Field label="Section (Income-tax Act 1961)" required error={errors.section} hint="As printed in returns: 194C, 194J(b), 206C(1F) …">
              <TextInput value={d.section} onValueChange={(v) => set('section', v.toUpperCase().replace(/\s+/g, '').slice(0, 20))} readOnly={readOnly} mono />
            </Field>
            <Field label="Income-tax Act 2025 reference" optional hint="For your records (s.393 TDS / s.394 TCS and the table entry).">
              <TextInput value={d.section2025} onValueChange={(v) => set('section2025', v.slice(0, 40))} readOnly={readOnly} />
            </Field>
            {kind === 'tds' ? (
              <Field label="Payments to non-residents" hint="Reported in 27Q instead of 26Q.">
                <Switch checked={d.forNonResidents} onChange={(v) => set('forNonResidents', v)} disabled={readOnly} aria-label="Payments to non-residents" />
              </Field>
            ) : null}
            <Field label="Active" hint="Inactive natures are not offered on ledgers or vouchers.">
              <Switch checked={d.isActive} onChange={(v) => set('isActive', v)} disabled={readOnly} aria-label="Active" />
            </Field>
          </FieldGroup>
          {errors.rates ? <Banner tone="danger" inline>{errors.rates}</Banner> : null}
          {d.rates.map((r, i) => (
            <FieldGroup
              key={i}
              legend={`Rates from ${r.applicableFrom ? formatDate(r.applicableFrom) : '—'}`}
              columns={4}
              description={r.note ?? undefined}
            >
              <Field label="Applicable from" required error={errors[`rates[${i}].applicableFrom`]}>
                <DateInput value={r.applicableFrom || null} onChange={(v) => setRate(i, { applicableFrom: v ?? '' })} referenceDate={workingDate} readOnly={readOnly} />
              </Field>
              <Field label="Individual / HUF %">
                <PercentInput value={r.rateIndividual} onChange={(v) => setRate(i, { rateIndividual: v ?? 0 })} readOnly={readOnly} />
              </Field>
              <Field label="Company %">
                <PercentInput value={r.rateCompany} onChange={(v) => setRate(i, { rateCompany: v ?? 0 })} readOnly={readOnly} />
              </Field>
              <Field label="Others %" hint="Firms, LLPs, AOP, trusts …">
                <PercentInput value={r.rateOthers} onChange={(v) => setRate(i, { rateOthers: v ?? 0 })} readOnly={readOnly} />
              </Field>
              <Field label={kind === 'tcs' ? 'No PAN % (s.206CC)' : 'No PAN % (s.206AA)'}>
                <PercentInput value={r.rateNoPan} onChange={(v) => setRate(i, { rateNoPan: v ?? 0 })} readOnly={readOnly} />
              </Field>
              <Field label="Single transaction above" optional hint="Blank = no single limit.">
                <AmountInput value={r.thresholdSingle} onChange={(v) => setRate(i, { thresholdSingle: v && v > 0 ? v : null })} symbol readOnly={readOnly} />
              </Field>
              <Field label="Aggregate above" optional hint="Per party; blank = none.">
                <AmountInput value={r.thresholdAggregate} onChange={(v) => setRate(i, { thresholdAggregate: v && v > 0 ? v : null })} symbol readOnly={readOnly} />
              </Field>
              <Field label="Aggregate per">
                <Select<'fy' | 'month'>
                  value={r.aggregatePeriod}
                  onChange={(v) => setRate(i, { aggregatePeriod: v })}
                  disabled={readOnly}
                  options={[
                    { value: 'fy', label: 'Financial year' },
                    { value: 'month', label: 'Month (rent)' },
                  ]}
                />
              </Field>
              <Field label="When crossed" error={errors[`rates[${i}].thresholdBasis`]}>
                <Select<'whole' | 'excess'>
                  value={r.thresholdBasis}
                  onChange={(v) => setRate(i, { thresholdBasis: v })}
                  disabled={readOnly}
                  options={[
                    { value: 'whole', label: 'Tax the whole amount' },
                    { value: 'excess', label: 'Tax only the excess (194Q)' },
                  ]}
                />
              </Field>
              <Field label="Base includes GST" hint="On for TCS; TDS is on the value before GST.">
                <Switch checked={r.baseIncludesGst} onChange={(v) => setRate(i, { baseIncludesGst: v })} disabled={readOnly} aria-label="Base includes GST" />
              </Field>
              <Field label="Note" optional>
                <TextInput value={r.note ?? ''} onValueChange={(v) => setRate(i, { note: v.slice(0, 500) })} readOnly={readOnly} />
              </Field>
              {d.rates.length > 1 && !readOnly ? (
                <Field label="Remove" hideLabel>
                  <IconButton icon="trash" aria-label={`Remove the rate row from ${r.applicableFrom}`} onClick={() => setDraft({ ...d, rates: d.rates.filter((_, j) => j !== i) })} />
                </Field>
              ) : null}
            </FieldGroup>
          ))}
          {!readOnly ? (
            <Inline>
              <Button icon="plus" shortcut="Alt+R" onClick={addRate}>
                Add rate row
              </Button>
            </Inline>
          ) : null}
        </Stack>
      </div>
    </Screen>
  );
}
