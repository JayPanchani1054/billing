/**
 * TDS / TCS panel of voucher entry (rendered by vouchers.entry in its side column when F11 › TDS is
 * on for purchase / journal / payment, or TCS for sales). Shows what the server computed in the last
 * check (vouchers.preview › tds): section, base, rate, amount, threshold notes. Alt+U ("TDS / TCS")
 * opens a dialog to change an amount (with a reason — audited and listed in TDS/TCS › Exceptions) or
 * choose the nature for an advance / a journal without TDS-applicable ledgers.
 */
import { useMemo, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { TdsVoucherLine, TdsVoucherPreview, VoucherTdsInput } from '../../../shared/types/tds.ts';
import type { VoucherMode } from '../../../shared/types/vouchers.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useScreenActions } from '../../app/nav.tsx';
import { useFeatures } from '../../app/state.tsx';
import { AmountInput, Badge, Button, Field, Hotkeys, Kbd, Modal, Select, Stack, TextInput, useEnterAdvance } from '../../ui/index.ts';
import { applyOverrideEdits, KIND_LABEL, lineSummary, overrideEditsOf, overrideErrors, STATUS_LABEL, tdsApplies, type OverrideEdit } from './lib/model.ts';

export interface TdsEntryPanelProps {
  baseType: VoucherBaseType;
  mode: VoucherMode;
  /** The form's `tds` (null = automatic). */
  value: VoucherTdsInput | null;
  /** `tds` of the latest server check (undefined: none yet / nothing to compute). */
  preview: TdsVoucherPreview | null | undefined;
  checking?: boolean;
  readOnly?: boolean;
  onChange: (next: VoucherTdsInput | null) => void;
}

const inr = (p: number): string => formatMoney(p, { symbol: true });

export function TdsEntryPanel(props: TdsEntryPanelProps) {
  const features = useFeatures();
  const applies = tdsApplies(props.baseType, features);
  const [open, setOpen] = useState(false);
  const isChallan = !!props.value?.challan;
  useScreenActions(
    applies && !isChallan ? [{ key: 'Alt+U', label: 'TDS / TCS', icon: 'percent', group: 'details', disabled: props.readOnly, onClick: () => setOpen(true) }] : [],
  );
  if (!applies) return null;
  const lines = props.preview?.lines ?? [];
  const kind = props.baseType === 'sales' ? 'tcs' : 'tds';
  const total = kind === 'tcs' ? (props.preview?.tcs ?? 0) : (props.preview?.tds ?? 0);
  return (
    <section className="bx-vch-side" aria-label={`${KIND_LABEL[kind]} on this voucher`} aria-live="polite">
      <h3 className="bx-vch-side__title">
        {KIND_LABEL[kind]} {props.checking ? <span className="bx-muted">· checking…</span> : null}
      </h3>
      <Stack gap={1}>
        {isChallan ? (
          <span className="bx-muted">
            Challan {props.value?.challan?.challanNo} (BSR {props.value?.challan?.bsrCode}) for {props.value?.challan?.section}, {props.value?.challan?.period}. Alter it in TDS/TCS ›
            Challan Register.
          </span>
        ) : lines.length === 0 ? (
          <span className="bx-muted">
            {kind === 'tcs' ? 'No sales ledger with a TCS nature on this invoice.' : 'No TDS-applicable ledger on this voucher.'}
            {kind === 'tds' && (props.baseType === 'payment' || props.baseType === 'journal') ? ' Alt+U to deduct under a nature (e.g. an advance).' : ''}
          </span>
        ) : (
          <>
            {lines.map((l) => (
              <TdsLineView key={`${l.kind}-${l.natureId}`} line={l} />
            ))}
            <span className="bx-num">
              {kind === 'tcs' ? 'TCS added to the invoice' : 'TDS deducted from the party'}: <strong>{inr(total)}</strong>
            </span>
          </>
        )}
        {!isChallan && !props.readOnly ? (
          <Button size="sm" variant="ghost" icon="edit" onClick={() => setOpen(true)}>
            Change <Kbd keys="Alt+U" size="sm" />
          </Button>
        ) : null}
      </Stack>
      {open ? <TdsDialog {...props} lines={lines} kind={kind} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

function TdsLineView({ line: l }: { line: TdsVoucherLine }) {
  return (
    <div title={l.note}>
      <span>{lineSummary(l)}</span>{' '}
      <span className="bx-num">
        <strong>{inr(l.amount)}</strong>
      </span>{' '}
      {l.overridden ? (
        <Badge size="sm" tone="warning">
          Changed
        </Badge>
      ) : l.status !== 'deducted' ? (
        <Badge size="sm">{STATUS_LABEL[l.status]}</Badge>
      ) : null}
      {l.panStatus !== 'valid' && l.partyLedgerId !== null ? (
        <Badge size="sm" tone="warning">
          {l.panStatus === 'invalid' ? 'PAN invalid' : 'No PAN'}
        </Badge>
      ) : null}
      <div className="bx-muted">{l.note}</div>
    </div>
  );
}

function TdsDialog(props: TdsEntryPanelProps & { lines: readonly TdsVoucherLine[]; kind: 'tds' | 'tcs'; onClose: () => void }) {
  const natureable = props.kind === 'tds' && (props.baseType === 'payment' || props.baseType === 'journal' || props.baseType === 'purchase');
  const natures = useApiQuery('tds.natures.list', { kind: 'tds' }, { enabled: natureable, staleTime: 60_000 });
  const [natureId, setNatureId] = useState<number | null>(props.value?.natureId ?? null);
  const [edits, setEdits] = useState<OverrideEdit[]>(() => overrideEditsOf(props.lines, props.value));
  const [tried, setTried] = useState(false);
  const errors = useMemo(() => overrideErrors(edits), [edits]);
  const setEdit = (natureIdOf: number, patch: Partial<OverrideEdit>): void => setEdits((all) => all.map((e) => (e.natureId === natureIdOf ? { ...e, ...patch } : e)));
  const apply = (): void => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    props.onChange(applyOverrideEdits(props.value, edits, natureable ? natureId : undefined));
    props.onClose();
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: apply });
  return (
    <Modal
      open
      onClose={props.onClose}
      size="lg"
      title={`${KIND_LABEL[props.kind]} on this voucher`}
      description="Change an amount only with a reason — it is kept in the edit log and listed under TDS/TCS › Exceptions. The voucher is re-checked after you apply."
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => apply() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          {natureable ? (
            <Field
              label="Deduct under"
              optional
              hint={props.baseType === 'payment' ? 'For an advance: TDS on the amount paid to the party.' : 'When no ledger on the voucher is TDS-applicable: TDS on the party’s amount.'}
            >
              <Select
                data-autofocus
                value={natureId === null ? '' : String(natureId)}
                options={[{ value: '', label: 'Automatic (from the ledgers)' }, ...(natures.data ?? []).map((n) => ({ value: String(n.id), label: `${n.section} — ${n.name}` }))]}
                onChange={(v) => setNatureId(v ? Number(v) : null)}
              />
            </Field>
          ) : null}
          {props.lines.length === 0 ? <span className="bx-muted">Nothing was computed on this voucher in the last check.</span> : null}
          {props.lines.map((l) => {
            const e = edits.find((x) => x.natureId === l.natureId);
            if (!e) return null;
            return (
              <Stack key={l.natureId} gap={1}>
                <strong>
                  {l.section} — {l.natureName}
                </strong>
                <span className="bx-muted">
                  {l.partyName ?? 'No party'} · base {inr(l.base || l.assessable)} · computed {inr(l.computed)} · {l.note}
                </span>
                <Field label="Amount" error={tried ? errors[l.natureId] : undefined}>
                  <AmountInput value={e.amount} onChange={(v) => setEdit(l.natureId, { amount: v })} symbol min={0} />
                </Field>
                <Field label="Reason" optional={(e.amount ?? e.computed) === e.computed}>
                  <TextInput value={e.reason} onValueChange={(v) => setEdit(l.natureId, { reason: v.slice(0, 300) })} placeholder="e.g. nil-deduction certificate applied for; party deducted at source already" />
                </Field>
              </Stack>
            );
          })}
        </Stack>
      </div>
    </Modal>
  );
}
