/**
 * Bill of Materials master (feature: Bill of materials and manufacturing).
 *
 *   'mfg.bom.list'  {itemId?}                      every BOM, by finished item. Enter alter · Alt+C create ·
 *                                                   Alt+D delete · Ctrl+1 active / Ctrl+2 all · Ctrl+F search
 *   'mfg.bom.form'  {id?, itemId?, forResult?}      create / alter: components, by-products and scrap per
 *                                                   the BOM's output quantity, default godowns, value basis;
 *                                                   cost estimate at the working date; Alt+H revision history
 *
 * A BOM is alterable at any time: every save keeps a numbered revision (snapshot) and the journals that
 * used it keep the revision they were made with.
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { BomDetail, BomLineKind, BomListRow, BomRevisionRow, BomValueBasis } from '../../../shared/types/mfg.ts';
import type { ItemPickerRow } from '../../../shared/types/inventory.ts';
import {
  fieldErrorsOf,
  formatDateTime,
  ReportScreen,
  Screen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useFeatures,
  useNav,
  userMessage,
  useScreenResult,
  useWorkingDate,
} from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  FieldGroup,
  KeyValueList,
  NumberInput,
  PercentInput,
  QuantityInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextArea,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GodownPicker, ItemPicker } from '../inventory/pickers.tsx';
import { focusedRowKey, focusRow, LinesTable, MFG_INVALIDATES } from './components.tsx';
import type { LineColumn, LineRow } from './components.tsx';
import { BOM_KIND_LABELS, blankBomRow, bomFormFrom, emptyBomForm, mapBomErrors, toBomInput, VALUE_BASIS_LABELS } from './lib/bomForm.ts';
import type { BomForm, BomRow } from './lib/bomForm.ts';
import { bomListExport } from './lib/model.ts';

const OFF = 'Turn on “Bill of materials and manufacturing” in Features (F11 › Inventory) to keep bills of materials.';

// ───────────────────────────── List ─────────────────────────────

export function BomListScreen({ params }: ScreenProps<{ itemId?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const features = useFeatures();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'active' | 'all'>('active');
  const [selected, setSelected] = useState<string | null>(null);
  const debounced = useDebouncedValue(search, 200);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = useApiQuery(
    'mfg.bom.list',
    { ...(params.itemId !== undefined ? { itemId: params.itemId } : {}), ...(debounced.trim() ? { search: debounced.trim() } : {}), includeInactive: view === 'all', limit: 5000 },
    { keepPrevious: true, enabled: features.manufacturing },
  );
  const del = useApiMutation('mfg.bom.delete', { invalidates: MFG_INVALIDATES });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const columns = useMemo<Column<BomListRow>[]>(
    () => [
      { key: 'itemName', header: 'Finished item', minWidth: 200, sortable: true },
      {
        key: 'name',
        header: 'BOM',
        minWidth: 160,
        sortable: true,
        render: (r) => (
          <span>
            {r.name} {r.isDefault ? <Badge size="sm" tone="brand">Default</Badge> : null} {!r.isActive ? <Badge size="sm">Inactive</Badge> : null}
          </span>
        ),
      },
      { key: 'outputQty', header: 'For quantity', kind: 'qty', width: 140, render: (r) => `${r.outputQty} ${r.unit}` },
      { key: 'components', header: 'Components', kind: 'number', width: 110 },
      { key: 'byProducts', header: 'By-products / scrap', kind: 'number', width: 150 },
      { key: 'revision', header: 'Revision', kind: 'number', width: 90 },
      { key: 'updatedAt', header: 'Last altered', width: 170, value: (r) => formatDateTime(r.updatedAt) },
    ],
    [],
  );
  const remove = async () => {
    if (!current) return;
    if (!(await confirm({ title: `Delete BOM “${current.name}” of ${current.itemName}?`, message: 'A BOM used by a Manufacturing Journal or a job work order cannot be deleted — mark it inactive instead.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: current.id });
      toast.success('Bill of materials deleted');
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    }
  };
  const actions: ScreenActionItem[] = [
    { key: 'Alt+C', label: 'Create BOM', icon: 'plus', primary: true, onClick: () => nav.push('mfg.bom.form', params.itemId !== undefined ? { itemId: params.itemId } : {}), hidden: !canCreate },
    { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => current && nav.push('mfg.bom.form', { id: current.id }), disabled: !current },
    { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !canDelete, disabled: !current, group: 'danger' },
    { key: 'Ctrl+1', label: 'Show active', icon: 'filter', onClick: () => setView('active'), disabled: view === 'active', group: 'view' },
    { key: 'Ctrl+2', label: 'Show all', icon: 'filter', onClick: () => setView('all'), disabled: view === 'all', group: 'view' },
    { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: () => searchRef.current?.focus(), group: 'view' },
  ];
  if (!features.manufacturing) {
    return (
      <Screen title="Bills of Materials" icon="layers">
        <EmptyState icon="layers" title="Bill of materials is turned off" body={OFF} />
      </Screen>
    );
  }
  return (
    <ReportScreen
      title="Bills of Materials"
      periodMode="none"
      actions={actions}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Alter · Alt+C Create BOM · Alt+D Delete · Ctrl+F Search · Ctrl+1/2 Active or all · Alt+E Export"
      filters={
        <Stack gap={2}>
          <TextInput ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Search item or BOM" aria-label="Search bills of materials" size="sm" />
          <SegmentedControl<'active' | 'all'> aria-label="Show" size="sm" value={view} onChange={setView} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
        </Stack>
      }
      exportDef={() => bomListExport(rows)}
    >
      <DataTable<BomListRow>
        aria-label="Bills of materials"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('mfg.bom.form', { id: r.id })}
        loading={q.loading}
        empty={<EmptyState icon="layers" title="No bills of materials yet" body="A BOM lists the components (and any by-products or scrap) of an item you make. Press Alt+C to create one." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export interface BomFormParams {
  id?: number;
  itemId?: number;
  forResult?: boolean;
}

export function BomFormScreen({ params }: ScreenProps<BomFormParams>) {
  const features = useFeatures();
  const id = typeof params.id === 'number' ? params.id : undefined;
  const q = useApiQuery('mfg.bom.get', { id: id ?? 0 }, { enabled: id !== undefined && features.manufacturing, staleTime: 0 });
  const item = useApiQuery('inventory.item.get', { id: params.itemId ?? 0 }, { enabled: id === undefined && params.itemId !== undefined && features.manufacturing });
  const title = id === undefined ? 'BOM Creation' : 'BOM Alteration';
  if (!features.manufacturing) {
    return (
      <Screen title={title} icon="layers">
        <EmptyState icon="layers" title="Bill of materials is turned off" body={OFF} />
      </Screen>
    );
  }
  const waiting = (id !== undefined && !q.data) || (id === undefined && params.itemId !== undefined && !item.data);
  if (waiting || q.error || item.error) return <Screen title={title} icon="layers" width="form" loading={!(q.error ?? item.error)} error={q.error ?? item.error} onRetry={() => void (q.refetch(), item.refetch())} />;
  const startItem = item.data ? { id: item.data.id, name: item.data.name, unit: item.data.unitSymbol ?? '' } : null;
  return <BomFormView key={q.data ? `${q.data.id}:${q.data.updatedAt}` : 'new'} saved={q.data ?? null} startItem={startItem} title={title} />;
}

const KIND_OPTIONS: ReadonlyArray<{ value: BomLineKind; label: string }> = (['component', 'by_product', 'scrap'] as const).map((k) => ({ value: k, label: BOM_KIND_LABELS[k] }));
const BASIS_OPTIONS: ReadonlyArray<{ value: BomValueBasis; label: string }> = (['nil', 'rate', 'percent'] as const).map((b) => ({ value: b, label: VALUE_BASIS_LABELS[b] }));

/** Keep one blank line at the end of the table. */
function withBlank(form: BomForm): BomForm {
  const blank = (r: BomRow) => r.itemId === null && r.qty === null;
  const filled = form.rows.filter((r) => !blank(r));
  const last = form.rows.filter(blank).pop() ?? blankBomRow('component');
  const rows = [...filled, last];
  return rows.length === form.rows.length && rows.every((r, i) => r === form.rows[i]) ? form : { ...form, rows };
}

