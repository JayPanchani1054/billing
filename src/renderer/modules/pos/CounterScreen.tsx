/**
 * 'pos.counter' { voucherTypeId?, id?, exchange? } — the POS counter: a Sales voucher of a POS type
 * (voucher_types.config.posInvoice) entered for speed.
 *
 *  - Scan box (always focused): a barcode scanner types the code + Enter; `3*code` adds three; the
 *    same item again adds to its line. Item code / part no. / alias / exact name work too; anything
 *    else opens Find item (Alt+F). ↑ ↓ pick a line, + / − change its quantity, Enter on an empty box
 *    goes to payment.
 *  - Lines: qty × price-level rate − discount, MRP and its value; the total is big and live (the
 *    posting engine's preview, so it is exactly what will be saved, GST and round-off included).
 *  - Customer (Alt+U): walk-in by default (paid in full); a customer found or created by mobile may
 *    take part on account. Place of supply: the counter's state (goods handed over at the counter,
 *    IGST Act s.10(1)(a)); "delivered to the customer" uses their state.
 *  - Payment (Ctrl+A or Enter on an empty scan box): split across tender modes, cash handed over and
 *    change; saved as ONE voucher (vouchers.save with posBill), then the receipt prints and a fresh
 *    bill starts. Hold (Alt+O) / recall (Alt+L), reprint last (Alt+P), return / exchange (Alt+T).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { stateLabel } from '../../../shared/gst/states.ts';
import { formatMoney, formatQty, formatRate } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { PosContext, PosHeldBill, PosItem } from '../../../shared/types/pos.ts';
import type { VoucherPreview } from '../../../shared/types/vouchers.ts';
import {
  api,
  invalidate,
  Screen,
  useApiQuery,
  useConfirm,
  useFeatures,
  useNav,
  userMessage,
  useWorkingDate,
  withConfirmation,
  type ScreenProps,
} from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, Inline, Spinner, Stack, Switch, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { CandidatesDialog, CustomerDialog, FindItemDialog, HeldBillsDialog, LineDialog, PosOff, TenderDialog, type CounterCustomer } from './components.tsx';
import { addScanned, buildBillInput, deliveryFromDraft, lineMrp, lineValue, linesFromDraft, parseScan, removeLine, setBatch, setPrice, setQty, stepQty, toDraft, totalQty, type CartLine, type ParsedScan } from './lib/cart.ts';
import { counterName, setCounterName } from './lib/counter.ts';
import { billBlockers, initialTenders, summarizeTenders, tendersFromSaved, toPosBill, type TenderState } from './lib/tender.ts';
import { useReceiptPrinter } from './ReceiptPrinter.tsx';

export interface CounterParams {
  voucherTypeId?: number;
  /** Alter a saved POS bill. */
  id?: number;
  /** Start a bill paid (partly) by exchange credit of this return (from the return screen). */
  exchange?: { voucherId: number; amount: number };
}

/** Everything a voucher save can change elsewhere (as the voucher entry screen invalidates) + POS. */
const SAVE_INVALIDATES = ['vouchers', 'reports', 'gst', 'gstrecon', 'outstanding', 'stock', 'banking', 'dashboard', 'accounts', 'inventory', 'print', 'documents', 'tds', 'pos'];

const rupees = (p: Paise): string => `₹ ${formatMoney(p)}`;

interface LastBill {
  id: number;
  number: string | null;
  total: Paise;
  change: Paise;
  credit: Paise;
}

export function CounterScreen({ params }: ScreenProps<CounterParams>) {
  const features = useFeatures();
  const ctxQ = useApiQuery('pos.context', {}, { staleTime: 0 });
  if (!features.pos) return <PosOff title="POS Counter" />;
  const ctx = ctxQ.data;
  if (!ctx) return <Screen title="POS Counter" icon="cart" loading={!ctxQ.error} error={ctxQ.error} onRetry={() => void ctxQ.refetch()} />;
  return <Counter ctx={ctx} params={params ?? {}} />;
}

