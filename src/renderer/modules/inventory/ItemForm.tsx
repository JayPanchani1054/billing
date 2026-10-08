/**
 * 'inventory.item.form' — Stock Item Creation / Alteration.
 * Params: { id?: number; initialName?: string; forResult?: boolean; groupId?: number }.
 * Opened for a result (pushForResult from an ItemPicker), saving returns { id, name }.
 *
 * One Tally-style page: Enter moves through every field, Ctrl+A saves. Sections: Basic, Tax (GST
 * on), Pricing, Stock (goods only) and Opening stock (goods only).
 */
import { useMemo, useState } from 'react';
import type { GodownDto, GstHistoryRow, StockGroupDto, StockItemDetail, UnitDto } from '../../../shared/types/inventory.ts';
import type { CompanyConfig } from '../../../shared/settings.ts';
import {
  api,
  formatDate,
  formatMoney,
  formatPercent,
  formatRate,
  invalidate,
  Screen,
  useApiMutation,
  useApiQuery,
  useBooks,
  useCan,
  useCompany,
  useCompanyConfig,
  useConfirm,
  useFeatures,
  useNav,
  useScreenResult,
  useWorkingDate,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import {
  AmountInput,
  Banner,
  Button,
  Field,
  FieldGroup,
  NumberInput,
  Panel,
  QuantityInput,
  Select,
  Stack,
  Switch,
  TextArea,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import { FeatureOff, focusField, focusFirstError, INVENTORY_INVALIDATES, splitApiError } from './common.tsx';
import { GstFields } from './GstFields.tsx';
import type { ItemDraft, ItemErrors, ItemFormContext } from './lib/itemForm.ts';
import {
  COSTING_INFO,
  costingInfo,
  effectiveGstText,
  emptyItemDraft,
  gstDetailsChanged,
  inheritedGroupGst,
  inheritedGstText,
  itemDraftDirty,
  itemDraftFromDetail,
  itemDraftWarnings,
  itemSaveInput,
  validateItemDraft,
} from './lib/itemForm.ts';
import type { OpeningContext, OpeningField } from './lib/opening.ts';
import { emptyOpening, remapOpeningErrors } from './lib/opening.ts';
import { netRate, qtyText } from './lib/slabs.ts';
import { altUnitText } from './lib/units.ts';
import { openingCellId, OpeningStockGrid } from './OpeningStockGrid.tsx';
import { StockCategoryPicker, StockGroupPicker, UnitPicker } from './pickers.tsx';
import './inventory.css';

export interface ItemFormParams {
  id?: number;
  initialName?: string;
  forResult?: boolean;
  /** Pre-select this stock group for a new item. */
  groupId?: number;
}

const ID = 'inv-item-';
const OPEN_ID = 'inv-item-open-';

/** Order used to focus the first invalid field. */
const FIELD_ORDER = [
  'name',
  'alias',
  'partNo',
  'barcode',
  'description',
  'groupId',
  'categoryId',
  'unitId',
  'altUnitId',
  'altConversion',
  'gstRate',
  'cessRate',
  'cessPerUnit',
  'hsnSac',
  'gstApplicableFrom',
  'mrp',
  'sellingPrice',
  'purchasePrice',
  'standardCost',
  'costingMethod',
  'reorderLevel',
  'minOrderQty',
  'maintainBatches',
] as const;

function idOf(key: string): string {
  const m = /^openings\.(\d+)\.(\w+)$/.exec(key);
  if (m) return openingCellId(OPEN_ID, Number(m[1]), m[2] as OpeningField);
  if (key === 'openings') return `${ID}openings`;
  return `${ID}${key}`;
}

const KNOWN = new Set<string>([...FIELD_ORDER, 'openings', 'isService', 'trackMfgDate', 'useExpiry', 'taxability']);
const isKnownKey = (k: string): boolean => KNOWN.has(k) || /^openings\.\d+\.\w+$/.test(k);

export function ItemFormScreen({ params }: ScreenProps<ItemFormParams>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const features = useFeatures();
  const existing = useApiQuery('inventory.item.get', { id: id ?? 0 }, { enabled: id !== undefined && features.inventory, staleTime: 0 });
  const units = useApiQuery('inventory.unit.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  const godowns = useApiQuery('inventory.godown.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  // Same query as the group picker (shared cache): the GST an item would inherit from its group.
  const groups = useApiQuery('inventory.group.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  const config = useCompanyConfig();
  const title = id === undefined ? 'Stock Item Creation' : 'Stock Item Alteration';
  if (!features.inventory) {
    return (
      <Screen title={title} icon="box" width="form">
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock items." />
      </Screen>
    );
  }
  const error = existing.error ?? units.error ?? godowns.error;
  const loading = (id !== undefined && !existing.data) || !units.data || !godowns.data || !config;
  if (error || loading) {
    return (
      <Screen
        title={title}
        icon="box"
        width="form"
        loading={!error}
        error={error ?? undefined}
        onRetry={() => {
          void existing.refetch();
          void units.refetch();
          void godowns.refetch();
        }}
      />
    );
  }
  return (
    <ItemFormBody
      key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'}
      saved={existing.data ?? null}
      params={params}
      units={units.data?.rows ?? []}
      godowns={godowns.data?.rows ?? []}
      groups={groups.data?.rows}
      config={config as CompanyConfig}
    />
  );
}

interface BodyProps {
  saved: StockItemDetail | null;
  params: ItemFormParams;
  units: readonly UnitDto[];
  godowns: readonly GodownDto[];
  /** Undefined while loading (the inherited GST is then not known). */
  groups: readonly StockGroupDto[] | undefined;
  config: CompanyConfig;
}

function ItemFormBody({ saved, params, units, godowns, groups, config }: BodyProps) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const company = useCompany();
  const features = useFeatures();
  const { booksFrom } = useBooks();
  const { date: workingDate } = useWorkingDate();
  const canDelete = useCan('masters.delete');
  const canAlter = useCan('masters.alter');
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const save = useApiMutation('inventory.item.save', { invalidates: INVENTORY_INVALIDATES });
  const del = useApiMutation('inventory.item.delete', { invalidates: INVENTORY_INVALIDATES });

  const initial = useMemo<ItemDraft>(() => {
    if (saved) return itemDraftFromDetail(saved);
    const d = emptyItemDraft({ name: params.initialName ?? '', groupId: typeof params.groupId === 'number' ? params.groupId : null });
    const nos = units.find((u) => u.symbol.toLowerCase() === 'nos' && !u.isCompound);
    return { ...d, unitId: nos?.id ?? null };
  }, [saved, params.initialName, params.groupId, units]);
  const [base, setBase] = useState<ItemDraft>(initial);
  const [d, setD] = useState<ItemDraft>(initial);
  const [errors, setErrors] = useState<ItemErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [created, setCreated] = useState(0);

  const dirty = itemDraftDirty(d, base);
  const mainGodown = godowns.find((g) => g.isPredefined) ?? null;
  const unit = units.find((u) => u.id === d.unitId) ?? null;
  const altUnit = units.find((u) => u.id === d.altUnitId) ?? null;
  const savedOpenings = saved?.openings ?? [];
  const showGodown = features.multipleGodowns || savedOpenings.some((o) => o.godownId !== mainGodown?.id);
  const showBatches = d.maintainBatches && !d.isService && (features.batches || savedOpenings.some((o) => o.batchName));
  const datesOn = features.expiryDates || savedOpenings.some((o) => o.expiryDate || o.mfgDate);
  const openingCtx: OpeningContext = {
    multipleGodowns: showGodown,
    batches: showBatches,
    trackMfgDate: showBatches && d.trackMfgDate && datesOn,
    useExpiry: showBatches && d.useExpiry && datesOn,
    unitSymbol: unit?.symbol ?? '',
    unitDecimals: unit?.decimalPlaces ?? 0,
  };
  const inheritedGst = groups ? inheritedGroupGst(groups, d.groupId) : undefined;
  const ctx: ItemFormContext = {
    gstEnabled: company.gstEnabled,
    hsnDigits: config.gst.hsnDigits,
    opening: openingCtx,
    hasGstHistory: (saved?.gstHistory.length ?? 0) > 0,
    inheritedGst,
  };
  // Where the GST comes from while "Set GST details here" is off: the server's resolution (dated
  // history included) for the saved group, else the group chain's current details.
  const inheritText =
    saved && d.groupId === saved.groupId && !saved.gstApplicable
      ? effectiveGstText(saved.effectiveGst, saved.groupName)
      : inheritedGst !== undefined
        ? inheritedGstText(inheritedGst)
        : undefined;
  /** Messages of fields not on screen (e.g. a section hidden for services) — shown in the banner instead. */
  const unseenErrors = (e: ItemErrors): string | null => {
    const lost = Object.entries(e).filter(([k, v]) => v && typeof document !== 'undefined' && !document.getElementById(idOf(k)));
    return lost.length ? lost.map(([, v]) => v).join(' ') : null;
  };
  /** Errors of hidden opening columns are shown on the row's quantity (never invisible). */
  const withOpeningErrorsShown = (e: ItemErrors): ItemErrors => {
    const cells: Record<string, string> = {};
    const rest: ItemErrors = {};
    for (const [k, v] of Object.entries(e)) {
      if (!v) continue;
      if (/^openings\.\d+\.\w+$/.test(k)) cells[k.slice('openings.'.length)] = v;
      else rest[k] = v;
    }
    for (const [k, v] of Object.entries(remapOpeningErrors(cells, openingCtx))) rest[`openings.${k}`] = v;
    return rest;
  };
  const openingLocked = !!config.lockedUpTo && booksFrom <= config.lockedUpTo;
  const warnings = itemDraftWarnings(d, ctx);
  const canCreate = useCan('masters.create');
  const readOnly = saved !== null ? !canAlter : !canCreate;

  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]): void => {
    setD((x) => ({ ...x, [k]: v }));
    if (errors[k as string]) setErrors((e) => ({ ...e, [k]: undefined }) as ItemErrors);
  };
  const patch = (p: Partial<ItemDraft>): void => {
    setD((x) => ({ ...x, ...p }));
    const touched = Object.keys(p);
    if (touched.some((k) => errors[k])) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !touched.includes(k))));
  };

  const submit = async (mode: 'next' | 'close'): Promise<void> => {
    if (save.pending || readOnly) return;
    if (saved && !dirty) {
      if (forResult) returnResult({ id: saved.id, name: saved.name });
      else nav.pop();
      return;
    }
    const e = withOpeningErrorsShown(validateItemDraft(d, saved, ctx));
    setErrors(e);
    setBanner(unseenErrors(e));
    if (Object.values(e).some(Boolean)) {
      focusFirstError(e, FIELD_ORDER, idOf);
      return;
    }
    try {
      const out = await save.mutate(itemSaveInput(d, saved, ctx));
      const item = out.item;
      toast.success(saved ? `Stock item “${item.name}” saved` : `Stock item “${item.name}” created`);
      for (const w of out.warnings) toast.warning('Please note', { message: w });
      if (forResult) {
        returnResult({ id: item.id, name: item.name });
      } else if (!saved && mode === 'next') {
        // Tally-style: the creation screen stays for the next item, keeping group, unit and GST.
        const next: ItemDraft = {
          ...emptyItemDraft({ groupId: d.groupId }),
          categoryId: d.categoryId,
          unitId: d.unitId,
          isService: d.isService,
          gstApplicable: d.gstApplicable,
          taxability: d.taxability,
          gstRate: d.gstRate,
          cessRate: d.cessRate,
          cessPerUnit: d.cessPerUnit,
          allowNonStandardRate: d.allowNonStandardRate,
          costingMethod: d.costingMethod,
          maintainBatches: d.maintainBatches,
          trackMfgDate: d.trackMfgDate,
          useExpiry: d.useExpiry,
          rateInclusiveOfTax: d.rateInclusiveOfTax,
        };
        setBase(next);
        setD(next);
        setErrors({});
        setCreated((n) => n + 1);
        window.setTimeout(() => focusField(`${ID}name`), 0);
      } else {
        nav.pop();
      }
    } catch (err) {
      const split = splitApiError(err, isKnownKey);
      const fields = withOpeningErrorsShown(split.fields);
      setErrors(fields);
      setBanner([split.message, unseenErrors(fields)].filter(Boolean).join(' ') || null);
      if (Object.keys(fields).length) focusFirstError(fields, FIELD_ORDER, idOf);
    }
  };

  const remove = async (): Promise<void> => {
    if (!saved || del.pending) return;
    if (saved.hasTransactions) {
      toast.info(`“${saved.name}” is used in vouchers`, { message: 'Items with stock movements cannot be deleted. Mark it inactive instead (Active: No).' });
      return;
    }
    const ok = await confirm({
      title: `Delete stock item “${saved.name}”?`,
      message: saved.openings.length
        ? `Its opening stock (${qtyText(saved.openingTotal.qty)} ${saved.unitSymbol}, ₹${formatMoney(saved.openingTotal.value)}) and price lists are removed too. This cannot be undone.`
        : 'This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success(`Stock item “${saved.name}” deleted`);
      nav.pop();
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const removeHistory = async (h: GstHistoryRow): Promise<void> => {
    if (!saved) return;
    const ok = await confirm({
      title: `Remove the GST rate from ${formatDate(h.applicableFrom)}?`,
      message: 'Invoices on and after that date will use the previous rate in the history. Use this only to undo a wrongly dated change.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api('inventory.gstHistory.delete', { id: h.id });
      invalidate('inventory');
      for (const p of INVENTORY_INVALIDATES) invalidate(p);
      toast.success('Rate removed from the history');
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ enabled: !readOnly, onComplete: () => void submit('next') });
  const primaryLabel = forResult ? 'Save & return' : saved ? 'Save' : 'Save & next';
  const costing = costingInfo(d.costingMethod);

  return (
    <Screen
      title={saved ? 'Stock Item Alteration' : 'Stock Item Creation'}
      subtitle={saved ? saved.name : created > 0 ? `${created} created in this session` : undefined}
      icon="box"
      width="form"
      dirty={dirty}
      hint="Enter next field · Ctrl+A save · Alt+C create in a list · Ctrl+Enter add opening row · Esc back"
      actions={[
        { key: 'Ctrl+A', label: primaryLabel, icon: 'save', primary: true, onClick: () => void submit('next'), disabled: readOnly },
        { key: 'Alt+S', label: 'Save & close', icon: 'check', onClick: () => void submit('close'), hidden: !!saved || forResult || readOnly },
        {
          key: 'Alt+L',
          label: 'Price lists',
          icon: 'tag',
          onClick: () => nav.push('inventory.priceList', { itemId: saved?.id }),
          hidden: !saved || !features.priceLevels,
          group: 'more',
        },
        {
          key: 'Alt+D, Ctrl+D',
          label: 'Delete',
          icon: 'trash',
          onClick: () => void remove(),
          hidden: !saved || !canDelete,
          disabled: saved?.hasTransactions,
          hint: saved?.hasTransactions ? 'Used in vouchers — cannot be deleted' : undefined,
          group: 'danger',
        },
      ]}
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          {!saved && !forResult ? (
            <Button shortcut="Alt+S" loading={save.pending} onClick={() => void submit('close')} disabled={readOnly}>
              Save & close
            </Button>
          ) : null}
          <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit('next')} disabled={readOnly}>
            {primaryLabel}
          </Button>
        </>
      }
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Stock item">
        <Stack gap={4}>
          {readOnly ? (
            <Banner tone="info" inline title="View only">
              {saved ? 'You may look at stock items but not change them. Ask an administrator for permission to alter masters.' : 'You may not create stock items. Ask an administrator for permission to create masters.'}
            </Banner>
          ) : null}
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}

          {/* ── Basic ── */}
          <Panel title="Basic details" headingLevel={2}>
            <Stack gap={3}>
              <FieldGroup columns={2}>
                <Field label="Name" required htmlFor={`${ID}name`} error={errors.name}>
                  <TextInput id={`${ID}name`} value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={200} data-autofocus="" autoComplete="off" readOnly={readOnly} />
                </Field>
                <Field label="Alias" optional htmlFor={`${ID}alias`} error={errors.alias} hint="Another name to find it by (short name, local name).">
                  <TextInput id={`${ID}alias`} value={d.alias} onChange={(e) => set('alias', e.target.value)} maxLength={200} autoComplete="off" readOnly={readOnly} />
                </Field>
                <Field label="Part number" optional htmlFor={`${ID}partNo`} error={errors.partNo}>
                  <TextInput id={`${ID}partNo`} value={d.partNo} onChange={(e) => set('partNo', e.target.value)} maxLength={100} autoComplete="off" readOnly={readOnly} />
                </Field>
                <Field label="Barcode" optional htmlFor={`${ID}barcode`} error={errors.barcode} hint="Scan or type. Must be unique.">
                  <TextInput id={`${ID}barcode`} value={d.barcode} onChange={(e) => set('barcode', e.target.value)} maxLength={100} autoComplete="off" mono readOnly={readOnly} />
                </Field>
              </FieldGroup>
              {/* Out of the Enter path (a textarea takes Enter as a new line): Tab or click to reach it. */}
              <div data-enter-skip="">
                <Field label="Description" optional htmlFor={`${ID}description`} error={errors.description} hint="Printed under the item name on invoices. Enter skips it — click or Tab here to add one.">
                  <TextArea id={`${ID}description`} value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} rows={2} autoGrow maxRows={6} readOnly={readOnly} />
                </Field>
              </div>
              <FieldGroup columns={2}>
                <Field label="Under (stock group)" optional htmlFor={`${ID}groupId`} error={errors.groupId} hint="Groups share GST details and roll up in stock reports. Alt+C to create.">
                  <StockGroupPicker id={`${ID}groupId`} value={d.groupId} onChange={(gid) => set('groupId', gid)} readOnly={readOnly} />
                </Field>
                <Field label="Category" optional htmlFor={`${ID}categoryId`} error={errors.categoryId} hint="A second way to classify items (e.g. brand, size). Alt+C to create.">
                  <StockCategoryPicker id={`${ID}categoryId`} value={d.categoryId} onChange={(cid) => set('categoryId', cid)} readOnly={readOnly} />
                </Field>
              </FieldGroup>
              <FieldGroup columns={2}>
                <Field
                  label="Unit"
                  required
                  htmlFor={`${ID}unitId`}
                  error={errors.unitId}
                  hint={saved?.hasTransactions ? 'Cannot change: the item is used in vouchers.' : 'How you count it: Nos, Kg, Mtr, Box… Alt+C to create.'}
                >
                  <UnitPicker
                    id={`${ID}unitId`}
                    value={d.unitId}
                    onChange={(uid) => set('unitId', uid)}
                    disabled={saved?.hasTransactions}
                    readOnly={readOnly}
                    required
                    invalid={!!errors.unitId}
                  />
                </Field>
                <Field label="Is this a service?" htmlFor={`${ID}isService`} hint={d.isService ? 'No stock is kept; use a SAC code for GST.' : 'Goods: stock is kept and valued.'}>
                  <Switch id={`${ID}isService`} checked={d.isService} onChange={(v) => set('isService', v)} disabled={readOnly} label={d.isService ? 'Yes — service' : 'No — goods'} />
                </Field>
              </FieldGroup>
              {!d.isService ? (
                <div className="bx-inv-conversion">
                  <Field label="Alternate unit" optional htmlFor={`${ID}altUnitId`} error={errors.altUnitId} hint="A second unit you buy or sell in, e.g. Box.">
                    <UnitPicker
                      id={`${ID}altUnitId`}
                      value={d.altUnitId}
                      onChange={(uid) => patch({ altUnitId: uid, altConversion: uid === null ? null : d.altConversion })}
                      exclude={d.unitId !== null ? new Set([d.unitId]) : undefined}
                      readOnly={readOnly}
                      placeholder="None"
                    />
                  </Field>
                  {d.altUnitId !== null ? (
                    <>
                      <span className="bx-inv-conversion__eq" aria-hidden="true">
                        1 {altUnit?.symbol ?? ''} =
                      </span>
                      <Field
                        label={`${unit?.symbol ?? 'Base units'} in 1 ${altUnit?.symbol ?? 'alternate unit'}`}
                        required
                        htmlFor={`${ID}altConversion`}
                        error={errors.altConversion}
                        hint={altUnitText(unit?.symbol, altUnit?.symbol, d.altConversion) || 'e.g. 12 when 1 Box = 12 Nos'}
                      >
                        <NumberInput id={`${ID}altConversion`} value={d.altConversion} onChange={(v) => set('altConversion', v)} decimals={4} min={0} readOnly={readOnly} />
                      </Field>
                    </>
                  ) : null}
                </div>
              ) : null}
              {saved ? (
                <Field label="Active" htmlFor={`${ID}isActive`} hint={d.isActive ? 'Offered in voucher entry.' : 'Hidden from voucher entry; history and reports keep it.'}>
                  <Switch id={`${ID}isActive`} checked={d.isActive} onChange={(v) => set('isActive', v)} disabled={readOnly} label={d.isActive ? 'Yes' : 'No — inactive'} />
                </Field>
              ) : null}
            </Stack>
          </Panel>

          {/* ── Tax ── */}
          {company.gstEnabled ? (
            <Panel title="GST" headingLevel={2}>
              <Stack gap={3}>
                <GstFields
                  value={d}
                  onChange={patch}
                  errors={errors}
                  kind={d.isService ? 'services' : 'goods'}
                  hsnDigits={config.gst.hsnDigits}
                  noun="stock item"
                  existing={!!saved}
                  changed={gstDetailsChanged(d, saved)}
                  history={saved?.gstHistory ?? []}
                  onDeleteHistory={saved && canAlter ? (h) => void removeHistory(h) : undefined}
                  effectiveText={!d.gstApplicable ? inheritText : undefined}
                  unitSymbol={unit?.symbol}
                  referenceDate={workingDate}
                  idPrefix={ID}
                  savedOwn={saved?.gstApplicable ?? false}
                  readOnly={readOnly}
                />
                <Field label="Prices include GST" htmlFor={`${ID}rateInclusiveOfTax`} hint={d.rateInclusiveOfTax ? 'Rates typed in vouchers include GST; the tax is worked out backwards.' : 'Rates typed in vouchers are before GST (usual for B2B).'}>
                  <Switch id={`${ID}rateInclusiveOfTax`} checked={d.rateInclusiveOfTax} onChange={(v) => set('rateInclusiveOfTax', v)} disabled={readOnly} />
                </Field>
              </Stack>
            </Panel>
          ) : null}

          {/* ── Pricing ── */}
          <Panel title="Prices" description="Defaults offered in vouchers. You can change them on each bill." headingLevel={2}>
            <Stack gap={3}>
              <FieldGroup columns={4}>
                <Field label="MRP" optional htmlFor={`${ID}mrp`} error={errors.mrp} hint="Maximum retail price (incl. tax).">
                  <AmountInput id={`${ID}mrp`} value={d.mrp} onChange={(v) => set('mrp', v)} symbol readOnly={readOnly} />
                </Field>
                <Field label="Selling price" optional htmlFor={`${ID}sellingPrice`} error={errors.sellingPrice} hint={`Per ${unit?.symbol ?? 'unit'}${d.rateInclusiveOfTax ? ', incl. GST' : ', before GST'}.`}>
                  <AmountInput id={`${ID}sellingPrice`} value={d.sellingPrice} onChange={(v) => set('sellingPrice', v)} symbol readOnly={readOnly} />
                </Field>
                <Field label="Purchase price" optional htmlFor={`${ID}purchasePrice`} error={errors.purchasePrice} hint={`Per ${unit?.symbol ?? 'unit'}.`}>
                  <AmountInput id={`${ID}purchasePrice`} value={d.purchasePrice} onChange={(v) => set('purchasePrice', v)} symbol readOnly={readOnly} />
                </Field>
                <Field
                  label="Standard cost"
                  required={d.costingMethod === 'std_cost'}
                  optional={d.costingMethod !== 'std_cost'}
                  htmlFor={`${ID}standardCost`}
                  error={errors.standardCost}
                  hint="Used by the Standard cost method."
                >
                  <AmountInput id={`${ID}standardCost`} value={d.standardCost} onChange={(v) => set('standardCost', v)} symbol readOnly={readOnly} />
                </Field>
              </FieldGroup>
              {features.priceLevels ? <PriceLevelSummary saved={saved} onOpen={() => nav.push('inventory.priceList', { itemId: saved?.id })} /> : null}
            </Stack>
          </Panel>

          {/* ── Stock ── */}
          {!d.isService ? (
            <Panel title="Stock" headingLevel={2}>
              <Stack gap={3}>
                <Field label="Costing method" htmlFor={`${ID}costingMethod`} error={errors.costingMethod} hint={costing.explain}>
                  <Select id={`${ID}costingMethod`} value={d.costingMethod} onChange={(v) => set('costingMethod', v)} options={COSTING_INFO.map((c) => ({ value: c.value, label: c.label }))} disabled={readOnly} />
                </Field>
                <FieldGroup columns={2}>
                  <Field label="Reorder level" optional htmlFor={`${ID}reorderLevel`} error={errors.reorderLevel} hint="Stock reports flag the item when stock falls to this.">
                    <QuantityInput id={`${ID}reorderLevel`} value={d.reorderLevel} onChange={(v) => set('reorderLevel', v)} unit={unit?.symbol} decimals={unit?.decimalPlaces ?? 0} readOnly={readOnly} />
                  </Field>
                  <Field label="Minimum order quantity" optional htmlFor={`${ID}minOrderQty`} error={errors.minOrderQty} hint="Suggested quantity when you reorder.">
                    <QuantityInput id={`${ID}minOrderQty`} value={d.minOrderQty} onChange={(v) => set('minOrderQty', v)} unit={unit?.symbol} decimals={unit?.decimalPlaces ?? 0} readOnly={readOnly} />
                  </Field>
                </FieldGroup>
                {features.batches || d.maintainBatches ? (
                  <FieldGroup columns={3}>
                    <Field label="Keep in batches" htmlFor={`${ID}maintainBatches`} error={errors.maintainBatches} hint={features.batches ? 'Track stock by batch or lot number.' : 'Batches are off in F11, so vouchers do not ask for them.'}>
                      <Switch id={`${ID}maintainBatches`} checked={d.maintainBatches} onChange={(v) => patch(v ? { maintainBatches: true } : { maintainBatches: false, trackMfgDate: false, useExpiry: false })} disabled={readOnly} />
                    </Field>
                    {d.maintainBatches && (features.expiryDates || d.trackMfgDate) ? (
                      <Field label="Record manufacturing date" htmlFor={`${ID}trackMfgDate`} error={errors.trackMfgDate}>
                        <Switch id={`${ID}trackMfgDate`} checked={d.trackMfgDate} onChange={(v) => set('trackMfgDate', v)} disabled={readOnly} />
                      </Field>
                    ) : null}
                    {d.maintainBatches && (features.expiryDates || d.useExpiry) ? (
                      <Field label="Record expiry date" htmlFor={`${ID}useExpiry`} error={errors.useExpiry} hint="Batches are then offered first-expiry-first-out.">
                        <Switch id={`${ID}useExpiry`} checked={d.useExpiry} onChange={(v) => set('useExpiry', v)} disabled={readOnly} />
                      </Field>
                    ) : null}
                  </FieldGroup>
                ) : null}
              </Stack>
            </Panel>
          ) : null}

          {/* ── Opening stock ── */}
          {!d.isService ? (
            <Panel title="Opening stock" description={`Stock in hand on ${formatDate(booksFrom)} (books beginning). Value = quantity × rate, or type a value to override.`} headingLevel={2} id={`${ID}openings`}>
              <Stack gap={2}>
                {openingLocked ? (
                  <Banner tone="info" inline title="Locked">
                    The books are locked up to {formatDate(config.lockedUpTo)}, so opening stock cannot change. Bring stock in with a Stock Journal or Physical Stock voucher dated after the lock.
                  </Banner>
                ) : null}
                {errors.openings ? (
                  <Banner tone="danger" inline>
                    {errors.openings}
                  </Banner>
                ) : null}
                {d.openings.length === 0 && (openingLocked || readOnly) ? (
                  <p className="bx-inv-note">No opening stock.</p>
                ) : d.openings.length === 0 ? (
                  <div data-enter-ignore="">
                    <Button icon="plus" onClick={() => set('openings', [emptyOpening(mainGodown?.id ?? null)])}>
                      Add opening stock
                    </Button>
                  </div>
                ) : (
                  <OpeningStockGrid
                    rows={d.openings}
                    onChange={(update) => {
                      setD((x) => ({ ...x, openings: update(x.openings) }));
                      if (Object.keys(errors).some((k) => k.startsWith('openings'))) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('openings'))));
                    }}
                    ctx={openingCtx}
                    errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('openings.')).map(([k, v]) => [k.slice('openings.'.length), v]))}
                    defaultGodownId={mainGodown?.id ?? null}
                    readOnly={openingLocked || readOnly}
                    referenceDate={workingDate}
                    idPrefix={OPEN_ID}
                  />
                )}
              </Stack>
            </Panel>
          ) : null}

          {warnings.length ? (
            <Banner tone="warning" inline title="Please check">
              {warnings.join(' ')}
            </Banner>
          ) : null}
        </Stack>
      </form>
    </Screen>
  );
}

