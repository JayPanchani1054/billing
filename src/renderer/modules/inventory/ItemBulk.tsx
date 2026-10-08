/**
 * 'inventory.item.bulk' — Multiple Stock Item Creation (Tally's "Multiple Stock Items").
 * Params: { groupId?: number }. One row per item: name, alias, group (blank = the default "Under"
 * at the top), unit, HSN, GST rate, selling price and opening stock. A new blank row appears as
 * soon as the last one is used; Enter on an empty name finishes (asks to save). All rows are
 * created together, or none (the first problem is shown on its row).
 */
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  formatDate,
  formatMoney,
  Screen,
  useApiMutation,
  useApiQuery,
  useBooks,
  useCompany,
  useCompanyConfig,
  useFeatures,
  useNav,
  useWorkingDate,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { AmountInput, Banner, Button, Field, FieldGroup, IconButton, NumberInput, PercentInput, QuantityInput, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { FeatureOff, focusField, INVENTORY_INVALIDATES, splitApiError } from './common.tsx';
import type { BulkContext, BulkRow } from './lib/bulk.ts';
import { bulkErrorTarget, bulkInputs, bulkWarnings, emptyBulkRow, isBlankBulkRow, validateBulkRows } from './lib/bulk.ts';
import { calculatedValue } from './lib/opening.ts';
import { GodownPicker, StockGroupPicker, UnitPicker } from './pickers.tsx';
import './inventory.css';

const BID = 'inv-bulk-';
/** The core creates at most this many items per request (all or none). */
const MAX_BULK_ROWS = 1000;
const cellId = (key: string, field: string): string => `${BID}${key}-${field}`;

export function ItemBulkScreen({ params }: ScreenProps<{ groupId?: number }>) {
  const features = useFeatures();
  const units = useApiQuery('inventory.unit.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  const godowns = useApiQuery('inventory.godown.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  if (!features.inventory) {
    return (
      <Screen title="Multiple Stock Items" icon="layers">
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock items." />
      </Screen>
    );
  }
  const error = units.error ?? godowns.error;
  if (error || !units.data || !godowns.data) {
    return (
      <Screen
        title="Multiple Stock Items"
        icon="layers"
        loading={!error}
        error={error ?? undefined}
        onRetry={() => {
          void units.refetch();
          void godowns.refetch();
        }}
      />
    );
  }
  const nos = units.data.rows.find((u) => !u.isCompound && u.symbol.toLowerCase() === 'nos');
  const main = godowns.data.rows.find((g) => g.isPredefined);
  return (
    <ItemBulk
      initialGroupId={typeof params.groupId === 'number' ? params.groupId : null}
      defaultUnitId={nos?.id ?? null}
      mainGodownId={main?.id ?? null}
      unitDecimals={new Map(units.data.rows.map((u) => [u.id, u.decimalPlaces]))}
      unitSymbols={new Map(units.data.rows.map((u) => [u.id, u.symbol]))}
    />
  );
}

interface BulkProps {
  initialGroupId: number | null;
  defaultUnitId: number | null;
  mainGodownId: number | null;
  unitDecimals: ReadonlyMap<number, number>;
  unitSymbols: ReadonlyMap<number, string>;
}

function ItemBulk({ initialGroupId, defaultUnitId, mainGodownId, unitDecimals, unitSymbols }: BulkProps) {
  const nav = useNav();
  const toast = useToast();
  const company = useCompany();
  const features = useFeatures();
  const { date: workingDate } = useWorkingDate();
  const { booksFrom } = useBooks();
  const lockedUpTo = useCompanyConfig()?.lockedUpTo ?? null;
  // Opening stock is dated at the books beginning: the core refuses it once that date is locked.
  const openingLocked = lockedUpTo !== null && booksFrom <= lockedUpTo;
  const save = useApiMutation('inventory.item.bulkCreate', { invalidates: INVENTORY_INVALIDATES });
  const [groupId, setGroupId] = useState<number | null>(initialGroupId);
  const [godownId, setGodownId] = useState<number | null>(mainGodownId);
  const [rows, setRows] = useState<BulkRow[]>(() => [emptyBulkRow(defaultUnitId)]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [created, setCreated] = useState(0);
  const gst = company.gstEnabled;
  const ctx: BulkContext = useMemo(
    () => ({ gstEnabled: gst, openingGodownId: godownId, multipleGodowns: features.multipleGodowns, unitDecimals: (id) => unitDecimals.get(id) ?? 0, openingLocked }),
    [gst, godownId, features.multipleGodowns, unitDecimals, openingLocked],
  );
  const used = rows.filter((r) => !isBlankBulkRow(r));
  const dirty = used.length > 0;
  const warnings = bulkWarnings(rows, ctx, workingDate);

  const edit = (key: string, p: Partial<BulkRow>): void => {
    setRows((list) => {
      const next = list.map((r) => (r.key === key ? { ...r, ...p } : r));
      const last = next[next.length - 1];
      // Keep exactly one blank row at the end, carrying the previous row's unit.
      if (last && !isBlankBulkRow(last)) next.push(emptyBulkRow(last.unitId ?? defaultUnitId));
      return next;
    });
    const touched = Object.keys(p).map((f) => `${key}.${f}`);
    if (touched.some((k) => errors[k])) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !touched.includes(k))));
  };
  const removeRow = (key: string): void => {
    setRows((list) => {
      const next = list.filter((r) => r.key !== key);
      return next.length && isBlankBulkRow(next[next.length - 1]) ? next : [...next, emptyBulkRow(defaultUnitId)];
    });
  };

  const submit = async (): Promise<void> => {
    if (save.pending) return;
    if (!used.length) {
      setBanner('Type at least one item name.');
      focusField(cellId(rows[0].key, 'name'));
      return;
    }
    if (used.length > MAX_BULK_ROWS) {
      setBanner(`Save at most ${MAX_BULK_ROWS.toLocaleString('en-IN')} items at a time — this grid has ${used.length.toLocaleString('en-IN')}. Remove some rows and save them next.`);
      return;
    }
    const e = validateBulkRows(rows, ctx);
    setErrors(e);
    setBanner(null);
    const firstBad = rows.find((r) => Object.keys(e).some((k) => k.startsWith(`${r.key}.`)));
    if (firstBad) {
      const field = Object.keys(e).find((k) => k.startsWith(`${firstBad.key}.`))?.slice(firstBad.key.length + 1) ?? 'name';
      focusField(cellId(firstBad.key, field));
      return;
    }
    const sent = bulkInputs(rows, ctx);
    try {
      const out = await save.mutate({ groupId, rows: sent.map((s) => s.input) });
      toast.success(`${out.created.length} stock item${out.created.length === 1 ? '' : 's'} created`);
      for (const w of out.warnings) toast.warning('Please note', { message: w });
      setCreated((n) => n + out.created.length);
      const fresh = emptyBulkRow(rows[rows.length - 1]?.unitId ?? defaultUnitId);
      setRows([fresh]);
      setErrors({});
      // The rows just saved are gone: continue typing on the fresh first row.
      window.setTimeout(() => focusField(cellId(fresh.key, 'name')), 0);
    } catch (err) {
      const { fields, message } = splitApiError(err, (k) => /^rows\.\d+/.test(k));
      const mapped: Record<string, string> = {};
      for (const [path, msg] of Object.entries(fields)) {
        const t = bulkErrorTarget(path.replace(/\.(\d+)(?=\.|$)/g, '[$1]'), sent);
        if (t) mapped[`${t.key}.${t.field}`] = msg;
      }
      setErrors(mapped);
      const firstKey = Object.keys(mapped)[0];
      setBanner(message ?? (firstKey ? null : 'Not saved.'));
      if (firstKey) {
        const [k, f] = firstKey.split('.');
        focusField(cellId(k, f));
      }
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>, r: BulkRow): void => {
    // Enter on the empty last row finishes the list (Tally): save.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && r.name.trim() === '' && rows[rows.length - 1]?.key === r.key && used.length > 0) {
      e.preventDefault();
      void submit();
    }
  };
  const err = (r: BulkRow, f: keyof BulkRow): string | undefined => errors[`${r.key}.${f}`];
  const errNode = (r: BulkRow, f: keyof BulkRow) =>
    err(r, f) ? (
      <span className="bx-inv-grid__error" id={`${cellId(r.key, f)}-err`}>
        {err(r, f)}
      </span>
    ) : null;
  const desc = (r: BulkRow, f: keyof BulkRow): string | undefined => (err(r, f) ? `${cellId(r.key, f)}-err` : undefined);

  return (
    <Screen
      title="Multiple Stock Items"
      subtitle={created ? `${created} created in this session` : 'Create many items at once'}
      icon="layers"
      dirty={dirty}
      hint="Enter next cell · Enter on an empty name to finish · Ctrl+A save all · Alt+C create in a list · Esc back"
      actions={[{ key: 'Ctrl+A', label: `Save ${used.length || ''} item${used.length === 1 ? '' : 's'}`.replace('  ', ' '), icon: 'save', primary: true, onClick: () => void submit(), disabled: !used.length }]}
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()} disabled={!used.length}>
            Save {used.length || ''} item{used.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Multiple stock items">
        <Stack gap={3}>
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}
          {openingLocked && lockedUpTo ? (
            <Banner tone="info" inline title="Opening stock is locked">
              The books are locked up to {formatDate(lockedUpTo)}, which includes the opening stock date ({formatDate(booksFrom)}). Create the items here and bring
              their stock in with a Stock Journal or Physical Stock voucher dated after the lock.
            </Banner>
          ) : null}
          <FieldGroup columns={features.multipleGodowns && !openingLocked ? 2 : 1}>
            <Field label="Under (default stock group)" optional hint="Used for rows that leave 'Under' blank.">
              <StockGroupPicker value={groupId} onChange={(id) => setGroupId(id)} placeholder="Primary (no group)" />
            </Field>
            {features.multipleGodowns && !openingLocked ? (
              <Field label="Opening stock in" required hint="Godown for the opening quantities below.">
                <GodownPicker value={godownId} onChange={(id) => setGodownId(id)} />
              </Field>
            ) : null}
          </FieldGroup>
          <div className="bx-inv-grid" role="group" aria-label="Items">
            <table className="bx-inv-grid__table">
              <colgroup>
                <col style={{ width: 40 }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '9%' }} />
                {gst ? <col style={{ width: '9%' }} /> : null}
                {gst ? <col style={{ width: '7%' }} /> : null}
                <col style={{ width: '10%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: 44 }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="bx-inv-grid__th" scope="col">
                    <span className="bx-sr-only">Row</span>
                  </th>
                  <th className="bx-inv-grid__th" scope="col">
                    Name *
                  </th>
                  <th className="bx-inv-grid__th" scope="col">
                    Alias
                  </th>
                  <th className="bx-inv-grid__th" scope="col">
                    Under
                  </th>
                  <th className="bx-inv-grid__th" scope="col">
                    Unit *
                  </th>
                  {gst ? (
                    <th className="bx-inv-grid__th" scope="col">
                      HSN
                    </th>
                  ) : null}
                  {gst ? (
                    <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                      GST %
                    </th>
                  ) : null}
                  <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                    Selling price
                  </th>
                  <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                    Opening qty
                  </th>
                  <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                    Rate
                  </th>
                  <th className="bx-inv-grid__th bx-inv-grid__th--num" scope="col">
                    Value
                  </th>
                  <th className="bx-inv-grid__th" scope="col">
                    <span className="bx-sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const value = r.openingQty !== null && r.openingRate !== null ? calculatedValue(r.openingQty, r.openingRate) : null;
                  const sym = r.unitId !== null ? (unitSymbols.get(r.unitId) ?? '') : '';
                  const n = i + 1;
                  return (
                    <tr key={r.key} className="bx-inv-grid__row">
                      <td className="bx-inv-grid__td bx-inv-grid__td--index">{n}</td>
                      <td className="bx-inv-grid__td">
                        <TextInput
                          id={cellId(r.key, 'name')}
                          aria-label={`Row ${n} name`}
                          aria-describedby={desc(r, 'name')}
                          size="sm"
                          value={r.name}
                          onChange={(e) => edit(r.key, { name: e.target.value })}
                          onKeyDown={(e) => onNameKeyDown(e, r)}
                          maxLength={200}
                          autoComplete="off"
                          invalid={!!err(r, 'name')}
                          data-autofocus={i === 0 ? '' : undefined}
                        />
                        {errNode(r, 'name')}
                      </td>
                      <td className="bx-inv-grid__td">
                        <TextInput id={cellId(r.key, 'alias')} aria-label={`Row ${n} alias`} aria-describedby={desc(r, 'alias')} size="sm" value={r.alias} onChange={(e) => edit(r.key, { alias: e.target.value })} maxLength={200} autoComplete="off" invalid={!!err(r, 'alias')} />
                        {errNode(r, 'alias')}
                      </td>
                      <td className="bx-inv-grid__td">
                        <StockGroupPicker id={cellId(r.key, 'groupId')} aria-label={`Row ${n} stock group`} size="sm" value={r.groupId} onChange={(id) => edit(r.key, { groupId: id })} placeholder="Default" invalid={!!err(r, 'groupId')} />
                        {errNode(r, 'groupId')}
                      </td>
                      <td className="bx-inv-grid__td">
                        <UnitPicker id={cellId(r.key, 'unitId')} aria-label={`Row ${n} unit`} size="sm" value={r.unitId} onChange={(id) => edit(r.key, { unitId: id })} invalid={!!err(r, 'unitId')} />
                        {errNode(r, 'unitId')}
                      </td>
                      {gst ? (
                        <td className="bx-inv-grid__td">
                          <TextInput
                            id={cellId(r.key, 'hsnSac')}
                            aria-label={`Row ${n} HSN code`}
                            aria-describedby={desc(r, 'hsnSac')}
                            size="sm"
                            value={r.hsnSac}
                            onChange={(e) => edit(r.key, { hsnSac: e.target.value.replace(/[^0-9 ]/g, '') })}
                            inputMode="numeric"
                            maxLength={11}
                            mono
                            invalid={!!err(r, 'hsnSac')}
                          />
                          {errNode(r, 'hsnSac')}
                        </td>
                      ) : null}
                      {gst ? (
                        <td className="bx-inv-grid__td bx-inv-grid__td--num">
                          <PercentInput id={cellId(r.key, 'gstRate')} aria-label={`Row ${n} GST rate`} aria-describedby={desc(r, 'gstRate')} size="sm" value={r.gstRate} onChange={(v) => edit(r.key, { gstRate: v })} max={100} invalid={!!err(r, 'gstRate')} />
                          {errNode(r, 'gstRate')}
                        </td>
                      ) : null}
                      <td className="bx-inv-grid__td bx-inv-grid__td--num">
                        <AmountInput id={cellId(r.key, 'sellingPrice')} aria-label={`Row ${n} selling price`} aria-describedby={desc(r, 'sellingPrice')} size="sm" value={r.sellingPrice} onChange={(v) => edit(r.key, { sellingPrice: v })} invalid={!!err(r, 'sellingPrice')} />
                        {errNode(r, 'sellingPrice')}
                      </td>
                      <td className="bx-inv-grid__td bx-inv-grid__td--num">
                        <QuantityInput
                          id={cellId(r.key, 'openingQty')}
                          aria-label={`Row ${n} opening quantity`}
                          aria-describedby={desc(r, 'openingQty')}
                          size="sm"
                          value={r.openingQty}
                          onChange={(v) => edit(r.key, { openingQty: v })}
                          decimals={r.unitId !== null ? (unitDecimals.get(r.unitId) ?? 0) : 0}
                          unit={sym}
                          invalid={!!err(r, 'openingQty')}
                          readOnly={openingLocked}
                        />
                        {errNode(r, 'openingQty')}
                      </td>
                      <td className="bx-inv-grid__td bx-inv-grid__td--num">
                        <NumberInput id={cellId(r.key, 'openingRate')} aria-label={`Row ${n} opening rate`} aria-describedby={desc(r, 'openingRate')} size="sm" value={r.openingRate} onChange={(v) => edit(r.key, { openingRate: v })} decimals={4} min={0} invalid={!!err(r, 'openingRate')} readOnly={openingLocked} />
                        {errNode(r, 'openingRate')}
                      </td>
                      <td className="bx-inv-grid__td bx-inv-grid__td--num bx-inv-grid__td--static">{value === null ? '' : formatMoney(value)}</td>
                      <td className="bx-inv-grid__td">
                        {isBlankBulkRow(r) ? null : <IconButton icon="trash" size="sm" variant="ghost" aria-label={`Remove row ${n}`} tabIndex={-1} onClick={() => removeRow(r.key)} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {warnings.length ? (
            <Banner tone="warning" inline title="Please check">
              {warnings.join(' ')}
            </Banner>
          ) : null}
          <p className="bx-inv-note">
            Rows left blank are ignored. Rows are goods; create services, and set batches, alternate units, cess or price levels, on each item afterwards.
          </p>
        </Stack>
      </form>
    </Screen>
  );
}
