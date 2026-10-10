/**
 * Dialogs and small parts of the POS counter: feature-off notice, state picker, customer by mobile,
 * line quantity / price, several items on one code, find item by name, held bills, payment.
 * Every dialog is keyboard-complete: Enter moves on, Ctrl+A accepts, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { stateOptions, type StateOption } from '../../../shared/gst/states.ts';
import { formatMoney, formatQty } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { PosCustomer, PosExchangeCredit, PosHeldBill, PosItemLookupResult, PosTenderMode } from '../../../shared/types/pos.ts';
import { POS_TENDER_KIND_LABELS } from '../../../shared/types/pos.ts';
import type { ItemPickerRow } from '../../../shared/types/inventory.ts';
import { api, Screen, useApiQuery, useCan, useNav, userMessage } from '../../app/index.ts';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  Combobox,
  DataTable,
  EmptyState,
  Field,
  Inline,
  Modal,
  NumberInput,
  PercentInput,
  Picker,
  Stack,
  TextInput,
  useEnterAdvance,
  useHotkeys,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import type { CartLine } from './lib/cart.ts';
import { addExchangeRow, payRestBy, quickCash, setTenderAmount, setTenderReference, summarizeTenders, wantsReference, type TenderState } from './lib/tender.ts';

const rupees = (p: Paise): string => `₹ ${formatMoney(p)}`;

/** Shown instead of a POS screen while F11 › POS invoicing is off. */
export function PosOff({ title }: { title: string }) {
  const nav = useNav();
  return (
    <Screen title={title} icon="cart" hint="Esc Back">
      <EmptyState
        icon="cart"
        title="POS invoicing is turned off for this company"
        body="Turn it on in Features (F11) › Inventory › POS invoicing to bill at the counter with barcode scanning, split payment and thermal receipts."
        action={
          <Button variant="primary" onClick={() => nav.push('company.features')}>
            Open Features (F11)
          </Button>
        }
      />
    </Screen>
  );
}

const STATES: readonly StateOption[] = stateOptions();

export function StatePicker({ id, value, onChange }: { id?: string; value: string; onChange: (code: string) => void }) {
  const selected = useMemo(() => STATES.find((s) => s.value === value) ?? null, [value]);
  return (
    <Picker<StateOption>
      id={id}
      items={STATES}
      getKey={(s) => s.value}
      getLabel={(s) => s.label}
      getAlias={(s) => s.alpha}
      value={selected}
      onChange={(s) => onChange(s?.value ?? '')}
      placeholder="State, code or short name (e.g. MH)"
      emptyText="No state matches"
    />
  );
}

// ───────────────────────────── Customer by mobile ─────────────────────────────

export interface CounterCustomer {
  ledgerId: number;
  name: string;
  mobile: string | null;
  stateCode: string | null;
  gstin: string | null;
}

/**
 * Alt+U — find the customer by mobile number (Enter); none found → create with name + state
 * (Ctrl+A); several → pick one. The "Walk-in" button clears the customer.
 */