function BomFormView({ saved, startItem, title }: { saved: BomDetail | null; startItem: { id: number; name: string; unit: string } | null; title: string }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const features = useFeatures();
  const { date } = useWorkingDate();
  const canAlter = useCan('masters.alter');
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const canReports = useCan('reports.view');
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const initial = useMemo(() => withBlank(saved ? bomFormFrom(saved) : emptyBomForm(startItem)), [saved, startItem]);
  const [form, setFormRaw] = useState<BomForm>(initial);
  const setForm = (fn: (f: BomForm) => BomForm) => setFormRaw((f) => withBlank(fn(f)));
  const [errors, setErrors] = useState<{ rows: Map<string, string>; fields: Record<string, string>; general: string[] }>({ rows: new Map(), fields: {}, general: [] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const dirty = JSON.stringify({ ...form, rows: form.rows.map(({ key: _k, ...r }) => r) }) !== JSON.stringify({ ...initial, rows: initial.rows.map(({ key: _k, ...r }) => r) });
  const readOnly = saved ? !canAlter : !canCreate;
  const save = useApiMutation('mfg.bom.save', { invalidates: MFG_INVALIDATES });
  const del = useApiMutation('mfg.bom.delete', { invalidates: MFG_INVALIDATES });
  const cost = useApiQuery('mfg.bom.cost', { id: saved?.id ?? 0, asOf: date }, { enabled: saved !== null && canReports, staleTime: 0 });

  const submit = async () => {
    if (save.pending || readOnly) return;
    const { input, lineKeys } = toBomInput(form, saved ? { id: saved.id, updatedAt: saved.updatedAt } : undefined);
    if (!input) {
      setErrors({ rows: new Map(), fields: { itemId: 'Select the finished item this BOM makes.' }, general: [] });
      return;
    }
    try {
      const out = await save.mutate(input);
      toast.success(`BOM “${out.name}” of ${out.itemName} saved`, saved ? { message: `Revision ${out.revision}` } : undefined);
      if (forResult) returnResult({ id: out.id, name: out.name });
      else nav.pop();
    } catch (err) {
      const mapped = mapBomErrors(fieldErrorsOf(err), lineKeys);
      if (mapped.rows.size === 0 && Object.keys(mapped.fields).length === 0 && mapped.general.length === 0) mapped.general.push(userMessage(err));
      setErrors(mapped);
      const first = mapped.rows.keys().next();
      if (!first.done) focusRow(first.value);
    }
  };
  const remove = async () => {
    if (!saved) return;
    if (!(await confirm({ title: `Delete BOM “${saved.name}”?`, message: saved.usedInVouchers > 0 ? `It is used by ${saved.usedInVouchers} voucher(s) and cannot be deleted; mark it inactive instead.` : 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success('Bill of materials deleted');
      nav.pop();
    } catch (err) {
      setErrors({ rows: new Map(), fields: {}, general: [userMessage(err)] });
    }
  };
  const patchRow = (key: string, patch: Partial<BomRow>) => setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const removeLine = () => {
    const key = focusedRowKey();
    if (!key) return;
    const i = form.rows.findIndex((r) => r.key === key);
    if (i < 0) return;
    setForm((f) => ({ ...f, rows: f.rows.filter((r) => r.key !== key) }));
    const next = form.rows[i + 1] ?? form.rows[i - 1];
    if (next) focusRow(next.key);
  };
  const insertLine = () => {
    const key = focusedRowKey();
    const i = key ? form.rows.findIndex((r) => r.key === key) : -1;
    if (i < 0) return;
    const fresh = blankBomRow(form.rows[i].kind);
    setForm((f) => ({ ...f, rows: [...f.rows.slice(0, i), fresh, ...f.rows.slice(i)] }));
    focusRow(fresh.key);
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void submit() });
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+A', label: forResult ? 'Save & return' : 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || save.pending, hint: readOnly ? `Needs the “${saved ? 'Alter' : 'Create'} masters” permission` : undefined },
    { key: 'Ctrl+D', label: 'Remove line', icon: 'minus', onClick: removeLine, hidden: readOnly, group: 'lines' },
    { key: 'Alt+N, Ctrl+N', label: 'Insert line', icon: 'plus', onClick: insertLine, hidden: readOnly, group: 'lines' },
    { key: 'Alt+H', label: 'Revision history', icon: 'clock', onClick: () => setHistoryOpen(true), hidden: !saved, group: 'view' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !saved || !canDelete, group: 'danger' },
  ];

  const columns: LineColumn[] = [
    { key: 'kind', header: 'Kind', width: 130 },
    { key: 'item', header: 'Item' },
    { key: 'qty', header: `Quantity per ${form.outputQty ?? ''} ${form.unit}`.trim(), width: 150, num: true },
    ...(features.multipleGodowns ? [{ key: 'godown', header: 'Default godown', width: 180 }] : []),
    { key: 'basis', header: 'Valued at', width: 140 },
    { key: 'rate', header: 'Rate / %', width: 110, num: true },
  ];
  const rows: LineRow[] = form.rows.map((r) => ({
    key: r.key,
    error: errors.rows.get(r.key),
    cells: {
      kind: (
        <Select<BomLineKind> size="sm" aria-label="Kind" value={r.kind} onChange={(v) => patchRow(r.key, { kind: v, valueBasis: v === 'component' ? 'nil' : r.valueBasis === 'nil' ? 'rate' : r.valueBasis })} disabled={readOnly} options={KIND_OPTIONS} />
      ),
      item: (
        <ItemPicker
          size="sm"
          aria-label="Item"
          goodsOnly
          value={r.itemId !== null ? { id: r.itemId, name: r.itemName } : null}
          onChange={(it: ItemPickerRow | null) => patchRow(r.key, it ? { itemId: it.id, itemName: it.name, unit: it.unitSymbol } : { itemId: null, itemName: '', unit: '' })}
          readOnly={readOnly}
          invalid={errors.rows.has(r.key)}
        />
      ),
      qty: <QuantityInput size="sm" aria-label="Quantity" value={r.qty} onChange={(q) => patchRow(r.key, { qty: q })} unit={r.unit} decimals={3} readOnly={readOnly} />,
      godown: features.multipleGodowns ? <GodownPicker size="sm" aria-label="Default godown" value={r.godownId} onChange={(gid) => patchRow(r.key, { godownId: gid })} placeholder="Main Location" readOnly={readOnly} allowCreate={false} /> : null,
      basis: r.kind === 'component' ? <span className="bx-muted">Issue cost</span> : <Select<BomValueBasis> size="sm" aria-label="Valued at" value={r.valueBasis} onChange={(v) => patchRow(r.key, { valueBasis: v })} disabled={readOnly} options={BASIS_OPTIONS} />,
      rate:
        r.kind !== 'component' && r.valueBasis === 'rate' ? (
          <NumberInput size="sm" aria-label="Rate per unit" value={r.valueRate} onChange={(v) => patchRow(r.key, { valueRate: v })} decimals={2} min={0} readOnly={readOnly} />
        ) : r.kind !== 'component' && r.valueBasis === 'percent' ? (
          <PercentInput size="sm" aria-label="Share of cost" value={r.valuePct} onChange={(v) => patchRow(r.key, { valuePct: v })} max={100} readOnly={readOnly} />
        ) : null,
    },
  }));

  const c = cost.data;
  return (
    <Screen
      title={saved ? `${title} — ${saved.itemName}` : title}
      subtitle={saved ? `${saved.name} · revision ${saved.revision}${saved.usedInVouchers > 0 ? ` · used in ${saved.usedInVouchers} voucher(s)` : ''}` : undefined}
      icon="layers"
      width="form"
      dirty={dirty}
      actions={actions}
      hint="Enter Next field · Ctrl+A Save · Ctrl+D Remove line · Alt+N Insert line · Alt+H Revision history · Esc Back"
    >
      <div ref={formRef}>
        <Stack gap={4}>
          {readOnly ? <Banner tone="info" inline>{`View only: ${saved ? 'changing' : 'creating'} bills of materials needs the “${saved ? 'Alter' : 'Create'} masters” permission.`}</Banner> : null}
          {errors.general.length > 0 ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setErrors((e) => ({ ...e, general: [] }))}>
              {errors.general.join(' ')}
            </Banner>
          ) : null}
          <FieldGroup columns={2}>
            <Field label="Finished item" required error={errors.fields.itemId} hint={saved && saved.usedInVouchers > 0 ? 'Used in vouchers: the item cannot change.' : undefined}>
              <ItemPicker
                goodsOnly
                value={form.itemId !== null ? { id: form.itemId, name: form.itemName } : null}
                onChange={(it) => setForm((f) => ({ ...f, itemId: it?.id ?? null, itemName: it?.name ?? '', unit: it?.unitSymbol ?? '' }))}
                readOnly={readOnly || (saved !== null && saved.usedInVouchers > 0)}
                data-autofocus=""
              />
            </Field>
            <Field label="BOM name" required error={errors.fields.name} hint="e.g. Standard, Export pack. An item may have several.">
              <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={100} readOnly={readOnly} />
            </Field>
            <Field label="Components are for" required error={errors.fields.outputQty} hint="Quantity of the finished item the lines below make.">
              <QuantityInput value={form.outputQty} onChange={(q) => setForm((f) => ({ ...f, outputQty: q }))} unit={form.unit} decimals={3} readOnly={readOnly} />
            </Field>
            <Field label="Default BOM of the item" hint="Chosen first in the Manufacturing Journal.">
              <Switch checked={form.isDefault} onChange={(v) => setForm((f) => ({ ...f, isDefault: v }))} disabled={readOnly} />
            </Field>
            <Field label="Active" hint="Inactive BOMs are kept for history but not offered.">
              <Switch checked={form.isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} disabled={readOnly} />
            </Field>
          </FieldGroup>
          <LinesTable caption="Components, by-products and scrap" columns={columns} rows={rows} />
          <p className="bx-mfg-note">
            Components are consumed at the company's stock valuation method as on the voucher date. By-products and scrap reduce the cost of the finished goods by their rate per unit, or by a
            share of the production cost.
          </p>
          <Field label="Notes" optional hint="Ctrl+Enter to move on.">
            <TextArea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} autoGrow maxRows={5} maxLength={2000} readOnly={readOnly} />
          </Field>
          {saved && canReports ? (
            <section aria-label="Cost estimate">
              <h2 className="bx-mfg-section__title">Cost estimate as on {formatDate(date)}</h2>
              {c ? (
                <KeyValueList
                  items={[
                    { label: `Components for ${c.qty} ${saved.unit}`, value: c.componentCost, kind: 'amount' },
                    { label: 'Less by-products / scrap', value: c.byProductValue, kind: 'amount', hideEmpty: true },
                    { label: 'Estimated cost', value: c.estimatedCost, kind: 'amount', strong: true },
                    { label: 'Per unit', value: `₹ ${formatMoney(Math.round(c.unitCost * 100))}` },
                    { label: 'Standard cost (item master)', value: c.standardCost === null ? '—' : `₹ ${formatMoney(Math.round(c.standardCost * 100))}` },
                  ]}
                />
              ) : (
                <p className="bx-muted">{cost.error ? userMessage(cost.error) : 'Working out…'}</p>
              )}
            </section>
          ) : null}
          <div>
            <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} disabled={readOnly} onClick={() => void submit()} data-enter-target="">
              {forResult ? 'Save & return' : 'Save'}
            </Button>
          </div>
        </Stack>
      </div>
      {historyOpen && saved ? <RevisionDrawer bomId={saved.id} onClose={() => setHistoryOpen(false)} /> : null}
    </Screen>
  );
}

