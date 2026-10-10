/**
 * Foreign-currency dialogs of voucher entry (rendered by the vouchers module's entry screen):
 *
 *  - ForexLineDialog (Alt+Y on a line of a ledger kept in a foreign currency, opens by itself when the
 *    ledger is chosen): amount in the currency, rate of exchange (default: the master rate of the
 *    voucher date for the voucher type — buying for receipts / sales, selling for payments /
 *    purchases), the rupees, and the bill-wise split in the currency with the realised difference each
 *    settled bill will book. Or an exchange adjustment in rupees only.
 *  - ForexPartyBillsDialog (Alt+B on an invoice in a foreign currency): the party's bill-wise split in
 *    the invoice currency.
 *  - ForexInvoiceDialog (Alt+Y on an invoice): the invoice currency (the party's) and its rate.
 *
 * Keys: Enter next field · Alt+F oldest bills first · Alt+N add line · Ctrl+D remove line ·
 * Alt+R master rate · Ctrl+A accept · Esc cancel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { formatExchangeRate, formatForex, FOREX_RATE_TYPES, roundRate, toMinor, type ForexRateType } from '../../../shared/forex.ts';
import type { Paise } from '../../../shared/money.ts';
import type { ForexCurrency, ForexPendingBill, VoucherForexInput } from '../../../shared/types/forex.ts';
import type { BillAllocationInput, BillRefType } from '../../../shared/types/vouchers.ts';
import { useApiQuery } from '../../app/index.ts';
import { AmountInput, Banner, Button, Combobox, EmptyState, Field, Hotkeys, IconButton, Modal, NumberInput, Select, Switch, TextInput, useEnterAdvance } from '../../ui/index.ts';
import {
  autoForexFifo,
  draftTotal,
  draftsFromAllocations,
  draftsToAllocations,
  estimatedDifference,
  lineRupees,
  settleableForex,
  type ForexBillDraft,
} from './lib/entry.ts';
import { RATE_TYPE_LABEL } from './lib/model.ts';

const REF_LABEL: Record<BillRefType, string> = { new: 'New Ref', against: 'Agst Ref', advance: 'Advance', on_account: 'On Account' };
const REF_OPTIONS = (Object.keys(REF_LABEL) as BillRefType[]).map((v) => ({ value: v, label: REF_LABEL[v] }));

interface DraftLine extends ForexBillDraft {
  k: number;
}

// ───────────────────────────── Bills editor (in the currency) ─────────────────────────────

interface BillsEditorProps {
  currency: ForexCurrency;
  side: 'dr' | 'cr';
  date: string;
  /** Total to allocate (magnitude, in the currency); null while not known. */
  total: number | null;
  rate: number | null;
  pending: readonly ForexPendingBill[];
  pendingLoading: boolean;
  lines: DraftLine[];
  setLines: (fn: (ls: DraftLine[]) => DraftLine[]) => void;
  onEdited: () => void;
  nextK: () => number;
  suggestedName: string;
}

