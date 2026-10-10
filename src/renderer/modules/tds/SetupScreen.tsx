/**
 * 'tds.setup' — company TDS/TCS setup: TAN (deductor), deductor category, person responsible, the
 * s.194Q buyer test (turnover above ₹10 crore in the preceding year), rounding, and the 'TDS
 * Receivable' ledger for tax customers deduct from our receipts. Ctrl+A saves.
 */
import { useCallback, useRef, useState } from 'react';
import type { TdsSettings } from '../../../shared/types/tds.ts';
import { api } from '../../app/api.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { invalidate } from '../../app/queryClient.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { Banner, Button, Field, FieldGroup, Inline, Select, Stack, Switch, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { TdsOff } from './components.tsx';
import { tanError } from './lib/model.ts';

const CATEGORIES: ReadonlyArray<{ value: TdsSettings['deductorCategory']; label: string }> = [
  { value: 'company', label: 'Company' },
  { value: 'firm', label: 'Firm / LLP' },
  { value: 'individual', label: 'Individual / HUF' },
  { value: 'others', label: 'Others (AOP, BOI, trust, …)' },
  { value: 'government', label: 'Government' },
];

export function SetupScreen() {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canManage = useCan('tds.manage');
  const on = features.tds || features.tcs;
  const q = useApiQuery('tds.settings.get', {}, { enabled: on, staleTime: 0 });
  const [draft, setDraft] = useState<TdsSettings | null>(null);
  const d = draft ?? q.data ?? null;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useApiMutation('tds.settings.save', { invalidates: ['vouchers'] });
  const set = (patch: Partial<TdsSettings>): void => {
    if (d) setDraft({ ...d, ...patch });
  };

  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  submitRef.current = async () => {
    if (!d || !canManage || save.pending) return;
    const tan = tanError(d.tan);
    setErrors(tan ? { tan } : {});
    if (tan) return;
    try {
      await save.mutate({ ...d, tan: d.tan.trim().toUpperCase() });
      setDraft(null);
      toast.success('TDS / TCS setup saved');
      nav.pop();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(Object.keys(f).length > 0 ? f : { form: userMessage(err) });
    }
  };
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });

  const createReceivable = async (): Promise<void> => {
    try {
      const out = await api('tds.receivableLedger.ensure', {});
      invalidate('accounts');
      invalidate('tds');
      toast.success('TDS Receivable ledger is ready', {
        message: 'Debit it in Receipt vouchers for the TDS your customers deduct.',
        action: { label: 'Open', onClick: () => nav.push('accounts.ledger.form', { id: out.ledgerId }) },
      });
    } catch (err) {
      toast.error('Could not create the ledger', { message: userMessage(err) });
    }
  };

  if (!on) return <TdsOff title="TDS / TCS Setup" />;
  return (
    <Screen
      title="TDS / TCS Setup"
      subtitle="Deductor details for challans and quarterly statements"
      icon="settings"
      width="form"
      dirty={draft !== null}
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Next field · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: !canManage || !d || save.pending, hint: canManage ? undefined : 'Needs the “Manage TDS/TCS setup” permission', onClick: accept },
        { key: 'Alt+R', label: 'Create TDS Receivable', icon: 'plus', hidden: !canManage || !features.tds, disabled: !canManage, onClick: () => void createReceivable() },
      ]}
    >
      {d ? (
        <div ref={formRef}>
          <Stack gap={4}>
            {!canManage ? <Banner tone="info" inline>Changing the setup needs the "Manage TDS/TCS setup" permission.</Banner> : null}
            {errors.form ? <Banner tone="danger" inline>{errors.form}</Banner> : null}
            <FieldGroup legend="Deductor / collector" columns={2}>
              <Field label="TAN" error={errors.tan} hint="Tax deduction and collection account number, e.g. MUMA12345B. Blank: the TAN in the company profile.">
                <TextInput data-autofocus value={d.tan} onValueChange={(v) => set({ tan: v.toUpperCase().replace(/\s+/g, '').slice(0, 10) })} uppercase mono maxLength={10} readOnly={!canManage} />
              </Field>
              <Field label="Deductor category">
                <Select<TdsSettings['deductorCategory']> value={d.deductorCategory} options={CATEGORIES} onChange={(v) => set({ deductorCategory: v })} disabled={!canManage} />
              </Field>
              <Field label="Person responsible" optional hint="Signs the statements and Form 16A / 27D.">
                <TextInput value={d.responsiblePerson} onValueChange={(v) => set({ responsiblePerson: v.slice(0, 100) })} readOnly={!canManage} />
              </Field>
              <Field label="Designation" optional>
                <TextInput value={d.responsibleDesignation} onValueChange={(v) => set({ responsibleDesignation: v.slice(0, 100) })} readOnly={!canManage} />
              </Field>
            </FieldGroup>
            <FieldGroup legend="Rules" columns={2}>
              {features.tds ? (
                <Field label="Deduct TDS on purchase of goods (s.194Q)" hint="Turn on when your total sales, gross receipts or turnover exceeded ₹10 crore in the preceding financial year.">
                  <Switch checked={d.buyer194Q} onChange={(v) => set({ buyer194Q: v })} disabled={!canManage} aria-label="Deduct TDS on purchase of goods (s.194Q)" />
                </Field>
              ) : null}
              <Field label="Round tax to the nearest rupee" hint="Income-tax rounds TDS / TCS to the rupee (s.288B). Turn off only to match a party's paise.">
                <Switch checked={d.roundToRupee} onChange={(v) => set({ roundToRupee: v })} disabled={!canManage} aria-label="Round tax to the nearest rupee" />
              </Field>
            </FieldGroup>
            <Inline gap={2}>
              <Button onClick={() => nav.push('tds.natures')}>Natures of payment / goods</Button>
              <Button onClick={() => nav.push('tds.ledgers')}>Ledger TDS / TCS details</Button>
              {features.tds ? (
                <Button shortcut="Alt+R" disabled={!canManage} onClick={() => void createReceivable()}>
                  Create TDS Receivable ledger
                </Button>
              ) : null}
            </Inline>
          </Stack>
        </div>
      ) : null}
    </Screen>
  );
}
