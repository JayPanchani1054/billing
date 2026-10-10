/**
 * Electronic ledgers as kept in the books, for the reporting period (Alt+F2):
 *   'gst.ledger.cash'   {from?, to?} — Electronic Cash Ledger: per major × minor head opening, deposits
 *                       (GST challans), utilisation (set-off journals), closing; transactions below.
 *   'gst.ledger.credit' {from?, to?} — Electronic Credit Ledger: per head opening, ITC accrued, reversed,
 *                       utilised, closing (from the Input tax ledgers); transactions below.
 * Enter on a transaction opens its voucher. The portal's ledgers are the legal record — the screens say so.
 */
import { useMemo } from 'react';
import type { CashLedgerTxn, CreditLedgerRow, CreditLedgerTxn } from '../../../shared/types/gst-plus.ts';
import { formatMoney, ReportScreen, useApiQuery, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, DataTable, EmptyState, Grid, KpiCard, Panel } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, useGstRange, WideTable } from './components.tsx';
import { cashLedgerExport, cashLedgerMatrix, creditLedgerExport, HEAD_NAMES, MINOR_LABELS, txnTotal } from './lib/gstplus.ts';
import { CASH_MINOR_HEADS } from '../../../shared/types/gst-plus.ts';

const money = (p: number): string => formatMoney(p);