function BillsEditor(p: BillsEditorProps) {
  const { currency, side, date, total, rate, pending, pendingLoading, lines, setLines, onEdited, nextK, suggestedName } = p;
  const dp = currency.decimalPlaces;
  const settleable = useMemo(() => settleableForex(pending, side), [pending, side]);
  const money = (x: number) => formatForex(x, dp, currency.symbol);
  const allocated = draftTotal(lines, dp);
  const left = total === null ? 0 : (toMinor(total, dp) - toMinor(allocated, dp)) / 10 ** dp;
  const patch = (k: number, q: Partial<ForexBillDraft>) => {
    onEdited();
    setLines((ls) => ls.map((l) => (l.k === k ? { ...l, ...q } : l)));
  };
  const remove = (k: number) => {
    onEdited();
    setLines((ls) => ls.filter((l) => l.k !== k));
  };
  const add = (d?: Partial<ForexBillDraft>) => {
    onEdited();
    setLines((ls) => [...ls, { k: nextK(), refType: 'against', billName: '', forexAmount: left > 0 ? left : null, ...d }]);
  };
  const fifo = () => {
    if (total === null) return;
    onEdited();
    setLines(() => autoForexFifo(pending, total, side, dp).map((d) => ({ ...d, k: nextK() })));
  };
  const removeFocused = () => {
    const tr = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-fx-line]');
    const k = tr ? Number(tr.dataset.fxLine) : NaN;
    if (Number.isFinite(k)) remove(k);
  };
  return (
    <div className="bx-vch-bills">
      <Hotkeys map={{ 'Alt+F': () => fifo(), 'Alt+N': () => add(), 'Ctrl+D': () => removeFocused() }} />
      <div className="bx-vch-bills__lines">
        <table className="bx-vch-mini" aria-label={`Bill allocations in ${currency.formalName}`}>
          <thead>
            <tr>
              <th scope="col">Type of ref</th>
              <th scope="col">Bill name</th>
              <th scope="col" className="is-num">
                Amount ({currency.symbol})
              </th>
              <th scope="col" className="is-num">
                Exchange difference
              </th>
              <th scope="col">
                <span className="bx-sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const bill = l.refType === 'against' ? settleable.find((b) => b.billName === l.billName) : undefined;
              const diff = bill && rate && l.forexAmount ? estimatedDifference(bill, l.forexAmount, rate, dp, side) : 0;
              return (
                <tr key={l.k} data-fx-line={l.k}>
                  <td>
                    <Select<BillRefType> aria-label="Type of reference" size="sm" options={REF_OPTIONS} value={l.refType} onChange={(v) => patch(l.k, { refType: v, billName: v === 'on_account' ? '' : v === 'new' && !l.billName ? suggestedName : l.billName })} />
                  </td>
                  <td>
                    {l.refType === 'against' ? (
                      <Combobox<ForexPendingBill>
                        aria-label="Pending bill"
                        size="sm"
                        items={settleable}
                        getKey={(b) => b.billName}
                        getLabel={(b) => b.billName}
                        rightMeta={(b) => <span className="bx-num">{money(Math.abs(b.forexAmount))}</span>}
                        value={bill ?? null}
                        onChange={(b) => patch(l.k, { billName: b?.billName ?? '', forexAmount: b && !l.forexAmount ? Math.abs(b.forexAmount) : l.forexAmount })}
                        placeholder="Choose a pending bill"
                        emptyText="No pending bill on this side"
                      />
                    ) : l.refType === 'on_account' ? (
                      <span className="bx-muted">—</span>
                    ) : (
                      <TextInput aria-label="Bill name" size="sm" value={l.billName} maxLength={50} onValueChange={(v) => patch(l.k, { billName: v })} />
                    )}
                  </td>
                  <td className="is-num">
                    <NumberInput aria-label={`Amount in ${currency.symbol}`} size="sm" decimals={dp} grouping={false} min={0} value={l.forexAmount} onChange={(v) => patch(l.k, { forexAmount: v })} />
                  </td>
                  <td className="is-num bx-num">{diff === 0 ? <span className="bx-muted">—</span> : `₹ ${formatMoney(Math.abs(diff))} ${diff > 0 ? 'loss' : 'gain'}`}</td>
                  <td>
                    <IconButton icon="trash" size="sm" aria-label="Remove this line" tabIndex={-1} onClick={() => remove(l.k)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="bx-vch-bills__actions">
          <Button size="sm" icon="plus" shortcut="Alt+N" onClick={() => add()}>
            Add line
          </Button>
          <Button size="sm" icon="zap" shortcut="Alt+F" disabled={settleable.length === 0 || total === null} onClick={fifo}>
            Settle oldest bills first
          </Button>
        </div>
        <p className="bx-muted" aria-live="polite">
          {total === null ? '' : toMinor(left, dp) === 0 ? 'Fully allocated' : left > 0 ? `Still to allocate: ${money(left)}` : `Over-allocated by ${money(-left)}`}
        </p>
      </div>
      <aside className="bx-vch-bills__pending" aria-label="Pending bills">
        <h3 className="bx-vch-side__title">Pending bills ({currency.symbol})</h3>
        {pendingLoading ? (
          <p className="bx-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <EmptyState size="sm" icon="receipt" title="No pending bills" body="Nothing is outstanding for this ledger on the voucher date." />
        ) : (
          <ul className="bx-vch-bills__list">
            {pending.map((b) => {
              const usable = settleable.includes(b);
              return (
                <li key={b.billName}>
                  <button
                    type="button"
                    className="bx-vch-bills__bill"
                    disabled={!usable}
                    onClick={() => add({ refType: 'against', billName: b.billName, forexAmount: Math.min(Math.abs(b.forexAmount), left > 0 ? left : Math.abs(b.forexAmount)) })}
                    title={usable ? 'Settle this bill (Agst Ref)' : 'On the same side as this entry — cannot be settled by it'}
                  >
                    <span className="bx-vch-bills__name">{b.billName}</span>
                    <span className="bx-muted">
                      {formatDate(b.billDate, 'D-MMM-YY')} · booked at ₹{formatExchangeRate(b.bookedRate)}
                    </span>
                    <span className="bx-num">
                      {money(Math.abs(b.forexAmount))} {b.forexAmount > 0 ? 'Dr' : 'Cr'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="bx-muted bx-vch-bills__note">Settled at another rate than booked, the difference is posted to the forex gain/loss ledger in this voucher.</p>
        <p className="bx-muted bx-vch-bills__note">As on {formatDate(date)}.</p>
      </aside>
    </div>
  );
}

function usePendingForex(ledgerId: number, date: string, excludeVoucherId: number | null, enabled: boolean) {
  const input = excludeVoucherId === null ? { ledgerId, asOf: date } : { ledgerId, asOf: date, excludeVoucherId };
  return useApiQuery('forex.pendingBills', input, { enabled });
}

function useDrafts(initial: BillAllocationInput[] | null) {
  const seq = useRef(1000);
  const nextK = () => {
    seq.current += 1;
    return seq.current;
  };
  const [lines, setLinesState] = useState<DraftLine[]>(() => draftsFromAllocations(initial).map((d) => ({ ...d, k: nextK() })));
  const edited = useRef((initial?.length ?? 0) > 0);
  return {
    lines,
    setLines: (fn: (ls: DraftLine[]) => DraftLine[]) => setLinesState(fn),
    nextK,
    edited,
  };
}

// ───────────────────────────── Line dialog (ledger mode) ─────────────────────────────

export interface ForexLineValue {
  /** Magnitude in the currency (0 = exchange adjustment in rupees only). */
  forexAmount: number;
  exchangeRate: number | null;
  /** Rupees (magnitude). */
  amount: Paise;
  bills: BillAllocationInput[] | null;
}

export interface ForexLineDialogProps {
  ledgerId: number;
  ledgerName: string;
  currency: ForexCurrency;
  side: 'dr' | 'cr';
  baseType: VoucherBaseType;
  date: string;
  excludeVoucherId: number | null;
  billWise: boolean;
  initial: { forexAmount: number | null; exchangeRate: number | null; amount: Paise | null; bills: BillAllocationInput[] | null };
  /** Voucher-level rate of the same currency, if any. */
  voucherRate: number | null;
  suggestedName: string;
  onAccept: (v: ForexLineValue) => void;
  onClose: () => void;
}

export function ForexLineDialog(props: ForexLineDialogProps) {
  const { ledgerId, ledgerName, currency, side, baseType, date, excludeVoucherId, billWise, initial, voucherRate, suggestedName, onAccept, onClose } = props;
  const dp = currency.decimalPlaces;
  const [adjust, setAdjust] = useState(initial.forexAmount === 0);
  const [fx, setFx] = useState<number | null>(initial.forexAmount === null ? null : Math.abs(initial.forexAmount));
  const [rate, setRate] = useState<number | null>(initial.exchangeRate ?? voucherRate);
  const [inr, setInr] = useState<Paise | null>(initial.forexAmount === 0 ? (initial.amount === null ? null : Math.abs(initial.amount)) : null);
  const suggestQ = useApiQuery('forex.rate.suggest', { currencyId: currency.id, date, baseType });
  const suggestion = suggestQ.data;
  useEffect(() => {
    if (rate === null && suggestion?.rate) setRate(suggestion.rate);
    // Fill once when the master rate arrives (never over a typed rate).
  }, [suggestion?.rate]);
  const pendingQ = usePendingForex(ledgerId, date, excludeVoucherId, billWise && !adjust);
  const pending = pendingQ.data ?? [];
  const drafts = useDrafts(initial.forexAmount ? initial.bills : null);
  // Against the oldest pending bills by default, until the user edits the split.
  useEffect(() => {
    if (!billWise || adjust || drafts.edited.current || fx === null || fx <= 0 || !pendingQ.data) return;
    drafts.setLines(() => autoForexFifo(pendingQ.data ?? [], fx, side, dp).map((d) => ({ ...d, k: drafts.nextK() })));
  }, [fx, pendingQ.data, billWise, adjust]);

  const rupees = adjust ? (inr ?? 0) : lineRupees(fx ?? 0, dp, rate);
  const allocated = draftTotal(drafts.lines, dp);
  const problems: string[] = [];
  if (!adjust) {
    if (!fx || fx <= 0) problems.push(`Enter the amount in ${currency.symbol}.`);
    if (!rate || rate <= 0) problems.push(`Enter the rate of exchange (rupees for one ${currency.formalName}).`);
    if (billWise && drafts.lines.length > 0 && fx && toMinor(allocated, dp) !== toMinor(fx, dp)) problems.push(`The bills add up to ${formatForex(allocated, dp, currency.symbol)}, the amount is ${formatForex(fx, dp, currency.symbol)}.`);
  } else if (!inr || inr <= 0) problems.push('Enter the rupee amount of the exchange adjustment.');
  const accept = () => {
    if (problems.length > 0) return;
    if (adjust) onAccept({ forexAmount: 0, exchangeRate: null, amount: inr ?? 0, bills: null });
    else {
      const bills = billWise && drafts.lines.length > 0 ? draftsToAllocations(drafts.lines, { dp, rate, unit: 'inr' }) : null;
      onAccept({ forexAmount: fx ?? 0, exchangeRate: rate === null ? null : roundRate(rate), amount: rupees, bills });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => accept() });
  const applyMasterRate = (): void => {
    if (suggestion?.rate) setRate(suggestion.rate);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size={billWise && !adjust ? 'xl' : 'md'}
      title={`${ledgerName} — amount in ${currency.formalName}`}
      description={`${side === 'dr' ? 'Debit' : 'Credit'}. The books are kept in rupees: the amount in ${currency.symbol} × the rate of exchange is posted.`}
      footerStart={
        <span className="bx-num" aria-live="polite">
          {rupees > 0 ? `₹ ${formatMoney(rupees)} ${side === 'dr' ? 'Dr' : 'Cr'}` : ''}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={problems.length > 0} onClick={accept}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => accept(), 'Alt+R': () => applyMasterRate() }} />
      <div ref={formRef}>
        <div className="bx-vch-head">
          {adjust ? (
            <Field label="Rupees (exchange adjustment)" hint={`Changes the rupee value only; the ${currency.symbol} balance is not touched.`}>
              <AmountInput data-autofocus value={inr} onChange={setInr} />
            </Field>
          ) : (
            <>
              <Field label={`Amount (${currency.symbol})`} required>
                <NumberInput data-autofocus decimals={dp} grouping={false} min={0} value={fx} onChange={setFx} />
              </Field>
              <Field
                label="Rate of exchange (₹)"
                required
                hint={
                  suggestion?.rate
                    ? `Master ${RATE_TYPE_LABEL[suggestion.rateType].toLowerCase()} rate${suggestion.rateDate ? ` of ${formatDate(suggestion.rateDate)}` : ''}: ₹${formatExchangeRate(suggestion.rate)} (Alt+R)`
                    : 'No rate in Currencies › Rates of Exchange on or before this date — type it'
                }
              >
                <NumberInput decimals={6} grouping={false} min={0} value={rate} onChange={setRate} />
              </Field>
            </>
          )}
          <Field label="Exchange adjustment in rupees only">
            <Switch checked={adjust} onChange={setAdjust} />
          </Field>
        </div>
        {billWise && !adjust ? (
          <BillsEditor
            currency={currency}
            side={side}
            date={date}
            total={fx}
            rate={rate}
            pending={pending}
            pendingLoading={pendingQ.loading}
            lines={drafts.lines}
            setLines={drafts.setLines}
            onEdited={() => {
              drafts.edited.current = true;
            }}
            nextK={drafts.nextK}
            suggestedName={suggestedName}
          />
        ) : null}
        {problems.length > 0 && (fx !== null || adjust) ? (
          <Banner tone="warning" inline>
            {problems[0]}
          </Banner>
        ) : null}
      </div>
    </Modal>
  );
}

// ───────────────────────────── Party bills of an invoice in the currency ─────────────────────────────

export interface ForexPartyBillsDialogProps {
  ledgerId: number;
  ledgerName: string;
  currency: ForexCurrency;
  /** Invoice value in the currency (magnitude). */
  total: number;
  side: 'dr' | 'cr';
  date: string;
  excludeVoucherId: number | null;
  /** Current allocations (amount = foreign × 100, forexAmount set). */
  initial: BillAllocationInput[] | null;
  suggestedName: string;
  onAccept: (bills: BillAllocationInput[] | null) => void;
  onClose: () => void;
}

export function ForexPartyBillsDialog(props: ForexPartyBillsDialogProps) {
  const { ledgerId, ledgerName, currency, total, side, date, excludeVoucherId, initial, suggestedName, onAccept, onClose } = props;
  const dp = currency.decimalPlaces;
  const pendingQ = usePendingForex(ledgerId, date, excludeVoucherId, true);
  const drafts = useDrafts(initial);
  useEffect(() => {
    if (drafts.lines.length === 0 && !drafts.edited.current) drafts.setLines(() => [{ k: drafts.nextK(), refType: 'new', billName: suggestedName, forexAmount: total }]);
  }, []);
  const allocated = draftTotal(drafts.lines, dp);
  const ok = toMinor(allocated, dp) === toMinor(total, dp) && drafts.lines.every((l) => l.refType === 'on_account' || l.billName.trim() !== '');
  const accept = () => {
    if (!ok) return;
    onAccept(draftsToAllocations(drafts.lines, { dp, rate: null, unit: 'encoded' }));
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => accept() });
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Bill-wise details — ${ledgerName} (${currency.symbol})`}
      description={`Allocate ${formatForex(total, dp, currency.symbol)} ${side === 'dr' ? 'Dr' : 'Cr'} in ${currency.formalName}. Adjust an advance received in ${currency.symbol} with Agst Ref.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAccept(null)}>
            Use default
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={!ok} onClick={accept}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => accept() }} />
      <div ref={formRef}>
        <BillsEditor
          currency={currency}
          side={side}
          date={date}
          total={total}
          rate={null}
          pending={pendingQ.data ?? []}
          pendingLoading={pendingQ.loading}
          lines={drafts.lines}
          setLines={drafts.setLines}
          onEdited={() => {
            drafts.edited.current = true;
          }}
          nextK={drafts.nextK}
          suggestedName={suggestedName}
        />
      </div>
    </Modal>
  );
}

// ───────────────────────────── Invoice currency + rate ─────────────────────────────

export interface ForexInvoiceDialogProps {
  currency: ForexCurrency;
  date: string;
  baseType: VoucherBaseType;
  value: VoucherForexInput | null;
  onAccept: (v: VoucherForexInput) => void;
  onClose: () => void;
}

export function ForexInvoiceDialog({ currency, date, baseType, value, onAccept, onClose }: ForexInvoiceDialogProps) {
  const [rateType, setRateType] = useState<ForexRateType | ''>(value?.rateType ?? '');
  const [rate, setRate] = useState<number | null>(value?.rate ?? null);
  const suggestQ = useApiQuery('forex.rate.suggest', rateType ? { currencyId: currency.id, date, rateType } : { currencyId: currency.id, date, baseType });
  const s = suggestQ.data;
  useEffect(() => {
    if (rate === null && s?.rate) setRate(s.rate);
  }, [s?.rate]);
  const accept = () => {
    if (!rate || rate <= 0) return;
    onAccept({ currencyId: currency.id, rate: roundRate(rate), ...(rateType ? { rateType } : s ? { rateType: s.rateType } : {}) });
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => accept() });
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Invoice in ${currency.formalName} (${currency.symbol})`}
      description={`Rates and amounts on this invoice are in ${currency.symbol}. The rupee value (× the rate) is what posts; GST is computed in rupees. For exports of goods use the CBIC-notified rate of the date (Rule 34, CGST Rules).`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={!rate || rate <= 0} onClick={accept}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys
        map={{
          'Ctrl+A': () => accept(),
          'Alt+R': () => {
            if (s?.rate) setRate(s.rate);
          },
        }}
      />
      <div className="bx-vch-head" ref={formRef}>
        <Field label="Rate from the master">
          <Select<ForexRateType | ''>
            value={rateType}
            options={[{ value: '' as const, label: `Default for this voucher (${s ? RATE_TYPE_LABEL[s.rateType].toLowerCase() : '…'})` }, ...FOREX_RATE_TYPES.map((t) => ({ value: t, label: RATE_TYPE_LABEL[t] }))]}
            onChange={(v) => {
              setRateType(v);
              setRate(null);
            }}
          />
        </Field>
        <Field
          label={`Rate of exchange (₹ per ${currency.symbol})`}
          required
          hint={s?.rate ? `Master rate${s.rateDate ? ` of ${formatDate(s.rateDate)}` : ''}: ₹${formatExchangeRate(s.rate)} (Alt+R)` : 'No rate in Currencies › Rates of Exchange on or before this date — type it'}
        >
          <NumberInput data-autofocus decimals={6} grouping={false} min={0} value={rate} onChange={setRate} />
        </Field>
      </div>
    </Modal>
  );
}