export function CustomerDialog({
  open,
  companyState,
  onClose,
  onPick,
}: {
  open: boolean;
  companyState: string | null;
  onClose: () => void;
  onPick: (c: CounterCustomer | null) => void;
}) {
  const toast = useToast();
  const canCreate = useCan('masters.create');
  const [mobile, setMobile] = useState('');
  const [found, setFound] = useState<PosCustomer[] | null>(null);
  const [name, setName] = useState('');
  const [state, setState] = useState(companyState ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMobile('');
    setFound(null);
    setName('');
    setState(companyState ?? '');
    setError(null);
  }, [open, companyState]);
  const find = async (): Promise<void> => {
    setError(null);
    try {
      const rows = await api('pos.customer.find', { mobile });
      if (rows.length === 1) {
        const c = rows[0];
        onPick({ ledgerId: c.ledgerId, name: c.name, mobile: c.mobile, stateCode: c.stateCode, gstin: c.gstin });
        return;
      }
      setFound(rows);
    } catch (err) {
      setError(userMessage(err));
    }
  };
  const create = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api('pos.customer.create', { name, mobile, ...(state ? { stateCode: state } : {}) });
      toast.success(`Customer ${c.name} created`);
      onPick({ ledgerId: c.ledgerId, name: c.name, mobile: c.mobile, stateCode: c.stateCode, gstin: c.gstin });
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const creating = found !== null && found.length === 0;
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void (creating ? create() : find()) });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customer"
      description="Find the customer by mobile number, or create one with just a name, mobile and state."
      size="md"
      footerStart={<span className="bx-muted">Enter Find · Ctrl+A Create · Esc Close</span>}
      footer={
        <>
          <Button onClick={() => onPick(null)}>Walk-in (no customer)</Button>
          {creating ? (
            <Button variant="primary" shortcut="Ctrl+A" loading={busy} disabled={!canCreate || !name.trim()} onClick={() => void create()}>
              Create customer
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void find()}>
              Find
            </Button>
          )}
        </>
      }
    >
      <CustomerKeys enabled={creating && canCreate} onAccept={() => void create()} />
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={3}>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Mobile number" htmlFor="pos-cust-mobile" hint="10 digits; +91 or 0 in front is fine.">
            <TextInput
              id="pos-cust-mobile"
              data-autofocus
              inputMode="tel"
              value={mobile}
              onChange={(e) => {
                setMobile(e.target.value);
                setFound(null);
              }}
              placeholder="98765 43210"
            />
          </Field>
          {found && found.length > 1 ? (
            <DataTable<PosCustomer>
              aria-label="Customers with this mobile number"
              autoFocus
              columns={[
                { key: 'name', header: 'Customer' },
                { key: 'groupName', header: 'Under', width: 160 },
                { key: 'stateCode', header: 'State', width: 70 },
              ]}
              rows={found}
              getRowKey={(r) => String(r.ledgerId)}
              onRowActivate={(c) => onPick({ ledgerId: c.ledgerId, name: c.name, mobile: c.mobile, stateCode: c.stateCode, gstin: c.gstin })}
            />
          ) : null}
          {creating ? (
            canCreate ? (
              <>
                <Banner tone="info">No customer has this mobile number. Enter the name to create one.</Banner>
                <Field label="Name" htmlFor="pos-cust-name" required>
                  <TextInput id="pos-cust-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
                </Field>
                <Field label="State" htmlFor="pos-cust-state" hint="Their state for GST (a walk-in buyer is billed at your counter's state unless goods are delivered to them).">
                  <StatePicker id="pos-cust-state" value={state} onChange={setState} />
                </Field>
              </>
            ) : (
              <Banner tone="warning">No customer has this mobile number, and you may not create customers (Masters › Create permission).</Banner>
            )
          ) : null}
        </Stack>
      </form>
    </Modal>
  );
}

function CustomerKeys({ enabled, onAccept }: { enabled: boolean; onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': enabled ? onAccept : undefined }, [enabled, onAccept]);
  return null;
}

// ───────────────────────────── Line: quantity / price / batch ─────────────────────────────

export function LineDialog({ line, onClose, onApply }: { line: CartLine | null; onClose: () => void; onApply: (v: { qty: number; rate: number; discountPct: number; batchName: string }) => void }) {
  const [qty, setQty] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [disc, setDisc] = useState<number | null>(null);
  const [batch, setBatch] = useState('');
  useEffect(() => {
    if (!line) return;
    setQty(line.qty);
    setRate(line.rate);
    setDisc(line.discountPct);
    setBatch(line.batchName ?? '');
  }, [line]);
  const apply = (): void => onApply({ qty: qty ?? 0, rate: rate ?? 0, discountPct: disc ?? 0, batchName: batch });
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: apply });
  if (!line) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={line.name}
      description={line.mrp !== null ? `MRP ${rupees(line.mrp)} per ${line.unit} (incl. taxes)` : undefined}
      size="sm"
      footerStart={<span className="bx-muted">Enter Next field · Ctrl+A Apply</span>}
      footer={
        <Button variant="primary" shortcut="Ctrl+A" onClick={apply}>
          Apply
        </Button>
      }
    >
      <AcceptKey onAccept={apply} />
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={3}>
          <Field label={`Quantity (${line.unit})`} htmlFor="pos-line-qty">
            <NumberInput id="pos-line-qty" data-autofocus value={qty} onChange={setQty} decimals={line.unitDecimals} min={0} />
          </Field>
          <Field label="Rate (₹ per unit)" htmlFor="pos-line-rate" hint={line.rateInclusiveOfTax ? 'Inclusive of GST (as on the item).' : 'Before GST.'}>
            <NumberInput id="pos-line-rate" value={rate} onChange={setRate} decimals={2} min={0} />
          </Field>
          <Field label="Discount" htmlFor="pos-line-disc">
            <PercentInput id="pos-line-disc" value={disc} onChange={setDisc} max={100} />
          </Field>
          {line.maintainBatches ? (
            <Field label="Batch" htmlFor="pos-line-batch" required>
              <TextInput id="pos-line-batch" value={batch} onChange={(e) => setBatch(e.target.value)} />
            </Field>
          ) : null}
        </Stack>
      </form>
    </Modal>
  );
}