function Counter({ ctx, params }: { ctx: PosContext; params: CounterParams }) {
  const nav = useNav();
  const toast = useToast();
  const { date } = useWorkingDate();
  const printer = useReceiptPrinter();
  const confirm = useConfirm();
  const altering = params.id !== undefined;
  const detailQ = useApiQuery('vouchers.get', { id: params.id ?? 0 }, { enabled: altering, staleTime: 0 });

  const [typeId, setTypeId] = useState<number | null>(params.voucherTypeId ?? ctx.saleVoucherTypeId);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [sel, setSel] = useState(0);
  const [customer, setCustomer] = useState<CounterCustomer | null>(null);
  const [deliverToCustomer, setDeliverToCustomer] = useState(false);
  const [scan, setScan] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [counter, setCounter] = useState(counterName);
  const [heldId, setHeldId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'customer' | 'line' | 'held' | 'find' | 'pay' | null>(null);
  const [findText, setFindText] = useState('');
  const [findQty, setFindQty] = useState(1);
  const [candidates, setCandidates] = useState<{ code: string; qty: number; list: Array<{ itemId: number; name: string; matchedBy: PosItem['matchedBy'] }> } | null>(null);
  const [tender, setTender] = useState<TenderState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [last, setLast] = useState<LastBill | null>(null);
  const [loadedFrom, setLoadedFrom] = useState<number | null>(null);
  // Exchange credit brought from the return screen: offered on the first bill only.
  const [exchange, setExchange] = useState<CounterParams['exchange'] | null>(params.exchange ?? null);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const focusScan = useCallback(() => requestAnimationFrame(() => scanRef.current?.focus()), []);

  const walkInId = ctx.walkIn?.id ?? null;
  const partyId = customer?.ledgerId ?? walkInId;
  const walkIn = customer === null;
  const priceLevelId = ctx.priceLevel?.id ?? null;
  const godownId = ctx.godown?.id ?? null;
  const placeOfSupply = deliverToCustomer && customer?.stateCode ? customer.stateCode : ctx.companyStateCode;

  // Alteration: the saved bill comes back on the counter with its prices and customer.
  const detail = altering ? detailQ.data : undefined;
  useEffect(() => {
    if (!detail || loadedFrom === detail.id) return;
    setLoadedFrom(detail.id);
    setTypeId(detail.voucherType.id);
    const items = detail.input.items ?? [];
    void Promise.all([...new Set(items.map((i) => i.itemId))].map((itemId) => api('pos.item.get', { itemId, date: detail.date, ...(priceLevelId ? { priceLevelId } : {}) }).catch(() => null))).then((found) => {
      const map = new Map<number, PosItem>(found.filter((x): x is PosItem => x !== null).map((x) => [x.itemId, x]));
      const back = linesFromDraft({ lines: items.map((i) => ({ itemId: i.itemId, qty: i.billedQty ?? i.qty, rate: i.rate, discountPct: i.discountPct, batchName: i.batchName })) }, map);
      setLines(back.lines);
    });
    if (detail.partyLedgerId !== null && detail.partyLedgerId !== walkInId) {
      setCustomer({ ledgerId: detail.partyLedgerId, name: detail.party.name ?? detail.partyLedgerName ?? '', mobile: null, stateCode: detail.party.stateCode, gstin: detail.party.gstin });
      setDeliverToCustomer(detail.placeOfSupply !== null && detail.placeOfSupply !== ctx.companyStateCode);
    }
    if (detail.input.posBill?.counter) setCounter(detail.input.posBill.counter);
  }, [detail, loadedFrom, priceLevelId, walkInId, ctx.companyStateCode]);

  // Ask for the customer first (POS settings) on a fresh bill.
  useEffect(() => {
    if (ctx.settings.askCustomerFirst && !altering) setDialog('customer');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live total: the engine's own preview of exactly this bill (debounced while scanning).
  const header = useMemo(
    () =>
      typeId !== null && partyId !== null
        ? { voucherTypeId: typeId, date: altering && detail ? detail.date : date, partyLedgerId: partyId, placeOfSupply, priceLevelId, godownId, ...(altering && detail ? { id: detail.id, expectedUpdatedAt: detail.updatedAt } : {}) }
        : null,
    [typeId, partyId, placeOfSupply, priceLevelId, godownId, date, altering, detail],
  );
  const previewInput = useMemo(() => {
    if (!header || lines.length === 0) return null;
    // Previewed with an empty POS block: the bill's own pos checks (Rule 46(e) reminder; on an alteration
    // the returns already made against it) show while the payment-only ones wait for the payment dialog.
    // An alteration must send the block, or the engine would re-attach the saved tenders.
    const { id: _id, expectedUpdatedAt: _e, ...plain } = buildBillInput(header, lines, { tenders: [] });
    return altering && detail ? { ...plain, id: detail.id } : plain;
  }, [header, lines, altering, detail]);
  const debounced = useDebouncedValue(previewInput, 120);
  const previewQ = useApiQuery('vouchers.preview', debounced ?? { voucherTypeId: 0, date, mode: 'item_invoice' as const }, { enabled: debounced !== null, keepPrevious: true, staleTime: 0 });
  const preview: VoucherPreview | undefined = lines.length > 0 ? previewQ.data : undefined;
  const settled = previewInput !== null && debounced === previewInput && !previewQ.isPrevious && !previewQ.refreshing;
  const total = preview?.totals.grandTotal ?? 0;
  const blocking = billBlockers(preview?.warnings ?? []);
  const notices = (preview?.warnings ?? []).filter((w) => !w.blocking && w.level === 'confirm');
  const mrpTotal = lines.reduce((a, l) => a + (lineMrp(l) ?? 0), 0);
  const mrpSaving = mrpTotal > 0 && preview ? Math.max(0, lines.reduce((a, l, i) => a + (l.mrp !== null ? (lineMrp(l) ?? 0) - chargedOf(preview, i, l) : 0), 0)) : 0;

  const reset = useCallback(() => {
    setLines([]);
    setSel(0);
    setCustomer(null);
    setDeliverToCustomer(false);
    setTender(null);
    setSaveError(null);
    setHeldId(null);
    setScan('');
  }, []);

  // ── Scan / add ──
  // Lines as of the latest change (scans arrive faster than renders; each scan builds on the last).
  const linesRef = useRef<CartLine[]>(lines);
  linesRef.current = lines;
  const addItem = useCallback(
    (item: PosItem, qty: number) => {
      const r = addScanned(linesRef.current, item, qty);
      linesRef.current = r.lines;
      setLines(r.lines);
      setSel(r.index);
      const onBill = r.lines[r.index]?.qty ?? qty;
      if (item.stock !== null && item.stock - onBill < 0) toast.warning(`${item.name}: only ${formatQty(Math.max(0, item.stock), item.unitDecimals, item.unit)} in stock`);
    },
    [toast],
  );
  const addById = useCallback(
    async (itemId: number, qty: number) => {
      try {
        const item = await api('pos.item.get', { itemId, date, ...(priceLevelId ? { priceLevelId } : {}), ...(godownId ? { godownId } : {}) });
        addItem(item, qty);
      } catch (err) {
        toast.error('Could not add the item', { message: userMessage(err) });
      }
      focusScan();
    },
    [addItem, date, priceLevelId, godownId, toast, focusScan],
  );

  const openPayment = useCallback(() => {
    if (lines.length === 0) return void toast.info('Scan an item first');
    if (!settled || !preview) return void toast.info('Working out the total…', { message: 'Press Enter again in a moment.' });
    if (blocking.length > 0) return void toast.error('The bill cannot be saved yet', { message: blocking[0].message });
    const exchangeMode = ctx.tenderModes.find((m) => m.kind === 'exchange');
    const ex = exchange && exchangeMode ? { modeId: exchangeMode.id, name: exchangeMode.name, voucherId: exchange.voucherId, amount: exchange.amount } : undefined;
    const saved = altering ? detail?.input.posBill : undefined;
    setTender(saved && saved.tenders.length > 0 ? tendersFromSaved(ctx.tenderModes, saved) : initialTenders(ctx.tenderModes, total, ex));
    setSaveError(null);
    setDialog('pay');
  }, [lines.length, settled, preview, blocking, ctx.tenderModes, exchange, total, toast, altering, detail]);

  const onScanKey = async (e: KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, Math.min(lines.length - 1, s + (e.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if ((e.key === '+' || e.key === '-') && scan === '' && lines[sel]) {
      e.preventDefault();
      setLines((cur) => stepQty(cur, sel, e.key === '+' ? 1 : -1));
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const parsed = parseScan(scan);
    if (!parsed) {
      if (!scanRunning.current) openPayment();
      return;
    }
    // A scanner may send the next code before the last lookup returns: queue, never drop.
    setScan('');
    scanQueue.current.push(parsed);
    void drainScans();
  };
  const scanQueue = useRef<ParsedScan[]>([]);
  const scanRunning = useRef(false);
  const drainScans = async (): Promise<void> => {
    if (scanRunning.current) return;
    scanRunning.current = true;
    setScanBusy(true);
    try {
      for (let next = scanQueue.current.shift(); next; next = scanQueue.current.shift()) {
        try {
          const r = await api('pos.item.lookup', { code: next.code, date, ...(priceLevelId ? { priceLevelId } : {}), ...(godownId ? { godownId } : {}) });
          if (r.item) addItem(r.item, next.qty);
          else if (r.candidates.length > 0) setCandidates({ code: next.code, qty: next.qty, list: r.candidates });
          else {
            setFindText(next.code);
            setFindQty(next.qty);
            setDialog('find');
          }
        } catch (err) {
          toast.error(`Could not look up “${next.code}”`, { message: userMessage(err) });
        }
      }
    } finally {
      scanRunning.current = false;
      setScanBusy(false);
    }
  };

  // ── Save ──
  const save = async (): Promise<void> => {
    if (!header || !tender || saving) return;
    const summary = summarizeTenders(tender, total, { walkIn });
    if (!summary.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = buildBillInput(header, lines, toPosBill(tender, { counter }));
      const saved = await withConfirmation((ack) => api('vouchers.save', { ...input, ...(ack ? { acknowledgeWarnings: true } : {}) }));
      if (!saved) return;
      for (const p of SAVE_INVALIDATES) invalidate(p);
      if (heldId !== null) {
        // The bill came from the hold list: it is billed now (recall already removed it; nothing left to do).
        setHeldId(null);
      }
      setLast({ id: saved.id, number: saved.number, total: saved.totals.grandTotal, change: summary.change, credit: summary.credit });
      if (ctx.settings.printAfterSave) printer.print(saved.id);
      toast.success(`Bill ${saved.number ?? ''} saved`.replace(/\s+/g, ' '), {
        message: [rupees(saved.totals.grandTotal), summary.change > 0 ? `Change ${rupees(summary.change)}` : null, summary.credit > 0 ? `${rupees(summary.credit)} on account` : null, 'Alt+P Reprint']
          .filter(Boolean)
          .join(' · '),
      });
      setDialog(null);
      if (altering) {
        nav.pop();
        return;
      }
      setExchange(null);
      reset();
      if (ctx.settings.askCustomerFirst) setDialog('customer');
      else focusScan();
    } catch (err) {
      setSaveError(userMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Hold / recall ──
  const hold = async (): Promise<void> => {
    if (lines.length === 0 || typeId === null) return void toast.info('There is nothing to hold');
    try {
      const h = await api('pos.held.save', { total, draft: toDraft(typeId, lines, customer ? { ledgerId: customer.ledgerId, name: customer.name, mobile: customer.mobile } : null, placeOfSupply) });
      toast.success(`Bill held: ${h.label}`, { message: 'Alt+L recalls it.' });
      reset();
      focusScan();
    } catch (err) {
      toast.error('Could not hold the bill', { message: userMessage(err) });
    }
  };
  const recall = async (h: PosHeldBill): Promise<void> => {
    if (lines.length > 0) {
      toast.info('Finish or hold the current bill first', { message: 'Alt+O holds it.' });
      return;
    }
    try {
      const bill = await api('pos.held.recall', { id: h.id });
      const ids = [...new Set(bill.draft.lines.map((l) => l.itemId))];
      const found = await Promise.all(ids.map((itemId) => api('pos.item.get', { itemId, date, ...(priceLevelId ? { priceLevelId } : {}), ...(godownId ? { godownId } : {}) }).catch(() => null)));
      const map = new Map<number, PosItem>(found.filter((x): x is PosItem => x !== null).map((x) => [x.itemId, x]));
      const back = linesFromDraft(bill.draft, map);
      setTypeId(bill.draft.voucherTypeId);
      setLines(back.lines);
      setSel(0);
      setHeldId(bill.id);
      if (bill.draft.partyLedgerId !== undefined && bill.draft.partyLedgerId !== walkInId) {
        // Keep the place of supply it was held with (goods delivered to the customer → their state, IGST).
        const delivery = deliveryFromDraft(bill.draft, ctx.companyStateCode, walkInId);
        setCustomer({ ledgerId: bill.draft.partyLedgerId, name: bill.draft.customerName ?? '', mobile: bill.draft.customerMobile ?? null, stateCode: delivery.stateCode, gstin: null });
        setDeliverToCustomer(delivery.deliver);
      }
      if (back.missing.length > 0) toast.warning(`${back.missing.length} item(s) of the held bill no longer exist and were left out`);
      setDialog(null);
      focusScan();
    } catch (err) {
      toast.error('Could not recall the bill', { message: userMessage(err) });
    }
  };

  const current = lines[sel] ?? null;
  const dirty = lines.length > 0;
  const typeName = ctx.saleTypes.find((t) => t.id === typeId)?.name ?? 'POS Sales';
  const columns = useMemo<Column<CartLine>[]>(
    () => [
      { key: 'no', header: '#', width: 40, value: (l) => lines.indexOf(l) + 1 },
      {
        key: 'name',
        header: 'Item',
        minWidth: 200,
        render: (l) => (
          <span>
            {l.name}
            {l.batchName ? <span className="bx-muted"> · Batch {l.batchName}</span> : l.maintainBatches ? <Badge size="sm" tone="warning">batch?</Badge> : null}
            {l.priceEdited ? <span className="bx-muted"> · price set</span> : null}
          </span>
        ),
      },
      { key: 'qty', header: 'Qty', width: 110, align: 'right', value: (l) => l.qty, render: (l) => <span className="bx-num">{formatQty(l.qty, l.unitDecimals, l.unit)}</span> },
      { key: 'rate', header: 'Rate', width: 100, align: 'right', value: (l) => l.rate, render: (l) => <span className="bx-num">{formatRate(l.rate)}</span> },
      { key: 'disc', header: 'Disc %', width: 70, align: 'right', value: (l) => l.discountPct, render: (l) => (l.discountPct ? <span className="bx-num">{l.discountPct}</span> : null) },
      { key: 'mrp', header: 'MRP', width: 90, align: 'right', value: (l) => l.mrp ?? 0, render: (l) => (l.mrp !== null ? <span className="bx-num">{formatMoney(l.mrp)}</span> : null) },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 120, value: (l) => lineValue(l) },
    ],
    [lines],
  );

  if (typeId === null) {
    return (
      <Screen title="POS Counter" icon="cart" hint="Esc Back">
        <Banner tone="warning" title="No POS voucher type">
          Mark a Sales voucher type “Use as POS invoice” under Masters › Voucher Types (turning POS invoicing on creates “POS Sales”).
        </Banner>
      </Screen>
    );
  }

  return (
    <Screen
      title={altering ? `${typeName} Alteration` : 'POS Counter'}
      subtitle={`${typeName}${counter ? ` · ${counter}` : ''}${ctx.priceLevel ? ` · ${ctx.priceLevel.name} prices` : ''}`}
      icon="cart"
      dirty={dirty}
      loading={altering && detailQ.loading}
      error={altering ? detailQ.error : undefined}
      hint="Enter Add item / pay · Up/Down Line · +/− Quantity · Ctrl+A Payment · Alt+U Customer · Alt+O Hold · Alt+L Held bills · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Payment', icon: 'rupee', primary: true, onClick: openPayment, disabled: lines.length === 0 || !ctx.can.bill },
        { key: 'Alt+U', label: 'Customer', icon: 'user', onClick: () => setDialog('customer') },
        { key: 'Alt+Q', label: 'Quantity / price', icon: 'edit', onClick: () => setDialog('line'), disabled: !current, group: 'line' },
        {
          key: 'Ctrl+D',
          label: 'Remove line',
          icon: 'trash',
          onClick: () => {
            setLines((cur) => removeLine(cur, sel));
            setSel((x) => Math.max(0, Math.min(x, lines.length - 2)));
          },
          disabled: !current,
          group: 'line',
        },
        { key: 'Alt+F', label: 'Find item', icon: 'search', onClick: () => setDialog('find'), group: 'line' },
        { key: 'Alt+M', label: 'Item master', icon: 'box', onClick: () => current && nav.push('inventory.item.form', { id: current.itemId }), disabled: !current, group: 'line' },
        { key: 'Alt+O', label: 'Hold bill', icon: 'clock', onClick: () => void hold(), disabled: lines.length === 0 || altering, group: 'bill' },
        { key: 'Alt+L', label: 'Held bills', icon: 'list', onClick: () => setDialog('held'), disabled: altering, group: 'bill' },
        { key: 'Alt+Z', label: 'Clear bill', icon: 'close', onClick: () => void clearBill(), disabled: lines.length === 0 || altering, group: 'bill' },
        { key: 'Alt+P', label: last ? `Reprint ${last.number ?? 'last bill'}` : 'Reprint last bill', icon: 'print', onClick: () => last && printer.print(last.id), disabled: !last || printer.busy, group: 'last' },
        { key: 'Alt+V', label: 'View last bill', icon: 'eye', onClick: () => last && nav.push('vouchers.view', { id: last.id }), disabled: !last, group: 'last' },
        { key: 'Alt+T', label: 'Return / exchange', icon: 'undo', onClick: () => nav.push('pos.return', last ? { billId: last.id } : {}), disabled: altering, group: 'more' },
        { key: 'Alt+B', label: 'Day-end summary', icon: 'chart', onClick: () => nav.push('pos.summary'), group: 'more' },
        { key: 'Alt+S', label: 'POS settings', icon: 'settings', onClick: () => nav.push('pos.settings'), hidden: !ctx.can.manage, group: 'more' },
      ]}
    >
      <div className="pos-counter">
        <Stack gap={3} className="pos-counter__main">
          <Inline gap={3} align="center" className="pos-counter__bar">
            <div className="pos-scan">
              <TextInput
                ref={scanRef}
                data-autofocus
                aria-label="Scan barcode or type item code"
                maxLength={200}
                className="pos-scan__input"
                leadingIcon="search"
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => void onScanKey(e)}
                placeholder="Scan barcode, or type item code / alias / name — 3*code adds three"
                trailing={scanBusy ? <Spinner size="xs" label="Looking up the item" /> : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Inline gap={2} align="center">
              <span className="bx-muted">Counter</span>
              <TextInput
                aria-label="Counter name"
                maxLength={40}
                className="pos-counter__name"
                value={counter}
                onChange={(e) => {
                  setCounter(e.target.value);
                  setCounterName(e.target.value);
                }}
                placeholder="e.g. Till 1"
                data-enter-skip
              />
            </Inline>
          </Inline>
          {blocking.map((w, i) => (
            <Banner key={`b${i}`} tone="danger">
              {w.message}
            </Banner>
          ))}
          {notices.slice(0, 3).map((w, i) => (
            <Banner key={`n${i}`} tone="warning">
              {w.message}
            </Banner>
          ))}
          <DataTable<CartLine>
            aria-label="Bill lines"
            columns={columns}
            rows={lines}
            getRowKey={(l) => l.key}
            selectedKey={current?.key ?? null}
            onSelect={(_k, row) => row && setSel(lines.indexOf(row))}
            onRowActivate={(row) => {
              setSel(lines.indexOf(row));
              setDialog('line');
            }}
            onRowKeyDown={(e) => {
              if (e.key === '+' || e.key === '-') {
                e.preventDefault();
                setLines((cur) => stepQty(cur, sel, e.key === '+' ? 1 : -1));
              }
            }}
            empty={<div className="pos-empty bx-muted">Scan the first item — or type its code and press Enter.</div>}
            footerRows={
              lines.length > 0
                ? [{ key: 'tot', cells: { name: `${lines.length} line${lines.length === 1 ? '' : 's'} · ${formatQty(totalQty(lines), 3)} units`, mrp: mrpTotal > 0 ? formatMoney(mrpTotal) : '', amount: lines.reduce((a, l) => a + lineValue(l), 0) } }]
                : undefined
            }
          />
        </Stack>

        <Stack gap={3} className="pos-counter__side">
          <div className="pos-total" aria-live="polite">
            <div className="pos-total__label">{altering ? 'Bill total' : 'To pay'}</div>
            <div className={`pos-total__amount bx-num${settled ? '' : ' is-pending'}`}>{rupees(total)}</div>
            {preview ? (
              <div className="pos-total__detail bx-muted">
                Taxable {formatMoney(preview.totals.taxable)} · GST {formatMoney(preview.totals.tax)}
                {preview.totals.roundOff ? ` · Round off ${formatMoney(preview.totals.roundOff)}` : ''}
              </div>
            ) : null}
            {mrpSaving > 0 ? <div className="pos-total__saved">You save {rupees(mrpSaving)} on MRP</div> : null}
          </div>

          <div className="pos-card">
            <Inline gap={2} justify="between" align="center">
              <strong>{customer ? customer.name : 'Walk-in customer'}</strong>
              <Button size="sm" onClick={() => setDialog('customer')} shortcut="Alt+U" data-enter-skip>
                {customer ? 'Change' : 'Customer'}
              </Button>
            </Inline>
            <div className="bx-muted">
              {customer
                ? [customer.mobile, customer.gstin ? `GSTIN ${customer.gstin}` : null, customer.stateCode ? stateLabel(customer.stateCode) : null].filter(Boolean).join(' · ')
                : 'Paid in full at the counter. Alt+U for a customer (mobile number) to sell on account.'}
            </div>
            {placeOfSupply ? <div className="bx-muted">Place of supply: {stateLabel(placeOfSupply)}</div> : null}
            {customer?.stateCode && customer.stateCode !== ctx.companyStateCode ? (
              <Switch
                checked={deliverToCustomer}
                onChange={setDeliverToCustomer}
                label={`Goods delivered to the customer in ${stateLabel(customer.stateCode)} (IGST)`}
                data-enter-skip
              />
            ) : null}
          </div>

          {last ? (
            <div className="pos-card">
              <Inline gap={2} justify="between">
                <strong>Last bill {last.number ?? ''}</strong>
                <span className="bx-num">{rupees(last.total)}</span>
              </Inline>
              <div className="bx-muted">
                {last.change > 0 ? `Change given ${rupees(last.change)}` : last.credit > 0 ? `${rupees(last.credit)} on account` : 'Paid in full'} · Alt+P Reprint · Alt+V View
              </div>
            </div>
          ) : null}
        </Stack>
      </div>

      {printer.element}

      <CustomerDialog
        open={dialog === 'customer'}
        companyState={ctx.companyStateCode}
        onClose={() => {
          setDialog(null);
          focusScan();
        }}
        onPick={(c) => {
          setCustomer(c);
          setDeliverToCustomer(false);
          setDialog(null);
          focusScan();
        }}
      />
      {dialog === 'line' ? (
        <LineDialog
          line={current}
          onClose={() => {
            setDialog(null);
            focusScan();
          }}
          onApply={(v) => {
            setLines((cur) => {
              let next = setPrice(cur, sel, v.rate, v.discountPct);
              next = setBatch(next, sel, v.batchName);
              return v.qty <= 0 ? removeLine(next, sel) : setQty(next, sel, v.qty);
            });
            setDialog(null);
            focusScan();
          }}
        />
      ) : null}
      {candidates ? (
        <CandidatesDialog
          code={candidates.code}
          candidates={candidates.list}
          onClose={() => {
            setCandidates(null);
            focusScan();
          }}
          onPick={(itemId) => {
            const qty = candidates.qty;
            setCandidates(null);
            void addById(itemId, qty);
          }}
        />
      ) : null}
      <FindItemDialog
        open={dialog === 'find'}
        initial={findText}
        date={date}
        onClose={() => {
          setDialog(null);
          setFindText('');
          focusScan();
        }}
        onPick={(itemId) => {
          setDialog(null);
          setFindText('');
          const qty = findQty;
          setFindQty(1);
          void addById(itemId, qty);
        }}
      />
      <HeldBillsDialog
        open={dialog === 'held'}
        onClose={() => {
          setDialog(null);
          focusScan();
        }}
        onRecall={(h) => void recall(h)}
      />
      {tender && dialog === 'pay' ? (
        <TenderDialog
          open
          due={total}
          walkIn={walkIn}
          customerName={customer?.name ?? null}
          modes={ctx.tenderModes}
          state={tender}
          onChange={setTender}
          partyLedgerId={customer?.ledgerId ?? null}
          saving={saving}
          error={saveError}
          onClose={() => {
            setDialog(null);
            focusScan();
          }}
          onSave={() => void save()}
        />
      ) : null}
    </Screen>
  );

  async function clearBill(): Promise<void> {
    if (lines.length === 0) return;
    const ok = await confirm({ title: 'Clear this bill?', message: `${lines.length} line${lines.length === 1 ? '' : 's'} will be removed. Nothing has been saved yet.`, confirmLabel: 'Clear bill', tone: 'danger' });
    if (!ok) return;
    reset();
    focusScan();
  }
}

/** Value charged on line i incl. GST, from the preview's GST lines (else the line value). */
function chargedOf(p: VoucherPreview, i: number, l: CartLine): Paise {
  const inv = p.inventory[i];
  const g = p.gstLines.find((x) => x.source === 'item' && x.itemId === l.itemId && x.taxableValue === (inv?.amount ?? -1));
  const taxable = inv?.amount ?? lineValue(l);
  return g ? taxable + g.igst + g.cgst + g.sgst + g.cess : taxable;
}

