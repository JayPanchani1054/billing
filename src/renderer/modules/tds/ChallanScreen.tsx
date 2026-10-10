/**
 * 'tds.challan' { kind?, section?, period?, voucherId? } — record a TDS/TCS challan (ITNS 281) paid
 * for one section and month: BSR code, challan serial, deposit date, tax / surcharge / cess, interest,
 * fee u/s 234E, others. Saves a Payment voucher (Dr TDS Payable – <section>, Dr interest / fee
 * ledgers, Cr bank) through the vouchers module; the deposit clears that month's deductions oldest
 * first. The unpaid tax and the interest to the deposit date are suggested (Alt+S fills them in).
 * Enter next field, Ctrl+A save, Alt+Enter view the saved voucher.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMonth } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { LedgerPickerRow } from '../../../shared/types/accounts.ts';
import type { TdsKind, VoucherTdsChallanInput } from '../../../shared/types/tds.ts';
import { withConfirmation } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import {
  AmountInput,
  Banner,
  Button,
  DateInput,
  Field,
  FieldGroup,
  Inline,
  KeyValueList,
  Select,
  Stack,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import { KindSwitch, TdsOff } from './components.tsx';
import { challanErrors, challanInput, challanTotal, enabledKinds, initialKind, KIND_LABEL, monthChoices, previousMonth, type ChallanDraft } from './lib/model.ts';

export interface ChallanParams {
  kind?: TdsKind;
  section?: string;
  period?: string;
  voucherId?: number;
}

const inr = (p: number): string => formatMoney(p, { symbol: true });

export function ChallanScreen({ params }: ScreenProps<ChallanParams>) {
  const p = params ?? {};
  const features = useFeatures();
  const kinds = enabledKinds(features);
  const existing = useApiQuery('tds.challan.get', { voucherId: p.voucherId ?? 0 }, { enabled: p.voucherId !== undefined, staleTime: 0 });
  if (kinds.length === 0) return <TdsOff title="TDS / TCS Challan" />;
  if (p.voucherId !== undefined && !existing.data) {
    return <Screen title="Alter Challan" icon="receipt" loading={existing.loading} error={existing.error} onRetry={() => void existing.refetch()} />;
  }
  return <ChallanForm params={p} existing={existing.data ?? null} kinds={kinds} />;
}

interface Existing {
  voucherId: number;
  number: string | null;
  date: string;
  bankLedgerId: number | null;
  narration: string | null;
  challan: VoucherTdsChallanInput;
  updatedAt: string;
  cancelled: boolean;
}

function ChallanForm({ params: p, existing, kinds }: { params: ChallanParams; existing: Existing | null; kinds: TdsKind[] }) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canCreate = useCan('vouchers.create');
  const canAlter = useCan('vouchers.alter');
  const { date: workingDate } = useWorkingDate();
  const banks = useApiQuery('accounts.ledger.picker', { classes: ['cash_bank'] }, { staleTime: 60_000 });
  const c = existing?.challan ?? null;
  const [draft, setDraft] = useState<ChallanDraft>(() => ({
    kind: c?.kind ?? initialKind(p.kind, features) ?? 'tds',
    section: c?.section ?? p.section ?? '',
    period: c?.period ?? p.period ?? previousMonth(workingDate),
    date: existing?.date ?? workingDate,
    depositDate: c?.depositDate ?? workingDate,
    bankLedgerId: existing?.bankLedgerId ?? null,
    bsrCode: c?.bsrCode ?? '',
    challanNo: c?.challanNo ?? '',
    minorHead: c?.minorHead ?? '200',
    tax: c ? c.tax : null,
    surcharge: c?.surcharge ?? null,
    cess: c?.cess ?? null,
    interest: c?.interest ?? null,
    fee: c?.fee ?? null,
    others: c?.others ?? null,
  }));
  const [touched, setTouched] = useState(false);
  /** The user typed the tax / interest: suggestions no longer overwrite them. */
  const [amountsTyped, setAmountsTyped] = useState(existing !== null);
  const [narration, setNarration] = useState(existing?.narration ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useApiMutation('tds.challan.save', { invalidates: ['vouchers', 'reports', 'banking', 'dashboard', 'accounts'] });
  const set = (patch: Partial<ChallanDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setTouched(true);
  };
  const setAmount = (patch: Partial<ChallanDraft>): void => {
    set(patch);
    setAmountsTyped(true);
  };

  // Inactive natures too: tax deducted under a nature made inactive later still has to be deposited.
  const natures = useApiQuery('tds.natures.list', { kind: draft.kind, includeInactive: true }, { staleTime: 60_000 });
  const sections = useMemo(() => [...new Set((natures.data ?? []).map((n) => n.section))].sort(), [natures.data]);
  useEffect(() => {
    if (!draft.section && sections.length > 0) setDraft((d) => (d.section ? d : { ...d, section: sections[0] }));
  }, [sections, draft.section]);

  // Only the typed deposit date is debounced (a fresh object each render would never settle).
  const depositDate = useDebouncedValue(draft.depositDate ?? workingDate, 250);
  const sugInput = { kind: draft.kind, section: draft.section, period: draft.period, depositDate, ...(existing ? { excludeVoucherId: existing.voucherId } : {}) };
  const sug = useApiQuery('tds.challan.suggest', sugInput, { enabled: !!sugInput.section && /^\d{4}-\d{2}$/.test(sugInput.period), keepPrevious: true });
  const s = sug.data && sug.data.section === draft.section && sug.data.period === draft.period && sug.data.kind === draft.kind ? sug.data : null;

  const fillSuggested = useCallback(() => {
    if (!s) return;
    setDraft((d) => ({ ...d, tax: s.unpaid, interest: s.interest > 0 ? s.interest : null }));
    setTouched(true);
  }, [s]);
  // A new challan starts with what is unpaid, until the user types the amounts.
  useEffect(() => {
    if (!amountsTyped && s) setDraft((d) => ({ ...d, tax: s.unpaid > 0 ? s.unpaid : d.tax, interest: s.interest > 0 ? s.interest : null }));
  }, [s, amountsTyped]);

  const bankRows: LedgerPickerRow[] = banks.data ?? [];
  const total = challanTotal(draft);
  const readOnly = existing ? !canAlter || existing.cancelled : !canCreate;

  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  submitRef.current = async () => {
    if (readOnly || save.pending) return;
    const e = challanErrors(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      const out = await withConfirmation((ack) =>
        save.mutate({
          ...(existing ? { voucherId: existing.voucherId, expectedUpdatedAt: existing.updatedAt } : {}),
          date: draft.date as string,
          bankLedgerId: draft.bankLedgerId as number,
          ...(narration.trim() ? { narration: narration.trim() } : {}),
          challan: challanInput(draft),
          ...(ack ? { acknowledgeWarnings: true } : {}),
        }),
      );
      if (out === undefined) return;
      toast.success(`Challan recorded (Payment ${out.number ?? ''})`, {
        message: `${inr(total)} paid for ${KIND_LABEL[draft.kind]} u/s ${draft.section}, ${formatMonth(draft.period)}.`,
        action: { label: 'Open', onClick: () => nav.push('vouchers.view', { id: out.id }) },
      });
      nav.pop();
    } catch (err) {
      const f = fieldErrorsOf(err);
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) mapped[k.replace(/^challan\./, '')] = v;
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: userMessage(err) });
    }
  };
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  const months = useMemo(() => {
    const list = monthChoices(workingDate);
    return list.some((m) => m.value === draft.period) ? list : [{ value: draft.period, label: formatMonth(draft.period) }, ...list];
  }, [workingDate, draft.period]);

  return (
    <Screen
      title={existing ? `Alter ${KIND_LABEL[draft.kind]} Challan` : `Create ${KIND_LABEL[draft.kind]} Challan`}
      subtitle={existing ? `Payment ${existing.number ?? ''}${existing.cancelled ? ' — cancelled' : ''}` : 'ITNS 281 — records the Payment voucher'}
      icon="receipt"
      width="form"
      dirty={touched}
      hint="Enter Next field · Alt+S Fill suggested amounts · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: readOnly || save.pending, onClick: accept },
        { key: 'Alt+S', label: 'Fill suggested amounts', icon: 'calculator', disabled: readOnly || !s, onClick: fillSuggested },
        { key: 'Alt+Enter', label: 'View voucher', icon: 'eye', hidden: !existing, onClick: () => existing && nav.push('vouchers.view', { id: existing.voucherId }) },
      ]}
      footer={
        <Inline gap={2} justify="end">
          <span className="bx-num" aria-live="polite">
            Total {inr(total)}
          </span>
          <Button onClick={() => void nav.back()}>Back</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} disabled={readOnly} onClick={accept}>
            Save
          </Button>
        </Inline>
      }
    >
      <div ref={formRef}>
        <Stack gap={4}>
          {readOnly ? (
            <Banner tone="info" inline>
              {existing?.cancelled ? 'This challan voucher is cancelled.' : 'Recording challans needs permission to create / alter vouchers.'}
            </Banner>
          ) : null}
          {errors.form ? <Banner tone="danger" inline>{errors.form}</Banner> : null}
          {!existing && kinds.length > 1 ? <KindSwitch kind={draft.kind} kinds={kinds} onChange={(k) => set({ kind: k, section: '' })} /> : null}
          <FieldGroup legend="Tax paid for" columns={3}>
            <Field label="Section" required error={errors.section}>
              <Select data-autofocus value={draft.section} placeholder="Choose" options={sections.map((x) => ({ value: x, label: x }))} onChange={(v) => set({ section: v })} disabled={readOnly} />
            </Field>
            <Field label="Month of deduction" required error={errors.period}>
              <Select value={draft.period} options={months} onChange={(v) => set({ period: v })} disabled={readOnly} />
            </Field>
            <Field label="Minor head">
              <Select<'200' | '400'>
                value={draft.minorHead}
                options={[
                  { value: '200', label: '200 — payable by taxpayer' },
                  { value: '400', label: '400 — regular assessment (demand)' },
                ]}
                onChange={(v) => set({ minorHead: v })}
                disabled={readOnly}
              />
            </Field>
          </FieldGroup>
          {s ? (
            <KeyValueList
              layout="inline"
              columns={3}
              items={[
                { label: 'Still unpaid', value: s.unpaid, kind: 'amount', strong: true },
                { label: `Interest to ${draft.depositDate ?? ''}`, value: s.interest, kind: 'amount' },
                { label: 'Due date', value: s.dueDate, kind: 'date' },
              ]}
            />
          ) : null}
          <FieldGroup legend="Challan" columns={3}>
            <Field label="Voucher date" required error={errors.date}>
              <DateInput value={draft.date} onChange={(v) => set({ date: v })} referenceDate={workingDate} readOnly={readOnly} />
            </Field>
            <Field label="Paid from" required error={errors.bankLedgerId}>
              <Select
                value={draft.bankLedgerId === null ? '' : String(draft.bankLedgerId)}
                placeholder={banks.loading ? 'Loading…' : 'Choose the bank'}
                options={bankRows.map((r) => ({ value: String(r.id), label: r.name }))}
                onChange={(v) => set({ bankLedgerId: v ? Number(v) : null })}
                disabled={readOnly}
              />
            </Field>
            <Field label="Date of deposit" required error={errors.depositDate} hint="As on the challan counterfoil.">
              <DateInput value={draft.depositDate} onChange={(v) => set({ depositDate: v })} referenceDate={workingDate} readOnly={readOnly} />
            </Field>
            <Field label="BSR code" required error={errors.bsrCode} hint="7 digits">
              <TextInput value={draft.bsrCode} onValueChange={(v) => set({ bsrCode: v.replace(/\D/g, '').slice(0, 7) })} inputMode="numeric" mono readOnly={readOnly} />
            </Field>
            <Field label="Challan serial no." required error={errors.challanNo} hint="Up to 5 digits">
              <TextInput value={draft.challanNo} onValueChange={(v) => set({ challanNo: v.replace(/\D/g, '').slice(0, 5) })} inputMode="numeric" mono readOnly={readOnly} />
            </Field>
          </FieldGroup>
          <FieldGroup legend="Amounts" columns={3}>
            <Field label={KIND_LABEL[draft.kind]} required error={errors.tax}>
              <AmountInput value={draft.tax} onChange={(v) => setAmount({ tax: v })} symbol readOnly={readOnly} />
            </Field>
            <Field label="Surcharge" optional>
              <AmountInput value={draft.surcharge} onChange={(v) => setAmount({ surcharge: v })} symbol blankZero readOnly={readOnly} />
            </Field>
            <Field label="Health & education cess" optional>
              <AmountInput value={draft.cess} onChange={(v) => setAmount({ cess: v })} symbol blankZero readOnly={readOnly} />
            </Field>
            <Field label="Interest" optional hint={draft.kind === 'tds' ? 's.201(1A)' : 's.206C(7)'}>
              <AmountInput value={draft.interest} onChange={(v) => setAmount({ interest: v })} symbol blankZero readOnly={readOnly} />
            </Field>
            <Field label="Fee u/s 234E" optional>
              <AmountInput value={draft.fee} onChange={(v) => setAmount({ fee: v })} symbol blankZero readOnly={readOnly} />
            </Field>
            <Field label="Others (penalty)" optional>
              <AmountInput value={draft.others} onChange={(v) => setAmount({ others: v })} symbol blankZero readOnly={readOnly} />
            </Field>
          </FieldGroup>
          <Field label="Narration" optional hint="Blank: challan number, BSR code and month are written for you.">
            <TextInput value={narration} onValueChange={(v) => { setNarration(v.slice(0, 4000)); setTouched(true); }} readOnly={readOnly} />
          </Field>
        </Stack>
      </div>
    </Screen>
  );
}
