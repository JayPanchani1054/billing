/**
 * 'vouchers.entry' — Tally-style voucher creation / alteration, one screen for every voucher type.
 *
 * Params: { baseType? | voucherTypeId?, id? (alter), duplicateOf?, draft?, date?, partyId? }
 *   draft: a new voucher pre-filled by 'documents.draft' — a quotation / proforma converted into an
 *   order / invoice (links back), a note billed by its invoice, or a recurring occurrence (Edit & post).
 *
 * Modes (lib/kinds.ts ALLOWED_MODES): item invoice, accounting invoice, ledger (single-entry
 * Account + particulars or Dr/Cr double entry), inventory (notes, orders, stock journal, physical
 * stock). Live totals use the shared GST engine (lib/totals.ts → computeInvoice); the server
 * re-checks with vouchers.preview while the user pauses, and again on save.
 *
 * Keyboard: Enter next field / cell (empty row → next section), Shift+Enter back, Ctrl+A accept,
 * Esc back (asks when changed), F2 date, F10 voucher type, F4–F9 & co. switch type (new vouchers),
 * Alt+I item ↔ accounting invoice, Ctrl+H single ↔ double entry, Ctrl+I more details, Alt+T fill
 * from notes/orders, Alt+B bill-wise, Alt+O cost centres, Alt+K bank details, Ctrl+B balance it,
 * Ctrl+D delete line, Alt+N / Ctrl+N insert line, Ctrl+L optional, Ctrl+T post-dated, F12 settings;
 * Alt+P print (the voucher being altered, or the one just saved here — lib/printing.ts);
 * alteration: Alt+D delete, Alt+X cancel, Alt+2 duplicate, Alt+H edit history.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { PREDEFINED_VOUCHER_TYPES } from '../../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { formatMoney } from '../../../../shared/format.ts';
import { stateOptions } from '../../../../shared/gst/index.ts';
import type { VoucherTypeRow } from '../../../../shared/types/accounts.ts';
import type { ItemPickerRow } from '../../../../shared/types/inventory.ts';
import type {
  TrackingDoc,
  TrackingKind,
  VoucherDetail,
  VoucherEntryContext,
  VoucherInput,
  VoucherMode,
  VoucherWarning,
} from '../../../../shared/types/vouchers.ts';
import {
  ApiError,
  api,
  fieldErrorsOf,
  isApiError,
  Screen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useFeatures,
  useNav,
  userMessage,
  useScreen,
  useShell,
  useWorkingDate,
  withConfirmation,
} from '../../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../../app/index.ts';
import { isShellFocus } from '../../../app/index.ts';
import { Badge, Button, DateInput, EmptyState, Field, Hotkeys, Kbd, SegmentedControl, Select, Switch, TextArea, TextInput, useEnterAdvance, useToast } from '../../../ui/index.ts';
import { allocationTotal } from '../lib/bills.ts';
import { ACCOUNT_ROW, buildVoucherInput, formFromInput } from '../lib/buildInput.ts';
import type { BuiltInput } from '../lib/buildInput.ts';
import { cellId, confirmationRequest, headerId, mapFieldErrors, parseCellId, targetOf, warningsByRow, warningsOfDetails } from '../lib/errorPaths.ts';
import type { KeyMaps } from '../lib/errorPaths.ts';
import { formReducer, isBlankItem, isBlankLedger, itemLineValue, itemsOf, newForm } from '../lib/formState.ts';
import type { ItemRow, LedgerRow, VoucherForm } from '../lib/formState.ts';
import { entrySections, initialFocusId, neighbourSection, nextCell, rowAfterDelete, verticalCell } from '../lib/gridNav.ts';
import type { EntrySection, GridModel } from '../lib/gridNav.ts';
import { baseTypeLabel, defaultDirection, defaultTypeFor, isGstBase, isInvoiceMode, MODE_LABEL, partySign, postsToBooks, qtyLabel, showsParty, singleEntryAccountSide, trackingKinds } from '../lib/kinds.ts';
import { defaultItemRate, priceSide, rowsFromTrackingDoc, taxBreakup, toClientItemInfo, toClientLedgerTax } from '../lib/masters.ts';
import { computeInvoiceTotals, computeLedgerTotals, computeStockTotals, stabilizeLines } from '../lib/totals.ts';
import type { ClientTotals, LineFigures, TotalsEnv } from '../lib/totals.ts';
import { afterSavePrint, entryPrintTarget, savedToastMessage, voucherRefLabel } from '../lib/printing.ts';
import type { SavedVoucherRef } from '../lib/printing.ts';
import { clientIssues } from '../lib/validate.ts';
import { LedgerCombo } from '../pickers/LedgerCombo.tsx';
import { useGodowns, useItemRows, useLedgerDetails, useLedgerRows, usePriceLevels } from '../pickers/hooks.ts';
import { BillsDialog } from './BillsDialog.tsx';
import { GstDetailsDialog } from '../../gst/GstDetailsDialog.tsx';
import { gstDetailsKinds, gstDetailsSummary } from '../../gst/lib/gstplus.ts';
import { ConfigHintsDialog, CostDialog, InstrumentDialog, MoreDetailsDialog, ReasonDialog, TrackingDialog, TypeSwitchDialog } from './dialogs.tsx';
import type { MoreDetailsValue } from './dialogs.tsx';
import { GridEnvContext, ItemGrid, itemColumns, LedgerGrid, navItemColumns, rowDetailNeeds, TotalRow } from './grids.tsx';
import type { GridEnv, LedgerColumn, RowDialogKind } from './grids.tsx';
import { breakupRows, checkItemsOf, ChecksPanel, ErrorBanner, PartyPanel, TotalsPanel } from './panels.tsx';
import type { CheckItem } from './panels.tsx';
import { TdsEntryPanel } from '../../tds/EntryPanel.tsx';
import type { TdsVoucherPreview } from '../../../../shared/types/tds.ts';
import type { ForexVoucherPreview } from '../../../../shared/types/forex.ts';
import { formatExchangeRate, formatForex } from '../../../../shared/forex.ts';
import { ForexEntryPanel } from '../../forex/EntryPanel.tsx';
import { ForexInvoiceDialog, ForexLineDialog, ForexPartyBillsDialog } from '../../forex/ForexDialogs.tsx';
import { useForexContext } from '../../forex/hooks.ts';
import { decodeForex } from '../../forex/lib/entry.ts';

export interface VoucherEntryParams {
  baseType?: VoucherBaseType;
  voucherTypeId?: number;
  /** Alter this voucher. */
  id?: number;
  /** New voucher pre-filled from this one. */
  duplicateOf?: number;
  /** New voucher pre-filled by the documents module ('documents.draft'): conversion, billing a note, recurring occurrence. */
  draft?: VoucherDraftParams;
  /** Voucher date (default: the working date). */
  date?: string;
  /** Pre-selected party (e.g. from a party's ledger). */
  partyId?: number;
}

export interface VoucherDraftParams {
  sourceId?: number;
  targetBaseType?: VoucherBaseType;
  voucherTypeId?: number;
  templateId?: number;
  periodKey?: string;
  /** Conversion / billing: the new voucher's date (the opener's working date). Recurring: omit (the occurrence date). */
  date?: string;
}

/** Everything a voucher save can change elsewhere ('documents': quotation status, recurring due list, bills pending). */
export const VOUCHER_INVALIDATES = ['vouchers', 'reports', 'gst', 'gstrecon', 'outstanding', 'stock', 'banking', 'dashboard', 'accounts', 'inventory', 'print', 'documents', 'tds'];

