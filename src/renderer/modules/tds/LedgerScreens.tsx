/**
 * 'tds.ledgers' { role? } — TDS/TCS details of ledgers (Tally "TDS details" of a ledger master):
 * parties (deductee type, PAN, lower-deduction certificate, default nature, deductor TAN of a customer),
 * expense / fixed-asset ledgers (TDS applicable + nature of payment), sales ledgers (TCS + nature of
 * goods). Ctrl+1 / Ctrl+2 / Ctrl+3 switch the view, Ctrl+F search, Enter alters, Alt+M opens the
 * ledger master.
 * 'tds.ledger.form' { ledgerId } — edit one ledger's details (Enter next field, Ctrl+A save).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { deducteeTypeFromPan, normalizePan } from '../../../shared/tds/rules.ts';
import type { DeducteeType, TdsLedgerDetails, TdsNature } from '../../../shared/types/tds.ts';
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
  Badge,
  Banner,
  DataTable,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  Inline,
  PercentInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { PanBadge, TdsOff } from './components.tsx';
import { DEDUCTEE_OPTIONS, ledgerDraftOf, ledgerErrors, ledgerSaveInput, natureOptionsFor, ROLE_LABEL, type LedgerDraft } from './lib/model.ts';

type Role = TdsLedgerDetails['role'];
const ROLES: readonly Role[] = ['party', 'expense', 'income'];
const DEDUCTEE_LABEL = new Map(DEDUCTEE_OPTIONS.map((o) => [o.value, o.label]));

function useNatureNames(): Map<number, TdsNature> {
  const q = useApiQuery('tds.natures.list', { includeInactive: true }, { staleTime: 60_000 });
  return useMemo(() => new Map((q.data ?? []).map((n) => [n.id, n])), [q.data]);
}

export function LedgersScreen({ params }: ScreenProps<{ role?: Role }>) {
  const nav = useNav();
  const features = useFeatures();
  const on = features.tds || features.tcs;
  const roles = ROLES.filter((r) => r !== 'income' || features.tcs);
  const [role, setRole] = useState<Role>(params?.role && roles.includes(params.role) ? params.role : 'party');
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 200);
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const q = useApiQuery('tds.ledgers.list', { role, search: debounced || undefined, onlyConfigured }, { keepPrevious: true, enabled: on });
  const natures = useNatureNames();
  const rows = q.data ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.ledgerId) === cursor) ?? null;
  const searchRef = useRef<HTMLInputElement | null>(null);

  const columns = useMemo<Column<TdsLedgerDetails>[]>(
    () => [
      { key: 'ledgerName', header: 'Ledger', minWidth: 220, sortable: true },
      { key: 'groupName', header: 'Under', width: 170, sortable: true },
      {
        key: 'applicable',
        header: role === 'party' ? 'Deductee' : role === 'income' ? 'TCS' : 'TDS',
        width: 90,
        value: (r) => (r.applicable ? 'Yes' : ''),
        render: (r) => (r.applicable ? <Badge size="sm" tone="brand">Yes</Badge> : <span className="bx-muted">No</span>),
      },
      {
        key: 'nature',
        header: role === 'party' ? 'Default nature' : 'Nature',
        minWidth: 200,
        value: (r) => {
          const n = r.natureId !== null ? natures.get(r.natureId) : undefined;
          return n ? `${n.section} ${n.name}` : '';
        },
      },
      { key: 'type', header: 'Deductee type', width: 150, hidden: role !== 'party', value: (r) => (r.deducteeType ? (DEDUCTEE_LABEL.get(r.deducteeType) ?? '') : '') },
      { key: 'pan', header: 'PAN', width: 150, hidden: role !== 'party', value: (r) => r.pan ?? '', render: (r) => <PanBadge status={r.panStatus} pan={r.pan} /> },
      {
        key: 'cert',
        header: 'Certificate',
        width: 140,
        hidden: role !== 'party',
        value: (r) => (r.certificate ? `${r.certificate.number} @ ${r.certificate.rate}%` : ''),
      },
      { key: 'tan', header: 'Deductor TAN', width: 120, hidden: role !== 'party', value: (r) => r.deductorTan ?? '' },
    ],
    [role, natures],
  );

  if (!on) return <TdsOff title="TDS/TCS Ledger Details" />;
  return (
    <Screen
      title="TDS / TCS Details of Ledgers"
      subtitle="Who is a deductee, which expenses attract TDS and which sales attract TCS."
      icon="ledger"
      loading={q.loading && !q.data}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Ctrl+1 Parties · Ctrl+2 Expenses · Ctrl+3 Sales · Ctrl+F Search · Alt+M Ledger master · Esc Back"
      actions={[
        { key: 'Alt+A', label: 'Alter', icon: 'edit', primary: true, disabled: !current, onClick: () => current && nav.push('tds.ledger.form', { ledgerId: current.ledgerId }) },
        { key: 'Alt+M', label: 'Ledger master', icon: 'ledger', disabled: !current, onClick: () => current && nav.push('accounts.ledger.form', { id: current.ledgerId }) },
        { key: 'Ctrl+1', label: 'Parties', group: 'view', disabled: role === 'party', onClick: () => setRole('party') },
        { key: 'Ctrl+2', label: 'Expenses & assets', group: 'view', hidden: !features.tds, disabled: role === 'expense', onClick: () => setRole('expense') },
        { key: 'Ctrl+3', label: 'Sales & income', group: 'view', hidden: !features.tcs, disabled: role === 'income', onClick: () => setRole('income') },
        { key: 'Ctrl+F', label: 'Search', icon: 'search', group: 'view', onClick: () => searchRef.current?.focus() },
      ]}
    >
      <Stack gap={3}>
        <Inline gap={3}>
          <SegmentedControl<Role> aria-label="Ledgers" size="sm" value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          <TextInput
            ref={searchRef}
            size="sm"
            leadingIcon="search"
            placeholder="Search ledgers"
            aria-label="Search ledgers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Switch checked={onlyConfigured} onChange={setOnlyConfigured} label="Only ledgers with TDS/TCS details" showState={false} />
        </Inline>
        <DataTable<TdsLedgerDetails>
          aria-label="TDS / TCS details of ledgers"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.ledgerId)}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => nav.push('tds.ledger.form', { ledgerId: r.ledgerId })}
          loading={q.loading}
          empty={
            <EmptyState
              title={search ? 'No ledger matches the search' : 'No ledgers here'}
              body={role === 'party' ? 'Suppliers, customers, partners and loan creditors appear here.' : 'Expense, fixed-asset and purchase / sales ledgers appear here.'}
            />
          }
        />
      </Stack>
    </Screen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export function LedgerFormScreen({ params }: ScreenProps<{ ledgerId: number }>) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canManage = useCan('tds.manage');
  const { date: workingDate } = useWorkingDate();
  const q = useApiQuery('tds.ledgers.get', { ledgerId: params.ledgerId }, { staleTime: 0 });
  // Inactive natures too, so a ledger that still uses one shows it (natureOptionsFor keeps only those).
  const natures = useApiQuery('tds.natures.list', { includeInactive: true }, { staleTime: 60_000 });
  const loaded = q.data;
  const [draft, setDraft] = useState<LedgerDraft | null>(null);
  const d: LedgerDraft | null = draft ?? (loaded ? ledgerDraftOf(loaded) : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useApiMutation('tds.ledgers.save', { invalidates: ['accounts', 'vouchers'] });
  const readOnly = !canManage;
  const set = (patch: Partial<LedgerDraft>): void => {
    if (d) setDraft({ ...d, ...patch });
  };

  const natureOptions = useMemo(
    () => natureOptionsFor(natures.data ?? [], d?.role, features, [d?.natureId ?? null, d?.certNatureId ?? null]),
    [natures.data, d?.role, features, d?.natureId, d?.certNatureId],
  );

  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  submitRef.current = async () => {
    if (!d || readOnly || save.pending) return;
    const e = ledgerErrors(d);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      const out = await save.mutate(ledgerSaveInput(params.ledgerId, d));
      toast.success(`TDS/TCS details of ${out.ledgerName} saved`);
      nav.pop();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(Object.keys(f).length > 0 ? f : { form: userMessage(err) });
    }
  };
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });

  const panSuggest = d && d.role === 'party' && !d.deducteeType ? deducteeTypeFromPan(normalizePan(d.pan)) : null;
  const title = loaded ? `TDS / TCS Details: ${loaded.ledgerName}` : 'TDS / TCS Details';

  return (
    <Screen
      title={title}
      subtitle={loaded ? `Under ${loaded.groupName}` : undefined}
      icon="ledger"
      width="form"
      dirty={draft !== null}
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Next field · Ctrl+A Save · Alt+M Ledger master · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: readOnly || save.pending || !d, onClick: accept },
        { key: 'Alt+M', label: 'Ledger master', icon: 'ledger', onClick: () => nav.push('accounts.ledger.form', { id: params.ledgerId }) },
      ]}
    >
      {d ? (
        <div ref={formRef}>
          <Stack gap={4}>
            {readOnly ? <Banner tone="info" inline>You can view these details; changing them needs the "Manage TDS/TCS setup" permission.</Banner> : null}
            {errors.form ? <Banner tone="danger" inline>{errors.form}</Banner> : null}
            {d.role === 'party' ? (
              <>
                <FieldGroup legend="Deductee" columns={2}>
                  <Field
                    label="TDS / TCS applies to this party"
                    hint="On: TDS is deducted from its bills / TCS collected on sales to it. Off: exempt (e.g. s.196, a transporter’s s.194C(6) declaration) — nothing is computed on its vouchers."
                  >
                    <Switch data-autofocus checked={d.applicable} onChange={(v) => set({ applicable: v })} disabled={readOnly} aria-label="TDS / TCS applies to this party" />
                  </Field>
                  <Field label="PAN" error={errors.pan} hint="Without a valid PAN the higher rate of s.206AA / s.206CC applies.">
                    <TextInput value={d.pan} onValueChange={(v) => set({ pan: v.toUpperCase().replace(/\s+/g, '').slice(0, 10) })} uppercase mono maxLength={10} readOnly={readOnly} />
                  </Field>
                  <Field label="Deductee type" hint={panSuggest ? `From the PAN: ${DEDUCTEE_LABEL.get(panSuggest) ?? ''}` : 'Decides the rate (194C: 1% individual / HUF, 2% others) and the statement code.'}>
                    <Select<DeducteeType>
                      value={d.deducteeType ?? ''}
                      placeholder="Not set (taken from the PAN)"
                      options={DEDUCTEE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      onChange={(v) => set({ deducteeType: v })}
                      disabled={readOnly}
                    />
                  </Field>
                  {features.tds ? (
                    <Field label="Non-resident" hint="Reported in Form 27Q instead of 26Q.">
                      <Switch checked={d.nonResident} onChange={(v) => set({ nonResident: v })} disabled={readOnly} aria-label="Non-resident" />
                    </Field>
                  ) : null}
                  <Field label="Default nature" optional hint="Used for advances and when an expense ledger has no nature of its own.">
                    <Select
                      value={d.natureId === null ? '' : String(d.natureId)}
                      placeholder="None"
                      options={[{ value: '', label: 'None' }, ...natureOptions]}
                      onChange={(v) => set({ natureId: v ? Number(v) : null })}
                      disabled={readOnly}
                    />
                  </Field>
                  <Field label="Deductor TAN (customer)" optional error={errors.deductorTan} hint="When this customer deducts TDS from your receipts: matches Form 26AS.">
                    <TextInput value={d.deductorTan} onValueChange={(v) => set({ deductorTan: v.toUpperCase().replace(/\s+/g, '').slice(0, 10) })} uppercase mono maxLength={10} readOnly={readOnly} />
                  </Field>
                </FieldGroup>
                <FieldGroup legend="Lower / nil deduction certificate (s.197 / s.206C(9))" columns={3}>
                  <Field label="Certificate held">
                    <Switch checked={d.hasCertificate} onChange={(v) => set({ hasCertificate: v })} disabled={readOnly} aria-label="Certificate held" />
                  </Field>
                  {d.hasCertificate ? (
                    <>
                      <Field label="Certificate no." required error={errors['certificate.number']}>
                        <TextInput value={d.certNumber} onValueChange={(v) => set({ certNumber: v.slice(0, 40) })} mono readOnly={readOnly} />
                      </Field>
                      <Field label="Rate %" required error={errors['certificate.rate']} hint="0 for a nil-deduction certificate.">
                        <PercentInput value={d.certRate} onChange={(v) => set({ certRate: v })} readOnly={readOnly} />
                      </Field>
                      <Field label="Valid from" required error={errors['certificate.validFrom']}>
                        <DateInput value={d.certFrom} onChange={(v) => set({ certFrom: v })} referenceDate={workingDate} readOnly={readOnly} />
                      </Field>
                      <Field label="Valid to" required error={errors['certificate.validTo']}>
                        <DateInput value={d.certTo} onChange={(v) => set({ certTo: v })} referenceDate={workingDate} readOnly={readOnly} />
                      </Field>
                      <Field label="Amount limit" optional hint="Blank = no limit.">
                        <AmountInput value={d.certLimit} onChange={(v) => set({ certLimit: v })} symbol readOnly={readOnly} />
                      </Field>
                      <Field label="For nature" optional>
                        <Select
                          value={d.certNatureId === null ? '' : String(d.certNatureId)}
                          options={[{ value: '', label: 'Every nature' }, ...natureOptions]}
                          onChange={(v) => set({ certNatureId: v ? Number(v) : null })}
                          disabled={readOnly}
                        />
                      </Field>
                    </>
                  ) : null}
                </FieldGroup>
              </>
            ) : (
              <FieldGroup legend={d.role === 'income' ? 'TCS on sales' : 'TDS on expenses'} columns={2}>
                <Field label={d.role === 'income' ? 'TCS applicable' : 'TDS applicable'} hint={d.role === 'income' ? 'Sales posted to this ledger attract TCS.' : 'Amounts posted to this ledger attract TDS.'}>
                  <Switch data-autofocus checked={d.applicable} onChange={(v) => set({ applicable: v })} disabled={readOnly} aria-label="Applicable" />
                </Field>
                <Field label={d.role === 'income' ? 'Nature of goods' : 'Nature of payment'} required={d.applicable} error={errors.natureId}>
                  <Select
                    value={d.natureId === null ? '' : String(d.natureId)}
                    placeholder="Choose"
                    options={natureOptions}
                    onChange={(v) => set({ natureId: v ? Number(v) : null })}
                    disabled={readOnly || !d.applicable}
                  />
                </Field>
              </FieldGroup>
            )}
            {loaded?.legacySection ? <span className="bx-muted">Earlier free-text TDS section on the ledger: {loaded.legacySection}</span> : null}
          </Stack>
        </div>
      ) : null}
    </Screen>
  );
}
