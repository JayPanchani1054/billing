/**
 * Shared pieces of the GST plus screens: the quarter selector of composition returns, a period
 * selector that adapts to the registration (quarters for composition, return periods otherwise), the
 * "mark as filed" dialog and the text-file save helper (CMP-08 / GSTR-4 in Pevqori's documented format).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { GstFiling, GstFilingForm, GstTextFile } from '../../../shared/types/gst-plus.ts';
import { native, useApiMutation, useApiQuery, useWorkingDate, userMessage } from '../../app/index.ts';
import { Button, DateInput, Field, Hotkeys, Modal, Select, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { PeriodSelect, useReturnPeriod } from './components.tsx';
import { FORM_LABELS, initialQuarter, quartersFrom } from './lib/gstplus.ts';

export interface PlusPeriodState {
  /** 'composition' → quarters (CMP-08); else GST return periods. */
  composition: boolean;
  key: string | null;
  setKey: (k: string) => void;
  label: string;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  select: (ref: RefObject<HTMLSelectElement | null>) => ReactNode;
}

/** Return period of the company's own return (GSTR-3B month / quarter, or the CMP-08 quarter). */
export function usePlusPeriod(requested?: string | null): PlusPeriodState {
  const rp = useReturnPeriod(requested);
  const { date } = useWorkingDate();
  const composition = rp.periods?.registration === 'composition';
  const quarters = useMemo(() => quartersFrom((rp.periods?.periods ?? []).filter((p) => p.kind === 'month').map((p) => p.key)), [rp.periods]);
  const [qKey, setQKey] = useState<string | null>(null);
  useEffect(() => {
    if (composition && qKey === null && quarters.length > 0) setQKey(initialQuarter(quarters, date, requested));
  }, [composition, qKey, quarters, date, requested]);
  if (composition) {
    return {
      composition,
      key: qKey,
      setKey: setQKey,
      label: quarters.find((q) => q.value === qKey)?.label ?? '',
      loading: rp.loading,
      error: rp.error,
      refetch: rp.refetch,
      select: (ref) => <QuarterSelect options={quarters} value={qKey} onChange={setQKey} selectRef={ref} />,
    };
  }
  return {
    composition: false,
    key: rp.key,
    setKey: rp.setKey,
    label: rp.label,
    loading: rp.loading,
    error: rp.error,
    refetch: rp.refetch,
    select: (ref) => <PeriodSelect periods={rp.periods} value={rp.key} onChange={rp.setKey} selectRef={ref} />,
  };
}

export function QuarterSelect({
  options,
  value,
  onChange,
  selectRef,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string | null;
  onChange: (k: string) => void;
  selectRef?: RefObject<HTMLSelectElement | null>;
}) {
  return (
    <label className="bx-gst-period">
      <span className="bx-gst-period__label">Quarter</span>
      <Select
        ref={selectRef}
        size="sm"
        aria-label="Quarter"
        aria-keyshortcuts="Alt+F2"
        options={[...options]}
        value={value ?? ''}
        placeholder={options.length ? 'Choose a quarter' : 'No quarters yet'}
        disabled={options.length === 0}
        onChange={(v) => onChange(v)}
      />
    </label>
  );
}

/** Filing status of one return (null while loading / not filed). */
export function useFiling(form: GstFilingForm, period: string | null): { filing: GstFiling | null; refetch: () => void } {
  const q = useApiQuery('gst.filing.list', { form }, { staleTime: 30_000 });
  return { filing: (q.data ?? []).find((f) => f.period === period) ?? null, refetch: () => void q.refetch() };
}

/** Ctrl+A-accept dialog: filing date + ARN → 'gst.filing.mark'. */
export function MarkFiledDialog({ form, period, periodLabel, onClose }: { form: GstFilingForm; period: string; periodLabel: string; onClose: (filed: boolean) => void }) {
  const toast = useToast();
  const { date } = useWorkingDate();
  const [filedOn, setFiledOn] = useState<string | null>(date);
  const [arn, setArn] = useState('');
  const mark = useApiMutation('gst.filing.mark', { invalidates: ['gst'] });
  const accept = async (): Promise<void> => {
    if (!filedOn || mark.pending) return;
    try {
      await mark.mutate({ form, period, filedOn, arn: arn.trim() || undefined });
      toast.success(`${FORM_LABELS[form]} for ${periodLabel} marked as filed`, {
        message: form === 'gstr1' ? 'Changes to its documents are now reported as amendments in a later GSTR-1.' : undefined,
      });
      onClose(true);
    } catch (err) {
      toast.error('Could not mark the return as filed', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  const first = useRef<HTMLInputElement | null>(null);
  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={`Mark ${FORM_LABELS[form]} as filed`}
      description={`${periodLabel}. Record the date and the ARN shown on the portal after filing.`}
      initialFocusRef={first}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={mark.pending} disabled={!filedOn} onClick={() => void accept()}>
            Mark filed
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Filed on" required error={mark.fieldErrors.filedOn}>
            <DateInput ref={first} value={filedOn} onChange={setFiledOn} referenceDate={date} />
          </Field>
          <Field label="ARN" optional hint="Acknowledgement Reference Number, e.g. AA270926123456X" error={mark.fieldErrors.arn}>
            <TextInput value={arn} onChange={(e) => setArn(e.target.value.toUpperCase())} maxLength={20} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}

const FILTERS = { json: [{ name: 'JSON file', extensions: ['json'] }], csv: [{ name: 'CSV file', extensions: ['csv'] }] };

/** Save a CMP-08 / GSTR-4 file where the user chooses. Resolves the path, or null when cancelled. */
export async function saveTextFile(file: GstTextFile, title: string): Promise<string | null> {
  const saved = await native('dialog.saveFile', { title, defaultName: file.fileName, filters: FILTERS[file.format], data: file.content });
  return saved ? saved.path : null;
}
