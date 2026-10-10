/**
 * 'forex.settings' — Multi-currency settings: the ledger realised exchange differences go to (default
 * the system ledger 'Forex Gain/Loss' under Indirect Expenses), the ledger for unrealised differences
 * (revaluation; default the same) and the rate column used for period-end revaluation.
 * Keys: Enter next field · Ctrl+A save · Alt+R currencies & rates · Esc back.
 */
import { useEffect, useMemo, useState } from 'react';
import { FOREX_RATE_TYPES, type ForexRateType } from '../../../shared/forex.ts';
import type { LedgerListRow } from '../../../shared/types/accounts.ts';
import type { ForexSettingsView } from '../../../shared/types/forex.ts';
import { api, Screen, useApiMutation, useApiQuery, useCan, useFeatures, useNav } from '../../app/index.ts';
import { Banner, Combobox, Field, Select, Stack, useEnterAdvance, useToast } from '../../ui/index.ts';
import { ForexOff } from './components.tsx';
import { RATE_TYPE_LABEL } from './lib/model.ts';

type Pick = { id: number; name: string } | null;

function LedgerChoice(props: { id: string; value: Pick; onChange: (v: Pick) => void; placeholder: string }) {
  return (
    <Combobox<LedgerListRow>
      id={props.id}
      loadItems={async (q) => (await api('accounts.ledger.list', { search: q, classes: ['income', 'expense'], activeOnly: true, limit: 50 })).rows.filter((r) => !r.billWise)}
      getKey={(r) => String(r.id)}
      getLabel={(r) => r.name}
      rightMeta={(r) => <span className="bx-muted">{r.groupName}</span>}
      value={props.value ? ({ id: props.value.id, name: props.value.name } as LedgerListRow) : null}
      onChange={(r) => props.onChange(r ? { id: r.id, name: r.name } : null)}
      placeholder={props.placeholder}
    />
  );
}

export function SettingsScreen() {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canSave = useCan('company.manage');
  const q = useApiQuery('forex.settings.get', {}, { enabled: features.multiCurrency });
  const save = useApiMutation('forex.settings.save', { invalidates: ['forex'] });
  const [realised, setRealised] = useState<Pick>(null);
  const [unrealised, setUnrealised] = useState<Pick>(null);
  const [rateType, setRateType] = useState<ForexRateType>('standard');
  const [loadedFrom, setLoadedFrom] = useState<ForexSettingsView | null>(null);
  useEffect(() => {
    const d = q.data;
    if (!d || d === loadedFrom) return;
    setLoadedFrom(d);
    setRealised(d.gainLossLedgerId !== null && d.gainLossLedger ? d.gainLossLedger : null);
    setUnrealised(d.unrealisedLedgerId !== null && d.unrealisedLedger ? d.unrealisedLedger : null);
    setRateType(d.revaluationRateType);
  }, [q.data]);
  const dirty =
    !!loadedFrom && ((realised?.id ?? null) !== loadedFrom.gainLossLedgerId || (unrealised?.id ?? null) !== loadedFrom.unrealisedLedgerId || rateType !== loadedFrom.revaluationRateType);
  const submit = async (): Promise<void> => {
    if (!canSave || save.pending) return;
    try {
      await save.mutate({ gainLossLedgerId: realised?.id ?? null, unrealisedLedgerId: unrealised?.id ?? null, revaluationRateType: rateType });
      toast.success('Multi-currency settings saved');
      nav.pop();
    } catch {
      /* save.fieldErrors shown next to the fields */
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const systemName = useMemo(() => q.data?.gainLossLedger?.name ?? 'Forex Gain/Loss', [q.data]);
  if (!features.multiCurrency) return <ForexOff title="Multi-currency Settings" />;
  return (
    <Screen
      title="Multi-currency Settings"
      subtitle="Exchange gain / loss ledgers and the revaluation rate"
      icon="settings"
      width="form"
      dirty={dirty}
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Next field · Ctrl+A Save · Alt+R Rates of exchange · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: !canSave || save.pending, hint: canSave ? undefined : 'Needs the “Manage company” permission', onClick: () => void submit() },
        { key: 'Alt+R', label: 'Rates of exchange', icon: 'rupee', onClick: () => nav.push('accounts.currencies'), group: 'details' },
      ]}
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={3}>
          {!canSave ? <Banner tone="info">You can view these settings; changing them needs the “Manage company” permission.</Banner> : null}
          <Field
            label="Realised exchange gain / loss ledger"
            htmlFor="fx-realised"
            error={save.fieldErrors.gainLossLedgerId}
            hint={`When a bill in a foreign currency is settled at another rate than it was booked at, the difference is posted here in the same voucher. Empty: the system ledger “${systemName}” (Indirect Expenses; a gain is a credit).`}
          >
            <LedgerChoice id="fx-realised" value={realised} onChange={setRealised} placeholder={`System ledger — ${systemName}`} />
          </Field>
          <Field
            label="Unrealised exchange gain / loss ledger"
            htmlFor="fx-unrealised"
            error={save.fieldErrors.unrealisedLedgerId}
            hint="Used by the period-end revaluation journal. Empty: the realised ledger above."
          >
            <LedgerChoice id="fx-unrealised" value={unrealised} onChange={setUnrealised} placeholder="Same as the realised ledger" />
          </Field>
          <Field label="Closing rate for revaluation" hint="Which rate of Currencies › Rates of Exchange restates foreign balances at the period end (AS 11 / Ind AS 21: the closing rate).">
            <Select<ForexRateType> value={rateType} options={FOREX_RATE_TYPES.map((t) => ({ value: t, label: RATE_TYPE_LABEL[t] }))} onChange={setRateType} />
          </Field>
        </Stack>
      </form>
    </Screen>
  );
}
