/**
 * 'inventory.priceList' — Price Lists (feature: Price levels). Params: { priceLevelId?, itemId?, date? }.
 * Choose a price level (Wholesale, Retail…) and the date the rates apply from, then give each item
 * one or more quantity slabs: from / up to (blank = and above) / rate / discount. Slabs of an item
 * may not overlap (checked as you type). Only items whose slabs changed are saved; edits survive
 * changing the search or group filter.
 */
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PriceLevelDto } from '../../../shared/types/inventory.ts';
import {
  api,
  fieldErrorsOf,
  formatDate,
  formatMoney,
  formatRate,
  Screen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useDirty,
  useFeatures,
  useNav,
  useWorkingDate,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import {
  Banner,
  Button,
  DateInput,
  EmptyState,
  Field,
  IconButton,
  Modal,
  NumberInput,
  PercentInput,
  QuantityInput,
  Select,
  Stack,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useHotkeys,
  useToast,
} from '../../ui/index.ts';
import { FeatureOff, focusField, INVENTORY_INVALIDATES } from './common.tsx';
import type { ItemSlabs, SlabDraft } from './lib/slabs.ts';
import { emptySlab, itemSlabsFromList, netRate, nextSlabFrom, priceListChanges, slabErrors, slabGaps } from './lib/slabs.ts';
import { isShownValue } from './lib/opening.ts';
import { StockGroupPicker } from './pickers.tsx';
import './inventory.css';

/** Items rendered at once (the grid is not virtualised; narrow with search / group). */
const MAX_SHOWN = 300;
const PID = 'inv-pl-';
const cellId = (slabKey: string, f: string): string => `${PID}${slabKey}-${f}`;

export interface PriceListParams {
  priceLevelId?: number;
  itemId?: number;
  date?: string;
}

export function PriceListScreen({ params }: ScreenProps<PriceListParams>) {
  const features = useFeatures();
  const on = features.inventory && features.priceLevels;
  const levels = useApiQuery('inventory.priceLevel.list', { limit: 5000 }, { enabled: on });
  if (!on) {
    return (
      <Screen title="Price Lists" icon="tag">
        <FeatureOff
          title={features.inventory ? 'Price levels are turned off' : 'Inventory is turned off'}
          body="Turn on Price levels in Features (F11) to keep separate rates for wholesale, retail or other customer groups."
        />
      </Screen>
    );
  }
  if (levels.error || !levels.data) return <Screen title="Price Lists" icon="tag" loading={!levels.error} error={levels.error ?? undefined} onRetry={() => void levels.refetch()} />;
  return <PriceListBody levels={levels.data.rows} params={params} />;
}

function PriceListBody({ levels, params }: { levels: readonly PriceLevelDto[]; params: PriceListParams }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const { date: workingDate } = useWorkingDate();
  const canCreate = useCan('masters.create');
  const canAlter = useCan('masters.alter');
  const [levelId, setLevelId] = useState<number | null>(typeof params.priceLevelId === 'number' ? params.priceLevelId : (levels[0]?.id ?? null));
  const [date, setDate] = useState<string>(typeof params.date === 'string' ? params.date : workingDate);
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [levelDialog, setLevelDialog] = useState<null | { id?: number; name: string }>(null);
  /** Loaded slabs per item (as on `date`) and the user's edits, by item id. */
  const [original, setOriginal] = useState<Map<number, ItemSlabs>>(() => new Map());
  const [edits, setEdits] = useState<Map<number, ItemSlabs>>(() => new Map());
  const [banner, setBanner] = useState<string | null>(null);
  const term = useDebouncedValue(search.trim(), 200);
  const save = useApiMutation('inventory.priceList.save', { invalidates: INVENTORY_INVALIDATES });
  const delLevel = useApiMutation('inventory.priceLevel.delete', { invalidates: INVENTORY_INVALIDATES });
  const canDelete = useCan('masters.delete');

  // An item named in params: search for it.
  useEffect(() => {
    if (typeof params.itemId !== 'number') return;
    let live = true;
    api('inventory.item.get', { id: params.itemId }).then(
      (it) => {
        if (live) setSearch(it.name);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [params.itemId]);

  const q = useApiQuery(
    'inventory.priceList.get',
    { priceLevelId: levelId ?? 0, date, includeAllItems: true, ...(term ? { search: term } : {}), ...(groupId !== null ? { groupId } : {}) },
    { enabled: levelId !== null, keepPrevious: true, staleTime: 0 },
  );

  // Remember what the server says for each item (first time seen for this level/date).
  useEffect(() => {
    if (!q.data || q.isPrevious) return;
    setOriginal((prev) => {
      const next = new Map(prev);
      for (const it of itemSlabsFromList(q.data?.rows ?? [])) if (!next.has(it.itemId)) next.set(it.itemId, it);
      return next;
    });
  }, [q.data, q.isPrevious]);

  const changes = useMemo(() => priceListChanges([...edits.values()], [...original.values()], date), [edits, original, date]);
  const keptMessage = useMemo(() => {
    if (!changes.keptItemIds.length) return '';
    const names = changes.keptItemIds.map((id) => original.get(id)?.itemName ?? `Item ${id}`);
    const dates = [...new Set(changes.keptItemIds.map((id) => original.get(id)?.applicableFrom).filter((x): x is string => !!x))];
    return (
      `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''} keep${names.length === 1 ? 's' : ''} the list from ${dates.map((x) => formatDate(x)).join(' / ')}: ` +
      `a list cannot be ended on a later date. To remove it, choose its own date (${dates.map((x) => formatDate(x)).join(' / ')}) and clear the slabs there; or enter the rates that apply from ${formatDate(date)}.`
    );
  }, [changes.keptItemIds, original, date]);
  const dirty = changes.changedItemIds.length > 0;
  useDirty(dirty);

  const shownItems = useMemo(() => {
    const rows = q.data?.rows ?? [];
    return rows.slice(0, MAX_SHOWN).map((r) => edits.get(r.itemId) ?? original.get(r.itemId) ?? itemSlabsFromList([r])[0]);
  }, [q.data, edits, original]);
  const total = q.data?.rows.length ?? 0;

  const errorsByItem = useMemo(() => {
    const out = new Map<number, Record<string, string>>();
    for (const it of edits.values()) {
      const e = slabErrors(it.slabs);
      if (Object.keys(e).length) out.set(it.itemId, e);
    }
    return out;
  }, [edits]);
  const allErrors = useMemo(() => Object.assign({}, ...[...errorsByItem.values()]) as Record<string, string>, [errorsByItem]);

  const editItem = (it: ItemSlabs, slabs: SlabDraft[]): void => {
    setEdits((m) => new Map(m).set(it.itemId, { ...it, slabs }));
  };
  const editSlab = (it: ItemSlabs, key: string, p: Partial<SlabDraft>): void => editItem(it, it.slabs.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const addSlab = (it: ItemSlabs): void => {
    const s = emptySlab(it.itemId, nextSlabFrom(it.slabs));
    editItem(it, [...it.slabs, s]);
    window.setTimeout(() => focusField(cellId(s.key, 'qtyFrom')), 0);
  };
  const removeSlab = (it: ItemSlabs, key: string): void => {
    const rest = it.slabs.filter((s) => s.key !== key);
    editItem(it, rest.length ? rest : [emptySlab(it.itemId)]);
  };

  const resetEdits = async (apply: () => void): Promise<void> => {
    if (dirty && !(await confirm({ title: 'Discard the rates you changed?', message: 'Changing the price level or the date loads that list instead.', confirmLabel: 'Discard', tone: 'danger' }))) return;
    setEdits(new Map());
    setOriginal(new Map());
    apply();
  };

  const submit = async (): Promise<void> => {
    if (save.pending || levelId === null) return;
    if (!dirty) {
      toast.info('Nothing to save', { message: 'Type a rate against an item first.' });
      return;
    }
    const firstErr = Object.keys(allErrors)[0];
    if (firstErr) {
      const [key, f] = firstErr.split('.');
      setBanner('Some slabs need attention — see the messages in red.');
      focusField(cellId(key, f));
      return;
    }
    setBanner(null);
    const saving = changes.changedItemIds.length - changes.keptItemIds.length;
    if (changes.rows.length === 0 && changes.clearItemIds.length === 0) {
      // Only lists dated earlier were emptied: there is nothing to record on this date.
      setBanner(keptMessage);
      return;
    }
    try {
      await save.mutate({ priceLevelId: levelId, applicableFrom: date, rows: changes.rows, ...(changes.clearItemIds.length ? { clearItemIds: changes.clearItemIds } : {}) });
      toast.success(`Price list saved`, { message: `${saving} item${saving === 1 ? '' : 's'} from ${formatDate(date)}.` });
      if (changes.keptItemIds.length) toast.warning('Some lists were kept', { message: keptMessage });
      setEdits(new Map());
      setOriginal(new Map());
      void q.refetch();
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const level = levels.find((l) => l.id === levelId) ?? null;

  const removeLevel = async (): Promise<void> => {
    if (!level || delLevel.pending) return;
    const ok = await confirm({
      title: `Delete price level “${level.name}”?`,
      message: 'Its price lists for every date are removed too. A level already used in vouchers cannot be deleted. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await delLevel.mutate({ id: level.id });
      toast.success(`Price level “${level.name}” deleted`);
      setEdits(new Map());
      setOriginal(new Map());
      setLevelId(levels.find((l) => l.id !== level.id)?.id ?? null);
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  if (levels.length === 0 || levelId === null) {
    return (
      <Screen title="Price Lists" icon="tag" actions={[{ key: 'Alt+C', label: 'Create price level', icon: 'plus', primary: true, onClick: () => setLevelDialog({ name: '' }), hidden: !canCreate }]}>
        <EmptyState
          icon="tag"
          title="No price levels yet"
          body="A price level is a set of rates for a kind of customer — for example Wholesale, Retail or Dealer. Create one to start."
          action={
            canCreate ? (
              <Button variant="primary" icon="plus" shortcut="Alt+C" onClick={() => setLevelDialog({ name: '' })}>
                Create price level
              </Button>
            ) : undefined
          }
        />
        {levelDialog ? <LevelDialog initial={levelDialog} onClose={(created) => { setLevelDialog(null); if (created) setLevelId(created.id); }} /> : null}
      </Screen>
    );
  }

  return (
    <Screen
      title="Price Lists"
      subtitle={level ? `${level.name} — rates from ${formatDate(date)}` : undefined}
      icon="tag"
      dirty={dirty}
      hint="Enter Next cell · Ctrl+Enter Add slab · Ctrl+Delete Remove slab · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !dirty || (!canAlter && !canCreate) },
        { key: 'Alt+C', label: 'Create price level', icon: 'plus', onClick: () => setLevelDialog({ name: '' }), hidden: !canCreate, group: 'levels' },
        { key: 'Alt+R', label: 'Rename price level', icon: 'edit', onClick: () => level && setLevelDialog({ id: level.id, name: level.name }), hidden: !canAlter || !level, group: 'levels' },
        { key: 'Alt+D', label: 'Delete price level', icon: 'trash', onClick: () => void removeLevel(), hidden: !canDelete || !level, group: 'danger' },
      ]}
      footer={
        <>
          <Button onClick={() => void nav.back()}>Close</Button>
          <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()} disabled={!dirty}>
            Save {dirty ? `${changes.changedItemIds.length} item${changes.changedItemIds.length === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Price list">
        <Stack gap={3}>
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}
          <div className="bx-inv-filters" data-enter-ignore="">
            <Field label="Price level">
              <Select value={String(levelId)} onChange={(v) => void resetEdits(() => setLevelId(Number(v)))} options={levels.map((l) => ({ value: String(l.id), label: l.name }))} />
            </Field>
            <Field label="Applicable from" hint="Rates apply from this date until a later list replaces them.">
              <DateInput value={date} onChange={(v) => v && void resetEdits(() => setDate(v))} referenceDate={workingDate} />
            </Field>
            <Field label="Find items">
              <TextInput value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Item name or alias" aria-label="Find items" />
            </Field>
          </div>
          <div data-enter-ignore="">
            <Field label="Under (stock group)" optional>
              <StockGroupPicker value={groupId} onChange={(id) => setGroupId(id)} allowCreate={false} placeholder="All groups" />
            </Field>
          </div>
          {q.error ? (
            <Banner tone="danger" title="The price list could not be loaded" action={<Button size="sm" onClick={() => void q.refetch()}>Retry</Button>}>
              {userMessage(q.error)}
            </Banner>
          ) : null}
          {!q.data && !q.error ? <p className="bx-inv-note">Loading…</p> : null}
          {q.data && total === 0 ? <EmptyState icon="search" title="No items" body={term || groupId !== null ? 'No items match the search or group.' : 'Create stock items first, then give them rates here.'} /> : null}
          {shownItems.length ? (
            <div className="bx-inv-grid" role="group" aria-label={`Rates for ${level?.name ?? 'price level'}`}>
              <table className="bx-inv-grid__table">
                <colgroup>
                  <col style={{ width: '28%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: 80 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="bx-inv-grid__th" scope="col">
                      Item
                    </th>
                    <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                      Quantity from
                    </th>
                    <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                      Up to (not incl.)
                    </th>
                    <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                      Rate (₹)
                    </th>
                    <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                      Discount
                    </th>
                    <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                      Net rate (₹)
                    </th>
                    <th className="bx-inv-grid__th" scope="col">
                      <span className="bx-sr-only">Slab actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownItems.map((it) =>
                    it.slabs.map((s, k) => (
                      <SlabRow
                        key={s.key}
                        item={it}
                        slab={s}
                        first={k === 0}
                        last={k === it.slabs.length - 1}
                        errors={errorsByItem.get(it.itemId) ?? {}}
                        changed={changes.changedItemIds.includes(it.itemId)}
                        date={date}
                        onEdit={(p) => editSlab(it, s.key, p)}
                        onAdd={() => addSlab(it)}
                        onRemove={() => removeSlab(it, s.key)}
                      />
                    )),
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
          {keptMessage ? (
            <Banner tone="warning" inline title="Not removed">
              {keptMessage}
            </Banner>
          ) : null}
          {total > MAX_SHOWN ? (
            <p className="bx-inv-note">
              Showing {MAX_SHOWN} of {total.toLocaleString('en-IN')} items. Search or choose a group to see the others — your changes are kept.
            </p>
          ) : null}
        </Stack>
      </form>
      {levelDialog ? <LevelDialog initial={levelDialog} onClose={(created) => { setLevelDialog(null); if (created && levelDialog.id === undefined) void resetEdits(() => setLevelId(created.id)); }} /> : null}
    </Screen>
  );
}

interface SlabRowProps {
  item: ItemSlabs;
  slab: SlabDraft;
  first: boolean;
  last: boolean;
  errors: Record<string, string>;
  changed: boolean;
  date: string;
  onEdit: (p: Partial<SlabDraft>) => void;
  onAdd: () => void;
  onRemove: () => void;
}

function SlabRow({ item, slab: s, first, last, errors, changed, date, onEdit, onAdd, onRemove }: SlabRowProps) {
  const err = (f: string): string | undefined => errors[`${s.key}.${f}`];
  const node = (f: string) =>
    err(f) ? (
      <span className="bx-inv-grid__error" id={`${cellId(s.key, f)}-err`}>
        {err(f)}
      </span>
    ) : null;
  const desc = (f: string): string | undefined => (err(f) ? `${cellId(s.key, f)}-err` : undefined);
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.ctrlKey && !e.altKey && e.key === 'Enter') {
      e.preventDefault();
      onAdd();
    } else if (e.ctrlKey && !e.altKey && e.key === 'Delete') {
      e.preventDefault();
      onRemove();
    }
  };
  const gaps = last ? slabGaps(item.slabs) : [];
  const net = netRate(s.rate, s.discountPct);
  const label = `${item.itemName}${item.slabs.length > 1 ? ` slab ${item.slabs.indexOf(s) + 1}` : ''}`;
  return (
    <tr className="bx-inv-grid__row" onKeyDown={onKeyDown}>
      <td className="bx-inv-grid__td bx-inv-grid__td--static">
        {first ? (
          <span className="bx-inv-name">
            <span>
              {item.itemName}
              {changed ? <span className="bx-inv-override"> · changed</span> : null}
            </span>
            <span className="bx-inv-name__sub">
              {item.unitSymbol}
              {item.sellingPrice !== null ? ` · default ₹${formatMoney(item.sellingPrice)}` : ''}
              {item.applicableFrom && item.applicableFrom !== date ? ` · list from ${formatDate(item.applicableFrom)}` : ''}
            </span>
          </span>
        ) : null}
        {gaps.length ? <span className="bx-inv-grid__error">No rate for {gaps.join(', ')} — the default price applies there.</span> : null}
      </td>
      <td className="bx-inv-grid__td bx-inv-grid__td--num">
        <QuantityInput id={cellId(s.key, 'qtyFrom')} aria-label={`${label}: quantity from`} aria-describedby={desc('qtyFrom')} size="sm" value={s.qtyFrom} onChange={(v) => onEdit({ qtyFrom: v })} decimals={3} unit={item.unitSymbol} invalid={!!err('qtyFrom')} />
        {node('qtyFrom')}
      </td>
      <td className="bx-inv-grid__td bx-inv-grid__td--num">
        <QuantityInput id={cellId(s.key, 'qtyTo')} aria-label={`${label}: up to quantity, blank for no limit`} aria-describedby={desc('qtyTo')} size="sm" value={s.qtyTo} onChange={(v) => onEdit({ qtyTo: v })} decimals={3} unit={item.unitSymbol} placeholder="and above" invalid={!!err('qtyTo')} />
        {node('qtyTo')}
      </td>
      <td className="bx-inv-grid__td bx-inv-grid__td--num">
        <NumberInput id={cellId(s.key, 'rate')} aria-label={`${label}: rate in rupees`} aria-describedby={desc('rate')} size="sm" value={s.rate} onChange={(v) => { if (!isShownValue(v, s.rate, 4)) onEdit({ rate: v }); }} decimals={4} min={0} invalid={!!err('rate')} />
        {node('rate')}
      </td>
      <td className="bx-inv-grid__td bx-inv-grid__td--num">
        <PercentInput id={cellId(s.key, 'discountPct')} aria-label={`${label}: discount percent`} aria-describedby={desc('discountPct')} size="sm" value={s.discountPct} onChange={(v) => onEdit({ discountPct: v })} max={100} blankZero invalid={!!err('discountPct')} />
        {node('discountPct')}
      </td>
      <td className="bx-inv-grid__td bx-inv-grid__td--num bx-inv-grid__td--static">{net === null ? '' : formatRate(net)}</td>
      <td className="bx-inv-grid__td">
        <span className="bx-inv-grid__actions">
          {last ? <IconButton icon="plus" size="sm" variant="ghost" aria-label={`Add a quantity slab for ${item.itemName}`} tabIndex={-1} onClick={onAdd} /> : null}
          <IconButton icon="trash" size="sm" variant="ghost" aria-label={`Remove this slab of ${item.itemName}`} tabIndex={-1} onClick={onRemove} />
        </span>
      </td>
    </tr>
  );
}

/** Create or rename a price level (small modal; Ctrl+A saves). */
function LevelDialog({ initial, onClose }: { initial: { id?: number; name: string }; onClose: (saved: PriceLevelDto | null) => void }) {
  const toast = useToast();
  const save = useApiMutation('inventory.priceLevel.save', { invalidates: INVENTORY_INVALIDATES });
  const [name, setName] = useState(initial.name);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (save.pending) return;
    if (!name.trim()) {
      setError('Enter the price level name, e.g. Wholesale');
      return;
    }
    try {
      const out = await save.mutate({ ...(initial.id !== undefined ? { id: initial.id } : {}), name: name.trim() });
      toast.success(initial.id !== undefined ? `Price level renamed to “${out.name}”` : `Price level “${out.name}” created`);
      onClose(out);
    } catch (err) {
      // Read the error itself: save.fieldErrors is React state and not updated yet here.
      setError(fieldErrorsOf(err).name ?? userMessage(err));
    }
  };
  return (
    <Modal
      open
      onClose={() => onClose(null)}
      title={initial.id !== undefined ? 'Rename Price Level' : 'Create Price Level'}
      size="sm"
      footer={
        <>
          <Button onClick={() => onClose(null)}>Cancel</Button>
          <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <LevelKeys onAccept={() => void submit()} />
      <Field label="Name" required error={error ?? undefined} hint="e.g. Wholesale, Retail, Dealer">
        <TextInput
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          maxLength={100}
          data-autofocus=""
          autoComplete="off"
        />
      </Field>
    </Modal>
  );
}

function LevelKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
