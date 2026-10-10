/**
 * 'pos.return' { billId? } — return or exchange goods from a POS bill. Enter the bill number (or come
 * from the counter's last bill), type the quantity coming back per line (Alt+R everything), then
 * Ctrl+A: refund by cash / card / UPI, give exchange credit (taken in goods on the next bill — the
 * counter opens with it), or, for a customer, credit the account. Saved as a Credit Note of the POS
 * Return type against the bill (CGST s.34: original invoice number and date on the note), through
 * vouchers.save; stock comes back and output GST is reversed by the posting engine.
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney, formatQty, formatRate } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { PosReturnContext, PosReturnLine } from '../../../shared/types/pos.ts';
import { api, invalidate, Screen, useApiQuery, useFeatures, useNav, userMessage, useWorkingDate, withConfirmation, type ScreenProps } from '../../app/index.ts';
import { Banner, Button, DataTable, Field, Inline, KeyValueList, NumberInput, Stack, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { PosOff, TenderDialog } from './components.tsx';
import { buildReturnInput, hasPicks, pickAll, pickedValue, pickIssues } from './lib/returns.ts';
import { billBlockers, initialTenders, summarizeTenders, toPosBill, type TenderState } from './lib/tender.ts';
import { useReceiptPrinter } from './ReceiptPrinter.tsx';

const RETURN_INVALIDATES = ['vouchers', 'reports', 'gst', 'gstrecon', 'outstanding', 'stock', 'banking', 'dashboard', 'accounts', 'inventory', 'print', 'pos'];
const rupees = (p: Paise): string => `₹ ${formatMoney(p)}`;

export function ReturnScreen({ params }: ScreenProps<{ billId?: number }>) {
  const features = useFeatures();
  if (!features.pos) return <PosOff title="POS Return / Exchange" />;
  return <Returns billId={params?.billId} />;
}

function Returns({ billId }: { billId?: number }) {
  const nav = useNav();
  const toast = useToast();
  const { date } = useWorkingDate();
  const printer = useReceiptPrinter();
  const posCtx = useApiQuery('pos.context', {}, { staleTime: 0 });
  const [number, setNumber] = useState('');
  const [ctx, setCtx] = useState<PosReturnContext | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Map<number, number>>(new Map());
  const [reason, setReason] = useState('Sales return');
  const [tender, setTender] = useState<TenderState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async (input: { voucherId?: number; number?: string }): Promise<void> => {
    setFindError(null);
    try {
      const c = await api('pos.return.context', { ...input, date });
      setCtx(c);
      setPicks(new Map());
      // Keyboard: the cursor moves to the first quantity that can still come back.
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[data-pos-return-qty]')?.focus());
    } catch (err) {
      setFindError(userMessage(err));
    }
  };
  useEffect(() => {
    if (billId !== undefined) void load({ voucherId: billId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billId]);

  const issues = ctx ? pickIssues(ctx, picks) : {};
  const ok = ctx !== null && hasPicks(picks) && Object.keys(issues).length === 0;
  const input = useMemo(() => (ctx && ok ? buildReturnInput(ctx, picks, { tenders: [] }, { date, reason }) : null), [ctx, ok, picks, date, reason]);
  const debounced = useDebouncedValue(input, 150);
  const previewQ = useApiQuery('vouchers.preview', debounced ?? { voucherTypeId: 0, date, mode: 'item_invoice' as const }, { enabled: debounced !== null, keepPrevious: true, staleTime: 0 });
  const value = input && previewQ.data && debounced === input && !previewQ.isPrevious ? previewQ.data.totals.grandTotal : null;
  const blocking = input ? billBlockers(previewQ.data?.warnings ?? []) : [];

  const modes = posCtx.data?.tenderModes ?? [];
  const openRefund = (): void => {
    if (!ctx || !ok) return void toast.info('Type the quantity coming back on at least one line');
    if (value === null) return void toast.info('Working out the return value…');
    if (blocking.length > 0) return void toast.error('The return cannot be saved yet', { message: blocking[0].message });
    const base = initialTenders(modes, value);
    const exchange = modes.find((m) => m.kind === 'exchange' && m.isActive);
    setTender(exchange ? { ...base, rows: [...base.rows, { modeId: exchange.id, name: exchange.name, kind: 'exchange', amount: 0, reference: '' }] } : base);
    setSaveError(null);
  };

  const save = async (): Promise<void> => {
    if (!ctx || !tender || value === null || saving) return;
    if (!summarizeTenders(tender, value, { walkIn: ctx.walkIn, isReturn: true }).ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const posBill = toPosBill(tender, { isReturn: true, returnOfId: ctx.billId });
      const full = buildReturnInput(ctx, picks, posBill, { date, reason });
      const saved = await withConfirmation((ack) => api('vouchers.save', { ...full, ...(ack ? { acknowledgeWarnings: true } : {}) }));
      if (!saved) return;
      for (const p of RETURN_INVALIDATES) invalidate(p);
      if (posCtx.data?.settings.printAfterSave) printer.print(saved.id);
      const exchanged = tender.rows.filter((r) => r.kind === 'exchange').reduce((a, r) => a + r.amount, 0);
      toast.success(`Return ${saved.number ?? ''} saved`.replace(/\s+/g, ' '), { message: exchanged > 0 ? `${rupees(exchanged)} exchange credit — the counter opens with it` : rupees(saved.totals.grandTotal) });
      setTender(null);
      if (exchanged > 0) nav.replace('pos.counter', { exchange: { voucherId: saved.id, amount: exchanged } });
      else nav.pop();
    } catch (err) {
      setSaveError(userMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo<Column<PosReturnLine>[]>(
    () => [
      { key: 'name', header: 'Item', minWidth: 200, render: (l) => <span>{l.name}{l.batchName ? <span className="bx-muted"> · Batch {l.batchName}</span> : null}</span> },
      { key: 'sold', header: 'Sold', width: 100, align: 'right', value: (l) => l.sold, render: (l) => <span className="bx-num">{formatQty(l.sold, l.unitDecimals, l.unit)}</span> },
      { key: 'returned', header: 'Returned before', width: 120, align: 'right', value: (l) => l.returned, render: (l) => (l.returned ? <span className="bx-num">{formatQty(l.returned, l.unitDecimals, l.unit)}</span> : null) },
      { key: 'rate', header: 'Rate', width: 100, align: 'right', value: (l) => l.rate, render: (l) => <span className="bx-num">{formatRate(l.rate)}</span> },
      {
        key: 'qty',
        header: 'Return qty',
        width: 140,
        render: (l) =>
          l.returnable > 0 ? (
            <NumberInput
              aria-label={`Return quantity of ${l.name}`}
              data-pos-return-qty
              value={picks.get(l.index) ?? null}
              onChange={(v) => setPicks((m) => new Map(m).set(l.index, v ?? 0))}
              decimals={l.unitDecimals}
              min={0}
              max={l.returnable}
              blankZero
              invalid={issues[l.index] !== undefined}
              title={issues[l.index]}
            />
          ) : (
            <span className="bx-muted">all returned</span>
          ),
      },
    ],
    [picks, issues],
  );

  return (
    <Screen
      title="POS Return / Exchange"
      subtitle={ctx ? `${ctx.voucherTypeName} ${ctx.billNumber ?? ''} dated ${formatDate(ctx.billDate)}` : 'Goods coming back from a POS bill'}
      icon="undo"
      dirty={hasPicks(picks)}
      hint="Enter Find the bill · Ctrl+A Refund · Alt+R Return everything · Alt+V View the bill · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Refund / exchange', icon: 'rupee', primary: true, onClick: openRefund, disabled: !ok },
        { key: 'Alt+R', label: 'Return everything', icon: 'undo', onClick: () => ctx && setPicks(pickAll(ctx)), disabled: !ctx },
        { key: 'Alt+V', label: 'View the bill', icon: 'eye', onClick: () => ctx && nav.push('vouchers.view', { id: ctx.billId }), disabled: !ctx },
      ]}
    >
      <Stack gap={3}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (number.trim()) void load({ number: number.trim() });
          }}
        >
          <Inline gap={2} align="end">
            <Field label="Bill number" htmlFor="pos-ret-number" hint="The number printed on the receipt, e.g. POS/125.">
              <TextInput id="pos-ret-number" data-autofocus={ctx === null ? true : undefined} value={number} onChange={(e) => setNumber(e.target.value)} placeholder={ctx?.billNumber ?? 'POS/…'} />
            </Field>
            <Button type="submit">Find bill</Button>
          </Inline>
        </form>
        {findError ? <Banner tone="danger">{findError}</Banner> : null}
        {ctx ? (
          <>
            <KeyValueList
              layout="inline"
              columns={3}
              items={[
                { label: 'Customer', value: ctx.partyName ?? '' },
                { label: 'Bill value', value: ctx.billValue, kind: 'amount' },
                { label: 'Paid by', value: ctx.tenders.map((t) => `${t.name} ${formatMoney(t.amount)}`).join(' · ') || 'On account' },
              ]}
            />
            {ctx.walkIn ? <Banner tone="info">Walk-in bill: refund the return in full, or give exchange credit for goods taken now.</Banner> : null}
            <DataTable<PosReturnLine> aria-label="Lines of the bill" columns={columns} rows={ctx.lines} getRowKey={(l) => String(l.index)} />
            <Inline gap={3} align="end">
              <Field label="Reason" htmlFor="pos-ret-reason">
                <TextInput id="pos-ret-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
              </Field>
              <div className="pos-total pos-total--small" aria-live="polite">
                <div className="pos-total__label">Return value (incl. GST)</div>
                <div className="pos-total__amount bx-num">{value !== null ? rupees(value) : ok ? '…' : rupees(pickedValue(ctx, picks))}</div>
              </div>
            </Inline>
            {blocking.map((w, i) => (
              <Banner key={i} tone="danger">
                {w.message}
              </Banner>
            ))}
          </>
        ) : null}
      </Stack>
      {printer.element}
      {tender && ctx && value !== null ? (
        <TenderDialog
          open
          isReturn
          due={value}
          walkIn={ctx.walkIn}
          customerName={ctx.walkIn ? null : ctx.partyName}
          modes={modes}
          state={tender}
          onChange={setTender}
          partyLedgerId={ctx.partyLedgerId}
          saving={saving}
          error={saveError}
          onClose={() => setTender(null)}
          onSave={() => void save()}
        />
      ) : null}
    </Screen>
  );
}
