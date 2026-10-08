/**
 * Units of measure: 'inventory.unit.list' and 'inventory.unit.form' (dialog;
 * params { id?, initialName?, forResult?, kind?: 'simple' | 'compound' } — returns { id, name }).
 * Simple units carry a GST UQC (suggested from the symbol) and decimal places; compound units read
 * "1 Box = 12 Nos".
 */
import { useMemo, useState } from 'react';
import type { UnitDto } from '../../../shared/types/inventory.ts';
import {
  DialogScreen,
  ReportScreen,
  Screen,
  ScreenError,
  ScreenSkeleton,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useDirty,
  useFeatures,
  useNav,
  useScreenResult,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, EmptyState, Field, FieldGroup, NumberInput, SegmentedControl, Select, Stack, TextInput, useDebouncedValue, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { AcceptKey, FeatureOff, focusFirstError, INVENTORY_INVALIDATES, splitApiError } from './common.tsx';
import { DeleteKey } from './Groups.tsx';
import { compoundSymbolPreview, conversionText, uqcSelectOptions, uqcSuggestion, validateCompoundUnit, validateSimpleUnit } from './lib/units.ts';
import { UnitPicker } from './pickers.tsx';
import './inventory.css';

export function UnitListScreen() {
  const features = useFeatures();
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const q = useApiQuery('inventory.unit.list', { limit: 5000 }, { enabled: features.inventory });
  const del = useApiMutation('inventory.unit.delete', { invalidates: INVENTORY_INVALIDATES });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const term = useDebouncedValue(search.trim().toLowerCase(), 120);
  const rows = useMemo(
    () => (q.data?.rows ?? []).filter((u) => !term || u.symbol.toLowerCase().includes(term) || (u.formalName ?? '').toLowerCase().includes(term) || (u.uqc ?? '').toLowerCase().includes(term)),
    [q.data, term],
  );
  const current = rows.find((u) => String(u.id) === selected) ?? null;
  const columns = useMemo<Column<UnitDto>[]>(
    () => [
      { key: 'symbol', header: 'Symbol', width: 180, sortable: true },
      {
        key: 'formalName',
        header: 'Meaning',
        render: (u) => (u.isCompound ? conversionText(u.firstUnitSymbol, u.conversion, u.secondUnitSymbol) : (u.formalName ?? '')),
        value: (u) => (u.isCompound ? conversionText(u.firstUnitSymbol, u.conversion, u.secondUnitSymbol) : (u.formalName ?? '')),
      },
      {
        key: 'kind',
        header: 'Type',
        width: 110,
        render: (u) =>
          u.isCompound ? (
            <Badge size="sm" tone="info">
              Compound
            </Badge>
          ) : (
            <span className="bx-muted">Simple</span>
          ),
      },
      { key: 'uqc', header: 'GST UQC', width: 100, value: (u) => u.uqc ?? '' },
      { key: 'decimalPlaces', header: 'Decimals', kind: 'number', decimals: 0, width: 90 },
      { key: 'itemCount', header: 'Items', kind: 'number', decimals: 0, width: 80 },
    ],
    [],
  );
  if (!features.inventory)
    return (
      <Screen title="Units of Measure" icon="scale">
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep units." />
      </Screen>
    );

  const remove = async (u: UnitDto | null): Promise<void> => {
    if (!u || del.pending) return;
    if (u.itemCount > 0) {
      toast.info(`“${u.symbol}” cannot be deleted`, { message: `${u.itemCount} stock item(s) use it.` });
      return;
    }
    if (!(await confirm({ title: `Delete unit “${u.symbol}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: u.id });
      toast.success(`Unit “${u.symbol}” deleted`);
      setSelected(undefined);
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    }
  };

  return (
    <ReportScreen
      title="Units of Measure"
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Type to search · Enter alter · Alt+C simple unit · Alt+U compound unit · Ctrl+D delete"
      actions={[
        { key: 'Alt+C', label: 'Create unit', icon: 'plus', primary: true, onClick: () => nav.push('inventory.unit.form', { kind: 'simple', ...(search.trim() ? { initialName: search.trim() } : {}) }), hidden: !canCreate },
        { key: 'Alt+U', label: 'Compound unit', icon: 'layers', onClick: () => nav.push('inventory.unit.form', { kind: 'compound' }), hidden: !canCreate },
        { key: 'Ctrl+D, Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(current), hidden: !canDelete, disabled: !current, hint: current && current.itemCount > 0 ? 'Used by stock items' : undefined, group: 'danger' },
      ]}
      filters={
        <Field label="Search" hideLabel>
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Search units" aria-label="Search units" data-autofocus="" />
        </Field>
      }
      exportDef={() => ({
        columns: [{ header: 'Symbol' }, { header: 'Meaning' }, { header: 'Type' }, { header: 'GST UQC' }, { header: 'Decimals', kind: 'number', decimals: 0 }, { header: 'Items', kind: 'number', decimals: 0 }],
        rows: rows.map((u) => [
          u.symbol,
          u.isCompound ? conversionText(u.firstUnitSymbol, u.conversion, u.secondUnitSymbol) : (u.formalName ?? ''),
          u.isCompound ? 'Compound' : 'Simple',
          u.uqc ?? '',
          u.decimalPlaces,
          u.itemCount,
        ]),
      })}
    >
      <DataTable
        aria-label="Units of measure"
        columns={columns}
        rows={rows}
        getRowKey={(u) => String(u.id)}
        selectedKey={selected}
        onSelect={(k) => setSelected(k ?? undefined)}
        onRowActivate={(u) => nav.push('inventory.unit.form', { id: u.id })}
        loading={q.loading}
        empty={
          term ? (
            <EmptyState icon="search" title="No units match" body="Change the search, or press Alt+C to create the unit." />
          ) : (
            <EmptyState
              icon="scale"
              title="No units yet"
              body="Units say how you count stock: Nos, Kg, Mtr, Box. Press Alt+C to create one."
              action={
                canCreate ? (
                  <Button variant="primary" icon="plus" shortcut="Alt+C" onClick={() => nav.push('inventory.unit.form', { kind: 'simple' })}>
                    Create unit
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
    </ReportScreen>
  );
}

export interface UnitFormParams {
  id?: number;
  initialName?: string;
  forResult?: boolean;
  kind?: 'simple' | 'compound';
}

export function UnitFormScreen({ params }: ScreenProps<UnitFormParams>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const features = useFeatures();
  const nav = useNav();
  const existing = useApiQuery('inventory.unit.get', { id: id ?? 0 }, { enabled: id !== undefined && features.inventory, staleTime: 0 });
  const title = id === undefined ? 'Unit Creation' : 'Unit Alteration';
  if (!features.inventory || existing.error || (id !== undefined && !existing.data)) {
    return (
      <DialogScreen title={title} size="md" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        {!features.inventory ? (
          <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep units." />
        ) : existing.error ? (
          <ScreenError error={existing.error} onRetry={() => void existing.refetch()} />
        ) : (
          <ScreenSkeleton lines={4} />
        )}
      </DialogScreen>
    );
  }
  return <UnitForm key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'} title={title} saved={existing.data ?? null} params={params} />;
}

interface UnitDraft {
  kind: 'simple' | 'compound';
  symbol: string;
  formalName: string;
  uqc: string;
  /** The user picked a UQC (else it follows the suggestion). */
  uqcChosen: boolean;
  decimalPlaces: number | null;
  firstUnitId: number | null;
  conversion: number | null;
  secondUnitId: number | null;
}

const UID = 'inv-unit-';

function UnitForm({ title, saved, params }: { title: string; saved: UnitDto | null; params: UnitFormParams }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canAlter = useCan('masters.alter');
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const save = useApiMutation('inventory.unit.save', { invalidates: INVENTORY_INVALIDATES });
  const del = useApiMutation('inventory.unit.delete', { invalidates: INVENTORY_INVALIDATES });
  const units = useApiQuery('inventory.unit.list', { limit: 5000 }, { staleTime: 60_000 });
  const base = useMemo<UnitDraft>(
    () => ({
      kind: saved ? (saved.isCompound ? 'compound' : 'simple') : params.kind === 'compound' ? 'compound' : 'simple',
      symbol: saved && !saved.isCompound ? saved.symbol : saved ? '' : (params.initialName ?? ''),
      formalName: saved?.formalName ?? '',
      uqc: saved?.uqc ?? '',
      uqcChosen: saved !== null && saved.uqc !== null,
      decimalPlaces: saved?.decimalPlaces ?? 0,
      firstUnitId: saved?.firstUnitId ?? null,
      conversion: saved?.conversion ?? null,
      secondUnitId: saved?.secondUnitId ?? null,
    }),
    [saved, params.kind, params.initialName],
  );
  const [d, setD] = useState<UnitDraft>(base);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const dirty = JSON.stringify({ ...d, uqcChosen: undefined }) !== JSON.stringify({ ...base, uqcChosen: undefined });
  useDirty(dirty);
  const readOnly = saved !== null ? !canAlter : !canCreate;
  const suggestion = uqcSuggestion(d.symbol, d.formalName);
  const uqc = d.uqcChosen ? d.uqc : suggestion.code;
  const uqcOptions = useMemo(() => uqcSelectOptions(suggestion.code), [suggestion.code]);
  const all = units.data?.rows ?? [];
  const first = all.find((u) => u.id === d.firstUnitId) ?? null;
  const second = all.find((u) => u.id === d.secondUnitId) ?? null;

  const patch = (p: Partial<UnitDraft>): void => {
    setD((x) => ({ ...x, ...p }));
    const keys = Object.keys(p);
    if (keys.some((k) => errors[k])) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k))));
  };

  const submit = async (): Promise<void> => {
    if (save.pending || readOnly) return;
    if (saved && !dirty) {
      if (forResult) returnResult({ id: saved.id, name: saved.symbol });
      else nav.pop();
      return;
    }
    const e: Record<string, string | undefined> = d.kind === 'simple' ? validateSimpleUnit(d) : validateCompoundUnit(d);
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Record<string, string>;
    setErrors(clean);
    setBanner(null);
    if (Object.keys(clean).length) {
      focusFirstError(clean, ['symbol', 'formalName', 'uqc', 'decimalPlaces', 'firstUnitId', 'conversion', 'secondUnitId'], (k) => `${UID}${k}`);
      return;
    }
    try {
      const out =
        d.kind === 'simple'
          ? await save.mutate({
              ...(saved ? { id: saved.id } : {}),
              kind: 'simple',
              symbol: d.symbol.trim(),
              formalName: d.formalName.trim() || null,
              uqc,
              decimalPlaces: d.decimalPlaces ?? 0,
            })
          : await save.mutate({
              ...(saved ? { id: saved.id } : {}),
              kind: 'compound',
              firstUnitId: d.firstUnitId as number,
              conversion: d.conversion as number,
              secondUnitId: d.secondUnitId as number,
            });
      toast.success(saved ? `Unit “${out.symbol}” saved` : `Unit “${out.symbol}” created`);
      if (forResult) returnResult({ id: out.id, name: out.symbol });
      else nav.pop();
    } catch (err) {
      const { fields, message } = splitApiError(err, (k) => ['symbol', 'formalName', 'uqc', 'decimalPlaces', 'firstUnitId', 'conversion', 'secondUnitId'].includes(k));
      setErrors(fields);
      setBanner(message);
    }
  };

  const remove = async (): Promise<void> => {
    if (!saved) return;
    if (saved.itemCount > 0) {
      setBanner(`${saved.itemCount} stock item(s) use this unit, so it cannot be deleted.`);
      return;
    }
    if (!(await confirm({ title: `Delete unit “${saved.symbol}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success(`Unit “${saved.symbol}” deleted`);
      nav.pop();
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void submit() });
  const preview = conversionText(first?.symbol, d.conversion, second?.symbol);
  return (
    <DialogScreen
      title={saved ? `${title} — ${saved.symbol}` : title}
      size="md"
      footerStart={
        saved && canDelete ? (
          <Button variant="danger" icon="trash" shortcut="Alt+D" onClick={() => void remove()} loading={del.pending}>
            Delete
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()} disabled={readOnly}>
            {forResult ? 'Save & return' : 'Save'}
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void submit()} />
      <DeleteKey enabled={!!saved && canDelete} onDelete={() => void remove()} />
      <div ref={formRef}>
        <Stack gap={4}>
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}
          {saved ? null : (
            <SegmentedControl<'simple' | 'compound'>
              aria-label="Type of unit"
              value={d.kind}
              onChange={(k) => patch({ kind: k })}
              options={[
                { value: 'simple', label: 'Simple (Nos, Kg)' },
                { value: 'compound', label: 'Compound (Box of 12 Nos)' },
              ]}
            />
          )}
          {d.kind === 'simple' ? (
            <>
              <FieldGroup columns={2}>
                <Field label="Symbol" required htmlFor={`${UID}symbol`} error={errors.symbol} hint="Short, as printed on bills: Nos, Kg, Mtr.">
                  <TextInput id={`${UID}symbol`} value={d.symbol} onChange={(e) => patch({ symbol: e.target.value })} maxLength={30} data-autofocus="" autoComplete="off" readOnly={readOnly} />
                </Field>
                <Field label="Formal name" optional htmlFor={`${UID}formalName`} error={errors.formalName} hint="In full: Numbers, Kilograms.">
                  <TextInput id={`${UID}formalName`} value={d.formalName} onChange={(e) => patch({ formalName: e.target.value })} maxLength={100} autoComplete="off" readOnly={readOnly} />
                </Field>
              </FieldGroup>
              <FieldGroup columns={2}>
                <Field label="GST unit (UQC)" htmlFor={`${UID}uqc`} error={errors.uqc} hint={d.uqcChosen && uqc !== suggestion.code ? `Chosen by you. ${suggestion.hint}` : suggestion.hint}>
                  <Select id={`${UID}uqc`} value={uqc} onChange={(v) => patch({ uqc: v, uqcChosen: true })} options={uqcOptions} disabled={readOnly} />
                </Field>
                <Field label="Decimal places" htmlFor={`${UID}decimalPlaces`} error={errors.decimalPlaces} hint="0 for whole numbers (Nos); 3 for Kg to the gram.">
                  <NumberInput id={`${UID}decimalPlaces`} value={d.decimalPlaces} onChange={(v) => patch({ decimalPlaces: v })} min={0} max={4} step={1} readOnly={readOnly} />
                </Field>
              </FieldGroup>
            </>
          ) : (
            <>
              <div className="bx-inv-conversion">
                <span className="bx-inv-conversion__eq" aria-hidden="true">
                  1
                </span>
                <Field label="Bigger unit" required htmlFor={`${UID}firstUnitId`} error={errors.firstUnitId}>
                  <UnitPicker id={`${UID}firstUnitId`} kind="simple" value={d.firstUnitId} onChange={(id) => patch({ firstUnitId: id })} readOnly={readOnly} placeholder="e.g. Box" />
                </Field>
                <span className="bx-inv-conversion__eq" aria-hidden="true">
                  =
                </span>
                <Field label="Contains" required htmlFor={`${UID}conversion`} error={errors.conversion}>
                  <NumberInput id={`${UID}conversion`} value={d.conversion} onChange={(v) => patch({ conversion: v })} decimals={4} min={0} readOnly={readOnly} />
                </Field>
                <Field label="Smaller unit" required htmlFor={`${UID}secondUnitId`} error={errors.secondUnitId}>
                  <UnitPicker
                    id={`${UID}secondUnitId`}
                    kind="simple"
                    value={d.secondUnitId}
                    onChange={(id) => patch({ secondUnitId: id })}
                    exclude={d.firstUnitId !== null ? new Set([d.firstUnitId]) : undefined}
                    readOnly={readOnly}
                    placeholder="e.g. Nos"
                  />
                </Field>
              </div>
              <p className="bx-inv-note" aria-live="polite">
                {preview ? `${preview} — saved as “${compoundSymbolPreview(first?.symbol, d.conversion, second?.symbol)}”. Quantities use ${second?.decimalPlaces ?? 0} decimal places, like ${second?.symbol ?? 'the smaller unit'}.` : 'Example: 1 Box = 12 Nos.'}
              </p>
            </>
          )}
          {saved && saved.itemCount > 0 ? (
            <p className="bx-inv-note">
              Used by {saved.itemCount} stock item{saved.itemCount === 1 ? '' : 's'}. Fewer decimal places are refused while quantities need them.
            </p>
          ) : null}
        </Stack>
      </div>
    </DialogScreen>
  );
}
