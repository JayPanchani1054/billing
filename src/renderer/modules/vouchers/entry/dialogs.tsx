/**
 * Smaller dialogs of the voucher screen: cost centres, bank instrument, more details (party /
 * consignee / dispatch & e-way bill / order / export), tracking documents, cancel with reason,
 * voucher type switch (F10) and the voucher configuration hints (F12).
 *
 * Every dialog: Enter moves through its fields, Ctrl+A accepts, Esc cancels.
 */
import { useMemo, useRef, useState } from 'react';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { formatMoney, formatQty } from '../../../../shared/format.ts';
import { stateOptions } from '../../../../shared/gst/index.ts';
import { REGISTRATION_TYPES } from '../../../../shared/gst/index.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { CostCentreRow, VoucherTypeRow } from '../../../../shared/types/accounts.ts';
import type { RegistrationType } from '../../../../shared/types/gst.ts';
import { INSTRUMENT_TYPES } from '../../../../shared/types/vouchers.ts';
import type {
  ConsigneeInput,
  CostAllocationInput,
  DispatchDetailsInput,
  ExportDetailsInput,
  InstrumentInput,
  InstrumentType,
  OrderDetailsInput,
  PartySnapshotInput,
  TrackingDoc,
  TrackingKind,
  VoucherEntryContext,
} from '../../../../shared/types/vouchers.ts';
import { useApiQuery, useNav } from '../../../app/index.ts';
import {
  AmountInput,
  Banner,
  Button,
  Checkbox,
  Combobox,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  Hotkeys,
  IconButton,
  KeyValueList,
  Modal,
  NumberInput,
  Select,
  Switch,
  Tabs,
  TextArea,
  TextInput,
  useEnterAdvance,
} from '../../../ui/index.ts';
import { TRACKING_KIND_LABEL } from '../lib/kinds.ts';

// ───────────────────────────── Cost centres ─────────────────────────────

export interface CostDialogProps {
  ledgerName: string;
  amount: Paise;
  initial: readonly CostAllocationInput[] | null;
  onAccept: (costs: CostAllocationInput[] | null) => void;
  onClose: () => void;
}