/** Cash ledger amounts are always positive; credit ledger amounts are signed (Dr = credit booked, Cr = reversed / used). */
function txnColumns<T extends CashLedgerTxn | CreditLedgerTxn>(kindLabel: (r: T) => string, amountKind: 'amount' | 'drcr' = 'amount'): Column<T>[] {
  return [
    { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
    { key: 'number', header: 'Voucher no.', width: 120, value: (r) => r.number ?? '' },
    { key: 'kind', header: 'Type', width: 110, value: kindLabel },
    { key: 'description', header: 'Particulars', minWidth: 220 },
    { key: 'igst', header: 'IGST', kind: amountKind, width: 120, blankZero: true, total: true },
    { key: 'cgst', header: 'CGST', kind: amountKind, width: 120, blankZero: true, total: true },
    { key: 'sgst', header: 'SGST/UTGST', kind: amountKind, width: 120, blankZero: true, total: true },
    { key: 'cess', header: 'Cess', kind: amountKind, width: 110, blankZero: true, total: true },
    { key: 'total', header: 'Total', kind: amountKind, width: 130, value: (r) => txnTotal(r), total: true },
  ];
}

// ───────────────────────────── Cash ledger ─────────────────────────────

export function CashLedgerScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const { from, to, override } = useGstRange(params);
  const q = useApiQuery('gst.ledger.cash', { from, to }, { keepPrevious: true });
  const l = q.data;
  const columns = useMemo(() => txnColumns<CashLedgerTxn>((r) => (r.kind === 'deposit' ? 'Deposit' : 'Utilised')), []);
  const matrix = useMemo(() => (l ? cashLedgerMatrix(l) : []), [l]);
  const actions: ScreenActionItem[] = [
    { key: 'Alt+S', label: 'GST set-off', icon: 'gst', onClick: () => nav.push('gst.setoff'), group: 'go' },
    { key: 'Alt+L', label: 'Credit ledger', icon: 'book', onClick: () => nav.push('gst.ledger.credit', override ?? {}), group: 'go' },
  ];
  return (
    <ReportScreen
      title="Electronic Cash Ledger"
      subtitle="As kept in the books"
      period={override}
      actions={actions}
      exportDef={l ? () => ({ ...cashLedgerExport(l), title: 'Electronic Cash Ledger', period: { from: l.from, to: l.to } }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open voucher · Alt+S GST set-off · Alt+L Credit ledger · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-scroll">
        <GstHelp>Cash you deposited with the government by GST challan (PMT-06) and how it was used to pay tax, interest, penalty, fee and others.</GstHelp>
        {l ? (
          <>
            <Grid minItemWidth={180} gap={3}>
              <KpiCard label="Opening balance" value={l.totals.opening} amount />
              <KpiCard label="Deposited" value={l.totals.deposited} amount caption="Challans in the period" />
              <KpiCard label="Utilised" value={l.totals.utilised} amount caption="Set-off journals" />
              <KpiCard label="Closing balance" value={l.totals.closing} amount caption={l.booksBalance !== l.totals.closing ? `Books account: ${money(l.booksBalance)}` : 'Agrees with the books account'} />
            </Grid>
            {l.notes.length > 0 ? (
              <Banner tone="info" inline>
                {l.notes.join(' ')}
              </Banner>
            ) : null}
            <Panel title="Balance by head" headingLevel={2}>
              <WideTable label="Cash ledger by head">
                <thead>
                  <tr>
                    <th scope="col">Major head</th>
                    {CASH_MINOR_HEADS.map((m) => (
                      <th key={m} scope="col" className="is-num">
                        {MINOR_LABELS[m]}
                      </th>
                    ))}
                    <th scope="col" className="is-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((r) => (
                    <tr key={r.head}>
                      <th scope="row">{HEAD_NAMES[r.head]}</th>
                      {CASH_MINOR_HEADS.map((m) => (
                        <td key={m} className="is-num">
                          {money(r.closing[m])}
                        </td>
                      ))}
                      <td className="is-num">{money(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </WideTable>
            </Panel>
            <Panel title="Transactions" headingLevel={2} description="Enter opens the challan or set-off voucher.">
              <DataTable<CashLedgerTxn>
                aria-label="Cash ledger transactions"
                autoFocus
                columns={columns}
                rows={l.transactions}
                getRowKey={(r, i) => `${r.voucherId}:${r.kind}:${i}`}
                onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
                height={Math.min(480, 40 + 32 * (l.transactions.length + 2))}
                empty={<EmptyState size="sm" icon="receipt" title="No deposits or set-offs in this period" body="Record a challan from GST Set-off (Alt+S, then Alt+C)." />}
              />
            </Panel>
          </>
        ) : null}
      </div>
    </ReportScreen>
  );
}

// ───────────────────────────── Credit ledger ─────────────────────────────

export function CreditLedgerScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const { from, to, override } = useGstRange(params);
  const q = useApiQuery('gst.ledger.credit', { from, to }, { keepPrevious: true });
  const l = q.data;
  const columns = useMemo(
    () => txnColumns<CreditLedgerTxn>((r) => (r.kind === 'accrued' ? 'Accrued' : r.kind === 'reversed' ? 'Reversed' : 'Utilised'), 'drcr'),
    [],
  );
  const summaryCols = useMemo<Column<CreditLedgerRow>[]>(
    () => [
      { key: 'label', header: 'Head', minWidth: 160 },
      { key: 'opening', header: 'Opening', kind: 'amount', width: 140, total: true },
      { key: 'accrued', header: 'ITC accrued', kind: 'amount', width: 140, total: true },
      { key: 'reversed', header: 'Reversed', kind: 'amount', width: 140, total: true, blankZero: true },
      { key: 'utilised', header: 'Utilised', kind: 'amount', width: 140, total: true, blankZero: true },
      { key: 'closing', header: 'Closing', kind: 'amount', width: 140, total: true },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Alt+S', label: 'GST set-off', icon: 'gst', onClick: () => nav.push('gst.setoff'), group: 'go' },
    { key: 'Alt+L', label: 'Cash ledger', icon: 'book', onClick: () => nav.push('gst.ledger.cash', override ?? {}), group: 'go' },
    { key: 'Alt+I', label: 'Input tax credit', icon: 'gst', onClick: () => nav.push('gst.itc', override ?? {}), group: 'go' },
  ];
  return (
    <ReportScreen
      title="Electronic Credit Ledger"
      subtitle="As kept in the books"
      period={override}
      actions={actions}
      exportDef={l ? () => ({ ...creditLedgerExport(l), title: 'Electronic Credit Ledger', period: { from: l.from, to: l.to } }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open voucher · Alt+S GST set-off · Alt+L Cash ledger · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-scroll">
        <GstHelp>Input tax credit per head: booked on purchases, reverse charge and bills of entry, reversed (Rules 37, 37A, 42, 43, s.17(5), returns) and used in set-off.</GstHelp>
        {l ? (
          <>
            {l.notes.length > 0 ? (
              <Banner tone="info" inline>
                {l.notes.join(' ')}
              </Banner>
            ) : null}
            <Panel title="Balance by head" headingLevel={2}>
              <DataTable<CreditLedgerRow>
                aria-label="Credit ledger by head"
                columns={summaryCols}
                rows={l.rows}
                getRowKey={(r) => r.head}
                height={40 + 32 * (l.rows.length + 2)}
              />
            </Panel>
            <Panel title="Transactions" headingLevel={2} description="Enter opens the voucher.">
              <DataTable<CreditLedgerTxn>
                aria-label="Credit ledger transactions"
                autoFocus
                columns={columns}
                rows={l.transactions}
                getRowKey={(r, i) => `${r.voucherId}:${r.kind}:${i}`}
                onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
                height={Math.min(520, 40 + 32 * (l.transactions.length + 2))}
                empty={<EmptyState size="sm" icon="file" title="No credit movements in this period" body="Change the period with Alt+F2." />}
              />
            </Panel>
          </>
        ) : null}
      </div>
    </ReportScreen>
  );
}