/** Price lists applicable today, per price level (read-only; edited on the Price List screen). */
function PriceLevelSummary({ saved, onOpen }: { saved: StockItemDetail | null; onOpen: () => void }) {
  if (!saved) return <p className="bx-inv-note">Save the item first, then set its price-level rates in Price Lists (Alt+L).</p>;
  return (
    <Stack gap={1}>
      {saved.priceLists.length === 0 ? (
        <p className="bx-inv-note">No price-level rates yet. Vouchers use the selling price above.</p>
      ) : (
        <ul className="bx-inv-summary" aria-label="Price levels">
          {saved.priceLists.map((pl) => (
            <li key={pl.priceLevelId}>
              {pl.priceLevelName}:{' '}
              <strong>
                {pl.slabs
                  .map((s) => {
                    const net = netRate(s.rate, s.discountPct);
                    const r = `₹${formatRate(s.rate)}${s.discountPct && net !== null ? ` less ${formatPercent(s.discountPct)} = ₹${formatRate(net)}` : ''}`;
                    return pl.slabs.length > 1 ? `${qtyText(s.qtyFrom)}${s.qtyTo === null ? '+' : `–${qtyText(s.qtyTo)}`}: ${r}` : r;
                  })
                  .join('; ')}
              </strong>{' '}
              (from {formatDate(pl.applicableFrom)})
            </li>
          ))}
        </ul>
      )}
      <div data-enter-ignore="">
        <Button size="sm" variant="ghost" icon="tag" shortcut="Alt+L" onClick={onOpen}>
          Edit price lists
        </Button>
      </div>
    </Stack>
  );
}
