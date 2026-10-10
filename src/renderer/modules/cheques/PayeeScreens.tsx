/**
 * Payee bank details (Masters):
 *   'cheques.payees'      —           parties / expense ledgers with their beneficiary account; Ctrl+2 every
 *                                     party (also those without details). Enter / Alt+A alter · Alt+C add
 *                                     details for another ledger · Ctrl+F search · Alt+E export
 *   'cheques.payee.form'  {ledgerId?} beneficiary name, account number (typed twice), IFSC, bank, branch,
 *                                     account type, name on cheque, preferred payment mode. Ctrl+A save.
 * Used by bulk e-payment files and as the payee name on cheques; every change is in the edit log.
 */
import { useMemo, useRef, useState } from 'react';
import type { PayeeAccountType, PayeeBankDetails, PayeeListRow, PayeePaymentMode } from '../../../shared/types/cheques.ts';
import { PAYEE_ACCOUNT_TYPES, PAYEE_PAYMENT_MODES } from '../../../shared/types/cheques.ts';
import { fieldErrorsOf, ReportScreen, Screen, useApiMutation, useApiQuery, useCan, useNav, userMessage, type ScreenProps } from '../../app/index.ts';
import { Banner, Button, DataTable, EmptyState, Field, FieldGroup, SegmentedControl, Select, Stack, TextInput, useDebouncedValue, useEnterAdvance, useToast, type Column } from '../../ui/index.ts';
import { LedgerPicker } from '../accounts/pickers.tsx';
import { ACCOUNT_TYPE_LABELS, CHEQUE_INVALIDATES, ifscBank, PAYMENT_MODE_LABELS, payeeDraft, payeeErrors, payeeInput, type PayeeDraft } from './lib/model.ts';

// ───────────────────────────── List ─────────────────────────────

export function PayeeListScreen() {
  const nav = useNav();
  const canAlter = useCan('masters.alter');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'details' | 'all'>('details');
  const [cursor, setCursor] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounced = useDebouncedValue(search, 200);
  const q = useApiQuery('cheques.payee.list', { ...(debounced.trim() ? { search: debounced.trim() } : {}), withDetails: view === 'details', limit: 1000 }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const current = rows.find((r) => String(r.ledgerId) === cursor) ?? rows[0] ?? null;
  const columns = useMemo<Column<PayeeListRow>[]>(
    () => [
      { key: 'ledgerName', header: 'Ledger', minWidth: 200, sortable: true },
      { key: 'groupName', header: 'Under', width: 160 },
      { key: 'beneficiaryName', header: 'Beneficiary', minWidth: 180, value: (r) => r.beneficiaryName ?? '' },
      { key: 'accountNo', header: 'A/c No.', width: 170, value: (r) => r.accountNo ?? '' },
      { key: 'ifsc', header: 'IFSC', width: 130, value: (r) => r.ifsc ?? '' },
      { key: 'bankName', header: 'Bank', width: 160, value: (r) => r.bankName ?? '' },
      { key: 'paymentMode', header: 'Pay by', width: 90, value: (r) => (r.paymentMode ? PAYMENT_MODE_LABELS[r.paymentMode] : '') },
    ],
    [],
  );
  return (
    <ReportScreen
      title="Payee Bank Details"
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Alter · Alt+C Add for a ledger · Ctrl+F Search · Ctrl+1 With details / Ctrl+2 All parties · Alt+E Export"
      actions={[
        { key: 'Alt+C', label: 'Add bank details', icon: 'plus', primary: true, onClick: () => nav.push('cheques.payee.form', {}), hidden: !canAlter },
        { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => current && nav.push('cheques.payee.form', { ledgerId: current.ledgerId }), disabled: !current },
        { key: 'Ctrl+1', label: 'With details', icon: 'filter', onClick: () => setView('details'), disabled: view === 'details', group: 'view' },
        { key: 'Ctrl+2', label: 'All parties', icon: 'filter', onClick: () => setView('all'), disabled: view === 'all', group: 'view' },
        { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: () => searchRef.current?.focus(), group: 'view' },
      ]}
      filters={
        <Stack gap={2}>
          <TextInput ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Search ledger, beneficiary or account" aria-label="Search payees" size="sm" />
          <SegmentedControl<'details' | 'all'> aria-label="Show" size="sm" value={view} onChange={setView} options={[{ value: 'details', label: 'With bank details' }, { value: 'all', label: 'All parties' }]} />
        </Stack>
      }
      exportDef={() => ({
        title: 'Payee Bank Details',
        columns: [{ header: 'Ledger' }, { header: 'Under' }, { header: 'Beneficiary' }, { header: 'A/c No.' }, { header: 'IFSC' }, { header: 'Bank' }, { header: 'Pay by' }],
        rows: rows.map((r) => [r.ledgerName, r.groupName, r.beneficiaryName ?? '', r.accountNo ?? '', r.ifsc ?? '', r.bankName ?? '', r.paymentMode ? PAYMENT_MODE_LABELS[r.paymentMode] : '']),
      })}
    >
      <DataTable<PayeeListRow>
        aria-label="Payee bank details"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.ledgerId)}
        selectedKey={current ? String(current.ledgerId) : null}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(r) => nav.push('cheques.payee.form', { ledgerId: r.ledgerId })}
        loading={q.loading}
        empty={
          <EmptyState
            icon="bank"
            title={view === 'details' ? 'No payee bank details yet' : 'No parties found'}
            body="Bank details of suppliers and other payees go into bulk payment files and on cheques. Press Alt+C to add them for a ledger."
          />
        }
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export function PayeeFormScreen({ params }: ScreenProps<{ ledgerId?: number }>) {
  const [ledgerId, setLedgerId] = useState<number | null>(typeof params.ledgerId === 'number' ? params.ledgerId : null);
  const q = useApiQuery('cheques.payee.get', { ledgerId: ledgerId ?? 0 }, { enabled: ledgerId !== null, staleTime: 0 });
  if (ledgerId === null) return <ChooseLedger onChoose={setLedgerId} />;
  if (!q.data) return <Screen title="Payee Bank Details" icon="bank" width="form" loading={!q.error} error={q.error} onRetry={() => void q.refetch()} />;
  return <PayeeForm key={`${q.data.ledgerId}:${q.data.updatedAt ?? ''}`} saved={q.data} />;
}

