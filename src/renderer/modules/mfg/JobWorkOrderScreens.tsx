/**
 * Job Work Orders (feature: Job work) — planning documents like Tally's Job Work Out / In Orders. They
 * move no stock and post nothing; Material Out / In vouchers linked to an order show its progress.
 *
 *   'mfg.jobWorkOrder.list'  {direction?}                 Ctrl+1 Out orders · Ctrl+2 In orders · Ctrl+3 open ·
 *                                                           Ctrl+4 all · Enter alter · Alt+C create · Alt+D delete ·
 *                                                           Alt+O Material Out · Alt+I Material In (against the order)
 *   'mfg.jobWorkOrder.form'  {id? | direction, partyId?}   create / alter; Alt+B fill the material from the BOM
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { explodeBom } from '../../../shared/mfg/bom.ts';
import { JOB_WORK_GOODS_LABELS, JOB_WORK_GOODS_TYPES, type JobWorkGoodsType } from '../../../shared/mfg/jobwork.ts';
import type { GodownDto, ItemPickerRow } from '../../../shared/types/inventory.ts';
import type { JobWorkDirection, JobWorkOrderDetail, JobWorkOrderListRow } from '../../../shared/types/mfg.ts';
import {
  fieldErrorsOf,
  ReportScreen,
  Screen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useFeatures,
  useNav,
  userMessage,
  useWorkingDate,
} from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  NumberInput,
  QuantityInput,
  SegmentedControl,
  Select,
  Stack,
  TextArea,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { LedgerPicker } from '../accounts/pickers.tsx';
import { ItemPicker } from '../inventory/pickers.tsx';
import { focusedRowKey, focusRow, LinesTable, MFG_INVALIDATES } from './components.tsx';
import type { LineColumn, LineRow } from './components.tsx';
import { jobWorkOrdersExport, orderStatusText } from './lib/model.ts';
import { blankOrderRow, emptyOrderForm, godownForParty, mapOrderErrors, ORDER_GODOWN_KIND, ORDER_TITLES, orderFormFrom, toOrderInput } from './lib/orderForm.ts';
import type { OrderForm, OrderRow } from './lib/orderForm.ts';

const OFF = 'Turn on Job work in Features (F11 › Inventory; it needs Multiple godowns) to keep job work orders.';
const GOODS_OPTIONS: ReadonlyArray<{ value: JobWorkGoodsType; label: string }> = JOB_WORK_GOODS_TYPES.map((g) => ({ value: g, label: JOB_WORK_GOODS_LABELS[g] }));

// ───────────────────────────── List ─────────────────────────────

export function JobWorkOrderListScreen({ params }: ScreenProps<{ direction?: JobWorkDirection }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const features = useFeatures();
  const canCreate = useCan('vouchers.create');
  const canDelete = useCan('vouchers.delete');
  const [direction, setDirection] = useState<JobWorkDirection>(params.direction ?? 'out');
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useApiQuery('mfg.jobWorkOrder.list', { direction, status, limit: 2000 }, { keepPrevious: true, enabled: features.jobWork });
  const del = useApiMutation('mfg.jobWorkOrder.delete', { invalidates: MFG_INVALIDATES });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const T = ORDER_TITLES[direction];
  const columns = useMemo<Column<JobWorkOrderListRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 105, sortable: true },
      { key: 'number', header: 'Order no.', width: 110, sortable: true },
      { key: 'partyName', header: T.party, minWidth: 180, sortable: true },
      { key: 'itemName', header: 'Item', minWidth: 160, value: (r) => r.itemName ?? 'Material only' },
      { key: 'qty', header: 'Ordered', kind: 'qty', width: 110, value: (r) => r.qty ?? 0, blankZero: true },
      { key: 'productDoneQty', header: 'Done', kind: 'qty', width: 100, blankZero: true },
      { key: 'pendingQty', header: 'Pending', kind: 'qty', width: 100, value: (r) => r.pendingQty ?? 0, blankZero: true },
      { key: 'dueDate', header: 'Due', kind: 'date', width: 105 },
      {
        key: 'status',
        header: 'Status',
        width: 100,
        value: (r) => orderStatusText(r),
        render: (r) => <Badge size="sm" tone={r.status === 'closed' ? 'neutral' : r.overdue ? 'danger' : 'info'}>{orderStatusText(r)}</Badge>,
      },
    ],
    [T.party],
  );
  const remove = async () => {
    if (!current) return;
    if (!(await confirm({ title: `Delete ${T.one} ${current.number}?`, message: 'An order with Material In / Out vouchers linked to it cannot be deleted — close it instead.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: current.id });
      toast.success('Job work order deleted');
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    }
  };
  const challan = (cls: 'material_out' | 'material_in') => current && nav.push('mfg.journal.entry', { cls, jobWorkOrderId: current.id });
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Job Work Out Orders', icon: 'truck', onClick: () => setDirection('out'), disabled: direction === 'out', group: 'view' },
    { key: 'Ctrl+2', label: 'Job Work In Orders', icon: 'truck', onClick: () => setDirection('in'), disabled: direction === 'in', group: 'view' },
    { key: 'Ctrl+3', label: 'Show open', icon: 'filter', onClick: () => setStatus('open'), disabled: status === 'open', group: 'view' },
    { key: 'Ctrl+4', label: 'Show all', icon: 'filter', onClick: () => setStatus('all'), disabled: status === 'all', group: 'view' },
    { key: 'Alt+C', label: `Create ${T.one}`, icon: 'plus', primary: true, onClick: () => nav.push('mfg.jobWorkOrder.form', { direction }), hidden: !canCreate },
    { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => current && nav.push('mfg.jobWorkOrder.form', { id: current.id }), disabled: !current },
    { key: 'Alt+O', label: 'Material Out', icon: 'upload', onClick: () => challan('material_out'), disabled: !current || current.status === 'closed', hidden: !canCreate, group: 'go' },
    { key: 'Alt+I', label: 'Material In', icon: 'download', onClick: () => challan('material_in'), disabled: !current || current.status === 'closed', hidden: !canCreate, group: 'go' },
    { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !canDelete, disabled: !current, group: 'danger' },
  ];
  if (!features.jobWork) {
    return (
      <Screen title="Job Work Orders" icon="truck">
        <EmptyState icon="truck" title="Job work is turned off" body={OFF} />
      </Screen>
    );
  }
  return (
    <ReportScreen
      title={T.many}
      periodMode="none"
      actions={actions}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Alter · Alt+C Create · Alt+O Material Out · Alt+I Material In · Ctrl+1/2 Out or In orders · Ctrl+3/4 Open or all · Alt+E Export"
      filters={
        <Stack gap={2}>
          <SegmentedControl<JobWorkDirection> aria-label="Kind" size="sm" value={direction} onChange={setDirection} options={[{ value: 'out', label: 'Out (to job workers)' }, { value: 'in', label: 'In (from principals)' }]} />
          <SegmentedControl<'open' | 'all'> aria-label="Status" size="sm" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />
        </Stack>
      }
      exportDef={() => jobWorkOrdersExport(rows, direction)}
    >
      <DataTable<JobWorkOrderListRow>
        aria-label={T.many}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('mfg.jobWorkOrder.form', { id: r.id })}
        loading={q.loading}
        empty={<EmptyState icon="truck" title={`No ${status === 'open' ? 'open ' : ''}${T.many.toLowerCase()}`} body="Press Alt+C to create one. An order plans the work; Material Out / In vouchers move the goods." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export interface JobWorkOrderFormParams {
  id?: number;
  direction?: JobWorkDirection;
  partyId?: number;
}

export function JobWorkOrderFormScreen({ params }: ScreenProps<JobWorkOrderFormParams>) {
  const features = useFeatures();
  const id = typeof params.id === 'number' ? params.id : undefined;
  const q = useApiQuery('mfg.jobWorkOrder.get', { id: id ?? 0 }, { enabled: id !== undefined && features.jobWork, staleTime: 0 });
  const godowns = useApiQuery('inventory.godown.list', { limit: 5000 }, { enabled: features.jobWork, staleTime: 60_000 });
  const direction = q.data?.direction ?? params.direction ?? 'out';
  const title = `${ORDER_TITLES[direction].one} ${id === undefined ? 'Creation' : 'Alteration'}`;
  if (!features.jobWork) {
    return (
      <Screen title={title} icon="truck">
        <EmptyState icon="truck" title="Job work is turned off" body={OFF} />
      </Screen>
    );
  }
  if ((id !== undefined && !q.data) || !godowns.data) {
    return <Screen title={title} icon="truck" width="form" loading={!(q.error ?? godowns.error)} error={q.error ?? godowns.error} onRetry={() => void (q.refetch(), godowns.refetch())} />;
  }
  return <OrderFormView key={q.data ? `${q.data.id}:${q.data.updatedAt}` : direction} saved={q.data ?? null} direction={direction} godowns={godowns.data.rows} title={title} partyId={params.partyId} />;
}

function withBlank(form: OrderForm): OrderForm {
  const blank = (r: OrderRow) => r.itemId === null && r.qty === null;
  const rows = [...form.rows.filter((r) => !blank(r)), form.rows.filter(blank).pop() ?? blankOrderRow()];
  return rows.length === form.rows.length && rows.every((r, i) => r === form.rows[i]) ? form : { ...form, rows };
}

function OrderFormView({ saved, direction, godowns, title, partyId }: { saved: JobWorkOrderDetail | null; direction: JobWorkDirection; godowns: readonly GodownDto[]; title: string; partyId?: number }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const features = useFeatures();
  const working = useWorkingDate();
  const canCreate = useCan('vouchers.create');
  const canAlter = useCan('vouchers.alter');
  const canDelete = useCan('vouchers.delete');
  const T = ORDER_TITLES[direction];
  const kind = ORDER_GODOWN_KIND[direction];
  const myGodowns = useMemo(() => godowns.filter((g) => g.thirdPartyKind === kind).map((g) => ({ ...g, kind: g.thirdPartyKind })), [godowns, kind]);
  const initial = useMemo(() => {
    const f = saved ? orderFormFrom(saved) : emptyOrderForm(direction, working.date);
    if (!saved && partyId !== undefined) {
      f.partyLedgerId = partyId;
      f.godownId = godownForParty(myGodowns, partyId, kind)?.id ?? null;
    }
    return withBlank(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [form, setFormRaw] = useState<OrderForm>(initial);
  const setForm = (fn: (f: OrderForm) => OrderForm) => setFormRaw((f) => withBlank(fn(f)));
  const strip = (f: OrderForm) => JSON.stringify({ ...f, rows: f.rows.map(({ key: _k, ...r }) => r) });
  const dirty = strip(form) !== strip(initial);
  const [errors, setErrors] = useState<{ rows: Map<string, string>; fields: Record<string, string>; general: string[] }>({ rows: new Map(), fields: {}, general: [] });
  const readOnly = saved ? !canAlter : !canCreate;
  const save = useApiMutation('mfg.jobWorkOrder.save', { invalidates: MFG_INVALIDATES });
  const del = useApiMutation('mfg.jobWorkOrder.delete', { invalidates: MFG_INVALIDATES });
  const bomsQ = useApiQuery('mfg.bom.list', { itemId: form.itemId ?? 0 }, { enabled: form.itemId !== null && features.manufacturing });
  const bomQ = useApiQuery('mfg.bom.get', { id: form.bomId ?? 0 }, { enabled: form.bomId !== null });

  const submit = async () => {
    if (save.pending || readOnly) return;
    const { input, lineKeys } = toOrderInput(form, saved ? { id: saved.id, updatedAt: saved.updatedAt } : undefined);
    if (!input) {
      setErrors({ rows: new Map(), fields: { partyLedgerId: `Select the ${T.party.toLowerCase()}.` }, general: [] });
      return;
    }
    try {
      const out = await save.mutate(input);
      toast.success(`${T.one} ${out.number} saved`);
      nav.pop();
    } catch (err) {
      const mapped = mapOrderErrors(fieldErrorsOf(err), lineKeys);
      if (mapped.rows.size === 0 && Object.keys(mapped.fields).length === 0 && mapped.general.length === 0) mapped.general.push(userMessage(err));
      setErrors(mapped);
    }
  };
  const remove = async () => {
    if (!saved) return;
    if (!(await confirm({ title: `Delete ${T.one} ${saved.number}?`, message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success('Job work order deleted');
      nav.pop();
    } catch (err) {
      setErrors({ rows: new Map(), fields: {}, general: [userMessage(err)] });
    }
  };
  const fillFromBom = () => {
    const bom = bomQ.data;
    if (!bom || form.qty === null || form.qty <= 0) {
      toast.info('Choose the item, its bill of materials and the quantity first.');
      return;
    }
    const rows = explodeBom(bom.lines.filter((l) => l.kind === 'component'), bom.outputQty, form.qty).map((e) =>
      blankOrderRow({ itemId: e.line.itemId, itemName: e.line.itemName, unit: e.line.unit, decimals: e.line.unitDecimals, qty: e.qty }),
    );
    setForm((f) => ({ ...f, rows }));
  };
  const patchRow = (key: string, patch: Partial<OrderRow>) => setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const removeLine = () => {
    const key = focusedRowKey();
    if (!key || !form.rows.some((r) => r.key === key)) return;
    setForm((f) => ({ ...f, rows: f.rows.filter((r) => r.key !== key) }));
  };
  const insertLine = () => {
    const key = focusedRowKey();
    const i = key ? form.rows.findIndex((r) => r.key === key) : -1;
    if (i < 0) return;
    const fresh = blankOrderRow();
    setForm((f) => ({ ...f, rows: [...f.rows.slice(0, i), fresh, ...f.rows.slice(i)] }));
    focusRow(fresh.key);
  };
  const challan = (cls: 'material_out' | 'material_in') => saved && nav.push('mfg.journal.entry', { cls, jobWorkOrderId: saved.id, partyId: saved.partyLedgerId });

  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void submit() });
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || save.pending },
    { key: 'Alt+B', label: 'Fill from BOM', icon: 'layers', onClick: fillFromBom, hidden: readOnly || !features.manufacturing, group: 'lines' },
    { key: 'Ctrl+D', label: 'Remove line', icon: 'minus', onClick: removeLine, hidden: readOnly, group: 'lines' },
    { key: 'Alt+N, Ctrl+N', label: 'Insert line', icon: 'plus', onClick: insertLine, hidden: readOnly, group: 'lines' },
    { key: 'Alt+O', label: 'Material Out', icon: 'upload', onClick: () => challan('material_out'), hidden: !saved || !canCreate, group: 'go' },
    { key: 'Alt+I', label: 'Material In', icon: 'download', onClick: () => challan('material_in'), hidden: !saved || !canCreate, group: 'go' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !saved || !canDelete, group: 'danger' },
  ];

  const progress = new Map((saved?.lines ?? []).map((l) => [l.itemId, l]));
  const columns: LineColumn[] = [
    { key: 'item', header: 'Item' },
    { key: 'qty', header: 'Quantity', width: 140, num: true },
    { key: 'goods', header: 'Goods (s.143)', width: 170 },
    ...(saved ? [{ key: 'sent', header: direction === 'out' ? 'Sent' : 'Received', width: 100, num: true }, { key: 'back', header: direction === 'out' ? 'Used / back' : 'Returned', width: 110, num: true }] : []),
  ];
  const rows: LineRow[] = form.rows.map((r) => {
    const p = r.itemId !== null ? progress.get(r.itemId) : undefined;
    return {
      key: r.key,
      error: errors.rows.get(r.key),
      cells: {
        item: (
          <ItemPicker
            size="sm"
            aria-label="Material"
            goodsOnly
            value={r.itemId !== null ? { id: r.itemId, name: r.itemName } : null}
            onChange={(it: ItemPickerRow | null) => patchRow(r.key, it ? { itemId: it.id, itemName: it.name, unit: it.unitSymbol, decimals: it.unitDecimals } : { itemId: null, itemName: '', unit: '' })}
            readOnly={readOnly}
          />
        ),
        qty: <QuantityInput size="sm" aria-label="Quantity" value={r.qty} onChange={(q) => patchRow(r.key, { qty: q })} unit={r.unit} decimals={r.decimals || 3} readOnly={readOnly} />,
        goods: <Select<JobWorkGoodsType> size="sm" aria-label="Goods type" value={r.goodsType} onChange={(v) => patchRow(r.key, { goodsType: v })} disabled={readOnly} options={GOODS_OPTIONS} />,
        sent: p ? <span className="bx-mfg-lines__value">{p.sentQty}</span> : null,
        back: p ? <span className="bx-mfg-lines__value">{p.returnedQty}</span> : null,
      },
    };
  });
  const boms = bomsQ.data?.rows ?? [];

  return (
    <Screen
      title={saved ? `${T.one} ${saved.number}` : title}
      subtitle={saved ? `${saved.partyName} · ${saved.status === 'closed' ? 'Closed' : 'Open'}${saved.qty !== null ? ` · done ${saved.productDoneQty} of ${saved.qty} ${saved.unit ?? ''}` : ''}` : undefined}
      icon="truck"
      width="form"
      dirty={dirty}
      actions={actions}
      hint="Enter Next field · Ctrl+A Save · Alt+B Fill from BOM · Ctrl+D Remove line · Alt+O Material Out · Alt+I Material In · Esc Back"
    >
      <div ref={formRef}>
        <Stack gap={4}>
          {errors.general.length > 0 ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setErrors((e) => ({ ...e, general: [] }))}>
              {errors.general.join(' ')}
            </Banner>
          ) : null}
          <FieldGroup columns={3}>
            <Field label="Order no." optional error={errors.fields.number} hint="Blank: the next number.">
              <TextInput value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} maxLength={30} readOnly={readOnly} placeholder="Automatic" />
            </Field>
            <Field label="Date" required error={errors.fields.date}>
              <DateInput value={form.date} onChange={(d) => d && setForm((f) => ({ ...f, date: d }))} referenceDate={working.date} readOnly={readOnly} />
            </Field>
            <Field label="Due date" optional error={errors.fields.dueDate}>
              <DateInput value={form.dueDate} onChange={(d) => setForm((f) => ({ ...f, dueDate: d }))} referenceDate={form.date} readOnly={readOnly} />
            </Field>
            <Field label={T.party} required error={errors.fields.partyLedgerId}>
              <LedgerPicker
                classes={['party']}
                value={form.partyLedgerId}
                onChange={(pid) => setForm((f) => ({ ...f, partyLedgerId: pid, godownId: f.godownId ?? godownForParty(myGodowns, pid, kind)?.id ?? null }))}
                showBalance={false}
                readOnly={readOnly}
                autoFocus={!saved}
              />
            </Field>
            <Field label="Job work godown" optional error={errors.fields.godownId} hint={myGodowns.length === 0 ? `No godown is marked “${direction === 'out' ? 'Our stock with third party' : 'Third-party stock with us'}” yet.` : undefined}>
              <Select
                value={form.godownId === null ? '' : String(form.godownId)}
                onChange={(v) => setForm((f) => ({ ...f, godownId: v === '' ? null : Number(v) }))}
                disabled={readOnly}
                options={[{ value: '', label: 'None' }, ...myGodowns.map((g) => ({ value: String(g.id), label: `${g.name}${g.partyName ? ` — ${g.partyName}` : ''}` }))]}
              />
            </Field>
            <Field label="Status">
              <Select<'open' | 'closed'> value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} disabled={readOnly || !saved} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} />
            </Field>
          </FieldGroup>
          <FieldGroup columns={3} legend={direction === 'out' ? 'Goods to be made by the job worker' : 'Goods to be made for the principal'}>
            <Field label="Item" optional error={errors.fields.itemId}>
              <ItemPicker goodsOnly value={form.itemId !== null ? { id: form.itemId, name: form.itemName } : null} onChange={(it) => setForm((f) => ({ ...f, itemId: it?.id ?? null, itemName: it?.name ?? '', unit: it?.unitSymbol ?? '', decimals: it?.unitDecimals ?? 0, bomId: it && it.id === f.itemId ? f.bomId : null }))} readOnly={readOnly} />
            </Field>
            <Field label="Quantity" optional error={errors.fields.qty}>
              <QuantityInput value={form.qty} onChange={(q) => setForm((f) => ({ ...f, qty: q }))} unit={form.unit} decimals={form.decimals || 3} readOnly={readOnly || form.itemId === null} />
            </Field>
            {features.manufacturing ? (
              <Field label="Bill of materials" optional error={errors.fields.bomId} hint="Alt+B fills the material from it.">
                <Select
                  value={form.bomId === null ? '' : String(form.bomId)}
                  onChange={(v) => setForm((f) => ({ ...f, bomId: v === '' ? null : Number(v) }))}
                  disabled={readOnly || form.itemId === null}
                  options={[{ value: '', label: 'None' }, ...boms.map((b) => ({ value: String(b.id), label: `${b.name}${b.isDefault ? ' (default)' : ''}` }))]}
                />
              </Field>
            ) : null}
            <Field label="Process" optional error={errors.fields.process} hint="Nature of job work, e.g. Machining.">
              <TextInput value={form.process} onChange={(e) => setForm((f) => ({ ...f, process: e.target.value }))} maxLength={200} readOnly={readOnly} />
            </Field>
            <Field label="Job charges per unit (₹)" optional error={errors.fields.rate}>
              <NumberInput value={form.rate} onChange={(v) => setForm((f) => ({ ...f, rate: v }))} decimals={2} min={0} readOnly={readOnly} />
            </Field>
          </FieldGroup>
          <LinesTable caption={direction === 'out' ? 'Material to send' : 'Material the principal sends'} columns={columns} rows={rows} />
          <Field label="Narration" optional hint="Ctrl+Enter to move on.">
            <TextArea value={form.narration} onChange={(e) => setForm((f) => ({ ...f, narration: e.target.value }))} rows={2} autoGrow maxRows={5} maxLength={2000} readOnly={readOnly} />
          </Field>
          {saved && saved.vouchers.length > 0 ? (
            <section aria-label="Vouchers against this order">
              <h2 className="bx-mfg-section__title">Vouchers against this order</h2>
              <DataTable<JobWorkOrderDetail['vouchers'][number]>
                aria-label="Vouchers against this order"
                columns={[
                  { key: 'date', header: 'Date', kind: 'date', width: 110 },
                  { key: 'typeName', header: 'Type', width: 180 },
                  { key: 'number', header: 'No.', value: (v) => v.number ?? '' },
                ]}
                rows={saved.vouchers}
                getRowKey={(v) => String(v.id)}
                onRowActivate={(v) => nav.push('vouchers.view', { id: v.id })}
              />
            </section>
          ) : null}
          {saved?.dueDate && saved.status === 'open' && saved.dueDate < working.date ? <Banner tone="warning">Past its due date ({formatDate(saved.dueDate)}).</Banner> : null}
          <div>
            <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} disabled={readOnly} onClick={() => void submit()} data-enter-target="">
              Save
            </Button>
          </div>
        </Stack>
      </div>
    </Screen>
  );
}