export function CostDialog({ ledgerName, amount, initial, onAccept, onClose }: CostDialogProps) {
  const q = useApiQuery('accounts.costCentre.list', {}, { staleTime: 60_000 });
  const centres = q.data?.rows ?? [];
  const seq = useRef(100);
  const [lines, setLines] = useState<Array<{ k: number; costCentreId: number | null; amount: Paise | null }>>(() =>
    initial && initial.length > 0 ? initial.map((c, i) => ({ k: i, costCentreId: c.costCentreId, amount: c.amount })) : [{ k: 0, costCentreId: null, amount }],
  );
  const total = lines.reduce((a, l) => a + (l.amount ?? 0), 0);
  const remaining = amount - total;
  const valid = lines.every((l) => l.costCentreId !== null && (l.amount ?? 0) > 0) && remaining === 0;
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => accept() });
  const accept = () => {
    if (!valid) return;
    onAccept(lines.map((l) => ({ costCentreId: l.costCentreId as number, amount: l.amount as Paise })));
  };
  const add = () => {
    seq.current += 1;
    setLines((ls) => [...ls, { k: seq.current, costCentreId: null, amount: Math.max(0, remaining) || null }]);
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Cost centres — ${ledgerName}`}
      description={`Split ₹ ${formatMoney(amount)} across cost centres (branches, projects, departments).`}
      footerStart={<span aria-live="polite">{remaining === 0 ? 'Fully allocated' : remaining > 0 ? `Still to allocate: ₹ ${formatMoney(remaining)}` : `Over by ₹ ${formatMoney(-remaining)}`}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAccept(null)}>
            No allocation
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={!valid} onClick={accept}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => accept(), 'Alt+N': () => add() }} />
      <div ref={formRef}>
        {centres.length === 0 && !q.loading ? (
          <EmptyState size="sm" icon="layers" title="No cost centres yet" body="Create cost centres under Masters › Cost Centres first." />
        ) : (
          <table className="bx-vch-mini" aria-label="Cost centre allocations">
            <thead>
              <tr>
                <th scope="col">Cost centre</th>
                <th scope="col" className="is-num">
                  Amount
                </th>
                <th scope="col">
                  <span className="bx-sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.k}>
                  <td>
                    <Combobox<CostCentreRow>
                      aria-label="Cost centre"
                      size="sm"
                      items={centres}
                      getKey={(c) => String(c.id)}
                      getLabel={(c) => c.name}
                      getAlias={(c) => c.alias}
                      groupBy={(c) => c.categoryName}
                      value={centres.find((c) => c.id === l.costCentreId) ?? null}
                      onChange={(c) => setLines((ls) => ls.map((x) => (x.k === l.k ? { ...x, costCentreId: c?.id ?? null } : x)))}
                      emptyText="No cost centre matches"
                    />
                  </td>
                  <td className="is-num">
                    <AmountInput aria-label="Amount" size="sm" value={l.amount} onChange={(v) => setLines((ls) => ls.map((x) => (x.k === l.k ? { ...x, amount: v } : x)))} />
                  </td>
                  <td>
                    <IconButton icon="trash" size="sm" tabIndex={-1} aria-label="Remove this line" onClick={() => setLines((ls) => ls.filter((x) => x.k !== l.k))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="bx-vch-bills__actions">
          <Button size="sm" icon="plus" shortcut="Alt+N" onClick={add}>
            Add line
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────── Bank instrument ─────────────────────────────

export const INSTRUMENT_LABEL: Readonly<Record<InstrumentType, string>> = {
  cheque: 'Cheque',
  dd: 'Demand draft',
  neft: 'NEFT',
  rtgs: 'RTGS',
  imps: 'IMPS',
  upi: 'UPI',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
};

export interface InstrumentDialogProps {
  ledgerName: string;
  date: string;
  initial: InstrumentInput | null;
  onAccept: (instrument: InstrumentInput | null) => void;
  onClose: () => void;
}

export function InstrumentDialog({ ledgerName, date, initial, onAccept, onClose }: InstrumentDialogProps) {
  const [v, setV] = useState<InstrumentInput>(() => initial ?? { type: 'cheque', date });
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => onAccept(v) });
  const set = (p: Partial<InstrumentInput>) => setV((cur) => ({ ...cur, ...p }));
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Bank details — ${ledgerName}`}
      description="How the money moved: cheque, NEFT, UPI… These details print on the voucher and help bank reconciliation."
      footer={
        <>
          <Button variant="ghost" onClick={() => onAccept(null)}>
            Clear
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={() => onAccept(v)}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => onAccept(v) }} />
      <div ref={formRef}>
        <FieldGroup columns={2}>
          <Field label="Transaction type">
            <Select<InstrumentType> options={INSTRUMENT_TYPES.map((t) => ({ value: t, label: INSTRUMENT_LABEL[t] }))} value={v.type} onChange={(t) => set({ type: t })} />
          </Field>
          <Field label={v.type === 'cheque' || v.type === 'dd' ? 'Instrument no.' : 'Reference / UTR no.'}>
            <TextInput value={v.number ?? ''} maxLength={40} onValueChange={(s) => set({ number: s })} />
          </Field>
          <Field label="Instrument date">
            <DateInput value={v.date ?? null} referenceDate={date} onChange={(d) => set({ date: d ?? undefined })} />
          </Field>
          <Field label="Bank name" optional>
            <TextInput value={v.bankName ?? ''} maxLength={100} onValueChange={(s) => set({ bankName: s })} />
          </Field>
          <Field label="Favouring" optional hint="Name the cheque is written to">
            <TextInput value={v.favouring ?? ''} maxLength={100} onValueChange={(s) => set({ favouring: s })} />
          </Field>
        </FieldGroup>
      </div>
    </Modal>
  );
}

