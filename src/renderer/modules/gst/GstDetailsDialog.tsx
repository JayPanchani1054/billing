/**
 * Voucher entry › Alt+J "GST details" (Tally: Stat Adjustment / advance / bill of entry) — the GST side of
 * a voucher that is not an ordinary invoice line. The vouchers module opens it and keeps the value in
 * the form (`VoucherForm.gstDetails` → `VoucherInput.gstDetails`); the gst voucher hook posts and
 * derives it (src/core/modules/gst/hook.ts). One section per base type (lib/gstplus.ts gstDetailsKinds):
 *   Receipt      advance against a future supply (rate, POS, goods / services)      → GSTR-1 11A, 3B 3.1(a)
 *   Payment      refund of an advance (Rule 51 refund voucher) / GST challan (PMT-06) → 11B / cash ledger
 *   Sales / debit note to a customer   advances adjusted on this invoice           → 11B
 *   Purchase     bill of entry of imported goods (BOE no., date, port, values, IGST)  → 3B 4(A)(1)
 *   Journal      stat adjustment nature (ITC reversal Rules 42 / 43 / 37 / 37A / s.17(5), reclaim,
 *                reverse-charge liability)                                          → 3B 4(B), 4(D), 3.1(d)
 * Ctrl+A applies (the voucher is saved with Ctrl+A on the voucher screen); Esc closes without changes.
 */