function RevisionDrawer({ bomId, onClose }: { bomId: number; onClose: () => void }) {
  const q = useApiQuery('mfg.bom.revisions', { id: bomId }, { staleTime: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const revs = useMemo(() => q.data ?? [], [q.data]);
  const current = revs.find((r) => String(r.revision) === selected) ?? revs[0] ?? null;
  const columns = useMemo<Column<BomRevisionRow>[]>(
    () => [
      { key: 'revision', header: 'Revision', kind: 'number', width: 90 },
      { key: 'changedAt', header: 'Saved on', value: (r) => formatDateTime(r.changedAt) },
      { key: 'changedByName', header: 'By', value: (r) => r.changedByName ?? '' },
    ],
    [],
  );
  const lineCols = useMemo<Column<BomDetail['lines'][number]>[]>(
    () => [
      { key: 'kind', header: 'Kind', width: 110, value: (l) => BOM_KIND_LABELS[l.kind] },
      { key: 'itemName', header: 'Item' },
      { key: 'qty', header: 'Quantity', kind: 'qty', width: 120, render: (l) => `${l.qty} ${l.unit}` },
      { key: 'godownName', header: 'Godown', width: 130, value: (l) => l.godownName ?? '' },
    ],
    [],
  );
  return (
    <Drawer open onClose={onClose} title="Revision history" description="Each save of the BOM is kept; vouchers keep the revision they used." size="lg">
      <Stack gap={3}>
        <DataTable<BomRevisionRow> aria-label="Revisions" autoFocus columns={columns} rows={revs} getRowKey={(r) => String(r.revision)} selectedKey={current ? String(current.revision) : null} onSelect={(k) => setSelected(k)} loading={q.loading} />
        {current ? (
          <>
            <p className="bx-mfg-note">
              Revision {current.revision}: {current.snapshot.name} for {current.snapshot.outputQty} {current.snapshot.unit}
              {current.snapshot.isDefault ? ' · default' : ''}
              {current.snapshot.isActive ? '' : ' · inactive'}
            </p>
            <DataTable<BomDetail['lines'][number]> aria-label={`Lines of revision ${current.revision}`} columns={lineCols} rows={current.snapshot.lines} getRowKey={(l) => String(l.lineNo)} />
          </>
        ) : null}
      </Stack>
    </Drawer>
  );
}
