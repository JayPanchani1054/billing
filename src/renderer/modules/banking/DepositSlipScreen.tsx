/**
 * 'banking.depositSlip' — Bank pay-in slip for a day. Params: { ledgerId?, date? }.
 * Cheques/DDs received into the bank on the date plus cash deposited, with totals and amount in words.
 * Alt+P prints it (printReport), Alt+E exports; Enter on a cheque opens its voucher.
 */
import { useMemo, useState } from 'react';
import type { DepositSlipCheque } from '../../../shared/types/banking.ts';
import { formatDate } from '../../../shared/dates.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Card, DataTable, DateInput, EmptyState, Field, Inline, KeyValueList, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { BankSelect, NoBanks, useBanks, useDefaultBank } from './components.tsx';
import { depositSlipExport } from './lib/exports.ts';

export function DepositSlipScreen({ params }: ScreenProps<{ ledgerId?: number; date?: string }>) {
  const nav = useNav();
  const { date: workingDate } = useWorkingDate();
  const [date, setDate] = useState<string | null>(params.date ?? workingDate);
  const { banks, loading: banksLoading, error: banksError } = useBanks(date ?? workingDate);
  const [ledgerId, setLedgerId] = useState<number | null>(params.ledgerId ?? null);
  useDefaultBank(banks, ledgerId, setLedgerId);
  const q = useApiQuery('banking.depositSlip', { ledgerId: ledgerId ?? 0, date: date ?? workingDate }, { enabled: ledgerId !== null && date !== null, keepPrevious: true });
  const slip = q.data;

  const columns = useMemo<Column<DepositSlipCheque>[]>(
    () => [
      { key: 'sno', header: 'S.No.', width: 64, align: 'right', render: (_r, ctx) => String(ctx.index + 1) },
      { key: 'instrumentNo', header: 'Cheque / DD no.', width: 140, render: (r) => `${r.instrumentType === 'dd' ? 'DD ' : ''}${r.instrumentNo ?? ''}` },
      { key: 'instrumentDate', header: 'Cheque date', kind: 'date', width: 110 },
      { key: 'drawnOn', header: 'Drawn on (bank)', width: 160 },
      { key: 'particulars', header: 'Received from', minWidth: 180 },
      { key: 'voucher', header: 'Voucher', width: 140, value: (r) => `${r.voucherType} ${r.number ?? ''}` },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, total: true },
    ],
    [],
  );

  if (!banksLoading && !banksError && banks.length === 0) {
    return (
      <ReportScreen title="Deposit Slip" periodMode="none">
        <NoBanks />
      </ReportScreen>
    );
  }

  return (
    <ReportScreen
      title="Deposit Slip"
      subtitle={slip ? `${slip.bank.name} · ${formatDate(slip.date)}` : undefined}
      periodMode="none"
      loading={banksLoading || (q.loading && !slip)}
      refreshing={q.refreshing}
      error={banksError ?? q.error}
      onRetry={() => void q.refetch()}
      exportDef={slip ? () => depositSlipExport(slip) : undefined}
      hint="Alt+P print the slip · Enter open voucher · Change the date to see another day's deposits"
      filters={
        <Inline gap={2} wrap align="end">
          <Field label="Bank account">
            <BankSelect banks={banks} value={ledgerId} onChange={(id) => id !== null && setLedgerId(id)} />
          </Field>
          <Field label="Deposit date">
            <DateInput size="sm" value={date} onChange={setDate} referenceDate={workingDate} />
          </Field>
        </Inline>
      }
    >
      {slip ? (
        <Stack gap={3} className="bx-bk-slip">
          <Card padding="sm" title={slip.bank.bankName ?? slip.bank.name} subtitle={[slip.bank.branch, slip.bank.ifsc ? `IFSC ${slip.bank.ifsc}` : null].filter(Boolean).join(' · ') || undefined}>
            <KeyValueList
              layout="inline"
              columns={2}
              items={[
                { label: 'Account holder', value: slip.bank.holder ?? slip.company.name },
                { label: 'Account no.', value: slip.bank.accountNo ?? '–' },
                { label: 'Date', value: slip.date, kind: 'date' },
                { label: 'Cheques / DDs', value: `${slip.totals.chequeCount}` },
                { label: 'Cheques total', value: slip.totals.cheques, kind: 'amount' },
                { label: 'Cash', value: slip.totals.cash, kind: 'amount' },
                { label: 'Total deposit', value: slip.totals.total, kind: 'amount', strong: true },
              ]}
            />
            <p className="bx-bk-slip__words">{slip.amountInWords}</p>
          </Card>
          <div className="bx-bk-table">
            <DataTable
              aria-label="Cheques deposited"
              autoFocus
              columns={columns}
              rows={slip.cheques}
              getRowKey={(r) => String(r.ledgerEntryId)}
              onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
              empty={
                <EmptyState
                  size="sm"
                  icon="receipt"
                  title={`No cheques received into this bank on ${formatDate(slip.date)}`}
                  body="Cheques and DDs entered in Receipt vouchers dated this day appear here. Pick another date."
                />
              }
            />
          </div>
        </Stack>
      ) : null}
    </ReportScreen>
  );
}