function AcceptKey({ onAccept, enabled = true }: { onAccept: () => void; enabled?: boolean }) {
  useHotkeys({ 'Ctrl+A': enabled ? onAccept : undefined }, [onAccept, enabled]);
  return null;
}

// ───────────────────────────── Several items on one code / find by name ─────────────────────────────

export function CandidatesDialog({ code, candidates, onClose, onPick }: { code: string; candidates: PosItemLookupResult['candidates']; onClose: () => void; onPick: (itemId: number) => void }) {
  return (
    <Modal open onClose={onClose} title={`Several items match “${code}”`} description="Choose the item (↑ ↓ and Enter)." size="md" flush>
      <DataTable
        aria-label="Matching items"
        autoFocus
        columns={[
          { key: 'name', header: 'Item' },
          { key: 'matchedBy', header: 'Matched by', width: 140, value: (r: PosItemLookupResult['candidates'][number]) => r.matchedBy.replace('_', ' ') },
        ]}
        rows={candidates}
        getRowKey={(r) => String(r.itemId)}
        onRowActivate={(r) => onPick(r.itemId)}
      />
    </Modal>
  );
}

/** Alt+F — find an item by name / alias / part no. / barcode (type-ahead, like the voucher's item picker). */
export function FindItemDialog({ open, initial, date, onClose, onPick }: { open: boolean; initial: string; date: string; onClose: () => void; onPick: (itemId: number) => void }) {
  const [value, setValue] = useState<ItemPickerRow | null>(null);
  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="Find item" description="Type a name, alias, part number or barcode; Enter adds it to the bill." size="md">
      <Field label="Item" htmlFor="pos-find-item">
        <Combobox<ItemPickerRow>
          id="pos-find-item"
          autoFocus
          loadItems={async (q) => api('inventory.item.picker', { search: q || initial, asOf: date, limit: 50 })}
          getKey={(r) => String(r.id)}
          getLabel={(r) => r.name}
          getAlias={(r) => r.alias}
          getKeywords={(r) => [r.partNo ?? '', r.barcode ?? '']}
          rightMeta={(r) => <span className="bx-muted bx-num">{r.isService ? '' : formatQty(r.stockQty, r.unitDecimals, r.unitSymbol)}</span>}
          value={value}
          onChange={setValue}
          onCommit={(r) => {
            if (r) onPick(r.id);
          }}
          placeholder={initial || 'Item name, alias, part no. or barcode'}
          emptyText="No item matches"
        />
      </Field>
    </Modal>
  );
}

// ───────────────────────────── Held bills ─────────────────────────────