/** Focus an element by id once it exists (cells appear one render after their row is filled). */
export function focusId(id: string, attempts = 6): void {
  const tryFocus = (left: number) => {
    const el = typeof document === 'undefined' ? null : document.getElementById(id);
    if (el) {
      el.focus();
      if (typeof (el as HTMLElement).scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (left > 0) requestAnimationFrame(() => tryFocus(left - 1));
  };
  requestAnimationFrame(() => tryFocus(attempts));
}

// ───────────────────────────── Outer: resolve type / voucher ─────────────────────────────

export function VoucherEntryScreen({ params }: ScreenProps<VoucherEntryParams>) {
  const nav = useNav();
  const { date: workingDate } = useWorkingDate();
  const typesQ = useApiQuery('accounts.voucherType.list', {}, { staleTime: 60_000 });
  const detailQ = useApiQuery('vouchers.get', { id: params.id ?? 0 }, { enabled: params.id !== undefined, staleTime: 0 });
  const dupQ = useApiQuery('vouchers.duplicate', { id: params.duplicateOf ?? 0 }, { enabled: params.duplicateOf !== undefined && params.id === undefined, staleTime: 0 });
  const wantsDraft = params.draft !== undefined && params.id === undefined && params.duplicateOf === undefined;
  const draftQ = useApiQuery('documents.draft', params.draft ?? {}, { enabled: wantsDraft, staleTime: 0 });
  const types = typesQ.data?.rows;
  const detail = params.id !== undefined ? detailQ.data : undefined;
  const dup = params.duplicateOf !== undefined && params.id === undefined ? dupQ.data : wantsDraft ? draftQ.data : undefined;

  const waiting = (params.id !== undefined && !detail) || ((params.duplicateOf !== undefined || wantsDraft) && params.id === undefined && !dup);
  const type: VoucherTypeRow | null = useMemo(() => {
    // Alteration / duplicate: the type is the saved voucher's — never guess one while it loads (a
    // guessed Sales type would fetch, and briefly use, the wrong entry context).
    if (!types || waiting) return null;
    if (detail) return types.find((t) => t.id === detail.voucherType.id) ?? null;
    if (dup) return types.find((t) => t.id === dup.voucherTypeId) ?? null;
    if (params.voucherTypeId !== undefined) return types.find((t) => t.id === params.voucherTypeId) ?? null;
    if (params.baseType) return defaultTypeFor(types, params.baseType);
    return defaultTypeFor(types, 'sales');
  }, [types, waiting, detail, dup, params.voucherTypeId, params.baseType]);

  const initialDate = detail ? detail.date : (params.date ?? workingDate);
  const ctxQ = useApiQuery('vouchers.entryContext', { voucherTypeId: type?.id ?? 0, date: initialDate }, { enabled: type !== null });
  // keepPrevious is off and the id is checked: the form must start from THIS type's context.
  const ctx0 = ctxQ.data && type && ctxQ.data.voucherType.id === type.id ? ctxQ.data : undefined;

  // A cancelled voucher, or one whose e-invoice (IRN) is generated, cannot be altered: show it read-only.
  const readOnly = !!detail && (detail.isCancelled || detail.irn.status === 'generated');
  useEffect(() => {
    if (detail && readOnly) nav.replace('vouchers.view', { id: detail.id });
  }, [detail, readOnly, nav]);

  // Manufacturing Journal / Material In / Material Out (stock journal types with a class, mfg module) are
  // entered on 'mfg.journal.entry': hand F10 / Go To / Alt+A over to it when the user may open it.
  const mfgClass = (ctx0?.voucherType.config as { stockJournalClass?: string | null } | null | undefined)?.stockJournalClass ?? null;
  const handOver = mfgClass !== null && !readOnly && nav.canOpen('mfg.journal.entry');
  useEffect(() => {
    if (!handOver || !type) return;
    nav.replace('mfg.journal.entry', {
      voucherTypeId: type.id,
      ...(params.id !== undefined ? { id: params.id } : {}),
      ...(params.duplicateOf !== undefined ? { duplicateOf: params.duplicateOf } : {}),
      ...(params.date !== undefined ? { date: params.date } : {}),
      ...(params.partyId !== undefined ? { partyId: params.partyId } : {}),
    });
  }, [handOver, type, params.id, params.duplicateOf, params.date, params.partyId, nav]);

  // A company-defined type opened from F10 / Go To ({ baseType, voucherTypeId }) shows its own name.
  const label = params.baseType && params.voucherTypeId === undefined ? baseTypeLabel(params.baseType) : (type?.name ?? (params.baseType ? baseTypeLabel(params.baseType) : 'Voucher'));
  const title = params.id !== undefined ? `${detail?.voucherType.name ?? label} Alteration` : `${type?.name ?? label} Voucher`;
  const loading = typesQ.loading || waiting || (type !== null && !ctx0);
  const error = typesQ.error ?? (params.id !== undefined ? detailQ.error : null) ?? (params.duplicateOf !== undefined ? dupQ.error : null) ?? (wantsDraft ? draftQ.error : null) ?? ctxQ.error;

  if (error || loading || !types || readOnly || handOver) {
    return <Screen title={title} icon="invoice" loading={!error} error={error} onRetry={() => void (typesQ.refetch(), detailQ.refetch(), dupQ.refetch(), draftQ.refetch(), ctxQ.refetch())} />;
  }
  if (!type) {
    return (
      <Screen title={title} icon="invoice">
        <EmptyState
          icon="invoice"
          title={`No active ${label} voucher type`}
          body="Create or activate one under Masters › Voucher Types, then try again."
          action={
            <Button variant="primary" onClick={() => nav.push('accounts.voucherTypes')}>
              Open voucher types
            </Button>
          }
        />
      </Screen>
    );
  }
  if (!ctx0) return <Screen title={title} icon="invoice" loading />;
  if (!detail && !ctx0.permissions.canCreate) {
    return (
      <Screen title={title} icon="invoice">
        <EmptyState icon="lock" title={`You cannot enter ${type.name} vouchers`} body="Your role can view vouchers but not create them. Ask an administrator for the “Create vouchers” permission." />
      </Screen>
    );
  }
  return <EntryForm key={`${type.id}:${params.id ?? ''}:${params.duplicateOf ?? ''}:${params.draft ? JSON.stringify(params.draft) : ''}`} type={type} types={types} ctx0={ctx0} detail={detail} dup={dup} params={params} />;
}

// ───────────────────────────── Inner: the form ─────────────────────────────

interface EntryFormProps {
  type: VoucherTypeRow;
  types: readonly VoucherTypeRow[];
  ctx0: VoucherEntryContext;
  detail: VoucherDetail | undefined;
  dup: VoucherInput | undefined;
  params: VoucherEntryParams;
}

type Dialog =
  | { kind: 'bills'; rowKey: string | null }
  | { kind: 'cost'; rowKey: string }
  | { kind: 'instrument'; rowKey: string }
  | { kind: 'more' }
  | { kind: 'tracking' }
  | { kind: 'type' }
  | { kind: 'config' }
  | { kind: 'cancel' }
  | { kind: 'gst' }
  /** (forex module) Foreign amount + rate of a ledger line, or (rowKey null) the invoice currency + rate. */
  | { kind: 'forex'; rowKey: string | null }
  | null;

interface PreviewState {
  form: VoucherForm;
  keys: KeyMaps;
  warnings: VoucherWarning[];
  issues: CheckItem[];
  grandTotal: number | null;
  number: string | null;
  /** TDS/TCS computed by the server (tds module voucher hook). */
  tds?: TdsVoucherPreview;
  /** Foreign-currency amounts and realised differences (forex module voucher hook). */
  forex?: ForexVoucherPreview;
}

const CTRL_KEYS_SWITCH = PREDEFINED_VOUCHER_TYPES.filter((t) => t.hotkey && t.hotkey !== 'F10');

function EntryForm({ type, types, ctx0, detail, dup, params }: EntryFormProps) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const shell = useShell();
  const features = useFeatures();
  const working = useWorkingDate();
  const screen = useScreen();
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const baseType = type.baseType;
  const isAlter = detail !== undefined;
  const typeConfig = (ctx0.voucherType.config ?? {}) as { defaultPartyLedgerId?: number | null; defaultGodownId?: number | null };
  const canAudit = useCan('audit.view');
  /** Party a new voucher starts with: the one passed in, else the voucher type's default (e.g. Cash for "Cash Sales"). */
  const startParty = params.partyId ?? typeConfig.defaultPartyLedgerId ?? null;

  const [form, dispatch] = useReducer(formReducer, undefined, (): VoucherForm => {
    if (detail) return formFromInput(detail.input, { baseType, alter: true });
    if (dup) return { ...formFromInput(dup, { baseType, alter: false, date: params.date ?? working.date }), touched: true };
    const side = singleEntryAccountSide(baseType);
    return newForm({
      voucherTypeId: type.id,
      baseType,
      mode: ctx0.defaultMode,
      date: params.date ?? working.date,
      isOptional: ctx0.voucherType.optionalByDefault,
      partyLedgerId: startParty,
      accountLedgerId: side !== null && baseType !== 'contra' ? ctx0.ledgers.cash : null,
    });
  });
  const formRef = useRef(form);
  formRef.current = form;

  // Without permission to alter, a saved voucher opens read-only.
  useEffect(() => {
    if (detail && !ctx0.permissions.canAlter) nav.replace('vouchers.view', { id: detail.id });
  }, [detail, ctx0.permissions.canAlter, nav]);

  const ctxQ = useApiQuery('vouchers.entryContext', { voucherTypeId: type.id, date: form.date }, { keepPrevious: true });
  const ctx = ctxQ.data ?? ctx0;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const voucherId = detail?.id ?? null;

  // ── Masters ──
  const itemsOn = form.mode === 'item_invoice' || form.mode === 'inventory';
  const ledgers = useLedgerRows(form.date);
  const items = useItemRows(form.date, form.priceLevelId, itemsOn);
  const godowns = useGodowns(features.multipleGodowns && itemsOn);
  const partyShown = showsParty(baseType, form.mode);
  const partyInput = voucherId === null ? { ledgerId: form.partyLedgerId ?? 0, date: form.date } : { ledgerId: form.partyLedgerId ?? 0, date: form.date, excludeVoucherId: voucherId };
  const partyQ = useApiQuery('vouchers.partyContext', partyInput, { enabled: partyShown && form.partyLedgerId !== null, keepPrevious: true });
  const party = partyQ.data && partyQ.data.ledgerId === form.partyLedgerId && partyShown ? partyQ.data : undefined;
  const direction = party?.gstDirection ?? defaultDirection(baseType);
  const priceLevels = usePriceLevels(features.priceLevels && itemsOn && direction === 'outward');
  const detailIds = useMemo(() => {
    const ids: number[] = [];
    for (const r of form.ledgers) if (r.ledgerId !== null) ids.push(r.ledgerId);
    if (form.mode === 'item_invoice') {
      for (const r of form.items) if (r.ledgerId !== null) ids.push(r.ledgerId);
      if (ctx.defaultLedgerId !== null) ids.push(ctx.defaultLedgerId);
    }
    return ids;
  }, [form.ledgers, form.items, form.mode, ctx.defaultLedgerId]);
  const ledgerDetails = useLedgerDetails(detailIds);

  // ── Foreign currency (forex module; F11 › Multiple currencies) ──
  const fx = useForexContext();
  const partyCurrency = isInvoiceMode(form.mode) ? fx.currencyOfLedger(form.partyLedgerId) : undefined;
  /** Invoice in a foreign currency: its amounts on the form are foreign × 100 (forex/lib/entry.ts). */
  const docForex = isInvoiceMode(form.mode) ? (form.forex ?? null) : null;
  const docCurrency = docForex ? fx.currencyById(docForex.currencyId) : undefined;
  const fxReady = fx.enabled && fx.data !== undefined;
  useEffect(() => {
    // The invoice currency follows the party: its currency at the master rate of the date (Alt+Y changes it).
    if (!fxReady || !isInvoiceMode(form.mode)) return undefined;
    if (!partyCurrency) {
      if (form.forex) dispatch({ type: 'patch', patch: { forex: null, partyBills: null } });
      return undefined;
    }
    if (form.forex && form.forex.currencyId === partyCurrency.id) return undefined;
    let alive = true;
    api('forex.rate.suggest', { currencyId: partyCurrency.id, date: form.date, baseType }).then(
      (sg) => {
        if (!alive) return;
        if (sg.rate) dispatch({ type: 'patch', patch: { forex: { currencyId: partyCurrency.id, rate: sg.rate, rateType: sg.rateType }, partyBills: null } });
        else setDialog({ kind: 'forex', rowKey: null });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // Re-run when the party's currency or the mode changes.
  }, [fxReady, partyCurrency?.id, form.mode]);
  useEffect(() => {
    // A line whose ledger is no longer kept in a foreign currency drops its foreign amount.
    if (!fxReady) return;
    for (const r of form.ledgers) {
      if (r.forexAmount !== undefined && r.forexAmount !== null && !fx.currencyOfLedger(r.ledgerId)) dispatch({ type: 'ledger', key: r.key, patch: { forexAmount: null, exchangeRate: null } });
    }
  }, [fxReady, form.ledgers, fx]);

  // ── Live totals (shared GST engine) ──
  const itemInfo = useMemo(() => new Map(items.rows.map((r) => [r.id, toClientItemInfo(r)])), [items.rows]);
  const ledgerTax = useMemo(() => new Map([...ledgerDetails].map(([id, d]) => [id, toClientLedgerTax(d)])), [ledgerDetails]);
  const partyTax = useMemo(() => {
    if (!party) return null;
    return {
      registrationType: form.party?.registrationType ?? party.registrationType,
      stateCode: form.party?.stateCode || party.stateCode || (party.country && party.country.toLowerCase() !== 'india' ? '96' : null),
      gstin: form.party?.gstin || party.gstin,
    };
  }, [party, form.party]);
  const totalsEnv = useMemo<TotalsEnv>(() => {
    const e: TotalsEnv = {
      direction,
      gstOn: ctx.company.gstEnabled,
      companyStateCode: ctx.company.stateCode ?? '',
      companyRegistration: ctx.company.gstRegistrationType,
      party: partyTax,
      // A foreign-currency invoice is not rounded in rupees (the server does the same).
      roundOff: docForex ? { ...ctx.config.roundOff, enabled: false } : ctx.config.roundOff,
      items: itemInfo,
      ledgerTax: (id) => ledgerTax.get(id),
      defaultLedgerId: ctx.defaultLedgerId,
    };
    if (ctx.config.gst.b2clThresholdPaise !== 1_00_000_00) e.b2clThresholdPaise = ctx.config.gst.b2clThresholdPaise;
    return e;
  }, [direction, ctx, partyTax, itemInfo, ledgerTax, docForex]);
  const deferred = useDeferredValue(form);
  const linesRef = useRef<ReadonlyMap<string, LineFigures> | null>(null);
  const invoice = useMemo<ClientTotals>(() => {
    const t = computeInvoiceTotals(deferred, totalsEnv);
    // Unchanged rows keep their figures object so their memoised grid rows do not re-render.
    const lines = stabilizeLines(linesRef.current, t.lines);
    linesRef.current = lines;
    return { ...t, lines };
  }, [deferred, totalsEnv]);
  const ledgerTotals = useMemo(() => computeLedgerTotals(deferred), [deferred]);
  const stockTotals = useMemo(() => computeStockTotals(deferred), [deferred]);

  // ── Errors, warnings, preview ──
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ title: string; messages: string[] } | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<{ warnings: VoucherWarning[]; keys: KeyMaps } | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | 'cancel' | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  /** The voucher last created from this screen: Alt+P prints it (lib/printing.ts). */
  const [lastSaved, setLastSaved] = useState<SavedVoucherRef | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  const typingClearsErrors = useRef(form);
  useEffect(() => {
    // Editing after a failed save: errors of cells that changed are cleared lazily (the next save re-checks).
    if (typingClearsErrors.current !== form && Object.keys(cellErrors).length > 0 && form.touched) {
      const active = typeof document !== 'undefined' ? document.activeElement?.id : undefined;
      if (active && active in cellErrors) {
        setCellErrors((cur) => {
          const next = { ...cur };
          delete next[active];
          return next;
        });
      }
    }
    typingClearsErrors.current = form;
  }, [form, cellErrors]);

  // Server check while the user pauses (only when the voucher looks complete).
  const numberingMethod = ctx.voucherType.numberingMethod;
  const referenceRequired = baseType === 'purchase' && ctx.company.gstEnabled && !!party && !!party.gstin && party.registrationType !== 'unregistered' && party.registrationType !== 'consumer';
  // The party's bill-wise allocation is checked against the invoice total (bill-wise parties only).
  const partyBillWise = features.billWise && !!party?.billWise && postsParty(baseType);
  const checksFor = (f: VoucherForm, invoiceTotal: number) => clientIssues(f, partyBillWise && isInvoiceMode(f.mode) ? { numberingMethod, referenceRequired, invoiceTotal } : { numberingMethod, referenceRequired });
  const pre = useMemo(
    () => clientIssues(deferred, partyBillWise && isInvoiceMode(deferred.mode) ? { numberingMethod, referenceRequired, invoiceTotal: invoice.grandTotal } : { numberingMethod, referenceRequired }),
    [deferred, numberingMethod, referenceRequired, partyBillWise, invoice.grandTotal],
  );
  useEffect(() => {
    if (pre.first !== null || !form.touched) return undefined;
    let alive = true;
    const snapshot = form;
    const t = setTimeout(() => {
      const built = buildVoucherInput(snapshot);
      setChecking(true);
      api('vouchers.preview', built.input).then(
        (p) => {
          if (!alive) return;
          setPreview({ form: snapshot, keys: built, warnings: p.warnings, issues: [], grandTotal: p.totals.grandTotal, number: p.number, tds: p.tds, forex: p.forex });
          // A fresher server check replaces the warnings of the last save attempt.
          setSaveWarnings(null);
          setChecking(false);
        },
        (err: unknown) => {
          if (!alive) return;
          const fe = fieldErrorsOf(err);
          const issues: CheckItem[] = Object.entries(fe).map(([path, message], i) => ({ key: `pv-${i}`, level: 'block', message, path }));
          if (issues.length === 0 && isApiError(err) && err.code !== 'UNKNOWN_ROUTE') issues.push({ key: 'pv', level: 'block', message: userMessage(err) });
          setPreview({ form: snapshot, keys: built, warnings: [], issues, grandTotal: null, number: null });
          setChecking(false);
        },
      );
    }, 900);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [form, pre.first]);

  const currentWarnings = saveWarnings ?? (preview ? { warnings: preview.warnings, keys: preview.keys } : null);
  const rowWarnings = useMemo(() => {
    const m = new Map<string, string>();
    if (!currentWarnings) return m;
    const { rows } = warningsByRow(currentWarnings.warnings, currentWarnings.keys);
    for (const [k, ws] of Object.entries(rows)) if (ws[0]) m.set(k, ws.map((w) => w.message).join(' · '));
    return m;
  }, [currentWarnings]);
  const rowErrors = useMemo(() => {
    const m = new Map<string, Record<string, string>>();
    for (const [id, msg] of Object.entries(cellErrors)) {
      const c = parseCellId(id);
      if (!c) continue;
      const cur = m.get(c.rowKey) ?? {};
      cur[id] = msg;
      m.set(c.rowKey, cur);
    }
    return m;
  }, [cellErrors]);
  const checkItems = useMemo<CheckItem[]>(() => {
    const out = currentWarnings ? checkItemsOf(currentWarnings.warnings) : [];
    if (!saveWarnings && preview) out.push(...preview.issues);
    return out;
  }, [currentWarnings, saveWarnings, preview]);

  // ── Navigation between header, grids and narration ──
  const sections = useMemo(() => entrySections(form.mode, baseType), [form.mode, baseType]);
  const itemCols = useMemo(
    () => (itemsOn ? itemColumns({ baseType, mode: form.mode === 'inventory' ? 'inventory' : 'item_invoice', features, gstOn: ctx.company.gstEnabled }) : []),
    [itemsOn, baseType, form.mode, features, ctx.company.gstEnabled],
  );
  const ledgerCols = useMemo<LedgerColumn[]>(() => {
    if (form.mode === 'accounting_invoice') return ctx.company.gstEnabled ? ['ledger', 'gst', 'hsn', 'amount'] : ['ledger', 'amount'];
    if (form.mode === 'ledger' && ctx.voucherType.narrationPerEntry) return ['ledger', 'amount', 'narr'];
    return ['ledger', 'amount'];
  }, [form.mode, ctx.company.gstEnabled, ctx.voucherType.narrationPerEntry]);

  const sectionRows = useCallback(
    (s: EntrySection, f: VoucherForm): Array<ItemRow | LedgerRow> => {
      if (s === 'items') return f.items;
      if (s === 'items:src') return itemsOf(f, true);
      if (s === 'items:dst') return itemsOf(f, false);
      if (s === 'ledgers') return f.ledgers;
      return [];
    },
    [],
  );
  const sectionOfRow = (f: VoucherForm, sectionKind: 'items' | 'ledgers', rowKey: string): EntrySection => {
    if (sectionKind === 'ledgers') return 'ledgers';
    if (baseType !== 'stock_journal') return 'items';
    return f.items.find((r) => r.key === rowKey)?.isConsumption ? 'items:src' : 'items:dst';
  };
  const modelOf = (s: EntrySection, f: VoucherForm, filledKey?: string): GridModel => {
    if (s === 'ledgers') {
      const cols = ledgerCols.filter((c) => c !== 'gst' && c !== 'hsn');
      return { columns: cols, rowKeys: f.ledgers.map((r) => r.key), isBlank: (k) => k !== filledKey && isBlankLedger(f.ledgers.find((r) => r.key === k) as LedgerRow) };
    }
    const rows = sectionRows(s, f) as ItemRow[];
    return {
      columns: navItemColumns(itemCols),
      rowKeys: rows.map((r) => r.key),
      isBlank: (k) => k !== filledKey && isBlankItem(rows.find((r) => r.key === k) as ItemRow),
      skip: (k, c) => {
        if (c !== 'batch') return false;
        const r = rows.find((x) => x.key === k);
        const it = r?.itemId != null ? items.byId.get(r.itemId) : undefined;
        return !it?.maintainBatches;
      },
    };
  };
  const focusHeaderLast = () => {
    const els = headerRef.current ? [...headerRef.current.querySelectorAll<HTMLElement>('input:not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly])')] : [];
    els[els.length - 1]?.focus();
  };
  /** Tally: the cursor starts on the number (manual), the party, the Account, or the first line. */
  const focusStart = () => {
    const f = formRef.current;
    const first = entrySections(f.mode, baseType)[0];
    const rows = sectionRows(first, f);
    focusId(
      initialFocusId({
        manualNumber: f.id === null && ctxRef.current.voucherType.numberingMethod === 'manual',
        referenceFirst: isInvoiceMode(f.mode) && (baseType === 'purchase' || (baseType === 'debit_note' && gridEnvRef.current.direction === 'inward')),
        partyShown: showsParty(baseType, f.mode),
        singleAccount: f.mode === 'ledger' && f.layout === 'single' && singleEntryAccountSide(baseType) !== null,
        firstSection: first,
        firstRowKey: rows[0]?.key ?? null,
      }),
    );
  };
  // The shell focuses a screen once, when it is pushed — before this form exists (it waits for its
  // data). Put the cursor where Tally does once the form is on screen (two frames: after the shell's).
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const host = headerRef.current?.closest('.bx-screen');
        const active = document.activeElement as HTMLElement | null;
        // Leave it alone when the user already moved into a field of this voucher — but not when the
        // shell put a provisional cursor on the first field (Date) while the form was loading.
        if (!screenRef.current.isTop) return;
        if (host && active && host.contains(active) && !isShellFocus(active) && active.matches('input:not([type=radio]), textarea, [role=combobox]')) return;
        focusStart();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
    // Mount only (focusStart reads refs).
  }, []);
  const enterSection = (s: EntrySection | 'header' | 'accept', dir: 'forward' | 'back') => {
    const f = formRef.current;
    if (s === 'header') return focusHeaderLast();
    if (s === 'accept') return void askAccept();
    if (s === 'narration') return focusId(headerId('narration'));
    const rows = sectionRows(s, f);
    if (rows.length === 0) return;
    const section = s === 'ledgers' ? 'ledgers' : 'items';
    if (dir === 'forward') {
      const first = rows[0];
      focusId(cellId(section, first.key, section === 'ledgers' ? 'ledger' : 'item'));
    } else {
      // Back into a grid: the last filled row's last cell (or the blank row).
      const filled = rows.filter((r) => (section === 'ledgers' ? !isBlankLedger(r as LedgerRow) : !isBlankItem(r as ItemRow)));
      const target = filled[filled.length - 1] ?? rows[rows.length - 1];
      const m = modelOf(s, f);
      const cols = m.columns.filter((c, i) => i === 0 || !m.skip?.(target.key, c));
      focusId(cellId(section, target.key, filled.length > 0 ? cols[cols.length - 1] : cols[0]));
    }
  };

  const move = (section: 'items' | 'ledgers', rowKey: string, column: string, dir: 'forward' | 'back', filled = false, billsAsked = false) => {
    const f = formRef.current;
    const s = sectionOfRow(f, section, rowKey);
    const m = modelOf(s, f, filled ? rowKey : undefined);
    // (forex module) Leaving the ledger of a line kept in a foreign currency: its amount in that currency
    // and the rate first (Tally's "$ … @ rate"); the rupees and bill-wise split come from that dialog.
    if (!billsAsked && dir === 'forward' && section === 'ledgers' && column === 'ledger' && f.mode === 'ledger') {
      const row = f.ledgers.find((r) => r.key === rowKey);
      if (row && row.ledgerId !== null && fx.currencyOfLedger(row.ledgerId) && (row.forexAmount === undefined || row.forexAmount === null)) {
        afterDialog.current = () => move(section, rowKey, 'amount', dir, filled, true);
        setDialog({ kind: 'forex', rowKey });
        return;
      }
    }
    // Leaving the amount of a bill-wise ledger line in a ledger voucher: allocate bills first (Tally).
    if (!billsAsked && dir === 'forward' && section === 'ledgers' && column === 'amount' && f.mode === 'ledger') {
      const row = f.ledgers.find((r) => r.key === rowKey);
      if (row && row.ledgerId !== null && row.amount && !row.bills && rowDetailNeeds(gridEnvRef.current, row.ledgerId).bills) {
        afterDialog.current = () => move(section, rowKey, column, dir, filled, true);
        setDialog({ kind: 'bills', rowKey });
        return;
      }
    }
    const t = nextCell(m, { rowKey, column }, dir);
    if (t.kind === 'cell') return focusId(cellId(section, t.rowKey, t.column));
    enterSection(neighbourSection(sections, s, dir === 'forward' ? 'forward' : 'back'), dir);
  };
  const afterDialog = useRef<(() => void) | null>(null);

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    const cell = parseCellId(t.id);
    if (!cell) return;
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      move(cell.section, cell.rowKey, cell.column, e.shiftKey ? 'back' : 'forward');
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && t.getAttribute('role') !== 'combobox') {
      const f = formRef.current;
      const v = verticalCell(modelOf(sectionOfRow(f, cell.section, cell.rowKey), f), { rowKey: cell.rowKey, column: cell.column }, e.key === 'ArrowUp' ? 'up' : 'down');
      if (v && v.kind === 'cell') {
        e.preventDefault();
        focusId(cellId(cell.section, v.rowKey, v.column));
      }
    }
  };

  const activeCell = () => parseCellId(typeof document === 'undefined' ? null : document.activeElement?.id);

  const deleteRow = useCallback((section: 'items' | 'ledgers', rowKey: string) => {
    const f = formRef.current;
    const list = section === 'items' ? f.items.map((r) => r.key) : f.ledgers.map((r) => r.key);
    const next = rowAfterDelete(list, rowKey);
    dispatch(section === 'items' ? { type: 'itemDelete', key: rowKey } : { type: 'ledgerDelete', key: rowKey });
    if (next) focusId(cellId(section, next, section === 'items' ? 'item' : 'ledger'));
  }, []);

  const insertRow = () => {
    const c = activeCell();
    if (!c) return;
    const f = formRef.current;
    const key = `${c.section === 'items' ? 'i' : 'l'}${f.seq + 1}`;
    if (c.section === 'items') {
      const ref = f.items.find((r) => r.key === c.rowKey);
      dispatch({ type: 'itemInsert', beforeKey: c.rowKey, isConsumption: ref?.isConsumption });
    } else dispatch({ type: 'ledgerInsert', beforeKey: c.rowKey });
    focusId(cellId(c.section, key, c.section === 'items' ? 'item' : 'ledger'));
  };

  // ── Item defaults ──
  const onItemChosen = useCallback(
    (rowKey: string, r: ItemPickerRow | null) => {
      const f = formRef.current;
      const row = f.items.find((x) => x.key === rowKey);
      if (!row) return;
      const p: Partial<Omit<ItemRow, 'key'>> = { itemId: r?.id ?? null, amount: null, rateInclusiveOfTax: null };
      if (r) {
        if (row.itemId !== r.id && baseType !== 'physical_stock') {
          const d = defaultItemRate(r, priceSide(baseType, gridEnvRef.current.direction));
          p.rate = d ? d.rate : null;
          p.autoRate = d ? d.rate : null;
          p.discountPct = d ? d.discountPct : null;
        }
        if (features.multipleGodowns && row.godownId === null) p.godownId = typeConfig.defaultGodownId ?? null;
        if (!r.maintainBatches) p.batchName = '';
      }
      dispatch({ type: 'item', key: rowKey, patch: p });
    },
    [baseType, features.multipleGodowns, typeConfig.defaultGodownId],
  );

  const advanceFrom = useCallback((section: 'items' | 'ledgers', rowKey: string, column: string) => {
    // Next frame: the pick that triggered this has been rendered, so the move sees the chosen item
    // (e.g. its batch column is no longer skipped) and the cells it targets exist.
    requestAnimationFrame(() => moveRef.current(section, rowKey, column, 'forward', true));
  }, []);
  const moveRef = useRef(move);
  moveRef.current = move;

  /**
   * Price-list quantity slabs: the rate filled in when the item was chosen is the slab for 1 unit.
   * When the quantity is committed, re-read the slab for that quantity — only while the rate is still
   * the one the screen filled in (a rate the user typed is never replaced).
   */
  const onQtyCommitted = useCallback((rowKey: string, qty: number | null) => {
    const f = formRef.current;
    const levelId = f.priceLevelId;
    if (levelId === null || qty === null || qty <= 0 || gridEnvRef.current.direction !== 'outward') return;
    const row = f.items.find((r) => r.key === rowKey);
    if (!row || row.itemId === null || row.autoRate === null || row.rate !== row.autoRate || row.amount !== null) return;
    const itemId = row.itemId;
    api('inventory.item.priceFor', { itemId, priceLevelId: levelId, date: f.date, qty, side: 'sales' }).then(
      (price) => {
        const cur = formRef.current.items.find((r) => r.key === rowKey);
        if (!cur || cur.itemId !== itemId || cur.rate !== cur.autoRate || cur.amount !== null || formRef.current.priceLevelId !== levelId) return;
        if (price.source !== 'price_list' || price.rate === cur.rate) return;
        const patch: Partial<Omit<ItemRow, 'key'>> = { rate: price.rate, autoRate: price.rate };
        if (cur.discountPct === null && price.discountPct) patch.discountPct = price.discountPct;
        dispatch({ type: 'item', key: rowKey, patch });
      },
      () => undefined,
    );
  }, []);

  const openRowDialog = useCallback((kind: RowDialogKind, rowKey: string) => {
    if (kind === 'bills') setDialog({ kind: 'bills', rowKey });
    else if (kind === 'cost') setDialog({ kind: 'cost', rowKey });
    else setDialog({ kind: 'instrument', rowKey });
  }, []);

  const excludeLedgerIds = useMemo(() => (form.partyLedgerId === null ? [] : [form.partyLedgerId]), [form.partyLedgerId]);
  const gridEnv = useMemo<GridEnv>(
    () => ({
      baseType,
      date: form.date,
      voucherId,
      features,
      direction,
      dispatch,
      ledgers: ledgers.rows,
      ledgerById: ledgers.byId,
      ledgerDetails,
      refetchLedgers: ledgers.refetch,
      items: items.rows,
      itemById: items.byId,
      refetchItems: items.refetch,
      godowns,
      excludeLedgerIds,
      onItemChosen,
      advanceFrom,
      onQtyCommitted,
      openRowDialog,
      deleteRow,
    }),
    // ledgers / items are memoised per list version (pickers/hooks.ts): this value stays the same
    // while the user types, so only the edited row re-renders.
    [baseType, form.date, voucherId, features, direction, ledgers, ledgerDetails, items, godowns, excludeLedgerIds, onItemChosen, advanceFrom, onQtyCommitted, openRowDialog, deleteRow],
  );
  const gridEnvRef = useRef(gridEnv);
  gridEnvRef.current = gridEnv;

  // ── Saving ──
  const save = useApiMutation('vouchers.save', { invalidates: VOUCHER_INVALIDATES });
  const del = useApiMutation('vouchers.delete', { invalidates: VOUCHER_INVALIDATES });
  const cancelM = useApiMutation('vouchers.cancel', { invalidates: VOUCHER_INVALIDATES });
  const typeName = ctx.voucherType.name;
  // The voucher type's switch, or F12 › Invoice printing for invoice-like types (vouchers.entryContext).
  const printAfterSave = ctx.config.printAfterSave && nav.isRegistered('print.voucher');

  const handleSaveError = (err: unknown, built: BuiltInput) => {
    if (!isApiError(err)) {
      setBanner({ title: 'Could not save', messages: [userMessage(err)] });
      return;
    }
    if (err.code === 'VALIDATION' || (err.code === 'CONFLICT' && Array.isArray(err.details))) {
      const m = mapFieldErrors(fieldErrorsOf(err.code === 'CONFLICT' ? new ApiError('VALIDATION', err.message, err.details) : err), built);
      setCellErrors(m.cells);
      const general = m.general.length > 0 ? m.general : Object.keys(m.cells).length === 0 ? [err.message] : [];
      setBanner(general.length > 0 || err.code === 'CONFLICT' ? { title: 'Please correct the voucher', messages: general.length > 0 ? general : [err.message] } : null);
      if (m.first) focusId(m.first.id);
      return;
    }
    if (err.code === 'BUSINESS_RULE') {
      const d = warningsOfDetails(err.details);
      if (d.warnings.length > 0) {
        setSaveWarnings({ warnings: d.warnings, keys: built });
        const firstBlock = d.warnings.find((w) => w.level === 'block' && w.path);
        const t = firstBlock?.path ? targetOf(firstBlock.path, built) : null;
        if (t) focusId(t.id);
      }
      setBanner({ title: 'This voucher cannot be saved yet', messages: [err.message] });
      return;
    }
    if (err.code === 'CONFLICT') {
      setBanner({ title: 'Changed by someone else', messages: [`${err.message} Press Esc and open the voucher again to see the latest version.`] });
      return;
    }
    setBanner({ title: err.code === 'LOCKED' ? 'Books are locked' : err.code === 'FORBIDDEN' ? 'Not allowed' : 'Could not save', messages: [userMessage(err)] });
    if (err.code === 'LOCKED') focusId(headerId('date'));
  };

  const doSave = async () => {
    if (busy) return;
    const f = formRef.current;
    const issues = checksFor(f, computeInvoiceTotals(f, totalsEnv).grandTotal);
    if (issues.first) {
      setCellErrors(issues.cells);
      setBanner(null);
      focusId(issues.first);
      return;
    }
    const built = buildVoucherInput(f);
    setCellErrors({});
    setBanner(null);
    setSaveWarnings(null);
    setBusy('save');
    try {
      const out = await withConfirmation(
        (ack) =>
          save.mutate({ ...built.input, acknowledgeWarnings: ack || undefined }).catch((err: unknown) => {
            // Translate the voucher warnings protocol for the shell's confirmation (info warnings stay inline).
            if (isApiError(err) && err.code === 'BUSINESS_RULE') {
              const req = confirmationRequest(err.details);
              if (req) {
                setSaveWarnings({ warnings: req.all, keys: built });
                throw new ApiError('BUSINESS_RULE', err.message, { needsConfirmation: true, warnings: req.confirm }, err.route);
              }
            }
            throw err;
          }),
        { title: 'Please check before saving', confirmLabel: 'Save anyway', cancelLabel: 'Go back' },
      );
      if (out === undefined) return;
      const infos = out.warnings.filter((w) => w.level === 'info');
      if (isAlter) {
        toast.success(`${typeName} ${out.number ?? ''} altered`.replace(/\s+/g, ' '), { message: infos.length > 0 ? infos.map((w) => w.message).join(' ') : undefined });
        dispatch({ type: 'load', form: { ...formRef.current, touched: false } });
        nav.pop({ id: out.id });
        return;
      }
      const saved: SavedVoucherRef = { id: out.id, number: out.number, typeName };
      const printNow = afterSavePrint(out.id, printAfterSave);
      toast.success(`${voucherRefLabel(saved)} saved`, {
        message: savedToastMessage(formatMoney(out.totals.grandTotal), infos.map((w) => w.message), printNow !== null, nav.isRegistered('print.voucher')),
        action: { label: 'View', onClick: () => nav.push('vouchers.view', { id: out.id }) },
      });
      setLastSaved(saved);
      setPreview(null);
      setSaveWarnings(null);
      if (f.docLinks) {
        // A converted document / recurring occurrence: back to the list it came from (it shows the result).
        dispatch({ type: 'load', form: { ...formRef.current, touched: false } });
        nav.pop({ id: out.id });
        return;
      }
      dispatch({ type: 'next', date: f.date, isOptional: ctx.voucherType.optionalByDefault, partyLedgerId: startParty });
      if (printNow) {
        nav.push('print.voucher', printNow);
        return;
      }
      requestAnimationFrame(() => focusStart());
    } catch (err) {
      handleSaveError(err, built);
    } finally {
      setBusy(null);
    }
  };
  const saveRef = useRef(doSave);
  saveRef.current = doSave;

  const askAccept = async () => {
    // Something obvious is missing: show it at once instead of asking "Accept?" first.
    if (checksFor(formRef.current, computeInvoiceTotals(formRef.current, totalsEnv).grandTotal).first) return saveRef.current();
    const ok = await confirm({ title: 'Accept this voucher?', message: summaryText(), confirmLabel: 'Accept', cancelLabel: 'Go back' });
    if (ok) await saveRef.current();
  };

  const summaryText = (): string => {
    const f = formRef.current;
    if (isInvoiceMode(f.mode)) return `${typeName} for ${docTotalText ?? `₹ ${formatMoney(invoice.grandTotal)}`}${party ? ` to ${party.name}` : ''}.`;
    if (f.mode === 'ledger') return `${typeName}: Dr ₹ ${formatMoney(ledgerTotals.debit)} = Cr ₹ ${formatMoney(ledgerTotals.credit || ledgerTotals.debit)}.`;
    return `${typeName} with ${f.items.filter((r) => !isBlankItem(r)).length} item line(s).`;
  };

  // ── Alteration actions ──
  const doDelete = async () => {
    if (!detail || busy) return;
    const ok = await confirm({
      title: `Delete ${detail.voucherType.name} ${detail.number ?? ''}?`.replace(/\s+\?/, '?'),
      message: 'The voucher and its GST entries are removed from the books. The number is not reused. To keep a record of it instead, cancel the voucher (Alt+X).',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      const out = await del.mutate({ id: detail.id, expectedUpdatedAt: detail.updatedAt });
      toast.success(`${detail.voucherType.name} ${out.number ?? ''} deleted`.replace(/\s+/g, ' '));
      dispatch({ type: 'load', form: { ...formRef.current, touched: false } });
      nav.pop();
    } catch (err) {
      setBanner({ title: 'Could not delete', messages: [userMessage(err)] });
    } finally {
      setBusy(null);
    }
  };
  const doCancel = async (reason: string) => {
    if (!detail) return;
    setBusy('cancel');
    setCancelError(null);
    try {
      const out = await cancelM.mutate({ id: detail.id, reason, expectedUpdatedAt: detail.updatedAt });
      toast.success(`${detail.voucherType.name} ${out.number ?? ''} cancelled`.replace(/\s+/g, ' '), { message: 'The number is kept and the amounts are removed from the books.' });
      setDialog(null);
      dispatch({ type: 'load', form: { ...formRef.current, touched: false } });
      nav.pop();
    } catch (err) {
      setCancelError(userMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // ── Type switching (new vouchers only) ──
  const switchType = async (target: { voucherTypeId?: number; baseType?: VoucherBaseType }) => {
    if (isAlter) return;
    // F8 inside a Sales voucher (or picking the same type in F10) keeps the voucher as it is.
    if (target.voucherTypeId === type.id || (target.baseType !== undefined && target.baseType === baseType)) return;
    if (target.baseType) {
      const a = shell.voucherAvailability(target.baseType);
      if (!a.ok) {
        toast.info(`${baseTypeLabel(target.baseType)} entry is not available`, { message: a.reason });
        return;
      }
    }
    if (formRef.current.touched && !(await confirm({ title: 'Discard this voucher?', message: 'What you have entered will be lost.', confirmLabel: 'Discard', tone: 'danger' }))) return;
    dispatch({ type: 'load', form: { ...formRef.current, touched: false } });
    nav.replace('vouchers.entry', { ...target, date: formRef.current.date });
  };

  // ── Modes / layouts ──
  const allowed = ctx.allowedModes;
  const altMode: VoucherMode | null =
    form.mode === 'item_invoice' ? (allowed.includes('accounting_invoice') ? 'accounting_invoice' : allowed.includes('inventory') ? 'inventory' : null) : form.mode === 'accounting_invoice' || form.mode === 'inventory' ? (allowed.includes('item_invoice') ? 'item_invoice' : null) : null;
  const canToggleLayout = form.mode === 'ledger' && singleEntryAccountSide(baseType) !== null;
  const toggleLayout = () => {
    if (!canToggleLayout) return;
    const target = form.layout === 'single' ? 'double' : 'single';
    const next = formReducer(form, { type: 'setLayout', layout: target });
    if (next === form) {
      toast.info('Stays in Dr/Cr layout', { message: 'Single entry needs exactly one cash or bank line on the account side.' });
      return;
    }
    dispatch({ type: 'setLayout', layout: target });
  };

  const trackKinds = useMemo(() => trackingKinds(baseType, features), [baseType, features]);

  const partyBillsOn = partyBillWise && isInvoiceMode(form.mode);
  const openBills = () => {
    const c = activeCell();
    if (c && c.section === 'ledgers' && form.mode === 'ledger') {
      const row = form.ledgers.find((r) => r.key === c.rowKey);
      if (row && row.ledgerId !== null && rowDetailNeeds(gridEnv, row.ledgerId).bills) return setDialog({ kind: 'bills', rowKey: row.key });
    }
    if (partyBillsOn) return setDialog({ kind: 'bills', rowKey: null });
    toast.info('No bill-wise details here', { message: 'Bill-wise details apply to parties that keep bills (customers and suppliers) when Bill-wise is on in Features (F11).' });
  };
  /** Alt+Y: the invoice currency / rate, or the foreign amount of the line the cursor is on (else the first such line). */
  const openForex = () => {
    if (isInvoiceMode(form.mode)) {
      if (partyCurrency) return setDialog({ kind: 'forex', rowKey: null });
      return toast.info('This invoice is in rupees', { message: 'An invoice is in a foreign currency when its party ledger is kept in one (Ledger › Currency).' });
    }
    const c = activeCell();
    const here = c && c.section === 'ledgers' ? form.ledgers.find((r) => r.key === c.rowKey) : undefined;
    const row = here && fx.currencyOfLedger(here.ledgerId) ? here : form.ledgers.find((r) => fx.currencyOfLedger(r.ledgerId));
    if (row && form.mode === 'ledger') return setDialog({ kind: 'forex', rowKey: row.key });
    toast.info('No foreign-currency line here', { message: 'Choose a ledger kept in a foreign currency (Ledger › Currency) — its amount and rate are asked for.' });
  };
  const openRowKind = (kind: 'cost' | 'instrument') => {
    const c = activeCell();
    if (c && c.section === 'ledgers') {
      const row = form.ledgers.find((r) => r.key === c.rowKey);
      if (row && row.ledgerId !== null) {
        const needs = rowDetailNeeds(gridEnv, row.ledgerId);
        if ((kind === 'cost' && needs.cost) || (kind === 'instrument' && needs.bank)) return setDialog({ kind, rowKey: row.key });
      }
    }
    if (kind === 'instrument' && form.layout === 'single' && form.accountLedgerId !== null) return setDialog({ kind: 'instrument', rowKey: ACCOUNT_ROW });
    toast.info(kind === 'cost' ? 'Move to a line with cost centres' : 'Move to a bank line', {
      message: kind === 'cost' ? 'Cost centres apply to ledgers set up for them (Features F11 › Cost centres).' : 'Bank details apply to bank account lines.',
    });
  };

  // ── Hotkeys not shown in the rail ──
  const switchKeys: Record<string, () => void> = {};
  if (!isAlter) for (const t of CTRL_KEYS_SWITCH) switchKeys[t.hotkey as string] = () => void switchType({ baseType: t.baseType });
  const hotkeys = {
    ...switchKeys,
    F2: () => focusId(headerId('date')),
    'Ctrl+D': () => {
      const c = activeCell();
      if (c) deleteRow(c.section, c.rowKey);
    },
    'Alt+N, Ctrl+N': () => insertRow(),
    'Alt+O': () => openRowKind('cost'),
    'Alt+K': () => openRowKind('instrument'),
    'Ctrl+B': form.mode === 'ledger' && form.layout === 'double' ? () => dispatch({ type: 'balanceLast' }) : undefined,
  };

  // ── Rail actions ──
  const isOrderOrNote = trackKinds.length > 0 && form.partyLedgerId !== null;
  const printTarget = entryPrintTarget(detail ? detail.id : null, lastSaved);
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+A', label: isAlter ? 'Save changes' : 'Accept', icon: 'save', primary: true, onClick: () => void doSave(), disabled: busy !== null },
    { key: 'F10', label: 'Voucher type', icon: 'invoice', onClick: () => setDialog({ kind: 'type' }), hidden: isAlter, group: 'type' },
    {
      key: 'Alt+I',
      label: altMode ? (altMode === 'accounting_invoice' ? 'Accounting invoice' : altMode === 'inventory' ? 'Stock only' : 'Item invoice') : 'Item invoice',
      icon: 'columns',
      onClick: () => altMode && dispatch({ type: 'setMode', mode: altMode }),
      hidden: altMode === null,
      group: 'type',
    },
    { key: 'Ctrl+H', label: form.layout === 'single' ? 'Dr/Cr layout' : 'Single entry', icon: 'list', onClick: toggleLayout, hidden: !canToggleLayout, group: 'type' },
    { key: 'Ctrl+I', label: 'More details', icon: 'more', onClick: () => setDialog({ kind: 'more' }), hidden: form.mode === 'ledger', group: 'details' },
    { key: 'Alt+T', label: 'From notes/orders', icon: 'link', onClick: () => setDialog({ kind: 'tracking' }), hidden: !isOrderOrNote || !itemsOn, group: 'details' },
    { key: 'Alt+B', label: 'Bill-wise', icon: 'receipt', onClick: openBills, hidden: !features.billWise, group: 'details' },
    // GST details (gst module): advance / refund / challan / advance adjustment / bill of entry / stat adjustment.
    { key: 'Alt+J', label: 'GST details', icon: 'gst', onClick: () => setDialog({ kind: 'gst' }), hidden: !ctx.company.gstEnabled || gstDetailsKinds(baseType, direction === 'outward').length === 0, group: 'details' },
    // Foreign currency (forex module): invoice currency & rate, or a line's foreign amount & rate.
    { key: 'Alt+Y', label: docForex ? 'Currency & rate' : 'Foreign amount', icon: 'rupee', onClick: openForex, hidden: !fx.enabled || !(form.mode === 'ledger' || isInvoiceMode(form.mode)), group: 'details' },
    { key: 'Ctrl+L', label: form.isOptional ? 'Make regular' : 'Make optional', icon: 'eye-off', onClick: () => dispatch({ type: 'patch', patch: { isOptional: !form.isOptional } }), group: 'status' },
    { key: 'Ctrl+T', label: form.isPostDated ? 'Not post-dated' : 'Post-dated', icon: 'clock', onClick: () => dispatch({ type: 'patch', patch: { isPostDated: !form.isPostDated } }), group: 'status' },
    { key: 'F12', label: 'Settings', icon: 'settings', onClick: () => setDialog({ kind: 'config' }), group: 'status' },
    {
      key: 'Alt+P',
      label: printTarget?.label ?? 'Print',
      icon: 'print',
      onClick: () => printTarget && nav.push('print.voucher', { id: printTarget.id }),
      hidden: printTarget === null || !nav.isRegistered('print.voucher'),
      hint: !isAlter && printTarget ? 'The voucher you just saved' : undefined,
      group: 'saved',
    },
    { key: 'Alt+2', label: 'Duplicate', icon: 'copy', onClick: () => detail && nav.push('vouchers.entry', { duplicateOf: detail.id }), hidden: !isAlter || !ctx.permissions.canCreate, group: 'saved' },
    {
      key: 'Alt+H',
      label: 'Edit history',
      icon: 'clock',
      onClick: () => detail && nav.push('security.audit', { entityType: 'voucher', entityId: detail.id, entityGuid: detail.guid, label: `${detail.voucherType.name} ${detail.number ?? ''}`.trim() }),
      hidden: !isAlter || !canAudit,
      group: 'saved',
    },
    { key: 'Alt+X', label: 'Cancel voucher', icon: 'x-circle', onClick: () => setDialog({ kind: 'cancel' }), hidden: !isAlter || !ctx.permissions.canAlter, group: 'danger' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void doDelete(), hidden: !isAlter || !ctx.permissions.canDelete, group: 'danger' },
  ];

  // ── Header ──
  const headerAdvance = useEnterAdvance<HTMLDivElement>({ onComplete: () => enterSection(sections[0], 'forward') });
  const setHeaderRef = useCallback(
    (el: HTMLDivElement | null) => {
      headerRef.current = el;
      headerAdvance(el);
    },
    [headerAdvance],
  );
  const posOptions = useMemo(() => stateOptions({ includeForeign: true }), []);
  const computedPos = invoice.computation?.placeOfSupply ?? null;
  const gstDoc = ctx.company.gstEnabled && isInvoiceMode(form.mode) && isGstBase(baseType);
  const supplierRef = baseType === 'purchase' || (baseType === 'debit_note' && direction === 'inward');
  const showRef = isInvoiceMode(form.mode) || form.mode === 'inventory' ? baseType !== 'stock_journal' && baseType !== 'physical_stock' : baseType === 'payment' || baseType === 'receipt';
  const isNoteDoc = (baseType === 'credit_note' || baseType === 'debit_note') && isInvoiceMode(form.mode);
  const dateHints: string[] = [];
  if (ctx.config.lockedUpTo && form.date <= ctx.config.lockedUpTo) dateHints.push(`Books are locked up to ${formatDate(ctx.config.lockedUpTo)}. Choose a later date.`);
  if (!ctx.permissions.canBackdate && form.date < ctx.today) dateHints.push('You can only enter vouchers dated today or later.');
  if (form.date > ctx.today && !form.isPostDated && postsToBooks(baseType)) dateHints.push('Future date — press Ctrl+T to mark it post-dated if the money moves later.');
  const numberEditable = numberingMethod === 'manual' || numberingMethod === 'automatic_override';
  const accountRow = form.accountLedgerId !== null ? ledgers.byId.get(form.accountLedgerId) : undefined;

  const header = (
    <div className="bx-vch-head" ref={setHeaderRef}>
      {numberingMethod !== 'none' ? (
        <Field label="No." htmlFor={headerId('number')} error={cellErrors[headerId('number')]} required={numberingMethod === 'manual' && !isAlter}>
          <TextInput
            id={headerId('number')}
            value={form.number}
            readOnly={!numberEditable}
            maxLength={50}
            placeholder={isAlter ? (detail?.number ?? '') : ctx.nextNumber || (numberingMethod === 'manual' ? 'Type the number' : '')}
            onValueChange={(s) => dispatch({ type: 'patch', patch: { number: s } })}
          />
        </Field>
      ) : null}
      <Field label="Date" htmlFor={headerId('date')} required error={cellErrors[headerId('date')]} hint={dateHints[0]}>
        <DateInput
          id={headerId('date')}
          value={form.date}
          referenceDate={working.date}
          minDate={ctx.company.booksFrom}
          showWeekday
          onChange={(d) => d && dispatch({ type: 'patch', patch: { date: d } })}
        />
      </Field>
      {baseType === 'quotation' || baseType === 'proforma' ? (
        <Field label="Valid until" htmlFor={headerId('validUntil')} optional error={cellErrors[headerId('validUntil')]} hint="Last date the offer holds">
          <DateInput id={headerId('validUntil')} value={form.validUntil} referenceDate={form.date} minDate={form.date} onChange={(d) => dispatch({ type: 'patch', patch: { validUntil: d } })} />
        </Field>
      ) : null}
      {baseType === 'reversing_journal' ? (
        <Field label="Applicable up to" htmlFor={headerId('applicableUpto')} optional error={cellErrors[headerId('applicableUpto')]} hint="Counts in scenario reports up to this date">
          <DateInput id={headerId('applicableUpto')} value={form.applicableUpto} referenceDate={form.date} minDate={form.date} onChange={(d) => dispatch({ type: 'patch', patch: { applicableUpto: d } })} />
        </Field>
      ) : null}
      {showRef ? (
        <>
          <Field label={supplierRef ? 'Supplier invoice no.' : 'Reference no.'} htmlFor={headerId('referenceNo')} required={referenceRequired} optional={!referenceRequired} error={cellErrors[headerId('referenceNo')]}>
            <TextInput id={headerId('referenceNo')} value={form.referenceNo} maxLength={50} onValueChange={(s) => dispatch({ type: 'patch', patch: { referenceNo: s } })} />
          </Field>
          <Field label={supplierRef ? 'Supplier invoice date' : 'Reference date'} htmlFor={headerId('referenceDate')} optional={!referenceRequired} error={cellErrors[headerId('referenceDate')]}>
            <DateInput id={headerId('referenceDate')} value={form.referenceDate} referenceDate={form.date} onChange={(d) => dispatch({ type: 'patch', patch: { referenceDate: d } })} />
          </Field>
        </>
      ) : null}
      {partyShown ? (
        <Field label={baseType === 'purchase' || direction === 'inward' ? "Supplier (party A/c)" : "Party A/c name"} htmlFor={headerId('party')} required error={cellErrors[headerId('party')]} className="bx-vch-head__wide">
          <LedgerCombo
            id={headerId('party')}
            rows={ledgers.rows}
            slot="party"
            baseType={baseType}
            direction={direction}
            value={form.partyLedgerId}
            invalid={!!cellErrors[headerId('party')]}
            onChange={(id) => dispatch({ type: 'patch', patch: { partyLedgerId: id, partyBills: null, party: null } })}
            onRefetch={ledgers.refetch}
          />
        </Field>
      ) : null}
      {form.mode === 'ledger' && form.layout === 'single' && singleEntryAccountSide(baseType) !== null ? (
        <Field
          label="Account"
          htmlFor={headerId('account')}
          required
          error={cellErrors[headerId('account')]}
          hint={accountRow ? `Current balance: ${formatDrCrText(accountRow.balance)}` : 'The cash or bank account the money goes through'}
          className="bx-vch-head__wide"
          labelAction={
            accountRow?.classes.includes('bank') ? (
              <Button size="sm" variant="link" tabIndex={-1} onClick={() => setDialog({ kind: 'instrument', rowKey: ACCOUNT_ROW })}>
                {form.accountInstrument ? 'Bank details ✓' : 'Bank details (Alt+K)'}
              </Button>
            ) : undefined
          }
        >
          <LedgerCombo
            id={headerId('account')}
            rows={ledgers.rows}
            slot="account"
            baseType={baseType}
            direction={direction}
            value={form.accountLedgerId}
            invalid={!!cellErrors[headerId('account')]}
            onChange={(id) => dispatch({ type: 'patch', patch: { accountLedgerId: id, accountInstrument: null } })}
            onRefetch={ledgers.refetch}
          />
        </Field>
      ) : null}
      {isNoteDoc ? (
        <>
          <Field label="Against invoice no." htmlFor={headerId('originalInvoiceNo')} optional error={cellErrors[headerId('originalInvoiceNo')]}>
            <TextInput id={headerId('originalInvoiceNo')} value={form.originalInvoiceNo} maxLength={50} onValueChange={(s) => dispatch({ type: 'patch', patch: { originalInvoiceNo: s } })} />
          </Field>
          <Field label="Invoice date" htmlFor={headerId('originalInvoiceDate')} optional>
            <DateInput id={headerId('originalInvoiceDate')} value={form.originalInvoiceDate} referenceDate={form.date} maxDate={form.date} onChange={(d) => dispatch({ type: 'patch', patch: { originalInvoiceDate: d } })} />
          </Field>
          <Field label="Reason" optional>
            <Select
              value={form.noteReason}
              placeholder="Choose a reason"
              options={(form.noteReason && !NOTE_REASONS.includes(form.noteReason) ? [...NOTE_REASONS, form.noteReason] : NOTE_REASONS).map((r) => ({ value: r, label: r }))}
              onChange={(r) => dispatch({ type: 'patch', patch: { noteReason: r } })}
            />
          </Field>
        </>
      ) : null}
      {gstDoc ? (
        <Field label="Place of supply" htmlFor={headerId('placeOfSupply')} error={cellErrors[headerId('placeOfSupply')]}>
          <Select
            id={headerId('placeOfSupply')}
            value={form.placeOfSupply}
            options={[{ value: '', label: computedPos ? `Automatic — ${posOptions.find((o) => o.value === computedPos)?.label ?? computedPos}` : 'Automatic' }, ...posOptions]}
            onChange={(v) => dispatch({ type: 'patch', patch: { placeOfSupply: v } })}
          />
        </Field>
      ) : null}
      {features.priceLevels && itemsOn && direction === 'outward' && priceLevels.length > 0 ? (
        <Field label="Price level" htmlFor={headerId('priceLevel')} optional>
          <Select
            id={headerId('priceLevel')}
            value={form.priceLevelId === null ? '' : String(form.priceLevelId)}
            options={[{ value: '', label: 'Item default prices' }, ...priceLevels.map((p) => ({ value: String(p.id), label: p.name }))]}
            onChange={(v) => dispatch({ type: 'patch', patch: { priceLevelId: v === '' ? null : Number(v) } })}
          />
        </Field>
      ) : null}
      {gstDoc && direction === 'inward' ? (
        <Field label="Reverse charge">
          <Switch checked={form.reverseCharge} onChange={(c) => dispatch({ type: 'patch', patch: { reverseCharge: c } })} />
        </Field>
      ) : null}
    </div>
  );

  // ── Body grids ──
  const ledgerAmountKind = form.mode === 'ledger' ? (form.layout === 'single' && singleEntryAccountSide(baseType) !== null ? 'magnitude' : 'signed') : 'invoice';
  const ledgerSlot = form.mode === 'ledger' ? 'particular' : 'invoiceLine';
  const ledgerSpan = 1 + ledgerCols.indexOf('amount');
  const ledgerTrailing = ledgerCols.length - ledgerCols.indexOf('amount');
  const diff = ledgerTotals.difference;
  const ledgerFooter =
    form.mode === 'ledger' ? (
      <>
        <TotalRow
          span={ledgerSpan}
          trailing={ledgerTrailing}
          label="Total"
          value={
            ledgerAmountKind === 'signed' ? (
              <span>
                Dr {formatMoney(ledgerTotals.debit)} · Cr {formatMoney(ledgerTotals.credit)}
              </span>
            ) : (
              ledgerTotals.debit
            )
          }
          tone="strong"
        />
        {ledgerAmountKind === 'signed' && diff !== 0 ? (
          <tr className="bx-vch-total is-diff">
            <td colSpan={ledgerSpan}>
              <span role="status">
                Difference: ₹ {formatMoney(Math.abs(diff))} {diff > 0 ? 'Dr' : 'Cr'} — Dr and Cr must be equal
              </span>
            </td>
            <td className="is-num">
              <Button size="sm" variant="secondary" shortcut="Ctrl+B" tabIndex={-1} onClick={() => dispatch({ type: 'balanceLast' })}>
                Balance it
              </Button>
            </td>
            <td colSpan={ledgerTrailing} />
          </tr>
        ) : null}
      </>
    ) : form.mode === 'accounting_invoice' ? (
      <TotalRow span={ledgerSpan} trailing={ledgerTrailing} label="Total of lines" value={form.ledgers.reduce((a, r) => a + (r.ledgerId === null ? 0 : (r.amount ?? 0)), 0)} />
    ) : undefined;

  const itemSpan = (cols: readonly string[]) => 1 + cols.indexOf('amount');
  const itemFooter = (rows: readonly ItemRow[]): ReactNode => {
    if (!itemCols.includes('amount')) return undefined;
    const value = rows.reduce((a, r) => (isBlankItem(r) ? a : a + itemLineValue(r)), 0);
    return <TotalRow span={itemSpan(itemCols)} trailing={itemCols.length - itemCols.indexOf('amount')} label={form.mode === 'item_invoice' ? 'Value of items' : 'Total'} value={value} />;
  };

  const grids: ReactNode[] = [];
  if (baseType === 'stock_journal') {
    grids.push(
      <div key="sj" className="bx-vch-sj">
        <ItemGrid
          title="Source (consumption)"
          caption="Source items going out"
          columns={itemCols}
          rows={itemsOf(form, true)}
          figures={invoice.lines}
          rowErrors={rowErrors}
          rowWarnings={rowWarnings}
          qtyLabel="Quantity"
          footer={<TotalRow span={itemSpan(itemCols)} trailing={itemCols.length - itemCols.indexOf('amount')} label="Total out" value={stockTotals.consumption} />}
        />
        <ItemGrid
          title="Destination (production)"
          caption="Destination items coming in"
          columns={itemCols}
          rows={itemsOf(form, false)}
          figures={invoice.lines}
          rowErrors={rowErrors}
          rowWarnings={rowWarnings}
          qtyLabel="Quantity"
          footer={<TotalRow span={itemSpan(itemCols)} trailing={itemCols.length - itemCols.indexOf('amount')} label="Total in" value={stockTotals.production} />}
        />
      </div>,
    );
  } else if (itemsOn) {
    grids.push(
      <ItemGrid
        key="items"
        caption="Item lines"
        columns={itemCols}
        rows={form.items}
        figures={invoice.lines}
        rowErrors={rowErrors}
        rowWarnings={rowWarnings}
        qtyLabel={qtyLabel(baseType)}
        footer={itemFooter(form.items)}
      />,
    );
  }
  if (form.mode !== 'inventory') {
    grids.push(
      <LedgerGrid
        key="ledgers"
        title={form.mode === 'item_invoice' ? 'Additional ledgers (freight, packing, discount — enter a discount as a minus amount)' : undefined}
        caption={form.mode === 'item_invoice' ? 'Additional ledgers' : form.mode === 'accounting_invoice' ? 'Invoice lines' : 'Particulars'}
        slot={ledgerSlot}
        amountKind={ledgerAmountKind}
        columns={ledgerCols}
        rows={form.ledgers}
        figures={invoice.lines}
        rowErrors={rowErrors}
        rowWarnings={rowWarnings}
        amountLabel={ledgerAmountKind === 'signed' ? 'Amount (Dr / Cr)' : 'Amount'}
        footer={ledgerFooter}
      />,
    );
  }

  // ── Side panels ──
  const serverTotal = preview && preview.form === form && preview.grandTotal !== null && isInvoiceMode(form.mode) ? preview.grandTotal : null;
  const sign = postsParty(baseType) ? partySign(baseType) : 1;
  const totalsPanel = isInvoiceMode(form.mode) ? (
    <TotalsPanel
      title={gstDoc ? 'Tax & totals' : 'Totals'}
      rows={breakupRows({ taxable: invoice.taxable, tax: taxBreakup(invoice.computation, ctx.company.stateCode), outside: invoice.outside, roundOff: invoice.roundOff, showTaxable: true })}
      total={invoice.grandTotal}
      totalLabel={postsParty(baseType) ? (sign > 0 ? 'Invoice total (receivable)' : 'Invoice total (payable)') : 'Total'}
      words
      notes={invoice.warnings}
      serverTotal={serverTotal}
      extra={
        invoice.computation && gstDoc ? (
          <p className="bx-vch-totals__meta">
            {invoice.computation.interState ? 'Inter-state (IGST)' : 'Within the state (CGST + SGST)'} · {natureLabel(invoice.computation.nature)}
            {invoice.computation.reverseCharge ? ' · Reverse charge' : ''}
          </p>
        ) : null
      }
    />
  ) : form.mode === 'ledger' ? (
    <TotalsPanel
      title="Totals"
      rows={[
        { key: 'dr', label: 'Debit', amount: ledgerTotals.debit },
        { key: 'cr', label: 'Credit', amount: ledgerTotals.credit },
      ]}
      total={ledgerTotals.debit}
      totalLabel={ledgerTotals.difference === 0 ? 'Voucher amount' : 'Not balanced yet'}
      words={ledgerTotals.difference === 0}
      notes={[]}
      serverTotal={null}
    />
  ) : (
    <TotalsPanel title="Totals" rows={[]} total={stockTotals.total} totalLabel={baseType === 'stock_journal' ? 'Value of production' : 'Value of goods'} words={false} notes={[]} serverTotal={null} />
  );

  // A foreign-currency invoice's form total is in that currency: the party effect uses the rupees of the last check.
  const partyEffect = isInvoiceMode(form.mode) && postsParty(baseType) ? sign * (docForex ? (serverTotal ?? 0) : invoice.grandTotal) : 0;
  const docTotalText = docForex && docCurrency ? formatForex(decodeForex(invoice.grandTotal), docCurrency.decimalPlaces, docCurrency.symbol) : null;
  const metaBadges = (
    <>
      <Badge tone="neutral">{MODE_LABEL[form.mode]}</Badge>
      {form.isOptional ? <Badge tone="warning">Optional — not in the books</Badge> : null}
      {form.gstDetails && gstDetailsSummary(form.gstDetails) ? <Badge tone="brand">GST: {gstDetailsSummary(form.gstDetails)}</Badge> : null}
      {form.isPostDated ? <Badge tone="info">Post-dated</Badge> : null}
      {docForex && docCurrency ? (
        <Badge tone="brand">
          In {docCurrency.isoCode ?? docCurrency.symbol} @ ₹{formatExchangeRate(docForex.rate)}
        </Badge>
      ) : null}
      {form.docLinks?.convertedFromId !== undefined ? <Badge tone="brand">Converts a {baseType === 'sales_order' ? 'quotation' : 'quotation / proforma'} — linked on save</Badge> : null}
      {form.docLinks?.recurring ? <Badge tone="brand">Recurring voucher · {form.docLinks.recurring.periodKey}</Badge> : null}
      {isAlter && detail?.irn.status ? <Badge tone="info">e-Invoice: {detail.irn.status}</Badge> : null}
    </>
  );

  const onFocusPath = (path: string) => {
    const f = formRef.current;
    const keys = (saveWarnings?.keys ?? preview?.keys ?? buildVoucherInput(f)) as KeyMaps;
    const t = targetOf(path, keys);
    if (t) focusId(t.id);
  };

  const title = `${typeName} ${isAlter ? 'Alteration' : 'Creation'}`;
  const subtitle = isAlter ? `No. ${detail?.number ?? '—'} · ${formatDate(detail?.date ?? form.date)}` : ctx.nextNumber ? `Next no. ${ctx.nextNumber}` : undefined;

  return (
    <GridEnvContext.Provider value={gridEnv}>
      <Screen
        title={title}
        subtitle={subtitle}
        icon="invoice"
        meta={metaBadges}
        dirty={form.touched}
        actions={actions}
        hint="Enter Next · Shift+Enter Back · Ctrl+A Accept · Alt+C Create master · Ctrl+D Delete line · Esc Back"
        toolbar={
          allowed.length > 1 && !isAlter ? (
            <SegmentedControl<VoucherMode>
              aria-label="Entry mode"
              size="sm"
              value={form.mode}
              options={allowed.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
              onChange={(m) => dispatch({ type: 'setMode', mode: m })}
            />
          ) : undefined
        }
        footer={
          <div className="bx-vch-foot">
            <span className="bx-vch-foot__sum bx-num">{docTotalText ? `Total ${docTotalText}` : summaryShort(form, invoice.grandTotal, ledgerTotals, stockTotals.total)}</span>
            <Button onClick={() => void nav.back()}>Back</Button>
            <Button variant="primary" shortcut="Ctrl+A" loading={busy === 'save'} onClick={() => void doSave()}>
              {isAlter ? 'Save changes' : 'Accept'}
            </Button>
          </div>
        }
      >
        <Hotkeys map={hotkeys} />
        <div className="bx-vch" data-density="compact">
          <div className="bx-vch__main">
            {banner ? <ErrorBanner title={banner.title} messages={banner.messages} onDismiss={() => setBanner(null)} /> : null}
            {header}
            <div className="bx-vch-body" onKeyDown={onGridKeyDown}>
              {grids}
            </div>
            <Field label="Narration" htmlFor={headerId('narration')} optional hint="Enter accepts the voucher · Shift+Enter goes back">
              <TextArea
                id={headerId('narration')}
                value={form.narration}
                maxLength={2000}
                autoGrow
                maxRows={4}
                onValueChange={(s) => dispatch({ type: 'patch', patch: { narration: s } })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) return;
                  e.preventDefault();
                  if (e.shiftKey) enterSection(neighbourSection(sections, 'narration', 'back'), 'back');
                  else void askAccept();
                }}
              />
            </Field>
          </div>
          <aside className="bx-vch__side" aria-label="Voucher summary">
            {partyShown ? (
              <PartyPanel
                party={party}
                loading={partyQ.loading && form.partyLedgerId !== null}
                voucherEffect={partyEffect}
                bills={form.partyBills}
                billWiseOn={features.billWise}
                onBills={partyBillsOn ? () => setDialog({ kind: 'bills', rowKey: null }) : undefined}
                onOpenLedger={party ? () => nav.push('reports.ledger', { ledgerId: party.ledgerId }) : undefined}
              />
            ) : null}
            {docForex ? null : totalsPanel}
            <ForexEntryPanel
              relevant={fx.enabled && (docForex !== null || form.ledgers.some((r) => fx.currencyOfLedger(r.ledgerId) !== undefined))}
              doc={docForex}
              docCurrency={docCurrency}
              formTotal={invoice.grandTotal}
              serverTotal={serverTotal}
              preview={preview?.form === form ? preview.forex : undefined}
              currencyOf={(id) => fx.currencyById(id)}
              checking={checking}
              onChange={busy === null ? openForex : undefined}
            />
            <TdsEntryPanel
              baseType={baseType}
              mode={form.mode}
              value={form.tds}
              preview={preview?.tds}
              checking={checking}
              readOnly={busy !== null}
              onChange={(tds) => dispatch({ type: 'patch', patch: { tds } })}
            />
            <ChecksPanel items={checkItems} checking={checking} onFocusPath={onFocusPath} />
            <p className="bx-vch-keys">
              <Kbd keys="Alt+C" /> new master · <Kbd keys="Ctrl+I" /> more details · <Kbd keys="F12" /> settings
            </p>
          </aside>
        </div>
        {renderDialog()}
      </Screen>
    </GridEnvContext.Provider>
  );

  /** (forex module) Foreign amount, rate and bill-wise split of a ledger-mode line. */
  function forexLineDialog(row: LedgerRow, cur: NonNullable<ReturnType<typeof fx.currencyOfLedger>>, done: () => void, cancel: () => void): ReactNode {
    const accSide = singleEntryAccountSide(baseType);
    const side: 'dr' | 'cr' = form.layout === 'single' && accSide ? (accSide === 'dr' ? 'cr' : 'dr') : row.amount !== null && row.amount !== 0 ? (row.amount > 0 ? 'dr' : 'cr') : row.side;
    const lr = row.ledgerId !== null ? ledgers.byId.get(row.ledgerId) : undefined;
    return (
      <ForexLineDialog
        ledgerId={row.ledgerId as number}
        ledgerName={lr?.name ?? 'Ledger'}
        currency={cur}
        side={side}
        baseType={baseType}
        date={form.date}
        excludeVoucherId={voucherId}
        billWise={row.ledgerId !== null && rowDetailNeeds(gridEnv, row.ledgerId).bills}
        initial={{ forexAmount: row.forexAmount ?? null, exchangeRate: row.exchangeRate ?? null, amount: row.amount, bills: row.bills }}
        voucherRate={form.forex && form.forex.currencyId === cur.id ? form.forex.rate : null}
        suggestedName={form.number || ctx.nextNumber}
        onAccept={(v) => {
          const signed = form.layout === 'single' && accSide ? v.amount : side === 'dr' ? v.amount : -v.amount;
          dispatch({ type: 'ledger', key: row.key, patch: { forexAmount: v.forexAmount, exchangeRate: v.exchangeRate, amount: signed, side, bills: v.bills } });
          done();
        }}
        onClose={cancel}
      />
    );
  }

  function renderDialog(): ReactNode {
    if (!dialog) return null;
    const close = () => {
      setDialog(null);
      afterDialog.current = null;
    };
    const closeThen = () => {
      const then = afterDialog.current;
      afterDialog.current = null;
      setDialog(null);
      if (then) requestAnimationFrame(then);
    };
    switch (dialog.kind) {
      case 'forex': {
        if (dialog.rowKey === null) {
          if (!partyCurrency) return null;
          return (
            <ForexInvoiceDialog
              currency={partyCurrency}
              date={form.date}
              baseType={baseType}
              value={form.forex ?? null}
              onAccept={(v) => {
                dispatch({ type: 'patch', patch: { forex: v } });
                closeThen();
              }}
              onClose={close}
            />
          );
        }
        const row = form.ledgers.find((r) => r.key === dialog.rowKey);
        const cur = row ? fx.currencyOfLedger(row.ledgerId) : undefined;
        if (!row || row.ledgerId === null || !cur) return null;
        return forexLineDialog(row, cur, closeThen, close);
      }
      case 'gst':
        return (
          <GstDetailsDialog
            baseType={baseType}
            outward={direction === 'outward'}
            date={form.date}
            partyLedgerId={form.partyLedgerId ?? party?.ledgerId ?? null}
            value={form.gstDetails}
            onApply={(gstDetails) => dispatch({ type: 'patch', patch: { gstDetails } })}
            onClose={close}
          />
        );
      case 'bills': {
        if (dialog.rowKey === null && party && docForex && docCurrency) {
          // (forex module) Party bills of an invoice in a foreign currency, in that currency.
          return (
            <ForexPartyBillsDialog
              ledgerId={party.ledgerId}
              ledgerName={party.name}
              currency={docCurrency}
              total={Math.abs(decodeForex(invoice.grandTotal))}
              side={sign > 0 ? 'dr' : 'cr'}
              date={form.date}
              excludeVoucherId={voucherId}
              initial={form.partyBills}
              suggestedName={(sign < 0 && baseType === 'purchase' ? form.referenceNo : '') || form.number || ctx.nextNumber}
              onAccept={(bills) => {
                dispatch({ type: 'patch', patch: { partyBills: bills } });
                closeThen();
              }}
              onClose={close}
            />
          );
        }
        if (dialog.rowKey !== null) {
          const fxRow = form.ledgers.find((r) => r.key === dialog.rowKey);
          const fxCur = fxRow && form.mode === 'ledger' ? fx.currencyOfLedger(fxRow.ledgerId) : undefined;
          // (forex module) Bills of a line kept in a foreign currency are split in that currency (an
          // exchange adjustment in rupees only keeps the rupee bill-wise dialog).
          if (fxRow && fxCur && fxRow.forexAmount !== 0) return forexLineDialog(fxRow, fxCur, closeThen, close);
        }
        if (dialog.rowKey === null) {
          if (!party) return null;
          const purchaseSide = sign < 0;
          return (
            <BillsDialog
              ledgerId={party.ledgerId}
              ledgerName={party.name}
              amount={invoice.grandTotal}
              side={sign > 0 ? 'dr' : 'cr'}
              date={form.date}
              excludeVoucherId={voucherId}
              initial={form.partyBills}
              suggestedName={(purchaseSide && baseType === 'purchase' ? form.referenceNo : '') || form.number || ctx.nextNumber}
              creditDays={party.creditDays}
              allowDefault
              onAccept={(bills) => {
                dispatch({ type: 'patch', patch: { partyBills: bills } });
                closeThen();
              }}
              onClose={close}
            />
          );
        }
        const row = form.ledgers.find((r) => r.key === dialog.rowKey);
        if (!row || row.ledgerId === null) return null;
        const lr = ledgers.byId.get(row.ledgerId);
        const amount = Math.abs(row.amount ?? 0);
        const accSide = singleEntryAccountSide(baseType);
        const rowSide: 'dr' | 'cr' = form.layout === 'single' && accSide ? (accSide === 'dr' ? 'cr' : 'dr') : (row.amount ?? 0) >= 0 ? 'dr' : 'cr';
        return (
          <BillsDialog
            ledgerId={row.ledgerId}
            ledgerName={lr?.name ?? 'Ledger'}
            amount={amount}
            side={rowSide}
            date={form.date}
            excludeVoucherId={voucherId}
            initial={row.bills}
            suggestedName={form.number || ctx.nextNumber}
            creditDays={ledgerDetails.get(row.ledgerId)?.defaultCreditDays ?? null}
            onAccept={(bills) => {
              dispatch({ type: 'ledger', key: row.key, patch: { bills: bills && allocationTotal(bills) > 0 ? bills : null } });
              closeThen();
            }}
            onClose={close}
          />
        );
      }
      case 'cost': {
        const row = form.ledgers.find((r) => r.key === dialog.rowKey);
        if (!row || row.ledgerId === null) return null;
        return (
          <CostDialog
            ledgerName={ledgers.byId.get(row.ledgerId)?.name ?? 'Ledger'}
            amount={Math.abs(row.amount ?? 0)}
            initial={row.costs}
            onAccept={(costs) => {
              dispatch({ type: 'ledger', key: row.key, patch: { costs } });
              closeThen();
            }}
            onClose={close}
          />
        );
      }
      case 'instrument': {
        if (dialog.rowKey === ACCOUNT_ROW) {
          return (
            <InstrumentDialog
              ledgerName={accountRow?.name ?? 'Bank'}
              date={form.date}
              initial={form.accountInstrument}
              onAccept={(instrument) => {
                dispatch({ type: 'patch', patch: { accountInstrument: instrument } });
                closeThen();
              }}
              onClose={close}
            />
          );
        }
        const row = form.ledgers.find((r) => r.key === dialog.rowKey);
        if (!row || row.ledgerId === null) return null;
        return (
          <InstrumentDialog
            ledgerName={ledgers.byId.get(row.ledgerId)?.name ?? 'Bank'}
            date={form.date}
            initial={row.instrument}
            onAccept={(instrument) => {
              dispatch({ type: 'ledger', key: row.key, patch: { instrument } });
              closeThen();
            }}
            onClose={close}
          />
        );
      }
      case 'more': {
        const value: MoreDetailsValue = {
          party: form.party,
          consignee: form.consignee,
          dispatch: form.dispatch,
          orderDetails: form.orderDetails,
          exportDetails: form.exportDetails,
          effectiveDate: form.effectiveDate,
        };
        return (
          <MoreDetailsDialog
            value={value}
            date={form.date}
            partyName={party?.name ?? ''}
            showEffectiveDate={ctx.voucherType.useEffectiveDate}
            showExport={direction === 'outward' && isInvoiceMode(form.mode)}
            showEway={features.ewayBill}
            onAccept={(v) => {
              dispatch({ type: 'patch', patch: v });
              close();
            }}
            onClose={close}
          />
        );
      }
      case 'tracking': {
        if (form.partyLedgerId === null) return null;
        const used = [...new Set(form.items.flatMap((r) => [r.trackingRef, r.orderRef]).filter(Boolean))];
        return (
          <TrackingDialog
            partyLedgerId={form.partyLedgerId}
            kinds={trackKinds}
            excludeVoucherId={voucherId}
            usedRefs={used}
            onAccept={(picked: Array<{ doc: TrackingDoc; kind: TrackingKind }>) => {
              const rows = picked.flatMap((p) => rowsFromTrackingDoc(p.doc, p.kind));
              if (rows.length > 0) dispatch({ type: 'itemsAppend', rows });
              close();
              toast.success(`${rows.length} line${rows.length === 1 ? '' : 's'} added`);
            }}
            onClose={close}
          />
        );
      }
      case 'type':
        return (
          <TypeSwitchDialog
            types={types}
            currentId={type.id}
            isAvailable={(b) => shell.voucherAvailability(b).ok}
            onPick={(t) => {
              close();
              void switchType({ voucherTypeId: t.id });
            }}
            onClose={close}
          />
        );
      case 'config':
        return <ConfigHintsDialog ctx={ctx} onClose={close} />;
      case 'cancel':
        return detail ? (
          <ReasonDialog
            title={`Cancel ${detail.voucherType.name} ${detail.number ?? ''}?`.replace(/\s+\?/, '?')}
            message="The voucher keeps its number (so GST invoice numbering stays continuous) but its amounts leave the books and stock. This cannot be undone."
            confirmLabel="Cancel voucher"
            required
            busy={busy === 'cancel'}
            error={cancelError}
            onConfirm={(r) => void doCancel(r)}
            onClose={close}
          />
        ) : null;
      default:
        return null;
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const NOTE_REASONS = ['Sales return', 'Post-sale discount', 'Deficiency in services', 'Correction in invoice', 'Change in place of supply', 'Finalisation of provisional assessment', 'Others'];

/** Base types whose party is posted (invoices and notes) — not orders or stock documents. */
function postsParty(b: VoucherBaseType): boolean {
  return b === 'sales' || b === 'purchase' || b === 'credit_note' || b === 'debit_note';
}

function formatDrCrText(p: number): string {
  if (p === 0) return '₹ 0.00';
  return `₹ ${formatMoney(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`;
}

const NATURE_LABEL: Readonly<Record<string, string>> = {
  b2b: 'B2B',
  b2cl: 'B2C large',
  b2cs: 'B2C small',
  export_wp: 'Export with IGST',
  export_wop: 'Export under LUT',
  sez_wp: 'SEZ with IGST',
  sez_wop: 'SEZ under LUT',
  deemed_export: 'Deemed export',
  nil_exempt: 'Nil / exempt',
  non_gst: 'Non-GST',
};

function natureLabel(n: string): string {
  return NATURE_LABEL[n] ?? n.replace(/_/g, ' ');
}

function summaryShort(f: VoucherForm, grand: number, l: { debit: number; credit: number; difference: number }, stock: number): string {
  if (f.mode === 'item_invoice' || f.mode === 'accounting_invoice') return `Total ₹ ${formatMoney(grand)}`;
  if (f.mode === 'ledger') return l.difference === 0 ? `Dr = Cr ₹ ${formatMoney(l.debit)}` : `Dr ₹ ${formatMoney(l.debit)} · Cr ₹ ${formatMoney(l.credit)} · difference ₹ ${formatMoney(Math.abs(l.difference))}`;
  return `Value ₹ ${formatMoney(stock)}`;
}
