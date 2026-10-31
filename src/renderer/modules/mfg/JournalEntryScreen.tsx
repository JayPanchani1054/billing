/**
 * 'mfg.journal.entry' — Manufacturing Journal, Material Out and Material In (stock journals whose voucher
 * type has a class, Masters › Voucher Types › Use as). 'vouchers.entry' hands these types over here.
 *
 * Params: { voucherTypeId? | cls?, id? (alter), duplicateOf?, date?, jobWorkOrderId?, partyId? }
 *
 *   Manufacturing Journal  finished item + BOM + quantity → components (scaled), by-products / scrap
 *                          and additional costs; the cost of the finished goods is worked out by the
 *                          core's costing rule (consumption at the stock valuation method as of the
 *                          voucher date + additional − by-products) and shown live from vouchers.preview.
 *   Material Out / In      job worker (party) + job work godown (its kind decides the lines: transfers of
 *                          our goods, or a principal's goods received / returned), the order, the process,
 *                          goods type for s.143, challan rate and any extension of the return date.
 *
 * Keyboard: Enter / Shift+Enter next / previous field · Ctrl+A accept · Alt+B fill from the BOM ·
 * Ctrl+D remove line · Alt+N (Ctrl+N) insert line · Ctrl+E line description · Alt+P print (the journal altered
 * or just saved) · alteration: Alt+D delete, Alt+X cancel, Alt+2 duplicate, Alt+H edit history, Alt+Enter view ·
 * Esc back.
 *
 * 2.2 line descriptions (lib/journalDescription.ts; the rule and the field are voucher entry's): every item line —
 * the finished goods, a component, a by-product / scrap, a material line — may carry a description of its own,
 * saved with this voucher only, in a quiet one-line field under its item. It shows when the line has text or the
 * user opens it: Ctrl+E on the line (from More ▾ or the shortcut bar: the line the cursor was last on), its
 * "Description" row tool, or the finished goods' "Description" beside "Item". In the Enter chain it follows the
 * item; Enter / Shift+Enter move on from it as from any field; left empty it closes again. Which lines are opened
 * is this screen's state (`descOpen` + a ref), never the form's; the next voucher starts with none.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, ReactNode } from 'react';
import { formatMoney } from '../../../shared/format.ts';
import { JOB_WORK_GOODS_LABELS, JOB_WORK_GOODS_TYPES, type JobWorkGoodsType } from '../../../shared/mfg/jobwork.ts';
import type { Paise } from '../../../shared/money.ts';
import { BOM_VALUE_BASES, STOCK_JOURNAL_CLASS_LABELS, THIRD_PARTY_KIND_LABELS } from '../../../shared/types/mfg.ts';
import type { BomValueBasis, MfgJournalContext, MfgJournalDetail, StockJournalCostPreview, StockJournalRole, StockJournalTypeRow } from '../../../shared/types/mfg.ts';
import type { VoucherSaveResult, VoucherWarning } from '../../../shared/types/vouchers.ts';
import {
  api,
  fieldErrorsOf,
  Screen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useFeatures,
  useNav,
  userMessage,
  useWorkingDate,
  withConfirmation,
} from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import {
  AmountInput,
  Banner,
  Button,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  focusElement,
  getEnterTargets,
  IconButton,
  Modal,
  PercentInput,
  QuantityInput,
  NumberInput,
  Select,
  Stack,
  StatLine,
  TextArea,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import { LedgerPicker } from '../accounts/pickers.tsx';
import { GodownPicker, ItemPicker } from '../inventory/pickers.tsx';
import { afterPointerRelease, DESC_MAX_LENGTH, NO_OPENED, openedAfterLeaving, openedWith } from '../vouchers/lib/lineDescription.ts';
import type { ItemPickerRow } from '../../../shared/types/inventory.ts';
import { focusedRowKey, focusLater, focusRow, LinesTable, MFG_INVALIDATES, rowKeyOf } from './components.tsx';
import type { LineColumn, LineRow } from './components.tsx';
import { describeAction, descriptionId, enterNeighbour, lineDescriptionShown } from './lib/journalDescription.ts';
import {
  applyBom,
  blankCost,
  blankRow,
  CLASS_TITLES,
  emptyForm,
  fromDetail,
  isFilled,
  lineValuesByKey,
  mapErrors,
  pickType,
  rowsOf,
  sectionsFor,
  toVoucherInput,
  withTrailingBlanks,
} from './lib/journalForm.ts';
import type { CostRow, JournalForm, JournalRow } from './lib/journalForm.ts';
import { godownForParty } from './lib/orderForm.ts';

export interface MfgJournalParams {
  voucherTypeId?: number;
  cls?: 'manufacturing' | 'material_out' | 'material_in';
  id?: number;
  duplicateOf?: number;
  date?: string;
  jobWorkOrderId?: number;
  partyId?: number;
}

const ENTRY_INVALIDATES = [...MFG_INVALIDATES, 'print', 'outstanding', 'accounts'];

// ───────────────────────────── Outer: resolve the type / voucher ─────────────────────────────

export function JournalEntryScreen({ params }: ScreenProps<MfgJournalParams>) {
  const nav = useNav();
  const { date: workingDate } = useWorkingDate();
  const typesQ = useApiQuery('mfg.journal.types', { includeInactive: true }, { staleTime: 30_000 });
  const detailQ = useApiQuery('mfg.journal.get', { id: params.id ?? 0 }, { enabled: params.id !== undefined, staleTime: 0 });
  const dupQ = useApiQuery('mfg.journal.duplicate', { id: params.duplicateOf ?? 0 }, { enabled: params.duplicateOf !== undefined && params.id === undefined, staleTime: 0 });
  const detail = params.id !== undefined ? detailQ.data : undefined;
  const dup = params.duplicateOf !== undefined && params.id === undefined ? dupQ.data : undefined;
  const waiting = (params.id !== undefined && !detail) || (params.duplicateOf !== undefined && params.id === undefined && !dup);
  const types = typesQ.data;
  const type: StockJournalTypeRow | null = useMemo(() => {
    if (!types || waiting) return null;
    const src = detail ?? dup;
    if (src) return types.find((t) => t.id === src.voucherTypeId) ?? null;
    return pickType(types, { voucherTypeId: params.voucherTypeId, cls: params.cls });
  }, [types, waiting, detail, dup, params.voucherTypeId, params.cls]);
  const date = detail ? detail.date : (params.date ?? workingDate);
  const ctxQ = useApiQuery('mfg.journal.context', { voucherTypeId: type?.id ?? 0, date }, { enabled: type !== null });
  const ctx = ctxQ.data && type && ctxQ.data.voucherType.id === type.id ? ctxQ.data : undefined;
  // A challan against a job work order (Alt+O / Alt+I on the order): start with its party and godown.
  const wantsOrder = params.jobWorkOrderId !== undefined && params.id === undefined && params.duplicateOf === undefined;
  const orderQ = useApiQuery('mfg.jobWorkOrder.get', { id: params.jobWorkOrderId ?? 0 }, { enabled: wantsOrder });

  const label = CLASS_TITLES[type?.class ?? params.cls ?? 'manufacturing'];
  const title = params.id !== undefined ? `${type?.name ?? label} Alteration` : `${type?.name ?? label}`;
  const error = typesQ.error ?? (params.id !== undefined ? detailQ.error : null) ?? (params.duplicateOf !== undefined ? dupQ.error : null) ?? ctxQ.error ?? (wantsOrder ? orderQ.error : null);
  if (error || typesQ.loading || waiting || (wantsOrder && !orderQ.data)) {
    return <Screen title={title} loading={!error} error={error} onRetry={() => void (typesQ.refetch(), detailQ.refetch(), dupQ.refetch(), ctxQ.refetch())} />;
  }
  if (!type) {
    return (
      <Screen title={title}>
        <EmptyState
          icon="layers"
          title={`No ${label} voucher type`}
          body="Turn on Bill of materials and manufacturing (or Job work) in Features (F11) — the Manufacturing Journal and Material In / Out types are created then — or set “Use as” on a Stock Journal type under Masters › Voucher Types."
          action={
            <Button variant="primary" onClick={() => nav.push('company.features')}>
              Open features
            </Button>
          }
        />
      </Screen>
    );
  }
  if (!ctx) return <Screen title={title} loading />;
  const seed = wantsOrder && orderQ.data ? { partyLedgerId: orderQ.data.partyLedgerId, godownId: orderQ.data.godownId } : null;
  return <JournalEntry key={`${type.id}:${params.id ?? ''}:${params.duplicateOf ?? ''}`} ctx={ctx} detail={detail} dup={dup} params={params} title={title} seed={seed} />;
}

// ───────────────────────────── Inner: the form ─────────────────────────────

interface PreviewState {
  estimate: StockJournalCostPreview | null;
  values: Map<string, Paise>;
  costValues: Map<string, Paise>;
  warnings: VoucherWarning[];
  number: string | null;
}

interface Errors {
  rows: Map<string, string>;
  costs: Map<string, string>;
  fields: Record<string, string>;
  general: string[];
}

const NO_ERRORS: Errors = { rows: new Map(), costs: new Map(), fields: {}, general: [] };

const VALUE_BASIS_OPTIONS: ReadonlyArray<{ value: BomValueBasis; label: string }> = BOM_VALUE_BASES.map((b) => ({ value: b, label: b === 'nil' ? 'No value' : b === 'rate' ? 'Rate per unit' : '% of cost' }));
const GOODS_OPTIONS: ReadonlyArray<{ value: JobWorkGoodsType; label: string }> = JOB_WORK_GOODS_TYPES.map((g) => ({ value: g, label: JOB_WORK_GOODS_LABELS[g] }));

function JournalEntry({
  ctx,
  detail,
  dup,
  params,
  title,
  seed,
}: {
  ctx: MfgJournalContext;
  detail: MfgJournalDetail | undefined;
  dup: MfgJournalDetail | undefined;
  params: MfgJournalParams;
  title: string;
  seed: { partyLedgerId: number; godownId: number | null } | null;
}) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const features = useFeatures();
  const working = useWorkingDate();
  const canCreate = useCan('vouchers.create');
  const canAlter = useCan('vouchers.alter');
  const canDelete = useCan('vouchers.delete');
  const canAudit = useCan('audit.view');
  const isAlter = detail !== undefined;
  const cls = ctx.voucherType.class;

  const initial = useMemo<JournalForm>(() => {
    if (detail) return fromDetail(detail);
    if (dup) return { ...fromDetail(dup), date: params.date ?? working.date, number: '' };
    const f = emptyForm(cls, ctx.voucherType.id, params.date ?? working.date);
    if (seed) {
      f.partyLedgerId = seed.partyLedgerId;
      f.thirdPartyGodownId = seed.godownId ?? godownForParty(ctx.godowns, seed.partyLedgerId, null)?.id ?? null;
    }
    if (params.partyId !== undefined) {
      f.partyLedgerId = params.partyId;
      f.thirdPartyGodownId = f.thirdPartyGodownId ?? godownForParty(ctx.godowns, params.partyId, null)?.id ?? null;
    }
    if (params.jobWorkOrderId !== undefined && f.cls !== 'manufacturing') f.jobWorkOrderId = params.jobWorkOrderId;
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const godownKind = (id: number | null) => (id === null ? null : (ctx.godowns.find((g) => g.id === id)?.kind ?? null));
  const [form, setFormRaw] = useState<JournalForm>(() => withTrailingBlanks(initial, sectionsFor(cls, godownKind(initial.thirdPartyGodownId))));
  const baseline = useRef(JSON.stringify(form));
  const kind = godownKind(form.thirdPartyGodownId);
  const sections = sectionsFor(form.cls, kind);
  const setForm = useCallback(
    (fn: (f: JournalForm) => JournalForm) => setFormRaw((f) => {
      const next = fn(f);
      const k = next.thirdPartyGodownId === null ? null : (ctx.godowns.find((g) => g.id === next.thirdPartyGodownId)?.kind ?? null);
      return withTrailingBlanks(next, sectionsFor(next.cls, k));
    }),
    [ctx.godowns],
  );
  const dirty = JSON.stringify(form) !== baseline.current;
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [lastSaved, setLastSaved] = useState<{ id: number; number: string | null } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  // BOM explosion: automatic until the user edits the components / by-products by hand.
  const [autoFill, setAutoFill] = useState(!isAlter && !dup);
  const applied = useRef<string>(form.bomId !== null ? `${form.bomId}:${rowsOf(form, ['product'])[0]?.qty ?? ''}` : '');

  const product = form.rows.find((r) => r.role === 'product') ?? null;
  const jobWork = form.cls !== 'manufacturing';
  const direction = kind === 'ours_with_party' ? 'out' : kind === 'party_with_us' ? 'in' : null;
  const readOnly = isAlter ? !canAlter : !canCreate;

  // ── BOMs of the finished item, and the chosen one ──
  const bomsQ = useApiQuery('mfg.bom.list', { itemId: product?.itemId ?? 0 }, { enabled: sections.products && product?.itemId != null && features.manufacturing });
  const bomQ = useApiQuery('mfg.bom.get', { id: form.bomId ?? 0 }, { enabled: form.bomId !== null });
  const boms = bomsQ.data?.rows ?? [];
  useEffect(() => {
    // A new finished item: pick its default BOM.
    if (!autoFill || !product?.itemId || form.bomId !== null || boms.length === 0 || boms[0].itemId !== product.itemId) return;
    const def = boms.find((b) => b.isDefault && b.isActive) ?? boms.find((b) => b.isActive);
    if (def) setForm((f) => ({ ...f, bomId: def.id }));
  }, [autoFill, product?.itemId, form.bomId, boms, setForm]);
  useEffect(() => {
    const bom = bomQ.data;
    const qty = product?.qty ?? null;
    if (!autoFill || !bom || bom.id !== form.bomId || qty === null || qty <= 0) return;
    const key = `${bom.id}:${qty}`;
    if (applied.current === key) return;
    applied.current = key;
    setForm((f) => applyBom(f, bom, qty, null));
  }, [autoFill, bomQ.data, form.bomId, product?.qty, setForm]);
  const fillFromBom = () => {
    const bom = bomQ.data;
    const qty = product?.qty ?? null;
    if (!bom || qty === null || qty <= 0) {
      toast.info(form.bomId === null ? 'Choose a bill of materials first.' : 'Enter the quantity of the finished goods first.');
      return;
    }
    applied.current = `${bom.id}:${qty}`;
    setAutoFill(true);
    setForm((f) => applyBom(f, bom, qty, null));
  };

  // ── Job work: party → its godown, open orders ──
  const thirdPartyGodowns = useMemo(() => ctx.godowns.filter((g) => g.kind !== 'none'), [ctx.godowns]);
  const ordersQ = useApiQuery(
    'mfg.jobWorkOrder.list',
    { partyLedgerId: form.partyLedgerId ?? 0, status: 'open', ...(direction ? { direction } : {}), limit: 200 },
    { enabled: jobWork && form.partyLedgerId !== null && features.jobWork },
  );
  const orderOptions = useMemo(() => {
    const rows = ordersQ.data?.rows ?? [];
    const opts = rows.map((o) => ({ value: String(o.id), label: `${o.number} · ${o.itemName ?? 'material'}${o.pendingQty !== null ? ` · pending ${o.pendingQty} ${o.unit ?? ''}` : ''}` }));
    if (form.jobWorkOrderId !== null && !rows.some((o) => o.id === form.jobWorkOrderId)) opts.unshift({ value: String(form.jobWorkOrderId), label: detail?.orderNumber ?? `Order ${form.jobWorkOrderId}` });
    return [{ value: '', label: 'None' }, ...opts];
  }, [ordersQ.data, form.jobWorkOrderId, detail?.orderNumber]);
  const setParty = (id: number | null) => {
    setForm((f) => {
      const next = { ...f, partyLedgerId: id };
      const own = godownForParty(ctx.godowns, id, null);
      if (own && (f.thirdPartyGodownId === null || godownForParty(ctx.godowns, f.partyLedgerId, null)?.id === f.thirdPartyGodownId)) next.thirdPartyGodownId = own.id;
      if (id !== f.partyLedgerId) next.jobWorkOrderId = null;
      return next;
    });
  };

  // ── Live costing (vouchers.preview, debounced) ──
  const [preview, setPreview] = useState<PreviewState | null>(null);
  useEffect(() => {
    if (!form.rows.some(isFilled)) {
      setPreview(null);
      return;
    }
    const built = toVoucherInput(form, detail ? { id: detail.id as number, updatedAt: detail.updatedAt, number: detail.number } : undefined);
    let live = true;
    const t = window.setTimeout(() => {
      api('vouchers.preview', built.input).then(
        (pv) => {
          if (!live) return;
          setPreview({
            estimate: pv.stockJournal ?? null,
            values: lineValuesByKey(pv.stockJournal?.lineValues, built.lineKeys),
            costValues: lineValuesByKey(pv.stockJournal?.additionalValues, built.costKeys),
            warnings: pv.warnings,
            number: pv.number,
          });
        },
        () => {
          // Incomplete entries fail validation while typing; the save shows the messages.
          if (live) setPreview((p) => (p ? { ...p, warnings: [] } : p));
        },
      );
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [form, detail]);

  // ── Row editing ──
  const patchRow = (key: string, patch: Partial<JournalRow>, manual = true) => {
    if (manual && autoFill) {
      const row = form.rows.find((r) => r.key === key);
      if (row && row.role !== 'product') setAutoFill(false);
    }
    setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
    setErrors((e) => (e.rows.has(key) ? { ...e, rows: new Map([...e.rows].filter(([k]) => k !== key)) } : e));
  };
  const setItem = (key: string, item: ItemPickerRow | null) =>
    patchRow(key, item ? { itemId: item.id, itemName: item.name, unit: item.unitSymbol, decimals: item.unitDecimals } : { itemId: null, itemName: '', unit: '', decimals: 0 });
  const setProductItem = (item: ItemPickerRow | null) => {
    if (!product) return;
    applied.current = '';
    setForm((f) => ({
      ...f,
      bomId: item && item.id === product.itemId ? f.bomId : null,
      rows: f.rows.map((r) => (r.key === product.key ? { ...r, ...(item ? { itemId: item.id, itemName: item.name, unit: item.unitSymbol, decimals: item.unitDecimals } : { itemId: null, itemName: '', unit: '', decimals: 0 }) } : r)),
    }));
  };
  const patchCost = (key: string, patch: Partial<CostRow>) => setForm((f) => ({ ...f, costs: f.costs.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const costs = form.costs;

  const removeLine = () => {
    const key = focusedRowKey();
    if (!key) return;
    const row = form.rows.find((r) => r.key === key);
    if (row && row.role !== 'product') {
      if (autoFill) setAutoFill(false);
      const idx = form.rows.indexOf(row);
      setForm((f) => ({ ...f, rows: f.rows.filter((r) => r.key !== key) }));
      const next = form.rows.slice(idx + 1).find((r) => r.role === row.role) ?? form.rows.slice(0, idx).reverse().find((r) => r.role === row.role);
      if (next) focusRow(next.key);
      return;
    }
    if (form.costs.some((c) => c.key === key)) setForm((f) => ({ ...f, costs: f.costs.filter((c) => c.key !== key) }));
  };
  const insertLine = () => {
    const key = focusedRowKey();
    const row = key ? form.rows.find((r) => r.key === key) : undefined;
    if (row && row.role !== 'product') {
      const fresh = blankRow(row.role === 'by_product' ? 'by_product' : row.role);
      setForm((f) => {
        const i = f.rows.findIndex((r) => r.key === row.key);
        return { ...f, rows: [...f.rows.slice(0, i), fresh, ...f.rows.slice(i)] };
      });
      focusRow(fresh.key);
      return;
    }
    const cost = key ? form.costs.find((c) => c.key === key) : undefined;
    if (cost) {
      const fresh = blankCost();
      setForm((f) => {
        const i = f.costs.findIndex((c) => c.key === cost.key);
        return { ...f, costs: [...f.costs.slice(0, i), fresh, ...f.costs.slice(i)] };
      });
      focusRow(fresh.key);
    }
  };

  // ── 2.2: line descriptions (lib/journalDescription.ts) — opened per row key; the field appears in the next render ──
  /** Lines whose description the user opened on this voucher (row keys) — screen state, never part of the form. */
  const [descOpen, setDescOpenState] = useState<ReadonlySet<string>>(NO_OPENED);
  /** The same set for handlers that run before the next render (a close after a press, Ctrl+E). */
  const descOpenRef = useRef(descOpen);
  const setDescOpen = useCallback((next: ReadonlySet<string>) => {
    if (next === descOpenRef.current) return;
    descOpenRef.current = next;
    setDescOpenState(next);
  }, []);
  /**
   * The line the cursor was last on (a table line or the finished goods) — Ctrl+E chosen in More ▾ or on the
   * shortcut bar describes it (the menu or the button has the focus then). Set by the form's focus events, cleared
   * in the header, the job work fields and the narration, and when the next voucher starts.
   */
  const lastLineRef = useRef<string | null>(null);
  const openDescription = useCallback(
    (rowKey: string) => {
      setDescOpen(openedWith(descOpenRef.current, rowKey));
      focusLater(descriptionId(rowKey));
    },
    [setDescOpen],
  );
  // Moving into a description keeps it open while it is edited (emptying it must not take it away under the
  // cursor); leaving it empty closes it again.
  const onDescriptionFocus = useCallback((rowKey: string) => setDescOpen(openedWith(descOpenRef.current, rowKey)), [setDescOpen]);
  const onDescriptionLeave = useCallback((rowKey: string, text: string) => setDescOpen(openedAfterLeaving(descOpenRef.current, rowKey, text)), [setDescOpen]);
  /** The cursor moved inside the form (focus events bubble): remember its line for Ctrl+E (lastLineRef). */
  const onFormFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const t = e.target;
    // A picker's list sits in a portal outside the form: the line of its field stays the last line.
    if (!(t instanceof Element) || !e.currentTarget.contains(t)) return;
    lastLineRef.current = rowKeyOf(t);
  };
  /**
   * Ctrl+E: the description of the line the cursor is on — opened and the cursor put in it, or only the cursor
   * when it already shows. From More ▾ or the shortcut bar it is the line the cursor was last on. Elsewhere (the
   * header, the narration, an additional cost, an empty line) a note says where to go.
   */
  const describeLine = () => {
    const key = focusedRowKey() ?? lastLineRef.current;
    const act = describeAction(form, descOpenRef.current, key);
    if (key !== null && act === 'focus') {
      // On screen: the cursor goes in now — an empty one just left for the shortcut bar closes when the press is
      // over unless the cursor is back (LineDescriptionField) — and again next frame, after More ▾ gave the focus
      // back to its button.
      document.getElementById(descriptionId(key))?.focus();
      focusLater(descriptionId(key));
      return;
    }
    if (key !== null && act === 'open') {
      openDescription(key);
      return;
    }
    toast.info('Move to an item line first', { message: 'Ctrl+E adds a description under the item the cursor is on.' });
  };
  /** A description typed under a line: not a change of the BOM's lines, so the automatic BOM refill goes on (it keeps the text). */
  const setDescription = (key: string, text: string) => patchRow(key, { description: text }, false);

  // ── Save / delete / cancel ──
  const save = useApiMutation('vouchers.save', { invalidates: ENTRY_INVALIDATES });
  const del = useApiMutation('vouchers.delete', { invalidates: ENTRY_INVALIDATES });
  const cancelM = useApiMutation('vouchers.cancel', { invalidates: ENTRY_INVALIDATES });
  const submit = async () => {
    if (save.pending || readOnly) return;
    const built = toVoucherInput(form, detail ? { id: detail.id as number, updatedAt: detail.updatedAt, number: detail.number } : undefined);
    if (built.lineKeys.length === 0) {
      setErrors({ ...NO_ERRORS, general: ['Enter at least one item line (item and quantity).'] });
      return;
    }
    setErrors(NO_ERRORS);
    let out: VoucherSaveResult | undefined;
    try {
      out = await withConfirmation((ack) => save.mutate({ ...built.input, acknowledgeWarnings: ack || undefined }), { confirmLabel: 'Save anyway' });
    } catch (err) {
      const mapped = mapErrors(fieldErrorsOf(err), built);
      if (mapped.rows.size === 0 && mapped.costs.size === 0 && Object.keys(mapped.fields).length === 0 && mapped.general.length === 0) mapped.general.push(userMessage(err));
      setErrors(mapped);
      const first = mapped.rows.keys().next();
      if (!first.done) focusRow(first.value);
      return;
    }
    if (!out) return;
    const name = ctx.voucherType.name;
    toast.success(`${name} ${out.number ?? ''} ${isAlter ? 'saved' : 'created'}`.replace(/\s+/g, ' '), { message: 'Alt+P prints it.' });
    if (isAlter) {
      nav.pop();
      return;
    }
    setLastSaved({ id: out.id, number: out.number });
    // A fresh voucher of the same type and date: no line opened (2.2), no last line.
    const fresh = withTrailingBlanks(emptyForm(form.cls, form.voucherTypeId, form.date), sectionsFor(form.cls, null));
    setDescOpen(NO_OPENED);
    lastLineRef.current = null;
    applied.current = '';
    setAutoFill(true);
    baseline.current = JSON.stringify(fresh);
    setFormRaw(fresh);
    setPreview(null);
  };
  const remove = async () => {
    if (!detail || detail.id === null) return;
    if (!(await confirm({ title: `Delete ${ctx.voucherType.name} ${detail.number ?? ''}?`.replace(/\s+/g, ' '), message: 'The stock moves of this voucher are removed and every stock report is recomputed. This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: detail.id, ...(detail.updatedAt ? { expectedUpdatedAt: detail.updatedAt } : {}) });
      toast.success('Voucher deleted');
      nav.pop();
    } catch (err) {
      setErrors({ ...NO_ERRORS, general: [userMessage(err)] });
    }
  };
  const print = () => {
    const id = detail?.id ?? lastSaved?.id ?? null;
    if (id === null) toast.info('Save the voucher first; Alt+P then prints it.');
    else nav.push('print.voucher', { id });
  };

  // Enter on the last field asks "Accept?" as voucher entry does (D19); Ctrl+A saves at once.
  const askAccept = async () => {
    if (save.pending || readOnly) return;
    const value = preview?.estimate?.productValue ?? 0;
    const ok = await confirm({
      title: isAlter ? 'Save this voucher?' : 'Accept this voucher?',
      message: `${ctx.voucherType.name}${value > 0 ? ` — cost of finished goods ₹ ${formatMoney(value)}` : ''}.`,
      confirmLabel: isAlter ? 'Save' : 'Accept',
      cancelLabel: 'Go back',
    });
    if (ok) await submit();
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void askAccept() });
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+A', label: isAlter ? 'Save' : 'Accept', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || save.pending, hint: readOnly ? `Needs the “${isAlter ? 'Alter' : 'Create'} vouchers” permission` : undefined },
    { key: 'Alt+B', label: 'Fill from BOM', icon: 'layers', onClick: fillFromBom, hidden: !sections.products || !features.manufacturing, group: 'lines' },
    { key: 'Ctrl+D', label: 'Remove line', icon: 'minus', onClick: removeLine, hidden: readOnly, group: 'lines' },
    { key: 'Alt+N, Ctrl+N', label: 'Insert line', icon: 'plus', onClick: insertLine, hidden: readOnly, group: 'lines' },
    // 2.2: a description under the line the cursor is on (the row tool "Description" does the same); More ▾ lists it.
    { key: 'Ctrl+E', label: 'Line description', icon: 'text', onClick: describeLine, hidden: readOnly, group: 'details' },
    { key: 'Alt+P', label: 'Print', icon: 'print', onClick: print, disabled: !detail && !lastSaved, group: 'voucher' },
    // As in the main voucher entry: optional (memo, no stock) and post-dated vouchers.
    { key: 'Ctrl+L', label: form.isOptional ? 'Make regular' : 'Make optional', icon: 'eye-off', onClick: () => setForm((f) => ({ ...f, isOptional: !f.isOptional })), hidden: readOnly, group: 'status' },
    { key: 'Ctrl+T', label: form.isPostDated ? 'Not post-dated' : 'Post-dated', icon: 'clock', onClick: () => setForm((f) => ({ ...f, isPostDated: !f.isPostDated })), hidden: readOnly, group: 'status' },
    { key: 'Alt+2', label: 'Duplicate', icon: 'copy', onClick: () => detail?.id && nav.replace('mfg.journal.entry', { duplicateOf: detail.id }), hidden: !isAlter || !canCreate, group: 'voucher' },
    { key: 'Alt+Enter', label: 'View voucher', icon: 'eye', onClick: () => detail?.id && nav.push('vouchers.view', { id: detail.id }), hidden: !isAlter, group: 'voucher' },
    { key: 'Alt+H', label: 'Edit history', icon: 'clock', onClick: () => detail?.id && nav.push('security.audit', { entityType: 'voucher', entityId: detail.id }), hidden: !isAlter || !canAudit, group: 'voucher' },
    { key: 'Alt+X', label: 'Cancel voucher', icon: 'x-circle', onClick: () => setCancelOpen(true), hidden: !isAlter || !canAlter, group: 'danger' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !isAlter || !canDelete, group: 'danger' },
  ];

  // ── Rendering helpers ──
  const est = preview?.estimate ?? null;
  const valueCell = (key: string): ReactNode => {
    const v = preview?.values.get(key);
    return <span className="bx-mfg-lines__value">{typeof v === 'number' ? formatMoney(v) : ''}</span>;
  };
  const godownCell = (r: JournalRow, placeholder: string): ReactNode =>
    features.multipleGodowns ? (
      <GodownPicker size="sm" aria-label={`Godown of ${r.itemName || 'the line'}`} value={r.godownId} onChange={(id) => patchRow(r.key, { godownId: id })} placeholder={placeholder} readOnly={readOnly} allowCreate={false} />
    ) : null;
  /** 2.2: a line's item with the line's description under it, while it shows (lib/journalDescription.ts). */
  const named = (r: JournalRow, item: ReactNode): ReactNode => (
    <div className="bx-mfg-name">
      {item}
      {lineDescriptionShown(descOpen, r) ? (
        <LineDescriptionField
          rowKey={r.key}
          label={`Description of ${r.itemName || 'the line'}`}
          value={r.description}
          readOnly={readOnly}
          onChange={(s) => setDescription(r.key, s)}
          onFocusLine={onDescriptionFocus}
          onLeave={onDescriptionLeave}
        />
      ) : null}
    </div>
  );
  /** 2.2: the row tool that opens a hidden description, on a line with an item (Ctrl+E does the same for the line the cursor is on). */
  const descriptionTool = (r: JournalRow): ReactNode =>
    readOnly || r.itemId === null || lineDescriptionShown(descOpen, r) ? null : (
      <IconButton icon="text" size="sm" variant="ghost" tabIndex={-1} aria-label={`Description of ${r.itemName}`} tooltip="Description (Ctrl+E)" onClick={() => openDescription(r.key)} />
    );
  const itemCell = (r: JournalRow, label: string): ReactNode =>
    named(
      r,
      <ItemPicker
        size="sm"
        aria-label={label}
        goodsOnly
        asOf={form.date}
        value={r.itemId !== null ? { id: r.itemId, name: r.itemName } : null}
        onChange={(it) => setItem(r.key, it)}
        readOnly={readOnly}
        invalid={errors.rows.has(r.key)}
      />,
    );
  const qtyCell = (r: JournalRow): ReactNode => (
    <QuantityInput size="sm" aria-label={`Quantity of ${r.itemName || 'the line'}`} value={r.qty} onChange={(q) => patchRow(r.key, { qty: q })} unit={r.unit} decimals={r.decimals} readOnly={readOnly} />
  );
  const batchCell = (r: JournalRow): ReactNode =>
    features.batches ? <TextInput size="sm" aria-label="Batch" value={r.batchName} onChange={(e) => patchRow(r.key, { batchName: e.target.value })} maxLength={100} readOnly={readOnly} /> : null;

  const outputs = rowsOf(form, ['by_product', 'scrap']);
  const components = rowsOf(form, ['component']);
  const material = sections.material ? rowsOf(form, [sections.material]) : [];
  const ownPlaceholder = 'Main Location';
  const thirdName = form.thirdPartyGodownId !== null ? (ctx.godowns.find((g) => g.id === form.thirdPartyGodownId)?.name ?? '') : '';

  const outputCols: LineColumn[] = [
    { key: 'kind', header: 'Kind', width: 120 },
    { key: 'item', header: 'Item' },
    ...(features.multipleGodowns ? [{ key: 'godown', header: 'Godown', width: 170 }] : []),
    { key: 'qty', header: 'Quantity', width: 130, num: true },
    { key: 'basis', header: 'Valued at', width: 140 },
    { key: 'rate', header: 'Rate / %', width: 110, num: true },
    { key: 'value', header: 'Value', width: 120, num: true },
  ];
  const outputRows: LineRow[] = outputs.map((r) => ({
    key: r.key,
    error: errors.rows.get(r.key),
    tool: descriptionTool(r),
    cells: {
      kind: (
        <Select<'by_product' | 'scrap'> size="sm" aria-label="Kind" value={r.role === 'by_product' ? 'by_product' : 'scrap'} onChange={(v) => patchRow(r.key, { role: v })} disabled={readOnly} options={[{ value: 'by_product', label: 'By-product' }, { value: 'scrap', label: 'Scrap' }]} />
      ),
      item: itemCell(r, 'By-product or scrap item'),
      godown: godownCell(r, ownPlaceholder),
      qty: qtyCell(r),
      basis: <Select<BomValueBasis> size="sm" aria-label="Valued at" value={r.valueBasis} onChange={(v) => patchRow(r.key, { valueBasis: v })} disabled={readOnly} options={VALUE_BASIS_OPTIONS} />,
      rate:
        r.valueBasis === 'rate' ? (
          <NumberInput size="sm" aria-label="Rate per unit" value={r.valueRate} onChange={(v) => patchRow(r.key, { valueRate: v })} decimals={2} min={0} readOnly={readOnly} />
        ) : r.valueBasis === 'percent' ? (
          <PercentInput size="sm" aria-label="Share of cost" value={r.valuePct} onChange={(v) => patchRow(r.key, { valuePct: v })} max={100} readOnly={readOnly} />
        ) : null,
      value: valueCell(r.key),
    },
  }));

  const componentCols: LineColumn[] = [
    { key: 'item', header: 'Item' },
    ...(features.multipleGodowns && form.cls === 'manufacturing' ? [{ key: 'godown', header: 'Godown', width: 170 }] : []),
    ...(features.batches ? [{ key: 'batch', header: 'Batch', width: 120 }] : []),
    { key: 'qty', header: 'Quantity', width: 130, num: true },
    { key: 'value', header: 'Value', width: 120, num: true },
  ];
  const componentRows: LineRow[] = components.map((r) => ({
    key: r.key,
    error: errors.rows.get(r.key),
    tool: descriptionTool(r),
    cells: { item: itemCell(r, 'Component'), godown: godownCell(r, ownPlaceholder), batch: batchCell(r), qty: qtyCell(r), value: valueCell(r.key) },
  }));

  // Challan details: our challan to a job worker, or the principal's challan for goods received.
  const challan = (form.cls === 'material_out' && sections.material === 'transfer') || sections.material === 'receipt';
  const materialCols: LineColumn[] = [
    { key: 'item', header: 'Item' },
    ...(features.multipleGodowns && sections.material === 'transfer' ? [{ key: 'godown', header: form.cls === 'material_out' ? 'From godown' : 'Into godown', width: 170 }] : []),
    ...(features.batches ? [{ key: 'batch', header: 'Batch', width: 110 }] : []),
    { key: 'qty', header: 'Quantity', width: 130, num: true },
    ...(challan
      ? [
          { key: 'goods', header: 'Goods (s.143)', width: 150 },
          { key: 'rate', header: 'Challan rate', width: 110, num: true },
          { key: 'ext', header: 'Return extended to', width: 150 },
        ]
      : []),
    { key: 'value', header: 'Value', width: 120, num: true },
  ];
  const materialRows: LineRow[] = material.map((r) => ({
    key: r.key,
    error: errors.rows.get(r.key),
    tool: descriptionTool(r),
    cells: {
      item: itemCell(r, 'Material'),
      godown: godownCell(r, ownPlaceholder),
      batch: batchCell(r),
      qty: qtyCell(r),
      goods: <Select<JobWorkGoodsType> size="sm" aria-label="Goods type" value={r.goodsType} onChange={(v) => patchRow(r.key, { goodsType: v })} disabled={readOnly} options={GOODS_OPTIONS} />,
      rate: <NumberInput size="sm" aria-label="Challan rate" value={r.rate} onChange={(v) => patchRow(r.key, { rate: v })} decimals={2} min={0} blankZero placeholder="Cost" readOnly={readOnly} />,
      ext: <DateInput size="sm" aria-label="Return date extended to" value={r.extendedTo} onChange={(d) => patchRow(r.key, { extendedTo: d })} referenceDate={form.date} showWeekday={false} calendarButton={false} readOnly={readOnly} />,
      value: valueCell(r.key),
    },
  }));

  const costCols: LineColumn[] = [
    { key: 'ledger', header: 'Expense ledger' },
    { key: 'label', header: 'Description', width: 200 },
    { key: 'basis', header: 'Basis', width: 150 },
    { key: 'value', header: 'Amount / %', width: 140, num: true },
    { key: 'calc', header: 'Value', width: 120, num: true },
  ];
  const costRows: LineRow[] = costs.map((c) => ({
    key: c.key,
    error: errors.costs.get(c.key),
    cells: {
      ledger: <LedgerPicker size="sm" aria-label="Expense ledger" classes={['expense']} value={c.ledgerId} onChange={(id) => patchCost(c.key, { ledgerId: id })} showBalance={false} readOnly={readOnly} />,
      label: <TextInput size="sm" aria-label="Description" value={c.label} onChange={(e) => patchCost(c.key, { label: e.target.value })} maxLength={100} placeholder="e.g. Labour, power" readOnly={readOnly} />,
      basis: (
        <Select<'amount' | 'percent'> size="sm" aria-label="Basis" value={c.basis} onChange={(v) => patchCost(c.key, { basis: v })} disabled={readOnly} options={[{ value: 'amount', label: 'Amount' }, { value: 'percent', label: '% of consumption' }]} />
      ),
      value:
        c.basis === 'amount' ? (
          <AmountInput size="sm" aria-label="Amount" value={c.amount} onChange={(v) => patchCost(c.key, { amount: v })} readOnly={readOnly} />
        ) : (
          <PercentInput size="sm" aria-label="Percent of the consumed cost" value={c.pct} onChange={(v) => patchCost(c.key, { pct: v })} max={1000} readOnly={readOnly} />
        ),
      calc: <span className="bx-mfg-lines__value">{preview?.costValues.get(c.key) !== undefined ? formatMoney(preview.costValues.get(c.key) as Paise) : ''}</span>,
    },
  }));

  const blocking = (preview?.warnings ?? []).filter((w) => w.level !== 'info');
  const subtitle = isAlter ? `${detail?.number ?? ''} · ${STOCK_JOURNAL_CLASS_LABELS[form.cls]}` : STOCK_JOURNAL_CLASS_LABELS[form.cls];

  return (
    <Screen
      title={title}
      subtitle={subtitle}
      dirty={dirty}
      actions={actions}
      meta={form.isOptional || form.isPostDated ? [form.isOptional ? 'Optional — moves no stock' : null, form.isPostDated ? 'Post-dated' : null].filter(Boolean).join(' · ') : undefined}
      hint="Enter Next field · Ctrl+A Accept · Alt+B Fill from BOM · Ctrl+D Remove line · Alt+N Insert line · Ctrl+E Description · Ctrl+L Optional · Alt+P Print · Esc Back"
    >
      <div ref={formRef} onFocus={onFormFocus}>
        <Stack gap={4}>
          {errors.general.length > 0 ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setErrors((e) => ({ ...e, general: [] }))}>
              {errors.general.join(' ')}
            </Banner>
          ) : null}
          {readOnly ? <Banner tone="info">Your role can view these vouchers but not {isAlter ? 'alter' : 'create'} them.</Banner> : null}

          <FieldGroup columns={jobWork ? 4 : 3}>
            <Field label="Voucher no." optional error={errors.fields.number} hint={preview?.number || ctx.nextNumber ? `Next: ${preview?.number ?? ctx.nextNumber}` : undefined}>
              <TextInput value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} placeholder={ctx.nextNumber ?? 'Automatic'} maxLength={30} readOnly={readOnly} />
            </Field>
            <Field label="Date" required error={errors.fields.date}>
              <DateInput value={form.date} onChange={(d) => d && setForm((f) => ({ ...f, date: d }))} referenceDate={working.date} readOnly={readOnly} data-autofocus={isAlter ? '' : undefined} />
            </Field>
            {jobWork ? (
              <>
                <Field label={direction === 'in' ? 'Principal' : 'Job worker'} required error={errors.fields.partyLedgerId}>
                  <LedgerPicker classes={['party']} value={form.partyLedgerId} onChange={(id) => setParty(id)} showBalance={false} readOnly={readOnly} />
                </Field>
                <Field label="Job work godown" required error={errors.fields.thirdPartyGodownId} hint={kind ? THIRD_PARTY_KIND_LABELS[kind] : 'Mark the godown under Godowns › Whose stock.'}>
                  <Select
                    value={form.thirdPartyGodownId === null ? '' : String(form.thirdPartyGodownId)}
                    onChange={(v) => setForm((f) => ({ ...f, thirdPartyGodownId: v === '' ? null : Number(v) }))}
                    disabled={readOnly}
                    placeholder="Choose…"
                    options={thirdPartyGodowns.map((g) => ({ value: String(g.id), label: `${g.name}${g.partyName ? ` — ${g.partyName}` : ''}` }))}
                  />
                </Field>
              </>
            ) : null}
          </FieldGroup>

          {jobWork && features.jobWork ? (
            <FieldGroup columns={3}>
              <Field
                label={direction === 'in' ? "Principal's challan no." : "Job worker's challan no."}
                optional
                error={errors.fields.referenceNo}
                hint={form.cls === 'material_in' && direction === 'out' ? 'The challan the job worker sent the goods back with (ITC-04 table 5A).' : 'Their own document number, if any.'}
              >
                <TextInput value={form.referenceNo} onChange={(e) => setForm((f) => ({ ...f, referenceNo: e.target.value }))} maxLength={50} readOnly={readOnly} />
              </Field>
              <Field label="Job work order" optional error={errors.fields.jobWorkOrderId}>
                <Select value={form.jobWorkOrderId === null ? '' : String(form.jobWorkOrderId)} onChange={(v) => setForm((f) => ({ ...f, jobWorkOrderId: v === '' ? null : Number(v) }))} disabled={readOnly || form.partyLedgerId === null} options={orderOptions} />
              </Field>
              <Field label="Nature of job work (process)" optional hint="Printed on the challan and in ITC-04, e.g. Machining, Dyeing.">
                <TextInput value={form.process} onChange={(e) => setForm((f) => ({ ...f, process: e.target.value }))} maxLength={200} readOnly={readOnly} />
              </Field>
            </FieldGroup>
          ) : null}

          {sections.needsGodown ? (
            <EmptyState
              size="sm"
              title="Choose the job worker and the job work godown"
              body="Its kind decides the lines: your goods with them, or a principal's goods with you."
            />
          ) : null}

          {sections.products && product ? (
            // The finished goods are a line of the voucher too (data-row-key: Ctrl+E, a save error's line).
            <section className="bx-mfg-section" aria-label="Finished goods" data-row-key={product.key}>
              <h2 className="bx-sr-only">Finished goods</h2>
              <FieldGroup columns={features.multipleGodowns ? 4 : 3} legend={form.cls === 'manufacturing' ? 'Finished goods' : 'Finished goods received from the job worker'}>
                <Field
                  label="Item"
                  required={form.cls === 'manufacturing'}
                  error={errors.rows.get(product.key)}
                  labelAction={
                    readOnly || product.itemId === null || lineDescriptionShown(descOpen, product) ? undefined : (
                      <Button size="sm" variant="link" tabIndex={-1} shortcut="Ctrl+E" onClick={() => openDescription(product.key)}>
                        Description
                      </Button>
                    )
                  }
                >
                  {named(
                    product,
                    <ItemPicker
                      goodsOnly
                      asOf={form.date}
                      value={product.itemId !== null ? { id: product.itemId, name: product.itemName } : null}
                      onChange={setProductItem}
                      readOnly={readOnly}
                      data-autofocus={isAlter ? undefined : ''}
                    />,
                  )}
                </Field>
                {features.manufacturing ? (
                  <Field label="Bill of materials" optional error={errors.fields.bomId} hint={autoFill ? 'Components fill in from it.' : 'Alt+B fills the components again.'}>
                    <Select
                      value={form.bomId === null ? '' : String(form.bomId)}
                      onChange={(v) => {
                        applied.current = '';
                        setAutoFill(true);
                        setForm((f) => ({ ...f, bomId: v === '' ? null : Number(v) }));
                      }}
                      disabled={readOnly || product.itemId === null}
                      options={[{ value: '', label: boms.length === 0 ? 'No BOM' : 'None' }, ...boms.map((b) => ({ value: String(b.id), label: `${b.name}${b.isDefault ? ' (default)' : ''}${b.isActive ? '' : ' — inactive'}` }))]}
                    />
                  </Field>
                ) : null}
                <Field label="Quantity" required>
                  <QuantityInput value={product.qty} onChange={(q) => patchRow(product.key, { qty: q }, false)} unit={product.unit} decimals={product.decimals} readOnly={readOnly} />
                </Field>
                {features.multipleGodowns ? (
                  <Field label="Into godown" optional>
                    <GodownPicker value={product.godownId} onChange={(id) => patchRow(product.key, { godownId: id }, false)} placeholder="Main Location" readOnly={readOnly} allowCreate={false} />
                  </Field>
                ) : null}
              </FieldGroup>
              {features.batches ? (
                <FieldGroup columns={3}>
                  <Field label="Batch" optional>
                    <TextInput value={product.batchName} onChange={(e) => patchRow(product.key, { batchName: e.target.value }, false)} maxLength={100} readOnly={readOnly} />
                  </Field>
                </FieldGroup>
              ) : null}
            </section>
          ) : null}

          {sections.components ? (
            <LinesTable
              caption={form.cls === 'manufacturing' ? 'Components consumed' : `Components consumed by the job worker${thirdName ? ` (at ${thirdName})` : ''}`}
              columns={componentCols}
              rows={componentRows}
              tools
              footer={est ? `Consumption ₹ ${formatMoney(est.consumed)}` : undefined}
            />
          ) : null}

          {sections.products ? <LinesTable caption="By-products and scrap" columns={outputCols} rows={outputRows} tools footer={est && est.byProducts > 0 ? `By-products and scrap ₹ ${formatMoney(est.byProducts)}` : undefined} /> : null}

          {sections.material ? (
            <LinesTable
              caption={
                sections.material === 'transfer'
                  ? form.cls === 'material_out'
                    ? `Material sent to ${thirdName || 'the job worker'}`
                    : `Material returned unprocessed from ${thirdName || 'the job worker'}`
                  : sections.material === 'receipt'
                    ? `Principal's material received into ${thirdName}`
                    : `Material sent back to the principal from ${thirdName}`
              }
              columns={materialCols}
              rows={materialRows}
              tools
              footer={est && est.transferred > 0 ? `Value ₹ ${formatMoney(est.transferred)}` : undefined}
            />
          ) : null}

          {sections.costs ? (
            <LinesTable
              caption="Additional costs (labour, power, overheads)"
              note="They add to the value of the finished goods only — the journal posts no ledger entry. Book the expense itself with a Payment or Journal voucher."
              columns={costCols}
              rows={costRows}
              footer={est && est.additional > 0 ? `Additional cost ₹ ${formatMoney(est.additional)}` : undefined}
            />
          ) : null}

          {est && (sections.products || est.transferred > 0) ? (
            <div aria-live="polite">
              <StatLine
                items={[
                  {
                    label: 'Cost of finished goods',
                    value: est.productValue,
                    title: `Components consumed ₹ ${formatMoney(est.consumed)}${est.additional ? ` + additional costs ₹ ${formatMoney(est.additional)}` : ''}${est.byProducts ? ` − by-products / scrap ₹ ${formatMoney(est.byProducts)}` : ''}`,
                  },
                  { label: 'Rate per unit', value: est.productQty > 0 ? `₹${formatMoney(Math.round(est.productRate * 100))} per ${product?.unit ?? 'unit'}` : '—' },
                ]}
              />
            </div>
          ) : null}
          {est && est.shortfall > 0 ? <Banner tone="warning">By-products and scrap are worth more than the cost of production; the finished goods would be valued at nil.</Banner> : null}
          {blocking.length > 0 ? (
            <Banner tone="warning" title="Check before saving">
              {blocking.map((w) => w.message).join(' ')}
            </Banner>
          ) : null}

          <Field label="Narration" optional hint="Ctrl+Enter to accept.">
            <TextArea value={form.narration} onChange={(e) => setForm((f) => ({ ...f, narration: e.target.value }))} rows={2} autoGrow maxRows={5} maxLength={2000} readOnly={readOnly} />
          </Field>
        </Stack>
      </div>
      {cancelOpen && detail?.id ? (
        <CancelDialog
          number={detail.number}
          pending={cancelM.pending}
          onClose={() => setCancelOpen(false)}
          onConfirm={async (reason) => {
            try {
              await cancelM.mutate({ id: detail.id as number, reason, ...(detail.updatedAt ? { expectedUpdatedAt: detail.updatedAt } : {}) });
              toast.success('Voucher cancelled — its number is kept, its stock moves are removed');
              setCancelOpen(false);
              nav.pop();
            } catch (err) {
              setCancelOpen(false);
              setErrors({ ...NO_ERRORS, general: [userMessage(err)] });
            }
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * 2.2: a line's own description under its item — voucher entry's quiet one-line field (vouchers/entry/grids.tsx ›
 * LineDescription), growing to four lines, on this screen's Enter chain (useEnterAdvance, DOM order): it follows
 * the item, and Enter / Shift+Enter move to the next / previous field as on every other field (no typed new lines;
 * pasted ones stay); Ctrl+Enter, the multi-line box convention, does the same through useEnterAdvance. It is never
 * the last field (the narration follows). Left empty it closes again (`onLeave`): at once for a key or a
 * programmatic move, after the press when a click moved the cursor. Its errors are the line's (shown under it).
 */
function LineDescriptionField({
  rowKey,
  label,
  value,
  readOnly,
  onChange,
  onFocusLine,
  onLeave,
}: {
  rowKey: string;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onFocusLine: (rowKey: string) => void;
  onLeave: (rowKey: string, text: string) => void;
}) {
  return (
    <TextArea
      id={descriptionId(rowKey)}
      className="bx-mfg-desc"
      aria-label={label}
      rows={1}
      autoGrow
      maxRows={4}
      maxLength={DESC_MAX_LENGTH}
      placeholder="Description"
      value={value}
      readOnly={readOnly}
      // Under the finished goods' "Item" it is inside that Field: not required or invalid with it.
      required={false}
      invalid={false}
      onValueChange={onChange}
      onFocus={() => onFocusLine(rowKey)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || readOnly) return;
        e.preventDefault();
        const field = e.currentTarget;
        const scope = field.closest<HTMLElement>('[data-enter-scope]');
        const next = scope ? enterNeighbour(getEnterTargets(scope), field, e.shiftKey) : null;
        if (next) {
          focusElement(next, true);
          next.scrollIntoView({ block: 'nearest' });
        }
      }}
      onBlur={(e) => {
        // A dialog opened from here (Alt+X, a confirmation …) gives the cursor back to this field, and so does the
        // window when the user returns: keep it for them. Anything else closes an empty one.
        const to = e.relatedTarget;
        if (to instanceof Element && to.closest('[role="dialog"], [role="alertdialog"]')) return;
        if (!document.hasFocus()) return;
        // A press below — a row tool, a label, the narration — moves the cursor at mousedown. Closed now, the field
        // would pull what was pressed up from under the pointer and the click would land elsewhere, so it closes once
        // the press is over, after the click (vouchers/lib/lineDescription.ts › afterPointerRelease) — unless the
        // cursor is back by then (Ctrl+E from the shortcut bar). The pressed control is :active (with nothing
        // focused, as for a label, the page is). Keys (Enter, Tab) and programmatic moves close it at once.
        if ((to instanceof Element ? to : document.documentElement).matches(':active')) {
          const field = e.currentTarget;
          afterPointerRelease(document, () => {
            if (document.activeElement !== field) onLeave(rowKey, field.value);
          });
          return;
        }
        onLeave(rowKey, e.currentTarget.value);
      }}
    />
  );
}

function CancelDialog({ number, pending, onClose, onConfirm }: { number: string | null; pending: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel voucher ${number ?? ''}?`.replace(/\s+\?/, '?')}
      description="A cancelled voucher keeps its number but moves no stock. Give the reason for the audit trail."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Go back</Button>
          <Button variant="danger" loading={pending} disabled={reason.trim() === ''} onClick={() => void onConfirm(reason.trim())}>
            Cancel voucher
          </Button>
        </>
      }
    >
      <Field label="Reason" required>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} autoGrow data-autofocus="" />
      </Field>
    </Modal>
  );
}

/** Role names of a journal's lines, for the voucher view panel and tests. */
export const ROLE_TEXT: Readonly<Record<StockJournalRole, string>> = {
  component: 'Component',
  product: 'Finished goods',
  by_product: 'By-product',
  scrap: 'Scrap',
  transfer: 'Material',
  receipt: 'Received',
  issue: 'Returned',
};