export function HeldBillsDialog({ open, onClose, onRecall }: { open: boolean; onClose: () => void; onRecall: (bill: PosHeldBill) => void }) {
  const toast = useToast();
  const q = useApiQuery('pos.held.list', {}, { enabled: open, staleTime: 0 });
  const [cursor, setCursor] = useState<string | null>(null);
  const rows = q.data ?? [];
  const current = rows.find((r) => String(r.id) === cursor) ?? rows[0] ?? null;
  const discard = async (): Promise<void> => {
    if (!current) return;
    try {
      await api('pos.held.discard', { id: current.id });
      toast.info(`Held bill “${current.label}” discarded`);
      void q.refetch();
    } catch (err) {
      toast.error('Could not discard the held bill', { message: userMessage(err) });
    }
  };
  const columns = useMemo<Column<PosHeldBill>[]>(
    () => [
      { key: 'label', header: 'Bill' },
      { key: 'lineCount', header: 'Lines', kind: 'number', width: 70 },
      { key: 'total', header: 'Amount', kind: 'amount', width: 120 },
      { key: 'createdAt', header: 'Held at', width: 120, value: (r) => new Date(r.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) },
      { key: 'createdByName', header: 'By', width: 120, value: (r) => r.createdByName ?? '' },
    ],
    [],
  );
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Bills on hold"
      description="Enter recalls the bill to the counter; Alt+D discards it."
      size="lg"
      flush
      footerStart={<span className="bx-muted">Enter Recall · Alt+D Discard · Esc Close</span>}
    >
      <DiscardKey enabled={current !== null} onDiscard={() => void discard()} />
      <DataTable<PosHeldBill>
        aria-label="Bills on hold"
        autoFocus
        columns={columns}
        rows={rows}
        loading={q.loading}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(r) => onRecall(r)}
        empty={<EmptyState title="No bills on hold" body="Alt+O on the counter puts the current bill on hold." />}
      />
    </Modal>
  );
}

function DiscardKey({ enabled, onDiscard }: { enabled: boolean; onDiscard: () => void }) {
  useHotkeys({ 'Alt+D': enabled ? onDiscard : undefined }, [enabled, onDiscard]);
  return null;
}

// ───────────────────────────── Payment ─────────────────────────────