// ───────────────────────────── More details (Ctrl+I) ─────────────────────────────

export interface MoreDetailsValue {
  party: PartySnapshotInput | null;
  consignee: ConsigneeInput | null;
  dispatch: DispatchDetailsInput | null;
  orderDetails: OrderDetailsInput | null;
  exportDetails: ExportDetailsInput | null;
  effectiveDate: string | null;
}

export interface MoreDetailsDialogProps {
  value: MoreDetailsValue;
  date: string;
  partyName: string;
  showEffectiveDate: boolean;
  showExport: boolean;
  showEway: boolean;
  onAccept: (v: MoreDetailsValue) => void;
  onClose: () => void;
}

const REG_LABEL: Readonly<Record<RegistrationType, string>> = {
  regular: 'Regular',
  composition: 'Composition',
  unregistered: 'Unregistered / consumer',
  consumer: 'Consumer',
  sez: 'SEZ',
  overseas: 'Overseas',
  deemed_export: 'Deemed export',
  uin: 'UIN holder',
} as Record<RegistrationType, string>;

export function MoreDetailsDialog({ value, date, partyName, showEffectiveDate, showExport, showEway, onAccept, onClose }: MoreDetailsDialogProps) {
  const [v, setV] = useState<MoreDetailsValue>(value);
  const [tab, setTab] = useState('party');
  const states = useMemo(() => stateOptions({ includeForeign: true }), []);
  const stateSelect = (val: string | undefined, on: (s: string) => void, label: string) => (
    <Field label={label} optional>
      <Select options={states} value={val ?? ''} placeholder="Choose a state" onChange={(s) => on(s)} />
    </Field>
  );
  const party = v.party ?? {};
  const consignee = v.consignee ?? {};
  const dispatch = v.dispatch ?? {};
  const order = v.orderDetails ?? {};
  const exp = v.exportDetails ?? {};
  const setParty = (p: Partial<PartySnapshotInput>) => setV((c) => ({ ...c, party: { ...(c.party ?? {}), ...p } }));
  const setConsignee = (p: Partial<ConsigneeInput>) => setV((c) => ({ ...c, consignee: { ...(c.consignee ?? {}), ...p } }));
  const setDispatch = (p: Partial<DispatchDetailsInput>) => setV((c) => ({ ...c, dispatch: { ...(c.dispatch ?? {}), ...p } }));
  const setOrder = (p: Partial<OrderDetailsInput>) => setV((c) => ({ ...c, orderDetails: { ...(c.orderDetails ?? {}), ...p } }));
  const setExport = (p: Partial<ExportDetailsInput>) => setV((c) => ({ ...c, exportDetails: { ...(c.exportDetails ?? {}), ...p } }));
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => onAccept(v) });
  const regOptions = REGISTRATION_TYPES.map((r) => ({ value: r, label: REG_LABEL[r] ?? r }));

  const items = [
    {
      id: 'party',
      label: 'Buyer / supplier',
      content: (
        <FieldGroup columns={2} description={`Printed on the document instead of the details saved in ${partyName || 'the party ledger'}. Leave blank to use the ledger.`}>
          <Field label="Name on document" optional>
            <TextInput value={party.name ?? ''} maxLength={200} onValueChange={(s) => setParty({ name: s })} />
          </Field>
          <Field label="GSTIN" optional>
            <TextInput value={party.gstin ?? ''} maxLength={15} uppercase mono onValueChange={(s) => setParty({ gstin: s })} />
          </Field>
          <Field label="Address" optional>
            <TextArea value={party.address ?? ''} maxLength={500} autoGrow maxRows={4} onValueChange={(s) => setParty({ address: s })} />
          </Field>
          {stateSelect(party.stateCode, (s) => setParty({ stateCode: s }), 'State')}
          <Field label="Pincode" optional>
            <TextInput value={party.pincode ?? ''} maxLength={6} inputMode="numeric" onValueChange={(s) => setParty({ pincode: s })} />
          </Field>
          <Field label="Registration type" optional>
            <Select<RegistrationType> options={regOptions} value={party.registrationType ?? ''} placeholder="As in the ledger" onChange={(r) => setParty({ registrationType: r })} />
          </Field>
        </FieldGroup>
      ),
    },
    {
      id: 'consignee',
      label: 'Ship to',
      content: (
        <FieldGroup columns={2} description="Where the goods go, when different from the buyer. The consignee's state decides the place of supply for goods.">
          <Field label="Consignee name" optional>
            <TextInput value={consignee.name ?? ''} maxLength={200} onValueChange={(s) => setConsignee({ name: s })} />
          </Field>
          <Field label="GSTIN" optional>
            <TextInput value={consignee.gstin ?? ''} maxLength={15} uppercase mono onValueChange={(s) => setConsignee({ gstin: s })} />
          </Field>
          <Field label="Address" optional>
            <TextArea value={consignee.address ?? ''} maxLength={500} autoGrow maxRows={4} onValueChange={(s) => setConsignee({ address: s })} />
          </Field>
          {stateSelect(consignee.stateCode, (s) => setConsignee({ stateCode: s }), 'State')}
          <Field label="Pincode" optional>
            <TextInput value={consignee.pincode ?? ''} maxLength={6} inputMode="numeric" onValueChange={(s) => setConsignee({ pincode: s })} />
          </Field>
        </FieldGroup>
      ),
    },
    {
      id: 'dispatch',
      label: showEway ? 'Dispatch & e-way bill' : 'Dispatch',
      content: (
        <FieldGroup columns={2}>
          <Field label="Dispatch doc no." optional>
            <TextInput value={dispatch.docNo ?? ''} maxLength={50} onValueChange={(s) => setDispatch({ docNo: s })} />
          </Field>
          <Field label="Dispatched through" optional>
            <TextInput value={dispatch.through ?? ''} maxLength={100} onValueChange={(s) => setDispatch({ through: s })} />
          </Field>
          <Field label="Destination" optional>
            <TextInput value={dispatch.destination ?? ''} maxLength={100} onValueChange={(s) => setDispatch({ destination: s })} />
          </Field>
          <Field label="Mode of transport" optional>
            <Select
              options={[
                { value: 'road', label: 'Road' },
                { value: 'rail', label: 'Rail' },
                { value: 'air', label: 'Air' },
                { value: 'ship', label: 'Ship' },
              ]}
              value={dispatch.mode ?? ''}
              placeholder="Choose"
              onChange={(m) => setDispatch({ mode: m })}
            />
          </Field>
          <Field label="Vehicle no." optional>
            <TextInput value={dispatch.vehicleNo ?? ''} maxLength={20} uppercase onValueChange={(s) => setDispatch({ vehicleNo: s })} />
          </Field>
          <Field label="Distance (km)" optional hint={showEway ? 'Needed for the e-way bill' : undefined}>
            <NumberInput value={dispatch.distanceKm ?? null} min={0} max={4000} onChange={(n) => setDispatch({ distanceKm: n ?? undefined })} />
          </Field>
          <Field label="Transporter name" optional>
            <TextInput value={dispatch.transporterName ?? ''} maxLength={100} onValueChange={(s) => setDispatch({ transporterName: s })} />
          </Field>
          <Field label="Transporter ID / GSTIN" optional>
            <TextInput value={dispatch.transporterId ?? ''} maxLength={15} uppercase mono onValueChange={(s) => setDispatch({ transporterId: s })} />
          </Field>
          <Field label="LR / RR no." optional>
            <TextInput value={dispatch.lrNo ?? ''} maxLength={50} onValueChange={(s) => setDispatch({ lrNo: s })} />
          </Field>
          <Field label="LR / RR date" optional>
            <DateInput value={dispatch.lrDate ?? null} referenceDate={date} onChange={(d) => setDispatch({ lrDate: d ?? undefined })} />
          </Field>
        </FieldGroup>
      ),
    },
    {
      id: 'order',
      label: 'Order',
      content: (
        <FieldGroup columns={2}>
          <Field label="Order no." optional>
            <TextInput value={order.orderNo ?? ''} maxLength={50} onValueChange={(s) => setOrder({ orderNo: s })} />
          </Field>
          <Field label="Order date" optional>
            <DateInput value={order.orderDate ?? null} referenceDate={date} onChange={(d) => setOrder({ orderDate: d ?? undefined })} />
          </Field>
          <Field label="Buyer's order no." optional>
            <TextInput value={order.buyersOrderNo ?? ''} maxLength={50} onValueChange={(s) => setOrder({ buyersOrderNo: s })} />
          </Field>
          <Field label="Delivery note no." optional>
            <TextInput value={order.deliveryNoteNo ?? ''} maxLength={50} onValueChange={(s) => setOrder({ deliveryNoteNo: s })} />
          </Field>
          <Field label="Terms of payment / delivery" optional>
            <TextInput value={order.terms ?? ''} maxLength={200} onValueChange={(s) => setOrder({ terms: s })} />
          </Field>
          <Field label="Other references" optional>
            <TextInput value={order.otherRefs ?? ''} maxLength={200} onValueChange={(s) => setOrder({ otherRefs: s })} />
          </Field>
        </FieldGroup>
      ),
    },
    ...(showExport
      ? [
          {
            id: 'export',
            label: 'Export / SEZ',
            content: (
              <FieldGroup columns={2} description="For exports and supplies to SEZ units. Without payment of IGST the supply is under your Letter of Undertaking (LUT).">
                <Field label="With payment of IGST">
                  <Switch checked={exp.withPayment === true} onChange={(c) => setExport({ withPayment: c })} />
                </Field>
                <Field label="Port code" optional>
                  <TextInput value={exp.portCode ?? ''} maxLength={10} uppercase mono onValueChange={(s) => setExport({ portCode: s })} />
                </Field>
                <Field label="Shipping bill no." optional>
                  <TextInput value={exp.shippingBillNo ?? ''} maxLength={20} onValueChange={(s) => setExport({ shippingBillNo: s })} />
                </Field>
                <Field label="Shipping bill date" optional>
                  <DateInput value={exp.shippingBillDate ?? null} referenceDate={date} onChange={(d) => setExport({ shippingBillDate: d ?? undefined })} />
                </Field>
                <Field label="Currency" optional>
                  <TextInput value={exp.currency ?? ''} maxLength={3} uppercase onValueChange={(s) => setExport({ currency: s })} />
                </Field>
                <Field label="Exchange rate" optional>
                  <NumberInput value={exp.exchangeRate ?? null} decimals={4} min={0} onChange={(n) => setExport({ exchangeRate: n ?? undefined })} />
                </Field>
              </FieldGroup>
            ),
          },
        ]
      : []),
    ...(showEffectiveDate
      ? [
          {
            id: 'effective',
            label: 'Effective date',
            content: (
              <Field label="Effective date" hint="The date the entry takes effect, when different from the voucher date.">
                <DateInput value={v.effectiveDate} referenceDate={date} onChange={(d) => setV((c) => ({ ...c, effectiveDate: d }))} />
              </Field>
            ),
          },
        ]
      : []),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="More details"
      description="Buyer, consignee, dispatch, order and export details printed on the document and used for GST and e-way bills."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={() => onAccept(v)}>
            Accept
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => onAccept(v) }} />
      <div ref={formRef}>
        <Tabs aria-label="Detail sections" items={items} value={tab} onChange={setTab} keepMounted />
      </div>
    </Modal>
  );
}

