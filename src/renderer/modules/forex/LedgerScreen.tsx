/**
 * 'forex.ledger' {ledgerId?, from?, to?} — Ledger Vouchers in both currencies for a ledger kept in a
 * foreign currency: per voucher the amount in the currency, the rate it was entered at and the
 * rupees posted, with running balances in both; opening / closing in both and, under the table, the
 * closing balance at the period-end closing rate (unrealised gain / loss).
 * Keys: Alt+L change ledger · Enter open voucher · Alt+A alter voucher · Alt+R the rupee ledger
 * (reports.ledger) · Alt+O opening balance in the currency · Alt+M ledger master · Alt+V revaluation ·
 * Alt+F2 period · Alt+E export · Alt+P print · Esc back.
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { ForexLedgerCurrency, ForexLedgerRow } from '../../../shared/types/forex.ts';
import { ReportScreen, useApiQuery, useFeatures, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState, Field, Picker, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useReportPeriod } from '../reports/components.tsx';
import { ForexOff } from './components.tsx';
import { currencyMap, fxDrCr, ledgerExport, ledgerFooterNote, rateText } from './lib/model.ts';

export interface ForexLedgerParams {
  ledgerId?: number;
  from?: string;
  to?: string;
}

export function LedgerScreen({ params }: ScreenProps<ForexLedgerParams>) {
  const nav = useNav();
  const features = useFeatures();
  const p = useReportPeriod(params);
  const [ledgerId, setLedgerId] = useState<number | null>(typeof params?.ledgerId === 'number' ? params.ledgerId : null);
  const [cursor, setCursor] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const ctxQ = useApiQuery('forex.context', {}, { enabled: features.multiCurrency, staleTime: 60_000 });
  const ledgers = useMemo(() => ctxQ.data?.ledgers ?? [], [ctxQ.data]);
  const cur = useMemo(() => currencyMap(ctxQ.data?.currencies ?? []), [ctxQ.data]);
  const q = useApiQuery('forex.ledger', { ledgerId: ledgerId ?? 0, from: p.from, to: p.to }, { keepPrevious: true, enabled: features.multiCurrency && ledgerId !== null });
  const d = ledgerId !== null && q.data?.ledgerId === ledgerId ? q.data : undefined;
  const selected = ledgers.find((l) => l.ledgerId === ledgerId) ?? null;
  const current = d?.rows.find((r) => String(r.voucherId) === cursor) ?? null;

  const columns = useMemo<Column<ForexLedgerRow>[]>(() => {
    const c = d?.currency;
    return [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'particulars', header: 'Particulars', minWidth: 220 },
      { key: 'voucherType', header: 'Vch Type', width: 130 },
      { key: 'number', header: 'Vch No.', width: 100, value: (r) => r.number ?? '' },
      {
        key: 'forexAmount',
        header: `${c?.isoCode ?? c?.symbol ?? 'Foreign'}`,
        width: 160,
        align: 'right',
        value: (r) => r.forexAmount ?? 0,
        render: (r) => <span className="bx-num">{r.forexAmount === null || r.forexAmount === 0 ? (r.amount !== 0 ? <span className="bx-muted">₹ only</span> : '') : fxDrCr(r.forexAmount, c)}</span>,
      },
      { key: 'rate', header: 'Rate', width: 110, align: 'right', value: (r) => r.rate ?? 0, render: (r) => <span className="bx-num">{rateText(r.rate)}</span> },
      { key: 'amount', header: 'Rupees', kind: 'drcr', width: 150 },
      { key: 'forexBalance', header: `Balance ${c?.symbol ?? ''}`, width: 160, align: 'right', value: (r) => r.forexBalance, render: (r) => <span className="bx-num">{fxDrCr(r.forexBalance, c)}</span> },
      { key: 'inrBalance', header: 'Balance ₹', kind: 'drcr', width: 160 },
    ];
  }, [d?.currency]);

  const footer: FooterRow[] = d
    ? [
        { key: 'opening', tone: 'subtle', cells: { particulars: 'Opening Balance', forexBalance: fxDrCr(d.openingForex, d.currency), inrBalance: d.openingInr } },
        {
          key: 'current',
          tone: 'subtle',
          cells: {
            particulars: 'Current Total',
            forexAmount: [d.totals.forexDr ? fxDrCr(d.totals.forexDr, d.currency) : '', d.totals.forexCr ? fxDrCr(-d.totals.forexCr, d.currency) : ''].filter(Boolean).join(' · '),
            amount: [d.totals.inrDr ? `${formatMoney(d.totals.inrDr)} Dr` : '', d.totals.inrCr ? `${formatMoney(d.totals.inrCr)} Cr` : ''].filter(Boolean).join(' · '),
          },
        },
        { key: 'closing', tone: 'total', cells: { particulars: 'Closing Balance', forexBalance: fxDrCr(d.closingForex, d.currency), inrBalance: d.closingInr } },
      ]
    : [];

  if (!features.multiCurrency) return <ForexOff title="Ledger in Foreign Currency" />;
  const actions: ScreenActionItem[] = [
    { key: 'Alt+L', label: 'Change ledger', icon: 'ledger', onClick: () => pickerRef.current?.focus(), group: 'ledger' },
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', disabled: !current, onClick: () => current && nav.push('vouchers.entry', { id: current.voucherId }), group: 'voucher' },
    { key: 'Alt+R', label: 'Rupee ledger', icon: 'rupee', disabled: ledgerId === null, onClick: () => ledgerId !== null && nav.push('reports.ledger', { ledgerId, from: p.from, to: p.to }), group: 'ledger' },
    { key: 'Alt+O', label: 'Opening in currency', icon: 'edit', disabled: ledgerId === null, onClick: () => ledgerId !== null && nav.push('forex.opening', { ledgerId }), group: 'ledger' },
    { key: 'Alt+M', label: 'Ledger master', icon: 'edit', disabled: ledgerId === null, onClick: () => ledgerId !== null && nav.push('accounts.ledger.form', { id: ledgerId }), group: 'ledger' },
    { key: 'Alt+V', label: 'Revaluation', icon: 'refresh', onClick: () => nav.push('forex.revaluation', { asOf: p.to }), group: 'view' },
  ];
  const note = d ? ledgerFooterNote(d, formatMoney) : null;
  return (
    <ReportScreen
      title={d ? d.ledgerName : 'Ledger in Foreign Currency'}
      subtitle={d ? `Kept in ${d.currency.formalName} (${d.currency.symbol}) · books in rupees` : 'Ledger Vouchers in both currencies'}
      period={p.period}
      loading={ledgerId !== null && q.loading && !d}
      refreshing={q.refreshing}
      error={ledgerId !== null ? q.error : ctxQ.error}
      onRetry={() => void (ledgerId !== null ? q.refetch() : ctxQ.refetch())}
      actions={actions}
      hint="Enter Open voucher · Alt+A Alter · Alt+L Change ledger · Alt+R Rupee ledger · Alt+O Opening · Alt+V Revaluation · Esc Back"
      filters={
        <Field label="Ledger" layout="inline" labelWidth={64}>
          <Picker<ForexLedgerCurrency>
            ref={pickerRef}
            aria-label="Ledger kept in a foreign currency"
            items={ledgers}
            getKey={(l) => String(l.ledgerId)}
            getLabel={(l) => l.ledgerName}
            rightMeta={(l) => <span className="bx-muted">{cur.get(l.currencyId)?.symbol ?? ''}</span>}
            value={selected}
            onChange={(l) => {
              if (!l) return;
              setLedgerId(l.ledgerId);
              setCursor(null);
            }}
            clearable={false}
            placeholder={ctxQ.loading ? 'Loading ledgers…' : ledgers.length === 0 ? 'No ledger is kept in a foreign currency' : 'Type a ledger name'}
            disabled={ledgers.length === 0}
            listMinWidth={360}
            autoFocus={ledgerId === null}
          />
        </Field>
      }
      exportDef={() => (d ? { ...ledgerExport(d), subtitle: `${d.ledgerName} — ${d.currency.formalName}` } : { columns: [], rows: [] })}
    >
      {ledgerId === null ? (
        <EmptyState
          icon="ledger"
          title="Choose a ledger kept in a foreign currency"
          body="Type its name above. A ledger is kept in a foreign currency when its master has a Currency (Ledger › Currency)."
        />
      ) : (
        <Stack gap={2} grow>
          <DataTable<ForexLedgerRow>
            aria-label={d ? `Ledger vouchers of ${d.ledgerName} in ${d.currency.formalName} and rupees` : 'Ledger vouchers'}
            className="bx-rep-fill"
            columns={columns}
            rows={d?.rows ?? []}
            getRowKey={(r) => String(r.voucherId)}
            selectedKey={cursor}
            onSelect={(k) => setCursor(k)}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
            footerRows={footer}
            loading={q.loading}
            typeToJump={(r) => r.particulars}
            empty={<EmptyState icon="receipt" title="No vouchers for this ledger in the period" body="Opening and closing balances are below. Change the period with Alt+F2." />}
            autoFocus
          />
          {note ? <p className="bx-rep-note">{note}</p> : null}
          {d ? <p className="bx-rep-note">Period {formatDate(d.from)} to {formatDate(d.to)}. “₹ only” lines are exchange adjustments in rupees (realised or revaluation).</p> : null}
        </Stack>
      )}
    </ReportScreen>
  );
}
