/**
 * 'cheques.register' {bankLedgerId?, bookId?, status?} — Cheque Leaf Register (F11 › Cheque printing).
 * Every leaf of the bank's cheque books (and cheques issued outside a book) as on a date: issued
 * (post-dated flagged), cleared (BRS bank date), stale (not cleared 3 months after its date), cancelled
 * (by you, with its voucher, or spoilt by a print) and unused.
 *   Ctrl+1 … Ctrl+6  all / issued / stale / unused / cancelled / cleared
 *   Enter            open the voucher of an issued leaf
 *   Alt+X            cancel an unused leaf (with the reason)  ·  Alt+U re-open one cancelled by mistake
 *   Alt+R            Bank Reconciliation of the bank (where the clearing date is entered)
 *   Alt+B            cheque books  ·  Alt+E export  ·  Alt+P print
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDate, localDateOf, todayLocal } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { ChequeRegisterRow } from '../../../shared/types/cheques.ts';
import { fieldErrorsOf, ReportScreen, Screen, useApiMutation, useApiQuery, useCan, useNav, userMessage, useWorkingDate, type ScreenProps } from '../../app/index.ts';
import { Badge, Button, DataTable, DateInput, Dialog, EmptyState, Field, Hotkeys, Inline, KpiCard, SegmentedControl, Select, Stack, TextInput, useToast, type Column } from '../../ui/index.ts';
import { ChequeBankSelect, ChequesOff, NoChequeBanks, useChequeBanks, useChequesOn } from './components.tsx';
import { CHEQUE_INVALIDATES, leafActions, REGISTER_VIEWS, registerExport, STATUS_LABELS, STATUS_TONES, type RegisterView } from './lib/model.ts';

export interface ChequeRegisterParams {
  bankLedgerId?: number;
  bookId?: number;
  status?: RegisterView;
}

export function ChequeLeafRegisterScreen({ params }: ScreenProps<ChequeRegisterParams>) {
  const on = useChequesOn();
  if (!on) return <ChequesOff title="Cheque Leaf Register" />;
  return <Register params={params} />;
}

function Register({ params }: { params: ChequeRegisterParams }) {
  const nav = useNav();
  const { date: workingDate } = useWorkingDate();
  const canAlter = useCan('vouchers.alter');
  const { banks, loading: banksLoading } = useChequeBanks();
  const [bankId, setBankId] = useState<number | null>(typeof params.bankLedgerId === 'number' ? params.bankLedgerId : null);
  const [bookId, setBookId] = useState<number | null>(typeof params.bookId === 'number' ? params.bookId : null);
  const [view, setView] = useState<RegisterView>(REGISTER_VIEWS.some((v) => v.value === params.status) ? (params.status as RegisterView) : 'all');
  const [asOf, setAsOf] = useState<string>(todayLocal());
  const [cursor, setCursor] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<ChequeRegisterRow | null>(null);
  useEffect(() => {
    if (bankId === null && banks.length > 0) setBankId(banks[0].ledgerId);
  }, [bankId, banks]);
  const q = useApiQuery('cheques.register', { bankLedgerId: bankId ?? 0, ...(bookId !== null ? { bookId } : {}), status: view, asOf }, { enabled: bankId !== null, keepPrevious: true });
  const books = useApiQuery('cheques.book.list', { bankLedgerId: bankId ?? 0 }, { enabled: bankId !== null });
  const restore = useApiMutation('cheques.leaf.restore', { invalidates: CHEQUE_INVALIDATES });
  const toast = useToast();
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const totals = q.data?.totals;
  const current = rows.find((r) => r.key === cursor) ?? rows[0] ?? null;
  const can = leafActions(current);

  const reopen = async (r: ChequeRegisterRow): Promise<void> => {
    if (bankId === null) return;
    try {
      await restore.mutate({ bankLedgerId: bankId, chequeNo: r.chequeNo });
      toast.success(`Cheque ${r.chequeNo} is unused again`);
    } catch (err) {
      toast.error('Not re-opened', { message: userMessage(err) });
    }
  };

  const columns = useMemo<Column<ChequeRegisterRow>[]>(
    () => [
      { key: 'chequeNo', header: 'Cheque No.', width: 120, sortable: true },
      {
        key: 'status',
        header: 'Status',
        width: 150,
        sortable: true,
        value: (r) => STATUS_LABELS[r.status],
        render: (r) => (
          <Inline gap={1}>
            <Badge size="sm" tone={STATUS_TONES[r.status]}>
              {STATUS_LABELS[r.status]}
            </Badge>
            {r.postDated ? (
              <Badge size="sm" tone="info">
                PDC
              </Badge>
            ) : null}
          </Inline>
        ),
      },
      { key: 'chequeDate', header: 'Cheque date', kind: 'date', width: 110, sortable: true },
      { key: 'payee', header: 'Payee', minWidth: 180, value: (r) => r.payee ?? '' },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, total: true, value: (r) => r.amount ?? 0, render: (r) => (r.amount === null ? '' : formatMoney(r.amount)) },
      { key: 'voucherLabel', header: 'Voucher', minWidth: 170, value: (r) => r.voucherLabel ?? '' },
      { key: 'bankDate', header: 'Cleared on', kind: 'date', width: 110 },
      { key: 'printedAt', header: 'Printed', width: 110, value: (r) => (r.printedAt ? formatDate(localDateOf(r.printedAt)) : '') },
      { key: 'bookName', header: 'Book', width: 150, value: (r) => r.bookName ?? 'Outside the books' },
      { key: 'reason', header: 'Remarks', minWidth: 200, value: (r) => r.reason ?? '' },
    ],
    [],
  );

  if (!banksLoading && banks.length === 0) {
    return (
      <Screen title="Cheque Leaf Register" icon="book">
        <NoChequeBanks />
      </Screen>
    );
  }

  return (
    <ReportScreen
      title="Cheque Leaf Register"
      periodMode="none"
      loading={q.loading || bankId === null}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open voucher · Ctrl+1…6 View · Alt+X Cancel leaf · Alt+U Re-open leaf · Alt+R Reconciliation · Alt+B Cheque books · Alt+E Export"
      actions={[
        ...REGISTER_VIEWS.map((v, i) => ({ key: `Ctrl+${i + 1}`, label: v.label, onClick: () => setView(v.value), disabled: view === v.value, group: 'view' })),
        { key: 'Alt+X', label: 'Cancel leaf', icon: 'x-circle' as const, onClick: () => current && can.cancel && setCancelling(current), disabled: !can.cancel, hidden: !canAlter, hint: 'Spoilt or lost leaves: they are never given to a payment', group: 'danger' },
        { key: 'Alt+U', label: 'Re-open leaf', icon: 'undo' as const, onClick: () => current && can.restore && void reopen(current), disabled: !can.restore || restore.pending, hidden: !canAlter, group: 'danger' },
        { key: 'Alt+R', label: 'Reconciliation', icon: 'bank' as const, onClick: () => nav.push('banking.brs', bankId !== null ? { ledgerId: bankId } : {}), group: 'go' },
        { key: 'Alt+B', label: 'Cheque books', icon: 'book' as const, onClick: () => nav.push('cheques.books', bankId !== null ? { bankLedgerId: bankId } : {}), group: 'go' },
      ]}
      filters={
        <Inline gap={2} wrap align="end">
          <ChequeBankSelect banks={banks} value={bankId} onChange={(v) => { setBankId(v); setBookId(null); }} />
          <SegmentedControl<RegisterView> aria-label="Leaves" size="sm" value={view} onChange={setView} options={REGISTER_VIEWS} />
          <Select
            aria-label="Cheque book"
            size="sm"
            value={bookId === null ? '' : String(bookId)}
            onChange={(v: string) => setBookId(v === '' ? null : Number(v))}
            options={[{ value: '', label: 'All books' }, ...(books.data ?? []).map((b) => ({ value: String(b.id), label: b.name }))]}
          />
          <DateInput aria-label="Status as on" size="sm" value={asOf} referenceDate={workingDate} onChange={(v) => v && setAsOf(v)} />
        </Inline>
      }
      exportDef={() => (q.data ? registerExport(q.data) : { title: 'Cheque Leaf Register', columns: [], rows: [] })}
    >
      <Stack gap={3}>
        {totals ? (
          <Inline gap={3} wrap>
            <KpiCard label="Issued, not cleared" value={totals.unclearedAmount} amount caption={`${totals.issued + totals.stale} cheques (${totals.stale} stale)`} icon="clock" />
            <KpiCard label="Leaves" value={String(totals.leaves)} caption={`${totals.unused} unused · ${totals.cleared} cleared · ${totals.cancelled} cancelled`} icon="book" />
            <KpiCard label="Stale cheques" value={String(totals.stale)} caption="Valid 3 months from their date: re-issue them, or cancel the payment" icon="alert" />
          </Inline>
        ) : null}
        <DataTable<ChequeRegisterRow>
          aria-label="Cheque leaves"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          selectedKey={current?.key ?? null}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => {
            if (r.voucherId !== null) nav.push('vouchers.view', { id: r.voucherId });
          }}
          loading={q.loading}
          empty={
            <EmptyState
              icon="book"
              title={view === 'all' ? 'No cheque leaves for this bank' : `No ${STATUS_LABELS[view as Exclude<RegisterView, 'all'>].toLowerCase()} leaves`}
              body="Add the bank's cheque books (Alt+B). Cheques written in Payments and Contras appear here with their clearing status from the Bank Reconciliation."
            />
          }
        />
      </Stack>
      {cancelling && bankId !== null ? <CancelLeafDialog bankLedgerId={bankId} row={cancelling} onClose={() => setCancelling(null)} /> : null}
    </ReportScreen>
  );
}

function CancelLeafDialog({ bankLedgerId, row, onClose }: { bankLedgerId: number; row: ChequeRegisterRow; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const cancel = useApiMutation('cheques.leaf.cancel', { invalidates: CHEQUE_INVALIDATES });
  const submit = async (): Promise<void> => {
    if (!reason.trim()) {
      setError('Say why the leaf is cancelled (e.g. spoilt while writing, torn, lost).');
      return;
    }
    try {
      await cancel.mutate({ bankLedgerId, chequeNo: row.chequeNo, reason: reason.trim() });
      toast.success(`Cheque ${row.chequeNo} cancelled`);
      onClose();
    } catch (err) {
      const fe = fieldErrorsOf(err);
      setError(fe.reason ?? fe.chequeNo ?? userMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cancel cheque ${row.chequeNo}?`}
      description="A cancelled leaf is never given to a payment. Keep the spoilt leaf with your records (write CANCELLED across it)."
      initialFocusRef={ref}
      footer={
        <>
          <Button onClick={onClose}>Go back</Button>
          <Button variant="danger" shortcut="Ctrl+A" loading={cancel.pending} onClick={() => void submit()}>
            Cancel leaf
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void submit() }} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Reason" required error={error ?? undefined}>
          <TextInput ref={ref} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Spoilt while writing" />
        </Field>
      </form>
    </Dialog>
  );
}