function ChooseLedger({ onChoose }: { onChoose: (id: number) => void }) {
  const [id, setId] = useState<number | null>(null);
  return (
    <Screen
      title="Payee Bank Details"
      subtitle="Choose the party or expense ledger"
      icon="bank"
      width="form"
      hint="Type the ledger name · Enter Continue · Esc Back"
      actions={[{ key: 'Ctrl+A', label: 'Continue', icon: 'arrow-right', primary: true, onClick: () => id !== null && onChoose(id), disabled: id === null }]}
    >
      <Field label="Ledger" required hint="Suppliers, customers (refunds), employees or expense ledgers paid by bank transfer or cheque.">
        <LedgerPicker
          classes={['party', 'expense', 'liability', 'asset', 'income']}
          value={id}
          onChange={(v) => setId(v)}
          onCommit={(v) => {
            if (v !== null) onChoose(v);
          }}
          autoFocus
          showBalance={false}
        />
      </Field>
    </Screen>
  );
}

const TYPE_OPTIONS = [{ value: '', label: 'Not stated' }, ...PAYEE_ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))];
const MODE_OPTIONS = [{ value: '', label: 'Decide per payment' }, ...PAYEE_PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))];

function PayeeForm({ saved }: { saved: PayeeBankDetails }) {
  const nav = useNav();
  const toast = useToast();
  const canAlter = useCan('masters.alter');
  const readOnly = !canAlter;
  const initial = useMemo(() => payeeDraft(saved), [saved]);
  const [d, setD] = useState<PayeeDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const save = useApiMutation('cheques.payee.save', { invalidates: CHEQUE_INVALIDATES });
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const errors = showErrors ? { ...payeeErrors(d), ...save.fieldErrors } : save.fieldErrors;
  const patch = (p: Partial<PayeeDraft>): void => setD((x) => ({ ...x, ...p }));
  const submit = async (): Promise<void> => {
    if (readOnly || save.pending) return;
    if (Object.keys(payeeErrors(d)).length > 0) {
      setShowErrors(true);
      return;
    }
    try {
      await save.mutate(payeeInput(saved.ledgerId, d));
      toast.success(`Bank details of ${saved.ledgerName} saved`);
      nav.pop();
    } catch (err) {
      if (Object.keys(fieldErrorsOf(err)).length === 0) toast.error('Not saved', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const bankCode = ifscBank(d.ifsc);
  return (
    <Screen
      title="Payee Bank Details"
      subtitle={saved.ledgerName}
      icon="bank"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || !dirty || save.pending, hidden: readOnly },
        { key: 'Alt+M', label: 'Open ledger', icon: 'ledger', onClick: () => nav.push('accounts.ledger.form', { id: saved.ledgerId }), group: 'nav' },
      ]}
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Payee bank details">
        <Stack gap={5}>
          <Banner tone="info">
            Check a new or changed account with the payee before paying (a call, or a cancelled cheque). Every change is in the edit log.
          </Banner>
          <FieldGroup legend="Bank account" columns={2}>
            <Field label="Beneficiary name" error={errors.beneficiaryName} hint="As the bank has it on the account.">
              <TextInput data-autofocus value={d.beneficiaryName} readOnly={readOnly} maxLength={100} onChange={(e) => patch({ beneficiaryName: e.target.value })} />
            </Field>
            <Field label="Account type">
              <Select<PayeeAccountType | ''> value={d.accountType} options={TYPE_OPTIONS as Array<{ value: PayeeAccountType | ''; label: string }>} disabled={readOnly} onChange={(v) => patch({ accountType: v })} />
            </Field>
            <Field label="Account number" error={errors.accountNo}>
              <TextInput value={d.accountNo} readOnly={readOnly} maxLength={40} mono inputMode="numeric" autoComplete="off" onChange={(e) => patch({ accountNo: e.target.value })} />
            </Field>
            <Field label="Account number again" error={errors.confirmAccountNo} hint="Type it again to rule out a wrong digit.">
              <TextInput value={d.confirmAccountNo} readOnly={readOnly} maxLength={40} mono inputMode="numeric" autoComplete="off" onPaste={(e) => e.preventDefault()} onChange={(e) => patch({ confirmAccountNo: e.target.value })} />
            </Field>
            <Field label="IFSC" error={errors.ifsc} hint={bankCode ? `Bank code ${bankCode}` : '11 characters, e.g. HDFC0001234'}>
              <TextInput value={d.ifsc} readOnly={readOnly} maxLength={20} mono uppercase onChange={(e) => patch({ ifsc: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Bank" error={errors.bankName}>
              <TextInput value={d.bankName} readOnly={readOnly} maxLength={100} onChange={(e) => patch({ bankName: e.target.value })} />
            </Field>
            <Field label="Branch" error={errors.branch}>
              <TextInput value={d.branch} readOnly={readOnly} maxLength={100} onChange={(e) => patch({ branch: e.target.value })} />
            </Field>
            <Field label="Pay by" hint="Used in bulk payment files when the voucher does not say NEFT / RTGS / IMPS.">
              <Select<PayeePaymentMode | ''> value={d.paymentMode} options={MODE_OPTIONS as Array<{ value: PayeePaymentMode | ''; label: string }>} disabled={readOnly} onChange={(v) => patch({ paymentMode: v })} />
            </Field>
          </FieldGroup>
          <FieldGroup legend="Cheques">
            <Field label="Name on cheque" error={errors.chequeName} hint={`Printed on the payee line. Blank: ${d.beneficiaryName.trim() || saved.effectiveChequeName}.`}>
              <TextInput value={d.chequeName} readOnly={readOnly} maxLength={80} onChange={(e) => patch({ chequeName: e.target.value })} />
            </Field>
          </FieldGroup>
          {!readOnly ? (
            <div>
              <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} disabled={!dirty} onClick={() => void submit()} data-enter-target="">
                Save
              </Button>
            </div>
          ) : null}
        </Stack>
      </form>
    </Screen>
  );
}