export function TenderDialog(props: {
  open: boolean;
  isReturn?: boolean;
  due: Paise;
  walkIn: boolean;
  customerName: string | null;
  modes: readonly PosTenderMode[];
  state: TenderState;
  onChange: (s: TenderState) => void;
  partyLedgerId: number | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const { state, due, onChange } = props;
  const summary = summarizeTenders(state, due, { walkIn: props.walkIn, isReturn: props.isReturn });
  const exchangeMode = props.modes.find((m) => m.kind === 'exchange' && m.isActive) ?? null;
  const creditsQ = useApiQuery('pos.exchange.open', props.partyLedgerId !== null && !props.walkIn ? { partyLedgerId: props.partyLedgerId } : {}, {
    enabled: props.open && !props.isReturn && exchangeMode !== null,
    staleTime: 0,
  });
  const credits = creditsQ.data ?? [];
  const [credit, setCredit] = useState<PosExchangeCredit | null>(null);
  const canSave = summary.ok && !props.saving && due > 0;
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => canSave && props.onSave() });
  const cashRef = useRef<HTMLInputElement | null>(null);
  // Walk-in cash sale (the usual case): the cursor starts in "Cash handed over" — type it, Enter saves.
  const [focusCash] = useState(() => !props.isReturn && summarizeTenders(props.state, props.due, { walkIn: props.walkIn }).cash === props.due && props.due > 0);
  if (!props.open) return null;
  const title = props.isReturn ? 'Refund' : 'Payment';
  return (
    <Modal
      open
      onClose={props.onClose}
      title={`${title} — ${rupees(due)}`}
      description={props.customerName ? `${props.isReturn ? 'Return from' : 'Bill to'} ${props.customerName}` : props.isReturn ? 'Walk-in return: refund in full or give exchange credit' : 'Walk-in bill: paid in full'}
      size="lg"
      footerStart={<span className="bx-muted">Enter Next field · Ctrl+A {props.isReturn ? 'Save return' : 'Save bill'} · Esc Back to the bill</span>}
      footer={
        <Button variant="primary" shortcut="Ctrl+A" loading={props.saving} disabled={!canSave} onClick={props.onSave}>
          {props.isReturn ? 'Save return' : 'Save bill'}
        </Button>
      }
    >
      <AcceptKey enabled={canSave} onAccept={props.onSave} />
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={3}>
          {props.error ? <Banner tone="danger">{props.error}</Banner> : null}
          <table className="pos-tenders" aria-label={props.isReturn ? 'Refund by tender' : 'Payment by tender'}>
            <thead>
              <tr>
                <th>{props.isReturn ? 'Refund by' : 'Paid by'}</th>
                <th className="bx-num">Amount</th>
                <th>Reference</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r, i) => (
                <tr key={`${r.modeId}:${r.exchangeVoucherId ?? ''}`}>
                  <td>
                    <Inline gap={2}>
                      <span>{r.name}</span>
                      <Badge size="sm" tone={r.kind === 'cash' ? 'neutral' : r.kind === 'exchange' ? 'accent' : 'info'}>
                        {POS_TENDER_KIND_LABELS[r.kind]}
                      </Badge>
                      {i === state.balanceIndex ? <span className="bx-muted">(balance)</span> : null}
                    </Inline>
                  </td>
                  <td className="pos-tenders__amount">
                    <AmountInput
                      aria-label={`${r.name} amount`}
                      value={r.amount}
                      onChange={(v) => onChange(setTenderAmount(state, i, v ?? 0, due))}
                      blankZero
                      {...(i === 0 && !focusCash ? { 'data-autofocus': true } : {})}
                    />
                  </td>
                  <td>
                    {wantsReference(r.kind) ? (
                      <TextInput aria-label={`${r.name} reference`} maxLength={50} value={r.reference} onChange={(e) => onChange(setTenderReference(state, i, e.target.value))} placeholder={r.kind === 'upi' ? 'UTR / last digits' : 'Slip / last 4 digits'} />
                    ) : r.kind === 'exchange' && r.exchangeVoucherId !== undefined ? (
                      <span className="bx-muted">From return #{r.exchangeVoucherId}</span>
                    ) : null}
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" data-enter-skip onClick={() => onChange(payRestBy(state, i, due))}>
                      Rest here
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!props.isReturn && exchangeMode && credits.length > 0 ? (
            <Field label="Use exchange credit" htmlFor="pos-exchange" hint="Goods returned earlier as exchange: their credit pays for this bill.">
              <Inline gap={2}>
                <Combobox<PosExchangeCredit>
                  id="pos-exchange"
                  items={credits}
                  getKey={(c) => String(c.voucherId)}
                  getLabel={(c) => `${c.number ?? 'Return'} · ${c.partyName ?? ''} · ${rupees(c.available)} left`}
                  value={credit}
                  onChange={setCredit}
                  placeholder="Choose the return"
                />
                <Button
                  disabled={!credit}
                  data-enter-skip
                  onClick={() => credit && exchangeMode && onChange(addExchangeRow(state, { modeId: exchangeMode.id, name: exchangeMode.name, voucherId: credit.voucherId, available: credit.available }, due))}
                >
                  Apply credit
                </Button>
              </Inline>
            </Field>
          ) : null}

          {!props.isReturn ? (
            <Field label="Cash handed over" htmlFor="pos-cash-tendered" hint={summary.cash > 0 ? 'Leave empty when the customer pays the exact cash.' : 'Only when part of the bill is paid in cash.'}>
              <Inline gap={2}>
                <AmountInput
                  id="pos-cash-tendered"
                  ref={cashRef}
                  value={state.cashTendered}
                  onChange={(v) => onChange({ ...state, cashTendered: v })}
                  disabled={summary.cash === 0}
                  symbol
                  {...(focusCash ? { 'data-autofocus': true } : {})}
                />
                {quickCash(summary.cash).map((amt) => (
                  <Button key={amt} size="sm" data-enter-skip disabled={summary.cash === 0} onClick={() => onChange({ ...state, cashTendered: amt })}>
                    {rupees(amt)}
                  </Button>
                ))}
              </Inline>
            </Field>
          ) : null}

          <div className="pos-pay-summary" aria-live="polite">
            <div>
              <span className="bx-muted">{props.isReturn ? 'Refunded' : 'Paid'}</span>
              <strong className="bx-num">{rupees(summary.paid)}</strong>
            </div>
            {summary.credit > 0 ? (
              <div>
                <span className="bx-muted">{props.walkIn ? (props.isReturn ? 'Not refunded' : 'Not paid') : props.isReturn ? 'Credited to the account' : 'On account'}</span>
                <strong className="bx-num">{rupees(summary.credit)}</strong>
              </div>
            ) : null}
            {!props.isReturn ? (
              <div className="pos-pay-summary__change">
                <span className="bx-muted">Change</span>
                <strong className="bx-num">{rupees(summary.change)}</strong>
              </div>
            ) : null}
          </div>
          {summary.problems.map((p, i) => (
            <Banner key={i} tone="warning">
              {p}
            </Banner>
          ))}
        </Stack>
      </form>
    </Modal>
  );
}
