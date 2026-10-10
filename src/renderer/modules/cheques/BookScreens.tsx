/**
 * Cheque books and per-bank cheque printing settings (F11 › Cheque printing):
 *   'cheques.books'      {bankLedgerId?}      every cheque book of one bank / all banks, with leaves issued,
 *                                             cancelled and unused and the next leaf. Alt+C create · Enter /
 *                                             Alt+A alter · Alt+D delete (only while no leaf is used) ·
 *                                             Alt+R leaf register · Alt+S bank print settings · Alt+L layouts
 *   'cheques.book.form'  {bankLedgerId?, id?} bank, first / last leaf, digits, name, active. Ctrl+A save
 *   'cheques.bank'       {bankLedgerId?}      the bank's cheque layout, 'A/c Payee' by default, signatory
 * A Payment / Contra paid by cheque without a number takes the next unused leaf of the bank's active
 * books when it is saved (core: cheques/hook.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ChequeBook } from '../../../shared/types/cheques.ts';
import { fieldErrorsOf, ReportScreen, Screen, useApiMutation, useApiQuery, useCan, useConfirm, useNav, userMessage, type ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, EmptyState, Field, FieldGroup, NumberInput, Select, Stack, Switch, TextInput, useEnterAdvance, useToast, type Column } from '../../ui/index.ts';
import { ChequeBankSelect, ChequesOff, NoChequeBanks, useChequeBanks, useChequesOn } from './components.tsx';
import { bookDraft, bookErrors, bookInput, bookLeaves, bookStatus, CHEQUE_INVALIDATES, padNo, type BookDraft } from './lib/model.ts';

// ───────────────────────────── List ─────────────────────────────

export function ChequeBooksScreen({ params }: ScreenProps<{ bankLedgerId?: number }>) {
  const on = useChequesOn();
  if (!on) return <ChequesOff title="Cheque Books" />;
  return <BookList initialBank={typeof params.bankLedgerId === 'number' ? params.bankLedgerId : null} />;
}

function BookList({ initialBank }: { initialBank: number | null }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canAlter = useCan('masters.alter');
  const canDelete = useCan('masters.delete');
  const { banks, loading: banksLoading } = useChequeBanks();
  const [bankId, setBankId] = useState<number | null>(initialBank);
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useApiQuery('cheques.book.list', bankId !== null ? { bankLedgerId: bankId } : {}, { keepPrevious: true });
  const del = useApiMutation('cheques.book.delete', { invalidates: CHEQUE_INVALIDATES });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const current = rows.find((r) => String(r.id) === cursor) ?? rows[0] ?? null;
  const targetBank = current?.bankLedgerId ?? bankId ?? (banks.length === 1 ? banks[0].ledgerId : null);

  const remove = async (b: ChequeBook): Promise<void> => {
    if (!(await confirm({ title: `Delete cheque book ${b.name}?`, message: `${b.bankLedgerName}: leaves ${padNo(b.fromNo, b.digits)} to ${padNo(b.toNo, b.digits)}. A book with a used or cancelled leaf stays on record (make it inactive instead).`, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: b.id });
      toast.success(`Cheque book ${b.name} deleted`);
      setCursor(null);
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    }
  };

  const columns = useMemo<Column<ChequeBook>[]>(
    () => [
      { key: 'bankLedgerName', header: 'Bank', minWidth: 180, sortable: true, hidden: bankId !== null },
      { key: 'name', header: 'Cheque book', minWidth: 180, sortable: true },
      { key: 'fromNo', header: 'From', width: 110, value: (r) => padNo(r.fromNo, r.digits) },
      { key: 'toNo', header: 'To', width: 110, value: (r) => padNo(r.toNo, r.digits) },
      { key: 'leaves', header: 'Leaves', kind: 'number', decimals: 0, width: 90, total: true },
      { key: 'issued', header: 'Issued', kind: 'number', decimals: 0, width: 90, total: true },
      { key: 'cancelled', header: 'Cancelled', kind: 'number', decimals: 0, width: 100, total: true },
      { key: 'unused', header: 'Unused', kind: 'number', decimals: 0, width: 90, total: true },
      {
        key: 'nextNo',
        header: 'Status',
        width: 150,
        value: (r) => bookStatus(r).label,
        render: (r) => {
          const s = bookStatus(r);
          return (
            <Badge size="sm" tone={s.tone}>
              {s.label}
            </Badge>
          );
        },
      },
    ],
    [bankId],
  );

  return (
    <ReportScreen
      title="Cheque Books"
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create cheque book · Alt+D Delete · Alt+R Leaf register · Alt+S Bank print settings · Alt+L Layouts · Alt+E Export"
      actions={[
        { key: 'Alt+C', label: 'Create cheque book', icon: 'plus', primary: true, onClick: () => nav.push('cheques.book.form', targetBank !== null ? { bankLedgerId: targetBank } : {}), hidden: !canCreate },
        { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => current && nav.push('cheques.book.form', { id: current.id, bankLedgerId: current.bankLedgerId }), disabled: !current, hidden: !canAlter },
        { key: 'Alt+R', label: 'Leaf register', icon: 'book', onClick: () => targetBank !== null && nav.push('cheques.register', { bankLedgerId: targetBank }), disabled: targetBank === null, group: 'go' },
        { key: 'Alt+S', label: 'Bank print settings', icon: 'settings', onClick: () => nav.push('cheques.bank', targetBank !== null ? { bankLedgerId: targetBank } : {}), group: 'go' },
        { key: 'Alt+L', label: 'Cheque layouts', icon: 'layers', onClick: () => nav.push('cheques.layouts'), group: 'go' },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => current && void remove(current), disabled: !current || current.issued + current.cancelled > 0 || del.pending, hidden: !canDelete, group: 'danger' },
      ]}
      filters={<ChequeBankSelect banks={banks} value={bankId} onChange={setBankId} allowAll />}
      exportDef={() => ({
        title: 'Cheque Books',
        subtitle: bankId === null ? 'All banks' : (banks.find((b) => b.ledgerId === bankId)?.name ?? ''),
        columns: [{ header: 'Bank' }, { header: 'Cheque book' }, { header: 'From' }, { header: 'To' }, { header: 'Leaves', kind: 'number' }, { header: 'Issued', kind: 'number' }, { header: 'Cancelled', kind: 'number' }, { header: 'Unused', kind: 'number' }, { header: 'Status' }],
        rows: rows.map((r) => [r.bankLedgerName, r.name, padNo(r.fromNo, r.digits), padNo(r.toNo, r.digits), r.leaves, r.issued, r.cancelled, r.unused, bookStatus(r).label]),
        totals: ['Total', '', '', '', rows.reduce((a, r) => a + r.leaves, 0), rows.reduce((a, r) => a + r.issued, 0), rows.reduce((a, r) => a + r.cancelled, 0), rows.reduce((a, r) => a + r.unused, 0), ''],
      })}
    >
      {!banksLoading && banks.length === 0 ? (
        <NoChequeBanks />
      ) : (
        <DataTable<ChequeBook>
          aria-label="Cheque books"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          selectedKey={current ? String(current.id) : null}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => nav.push(canAlter ? 'cheques.book.form' : 'cheques.register', canAlter ? { id: r.id, bankLedgerId: r.bankLedgerId } : { bankLedgerId: r.bankLedgerId, bookId: r.id })}
          loading={q.loading}
          empty={<EmptyState icon="book" title="No cheque books yet" body="Enter the first and last leaf number of each cheque book (Alt+C). Payments by cheque then take the next leaf on their own." />}
        />
      )}
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export function ChequeBookFormScreen({ params }: ScreenProps<{ bankLedgerId?: number; id?: number }>) {
  const on = useChequesOn();
  const id = typeof params.id === 'number' ? params.id : undefined;
  const bank = typeof params.bankLedgerId === 'number' ? params.bankLedgerId : null;
  const q = useApiQuery('cheques.book.list', bank !== null ? { bankLedgerId: bank } : {}, { enabled: on && id !== undefined, staleTime: 0 });
  if (!on) return <ChequesOff title="Cheque Book" />;
  if (id === undefined) return <BookForm saved={null} initialBank={bank} />;
  const book = q.data?.find((b) => b.id === id) ?? null;
  if (!book) {
    return (
      <Screen title="Cheque Book Alteration" icon="book" width="form" loading={q.loading} error={q.error} onRetry={() => void q.refetch()}>
        {!q.loading && !q.error ? <EmptyState icon="book" title="This cheque book no longer exists" body="It may have been deleted. Press Esc to go back." /> : null}
      </Screen>
    );
  }
  return <BookForm key={`${book.id}:${book.fromNo}:${book.toNo}:${book.isActive}`} saved={book} initialBank={book.bankLedgerId} />;
}

function BookForm({ saved, initialBank }: { saved: ChequeBook | null; initialBank: number | null }) {
  const nav = useNav();
  const toast = useToast();
  const canSave = useCan(saved ? 'masters.alter' : 'masters.create');
  const { banks } = useChequeBanks();
  const [bankId, setBankId] = useState<number | null>(initialBank);
  const initial = useMemo(() => bookDraft(saved), [saved]);
  const [d, setD] = useState<BookDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const save = useApiMutation('cheques.book.save', { invalidates: CHEQUE_INVALIDATES });
  // A single bank: choose it.
  useEffect(() => {
    if (bankId === null && banks.length === 1) setBankId(banks[0].ledgerId);
  }, [bankId, banks]);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial) || bankId !== initialBank;
  const local = bookErrors(d);
  const errors: Partial<Record<string, string>> = showErrors ? { ...local, ...(bankId === null ? { bankLedgerId: 'Choose the bank whose cheque book this is.' } : {}), ...save.fieldErrors } : save.fieldErrors;
  const patch = (p: Partial<BookDraft>): void => setD((x) => ({ ...x, ...p }));
  const leaves = bookLeaves(d);
  const digits = d.digits ?? 6;

  const submit = async (): Promise<void> => {
    if (!canSave || save.pending) return;
    if (Object.keys(local).length > 0 || bankId === null) {
      setShowErrors(true);
      return;
    }
    try {
      const out = await save.mutate(bookInput(bankId, d, saved?.id));
      toast.success(`Cheque book ${out.name} saved`, { message: out.nextNo ? `Next leaf ${out.nextNo}` : undefined });
      nav.pop();
    } catch (err) {
      setShowErrors(true);
      if (Object.keys(fieldErrorsOf(err)).length === 0) toast.error('Not saved', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });

  return (
    <Screen
      title={saved ? 'Cheque Book Alteration' : 'Cheque Book Creation'}
      subtitle={saved ? `${saved.bankLedgerName} · ${saved.name}` : undefined}
      icon="book"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Esc Back"
      actions={[{ key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !canSave || save.pending, hidden: !canSave }]}
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Cheque book">
        <Stack gap={5}>
          {saved && saved.issued + saved.cancelled > 0 ? (
            <Banner tone="info">
              {saved.issued} leaves of this book are issued and {saved.cancelled} cancelled. You can change the range, but the leaves already used stay with their vouchers.
            </Banner>
          ) : null}
          <FieldGroup legend="Cheque book" columns={2}>
            <Field label="Bank" required error={errors.bankLedgerId} hint={saved ? 'A book cannot move to another bank.' : undefined}>
              <ChequeBankSelect banks={banks} value={bankId} onChange={setBankId} disabled={!!saved || !canSave} autoFocus={!saved && initialBank === null} />
            </Field>
            <Field label="Name" optional error={errors.name} hint={leaves !== null ? `Blank: ${padNo(d.fromNo ?? 0, digits)}–${padNo(d.toNo ?? 0, digits)}` : 'Blank: the leaf range'}>
              <TextInput value={d.name} maxLength={100} readOnly={!canSave} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="First leaf number" required error={errors.fromNo} hint="Printed on the first leaf (top-left / MICR band).">
              <NumberInput value={d.fromNo} min={0} grouping={false} expressions={false} align="left" readOnly={!canSave} data-autofocus={saved || initialBank !== null ? '' : undefined} onChange={(v) => patch({ fromNo: v })} />
            </Field>
            <Field label="Last leaf number" required error={errors.toNo} hint={leaves !== null ? `${leaves} leaves` : 'A book of 25 leaves from 000501 ends at 000525.'}>
              <NumberInput value={d.toNo} min={0} grouping={false} expressions={false} align="left" readOnly={!canSave} onChange={(v) => patch({ toNo: v })} />
            </Field>
            <Field label="Digits" error={errors.digits} hint="Cheque numbers are printed with leading zeros (6 on CTS-2010 cheques).">
              <NumberInput value={d.digits} min={1} max={12} step={1} grouping={false} align="left" readOnly={!canSave} onChange={(v) => patch({ digits: v })} />
            </Field>
            <Field label="Active" hint="Inactive books are skipped when the next leaf is chosen.">
              <Switch checked={d.isActive} disabled={!canSave} onChange={(v) => patch({ isActive: v })} />
            </Field>
          </FieldGroup>
          {canSave ? (
            <div>
              <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()} data-enter-target="">
                Save
              </Button>
            </div>
          ) : null}
        </Stack>
      </form>
    </Screen>
  );
}

// ───────────────────────────── Bank print settings ─────────────────────────────

export function BankSettingsScreen({ params }: ScreenProps<{ bankLedgerId?: number }>) {
  const on = useChequesOn();
  const { banks, loading } = useChequeBanks();
  const [bankId, setBankId] = useState<number | null>(typeof params.bankLedgerId === 'number' ? params.bankLedgerId : null);
  useEffect(() => {
    if (bankId === null && banks.length === 1) setBankId(banks[0].ledgerId);
  }, [bankId, banks]);
  const q = useApiQuery('cheques.bank.get', { bankLedgerId: bankId ?? 0 }, { enabled: on && bankId !== null, staleTime: 0 });
  if (!on) return <ChequesOff title="Cheque Printing Settings" />;
  if (bankId === null || !q.data) {
    return (
      <Screen title="Cheque Printing Settings" icon="settings" width="form" loading={loading || (bankId !== null && q.loading)} error={q.error} onRetry={() => void q.refetch()} hint="Choose the bank · Esc Back">
        {!loading && banks.length === 0 ? (
          <NoChequeBanks />
        ) : (
          <Field label="Bank" required hint="Each bank account has its own cheque layout and signatory text.">
            <ChequeBankSelect banks={banks} value={bankId} onChange={setBankId} autoFocus />
          </Field>
        )}
      </Screen>
    );
  }
  return <BankSettingsForm key={`${q.data.bankLedgerId}:${q.data.layoutId}:${q.data.acPayee}:${q.data.signatory}`} saved={q.data} onBank={setBankId} />;
}

function BankSettingsForm({ saved, onBank }: { saved: { bankLedgerId: number; bankLedgerName: string; layoutId: number | null; acPayee: boolean; signatory: string | null }; onBank: (id: number | null) => void }) {
  const nav = useNav();
  const toast = useToast();
  const canAlter = useCan('masters.alter');
  const { banks } = useChequeBanks();
  const layouts = useApiQuery('cheques.layout.list', {});
  const [layoutId, setLayoutId] = useState<number | null>(saved.layoutId);
  const [acPayee, setAcPayee] = useState(saved.acPayee);
  const [signatory, setSignatory] = useState(saved.signatory ?? '');
  const save = useApiMutation('cheques.bank.save', { invalidates: CHEQUE_INVALIDATES });
  const dirty = layoutId !== saved.layoutId || acPayee !== saved.acPayee || signatory.trim() !== (saved.signatory ?? '');
  const submit = async (): Promise<void> => {
    if (!canAlter || save.pending) return;
    try {
      await save.mutate({ bankLedgerId: saved.bankLedgerId, layoutId, acPayee, signatory: signatory.trim() || null });
      toast.success(`Cheque printing settings of ${saved.bankLedgerName} saved`);
      nav.pop();
    } catch (err) {
      if (Object.keys(fieldErrorsOf(err)).length === 0) toast.error('Not saved', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const layoutOptions = [{ value: '', label: 'CTS-2010 standard leaf (preset)' }, ...(layouts.data ?? []).map((l) => ({ value: String(l.id), label: l.name }))];
  return (
    <Screen
      title="Cheque Printing Settings"
      subtitle={saved.bankLedgerName}
      icon="settings"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Alt+L Layouts · Alt+B Cheque books · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !canAlter || !dirty || save.pending, hidden: !canAlter },
        { key: 'Alt+L', label: 'Cheque layouts', icon: 'layers', onClick: () => nav.push('cheques.layouts'), group: 'go' },
        { key: 'Alt+B', label: 'Cheque books', icon: 'book', onClick: () => nav.push('cheques.books', { bankLedgerId: saved.bankLedgerId }), group: 'go' },
      ]}
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Cheque printing settings">
        <Stack gap={5}>
          <FieldGroup legend="Bank">
            <Field label="Bank">
              <ChequeBankSelect banks={banks} value={saved.bankLedgerId} onChange={(v) => !dirty && onBank(v)} disabled={dirty} />
            </Field>
          </FieldGroup>
          <FieldGroup legend="Printing" columns={2}>
            <Field label="Cheque layout" error={save.fieldErrors.layoutId} hint="Where the date, payee and amount go on this bank's leaves. Calibrate it once (Alt+L).">
              <Select aria-label="Cheque layout" data-autofocus="" value={layoutId === null ? '' : String(layoutId)} options={layoutOptions} disabled={!canAlter} onChange={(v: string) => setLayoutId(v === '' ? null : Number(v))} />
            </Field>
            <Field label="Cross 'A/c Payee'" hint="Printed on every cheque of this bank unless you switch it off for one (never on a self cheque).">
              <Switch checked={acPayee} disabled={!canAlter} onChange={setAcPayee} />
            </Field>
            <Field label="Signatory text" error={save.fieldErrors.signatory} hint="Under the signature space, e.g. Authorised Signatory / Partner / Director.">
              <TextInput value={signatory} maxLength={100} readOnly={!canAlter} placeholder="Authorised Signatory" onChange={(e) => setSignatory(e.target.value)} />
            </Field>
          </FieldGroup>
          {canAlter ? (
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