import { useMemo, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { rateOptions, stateOptions } from '../../../shared/gst/index.ts';
import type { AdvanceRefInput, CashMinorHead, GstAdjustmentNature, VoucherGstDetailsInput } from '../../../shared/types/gst-plus.ts';
import { CASH_MINOR_HEADS, GST_ADJUSTMENT_3B_ROW } from '../../../shared/types/gst-plus.ts';
import type { TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { formatDate, formatMoney, useApiQuery, useAppState } from '../../app/index.ts';
import { AmountInput, Banner, Button, Checkbox, DateInput, EmptyState, Field, Hotkeys, Modal, SegmentedControl, Select, Stack, TextInput, useEnterAdvance } from '../../ui/index.ts';
import { WideTable } from './components.tsx';
import { ADJUSTMENT_OPTIONS, boeFieldErrors, challanFieldErrors, challanGrid, gridToHeads, gstDetailsKinds, HEAD_NAMES, MINOR_LABELS, periodKeyError } from './lib/gstplus.ts';

export interface GstDetailsDialogProps {
  baseType: VoucherBaseType;
  /** Debit note to a customer (outward) — it can adjust advances like a sale. */
  outward: boolean;
  date: string;
  partyLedgerId: number | null;
  value: VoucherGstDetailsInput | null;
  /** Called with the new details (null = none) when the user accepts. */
  onApply: (value: VoucherGstDetailsInput | null) => void;
  onClose: () => void;
}

type Grid = Record<TaxHead, Record<CashMinorHead, number>>;

export function GstDetailsDialog({ baseType, outward, date, partyLedgerId, value, onApply, onClose }: GstDetailsDialogProps) {
  const app = useAppState();
  const composition = app.company?.gstRegistration === 'composition';
  const kinds = gstDetailsKinds(baseType, outward);
  const v = value ?? {};

  // Receipt: advance.
  const [advOn, setAdvOn] = useState(v.advance !== undefined);
  const [supplyType, setSupplyType] = useState<'goods' | 'services'>(v.advance?.supplyType ?? 'services');
  const [rate, setRate] = useState<number>(v.advance?.rate ?? 18);
  const [pos, setPos] = useState(v.advance?.placeOfSupply ?? '');
  const [advAmount, setAdvAmount] = useState<number | null>(v.advance?.amount ?? null);

  // Payment: refund / challan. Sales: adjustments.
  const [payKind, setPayKind] = useState<'none' | 'refund' | 'challan'>(v.advanceRefund ? 'refund' : v.challan ? 'challan' : 'none');
  const [refund, setRefund] = useState<AdvanceRefInput | null>(v.advanceRefund ?? null);
  const [adjust, setAdjust] = useState<Record<number, number>>(() => Object.fromEntries((v.advanceAdjustments ?? []).map((a) => [a.receiptVoucherId, a.amount])));
  const needsPending = kinds.includes('adjust') || (kinds.includes('refund') && payKind === 'refund');
  const pending = useApiQuery('gst.advances.pending', { asOf: date, ...(partyLedgerId !== null ? { partyLedgerId } : {}) }, { enabled: needsPending, staleTime: 0 });
  const pendingRows = useMemo(() => {
    // An alteration: the advances this voucher already uses are not "pending" any more — keep them listed.
    const rows = [...(pending.data ?? [])];
    for (const a of [...(v.advanceAdjustments ?? []), ...(v.advanceRefund ? [v.advanceRefund] : [])]) {
      if (!rows.some((r) => r.receiptVoucherId === a.receiptVoucherId)) {
        rows.push({ receiptVoucherId: a.receiptVoucherId, number: `#${a.receiptVoucherId}`, date: '', partyLedgerId: null, partyName: null, pos: '', rate: 0, gross: a.amount, pending: 0 });
      }
    }
    return rows;
  }, [pending.data, v.advanceAdjustments, v.advanceRefund]);

  const [cpin, setCpin] = useState(v.challan?.cpin ?? '');
  const [cin, setCin] = useState(v.challan?.cin ?? '');
  const [brn, setBrn] = useState(v.challan?.brn ?? '');
  const [challanDate, setChallanDate] = useState<string | null>(v.challan?.challanDate ?? date);
  const [bankName, setBankName] = useState(v.challan?.bankName ?? '');
  const [challanPeriod, setChallanPeriod] = useState(v.challan?.period ?? '');
  const [grid, setGrid] = useState<Grid>(() => challanGrid(v.challan?.heads ?? []));

  // Purchase: bill of entry.
  const [boeOn, setBoeOn] = useState(v.billOfEntry !== undefined);
  const [boeNo, setBoeNo] = useState(v.billOfEntry?.number ?? '');
  const [boeDate, setBoeDate] = useState<string | null>(v.billOfEntry?.date ?? date);
  const [port, setPort] = useState(v.billOfEntry?.portCode ?? '');
  const [assessable, setAssessable] = useState<number | null>(v.billOfEntry?.assessableValue ?? null);
  const [duty, setDuty] = useState<number | null>(v.billOfEntry?.customsDuty ?? null);
  const [igst, setIgst] = useState<number | null>(v.billOfEntry?.igst ?? null);
  const [cess, setCess] = useState<number | null>(v.billOfEntry?.cess ?? null);

  // Journal: stat adjustment.
  const [nature, setNature] = useState<GstAdjustmentNature | ''>(v.adjustment?.nature ?? '');
  const [adjPeriod, setAdjPeriod] = useState(v.adjustment?.period ?? '');
  const [rcmTaxable, setRcmTaxable] = useState<number | null>(v.adjustment?.taxableValue ?? null);

  const challanErrs = payKind === 'challan' ? challanFieldErrors({ cpin, cin }) : {};
  const challanPeriodErr = payKind === 'challan' ? periodKeyError(challanPeriod) : undefined;
  const boeErrs = boeOn ? boeFieldErrors({ number: boeNo, date: boeDate, portCode: port, assessableValue: assessable, igst }) : {};
  const adjPeriodErr = nature ? periodKeyError(adjPeriod) : undefined;
  const blocked = Object.keys(challanErrs).length > 0 || Object.keys(boeErrs).length > 0 || challanPeriodErr !== undefined || adjPeriodErr !== undefined;

  const build = (): VoucherGstDetailsInput | null => {
    const out: VoucherGstDetailsInput = {};
    if (v.setoff) out.setoff = v.setoff; // posted by GST Set-off; kept as is
    if (kinds.includes('advance') && advOn) {
      out.advance = { supplyType, rate: supplyType === 'goods' ? 0 : rate, ...(pos ? { placeOfSupply: pos } : {}), ...(advAmount !== null && advAmount > 0 ? { amount: advAmount } : {}) };
    }
    if (kinds.includes('refund') && payKind === 'refund' && refund && refund.amount > 0) out.advanceRefund = refund;
    if (kinds.includes('challan') && payKind === 'challan') {
      out.challan = {
        cpin: cpin.trim(),
        ...(cin.trim() ? { cin: cin.trim() } : {}),
        ...(brn.trim() ? { brn: brn.trim() } : {}),
        ...(challanDate ? { challanDate } : {}),
        ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
        ...(v.challan?.mode ? { mode: v.challan.mode } : {}),
        ...(challanPeriod.trim() ? { period: challanPeriod.trim() } : {}),
        heads: gridToHeads(grid),
      };
    }
    if (kinds.includes('adjust')) {
      const list = Object.entries(adjust)
        .filter(([, amt]) => amt > 0)
        .map(([id, amt]) => ({ receiptVoucherId: Number(id), amount: amt }));
      if (list.length > 0) out.advanceAdjustments = list;
    }
    if (kinds.includes('boe') && boeOn) {
      out.billOfEntry = {
        number: boeNo.trim(),
        date: boeDate ?? date,
        ...(port.trim() ? { portCode: port.trim().toUpperCase() } : {}),
        assessableValue: assessable ?? 0,
        ...(duty ? { customsDuty: duty } : {}),
        igst: igst ?? 0,
        ...(cess ? { cess } : {}),
        ...(v.billOfEntry?.creditLedgerId !== undefined ? { creditLedgerId: v.billOfEntry.creditLedgerId } : {}),
      };
    }
    if (kinds.includes('adjustment') && nature) {
      out.adjustment = { nature, ...(adjPeriod.trim() ? { period: adjPeriod.trim() } : {}), ...(nature === 'rcm_liability' && rcmTaxable ? { taxableValue: rcmTaxable } : {}) };
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  const accept = (): void => {
    if (blocked) return;
    onApply(build());
    onClose();
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  const stateOpts = useMemo(() => stateOptions({ includeForeign: true }).map((s) => ({ value: s.value, label: s.label })), []);
  const rates = useMemo(() => rateOptions().filter((r) => r.value > 0).map((r) => ({ value: String(r.value), label: r.label })), []);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="GST details"
      description="The GST side of this voucher that is not an invoice line. Saved with the voucher (Ctrl+A on the voucher)."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={blocked} onClick={accept}>
            Apply
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': accept }} />
      <div ref={formRef}>
        <Stack gap={3}>
          {kinds.length === 0 ? <EmptyState size="sm" title="Nothing to add for this voucher type" body="GST details apply to receipts, payments, sales, purchases and journals." /> : null}

          {kinds.includes('advance') ? (
            composition ? (
              <Banner tone="info" inline>
                Composition taxpayers pay tax on turnover through CMP-08; advances are not reported separately.
              </Banner>
            ) : (
              <>
                <Checkbox data-autofocus checked={advOn} onChange={setAdvOn} label="Advance received against a future supply" />
                {advOn ? (
                  <div className="bx-gst-formgrid">
                    <Field label="Supply">
                      <SegmentedControl
                        aria-label="Supply"
                        size="sm"
                        value={supplyType}
                        onChange={setSupplyType}
                        options={[
                          { value: 'services', label: 'Services' },
                          { value: 'goods', label: 'Goods' },
                        ]}
                      />
                    </Field>
                    <Field label="GST rate" hint={supplyType === 'goods' ? 'No tax on advances for goods (Notification 66/2017-CT)' : 'Rate of the service'}>
                      <Select value={String(rate)} disabled={supplyType === 'goods'} options={rates} onChange={(x) => setRate(Number(x))} />
                    </Field>
                    <Field label="Place of supply" optional hint="Default: the customer's state">
                      <Select value={pos} placeholder="Customer's state" options={[{ value: '', label: "Customer's state" }, ...stateOpts]} onChange={setPos} />
                    </Field>
                    <Field label="Advance (incl. tax)" optional hint="Default: the amount received">
                      <AmountInput value={advAmount} onChange={setAdvAmount} />
                    </Field>
                  </div>
                ) : null}
              </>
            )
          ) : null}

          {kinds.includes('refund') || kinds.includes('challan') ? (
            <Field label="This payment is">
              <SegmentedControl
                aria-label="Payment kind"
                size="sm"
                value={payKind}
                onChange={setPayKind}
                options={[
                  { value: 'none', label: 'Ordinary payment' },
                  { value: 'refund', label: 'Refund of an advance' },
                  { value: 'challan', label: 'GST challan (PMT-06)' },
                ]}
              />
            </Field>
          ) : null}

          {payKind === 'refund' && kinds.includes('refund') ? (
            <AdvancePicker
              rows={pendingRows}
              loading={pending.loading}
              values={refund ? { [refund.receiptVoucherId]: refund.amount } : {}}
              single
              onChange={(id, amt) => setRefund(amt > 0 ? { receiptVoucherId: id, amount: amt } : null)}
              help="Refund voucher (Rule 51): the tax paid on the refunded part is reversed in 11B."
            />
          ) : null}

          {payKind === 'challan' && kinds.includes('challan') ? (
            <>
              <Banner tone="info" inline>
                Debit "GST Electronic Cash Ledger" with the total and credit the bank. GST Set-off (Alt+C there) fills this in for you.
              </Banner>
              <div className="bx-gst-formgrid">
                <Field label="CPIN" required error={cpin ? challanErrs.cpin : undefined}>
                  <TextInput value={cpin} onChange={(e) => setCpin(e.target.value.replace(/\s/g, ''))} maxLength={14} inputMode="numeric" />
                </Field>
                <Field label="CIN" optional error={challanErrs.cin}>
                  <TextInput value={cin} onChange={(e) => setCin(e.target.value.replace(/\s/g, '').toUpperCase())} maxLength={17} />
                </Field>
                <Field label="BRN" optional>
                  <TextInput value={brn} onChange={(e) => setBrn(e.target.value)} maxLength={40} />
                </Field>
                <Field label="Challan date" optional>
                  <DateInput value={challanDate} onChange={setChallanDate} referenceDate={date} />
                </Field>
                <Field label="Bank" optional>
                  <TextInput value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={100} />
                </Field>
                <Field label="Return period" optional hint="The return this pays, e.g. 092026 or 2026-27-Q2 (GST Set-off lists challans by it)" error={challanPeriodErr}>
                  <TextInput value={challanPeriod} onChange={(e) => setChallanPeriod(e.target.value.trim())} maxLength={10} />
                </Field>
              </div>
              <WideTable label="Challan amounts">
                <thead>
                  <tr>
                    <th scope="col">Major head</th>
                    {CASH_MINOR_HEADS.map((m) => (
                      <th key={m} scope="col" className="is-num">
                        {MINOR_LABELS[m]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TAX_HEADS.map((h) => (
                    <tr key={h}>
                      <th scope="row">{HEAD_NAMES[h]}</th>
                      {CASH_MINOR_HEADS.map((m) => (
                        <td key={m} className="is-num">
                          <AmountInput size="sm" aria-label={`${HEAD_NAMES[h]} ${MINOR_LABELS[m]}`} value={grid[h][m] || null} onChange={(x) => setGrid((g) => ({ ...g, [h]: { ...g[h], [m]: x ?? 0 } }))} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </WideTable>
            </>
          ) : null}

          {kinds.includes('adjust') ? (
            <AdvancePicker
              rows={pendingRows}
              loading={pending.loading}
              values={adjust}
              onChange={(id, amt) => setAdjust((a) => ({ ...a, [id]: amt }))}
              help={
                partyLedgerId === null
                  ? 'Choose the party first to see its advances.'
                  : 'Amount (incl. tax) of each advance this invoice bills. Leave blank to use the bill-wise "Against" allocations on advance bills.'
              }
            />
          ) : null}

          {kinds.includes('boe') ? (
            <>
              <Checkbox data-autofocus checked={boeOn} onChange={setBoeOn} label="Import of goods — bill of entry" />
              {boeOn ? (
                <div className="bx-gst-formgrid">
                  <Field label="BOE number" required error={boeErrs.number}>
                    <TextInput value={boeNo} onChange={(e) => setBoeNo(e.target.value)} maxLength={20} />
                  </Field>
                  <Field label="BOE date" required error={boeErrs.date}>
                    <DateInput value={boeDate} onChange={setBoeDate} referenceDate={date} />
                  </Field>
                  <Field label="Port code" optional hint="Six characters, e.g. INNSA1" error={boeErrs.portCode}>
                    <TextInput value={port} onChange={(e) => setPort(e.target.value.toUpperCase())} maxLength={6} />
                  </Field>
                  <Field label="Assessable value" required error={boeErrs.assessableValue}>
                    <AmountInput value={assessable} onChange={setAssessable} />
                  </Field>
                  <Field label="Customs duty (BCD + SWS)" optional hint="For information; posted with the purchase">
                    <AmountInput value={duty} onChange={setDuty} />
                  </Field>
                  <Field label="IGST paid at customs" required error={boeErrs.igst}>
                    <AmountInput value={igst} onChange={setIgst} />
                  </Field>
                  <Field label="Compensation cess" optional>
                    <AmountInput value={cess} onChange={setCess} />
                  </Field>
                </div>
              ) : null}
            </>
          ) : null}

          {kinds.includes('adjustment') ? (
            v.setoff ? (
              <Banner tone="info" inline>
                This journal was posted by GST Set-off for {v.setoff.period}. Delete it and post the set-off again to change it.
              </Banner>
            ) : (
              <>
                <Field label="Stat adjustment" hint={nature ? `Reported in GSTR-3B ${GST_ADJUSTMENT_3B_ROW[nature]}` : 'Leave empty for an ordinary journal'}>
                  <Select
                    data-autofocus
                    value={nature}
                    options={[{ value: '', label: 'None (ordinary journal)' }, ...ADJUSTMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))]}
                    onChange={(x) => setNature(x as GstAdjustmentNature | '')}
                  />
                </Field>
                {nature ? (
                  <div className="bx-gst-formgrid">
                    <Field label="Return period" optional hint="e.g. 092026 or 2026-27-Q2; default: the voucher date's period" error={adjPeriodErr}>
                      <TextInput value={adjPeriod} onChange={(e) => setAdjPeriod(e.target.value)} maxLength={10} />
                    </Field>
                    {nature === 'rcm_liability' ? (
                      <Field label="Taxable value (3.1(d))" optional>
                        <AmountInput value={rcmTaxable} onChange={setRcmTaxable} />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
                {nature ? <p className="bx-muted">{adjustmentHelp(nature)}</p> : null}
              </>
            )
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}

/** How to enter the journal lines for each nature (Dr / Cr of the GST ledgers). */
function adjustmentHelp(n: GstAdjustmentNature): string {
  if (n === 'rcm_liability') return 'Credit the reverse-charge payable (Output) tax ledgers and, where credit is available, debit the Input tax ledgers.';
  if (n === 'itc_reclaim') return 'Debit the Input tax ledgers with the credit reclaimed and credit the account debited when it was reversed (e.g. "ITC Reversed (GST)").';
  return 'Credit the Input tax ledgers with the credit reversed and debit an expense (e.g. "ITC Reversed (GST)") or the asset / the supplier as appropriate.';
}

function AdvancePicker({
  rows,
  loading,
  values,
  onChange,
  single,
  help,
}: {
  rows: ReadonlyArray<{ receiptVoucherId: number; number: string | null; date: string; partyName: string | null; rate: number; gross: number; pending: number }>;
  loading: boolean;
  values: Readonly<Record<number, number>>;
  onChange: (receiptVoucherId: number, amount: number) => void;
  single?: boolean;
  help: string;
}) {
  return (
    <Stack gap={2}>
      <p className="bx-muted">{help}</p>
      {rows.length === 0 ? (
        <EmptyState size="sm" icon="receipt" title={loading ? 'Loading advances…' : 'No pending advance'} body={loading ? undefined : 'Advances come from receipts marked as an advance (Alt+J on the receipt).'} />
      ) : (
        <WideTable label="Pending advances">
          <thead>
            <tr>
              <th scope="col">Receipt</th>
              <th scope="col">Date</th>
              <th scope="col">Party</th>
              <th scope="col" className="is-num">Rate</th>
              <th scope="col" className="is-num">Pending</th>
              <th scope="col" className="is-num">{single ? 'Refund' : 'Adjust now'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.receiptVoucherId}>
                <th scope="row">{r.number ?? ''}</th>
                <td>{r.date ? formatDate(r.date) : ''}</td>
                <td>{r.partyName ?? ''}</td>
                <td className="is-num">{r.rate ? `${r.rate}%` : ''}</td>
                <td className="is-num">{formatMoney(r.pending)}</td>
                <td className="is-num">
                  <AmountInput
                    size="sm"
                    aria-label={`Amount for receipt ${r.number ?? r.receiptVoucherId}`}
                    value={values[r.receiptVoucherId] || null}
                    onChange={(x) => onChange(r.receiptVoucherId, x ?? 0)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </WideTable>
      )}
    </Stack>
  );
}
