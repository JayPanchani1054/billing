/**
 * 'cheques.epayments' {bankLedgerId?} — E-payment File: Payments of the period (Alt+F2) made by bank
 * transfer (NEFT / RTGS / IMPS, or no instrument), each with the payee's beneficiary account. Tick the
 * ones to pay (Space / Enter, Alt+A all ready ones) and Ctrl+A saves the bulk payment CSV to upload in
 * the bank's corporate net banking (generic layout: README › E-payments). Payments with a problem
 * (no bank details, several payees, RTGS under ₹2 lakh …) are listed with the fix and never go into a
 * file; Alt+M opens the payee's bank details, Alt+O the voucher. Saving a file is an export (edit log).
 */
import { useMemo, useState } from 'react';
import { formatDate, localDateOf, todayLocal } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { EPaymentCandidate } from '../../../shared/types/cheques.ts';
import { api, invalidate, native, ReportScreen, showInFolder, useApiQuery, useCan, useConfirm, useNav, usePeriod, userMessage, useWorkingDate, type ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Checkbox, DataTable, DateInput, EmptyState, Field, Inline, Stack, useToast, type Column } from '../../ui/index.ts';
import { ChequeBankSelect, useChequeBanks } from './components.tsx';
import { alreadyExported, CHEQUE_INVALIDATES, epaymentChosen, epaymentExport, makeAndSavePaymentFile, readyPayments, toggleAllReady } from './lib/model.ts';

const CSV_FILTERS = [{ name: 'CSV file', extensions: ['csv'] }];