// ───────────────────────────── Tracking documents (Alt+T) ─────────────────────────────

export interface TrackingDialogProps {
  partyLedgerId: number;
  kinds: readonly TrackingKind[];
  excludeVoucherId: number | null;
  /** Refs already on the voucher (pre-ticked off). */
  usedRefs: readonly string[];
  onAccept: (picked: Array<{ doc: TrackingDoc; kind: TrackingKind }>) => void;
  onClose: () => void;
}

export function TrackingDialog({ partyLedgerId, kinds, excludeVoucherId, usedRefs, onAccept, onClose }: TrackingDialogProps) {
  const [kind, setKind] = useState<TrackingKind>(kinds[0]);
  const input = excludeVoucherId === null ? { partyLedgerId, kind } : { partyLedgerId, kind, excludeVoucherId };
  const q = useApiQuery('vouchers.trackingRefs', input);
  const [picked, setPicked] = useState<Map<string, { doc: TrackingDoc; kind: TrackingKind }>>(new Map());
  const docs = q.data ?? [];
  const toggle = (doc: TrackingDoc) =>
    setPicked((cur) => {
      const next = new Map(cur);
      const k = `${kind}:${doc.voucherId}`;
      if (next.has(k)) next.delete(k);
      else next.set(k, { doc, kind });
      return next;
    });
  const accept = () => {
    if (picked.size > 0) onAccept([...picked.values()]);
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Fill from earlier documents"
      description="Tick the open delivery/receipt notes or orders of this party to bring their pending items into this voucher."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={picked.size === 0} onClick={accept}>
            Add {picked.size > 0 ? `${picked.size} document${picked.size === 1 ? '' : 's'}` : 'items'}
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => accept() }} />
      {kinds.length > 1 ? (
        <Tabs aria-label="Document kind" variant="pill" items={kinds.map((k) => ({ id: k, label: TRACKING_KIND_LABEL[k] }))} value={kind} onChange={(k) => setKind(k as TrackingKind)} />
      ) : null}
      {q.loading ? (
        <p className="bx-muted">Loading…</p>
      ) : docs.length === 0 ? (
        <EmptyState size="sm" icon="file" title={`No open ${TRACKING_KIND_LABEL[kind].toLowerCase()}`} body="Everything for this party has been billed already." />
      ) : (
        <ul className="bx-vch-track">
          {docs.map((d) => {
            const used = usedRefs.includes(d.ref);
            const k = `${kind}:${d.voucherId}`;
            return (
              <li key={k} className="bx-vch-track__doc">
                <Checkbox
                  checked={picked.has(k)}
                  disabled={used}
                  onChange={() => toggle(d)}
                  label={`${d.voucherTypeName} ${d.number ?? d.ref} · ${formatDate(d.date)}`}
                  description={used ? 'Already on this voucher' : d.lines.map((l) => `${l.itemName}: ${formatQty(l.pendingQty, 3, l.unit)} pending of ${formatQty(l.qty, 3, l.unit)}`).join(' · ')}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

// ───────────────────────────── Cancel with reason ─────────────────────────────

export interface ReasonDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  required: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export function ReasonDialog({ title, message, confirmLabel, required, busy, error, onConfirm, onClose }: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const ok = !required || reason.trim().length > 0;
  const go = () => {
    if (ok && !busy) onConfirm(reason.trim());
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      role="alertdialog"
      title={title}
      description={message}
      footer={
        <>
          <Button onClick={onClose}>Go back</Button>
          <Button variant="danger" shortcut="Ctrl+A" loading={busy} disabled={!ok} onClick={go}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => go() }} />
      <Field label="Reason" required={required} optional={!required} hint="Kept in the edit log." error={error ?? undefined}>
        <TextArea value={reason} maxLength={500} autoGrow maxRows={5} onValueChange={setReason} data-autofocus />
      </Field>
    </Modal>
  );
}

// ───────────────────────────── F10: switch voucher type ─────────────────────────────

export interface TypeSwitchDialogProps {
  types: readonly VoucherTypeRow[];
  currentId: number;
  isAvailable: (baseType: VoucherBaseType) => boolean;
  onPick: (t: VoucherTypeRow) => void;
  onClose: () => void;
}

export function TypeSwitchDialog({ types, currentId, isAvailable, onPick, onClose }: TypeSwitchDialogProps) {
  const items = useMemo(() => types.filter((t) => t.isActive && isAvailable(t.baseType)), [types, isAvailable]);
  return (
    <Modal open onClose={onClose} size="md" title="Change voucher type" description="Pick the type of voucher to enter. The date is kept.">
      <Field label="Voucher type">
        <Combobox<VoucherTypeRow>
          items={items}
          getKey={(t) => String(t.id)}
          getLabel={(t) => t.name}
          getAlias={(t) => t.abbreviation}
          rightMeta={(t) => (t.hotkey ? <span className="bx-muted">{t.hotkey}</span> : null)}
          value={null}
          onChange={(t) => {
            if (t && t.id !== currentId) onPick(t);
          }}
          onCommit={(t) => {
            if (t && t.id !== currentId) onPick(t);
            else onClose();
          }}
          autoFocus
          placeholder="Type Sales, Payment, Journal…"
          emptyText="No voucher type matches"
        />
      </Field>
    </Modal>
  );
}

// ───────────────────────────── F12: configuration hints ─────────────────────────────

export interface ConfigHintsDialogProps {
  ctx: VoucherEntryContext;
  onClose: () => void;
}

const NUMBERING_LABEL = { automatic: 'Automatic', automatic_override: 'Automatic (you may type a number)', manual: 'Manual (type every number)', none: 'Not numbered' } as const;

export function ConfigHintsDialog({ ctx, onClose }: ConfigHintsDialogProps) {
  const nav = useNav();
  const t = ctx.voucherType;
  const c = ctx.config;
  const guard = (g: string) => (g === 'block' ? 'Not allowed' : g === 'warn' ? 'Warn before saving' : 'Allowed');
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`${t.name} — settings`}
      description="How this voucher type behaves. Change them in the voucher type master or in Configuration (F12)."
      footer={
        <>
          <Button
            onClick={() => {
              onClose();
              nav.push('company.config');
            }}
          >
            Company configuration
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              nav.push('accounts.voucherType.form', { id: t.id });
            }}
          >
            Voucher type settings
          </Button>
        </>
      }
    >
      <KeyValueList
        items={[
          { label: 'Numbering', value: `${NUMBERING_LABEL[t.numberingMethod]}${ctx.nextNumber ? ` · next ${ctx.nextNumber}` : ''}` },
          { label: 'Print after saving', value: c.printAfterSave || t.printAfterSave ? 'Yes' : 'No' },
          { label: 'Optional by default', value: t.optionalByDefault ? 'Yes' : 'No' },
          { label: 'Narration for each line', value: t.narrationPerEntry ? 'Yes' : 'No' },
          { label: 'Round off invoices', value: c.roundOff.enabled ? `To ₹ ${formatMoney(c.roundOff.unit)} (${c.roundOff.method})` : 'No' },
          { label: 'Negative stock', value: guard(c.guards.negativeStock) },
          { label: 'Negative cash', value: guard(c.guards.negativeCash) },
          { label: 'Credit limit exceeded', value: guard(c.guards.creditLimit) },
          { label: 'Books locked up to', value: c.lockedUpTo ? formatDate(c.lockedUpTo) : 'Not locked' },
        ]}
      />
      {!ctx.permissions.canBackdate ? (
        <Banner tone="info" inline>
          You can enter vouchers dated today or later. Ask an administrator for back-dated entry.
        </Banner>
      ) : null}
    </Modal>
  );
}
