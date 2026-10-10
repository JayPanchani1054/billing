/**
 * Change Number dialog (Ctrl+R in voucher entry — create and alter — and in voucher view). Needs the
 * permission "Change voucher numbers and the next number" (vouchers.renumber).
 *
 *   Change invoice number
 *     Current number      INV/26-27/0042          (a new voucher: "Next number")
 *     New number          [INV/26-27/0141]  ✓ Available in FY 2026-27 · 14 of 16 characters
 *     Reason (edit log)   [Matching the paper bill book]
 *     [✓] Continue the series from here (next invoice will be INV/26-27/0142)
 *                                           [Cancel Esc] [Use this number Ctrl+A]
 *
 * The number is checked as it is typed ('vouchers.numberCheck', 300 ms after the last key): format (GST
 * documents: ≤ 16 letters, digits, '/' and '-') and uniqueness in the scope the save applies (the
 * financial year for an outward GST document, else the numbering period). The caller decides what
 * "Use this number" does: voucher entry keeps it as the voucher's numberOverride (sent with the save),
 * voucher view calls 'vouchers.renumber'. View-model: lib/changeNumber.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { NumberingScheme } from '../../../shared/numbering.ts';
import type { NumberingMethod, VoucherMode, VoucherNumberOverride } from '../../../shared/types/vouchers.ts';
import { api, userMessage } from '../../app/index.ts';
import { Banner, Button, Checkbox, Field, Hotkeys, KeyValueList, Modal, Stack, TextArea, TextInput, useEnterAdvance } from '../../ui/index.ts';
import { OkHint } from '../accounts/components.tsx';
import {
  changeNumberTitle,
  continueSeriesState,
  NUMBER_CHECK_DEBOUNCE_MS,
  numberMessage,
  numberNoun,
  overrideOf,
  RENUMBER_REASON_MAX,
} from './lib/changeNumber.ts';
import type { NumberCheckState } from './lib/changeNumber.ts';

export interface ChangeNumberDialogProps {
  voucherTypeId: number;
  baseType: VoucherBaseType;
  /** The voucher date (decides the financial year / period of the check). */
  date: string;
  fyStartMonth: number;
  /** A GST document (sales, credit / debit note of a GST company): the 16-character rule. */
  gstDoc: boolean;
  method: NumberingMethod;
  /** The type's numbering scheme (prefix / suffix / width), null while unknown. */
  scheme: Pick<NumberingScheme, 'prefix' | 'suffix' | 'width' | 'prefixRows' | 'suffixRows'> | null;
  /** The voucher's own number (alteration / view); null for a new voucher. */
  current: string | null;
  /** The next automatic number ('' when unknown or not automatic). */
  nextNumber: string;
  /** The voucher being changed (its own number is not "taken"). */
  excludeId?: number;
  /** Party and layout of the voucher being entered (a debit note is outward only to a customer). */
  partyLedgerId?: number | null;
  mode?: VoucherMode;
  /** A number chosen earlier (entry: the form's numberOverride). */
  initial?: VoucherNumberOverride | null;
  /** Saving (view: the renumber call is running). */
  busy?: boolean;
  /** Error of the caller's save, shown above the fields. */
  error?: string | null;
  onAccept: (o: VoucherNumberOverride) => void;
  /** Entry with a number chosen earlier: go back to the automatic / saved number. */
  onReset?: () => void;
  onClose: () => void;
}

export function ChangeNumberDialog(p: ChangeNumberDialogProps) {
  const noun = numberNoun(p.baseType);
  const [typed, setTyped] = useState(p.initial?.number ?? '');
  const [reason, setReason] = useState(p.initial?.reason ?? '');
  const [continueSeries, setContinueSeries] = useState(p.initial?.continueSeries === true);
  const [check, setCheck] = useState<NumberCheckState | null>(null);

  // Live check, debounced; an answer is kept with the number it is about (lib/changeNumber.ts › numberMessage).
  const n = typed.trim();
  const { voucherTypeId, date, excludeId, partyLedgerId, mode } = p;
  useEffect(() => {
    if (n === '' || (p.current !== null && n === p.current.trim())) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      const input: { voucherTypeId: number; date: string; number: string; excludeId?: number; partyLedgerId?: number; mode?: VoucherMode } = { voucherTypeId, date, number: n };
      if (excludeId !== undefined) input.excludeId = excludeId;
      if (partyLedgerId !== undefined && partyLedgerId !== null) input.partyLedgerId = partyLedgerId;
      if (mode !== undefined) input.mode = mode;
      api('vouchers.numberCheck', input).then(
        (result) => {
          if (alive) setCheck({ number: n, result, error: null });
        },
        (err: unknown) => {
          if (alive) setCheck({ number: n, result: null, error: userMessage(err) });
        },
      );
    }, NUMBER_CHECK_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [n, p.current, voucherTypeId, date, excludeId, partyLedgerId, mode]);

  const message = numberMessage(typed, p.current, p.gstDoc, check);
  const seq = message.canAccept && check?.number === n ? (check.result?.seq ?? null) : null;
  const series = useMemo(
    () => continueSeriesState({ method: p.method, scheme: p.scheme, seq, nextNumber: p.nextNumber || null, date: p.date, fyStartMonth: p.fyStartMonth, noun }),
    [p.method, p.scheme, seq, p.nextNumber, p.date, p.fyStartMonth, noun],
  );
  const canAccept = message.canAccept && p.busy !== true;
  const accept = () => {
    if (canAccept) p.onAccept(overrideOf(typed, reason, continueSeries && series.enabled));
  };
  const formRef = useEnterAdvance<HTMLElement>({ onComplete: accept });

  return (
    <Modal
      open
      onClose={p.onClose}
      size="md"
      title={changeNumberTitle(p.baseType)}
      description={`The new number is checked as you type. The change is kept in the edit log${p.gstDoc ? '; GST invoice numbers stay unique within the financial year' : ''}.`}
      footerStart={
        p.onReset ? (
          <Button variant="link" onClick={p.onReset}>
            {p.current ? 'Keep the saved number' : 'Use the automatic number'}
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={p.onClose} shortcut="Esc">
            Cancel
          </Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={p.busy === true} disabled={!canAccept} onClick={accept}>
            Use this number
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => accept() }} />
      <Stack ref={formRef} gap={3}>
        {p.error ? (
          <Banner tone="danger" title="The number was not changed">
            {p.error}
          </Banner>
        ) : null}
        <KeyValueList items={[{ label: p.current !== null ? 'Current number' : 'Next number', value: (p.current !== null ? p.current : p.nextNumber) || '—', strong: true }]} />
        <Field
          label="New number"
          required
          error={message.tone === 'danger' ? message.text : undefined}
          hint={message.tone === 'danger' ? undefined : <span role="status">{message.tone === 'success' ? <OkHint>{message.text.replace(/^✓ /, '')}</OkHint> : message.text}</span>}
        >
          <TextInput value={typed} maxLength={p.gstDoc ? 40 : 80} mono spellCheck={false} autoComplete="off" onValueChange={setTyped} data-autofocus />
        </Field>
        <Field label="Reason (edit log)" optional hint="Why the number changes — kept with the change in the edit history (Alt+H).">
          <TextArea value={reason} maxLength={RENUMBER_REASON_MAX} autoGrow maxRows={3} onValueChange={setReason} />
        </Field>
        <Checkbox
          label={series.label}
          description={series.enabled ? `Later ${noun}s are numbered after this one.` : series.reason}
          checked={continueSeries && series.enabled}
          disabled={!series.enabled}
          onChange={setContinueSeries}
        />
      </Stack>
    </Modal>
  );
}