export function EPaymentScreen({ params }: ScreenProps<{ bankLedgerId?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canExport = useCan('data.export');
  const { from, to } = usePeriod();
  const { date: workingDate } = useWorkingDate();
  const { banks } = useChequeBanks();
  const [bankId, setBankId] = useState<number | null>(typeof params.bankLedgerId === 'number' ? params.bankLedgerId : null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [valueDate, setValueDate] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const q = useApiQuery('cheques.epayment.list', { from, to, ...(bankId !== null ? { bankLedgerId: bankId } : {}) }, { keepPrevious: true, staleTime: 0 });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const chosen = epaymentChosen(rows, selected);
  const total = chosen.reduce((a, r) => a + r.amount, 0);
  const ready = readyPayments(rows);
  const problems = rows.length - ready.length;
  const current = rows.find((r) => String(r.voucherId) === cursor) ?? rows[0] ?? null;
  const toggle = (r: EPaymentCandidate): void => {
    if (r.problem !== null) {
      toast.info('Not ready for a payment file', { message: r.problem });
      return;
    }
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(r.voucherId)) next.delete(r.voucherId);
      else next.add(r.voucherId);
      return next;
    });
  };

  const saveFile = async (): Promise<void> => {
    if (chosen.length === 0 || saving || !canExport) return;
    const again = alreadyExported(chosen);
    if (again.length > 0) {
      const ok = await confirm({
        title: `${again.length} payment${again.length === 1 ? ' is' : 's are'} already in a payment file`,
        message: 'Uploading them again pays the beneficiary twice. Continue only if the earlier file was not uploaded.',
        warnings: again.map((r) => `${r.voucherLabel} · ${r.payeeName ?? ''} · ${formatMoney(r.amount, { symbol: true })} — file of ${formatDate(localDateOf(r.exportedAt))}`),
        confirmLabel: 'Put them in the file',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const { file, saved } = await makeAndSavePaymentFile({
        make: () => api('cheques.epayment.export', { voucherIds: chosen.map((r) => r.voucherId), ...(valueDate ? { valueDate } : {}) }),
        save: (f) => native('dialog.saveFile', { title: 'Save the bulk payment file', defaultName: f.fileName, filters: CSV_FILTERS, data: f.bytes }),
        discard: (batchId) => api('cheques.epayment.discard', { batchId }),
      });
      invalidate(CHEQUE_INVALIDATES[0]);
      if (saved) {
        toast.success(`Payment file saved: ${file.rows} payment${file.rows === 1 ? '' : 's'}, ${formatMoney(file.total, { symbol: true })}`, {
          message: 'Upload it in your bank’s net banking (bulk / file upload) and authorise it there.',
          action: { label: 'Show in folder', onClick: () => showInFolder(saved.path) },
        });
        setSelected(new Set());
      }
      if (file.skipped.length > 0) toast.warning(`${file.skipped.length} payment${file.skipped.length === 1 ? ' was' : 's were'} left out`, { message: file.skipped.map((s) => `${s.label}: ${s.reason}`).join(' · ') });
      void q.refetch();
    } catch (err) {
      toast.error('The payment file was not made', { message: userMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo<Column<EPaymentCandidate>[]>(
    () => [
      {
        key: 'pick',
        header: 'Pay',
        headerLabel: 'In the payment file',
        width: 60,
        render: (r) => <Checkbox checked={selected.has(r.voucherId)} disabled={r.problem !== null} aria-label={`Put ${r.voucherLabel} in the file`} tabIndex={-1} onChange={() => toggle(r)} />,
      },
      { key: 'date', header: 'Date', kind: 'date', width: 104, sortable: true },
      { key: 'voucherLabel', header: 'Voucher', minWidth: 170 },
      { key: 'payeeName', header: 'Payee', minWidth: 170, sortable: true, value: (r) => r.payeeName ?? '' },
      { key: 'beneficiaryName', header: 'Beneficiary', minWidth: 160, value: (r) => r.beneficiaryName ?? '' },
      { key: 'accountNo', header: 'A/c No.', width: 150, value: (r) => r.accountNo ?? '' },
      { key: 'ifsc', header: 'IFSC', width: 120, value: (r) => r.ifsc ?? '' },
      { key: 'mode', header: 'Mode', width: 76, value: (r) => r.mode.toUpperCase() },
      { key: 'bankLedgerName', header: 'From bank', width: 150, hidden: bankId !== null },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, total: true, sortable: true },
      {
        key: 'status',
        header: 'Status',
        minWidth: 200,
        value: (r) => r.problem ?? (r.exportedAt ? 'In a payment file' : 'Ready'),
        render: (r) =>
          r.problem !== null ? (
            <Badge size="sm" tone="danger" icon="alert">
              {r.problem}
            </Badge>
          ) : r.exportedAt ? (
            <Badge size="sm" tone="warning">
              {`In a file of ${formatDate(localDateOf(r.exportedAt))}`}
            </Badge>
          ) : (
            <Badge size="sm" tone="success">
              Ready
            </Badge>
          ),
      },
    ],
    [selected, bankId],
  );

  return (
    <ReportScreen
      title="E-payment File"
      subtitle={`${chosen.length} selected · ${formatMoney(total, { symbol: true })}`}
      periodMode="range"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Space or Enter Tick · Alt+A Tick all ready · Ctrl+A Save payment file · Alt+M Payee bank details · Alt+O Open voucher · Alt+F2 Period"
      actions={[
        { key: 'Ctrl+A', label: 'Save payment file', icon: 'download', primary: true, onClick: () => void saveFile(), disabled: chosen.length === 0 || saving || !canExport, hint: canExport ? 'A CSV for the bank’s bulk upload; recorded in the edit log' : 'Making a payment file needs the Data › Export permission' },
        { key: 'Alt+A', label: ready.length > 0 && ready.every((r) => selected.has(r.voucherId)) ? 'Untick all' : 'Tick all ready', icon: 'check', onClick: () => setSelected((s) => toggleAllReady(rows, s)), disabled: ready.length === 0 },
        { key: 'Alt+M', label: 'Payee bank details', icon: 'bank', onClick: () => current?.payeeLedgerId && nav.push('cheques.payee.form', { ledgerId: current.payeeLedgerId }), disabled: !current?.payeeLedgerId, group: 'go' },
        { key: 'Alt+O', label: 'Open voucher', icon: 'eye', onClick: () => current && nav.push('vouchers.view', { id: current.voucherId }), disabled: !current, group: 'go' },
      ]}
      filters={
        <Inline gap={3} wrap align="end">
          <Field label="From bank">
            <ChequeBankSelect banks={banks} value={bankId} onChange={(v) => { setBankId(v); setSelected(new Set()); }} allowAll />
          </Field>
          <Field label="Value date" hint="Blank: each payment's date (never before today)">
            <DateInput aria-label="Value date" size="sm" value={valueDate} minDate={todayLocal()} referenceDate={workingDate} onChange={setValueDate} />
          </Field>
        </Inline>
      }
      exportDef={() => epaymentExport(rows, { from, to })}
    >
      <Stack gap={3}>
        {problems > 0 ? (
          <Banner tone="warning" title={`${problems} payment${problems === 1 ? '' : 's'} cannot go into a file yet`}>
            Fix each one as its status says (Alt+M opens the payee's bank details), or pay it another way.
          </Banner>
        ) : null}
        <DataTable<EPaymentCandidate>
          aria-label="Payments by bank transfer"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.voucherId)}
          selectedKey={current ? String(current.voucherId) : null}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => toggle(r)}
          onRowKeyDown={(e, r) => {
            if (r && e.key === ' ' && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              toggle(r);
            }
          }}
          loading={q.loading}
          empty={
            <EmptyState
              icon="bank"
              title="No payments by bank transfer in this period"
              body="Payments whose bank line says NEFT, RTGS or IMPS (Alt+K in the voucher), or has no instrument, are listed here. Cheque, DD, UPI and card payments are not. Change the period with Alt+F2."
            />
          }
        />
      </Stack>
    </ReportScreen>
  );
}
