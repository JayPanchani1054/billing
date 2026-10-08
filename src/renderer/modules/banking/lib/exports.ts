/**
 * Export / print tables for the banking screens (amounts in paise, dates ISO — formatted by the export
 * helpers). Pure so the column layout is tested.
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import type { BankSummaryRow, BrsResult, ChequeRegisterRow, ChequeStatus, DepositSlip, PdcRow } from '../../../../shared/types/banking.ts';
import type { ReportExportDef } from '../../../app/Screen.tsx';
import { CATEGORY_LABEL } from './brsGrid.ts';

export const CHEQUE_STATUS_LABEL: Record<ChequeStatus, string> = { cleared: 'Cleared', uncleared: 'Not cleared', post_dated: 'Post-dated' };

const instrumentLabel = (t: string | null): string => (t ? t.toUpperCase() : '');

export function brsExport(r: BrsResult): ReportExportDef {
  return {
    subtitle: `${r.ledger.name} — as on ${formatDate(r.asOf)}`,
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Particulars', width: 28 },
      { header: 'Vch Type', width: 14 },
      { header: 'Vch No.', width: 10 },
      { header: 'Instrument', width: 10 },
      { header: 'Instr. No.', width: 12 },
      { header: 'Instr. Date', kind: 'date' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
      { header: 'Bank Date', kind: 'date' },
      { header: 'Status', width: 14 },
    ],
    rows: r.entries.map((e) => [
      e.date,
      e.particulars,
      e.voucherType,
      e.number ?? '',
      instrumentLabel(e.instrumentType),
      e.instrumentNo ?? '',
      e.instrumentDate,
      e.debit || null,
      e.credit || null,
      e.bankDate,
      CATEGORY_LABEL[e.category],
    ]),
    notes: [
      `Balance as per company books: ${signed(r.balanceAsPerBooks)}`,
      `Add: cheques issued but not presented: ${plain(r.chequesIssuedNotPresented)}`,
      `Less: cheques deposited but not cleared: ${plain(r.chequesDepositedNotCleared)}`,
      ...(r.clearedBeforeVoucherDate !== 0 ? [`Cleared before the voucher date: ${signed(r.clearedBeforeVoucherDate)}`] : []),
      `Balance as per bank: ${signed(r.balanceAsPerBank)}`,
      ...(r.statementBalance !== null
        ? [
            ...(r.statementDate !== null && r.statementDate < r.asOf && r.balanceAsPerBankOnStatementDate !== null
              ? [`Balance as per bank on ${formatDate(r.statementDate)} (from the books): ${signed(r.balanceAsPerBankOnStatementDate)}`]
              : []),
            `Imported statement balance on ${formatDate(r.statementDate)}: ${signed(r.statementBalance)}`,
            `Difference (statement − bank as per books): ${signed(r.difference ?? 0)}`,
            ...(r.amountsNotInBooks.count > 0
              ? [`Statement lines not in the books (${r.amountsNotInBooks.count}): ${signed(r.amountsNotInBooks.deposits - r.amountsNotInBooks.withdrawals)}`, `Unexplained: ${signed(r.unexplainedDifference ?? 0)}`]
              : []),
          ]
        : []),
    ].join('\n'),
    landscape: true,
  };
}

const plain = (p: number): string => formatMoney(p, { absolute: true });
const signed = (p: number): string => formatDrCr(p, { keepZero: true });

export function chequeRegisterExport(rows: readonly ChequeRegisterRow[]): ReportExportDef {
  return {
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Bank', width: 18 },
      { header: 'Issued / Received', width: 10 },
      { header: 'Cheque No.', width: 12 },
      { header: 'Cheque Date', kind: 'date' },
      { header: 'Party', width: 26 },
      { header: 'Drawn on', width: 14 },
      { header: 'Vch Type', width: 12 },
      { header: 'Vch No.', width: 10 },
      { header: 'Amount', kind: 'amount' },
      { header: 'Bank Date', kind: 'date' },
      { header: 'Status', width: 12 },
    ],
    rows: rows.map((r) => [
      r.date,
      r.bankLedgerName,
      r.direction === 'issued' ? 'Issued' : 'Received',
      r.instrumentNo ?? '',
      r.instrumentDate,
      r.particulars,
      r.drawnOn ?? '',
      r.voucherType,
      r.number ?? '',
      r.amount,
      r.bankDate,
      r.stale ? 'Stale (over 3 months)' : CHEQUE_STATUS_LABEL[r.status],
    ]),
    totals: ['', '', '', '', '', 'Total', '', '', '', rows.reduce((s, r) => s + r.amount, 0), '', ''],
    landscape: true,
  };
}

export function pdcExport(rows: readonly PdcRow[]): ReportExportDef {
  return {
    columns: [
      { header: 'Due date', kind: 'date' },
      { header: 'Type', width: 10 },
      { header: 'Party', width: 26 },
      { header: 'Bank', width: 18 },
      { header: 'Cheque No.', width: 12 },
      { header: 'Drawn on', width: 14 },
      { header: 'Vch Type', width: 12 },
      { header: 'Vch No.', width: 10 },
      { header: 'Amount', kind: 'amount' },
      { header: 'Days to due', kind: 'number' },
    ],
    rows: rows.map((r) => [
      r.date,
      r.kind === 'receivable' ? 'Receivable' : 'Payable',
      r.particulars,
      r.bankLedgerName,
      r.instrumentNo ?? '',
      r.drawnOn ?? '',
      r.voucherType,
      r.number ?? '',
      r.amount,
      r.daysToMaturity,
    ]),
  };
}

export function summaryExport(rows: readonly BankSummaryRow[]): ReportExportDef {
  return {
    columns: [
      { header: 'Bank account', width: 26 },
      { header: 'Account No.', width: 18 },
      { header: 'Balance as per books', kind: 'drcr' },
      { header: 'Not presented', kind: 'amount' },
      { header: 'Not cleared', kind: 'amount' },
      { header: 'Balance as per bank', kind: 'drcr' },
      { header: 'Last reconciled', kind: 'date' },
      { header: 'Statement date', kind: 'date' },
      { header: 'Statement balance', kind: 'drcr' },
      { header: 'Statement − bank (books)', kind: 'drcr' },
      { header: 'Unmatched lines', kind: 'number' },
    ],
    rows: rows.map((r) => [
      r.name,
      r.accountNo ?? '',
      r.balanceAsPerBooks,
      r.unreconciled.issued || null,
      r.unreconciled.deposits || null,
      r.balanceAsPerBank,
      r.lastReconciledDate,
      r.lastStatement?.date ?? null,
      r.lastStatement?.balance ?? null,
      r.lastStatement?.difference ?? null,
      r.statementLines.unmatched,
    ]),
    totals: ['Total', '', rows.reduce((s, r) => s + r.balanceAsPerBooks, 0), null, null, rows.reduce((s, r) => s + r.balanceAsPerBank, 0), null, null, null, null, null],
  };
}

export function depositSlipExport(s: DepositSlip): ReportExportDef {
  return {
    title: 'Bank Deposit Slip',
    subtitle: [s.bank.bankName ?? s.bank.name, s.bank.accountNo ? `A/c No. ${s.bank.accountNo}` : '', s.bank.branch ?? '', `Date ${formatDate(s.date)}`].filter(Boolean).join(' · '),
    period: formatDate(s.date),
    columns: [
      { header: 'S.No.', kind: 'number' },
      { header: 'Cheque / DD No.', width: 14 },
      { header: 'Cheque Date', kind: 'date' },
      { header: 'Drawn on (bank)', width: 18 },
      { header: 'Received from', width: 26 },
      { header: 'Amount', kind: 'amount' },
    ],
    rows: [
      ...s.cheques.map((c, i) => [i + 1, `${c.instrumentType === 'dd' ? 'DD ' : ''}${c.instrumentNo ?? ''}`, c.instrumentDate, c.drawnOn ?? '', c.particulars, c.amount]),
      ...(s.cash.amount > 0 ? [[null, 'Cash', null, '', `${s.cash.vouchers} cash deposit${s.cash.vouchers === 1 ? '' : 's'}`, s.cash.amount]] : []),
    ],
    totals: [null, '', null, '', 'Total', s.totals.total],
    notes: `${s.amountInWords}\nAccount holder: ${s.bank.holder ?? s.company.name}${s.bank.ifsc ? ` · IFSC ${s.bank.ifsc}` : ''}\n\nDepositor's signature: ____________________`,
  };
}
